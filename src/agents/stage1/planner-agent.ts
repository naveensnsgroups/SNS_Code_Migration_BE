

import { DetectedStack, TargetStack } from '../../types.js';
import { toolRegistry }               from '../../core/tool-invocation-registry.js';
import { ToolContext }                 from '../../types/tool.js';
import { AgentExecutor }              from '../core/agentExecutor.js';
import { TaskContextManager }         from '../../session/taskContext.js';
import { SessionManager }             from '../../session/sessionManager.js';
import { resolveStreamingProvider }   from '../../ai/index.js';
import { StreamingProvider }          from '../../types/language-model.js';
import {
  DISCOVERY_AGENT,
  GRAPH_RESOLVER_AGENT,
  SECTION_WRITER_AGENT,
  STAGE1_PLANNER_AGENT,
} from '../core/agent-definitions.js';
import {
  DISCOVERY_SYSTEM_PROMPT,
  buildDiscoveryUserPrompt,
} from '../../prompts/discovery-prompt.js';
import {
  FILE_ANALYSIS_SYSTEM_PROMPT,
  buildAnalysisUserPrompt,
} from '../../prompts/file-analysis-prompt.js';

import {
  GRAPH_PASS_C_SYSTEM,
  buildGraphPassCUserPrompt,
  GRAPH_PASS_D_SYSTEM,
  buildGraphPassDUserPrompt,
} from '../../prompts/graph-resolution-prompt.js';

import {
  SECTION_SYSTEM_PROMPT,
  SECTION_CONFIG,
  SectionConfig,
  buildSectionUserPrompt,
  buildParallelSectionGroups,
  getSectionThemeName,
} from '../../prompts/section-writer-prompt.js';

import { assembleSections, getWrittenSections } from './section-assembler.js';
import {
  resolveForeignKeys,
  buildCallFlowGraph,
  computeImportedBy,
  computeMigrationOrder,
} from './graph-resolver.js';
import {
  deduplicateFileIndex,
} from './domain-router.js';

import fs   from 'fs-extra';
import path from 'path';
import glob from 'fast-glob';

const REASONING_MODEL_ALIAS    = 'reasoning-model';
const CUSTOM_RULES_FRAGMENT_ID = 'system-agent-rules';

function computeTurnCapFromData(
  contextK:         number,   
  avgFileSizeLines: number,   
  pendingCount:     number    
): number {
  if (contextK <= 0 || avgFileSizeLines <= 0) return Math.min(22, pendingCount);
  const tokenBudget   = contextK * 1000 * 0.55;
  const tokensPerFile = Math.max(avgFileSizeLines * 4 + 500, 700);
  const contextBased  = Math.floor(tokenBudget / tokensPerFile);
  
  return Math.min(Math.max(contextBased, 3), pendingCount);
}

function computeBatchSizeFromData(pendingCount: number): number {
  if (pendingCount < 30)  return 10;  
  if (pendingCount < 100) return 8;
  if (pendingCount < 300) return 5;
  return 3;                           
}

function computeAvgFileSizeLines(fileIndex: any[]): number {
  if (!fileIndex.length) return 150; 
  const total = fileIndex.reduce((sum: number, f: any) => sum + (f?.estimatedLines ?? 0), 0);
  const avg   = Math.round(total / fileIndex.length);
  return avg > 0 ? avg : 150;
}

function getModelContextK(modelName: string): number {
  const m = (modelName ?? '').toLowerCase();
  
  if (m.includes('gemini-2.5-pro'))    return 1000;
  if (m.includes('gemini-2.5-flash'))  return 1000;
  if (m.includes('gemini-2.0-flash'))  return 1000;
  if (m.includes('gemini-1.5-pro'))    return 1000;
  if (m.includes('gemini-1.5-flash'))  return 1000;
  
  if (m.includes('claude-3-5-sonnet')) return 200;
  if (m.includes('claude-sonnet-4'))   return 200;
  if (m.includes('claude-opus-4'))     return 200;
  if (m.includes('claude-3-opus'))     return 200;
  if (m.includes('claude-haiku'))      return 200;
  if (m.includes('claude-3-haiku'))    return 200;
  
  if (m.includes('gpt-4o'))            return 128;
  if (m.includes('gpt-4-turbo'))       return 128;
  if (m.includes('gpt-3.5'))           return 16;
  
  return 128;
}

function computeMaxConcurrentSections(modelName: string): number {
  const m = (modelName ?? '').toLowerCase().trim();
  
  if (m.startsWith('gemini-') || m.includes('gemini')) {
    if (m.includes('pro'))   return 2; 
    if (m.includes('flash')) return 4; 
    return 3;                          
  }
  
  if (m.startsWith('claude-') || m.includes('claude')) {
    if (m.includes('opus'))   return 3; 
    if (m.includes('haiku'))  return 8; 
    return 5;                           
  }
  
  if (m.startsWith('gpt-') || m.includes('gpt')) return 4;
  
  if (m.startsWith('groq-') || m.includes('groq')) return 6;
  return 3; 
}

async function runWithConcurrencyLimit<T>(
  tasks: Array<() => Promise<T>>,
  limit: number
): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = new Array(tasks.length);
  const executing = new Set<Promise<void>>();

  for (let i = 0; i < tasks.length; i++) {
    const idx  = i;
    const task = tasks[idx];
    const p: Promise<void> = task()
      .then(r  => { results[idx] = { status: 'fulfilled', value: r }; })
      .catch(e => { results[idx] = { status: 'rejected',  reason: e }; })
      .finally(() => executing.delete(p));
    executing.add(p);
    if (executing.size >= limit) await Promise.race(executing);
  }
  await Promise.all(executing);
  return results;
}

function withPhaseTimeout<T>(
  operation:   Promise<T>,
  timeoutMs:   number,
  phaseLabel:  string,
  onLog?:      (msg: string, lvl?: 'info' | 'success' | 'error' | 'warning') => void
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onLog?.(
        `[PlannerAgent] ⏱ TIMEOUT: ${phaseLabel} exceeded ${Math.round(timeoutMs / 60_000)} min. ` +
        `Pipeline will resume from the last saved phase on next run.`,
        'error'
      );
      reject(new Error(
        `[PlannerAgent] Phase timeout: "${phaseLabel}" did not complete within ` +
        `${Math.round(timeoutMs / 60_000)} minutes. ` +
        `active_phase has been saved — restart the pipeline to resume from this phase.`
      ));
    }, timeoutMs);

    operation
      .then(result => { clearTimeout(timer); resolve(result); })
      .catch(err   => { clearTimeout(timer); reject(err);    });
  });
}

const PHASE_TIMEOUT_MS = {
  discovery:     6  * 60_000,
  analysisPass:  18 * 60_000,
  graphPass:     12 * 60_000,
  section:       10 * 60_000,
} as const;

type LogFn = (msg: string, lvl?: 'info' | 'success' | 'error' | 'warning') => void;
type ErrorAction = 'retry-rate-limit' | 'retry-depth' | 'skip-problematic' | 'escalate';

async function handleAnalysisError(
  error:       Error,
  passNumber:  number,
  pendingCount: number,
  onLog:       LogFn
): Promise<ErrorAction> {
  const msg = (error.message ?? '').toLowerCase();

  
  if (msg.includes('429') || msg.includes('rate limit') || msg.includes('quota') || msg.includes('too many')) {
    const delayMs = Math.min(Math.pow(2, passNumber) * 2_000, 120_000); 
    onLog(
      `[PlannerAgent] Rate limit on pass ${passNumber}. Waiting ${Math.round(delayMs / 1000)}s before retry.`,
      'warning'
    );
    await new Promise(r => setTimeout(r, delayMs));
    return 'retry-rate-limit';
  }

  
  if (msg.includes('timeout') || msg.includes('timed out') || msg.includes('phase timeout')) {
    onLog(
      `[PlannerAgent] Pass ${passNumber} timed out. ${pendingCount} files remain. ` +
      `Resuming from LAST_FILE_ANALYZED on next pass.`,
      'warning'
    );
    return 'retry-rate-limit'; 
  }

  
  if (passNumber <= 2) {
    onLog(
      `[PlannerAgent] Pass ${passNumber} error: ${error.message}. ` +
      `Retrying — agent will resume from LAST_FILE_ANALYZED.`,
      'warning'
    );
    return 'retry-depth';
  }

  
  onLog(
    `[PlannerAgent] Pass ${passNumber} failed after ${passNumber} attempts: ${error.message}. ` +
    `Advancing with ${pendingCount} files still pending.`,
    'error'
  );
  return 'skip-problematic';
}

const FILE_INDEX_CANDIDATE_KEYS = ['file_index', 'file-index', 'FILE_INDEX'] as const;

function resolveFileIndexFromContext(ctx: Record<string, unknown>): { key: string; entries: any[] } {
  
  const indirectKey = ctx['FILE_INDEX_KEY'] as string | undefined;
  if (indirectKey && Array.isArray(ctx[indirectKey]) && (ctx[indirectKey] as any[]).length > 0) {
    return { key: indirectKey, entries: ctx[indirectKey] as any[] };
  }

  
  for (const candidate of FILE_INDEX_CANDIDATE_KEYS) {
    const val = ctx[candidate];
    if (Array.isArray(val) && val.length > 0) {
      return { key: candidate, entries: val as any[] };
    }
  }

  
  
  
  for (const [k, v] of Object.entries(ctx)) {
    if (
      Array.isArray(v) && v.length > 0 &&
      typeof (v as any[])[0] === 'object' &&
      (v as any[])[0] !== null &&
      'path' in (v as any[])[0] &&
      'read_status' in (v as any[])[0]
    ) {
      return { key: k, entries: v as any[] };
    }
  }

  
  return { key: indirectKey ?? 'file_index', entries: [] };
}

export class PlannerAgent {
  
  static async run(
    sessionId:       string,
    legacyPath:      string,
    modernPath:      string,
    detectedStack:   DetectedStack,
    targetStack:     TargetStack,
    _aiServiceLegacy: unknown,
    onLog?:      (message: string, level?: 'info' | 'success' | 'error' | 'warning') => void,
    onProgress?: (percent: number, currentFile?: string) => void,
    onPhase?:    (phaseId: string, status: 'active' | 'done' | 'error') => Promise<void>
  ): Promise<string> {
    onLog?.('[PlannerAgent] Stage 1: Starting codebase analysis...', 'info');

    
    const session        = await SessionManager.getSession(sessionId);
    const toolsConfig    : Record<string, boolean> = (session as any)?.toolsConfig    ?? {};
    const promptFragments: Record<string, string>  = (session as any)?.promptFragments ?? {};

    const { provider, resolvedModel } = await resolveStreamingProvider(sessionId, targetStack);

    
    const context: ToolContext = {
      sessionId,
      legacyPath,
      modernPath,
      onLog: (msg, lvl) => onLog?.(msg, lvl),
    };

    
    const customRules  = promptFragments[CUSTOM_RULES_FRAGMENT_ID];
    const customSuffix = customRules ? `\n\n<custom_rules>\n${customRules}\n</custom_rules>` : '';

    
    const filter = (def: typeof DISCOVERY_AGENT) =>
      toolRegistry.getFunctions(...def.functions).filter(t => toolsConfig[t.name] !== false);

    const discoveryTools = filter(DISCOVERY_AGENT);
    const analysisTools  = filter(STAGE1_PLANNER_AGENT);  
    const graphTools     = filter(GRAPH_RESOLVER_AGENT);
    const sectionTools   = filter(SECTION_WRITER_AGENT);

    
    let taskCtx     = await TaskContextManager.getContext(sessionId);
    let activePhase = (taskCtx.active_phase as string) || 'discovery';

    if (activePhase === 'complete') {
      onLog?.('[PlannerAgent] Stage 1 already complete.', 'success');
      return 'Stage 1 analysis already complete.';
    }

    onLog?.(`[PlannerAgent] Resuming from phase: "${activePhase}"`, 'info');

    
    
    
    
    if (activePhase === 'discovery') {
      onLog?.('[PlannerAgent] Stage 1/5: Workspace Discovery...', 'info');
      await onPhase?.('discovery', 'active');

      
      
      
      
      
      let preflightFileCount = 0;
      try {
        const preflightFiles = await glob('**/*', {
          cwd:       legacyPath,
          onlyFiles: true,
          ignore:    ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**', '**/.next/**'],
          dot:       true,
        });
        preflightFileCount = preflightFiles.length;
      } catch (globErr: any) {
        onLog?.(
          `[PlannerAgent] Pre-flight scan failed for "${legacyPath}": ${globErr.message}. ` +
          'Proceeding to Discovery Agent — it will handle file listing.',
          'warning'
        );
      }

      onLog?.(
        `[PlannerAgent] Pre-flight scan: found ${preflightFileCount} file(s) in "${legacyPath}".`,
        'info'
      );

      if (preflightFileCount === 0) {
        await TaskContextManager.updateContext(sessionId, { active_phase: 'discovery' });
        throw new Error(
          `[PlannerAgent] Pre-flight check failed: legacyPath "${legacyPath}" contains 0 files. ` +
          'The source project folder is empty or all files were excluded (node_modules / .git / dist / build). ' +
          'Please verify the uploaded project and start a new session.'
        );
      }

      
      await withPhaseTimeout(
        AgentExecutor.execute(
          provider,
          DISCOVERY_SYSTEM_PROMPT + customSuffix,
          buildDiscoveryUserPrompt(legacyPath, detectedStack),
          discoveryTools,
          context,
          resolvedModel,
          'discovery-agent'
        ),
        PHASE_TIMEOUT_MS.discovery,
        'discovery',
        onLog
      );

      taskCtx = await TaskContextManager.getContext(sessionId);
      const totalFiles = (taskCtx.TOTAL_FILES as number | undefined) ?? 0;

      
      if (totalFiles === 0) {
        
        
        
        
        
        await TaskContextManager.updateContext(sessionId, { active_phase: 'discovery' });
        throw new Error(
          `[PlannerAgent] Discovery Agent returned TOTAL_FILES=0 for "${legacyPath}" ` +
          `(pre-flight found ${preflightFileCount} file(s) there). ` +
          'The LLM agent failed to save the file index — likely an API error or timeout. ' +
          'Phase reset to \'discovery\' — re-run to retry from the start.'
        );
      }

      
      
      
      
      
      const expectedFiles = detectedStack.fileCount;
      const minimumExpected = Math.max(1, Math.floor(expectedFiles * 0.5));
      if (expectedFiles > 5 && totalFiles < minimumExpected) {
        onLog?.(
          `[PlannerAgent] Discovery undercount: saved ${totalFiles} files but initial scan found ${expectedFiles}. ` +
        `Minimum expected: ${minimumExpected}. Resetting to discovery to retry.`,
          'warning'
        );
        await TaskContextManager.updateContext(sessionId, { active_phase: 'discovery', TOTAL_FILES: 0 });
        throw new Error(
          `[PlannerAgent] Discovery indexed only ${totalFiles}/${expectedFiles} files (< 50% threshold). ` +
          'The agent likely missed subdirectories. ' +
          'Phase reset to \'discovery\' — re-run to retry with corrected file discovery.'
        );
      }

      onLog?.(`[PlannerAgent] Discovery complete: ${totalFiles} files indexed.`, 'success');
      onProgress?.(5, 'Workspace Discovery');
      await onPhase?.('discovery', 'done');

      
      
      
      
      
      
      
      
      
      
      
      
      
      
      
      // ── FILE_INDEX normalization: merge all key variants → canonical "file-index" ─────────────
      try {
        const staleCtx = await TaskContextManager.getContext(sessionId);

        // Collect every possible key the LLM may have used
        const CANDIDATE_KEYS = ['file-index', 'file_index', 'FILE_INDEX', 'fileIndex'] as const;
        const foundArrays = new Map<string, any[]>();
        for (const key of CANDIDATE_KEYS) {
          const val = staleCtx[key];
          if (Array.isArray(val) && val.length > 0) {
            foundArrays.set(key, val as any[]);
          }
        }

        if (foundArrays.size > 0) {
          // Flatten all entries from all found keys
          const allEntries: any[] = Array.from(foundArrays.values()).flat();

          // ── Deduplicate by path ─────────────────────────────────────────────
          // Strategy: for the same logical file, keep the entry with:
          //   1. DONE status (over PENDING)
          //   2. Longer/more complete path (fix truncated path bug)
          const byPath = new Map<string, any>();
          for (const entry of allEntries) {
            const entryPath: string | undefined = entry?.path;
            if (!entryPath || typeof entryPath !== 'string') continue;

            const existing = byPath.get(entryPath);
            if (!existing) {
              byPath.set(entryPath, entry);
            } else {
              // Prefer DONE over PENDING
              const existingDone = existing.read_status === 'DONE';
              const entryDone    = entry.read_status    === 'DONE';
              if (!existingDone && entryDone) {
                byPath.set(entryPath, entry);
              }
            }
          }

          // ── Cross-key reconciliation: same basename, different paths ────────
          // Handles the truncated-path bug where file_index used shortened paths
          // and file-index used the full correct paths.
          // Prefer DONE status from any key for files with matching basenames.
          if (foundArrays.size > 1) {
            const allPaths = Array.from(byPath.keys());
            for (const p of allPaths) {
              const basename = path.basename(p);
              // Find any other entry with the same basename but different path
              for (const [otherPath, otherEntry] of byPath) {
                if (otherPath !== p && path.basename(otherPath) === basename) {
                  // Two entries resolve to the same file — keep longer (fuller) path with DONE priority
                  const current = byPath.get(p)!;
                  const keepLonger  = p.length >= otherPath.length;
                  const keepPath    = keepLonger ? p : otherPath;
                  const dropPath    = keepLonger ? otherPath : p;
                  const keepEntry   = keepLonger ? current : otherEntry;
                  const dropEntry   = keepLonger ? otherEntry : current;
                  // If the shorter path has DONE and longer is PENDING, merge status
                  const mergedStatus =
                    dropEntry.read_status === 'DONE' || keepEntry.read_status === 'DONE'
                      ? 'DONE'
                      : 'PENDING';
                  byPath.set(keepPath, { ...keepEntry, read_status: mergedStatus });
                  byPath.delete(dropPath);
                  break;
                }
              }
            }
          }

          const merged: any[] = Array.from(byPath.values());

          // ── Path validation: detect suspicious/truncated paths ─────────────
          let pathErrorCount = 0;
          const validatedMerged = await Promise.all(
            merged.map(async (entry: any) => {
              if (!entry?.path) return entry;
              const abs = path.join(legacyPath, entry.path);
              try {
                const exists = await fs.pathExists(abs);
                if (!exists) {
                  pathErrorCount++;
                  return { ...entry, read_status: 'PATH_ERROR' };
                }
              } catch { /* fs errors treated as non-blocking */ }
              return entry;
            })
          );

          if (pathErrorCount > 0) {
            onLog?.(
              `[PlannerAgent] ⚠️ FILE_INDEX path validation: ${pathErrorCount} entries point to ` +
              `non-existent files (marked PATH_ERROR). This is usually caused by the Discovery Agent ` +
              `writing truncated paths. These files will be skipped in Phase 2.`,
              'warning'
            );
          }

          // ── Compute accurate source file count ────────────────────────────
          const totalSourceFiles = validatedMerged.filter(
            (e: any) => e?.type === 'source' && e?.read_status !== 'PATH_ERROR'
          ).length;

          // ── Save canonical index + clear all alternate keys ───────────────
          const patch: Record<string, any> = {
            'file-index':         validatedMerged,
            'FILE_INDEX_KEY':     'file-index',
            'TOTAL_SOURCE_FILES': totalSourceFiles,
          };
          for (const key of foundArrays.keys()) {
            if (key !== 'file-index') patch[key] = null; // purge alternate keys
          }
          await TaskContextManager.updateContext(sessionId, patch);

          const keyNames = [...foundArrays.keys()].join(', ');
          onLog?.(
            `[PlannerAgent] FILE_INDEX normalized: merged ${allEntries.length} raw entries ` +
            `from [${keyNames}] → ${validatedMerged.length} unique entries in "file-index". ` +
            `Source files: ${totalSourceFiles}. Path errors: ${pathErrorCount}.`,
            'info'
          );
        }

      } catch (normErr: any) {
        onLog?.(
          `[PlannerAgent] FILE_INDEX normalization warning: ${normErr?.message ?? String(normErr)}. Continuing.`,
          'warning'
        );
      }

      await onPhase?.('file-analysis', 'active');
      await TaskContextManager.updateContext(sessionId, { active_phase: 'analysis' });
      activePhase = 'analysis';

    }

    
    
    
    
    
    
    
    
    
    
    if (activePhase === 'analysis') {
      taskCtx = await TaskContextManager.getContext(sessionId);
      const totalFiles = (taskCtx.TOTAL_FILES as number) || 0;
      onLog?.(`[PlannerAgent] Stage 2/5: File Analysis (${totalFiles} files)...`, 'info');
      await onPhase?.('file-analysis', 'active');

      
      
      
      
      {
        const { key: initKey, entries: rawFileIndex } = resolveFileIndexFromContext(taskCtx as Record<string, unknown>);
        if (rawFileIndex.length > 0) {
          let currentIndex = [...rawFileIndex];
          const { deduped: dedupedIndex, removedCount } = deduplicateFileIndex(currentIndex as any);
          currentIndex = dedupedIndex;
          if (removedCount > 0) {
            onLog?.(`[PlannerAgent] De-duplicated FILE_INDEX (key="${initKey}"): removed ${removedCount} duplicate entries.`, 'info');
          }

          let emptyFilesCount = 0;
          const updatedIndex = currentIndex.map((f: any) => {
            if (f && f.read_status !== 'DONE' && (f.estimatedLines ?? 0) <= 0) {
              emptyFilesCount++;
              onLog?.(`[PlannerAgent] Auto-marked empty file as DONE: "${f.path}" (Reason: empty file, 0 lines of code).`, 'info');
              return { ...f, read_status: 'DONE' };
            }
            return f;
          });

          if (removedCount > 0 || emptyFilesCount > 0) {
            await TaskContextManager.updateContext(sessionId, { [initKey]: updatedIndex });
          }
          
          if (!(taskCtx as any)['FILE_INDEX_KEY']) {
            await TaskContextManager.updateContext(sessionId, { FILE_INDEX_KEY: initKey });
            onLog?.(`[PlannerAgent] Normalized FILE_INDEX_KEY to "${initKey}" (was missing from context).`, 'info');
          }
        }
      }

      let passNumber       = 0;
      let consecutiveStalls = 0;
      const MAX_PASSES = 50;  
      const MAX_STALLS = 4;   

      while (true) {
        
        taskCtx = await TaskContextManager.getContext(sessionId);
        const { key: fileIndexKey, entries: fileIndex } = resolveFileIndexFromContext(taskCtx as Record<string, unknown>);
        const pending   = fileIndex.filter((f: any) => f?.read_status !== 'DONE');
        const doneCount = fileIndex.length - pending.length;

        
        
        
        
        
        
        
        
        if (fileIndex.length === 0 && totalFiles > 0) {
          await TaskContextManager.updateContext(sessionId, { active_phase: 'discovery', TOTAL_FILES: 0 });
          throw new Error(
            `[PlannerAgent] Phase 2 ABORT: FILE_INDEX is empty (key="${fileIndexKey}") ` +
            `but TOTAL_FILES=${totalFiles}. The Discovery LLM wrote the file index under ` +
            'a key that could not be resolved (likely \'file_index\' vs \'file-index\' mismatch). ' +
            'Phase reset to \'discovery\' — re-run to retry from Discovery.'
          );
        }

        
        if (pending.length === 0 && fileIndex.length > 0) {
          onLog?.(`[PlannerAgent] All ${fileIndex.length} files analyzed. Analysis complete.`, 'success');
          onProgress?.(45, `Analyzed ${fileIndex.length} / ${fileIndex.length} files`);
          break;
        }

        
        if (passNumber >= MAX_PASSES) {
          onLog?.(
            `[PlannerAgent] Safety ceiling reached (${MAX_PASSES} passes). ` +
            `Advancing with ${pending.length} files still pending.`,
            'warning'
          );
          onProgress?.(45, `Advanced at ${doneCount} / ${fileIndex.length} files`);
          break;
        }

        passNumber++;
        const lastAnalyzed = taskCtx.LAST_FILE_ANALYZED as string | undefined;
        const remaining    = pending.length;

        
        
        
        
        
        
        onLog?.(
          `[PlannerAgent] Analysis pass ${passNumber}: ${remaining} file(s) pending (${doneCount}/${fileIndex.length} done).`,
          'info'
        );

        
        const avgLines  = computeAvgFileSizeLines(fileIndex);
        const contextK  = getModelContextK(resolvedModel);
        const turnCap   = computeTurnCapFromData(contextK, avgLines, remaining);
        const batchSize = computeBatchSizeFromData(remaining);
        onLog?.(
          `[PlannerAgent] Pass ${passNumber} limits: turnCap=${turnCap} | batchSize=${batchSize} ` +
          `(contextK=${contextK}K, avgLines=${avgLines}, pending=${remaining})`,
          'info'
        );

        
        let passError: Error | null = null;
        const passResults = await runWithConcurrencyLimit(
          [() =>
            withPhaseTimeout(
              AgentExecutor.execute(
                provider,
                FILE_ANALYSIS_SYSTEM_PROMPT + customSuffix,
                buildAnalysisUserPrompt(
                  legacyPath, lastAnalyzed, turnCap, batchSize,
                  detectedStack.language, detectedStack.framework
                ),
                analysisTools, context, resolvedModel,
                `analysis-agent-pass${passNumber}`
              ),
              PHASE_TIMEOUT_MS.analysisPass,
              `analysis-pass-${passNumber}`,
              onLog
            )
          ],
          1   
        );

        
        for (const result of passResults) {
          if (result.status === 'rejected') {
            const err = result.reason as Error;
            const action = await handleAnalysisError(err, passNumber, remaining, onLog ?? (() => {}));
            if (action === 'skip-problematic' || action === 'escalate') {
              passError = err;
              break;
            }
            
            if (!passError) passError = err;
          }
        }
        if (passError) {
          const action = await handleAnalysisError(passError, passNumber, remaining, onLog ?? (() => {}));
          if (action === 'skip-problematic' || action === 'escalate') {
            break;
          }
        }

        await PlannerAgent.cleanupAnalysisKeys(sessionId);

        
        
        
        if (!passError) {
          const reconciledCount = await PlannerAgent.reconcileFileDoneStatus(sessionId, modernPath);
          if (reconciledCount > 0) {
            onLog?.(
              `[PlannerAgent] Reconciled ${reconciledCount} file(s) as DONE from knowledge graph sources.`,
              'info'
            );
          }
        }

        
        
        taskCtx = await TaskContextManager.getContext(sessionId);
        const { entries: fileIndexAfter } = resolveFileIndexFromContext(taskCtx as Record<string, unknown>);
        const doneAfter = fileIndexAfter.filter((f: any) => f?.read_status === 'DONE').length;

        
        if (doneAfter > doneCount) {
          
          consecutiveStalls = 0;
          const analysisPct = 5 + Math.min(Math.round((doneAfter / Math.max(totalFiles, 1)) * 40), 40);
          onProgress?.(analysisPct, `Analyzed ${doneAfter} / ${totalFiles} files`);
        } else {
          
          consecutiveStalls++;
          onLog?.(
            `[PlannerAgent] Pass ${passNumber}: no new files marked DONE (${doneAfter}/${totalFiles}). ` +
            `Stall ${consecutiveStalls}/${MAX_STALLS}.`,
            'warning'
          );
          if (consecutiveStalls >= MAX_STALLS) {
            onLog?.(
              `[PlannerAgent] ${MAX_STALLS} consecutive stalled passes — agent is stuck. ` +
              `Advancing with ${doneAfter}/${totalFiles} files done.`,
              'warning'
            );
            onProgress?.(45, `Stalled at ${doneAfter} / ${totalFiles} files`);
            break;
          }
        }
      }

      if (passNumber >= MAX_PASSES) {
        onLog?.(`[PlannerAgent] Max passes (${MAX_PASSES}) reached. Advancing with partial analysis.`, 'warning');
      }

      onLog?.('[PlannerAgent] Stage 2/5: File analysis complete.', 'success');
      await onPhase?.('file-analysis', 'done');
      await onPhase?.('graph-resolution', 'active');
      await TaskContextManager.updateContext(sessionId, { active_phase: 'graph-resolution' });
      activePhase = 'graph-resolution';
    }

    
    
    
    
    
    
    
    
    
    if (activePhase === 'graph-resolution') {
      await onPhase?.('graph-resolution', 'active');
      onLog?.('[PlannerAgent] Stage 3/5: Graph Resolution (TypeScript + Architecture Synthesis)...', 'info');

      
      const preGraphCtx        = await TaskContextManager.getContext(sessionId);
      const totalUnitsCheck    = (preGraphCtx.TOTAL_CALLABLE_UNITS as number) ?? 0;
      const totalEntitiesCheck = (preGraphCtx.TOTAL_DATA_ENTITIES  as number) ?? 0;
      const totalEndptsCheck   = (preGraphCtx.TOTAL_API_ENDPOINTS  as number) ?? 0;
      const graphsAreEmpty     = totalUnitsCheck === 0
                              && totalEntitiesCheck === 0
                              && totalEndptsCheck === 0;

      if (graphsAreEmpty) {
        onLog?.(
          '[PlannerAgent] ⚠️ Graph quality gate: all 3 primary graphs are empty. ' +
          'TypeScript resolvers will be no-ops. Pass C runs to save counters (all = 0).',
          'warning'
        );
        await TaskContextManager.updateContext(sessionId, {
          GRAPH_QUALITY_GATE_TRIGGERED: true,
          GRAPH_QUALITY_GATE_REASON: 'All 3 primary graphs empty after Phase 2',
        });
      }

      if (!graphsAreEmpty) {
        
        onLog?.('[PlannerAgent] Stage 3A/5: TypeScript FK Resolution...', 'info');
        try {
          const fkCount = await resolveForeignKeys(modernPath);
          onLog?.(`[PlannerAgent] Stage 3A complete — ${fkCount} FK relation(s) resolved.`, 'success');
        } catch (fkErr: any) {
          onLog?.(`[PlannerAgent] Stage 3A FK error: ${fkErr.message}. Continuing.`, 'warning');
        }
        onProgress?.(47, 'Graph: FK relations resolved');

        
        onLog?.('[PlannerAgent] Stage 3B/5: TypeScript Call-Flow Graph...', 'info');
        try {
          const cfCount = await buildCallFlowGraph(modernPath);
          onLog?.(`[PlannerAgent] Stage 3B complete — ${cfCount} entry point(s) traced.`, 'success');
        } catch (cfErr: any) {
          onLog?.(`[PlannerAgent] Stage 3B call-flow error: ${cfErr.message}. Continuing.`, 'warning');
        }
        onProgress?.(50, 'Graph: Call-flow traced');
      } else {
        onLog?.('[PlannerAgent] Stage 3A+3B: TypeScript resolvers skipped (empty graphs).', 'warning');
      }

      
      onLog?.('[PlannerAgent] Stage 3C-pre: TypeScript importedBy + Migration Order...', 'info');
      try {
        await computeImportedBy(modernPath);
        const migrationOrder = await computeMigrationOrder(modernPath);
        if (migrationOrder.length > 0) {
          await TaskContextManager.updateContext(sessionId, {
            MIGRATION_ORDER: migrationOrder.map((filePath, i) => ({ rank: i + 1, file: filePath })),
          });
          onLog?.(`[PlannerAgent] Migration order: top ${migrationOrder.length} files ranked.`, 'success');
        } else {
          onLog?.('[PlannerAgent] Migration order: no import data — imports-graph may be empty.', 'info');
        }
      } catch (ibErr: any) {
        onLog?.(`[PlannerAgent] importedBy error: ${ibErr.message}. Continuing.`, 'warning');
      }

      onLog?.('[PlannerAgent] Stage 3C/5: Architecture Synthesis + Counters (LLM)...', 'info');
      onProgress?.(51, 'Graph: Synthesizing architecture');
      
      await withPhaseTimeout(
        AgentExecutor.execute(
          provider,
          GRAPH_PASS_C_SYSTEM + customSuffix,
          buildGraphPassCUserPrompt(legacyPath, detectedStack.language, detectedStack.framework),
          graphTools, context, resolvedModel, 'graph-resolver-architecture'
        ),
        PHASE_TIMEOUT_MS.graphPass,
        'graph-pass-C',
        onLog
      );
      onLog?.('[PlannerAgent] Stage 3C complete — architecture synthesized.', 'success');
      
      onProgress?.(53, 'Graph: Architecture complete');

      
      await PlannerAgent.validateGraphResolverOutputs(modernPath, onLog);

      
      const ctxAfterGraph = await TaskContextManager.getContext(sessionId);
      const countersPresent = ctxAfterGraph.TOTAL_CALLABLE_UNITS !== undefined
                           || ctxAfterGraph.TOTAL_DATA_ENTITIES  !== undefined
                           || ctxAfterGraph.TOTAL_API_ENDPOINTS  !== undefined;

      
      
      
      if (!countersPresent) {
        onLog?.(
          '[PlannerAgent] Pass C did not save G5 counters. Auto-running Pass D (counter recovery)...',
          'warning'
        );
        try {
          
          await withPhaseTimeout(
            AgentExecutor.execute(
              provider,
              GRAPH_PASS_D_SYSTEM + customSuffix,
              buildGraphPassDUserPrompt(legacyPath, detectedStack.language, detectedStack.framework),
              graphTools, context, resolvedModel, 'graph-resolver-counters'
            ),
            PHASE_TIMEOUT_MS.graphPass,
            'graph-pass-D',
            onLog
          );
          const ctxAfterPassD = await TaskContextManager.getContext(sessionId);
          const passDCounters = ctxAfterPassD.TOTAL_CALLABLE_UNITS !== undefined
                             || ctxAfterPassD.TOTAL_DATA_ENTITIES   !== undefined
                             || ctxAfterPassD.TOTAL_API_ENDPOINTS   !== undefined;
          if (passDCounters) {
            onLog?.(
              `[PlannerAgent] Pass D recovered counters: ${ctxAfterPassD.TOTAL_CALLABLE_UNITS ?? 0} functions | ` +
              `${ctxAfterPassD.TOTAL_DATA_ENTITIES ?? 0} entities | ` +
              `${ctxAfterPassD.TOTAL_API_ENDPOINTS ?? 0} endpoints`,
              'success'
            );
          } else {
            onLog?.(
              '[PlannerAgent] Pass D also failed to save counters. Section 26 will show zeros. ' +
              'Check graph-resolver-counters logs for details.',
              'warning'
            );
          }
        } catch (passDErr: any) {
          onLog?.(
            `[PlannerAgent] Pass D failed: ${passDErr.message}. Continuing to section writing.`,
            'warning'
          );
        }
      } else {
        onLog?.(
          `[PlannerAgent] Graph counters: ${ctxAfterGraph.TOTAL_CALLABLE_UNITS ?? 0} functions | ` +
          `${ctxAfterGraph.TOTAL_DATA_ENTITIES ?? 0} entities | ` +
          `${ctxAfterGraph.TOTAL_API_ENDPOINTS ?? 0} endpoints | ` +
          `${ctxAfterGraph.TOTAL_BUSINESS_RULES ?? 0} rules`,
          'info'
        );
      }

      onLog?.('[PlannerAgent] Stage 3/5: 3-pass graph resolution complete.', 'success');
      onProgress?.(55, 'Graph Resolution');
      await onPhase?.('graph-resolution', 'done');
      await onPhase?.('section-writing', 'active');
      await TaskContextManager.updateContext(sessionId, { active_phase: 'section-writing' });
      activePhase = 'section-writing';
    }

    
    
    
    
    
    
    if (activePhase === 'section-writing') {
      onLog?.('[PlannerAgent] Stage 4/5: Writing 26 sections...', 'info');
      await onPhase?.('section-writing', 'active');

      
      const alreadyWritten = await getWrittenSections(modernPath);

      
      
      
      const taskCtxSections = await TaskContextManager.getContext(sessionId);
      const naSkippedSections = new Set<number>();
      for (const key of Object.keys(taskCtxSections)) {
        if (key.startsWith('SECTION_') && key.endsWith('_STATUS')) {
          const n = parseInt(key.replace('SECTION_', '').replace('_STATUS', ''), 10);
          if (!isNaN(n) && taskCtxSections[key] === 'skipped-empty-graph') {
            naSkippedSections.add(n);
          }
        }
      }
      if (naSkippedSections.size > 0) {
        onLog?.(
          `[PlannerAgent] Resume: ${naSkippedSections.size} section(s) previously marked N/A — skipping LLM calls.`,
          'info'
        );
      }

      
      
      let sectionsWritten = alreadyWritten.size + naSkippedSections.size;
      const totalSections = SECTION_CONFIG.length; 

      
      const batches = buildParallelSectionGroups(SECTION_CONFIG);

      
      const maxConcurrent = computeMaxConcurrentSections(resolvedModel);
      onLog?.(`[PlannerAgent] Section writer concurrency: ${maxConcurrent} parallel (model: ${resolvedModel || 'default'})`, 'info');

      for (const batch of batches) {
        
        const themeNames = [...new Set(batch.map(s => getSectionThemeName(s.n)))];
        const sectionNums = batch.map(s => s.n).join(', ');
        onLog?.(
          `[PlannerAgent] Dispatching sections [${sectionNums}] — themes: ${themeNames.join(' | ')}`,
          'info'
        );

        await runWithConcurrencyLimit(
          batch.map(section => () =>
            PlannerAgent.writeSingleSection(
              section,
              provider,
              SECTION_SYSTEM_PROMPT + customSuffix,
              modernPath,
              sectionTools,
              context,
              resolvedModel,
              alreadyWritten,
              naSkippedSections,   
              sessionId,           
              detectedStack.language,  
              detectedStack.framework, 
              onLog,
              () => {
                sectionsWritten++;
                const pct = 55 + Math.round((sectionsWritten / totalSections) * 35);
                onProgress?.(Math.min(pct, 90), `Section ${sectionsWritten} / ${totalSections}`);
              }
            )
          ),
          maxConcurrent
        );
      }

      await onPhase?.('section-writing', 'done');
      await onPhase?.('assembly', 'active');
      await TaskContextManager.updateContext(sessionId, { active_phase: 'assembly' });
      activePhase = 'assembly';
    }

    
    
    
    
    if (activePhase === 'assembly') {
      onLog?.('[PlannerAgent] Stage 5/5: Assembling Stage1_Analysis.md...', 'info');
      await onPhase?.('assembly', 'active');

      const { missingSections } = await assembleSections(modernPath, sessionId, onLog);

      await TaskContextManager.updateContext(sessionId, {
        active_phase:            'complete',
        STAGE1_ANALYSIS_WRITTEN: true,
        MISSING_SECTIONS:        missingSections,
        STAGE1_COMPLETED_AT:     new Date().toISOString(),
      });

      onLog?.(
        missingSections.length > 0
          ? `[PlannerAgent] WARNING: ${missingSections.length} sections missing: ${missingSections.join(', ')}`
          : '[PlannerAgent] Stage 1 complete. All 26 sections written.',
        missingSections.length > 0 ? 'warning' : 'success'
      );
      onProgress?.(98, 'Assembling Stage1_Analysis.md');
      await onPhase?.('assembly', 'done');
    }

    return 'Stage 1 analysis complete.';
  }

  

  
  private static async writeSingleSection(
    section:          SectionConfig,
    provider:         StreamingProvider,
    systemPrompt:     string,
    modernPath:       string,
    tools:            ReturnType<typeof toolRegistry.getFunctions>,
    context:          ToolContext,
    resolvedModel:    string,
    alreadyWritten:   Set<number>,
    naSkippedSections: Set<number>,  
    sessionId:        string,         
    language?:        string,         
    framework?:       string,         
    onLog?:           (msg: string, lvl?: 'info' | 'success' | 'error' | 'warning') => void,
    onSectionDone?:   () => void
  ): Promise<void> {
    const nn          = String(section.n).padStart(2, '0');
    const sectionFile = path.join(modernPath, '_analysis', 'sections', `section-${nn}.md`);
    const graphsDir   = path.join(modernPath, '_analysis'); 

    if (alreadyWritten.has(section.n)) {
      onLog?.(`[PlannerAgent] Section ${section.n} already on disk — skipping.`, 'info');
      return;
    }

    
    
    if (naSkippedSections.has(section.n)) {
      onLog?.(`[PlannerAgent] Section ${section.n} previously marked N/A — skipping (no graph data for this codebase).`, 'info');
      onSectionDone?.();
      return;
    }

    
    
    
    
    if (section.graph) {
      const graphFile = path.join(graphsDir, `${section.graph}-graph.json`);
      const graphExists = await fs.pathExists(graphFile);

      if (!graphExists) {
        if (section.emptyGraphIsValid) {
          
          await PlannerAgent.writeEmptySection(sectionFile, section, 'graph file not found — not applicable for this codebase');
          await TaskContextManager.updateContext(sessionId, { [`SECTION_${section.n}_STATUS`]: 'skipped-empty-graph' });
          onLog?.(`[PlannerAgent] Section ${section.n}: ${section.graph}-graph not found — writing "not applicable" note.`, 'info');
          onSectionDone?.();
          return;
        }
        
        onLog?.(`[PlannerAgent] Section ${section.n}: ${section.graph}-graph missing (resolver may have skipped it) — attempting LLM write.`, 'warning');
      } else {
        
        try {
          const graphRaw  = await fs.readFile(graphFile, 'utf-8');
          const graphData = JSON.parse(graphRaw);

          
          const isEmpty = PlannerAgent.isGraphEmpty(graphData);
          if (isEmpty && section.emptyGraphIsValid) {
            
            await PlannerAgent.writeEmptySection(sectionFile, section, `${section.graph} graph contains no entries — not applicable for this codebase`);
            await TaskContextManager.updateContext(sessionId, { [`SECTION_${section.n}_STATUS`]: 'skipped-empty-graph' });
            onLog?.(`[PlannerAgent] Section ${section.n}: ${section.graph}-graph is empty — writing "not applicable" note (emptyGraphIsValid=true).`, 'info');
            onSectionDone?.();
            return;
          }
        } catch {
          
          onLog?.(`[PlannerAgent] Section ${section.n}: could not parse ${section.graph}-graph.json — proceeding with LLM.`, 'warning');
        }
      }
    }

    
    const minBytes = section.minContentBytes;

    onLog?.(`[PlannerAgent] Writing section ${section.n}: ${section.name}...`, 'info');
    const userPrompt = buildSectionUserPrompt(section, modernPath, language, framework);

    
    await withPhaseTimeout(
      AgentExecutor.execute(
        provider, systemPrompt, userPrompt, tools, context,
        resolvedModel, `section-${section.n}`
      ),
      PHASE_TIMEOUT_MS.section,
      `section-${section.n}-first-attempt`,
      onLog
    );

    
    const { valid, failureReason } = await PlannerAgent.validateSectionFile(sectionFile, minBytes, section);
    if (valid) {
      const stat = await fs.stat(sectionFile);
      onLog?.(`[PlannerAgent] Section ${section.n} written: ${section.name} (${stat.size} bytes)`, 'success');
      onSectionDone?.();
      return;
    }

    
    
    onLog?.(`[PlannerAgent] Section ${section.n} needs retry — ${failureReason}`, 'warning');

    const retryPrompt = userPrompt +
      `\n\nPREVIOUS ATTEMPT FAILED: ${failureReason}\n` +
      `The section file is either missing or has fewer than ${minBytes} bytes of content.\n` +
      `Fix: Read the data source again (${section.graph ? `read-knowledge-graph("${section.graph}")` : 'get_task_context'}) ` +
      `and write ALL entries found. Include every item — do not truncate.\n` +
      `Then call write_file to save the complete section.`;

    
    await withPhaseTimeout(
      AgentExecutor.execute(
        provider, systemPrompt, retryPrompt, tools, context,
        resolvedModel, `section-${section.n}-retry`
      ),
      PHASE_TIMEOUT_MS.section,
      `section-${section.n}-retry`,
      onLog
    );

    
    const { valid: retryValid, failureReason: retryReason } = await PlannerAgent.validateSectionFile(sectionFile, minBytes, section);

    if (retryValid) {
      const retryStat = await fs.stat(sectionFile);
      onLog?.(`[PlannerAgent] Section ${section.n} written on retry (${retryStat.size} bytes).`, 'success');
      onSectionDone?.();
      return;
    }

    
    
    
    onLog?.(`[PlannerAgent] Section ${section.n} LLM failed twice (${retryReason}). Writing TypeScript fallback.`, 'error');

    const fallbackWritten = await PlannerAgent.writeFallbackSection(sectionFile, section, modernPath);
    if (fallbackWritten) {
      onLog?.(`[PlannerAgent] Section ${section.n} fallback written from raw graph data.`, 'warning');
    } else {
      
      await PlannerAgent.writeEmptySection(sectionFile, section, `LLM failed after 2 attempts — ${retryReason}`);
      onLog?.(`[PlannerAgent] Section ${section.n}: could not write from raw data. Informational note written.`, 'warning');
    }

    
    onSectionDone?.();
  }

  
  

  private static async validateSectionFile(
    filePath: string,
    minBytes: number,
    section:  SectionConfig
  ): Promise<{ valid: boolean; failureReason: string }> {
    if (!(await fs.pathExists(filePath))) {
      return { valid: false, failureReason: 'file was not created (agent did not call write_file)' };
    }
    const stat = await fs.stat(filePath);
    if (stat.size < minBytes) {
      return {
        valid: false,
        failureReason: `file is only ${stat.size} bytes (minimum ${minBytes} bytes for section ${section.n}: ${section.name})`
      };
    }
    return { valid: true, failureReason: '' };
  }

  

  private static async writeEmptySection(
    filePath: string,
    section:  SectionConfig,
    reason:   string
  ): Promise<void> {
    await fs.ensureDir(path.dirname(filePath));
    const content = [
      `## ${section.n}. ${section.name}`,
      '',
      `> ℹ️ Not applicable for this codebase.`,
      `> Reason: ${reason}`,
      '',
      `This section covers ${section.name.toLowerCase()}, which was not detected in this project.`,
      section.graph
        ? `The \`${section.graph}\` knowledge graph contained no entries.`
        : 'No relevant data was found in the task context.',
      '',
    ].join('\n');
    await fs.writeFile(filePath, content, 'utf-8');
  }

  
  
  

  private static async writeFallbackSection(
    filePath:   string,
    section:    SectionConfig,
    modernPath: string
  ): Promise<boolean> {
    if (!section.graph) return false;

    const graphFile = path.join(modernPath, '_analysis', `${section.graph}-graph.json`); 
    if (!(await fs.pathExists(graphFile))) return false;

    try {
      const graphRaw  = await fs.readFile(graphFile, 'utf-8');
      const graphData = JSON.parse(graphRaw);

      await fs.ensureDir(path.dirname(filePath));

      
      const lines: string[] = [
        `## ${section.n}. ${section.name}`,
        '',
        `> ⚠️ LLM section writer failed after 2 attempts. Raw graph data follows.`,
        `> This data was written directly by the TypeScript assembler from \`${section.graph}-graph.json\`.`,
        '',
      ];

      for (const [key, value] of Object.entries(graphData)) {
        if (value === null || value === undefined) continue;
        lines.push(`### ${key}`);
        lines.push('');
        if (Array.isArray(value) && value.length > 0) {
          lines.push('```json');
          lines.push(JSON.stringify(value.slice(0, 50), null, 2));  
          if (value.length > 50) lines.push(`// ... and ${value.length - 50} more entries`);
          lines.push('```');
        } else if (typeof value === 'object') {
          lines.push('```json');
          lines.push(JSON.stringify(value, null, 2).slice(0, 3000));  
          lines.push('```');
        } else {
          lines.push(String(value));
        }
        lines.push('');
      }

      await fs.writeFile(filePath, lines.join('\n'), 'utf-8');
      return true;
    } catch {
      return false;
    }
  }

  

  private static isGraphEmpty(graphData: unknown): boolean {
    if (!graphData || typeof graphData !== 'object') return true;
    const obj = graphData as Record<string, unknown>;

    
    for (const val of Object.values(obj)) {
      if (Array.isArray(val)  && val.length > 0)        return false;
      if (typeof val === 'object' && val !== null && Object.keys(val as object).length > 0) return false;
      if (typeof val === 'string' && val.trim().length > 0) return false;
      if (typeof val === 'number' && val > 0)           return false;
    }
    return true;
  }

  
  static async validateGraphResolverOutputs(
    modernPath: string,
    onLog?: (msg: string, lvl?: 'info' | 'success' | 'error' | 'warning') => void
  ): Promise<void> {
    const graphsDir = path.join(modernPath, '_analysis');
    const checks = [
      { name: 'call-flow',    sectionRef: 'Section 14',   critical: true  },
      { name: 'architecture', sectionRef: 'Section 2',    critical: true  },
      { name: 'entity',       sectionRef: 'Section 5',    critical: false },
      { name: 'symbol',       sectionRef: 'Sections 7+8', critical: false },
      { name: 'api',          sectionRef: 'Section 10',   critical: false },
    ];

    onLog?.('[GraphValidator] Validating graph resolver outputs...', 'info');

    for (const check of checks) {
      const graphPath = path.join(graphsDir, `${check.name}-graph.json`);
      try {
        const raw  = await fs.readFile(graphPath, 'utf-8').catch(() => '{}');
        const data = JSON.parse(raw) as Record<string, unknown>;
        
        const realKeys = Object.keys(data).filter(k => k !== '_sources');
        
        
        const realEntries = realKeys.filter(k => {
          const v = data[k];
          if (Array.isArray(v))                                    return v.length > 0;
          if (v && typeof v === 'object') return Object.keys(v as object).length > 0;
          if (typeof v === 'string')                               return (v as string).trim().length > 0;
          return v !== null && v !== undefined;
        });
        if (realEntries.length === 0) {
          onLog?.(
            `[GraphValidator] ⚠️ ${check.name}-graph: ${realKeys.length} key(s) but 0 real data entries` +
            ` (hollow graph — only metadata or empty objects). ` +
            `${check.sectionRef} will use TypeScript fallback or "not applicable" note.` +
            (check.critical ? ' (CRITICAL — check agent logs for errors)' : ''),
            'warning'
          );
        } else {
          onLog?.(
            `[GraphValidator] ✅ ${check.name}-graph: ${realEntries.length} real entries. ${check.sectionRef} ready.`,
            'success'
          );
        }
      } catch {
        onLog?.(`[GraphValidator] ⚠️ Could not read ${check.name}-graph.json.`, 'warning');
      }
    }
  }

  
  private static async cleanupAnalysisKeys(sessionId: string): Promise<void> {
    const ctx          = await TaskContextManager.getContext(sessionId);
    const analysisKeys = Object.keys(ctx).filter(k => k.startsWith('analysis:'));
    if (analysisKeys.length === 0) return;

    const deletions: Record<string, null> = {};
    analysisKeys.forEach(k => { deletions[k] = null; });
    try {
      await TaskContextManager.updateContext(sessionId, deletions);
    } catch {
      
    }
  }

  
  private static async reconcileFileDoneStatus(
    sessionId:  string,
    modernPath: string
  ): Promise<number> {
    const analysisDir = path.join(modernPath, '_analysis');
    if (!(await fs.pathExists(analysisDir))) return 0;

    
    const allSources = new Set<string>();
    try {
      const dirEntries = await fs.readdir(analysisDir);
      for (const entry of dirEntries) {
        if (!entry.endsWith('-graph.json')) continue;
        try {
          const graphData = await fs.readJson(path.join(analysisDir, entry)) as Record<string, unknown>;
          if (Array.isArray(graphData._sources)) {
            for (const src of graphData._sources as string[]) {
              
              if (src && !src.startsWith('_resolver/')) {
                allSources.add(src);
              }
            }
          }
        } catch {  }
      }
    } catch { return 0; }

    if (allSources.size === 0) return 0;

    
    const ctx = await TaskContextManager.getContext(sessionId);
    const { key: fileIndexKey, entries: fileIndex } = resolveFileIndexFromContext(ctx as Record<string, unknown>);
    if (fileIndex.length === 0) return 0;

    
    let updatedCount = 0;

    
    
    
    
    const NON_CODE_BASENAMES = new Set([
      'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'npm-shrinkwrap.json',
      'poetry.lock', 'pipfile.lock', 'cargo.lock', 'composer.lock', 'gemfile.lock', 'go.sum',
      '.gitignore', '.gitattributes', '.npmignore', '.dockerignore', '.eslintignore',
      '.prettierignore', '.editorconfig', '.nvmrc', '.node-version',
      'license', 'license.md', 'license.txt', 'changelog.md', 'changelog.txt',
      'contributing.md', 'security.md', 'readme.md', 'readme.rst', 'readme.txt', 'notice',
    ]);
    const NON_CODE_EXTENSIONS = new Set([
      '.lock', '.log', '.map',
      '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico',
      '.woff', '.woff2', '.ttf', '.eot', '.otf',
    ]);
    
    const NON_CODE_TYPES = new Set(['doc', 'asset']);

    for (const entry of fileIndex) {
      if (entry?.read_status === 'DONE') continue;

      
      if (allSources.has(entry?.path)) {
        entry.read_status = 'DONE';
        updatedCount++;
        continue;
      }

      
      if (entry?.path) {
        const basename  = path.basename(entry.path).toLowerCase();
        const extension = path.extname(entry.path).toLowerCase();
        const fileType  = (entry.type ?? '').toLowerCase();
        if (
          NON_CODE_TYPES.has(fileType) ||
          NON_CODE_BASENAMES.has(basename) ||
          NON_CODE_EXTENSIONS.has(extension)
        ) {
          entry.read_status = 'DONE';
          updatedCount++;
        }
      }
    }

    if (updatedCount === 0) return 0;

    
    try {
      await TaskContextManager.updateContext(sessionId, { [fileIndexKey]: fileIndex });
    } catch {  }

    return updatedCount;
  }
}

export { buildAnalysisUserPrompt as buildAnalyzerUserPrompt } from '../../prompts/file-analysis-prompt.js';
