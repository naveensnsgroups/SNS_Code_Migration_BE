

import { DetectedStack, TargetStack } from '../../types.js';
import { toolRegistry }               from '../../core/tool-invocation-registry.js';
import { ToolContext }                 from '../../types/tool.js';
import { AgentExecutor }              from '../core/agentExecutor.js';
import { TaskContextManager }         from '../../session/taskContext.js';
import { SessionManager }             from '../../session/sessionManager.js';
import { resolveStreamingProvider }   from '../../ai/index.js';
import {
  DISCOVERY_AGENT,
  GRAPH_RESOLVER_AGENT,
  SECTION_WRITER_AGENT,
  ANALYSIS_AGENT,
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
  buildParallelSectionGroups,
  getSectionThemeName,
} from '../../prompts/section-writer-prompt.js';

import { assembleSections, getWrittenSections } from './section-assembler.js';
import {
  resolveForeignKeys,
  buildCallFlowGraph,
  computeImportedBy,
  computeMigrationOrder,
  reconcilePendingHandlerShapes,
  arePrimaryGraphsEmpty,
  validateGraphResolverOutputs,
} from './graph-resolver.js';
import {
  deduplicateFileIndex,
} from './domain-router.js';
import {
  resolveFileIndexFromContext,
  normalizeFileIndexKeys,
  cleanupAnalysisKeys,
  reconcileFileDoneStatus,
} from './file-index-manager.js';
import { writeSingleSection } from './section-writer-runner.js';
import {
  LogFn,
  runWithConcurrencyLimit,
  withPhaseTimeout,
  computeTurnCapFromData,
  computeBatchSizeFromData,
  computeAvgFileSizeLines,
  getModelContextK,
  computeMaxConcurrentSections,
} from '../core/agent-concurrency-utils.js';

import fs   from 'fs-extra';
import glob from 'fast-glob';

const CUSTOM_RULES_FRAGMENT_ID = 'system-agent-rules';

const PHASE_TIMEOUT_MS = {
  discovery:     6  * 60_000,
  analysisPass:  18 * 60_000,
  graphPass:     12 * 60_000,
  section:       10 * 60_000,
} as const;

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

// Sentinel return value: the pipeline observed a user Stop/Pause request at a
// checkpoint and halted. Session status has already been updated by the caller's
// cancellation callback; active_phase remains saved so the run can resume.
export const STAGE1_ABORTED = 'STAGE1_ABORTED';

// Returned when the pipeline reaches the HITL checkpoint after graph-resolution.
// active_phase is already persisted at 'section-writing', so a later
// /continue-analysis resumes straight into section writing (same resume
// mechanism as pause/abort). The orchestrator sets status 'awaiting-graph-review'
// and does NOT mark the run complete.
export const STAGE1_AWAITING_GRAPH_REVIEW = 'STAGE1_AWAITING_GRAPH_REVIEW';

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
    onPhase?:    (phaseId: string, status: 'active' | 'done' | 'error') => Promise<void>,
    shouldAbort?: () => Promise<boolean>
  ): Promise<string> {
    onLog?.('[PlannerAgent] Stage 1: Starting codebase analysis...', 'info');

    // Cancellation checkpoint used at phase boundaries, between analysis passes,
    // and between section batches. active_phase is already persisted at each of
    // these points, so halting here is always cleanly resumable.
    const abortRequested = async (): Promise<boolean> => {
      try {
        return (await shouldAbort?.()) === true;
      } catch {
        return false;
      }
    };


    const session        = await SessionManager.getSession(sessionId);
    const toolsConfig    : Record<string, boolean> = (session as any)?.toolsConfig    ?? {};
    const promptFragments: Record<string, string>  = (session as any)?.promptFragments ?? {};

    // Each phase below resolves its OWN provider/model — per-agent override, then
    // the agent's declared alias, then the global target model — so different
    // phases can genuinely run on different providers in the same pipeline run.
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
    // Analysis phase uses the dedicated ANALYSIS_AGENT's tool set (read/extract/
    // graph tools only). This deliberately excludes shell + directory-browsing,
    // which the FILE_ANALYSIS_SYSTEM_PROMPT explicitly forbids anyway.
    const analysisTools  = filter(ANALYSIS_AGENT);
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
      if (await abortRequested()) return STAGE1_ABORTED;
      onLog?.('[PlannerAgent] Stage 1/5: Workspace Discovery...', 'info');
      await onPhase?.('discovery', 'active');

      const { provider, resolvedModel } = await resolveStreamingProvider(sessionId, targetStack, DISCOVERY_AGENT);






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
          'discovery-agent',
          undefined,
          DISCOVERY_AGENT.recoveryHint
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
      await normalizeFileIndexKeys(sessionId, legacyPath, onLog);

      await onPhase?.('file-analysis', 'active');
      await TaskContextManager.updateContext(sessionId, { active_phase: 'analysis' });
      activePhase = 'analysis';

    }











    if (activePhase === 'analysis') {
      if (await abortRequested()) return STAGE1_ABORTED;
      taskCtx = await TaskContextManager.getContext(sessionId);
      const totalFiles = (taskCtx.TOTAL_FILES as number) || 0;
      onLog?.(`[PlannerAgent] Stage 2/5: File Analysis (${totalFiles} files)...`, 'info');
      await onPhase?.('file-analysis', 'active');

      const { provider, resolvedModel } = await resolveStreamingProvider(sessionId, targetStack, ANALYSIS_AGENT);





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
        // User Stop/Pause between passes: progress is already checkpointed
        // (LAST_FILE_ANALYZED + read_status per file), so halt cleanly here.
        if (await abortRequested()) return STAGE1_ABORTED;

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
        // Per-pass turn cap: bound the ReAct loop for one analysis pass so it
        // cannot spin for dozens of turns and exhaust a rate-limited token budget.
        // Allow a generous multiple of the file batch (read + graph writes + a
        // checkpoint per file), plus headroom, but never unbounded.
        const passMaxIterations = Math.max(12, batchSize * 6 + 8);
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
                `analysis-agent-pass${passNumber}`,
                passMaxIterations,
                ANALYSIS_AGENT.recoveryHint
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

        await cleanupAnalysisKeys(sessionId);

        // Re-normalize FILE_INDEX keys after every pass: if the LLM saved its
        // progress under an alternate key variant during this pass, merge it back
        // into canonical "file-index" now instead of orphaning it until a re-run.
        await normalizeFileIndexKeys(sessionId, legacyPath, onLog);




        if (!passError) {
          const reconciledCount = await reconcileFileDoneStatus(sessionId, modernPath);
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
      if (await abortRequested()) return STAGE1_ABORTED;
      await onPhase?.('graph-resolution', 'active');
      onLog?.('[PlannerAgent] Stage 3/5: Graph Resolution (TypeScript + Architecture Synthesis)...', 'info');

      const { provider, resolvedModel } = await resolveStreamingProvider(sessionId, targetStack, GRAPH_RESOLVER_AGENT);

// Gate on the actual Phase-2 graph files on disk. The TOTAL_* counters must NOT
      // be used here: they are only computed later by Pass C/D below, so reading them
      // at this point always yields 0/undefined on a first run and falsely triggers
      // the gate (which then wrongly skips the 3A/3B TypeScript resolvers).
      const graphsAreEmpty = await arePrimaryGraphsEmpty(modernPath);

      if (graphsAreEmpty) {
        onLog?.(
          '[PlannerAgent] Graph quality gate: all 3 primary graphs (symbol/entity/api) ' +
          'have no data on disk after Phase 2. TypeScript resolvers will be no-ops. ' +
          'Pass C runs to save counters (all = 0).',
          'warning'
        );
        await TaskContextManager.updateContext(sessionId, {
          GRAPH_QUALITY_GATE_TRIGGERED: true,
          GRAPH_QUALITY_GATE_REASON: 'All 3 primary graph files (symbol/entity/api) empty or missing on disk after Phase 2',
        });
      } else {
        // Clear any stale gate flag left by a previous run of this session.
        await TaskContextManager.updateContext(sessionId, {
          GRAPH_QUALITY_GATE_TRIGGERED: false,
          GRAPH_QUALITY_GATE_REASON: null,
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
          const { traced: cfCount, shallow: shallowEntryPoints } = await buildCallFlowGraph(modernPath);
          if (shallowEntryPoints.length > 0) {
            await TaskContextManager.updateContext(sessionId, {
              SHALLOW_CALLFLOW_ENTRIES: shallowEntryPoints,
            });
            onLog?.(
              `[PlannerAgent] Stage 3B: ${shallowEntryPoints.length} entry point(s) did not resolve to any file — flagged as shallow.`,
              'warning'
            );
          }
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
        const reconciledCount = await reconcilePendingHandlerShapes(sessionId, modernPath);
        if (reconciledCount > 0) {
          onLog?.(`[PlannerAgent] Reconciled ${reconciledCount} handler request/response shape(s) into api-graph.`, 'success');
        }
        await computeImportedBy(modernPath);
        const migrationOrder = await computeMigrationOrder(modernPath);
        if (migrationOrder.length > 0) {
          await TaskContextManager.updateContext(sessionId, {
            MIGRATION_ORDER: migrationOrder.map((filePath, i) => ({ rank: i + 1, file: filePath })),
          });
          onLog?.(`[PlannerAgent] Migration order: ${migrationOrder.length} files topologically ranked.`, 'success');
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
          graphTools, context, resolvedModel, 'graph-resolver-architecture',
          undefined, GRAPH_RESOLVER_AGENT.recoveryHint
        ),
        PHASE_TIMEOUT_MS.graphPass,
        'graph-pass-C',
        onLog
      );
      onLog?.('[PlannerAgent] Stage 3C complete — architecture synthesized.', 'success');

      onProgress?.(53, 'Graph: Architecture complete');


      await validateGraphResolverOutputs(modernPath, onLog);


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
              graphTools, context, resolvedModel, 'graph-resolver-counters',
              undefined, GRAPH_RESOLVER_AGENT.recoveryHint
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
      // Persist the resume point BEFORE the checkpoint: a later /continue-analysis
      // reads active_phase='section-writing' and resumes into the block below,
      // skipping graph-resolution (and this checkpoint) entirely.
      await TaskContextManager.updateContext(sessionId, { active_phase: 'section-writing' });
      activePhase = 'section-writing';

      // ── HITL checkpoint ──────────────────────────────────────────────────
      // Capture the real graph-resolution result for the human to review, then
      // halt. section-writing is intentionally NOT marked 'active' yet — it only
      // starts once the user chooses Continue (the block below sets it active).
      const ctxForSummary = await TaskContextManager.getContext(sessionId);
      const counters: Record<string, number> = {};
      for (const [k, v] of Object.entries(ctxForSummary)) {
        if (k.startsWith('TOTAL_') && typeof v === 'number') counters[k] = v;
      }
      await SessionManager.updateSession(sessionId, {
        graphResolutionSummary: {
          counters,
          primaryGraphsEmpty: await arePrimaryGraphsEmpty(modernPath),
          generatedAt: new Date().toISOString(),
        },
      });
      onLog?.(
        '[PlannerAgent] Graph resolution complete — awaiting review. ' +
        'Continue to write the analysis report, or skip to code migration.',
        'success'
      );
      return STAGE1_AWAITING_GRAPH_REVIEW;
    }







    if (activePhase === 'section-writing') {
      if (await abortRequested()) return STAGE1_ABORTED;
      onLog?.('[PlannerAgent] Stage 4/5: Writing 26 sections...', 'info');
      await onPhase?.('section-writing', 'active');

      const { provider, resolvedModel } = await resolveStreamingProvider(sessionId, targetStack, SECTION_WRITER_AGENT);


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
        // User Stop/Pause between batches: already-written sections are on disk
        // and detected on resume, so halting here loses no work.
        if (await abortRequested()) return STAGE1_ABORTED;

        const themeNames = [...new Set(batch.map(s => getSectionThemeName(s.n)))];
        const sectionNums = batch.map(s => s.n).join(', ');
        onLog?.(
          `[PlannerAgent] Dispatching sections [${sectionNums}] — themes: ${themeNames.join(' | ')}`,
          'info'
        );

        await runWithConcurrencyLimit(
          batch.map(section => () =>
            writeSingleSection(
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
              PHASE_TIMEOUT_MS.section,
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
      if (await abortRequested()) return STAGE1_ABORTED;
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
}

export { buildAnalysisUserPrompt as buildAnalyzerUserPrompt } from '../../prompts/file-analysis-prompt.js';
