// =============================================================================
//  planner-agent.ts — Stage 1: TypeScript Orchestrator
//
//  SNS IDE pattern:
//    - ONE AgentExecutor.execute() per phase — no restart loops
//    - TypeScript controls phase TRANSITIONS only — agent decides when it is done
//    - No turn counting from orchestrator — agent stops naturally (no more tool calls)
//    - If a phase needs a resume pass, TypeScript makes ONE more call — not a loop
//
//  Stage 1: Discovery        (1 call — discovers files, saves TOTAL_FILES)
//  Stage 2: File Analysis    (1 call + 1 optional resume — reads all source files)
//  Stage 3: Graph Resolution (1 call — resolves cross-references across graphs)
//  Stage 4: Section Writing  (26 calls parallel by graph group — writes one file each)
//  Stage 5: Assembly         (TypeScript only — no LLM)
// =============================================================================

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
import { DATA_AGENT_SYSTEM_PROMPT,    buildDataAgentUserPrompt    } from '../../prompts/data-agent-prompt.js';
import { BACKEND_AGENT_SYSTEM_PROMPT, buildBackendAgentUserPrompt } from '../../prompts/backend-agent-prompt.js';
import { LOGIC_AGENT_SYSTEM_PROMPT,   buildLogicAgentUserPrompt   } from '../../prompts/logic-agent-prompt.js';
import { INFRA_AGENT_SYSTEM_PROMPT,   buildInfraAgentUserPrompt   } from '../../prompts/infra-agent-prompt.js';
import { UI_AGENT_SYSTEM_PROMPT,      buildUIAgentUserPrompt      } from '../../prompts/ui-agent-prompt.js';
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
  routeFilesToDomains,
  deduplicateFileIndex,
  getBucketSummary,
} from './domain-router.js';
import fs   from 'fs-extra';
import path from 'path';
import glob from 'fast-glob';


// ── Constants ─────────────────────────────────────────────────────────────────

const REASONING_MODEL_ALIAS    = 'reasoning-model';
const CUSTOM_RULES_FRAGMENT_ID = 'system-agent-rules';

// ── Dynamic Turn Cap (from real FILE_INDEX data) ─────────────────────────────
// Replaces model-name-string matching with real signal.
// contextK: model's context window in thousands of tokens (from session config or model resolver).
// avgFileSizeLines: computed from actual FILE_INDEX.estimatedLines average.
// pendingCount: actual files still to process — never cap higher than this.
//
// Formula:
//   tokenBudget  = contextK * 1000 * 0.55  (55% of context for file content)
//   tokensPerFile = max(avgFileSizeLines * 4 + 500, 700)  (4 tok/line + graph overhead)
//   turnCap = min(floor(tokenBudget / tokensPerFile), pendingCount)
//
// If contextK is unknown: fall back to safe default of 22 files.

function computeTurnCapFromData(
  contextK:         number,   // model context window in K tokens (e.g. 1000 for 1M context)
  avgFileSizeLines: number,   // average lines across FILE_INDEX.estimatedLines
  pendingCount:     number    // files remaining to process
): number {
  if (contextK <= 0 || avgFileSizeLines <= 0) return Math.min(22, pendingCount);
  const tokenBudget   = contextK * 1000 * 0.55;
  const tokensPerFile = Math.max(avgFileSizeLines * 4 + 500, 700);
  const contextBased  = Math.floor(tokenBudget / tokensPerFile);
  // Clamp: at least 3 (never pointlessly small), at most pendingCount (never overshoot)
  return Math.min(Math.max(contextBased, 3), pendingCount);
}

// ── Dynamic Batch Size (from real FILE_INDEX data) ───────────────────────────
// Derived from actual pending file count — no hardcoded thresholds.
// Larger pending lists = smaller batches (stay within token budget per turn).

function computeBatchSizeFromData(pendingCount: number): number {
  if (pendingCount < 30)  return 10;  // tiny remaining set — batch aggressively
  if (pendingCount < 100) return 8;
  if (pendingCount < 300) return 5;
  return 3;                           // large remaining set — conservative
}

// ── Compute average file size from FILE_INDEX ──────────────────────────────
function computeAvgFileSizeLines(fileIndex: any[]): number {
  if (!fileIndex.length) return 150; // safe default
  const total = fileIndex.reduce((sum: number, f: any) => sum + (f?.estimatedLines ?? 0), 0);
  const avg   = Math.round(total / fileIndex.length);
  return avg > 0 ? avg : 150;
}

// ── Extract model context window K from resolved model name ───────────────
// Used for dynamic turn cap computation.
// Returns context window size in thousands of tokens.
function getModelContextK(modelName: string): number {
  const m = (modelName ?? '').toLowerCase();
  // Gemini family
  if (m.includes('gemini-2.5-pro'))    return 1000;
  if (m.includes('gemini-2.5-flash'))  return 1000;
  if (m.includes('gemini-2.0-flash'))  return 1000;
  if (m.includes('gemini-1.5-pro'))    return 1000;
  if (m.includes('gemini-1.5-flash'))  return 1000;
  // Claude family
  if (m.includes('claude-3-5-sonnet')) return 200;
  if (m.includes('claude-sonnet-4'))   return 200;
  if (m.includes('claude-opus-4'))     return 200;
  if (m.includes('claude-3-opus'))     return 200;
  if (m.includes('claude-haiku'))      return 200;
  if (m.includes('claude-3-haiku'))    return 200;
  // GPT family
  if (m.includes('gpt-4o'))            return 128;
  if (m.includes('gpt-4-turbo'))       return 128;
  if (m.includes('gpt-3.5'))           return 16;
  // Default: conservative 128K assumption for unknown models
  return 128;
}

// ── Model-Aware Section Writer Concurrency ─────────────────────────────────
// Derived from PROVIDER FAMILY (not hardcoded model names) — works for any model
// the user configures, including future models not yet known.
//
// Detection: same prefix-based family detection as agentExecutor.ts compaction.
// Limit = conservative estimate based on provider's typical RPM limit.
// gemini-*: 15 RPM free → 4 concurrent (fast flash models) or 2 (slower pro models)
// claude-*: paid tier  → 5 concurrent (sonnet) or 3 (opus)
// gpt-*/groq-*: 5 concurrent (paid tier)
// unknown: 3 concurrent (safe conservative default)

function computeMaxConcurrentSections(modelName: string): number {
  const m = (modelName ?? '').toLowerCase().trim();
  // Gemini family: 15 RPM free. Pro variants slower → reduce concurrency.
  if (m.startsWith('gemini-') || m.includes('gemini')) {
    if (m.includes('pro'))   return 2; // Pro models: longer latency, stricter RPD limits
    if (m.includes('flash')) return 4; // Flash models: fast, safe at 4 concurrent
    return 3;                          // Other Gemini variants: moderate
  }
  // Claude family: paid tier, generous RPM.
  if (m.startsWith('claude-') || m.includes('claude')) {
    if (m.includes('opus'))   return 3; // Opus: expensive, reduce concurrency
    if (m.includes('haiku'))  return 8; // Haiku: fast, high throughput
    return 5;                           // Sonnet and other Claude variants
  }
  // GPT family: paid tier.
  if (m.startsWith('gpt-') || m.includes('gpt')) return 4;
  // Groq: ultra-fast inference.
  if (m.startsWith('groq-') || m.includes('groq')) return 6;
  return 3; // Safe default for any unknown or future model
}

// ── Concurrency-Limited Parallel Executor ─────────────────────────────────
// Production equivalent of npm `p-limit` — semaphore-based concurrency control.
// No external dependency. Respects provider RPM limits without hardcoding.

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

// ── GAP 1: Per-Phase Timeout Wrapper ─────────────────────────────────────────
// Wraps any async operation with a hard timeout.
// Prevents the pipeline from hanging indefinitely on:
//   - Network outages or provider downtime
//   - LLM stuck in an infinite tool loop that rate-limit retry never resolves
//   - Node process blocking on a single awaited call forever
//
// Benefits:
//   ✅ Server never hangs permanently — always recovers within timeoutMs
//   ✅ active_phase is already saved before each execute() — resume works after timeout
//   ✅ Clear error message tells user which phase timed out and how long it waited

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

// ── Phase timeout limits (conservative — longer than any real execution) ──────
// Discovery: 6 min   (usually 30–90 sec)
// Analysis pass: 18 min   (can be long for 200+ file projects)
// Graph pass: 12 min  (per sub-pass — A/B/C/D)
// Section: 10 min  (per section — retry adds extra time)
const PHASE_TIMEOUT_MS = {
  discovery:     6  * 60_000,
  analysisPass:  18 * 60_000,
  graphPass:     12 * 60_000,
  section:       10 * 60_000,
} as const;

// ── 4-Category Error Handler ──────────────────────────────────────────────────
// Classifies every agent error into one of 4 action categories.
// No arbitrary retry counts — action is driven by error signal type.

type LogFn = (msg: string, lvl?: 'info' | 'success' | 'error' | 'warning') => void;
type ErrorAction = 'retry-rate-limit' | 'retry-depth' | 'skip-problematic' | 'escalate';

async function handleAnalysisError(
  error:       Error,
  passNumber:  number,
  pendingCount: number,
  onLog:       LogFn
): Promise<ErrorAction> {
  const msg = (error.message ?? '').toLowerCase();

  // Category 1: Rate limit / quota — exponential backoff, then retry same pass
  if (msg.includes('429') || msg.includes('rate limit') || msg.includes('quota') || msg.includes('too many')) {
    const delayMs = Math.min(Math.pow(2, passNumber) * 2_000, 120_000); // cap at 2 min
    onLog(
      `[PlannerAgent] Rate limit on pass ${passNumber}. Waiting ${Math.round(delayMs / 1000)}s before retry.`,
      'warning'
    );
    await new Promise(r => setTimeout(r, delayMs));
    return 'retry-rate-limit';
  }

  // Category 2: Timeout — resume from LAST_FILE_ANALYZED checkpoint
  if (msg.includes('timeout') || msg.includes('timed out') || msg.includes('phase timeout')) {
    onLog(
      `[PlannerAgent] Pass ${passNumber} timed out. ${pendingCount} files remain. ` +
      `Resuming from LAST_FILE_ANALYZED on next pass.`,
      'warning'
    );
    return 'retry-rate-limit'; // same action: retry the pass from checkpoint
  }

  // Category 3: First failure — retry with depth-recovery signal
  if (passNumber <= 2) {
    onLog(
      `[PlannerAgent] Pass ${passNumber} error: ${error.message}. ` +
      `Retrying — agent will resume from LAST_FILE_ANALYZED.`,
      'warning'
    );
    return 'retry-depth';
  }

  // Category 4: Repeated failures — skip and advance (log the remaining files as problematic)
  onLog(
    `[PlannerAgent] Pass ${passNumber} failed after ${passNumber} attempts: ${error.message}. ` +
    `Advancing with ${pendingCount} files still pending.`,
    'error'
  );
  return 'skip-problematic';
}

// \u2500\u2500 FILE_INDEX Resolution Helper \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
// Discovery agents have written file index under different key names across versions:
//   'file_index'   (underscore) \u2014 current discovery agent output
//   'file-index'   (dash)       \u2014 older discovery agent output
//   FILE_INDEX_KEY              \u2014 indirect: context stores the KEY NAME, not the array
//
// This function resolves to whichever key actually contains an array of file objects,
// preventing the Phase 2 loop from seeing an empty file index when data exists.
//
// Returns: { key: string; entries: any[] }
//   key     = the actual context key where the array was found
//   entries = the file index array (may be empty if nothing found)

const FILE_INDEX_CANDIDATE_KEYS = ['file_index', 'file-index', 'FILE_INDEX'] as const;

function resolveFileIndexFromContext(ctx: Record<string, unknown>): { key: string; entries: any[] } {
  // 1. Try FILE_INDEX_KEY indirection first (canonical path)
  const indirectKey = ctx['FILE_INDEX_KEY'] as string | undefined;
  if (indirectKey && Array.isArray(ctx[indirectKey]) && (ctx[indirectKey] as any[]).length > 0) {
    return { key: indirectKey, entries: ctx[indirectKey] as any[] };
  }

  // 2. Try known static key names (covers underscore AND dash variants)
  for (const candidate of FILE_INDEX_CANDIDATE_KEYS) {
    const val = ctx[candidate];
    if (Array.isArray(val) && val.length > 0) {
      return { key: candidate, entries: val as any[] };
    }
  }

  // 3. Scan all context keys for the first array of objects with a 'path' + 'read_status' field.
  //    Last resort — handles future key name variations.
  //    Skips null values (the stale-cleanup pass writes null, not undefined).
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

  // 4. Nothing found — return the indirect key (if any) with empty array
  return { key: indirectKey ?? 'file_index', entries: [] };
}

// ── PlannerAgent ──────────────────────────────────────────────────────────────

export class PlannerAgent {
  /**
   * Runs Stage 1: TypeScript orchestrator (SNS IDE pattern).
   *
   * TypeScript controls phase TRANSITIONS only.
   * Each phase calls AgentExecutor once — agent self-manages and stops naturally.
   * No restart loops — ONE optional resume pass per phase if progress was made.
   */
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

    // ── Resolve provider + model (shared utility — no duplication) ────────────
    const session        = await SessionManager.getSession(sessionId);
    const toolsConfig    : Record<string, boolean> = (session as any)?.toolsConfig    ?? {};
    const promptFragments: Record<string, string>  = (session as any)?.promptFragments ?? {};

    const { provider, resolvedModel } = await resolveStreamingProvider(sessionId, targetStack);

    // ── Tool context ─────────────────────────────────────────────────────────
    const context: ToolContext = {
      sessionId,
      legacyPath,
      modernPath,
      onLog: (msg, lvl) => onLog?.(msg, lvl),
    };

    // Optional custom rules from AI Config panel
    const customRules  = promptFragments[CUSTOM_RULES_FRAGMENT_ID];
    const customSuffix = customRules ? `\n\n<custom_rules>\n${customRules}\n</custom_rules>` : '';

    // ── Per-agent tool lists (filtered by UI toggle config) ──────────────────
    const filter = (def: typeof DISCOVERY_AGENT) =>
      toolRegistry.getFunctions(...def.functions).filter(t => toolsConfig[t.name] !== false);

    const discoveryTools = filter(DISCOVERY_AGENT);
    const analysisTools  = filter(STAGE1_PLANNER_AGENT);  // full tool set for file reading
    const graphTools     = filter(GRAPH_RESOLVER_AGENT);
    const sectionTools   = filter(SECTION_WRITER_AGENT);

    // ── Load current phase (resume support) ──────────────────────────────────
    let taskCtx     = await TaskContextManager.getContext(sessionId);
    let activePhase = (taskCtx.active_phase as string) || 'discovery';

    if (activePhase === 'complete') {
      onLog?.('[PlannerAgent] Stage 1 already complete.', 'success');
      return 'Stage 1 analysis already complete.';
    }

    onLog?.(`[PlannerAgent] Resuming from phase: "${activePhase}"`, 'info');

    // ═════════════════════════════════════════════════════════════════════════
    // STAGE 1 — Discovery
    // TypeScript checks: TOTAL_FILES saved before advancing to analysis.
    // ═════════════════════════════════════════════════════════════════════════
    if (activePhase === 'discovery') {
      onLog?.('[PlannerAgent] Stage 1/5: Workspace Discovery...', 'info');
      await onPhase?.('discovery', 'active');

      // ── Pre-flight: count source files in legacyPath BEFORE calling the LLM ──────
      // This is a fast TypeScript-only check (no LLM, no API call).
      // If the path has no files at all, we fail immediately with an actionable
      // error instead of letting the Discovery Agent run for 6 minutes and then
      // returning TOTAL_FILES=0.
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

      // GAP 1 applied: discovery has a 6-minute hard timeout
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

      // ── Guard 1: Zero files saved ───────────────────────────────────────────
      if (totalFiles === 0) {
        // Discovery agent ran but saved TOTAL_FILES=0.
        // Pre-flight confirmed ${preflightFileCount} files exist in legacyPath,
        // so this is an LLM-side failure (agent crashed or hit an API error before
        // calling edit_task_context to persist TOTAL_FILES and FILE_INDEX).
        // Phase is reset to 'discovery' so the next run retries from scratch.
        await TaskContextManager.updateContext(sessionId, { active_phase: 'discovery' });
        throw new Error(
          `[PlannerAgent] Discovery Agent returned TOTAL_FILES=0 for "${legacyPath}" ` +
          `(pre-flight found ${preflightFileCount} file(s) there). ` +
          'The LLM agent failed to save the file index — likely an API error or timeout. ' +
          'Phase reset to \'discovery\' — re-run to retry from the start.'
        );
      }

      // ── Guard 2: Suspiciously low file count (< 50% of initial scan) ────────
      // The initial workspace scan detected detectedStack.fileCount files.
      // If the discovery agent saved far fewer than expected, it missed subdirectories
      // (e.g. called getWorkspaceFileList instead of findFilesByPattern recursively).
      // Reset to discovery so it retries with the corrected prompt.
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

      // ── P0 Fix: Normalize stale file_index key (underscore → dash) ──────────────
      // The Discovery LLM sometimes writes 'file_index' (underscore) even though
      // FILE_INDEX_KEY is set to 'file-index' (dash).
      //
      // OLD (broken) logic: null out file_index, assuming file-index exists.
      //   If file-index was never written, the FILE_INDEX data is GONE →
      //   Phase 2 sees fileIndex=[] → "all done" exits immediately →
      //   all domain agents skipped → all knowledge graphs empty →
      //   Sections 5-26 say "not applicable" (this bug caused this run's failure).
      //
      // NEW (correct) logic:
      //   1. If 'file_index' (underscore) has data AND 'file-index' (dash) is empty/missing:
      //      → COPY underscore data to dash key (so downstream code finds it by FILE_INDEX_KEY)
      //   2. Then null out the underscore key to prevent Phase 2 key confusion.
      try {
        const staleCtx = await TaskContextManager.getContext(sessionId);
        const underscoreVal = staleCtx['file_index'];
        const dashVal       = staleCtx['file-index'];
        const hasUnderscoreData = Array.isArray(underscoreVal) && underscoreVal.length > 0;
        const hasDashData       = Array.isArray(dashVal)       && dashVal.length       > 0;

        if (hasUnderscoreData && !hasDashData) {
          // RESCUE: LLM wrote underscore only — copy to dash so FILE_INDEX_KEY works
          await TaskContextManager.updateContext(sessionId, {
            'file-index': underscoreVal,
            'file_index': null,
            'FILE_INDEX_KEY': 'file-index',
          });
          onLog?.(
            `[PlannerAgent] Normalized FILE_INDEX: copied ${
              (underscoreVal as any[]).length
            } entries from file_index → file-index (LLM used wrong key).`,
            'info'
          );
        } else if (hasUnderscoreData && hasDashData) {
          // Both exist: dash is already populated; null underscore to remove confusion
          await TaskContextManager.updateContext(sessionId, { 'file_index': null });
          onLog?.('[PlannerAgent] Removed duplicate file_index (underscore) — file-index (dash) already populated.', 'info');
        }
        // else: neither or only dash exists — nothing to do
      } catch { /* non-fatal — resolveFileIndexFromContext will fall back to scanning */ }

      await onPhase?.('file-analysis', 'active');
      await TaskContextManager.updateContext(sessionId, { active_phase: 'analysis' });
      activePhase = 'analysis';

    }

    // ═════════════════════════════════════════════════════════════════════════
    // STAGE 2 — File Analysis (Signal-Driven Loop)
    //
    // Primary exit: ALL files marked DONE in FILE_INDEX (real signal).
    // Safety ceiling: MAX_PASSES=50 (never reached under normal conditions).
    // Stall guard: 4 consecutive zero-progress passes → advance anyway.
    // Error handler: 4-category classifier drives retry vs. skip vs. escalate.
    // Turn cap: derived from real FILE_INDEX avg line count, not model name strings.
    // De-duplication: FILE_INDEX de-duped once after discovery (GAP 3 fix).
    // ═════════════════════════════════════════════════════════════════════════
    if (activePhase === 'analysis') {
      taskCtx = await TaskContextManager.getContext(sessionId);
      const totalFiles = (taskCtx.TOTAL_FILES as number) || 0;
      onLog?.(`[PlannerAgent] Stage 2/5: File Analysis (${totalFiles} files)...`, 'info');
      await onPhase?.('file-analysis', 'active');

      // ── GAP 3 Fix: De-duplicate FILE_INDEX once before analysis starts ────────
      // Discovery may run twice on resume, creating duplicate FILE_INDEX entries.
      // De-dupe eliminates DUPLICATE WRITE BLOCKED false-positives in the analysis agent.
      // Uses resolveFileIndexFromContext() so we find the array regardless of key name.
      {
        const { key: initKey, entries: rawFileIndex } = resolveFileIndexFromContext(taskCtx as Record<string, unknown>);
        if (rawFileIndex.length > 0) {
          const { deduped: dedupedIndex, removedCount } = deduplicateFileIndex(rawFileIndex as any);
          if (removedCount > 0) {
            await TaskContextManager.updateContext(sessionId, { [initKey]: dedupedIndex });
            onLog?.(`[PlannerAgent] De-duplicated FILE_INDEX (key="${initKey}"): removed ${removedCount} duplicate entries.`, 'info');
          }
          // Normalize: always set FILE_INDEX_KEY so downstream code can use the indirection path
          if (!(taskCtx as any)['FILE_INDEX_KEY']) {
            await TaskContextManager.updateContext(sessionId, { FILE_INDEX_KEY: initKey });
            onLog?.(`[PlannerAgent] Normalized FILE_INDEX_KEY to "${initKey}" (was missing from context).`, 'info');
          }
        }
      }

      let passNumber       = 0;
      let consecutiveStalls = 0;
      const MAX_PASSES = 50;  // safety ceiling ONLY — normal exit is pending.length === 0
      const MAX_STALLS = 4;   // require 4 consecutive zero-progress passes before advancing

      while (true) {
        // ── Real Signal: Check pending files before every pass ─────────────────
        taskCtx = await TaskContextManager.getContext(sessionId);
        const { key: fileIndexKey, entries: fileIndex } = resolveFileIndexFromContext(taskCtx as Record<string, unknown>);
        const pending   = fileIndex.filter((f: any) => f?.read_status !== 'DONE');
        const doneCount = fileIndex.length - pending.length;

        // ── CRITICAL GUARD: FILE_INDEX is empty but TOTAL_FILES > 0 ─────────────────
        // This means key resolution failed — the file index was not found in context.
        // Root causes:
        //   • Discovery LLM wrote 'file_index' (underscore) but FILE_INDEX_KEY='file-index' (dash)
        //     AND the normalization above did not copy it (e.g. the context was already corrupted).
        //   • The taskContext.json was partially written / corrupted.
        // Action: reset to discovery so the user gets a clear error, not silent "all done"
        //         which causes all sections to say "not applicable".
        if (fileIndex.length === 0 && totalFiles > 0) {
          await TaskContextManager.updateContext(sessionId, { active_phase: 'discovery', TOTAL_FILES: 0 });
          throw new Error(
            `[PlannerAgent] Phase 2 ABORT: FILE_INDEX is empty (key="${fileIndexKey}") ` +
            `but TOTAL_FILES=${totalFiles}. The Discovery LLM wrote the file index under ` +
            'a key that could not be resolved (likely \'file_index\' vs \'file-index\' mismatch). ' +
            'Phase reset to \'discovery\' — re-run to retry from Discovery.'
          );
        }

        // Primary exit: all files done (real signal — not a counter)
        if (pending.length === 0 && fileIndex.length > 0) {
          onLog?.(`[PlannerAgent] All ${fileIndex.length} files analyzed. Analysis complete.`, 'success');
          onProgress?.(45, `Analyzed ${fileIndex.length} / ${fileIndex.length} files`);
          break;
        }

        // Safety ceiling: counter only (never the primary control)
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

        // ── Domain-routed dispatch: route pending files to specialist agents ────
        // routeFilesToDomains() classifies each PENDING source/schema file into one
        // of 5 domain buckets (DATA / BACKEND / LOGIC / INFRA / UI) using file.role
        // and file.path — no LLM calls, no heuristic guessing.
        // Non-source files (config, doc, asset, build) are excluded by the router
        // and handled by the generic fallback agent below.
        const buckets     = routeFilesToDomains(pending as any);
        const bucketSummary = getBucketSummary(buckets);

        onLog?.(
          `[PlannerAgent] Analysis pass ${passNumber}: ${remaining} file(s) pending (${doneCount}/${fileIndex.length} done).`,
          'info'
        );
        if (bucketSummary) {
          onLog?.(`[PlannerAgent] Domain routing: ${bucketSummary}`, 'info');
        }

        // ── Data-driven turn cap + batch size (per-bucket, from real FILE_INDEX) ─
        const avgLines  = computeAvgFileSizeLines(fileIndex);
        const contextK  = getModelContextK(resolvedModel);
        const turnCap   = computeTurnCapFromData(contextK, avgLines, remaining);
        const batchSize = computeBatchSizeFromData(remaining);
        onLog?.(
          `[PlannerAgent] Pass ${passNumber} limits: turnCap=${turnCap} files | batchSize=${batchSize} ` +
          `(contextK=${contextK}K, avgLines=${avgLines}, pending=${remaining})`,
          'info'
        );

        // ── Domain agent dispatch map ────────────────────────────────────────────
        // Each bucket runs as an independent AgentExecutor call in parallel.
        // System prompt is domain-specific; user prompt lists only that bucket's files.
        type DomainDispatch = {
          bucket:     keyof typeof buckets;
          system:     string;
          userPrompt: string;
          agentId:    string;
        };

        const dispatches: DomainDispatch[] = [];

        if (buckets.DATA.length > 0) {
          dispatches.push({
            bucket:     'DATA',
            system:     DATA_AGENT_SYSTEM_PROMPT + customSuffix,
            userPrompt: buildDataAgentUserPrompt(legacyPath, buckets.DATA as any, detectedStack.language, detectedStack.framework),
            agentId:    `data-agent-pass${passNumber}`,
          });
        }
        if (buckets.BACKEND.length > 0) {
          dispatches.push({
            bucket:     'BACKEND',
            system:     BACKEND_AGENT_SYSTEM_PROMPT + customSuffix,
            userPrompt: buildBackendAgentUserPrompt(legacyPath, buckets.BACKEND as any, detectedStack.language, detectedStack.framework),
            agentId:    `backend-agent-pass${passNumber}`,
          });
        }
        if (buckets.LOGIC.length > 0) {
          dispatches.push({
            bucket:     'LOGIC',
            system:     LOGIC_AGENT_SYSTEM_PROMPT + customSuffix,
            userPrompt: buildLogicAgentUserPrompt(legacyPath, buckets.LOGIC as any, detectedStack.language, detectedStack.framework),
            agentId:    `logic-agent-pass${passNumber}`,
          });
        }
        if (buckets.INFRA.length > 0) {
          dispatches.push({
            bucket:     'INFRA',
            system:     INFRA_AGENT_SYSTEM_PROMPT + customSuffix,
            userPrompt: buildInfraAgentUserPrompt(legacyPath, buckets.INFRA as any, detectedStack.language, detectedStack.framework),
            agentId:    `infra-agent-pass${passNumber}`,
          });
        }
        if (buckets.UI.length > 0) {
          dispatches.push({
            bucket:     'UI',
            system:     UI_AGENT_SYSTEM_PROMPT + customSuffix,
            userPrompt: buildUIAgentUserPrompt(legacyPath, buckets.UI as any, detectedStack.language, detectedStack.framework),
            agentId:    `ui-agent-pass${passNumber}`,
          });
        }

        // Fallback: files not routed to any domain (non-source/schema types such as
        // config, doc, asset — excluded by routeFilesToDomains) use the generic agent.
        const routedPaths = new Set([
          ...buckets.DATA, ...buckets.BACKEND, ...buckets.LOGIC,
          ...buckets.INFRA, ...buckets.UI,
        ].map((f: any) => f.path));
        const unroutedFiles = pending.filter(f => !routedPaths.has((f as any).path));
        if (unroutedFiles.length > 0) {
          onLog?.(
            `[PlannerAgent] ${unroutedFiles.length} non-source file(s) → generic agent (config/doc/asset).`,
            'info'
          );
          dispatches.push({
            bucket:     'LOGIC',   // reuse LOGIC slot for typing — not a real bucket here
            system:     FILE_ANALYSIS_SYSTEM_PROMPT + customSuffix,
            userPrompt: buildAnalysisUserPrompt(
              legacyPath, lastAnalyzed, turnCap, batchSize,
              detectedStack.language, detectedStack.framework
            ),
            agentId: `file-analysis-agent-pass${passNumber}`,
          });
        }

        // If nothing to dispatch (e.g. all pending are already mid-flight), skip
        if (dispatches.length === 0) {
          onLog?.(`[PlannerAgent] Pass ${passNumber}: nothing to dispatch (0 routable files).`, 'warning');
        }

        // ── Execute all domain dispatches concurrently ───────────────────────────
        // Each domain agent runs independently — no shared mutable state per pass.
        // concurrencyLimit = 5 (one slot per domain bucket).
        let passError: Error | null = null;
        const passResults = await Promise.allSettled(
          dispatches.map(d =>
            withPhaseTimeout(
              AgentExecutor.execute(provider, d.system, d.userPrompt, analysisTools, context, resolvedModel, d.agentId),
              PHASE_TIMEOUT_MS.analysisPass,
              `analysis-pass-${passNumber}-${d.bucket}`,
              onLog
            )
          )
        );

        // Collect errors — if any domain agent failed, classify the worst one
        for (const result of passResults) {
          if (result.status === 'rejected') {
            const err = result.reason as Error;
            const action = await handleAnalysisError(err, passNumber, remaining, onLog ?? (() => {}));
            if (action === 'skip-problematic' || action === 'escalate') {
              passError = err;
              break;
            }
            // rate-limit / depth-retry: log but let other domain agents' results stand
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

        // ── TypeScript-side DONE reconciliation ──────────────────────────────
        // Safety net: marks files DONE if their path appears in any graph's _sources.
        // Covers cases where LLM wrote graphs but didn't call edit_task_context.
        if (!passError) {
          const reconciledCount = await PlannerAgent.reconcileFileDoneStatus(sessionId, modernPath);
          if (reconciledCount > 0) {
            onLog?.(
              `[PlannerAgent] Reconciled ${reconciledCount} file(s) as DONE from knowledge graph sources.`,
              'info'
            );
          }
        }

        // ── Stall guard: secondary safety net only ────────────────────────────
        // Re-read context to measure progress made in this pass
        taskCtx = await TaskContextManager.getContext(sessionId);
        const { entries: fileIndexAfter } = resolveFileIndexFromContext(taskCtx as Record<string, unknown>);
        const doneAfter = fileIndexAfter.filter((f: any) => f?.read_status === 'DONE').length;


        // Stall guard: compare THIS pass progress
        if (doneAfter > doneCount) {
          // Real progress made this pass — reset stall counter
          consecutiveStalls = 0;
          const analysisPct = 5 + Math.min(Math.round((doneAfter / Math.max(totalFiles, 1)) * 40), 40);
          onProgress?.(analysisPct, `Analyzed ${doneAfter} / ${totalFiles} files`);
        } else {
          // Zero progress this pass — increment stall counter
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

    // ═════════════════════════════════════════════════════════════════════════
    // STAGE 3 — Graph Resolution (TypeScript + 1 LLM call)
    //
    // Pass A (FK resolution):         TypeScript graph-resolver.ts — 0 LLM calls
    // Pass B (call-flow graph):        TypeScript graph-resolver.ts — 0 LLM calls
    // importedBy + MIGRATION_ORDER:    TypeScript graph-resolver.ts — 0 LLM calls
    // Pass C (architecture synthesis): 1 LLM call
    // Pass D (counter recovery):       1 LLM call — safety fallback only
    // ═════════════════════════════════════════════════════════════════════════
    if (activePhase === 'graph-resolution') {
      await onPhase?.('graph-resolution', 'active');
      onLog?.('[PlannerAgent] Stage 3/5: Graph Resolution (TypeScript + Architecture Synthesis)...', 'info');

      // ── Graph Quality Gate ─────────────────────────────────────────────────
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
        // ── TypeScript FK Resolution (replaces LLM Pass A) ──────────────────
        onLog?.('[PlannerAgent] Stage 3A/5: TypeScript FK Resolution...', 'info');
        try {
          const fkCount = await resolveForeignKeys(modernPath);
          onLog?.(`[PlannerAgent] Stage 3A complete — ${fkCount} FK relation(s) resolved.`, 'success');
        } catch (fkErr: any) {
          onLog?.(`[PlannerAgent] Stage 3A FK error: ${fkErr.message}. Continuing.`, 'warning');
        }
        onProgress?.(47, 'Graph: FK relations resolved');

        // ── TypeScript Call-Flow Graph (replaces LLM Pass B loop) ──────────
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

      // ── TypeScript importedBy + MIGRATION_ORDER ────────────────────────────
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
      // GAP 1 applied: Pass C has a 12-minute hard timeout
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
      // GAP 4: signal Pass C done before optional Pass D
      onProgress?.(53, 'Graph: Architecture complete');

      // ── Validate outputs from all 3 passes ──────────────────────────────────
      await PlannerAgent.validateGraphResolverOutputs(modernPath, onLog);

      // ── Verify G5 counters (Pass C is responsible for these) ────────────────
      const ctxAfterGraph = await TaskContextManager.getContext(sessionId);
      const countersPresent = ctxAfterGraph.TOTAL_CALLABLE_UNITS !== undefined
                           || ctxAfterGraph.TOTAL_DATA_ENTITIES  !== undefined
                           || ctxAfterGraph.TOTAL_API_ENDPOINTS  !== undefined;

      // Fix 4: If Pass C did not save counters, auto-run Pass D (counter-only recovery)
      // Pass D is a minimal 2-3 turn pass: reads all 8 graphs, counts real entries,
      // saves all 8 G5 counters. No architecture synthesis — just counts.
      if (!countersPresent) {
        onLog?.(
          '[PlannerAgent] Pass C did not save G5 counters. Auto-running Pass D (counter recovery)...',
          'warning'
        );
        try {
          // GAP 1 applied: Pass D (counter recovery) also has a 12-minute timeout
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

    // ═════════════════════════════════════════════════════════════════════════
    // STAGE 4 — Section Writing (26 focused agent calls, parallel by graph group)
    // Each section gets a FRESH context window — no exhaustion.
    // Agent self-manages per section: reads its graph, writes the file, stops.
    // TypeScript verifies each file exists. Retries once if missing.
    // ═════════════════════════════════════════════════════════════════════════
    if (activePhase === 'section-writing') {
      onLog?.('[PlannerAgent] Stage 4/5: Writing 26 sections...', 'info');
      await onPhase?.('section-writing', 'active');

      // Check which sections already exist on disk (resume support)
      const alreadyWritten = await getWrittenSections(modernPath);

      // GAP 2: also load sections previously determined N/A (no graph data)
      // Without this, N/A sections are re-attempted every resume — wasting LLM calls
      // on sections already confirmed to have no data in this codebase.
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

      // Shared counter for real per-section progress (55–90%)
      // JS is single-threaded — counter increments are safe despite parallel awaits
      let sectionsWritten = alreadyWritten.size + naSkippedSections.size;
      const totalSections = SECTION_CONFIG.length; // 26

      // Run sections in parallel batches (sections sharing a graph run sequentially)
      const batches = buildParallelSectionGroups(SECTION_CONFIG);

      // Model-aware concurrency: derived from provider family — no hardcoded model names
      const maxConcurrent = computeMaxConcurrentSections(resolvedModel);
      onLog?.(`[PlannerAgent] Section writer concurrency: ${maxConcurrent} parallel (model: ${resolvedModel || 'default'})`, 'info');

      for (const batch of batches) {
        // Log which theme groups are running in this batch (for user visibility)
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
              naSkippedSections,   // GAP 2: pass N/A set so section writer skips them
              sessionId,           // GAP 2: pass sessionId so N/A status can be persisted
              detectedStack.language,  // language signal for Claude Code level prompting
              detectedStack.framework, // framework signal
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

    // ═════════════════════════════════════════════════════════════════════════
    // STAGE 5 — Assembly (TypeScript only — no LLM)
    // Reads all 26 section files. Adds table of contents. Writes Stage1_Analysis.md.
    // ═════════════════════════════════════════════════════════════════════════
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

  // ── Private helpers ───────────────────────────────────────────────────────

  /**
   * Writes a single section file.
   * Retries ONCE if the file is not found after the first attempt.
   * Uses a fresh AgentExecutor call per section → fresh context window.
   */
  private static async writeSingleSection(
    section:          SectionConfig,
    provider:         StreamingProvider,
    systemPrompt:     string,
    modernPath:       string,
    tools:            ReturnType<typeof toolRegistry.getFunctions>,
    context:          ToolContext,
    resolvedModel:    string,
    alreadyWritten:   Set<number>,
    naSkippedSections: Set<number>,  // GAP 2: sections already confirmed N/A on a prior run
    sessionId:        string,         // GAP 2: needed to persist N/A status
    language?:        string,         // primary language from detectedStack
    framework?:       string,         // framework from detectedStack
    onLog?:           (msg: string, lvl?: 'info' | 'success' | 'error' | 'warning') => void,
    onSectionDone?:   () => void
  ): Promise<void> {
    const nn          = String(section.n).padStart(2, '0');
    const sectionFile = path.join(modernPath, '_analysis', 'sections', `section-${nn}.md`);
    const graphsDir   = path.join(modernPath, '_analysis'); // Fix: graphs are in _analysis/ directly, not _analysis/graphs/

    if (alreadyWritten.has(section.n)) {
      onLog?.(`[PlannerAgent] Section ${section.n} already on disk — skipping.`, 'info');
      return;
    }

    // GAP 2: skip sections previously confirmed N/A on a prior run
    // This prevents re-calling the LLM on sections already proven to have no data
    if (naSkippedSections.has(section.n)) {
      onLog?.(`[PlannerAgent] Section ${section.n} previously marked N/A — skipping (no graph data for this codebase).`, 'info');
      onSectionDone?.();
      return;
    }

    // ── Pattern 1: Pre-flight graph check ──────────────────────────────────────
    // If this section needs a graph, check whether the graph file exists and
    // has real data BEFORE calling the LLM. Empty + emptyGraphIsValid → write
    // a TypeScript-generated note directly (no wasted LLM call).
    if (section.graph) {
      const graphFile = path.join(graphsDir, `${section.graph}-graph.json`);
      const graphExists = await fs.pathExists(graphFile);

      if (!graphExists) {
        if (section.emptyGraphIsValid) {
          // GAP 2: persist N/A status so resume skips this section immediately
          await PlannerAgent.writeEmptySection(sectionFile, section, 'graph file not found — not applicable for this codebase');
          await TaskContextManager.updateContext(sessionId, { [`SECTION_${section.n}_STATUS`]: 'skipped-empty-graph' });
          onLog?.(`[PlannerAgent] Section ${section.n}: ${section.graph}-graph not found — writing "not applicable" note.`, 'info');
          onSectionDone?.();
          return;
        }
        // Graph missing but should exist — log warning and let LLM try anyway
        onLog?.(`[PlannerAgent] Section ${section.n}: ${section.graph}-graph missing (resolver may have skipped it) — attempting LLM write.`, 'warning');
      } else {
        // Graph exists — check if it has meaningful data
        try {
          const graphRaw  = await fs.readFile(graphFile, 'utf-8');
          const graphData = JSON.parse(graphRaw);

          // Determine if graph has any entries (check common top-level arrays)
          const isEmpty = PlannerAgent.isGraphEmpty(graphData);
          if (isEmpty && section.emptyGraphIsValid) {
            // GAP 2: persist N/A status so resume skips this section immediately
            await PlannerAgent.writeEmptySection(sectionFile, section, `${section.graph} graph contains no entries — not applicable for this codebase`);
            await TaskContextManager.updateContext(sessionId, { [`SECTION_${section.n}_STATUS`]: 'skipped-empty-graph' });
            onLog?.(`[PlannerAgent] Section ${section.n}: ${section.graph}-graph is empty — writing "not applicable" note (emptyGraphIsValid=true).`, 'info');
            onSectionDone?.();
            return;
          }
        } catch {
          // JSON parse failed — let the LLM try; it may recover
          onLog?.(`[PlannerAgent] Section ${section.n}: could not parse ${section.graph}-graph.json — proceeding with LLM.`, 'warning');
        }
      }
    }

    // ── Pattern 2: Per-section minimum bytes (from SectionConfig) ──────────────
    const minBytes = section.minContentBytes;

    onLog?.(`[PlannerAgent] Writing section ${section.n}: ${section.name}...`, 'info');
    const userPrompt = buildSectionUserPrompt(section, modernPath, language, framework);

    // ── First attempt (GAP 1: 10-minute timeout per section) ───────────────────
    await withPhaseTimeout(
      AgentExecutor.execute(
        provider, systemPrompt, userPrompt, tools, context,
        resolvedModel, `section-${section.n}`
      ),
      PHASE_TIMEOUT_MS.section,
      `section-${section.n}-first-attempt`,
      onLog
    );

    // ── Validate output ────────────────────────────────────────────────────────
    const { valid, failureReason } = await PlannerAgent.validateSectionFile(sectionFile, minBytes, section);
    if (valid) {
      const stat = await fs.stat(sectionFile);
      onLog?.(`[PlannerAgent] Section ${section.n} written: ${section.name} (${stat.size} bytes)`, 'success');
      onSectionDone?.();
      return;
    }

    // ── Pattern 3: Retry with specific failure reason ──────────────────────────
    // Tell the LLM exactly WHY it failed — not a generic "try again"
    onLog?.(`[PlannerAgent] Section ${section.n} needs retry — ${failureReason}`, 'warning');

    const retryPrompt = userPrompt +
      `\n\nPREVIOUS ATTEMPT FAILED: ${failureReason}\n` +
      `The section file is either missing or has fewer than ${minBytes} bytes of content.\n` +
      `Fix: Read the data source again (${section.graph ? `read-knowledge-graph("${section.graph}")` : 'get_task_context'}) ` +
      `and write ALL entries found. Include every item — do not truncate.\n` +
      `Then call write_file to save the complete section.`;

    // GAP 1: retry also has a 10-minute timeout
    await withPhaseTimeout(
      AgentExecutor.execute(
        provider, systemPrompt, retryPrompt, tools, context,
        resolvedModel, `section-${section.n}-retry`
      ),
      PHASE_TIMEOUT_MS.section,
      `section-${section.n}-retry`,
      onLog
    );

    // ── Validate retry output ─────────────────────────────────────────────────
    const { valid: retryValid, failureReason: retryReason } = await PlannerAgent.validateSectionFile(sectionFile, minBytes, section);

    if (retryValid) {
      const retryStat = await fs.stat(sectionFile);
      onLog?.(`[PlannerAgent] Section ${section.n} written on retry (${retryStat.size} bytes).`, 'success');
      onSectionDone?.();
      return;
    }

    // ── Pattern 4: TypeScript fallback — raw graph data dump ──────────────────
    // LLM failed twice. Instead of a useless placeholder, TypeScript reads the
    // raw graph JSON and writes a structured data dump. Partial but useful.
    onLog?.(`[PlannerAgent] Section ${section.n} LLM failed twice (${retryReason}). Writing TypeScript fallback.`, 'error');

    const fallbackWritten = await PlannerAgent.writeFallbackSection(sectionFile, section, modernPath);
    if (fallbackWritten) {
      onLog?.(`[PlannerAgent] Section ${section.n} fallback written from raw graph data.`, 'warning');
    } else {
      // Last resort: write a meaningful "not analyzed" note (never a bare placeholder)
      await PlannerAgent.writeEmptySection(sectionFile, section, `LLM failed after 2 attempts — ${retryReason}`);
      onLog?.(`[PlannerAgent] Section ${section.n}: could not write from raw data. Informational note written.`, 'warning');
    }

    // Always count as attempted — keeps progress counter accurate
    onSectionDone?.();
  }

  // ── Validation helper ──────────────────────────────────────────────────────
  // Pattern 2+3: per-section threshold, returns specific failure reason string

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

  // ── Pattern 1: Write "not applicable" note (not a blank placeholder) ────────

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

  // ── Pattern 4: TypeScript raw-graph fallback ──────────────────────────────
  // Reads the graph JSON directly and writes a structured data dump.
  // Returns true if fallback was written successfully.

  private static async writeFallbackSection(
    filePath:   string,
    section:    SectionConfig,
    modernPath: string
  ): Promise<boolean> {
    if (!section.graph) return false;

    const graphFile = path.join(modernPath, '_analysis', `${section.graph}-graph.json`); // Fix: no /graphs/ subdirectory
    if (!(await fs.pathExists(graphFile))) return false;

    try {
      const graphRaw  = await fs.readFile(graphFile, 'utf-8');
      const graphData = JSON.parse(graphRaw);

      await fs.ensureDir(path.dirname(filePath));

      // Write a structured dump of every top-level key in the graph
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
          lines.push(JSON.stringify(value.slice(0, 50), null, 2));  // cap at 50 entries
          if (value.length > 50) lines.push(`// ... and ${value.length - 50} more entries`);
          lines.push('```');
        } else if (typeof value === 'object') {
          lines.push('```json');
          lines.push(JSON.stringify(value, null, 2).slice(0, 3000));  // cap output size
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

  // ── Graph emptiness check ─────────────────────────────────────────────────

  private static isGraphEmpty(graphData: unknown): boolean {
    if (!graphData || typeof graphData !== 'object') return true;
    const obj = graphData as Record<string, unknown>;

    // Check all top-level values — if every array is empty and every object is {}, it's empty
    for (const val of Object.values(obj)) {
      if (Array.isArray(val)  && val.length > 0)        return false;
      if (typeof val === 'object' && val !== null && Object.keys(val as object).length > 0) return false;
      if (typeof val === 'string' && val.trim().length > 0) return false;
      if (typeof val === 'number' && val > 0)           return false;
    }
    return true;
  }



  /**
   * Validates outputs of the 3-pass Graph Resolver.
   * Checks the 5 most critical graphs and emits specific warnings for any that are empty.
   * Excludes _sources (internal dedup tracking) from entry counts.
   */
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
        // Exclude _sources (internal dedup metadata) from domain entry count
        const realKeys = Object.keys(data).filter(k => k !== '_sources');
        // Fix 8: Count real data entries — not just key existence.
        // A key with an empty object/array value (e.g. {synthesized_overview: {}}) is NOT real data.
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

  /**
   * Removes all analysis:[file] keys from task context after Stage 2.
   * These keys are 2-10 KB each and are no longer needed once their data
   * has been merged into knowledge graphs (which are stored separately as JSON files).
   * Removing them keeps Stage 3 and Stage 4 agent context windows small.
   */
  private static async cleanupAnalysisKeys(sessionId: string): Promise<void> {
    const ctx          = await TaskContextManager.getContext(sessionId);
    const analysisKeys = Object.keys(ctx).filter(k => k.startsWith('analysis:'));
    if (analysisKeys.length === 0) return;

    const deletions: Record<string, null> = {};
    analysisKeys.forEach(k => { deletions[k] = null; });
    try {
      await TaskContextManager.updateContext(sessionId, deletions);
    } catch {
      // Non-fatal — context cleanup is a best-effort optimization
    }
  }

  /**
   * Reconciles FILE_INDEX with knowledge graph _sources.
   *
   * Problem: the LLM frequently writes to knowledge graphs but never calls
   * edit_task_context to mark files DONE — because 429 / TURN_CAP cuts it off
   * before reaching step f/g. TypeScript can infer which files were processed
   * by reading the _sources arrays stored in every graph file.
   *
   * After every analysis pass, this method:
   *   1. Reads _sources from all *-graph.json files.
   *   2. Builds a set of all file paths that contributed data to any graph.
   *   3. For each FILE_INDEX entry whose path is in that set but is not DONE:
   *      marks it DONE and saves the updated FILE_INDEX.
   *
   * Returns the number of files newly marked DONE.
   */
  private static async reconcileFileDoneStatus(
    sessionId:  string,
    modernPath: string
  ): Promise<number> {
    const analysisDir = path.join(modernPath, '_analysis');
    if (!(await fs.pathExists(analysisDir))) return 0;

    // ── Step 1: Collect all file paths from every graph's _sources ─────────
    const allSources = new Set<string>();
    try {
      const dirEntries = await fs.readdir(analysisDir);
      for (const entry of dirEntries) {
        if (!entry.endsWith('-graph.json')) continue;
        try {
          const graphData = await fs.readJson(path.join(analysisDir, entry)) as Record<string, unknown>;
          if (Array.isArray(graphData._sources)) {
            for (const src of graphData._sources as string[]) {
              // Skip synthetic resolver sourceFiles (_resolver/...) — only real project files
              if (src && !src.startsWith('_resolver/')) {
                allSources.add(src);
              }
            }
          }
        } catch { /* corrupt graph file — skip */ }
      }
    } catch { return 0; }

    if (allSources.size === 0) return 0;

    // ── Step 2: Load FILE_INDEX from task context ──────────────────────────
    const ctx = await TaskContextManager.getContext(sessionId);
    const { key: fileIndexKey, entries: fileIndex } = resolveFileIndexFromContext(ctx as Record<string, unknown>);
    if (fileIndex.length === 0) return 0;

    // ── Step 3: Mark DONE for any file that contributed to a graph ─────────
    let updatedCount = 0;

    // Non-code file basenames that legitimately contribute to no knowledge graph.
    // These are always read (or trivially skipped) by the LLM but never appear in
    // _sources because they have no extractable data. Auto-mark them DONE so they
    // never block progress by staying PENDING indefinitely.
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
    // Auto-mark doc and asset typed files DONE — no graph data expected from these.
    const NON_CODE_TYPES = new Set(['doc', 'asset']);

    for (const entry of fileIndex) {
      if (entry?.read_status === 'DONE') continue;

      // Mark DONE if file contributed to any graph
      if (allSources.has(entry?.path)) {
        entry.read_status = 'DONE';
        updatedCount++;
        continue;
      }

      // Auto-mark DONE if it is a known type (doc/asset) or a known non-code file
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

    // ── Step 4: Persist the updated FILE_INDEX ─────────────────────────────
    try {
      await TaskContextManager.updateContext(sessionId, { [fileIndexKey]: fileIndex });
    } catch { /* non-fatal — will be retried next pass */ }

    return updatedCount;
  }
}


// ── Backward-compat export ────────────────────────────────────────────────────

export { buildAnalysisUserPrompt as buildAnalyzerUserPrompt } from '../../prompts/file-analysis-prompt.js';
