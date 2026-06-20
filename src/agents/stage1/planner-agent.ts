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
import {
  GRAPH_RESOLUTION_SYSTEM_PROMPT,
  buildGraphResolutionUserPrompt,
  GRAPH_PASS_A_SYSTEM,
  buildGraphPassAUserPrompt,
  GRAPH_PASS_B_SYSTEM,
  buildGraphPassBUserPrompt,
  GRAPH_PASS_C_SYSTEM,
  buildGraphPassCUserPrompt,
  GRAPH_PASS_D_SYSTEM,           // Fix 4: counter-only recovery pass
  buildGraphPassDUserPrompt,     // Fix 4: counter-only recovery pass
} from '../../prompts/graph-resolution-prompt.js';
import {
  SECTION_SYSTEM_PROMPT,
  SECTION_CONFIG,
  SectionConfig,
  buildSectionUserPrompt,
  buildParallelSectionGroups,
} from '../../prompts/section-writer-prompt.js';
import { assembleSections, getWrittenSections } from './section-assembler.js';
import fs   from 'fs-extra';
import path from 'path';

// ── Constants ─────────────────────────────────────────────────────────────────

const REASONING_MODEL_ALIAS    = 'reasoning-model';
const CUSTOM_RULES_FRAGMENT_ID = 'system-agent-rules';

// ── Model-Aware Turn Cap ──────────────────────────────────────────────────────
// Computes the maximum number of files the file-analysis agent should process
// per session, based on the model's context window size.
// Larger context = more files per session.
// Free tier models need conservative caps to avoid rate limits and context exhaustion.

function computeTurnCap(modelName: string): number {
  const m = modelName.toLowerCase();
  if (m.includes('gemini-2.0-flash'))   return 35;  // 1M context, 15 RPM free
  if (m.includes('gemini-2.5-flash'))   return 35;
  if (m.includes('gemini-2.5-pro'))     return 30;  // 1M context, 50 RPD free — conservative
  if (m.includes('gemini-1.5-flash'))   return 30;
  if (m.includes('gemini-1.5-pro'))     return 28;
  if (m.includes('claude-opus-4'))      return 20;  // 200k context
  if (m.includes('claude-sonnet-4'))    return 25;
  if (m.includes('claude-3-5-sonnet'))  return 25;
  if (m.includes('claude-3-opus'))      return 18;
  if (m.includes('claude-3-haiku'))     return 20;
  if (m.includes('claude-haiku'))       return 20;
  if (m.includes('gpt-4o-mini'))        return 22;  // 128k context
  if (m.includes('gpt-4o'))             return 18;
  if (m.includes('gpt-4-turbo'))        return 18;
  if (m.includes('gpt-3.5'))            return 15;  // 16k context — very limited
  return 22;                                         // safe default for unknown models
}

// ── Project-Size-Aware Batch Size ─────────────────────────────────────────────
// Controls how many SMALL files (<= 200 lines) are read in a single batch-read-files call.
// More files in parallel = faster analysis, but higher token cost per turn.
// For large projects, reduce batch size to stay within token budgets.

function computeBatchSize(totalFiles: number): number {
  if (totalFiles < 30)  return 10;   // tiny project — batch aggressively
  if (totalFiles < 100) return 8;    // small project — moderate batching
  if (totalFiles < 300) return 5;    // medium project — conservative
  return 3;                          // large project — minimal, prioritise quality
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
        // Discovery agent ran but saved zero files.
        // This happens when: the workspace has no recognisable source files,
        // the agent hit an LLM error before calling edit_task_context, or
        // the legacy path was empty / misconfigured.
        //
        // SNS IDE pattern: reset phase to 'discovery' so the next run restarts
        // from Discovery, not from File Analysis with no FILE_INDEX.
        await TaskContextManager.updateContext(sessionId, { active_phase: 'discovery' });
        throw new Error(
          '[PlannerAgent] Discovery returned TOTAL_FILES=0. ' +
          'No source files were indexed. ' +
          'Possible causes: empty workspace, wrong legacyPath, or agent error. ' +
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

      // ── P0 Fix: Remove stale file_index (underscore) key ──────────────────
      // A prior discovery pass may have written 'file_index' (underscore) while
      // the current active key is 'file-index' (dash). If the Phase 2 agent reads
      // the stale key it sees 8 files all DONE and stops immediately — session stuck.
      // Solution: delete the underscore key immediately after discovery completes.
      try {
        const staleCtx = await TaskContextManager.getContext(sessionId);
        if (staleCtx['file_index'] !== undefined && staleCtx['FILE_INDEX_KEY'] === 'file-index') {
          await TaskContextManager.updateContext(sessionId, { file_index: null });
          onLog?.('[PlannerAgent] Cleaned up stale file_index key — preventing Phase 2 key confusion.', 'info');
        }
      } catch { /* non-fatal — best-effort cleanup */ }

      await onPhase?.('file-analysis', 'active');
      await TaskContextManager.updateContext(sessionId, { active_phase: 'analysis' });
      activePhase = 'analysis';

    }

    // ═════════════════════════════════════════════════════════════════════════
    // STAGE 2 — File Analysis (Full While Loop)
    // TypeScript loops as many times as needed until ALL files are DONE.
    // Stall guard: if a pass makes ZERO progress, agent is stuck → advance anyway.
    // Handles codebases of any size (3 files or 3,000 files).
    // ═════════════════════════════════════════════════════════════════════════
    if (activePhase === 'analysis') {
      taskCtx = await TaskContextManager.getContext(sessionId);
      const totalFiles = (taskCtx.TOTAL_FILES as number) || 0;
      onLog?.(`[PlannerAgent] Stage 2/5: File Analysis (${totalFiles} files)...`, 'info');
      await onPhase?.('file-analysis', 'active');

      let passNumber        = 0;
      let consecutiveStalls  = 0;    // how many passes in a row made zero progress
      const MAX_PASSES = 20;         // safety ceiling — no infinite loop ever
      const MAX_STALLS = 4;          // require 4 consecutive zero-progress passes before advancing
                                     // (2 was too aggressive — free-tier 429s cause false stalls)

      while (passNumber < MAX_PASSES) {
        passNumber++;

        // Re-read context to get LAST_FILE_ANALYZED for resume prompt
        taskCtx = await TaskContextManager.getContext(sessionId);
        const lastAnalyzed = taskCtx.LAST_FILE_ANALYZED as string | undefined;

        // Check done count BEFORE running this pass (used for stall detection)
        const fileIndexKey = taskCtx.FILE_INDEX_KEY as string | undefined;
        const fileIndex: any[] = fileIndexKey ? ((taskCtx[fileIndexKey] as any[]) ?? []) : [];
        const doneCount = fileIndex.filter((f: any) => f?.read_status === 'DONE').length;

        if (doneCount >= totalFiles) {
          onLog?.(`[PlannerAgent] All ${totalFiles} files analyzed.`, 'success');
          break;
        }

        const remaining = totalFiles - doneCount;
        const agentId   = passNumber === 1 ? 'file-analysis-agent' : `file-analysis-agent-pass${passNumber}`;
        onLog?.(`[PlannerAgent] Analysis pass ${passNumber}: ${remaining} files remaining (${doneCount}/${totalFiles} done).`, 'info');

        // Compute dynamic limits (model-aware + project-size-aware)
        const turnCap   = computeTurnCap(resolvedModel);
        const batchSize = computeBatchSize(totalFiles);
        onLog?.(`[PlannerAgent] Session limits: turnCap=${turnCap} files | batchSize=${batchSize} small files/batch (model: ${resolvedModel || 'default'})`, 'info');

        // GAP 1 applied: each analysis pass has an 18-minute hard timeout
        await withPhaseTimeout(
          AgentExecutor.execute(
            provider,
            FILE_ANALYSIS_SYSTEM_PROMPT + customSuffix,
            buildAnalysisUserPrompt(legacyPath, lastAnalyzed, turnCap, batchSize, detectedStack.language, detectedStack.framework),
            analysisTools,
            context,
            resolvedModel,
            agentId
          ),
          PHASE_TIMEOUT_MS.analysisPass,
          `analysis-pass-${passNumber}`,
          onLog
        );

        await PlannerAgent.cleanupAnalysisKeys(sessionId);

        // ── TypeScript-side DONE reconciliation ───────────────────────────────
        // The LLM often writes knowledge graphs but skips calling edit_task_context
        // to mark files DONE (hit by 429 / TURN_CAP before reaching that step).
        // TypeScript reads _sources from every graph file and marks any FILE_INDEX
        // entry DONE if its path appears in any graph's _sources array.
        // This is the safety net that makes progress visible regardless of LLM behaviour.
        const reconciledCount = await PlannerAgent.reconcileFileDoneStatus(
          sessionId, modernPath
        );
        if (reconciledCount > 0) {
          onLog?.(
            `[PlannerAgent] Reconciled ${reconciledCount} file(s) as DONE from knowledge graph sources.`,
            'info'
          );
        }

        // Re-read context to measure progress made in this pass
        taskCtx = await TaskContextManager.getContext(sessionId);
        const fileIndexKeyAfter   = taskCtx.FILE_INDEX_KEY as string | undefined;
        const fileIndexAfter: any[] = fileIndexKeyAfter ? ((taskCtx[fileIndexKeyAfter] as any[]) ?? []) : [];
        const doneAfter = fileIndexAfter.filter((f: any) => f?.read_status === 'DONE').length;

        if (doneAfter >= totalFiles) {
          onLog?.(`[PlannerAgent] All ${totalFiles} files analyzed after pass ${passNumber}.`, 'success');
          onProgress?.(45, `Analyzed ${doneAfter} / ${totalFiles} files`);
          break;
        }

        // Stall guard: compare THIS pass's progress (doneAfter vs doneCount at pass start)
        // A 429-interrupted pass may make no DONE marks but still made real progress —
        // so require 2 consecutive zero-progress passes before advancing.
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
    // STAGE 3 — Graph Resolution
    // ONE call. Agent resolves cross-refs, synthesizes architecture, saves counters.
    // Agent self-manages: reads all graphs, resolves references, stops naturally.
    // ═════════════════════════════════════════════════════════════════════════
    if (activePhase === 'graph-resolution') {
      await onPhase?.('graph-resolution', 'active');
      // ═══════════════════════════════════════════════════════════════════════
      // STAGE 3 — Graph Resolution (3 Context-Isolated Passes)
      //
      // Anthropic Context Isolation principle: each sub-agent starts fresh.
      // Benefits: full context capacity per pass, no context pollution,
      // better failure isolation (retry only the failed pass).
      //
      // Pass A: Entity FK resolution + entry point auth resolution
      // Pass B: Call flow graph (traces ALL entry points — no cap)
      // Pass C: Architecture synthesis + mandatory G5 counters
      // ═══════════════════════════════════════════════════════════════════════

      onLog?.('[PlannerAgent] Stage 3/5: Graph Resolution...', 'info');

      // ── Graph Quality Gate ─────────────────────────────────────────────────
      // If Phase 2 produced no data in the 3 primary graphs, running Pass A and
      // Pass B is wasteful — they only resolve cross-references in existing data.
      // Root cause: Phase 2 may have used a stale file-index key (all files DONE)
      // and written zero entries to knowledge graphs.
      // Action: skip Pass A+B, jump to Pass C (saves counters = all 0) + Pass D.
      const preGraphCtx = await TaskContextManager.getContext(sessionId);
      const totalUnitsCheck    = (preGraphCtx.TOTAL_CALLABLE_UNITS as number) ?? 0;
      const totalEntitiesCheck = (preGraphCtx.TOTAL_DATA_ENTITIES  as number) ?? 0;
      const totalEndptsCheck   = (preGraphCtx.TOTAL_API_ENDPOINTS  as number) ?? 0;
      const graphsAreEmpty     = totalUnitsCheck === 0
                              && totalEntitiesCheck === 0
                              && totalEndptsCheck === 0;

      if (graphsAreEmpty) {
        onLog?.(
          '[PlannerAgent] ⚠️ Graph quality gate: all 3 primary graphs are empty. ' +
          'Phase 2 may not have written to knowledge graphs (stale file-index key or zero-file session). ' +
          'Skipping Pass A (entity FK) and Pass B (call flows) — no data to resolve. ' +
          'Pass C will run to save counters (all = 0). Check Phase 2 logs for root cause.',
          'warning'
        );
        await TaskContextManager.updateContext(sessionId, {
          GRAPH_QUALITY_GATE_TRIGGERED: true,
          GRAPH_QUALITY_GATE_REASON: 'All 3 primary graphs empty after Phase 2',
        });
      }

      if (!graphsAreEmpty) {
        onLog?.('[PlannerAgent] Stage 3A/5: Entity & Auth Resolution...', 'info');
        // GAP 1 applied: graph passes each have a 12-minute hard timeout
        await withPhaseTimeout(
          AgentExecutor.execute(
            provider,
            GRAPH_PASS_A_SYSTEM + customSuffix,
            buildGraphPassAUserPrompt(legacyPath, detectedStack.language, detectedStack.framework),
            graphTools, context, resolvedModel, 'graph-resolver-entity-auth'
          ),
          PHASE_TIMEOUT_MS.graphPass,
          'graph-pass-A',
          onLog
        );
        onLog?.('[PlannerAgent] Stage 3A complete — entity FKs + auth resolved.', 'success');
        // GAP 4: granular progress — user sees sub-pass completion, not frozen 55%
        onProgress?.(47, 'Graph: Entity & Auth resolved');
      } else {
        onLog?.('[PlannerAgent] Stage 3A skipped — graphs are empty.', 'warning');
      }

      if (!graphsAreEmpty) {
        // Fix 3: Pass B now uses offset-based batching (15 endpoints per call).
        // Each call traces one batch, saves CALL_FLOW_OFFSET, then stops.
        // The orchestrator loops until offset >= CALL_FLOW_TOTAL (all endpoints traced).
        // This prevents context exhaustion that previously caused Pass C to never run.
        onLog?.('[PlannerAgent] Stage 3B/5: Call Flow Graph Construction (batched)...', 'info');
        const MAX_PASS_B_ROUNDS = 20; // Safety ceiling: 20 × 15 = 300 endpoints max
        let passBRound = 0;
        while (passBRound < MAX_PASS_B_ROUNDS) {
          passBRound++;
          const ctxBeforeB = await TaskContextManager.getContext(sessionId);
          const currentOffset = (ctxBeforeB.CALL_FLOW_OFFSET as number) ?? 0;
          const totalEndpoints = (ctxBeforeB.CALL_FLOW_TOTAL as number) ?? undefined;

          // If total is known and offset has reached or passed it — all traces done
          if (totalEndpoints !== undefined && currentOffset >= totalEndpoints) {
            onLog?.(`[PlannerAgent] Pass B complete — all ${totalEndpoints} entry points traced.`, 'success');
            break;
          }

          onLog?.(`[PlannerAgent] Pass B round ${passBRound}: tracing batch starting at offset ${currentOffset}...`, 'info');
          // GAP 1 applied: each Pass B round has a 12-minute timeout
          await withPhaseTimeout(
            AgentExecutor.execute(
              provider,
              GRAPH_PASS_B_SYSTEM + customSuffix,
              buildGraphPassBUserPrompt(legacyPath, currentOffset, detectedStack.language, detectedStack.framework),
              graphTools, context, resolvedModel, 'graph-resolver-callflow'
            ),
            PHASE_TIMEOUT_MS.graphPass,
            `graph-pass-B-round-${passBRound}`,
            onLog
          );

          // Read updated offset — if it didn't advance, stop to avoid an infinite loop
          const ctxAfterB = await TaskContextManager.getContext(sessionId);
          const newOffset = (ctxAfterB.CALL_FLOW_OFFSET as number) ?? currentOffset;
          const newTotal  = (ctxAfterB.CALL_FLOW_TOTAL as number) ?? undefined;

          if (newOffset <= currentOffset) {
            onLog?.(`[PlannerAgent] Pass B round ${passBRound}: offset did not advance (stuck at ${currentOffset}). Stopping Pass B.`, 'warning');
            break;
          }

          // GAP 3: Regression guard — offset going BACKWARDS means LLM reset it incorrectly
          if (newOffset < currentOffset) {
            onLog?.(
              `[PlannerAgent] Pass B round ${passBRound}: OFFSET REGRESSION detected ` +
              `(${currentOffset} → ${newOffset}). LLM reset the counter incorrectly. ` +
              `Stopping Pass B to prevent re-tracing already completed endpoints.`,
              'warning'
            );
            break;
          }

          // GAP 4: granular progress per Pass B round
          if (newTotal && newTotal > 0) {
            const bPct = 47 + Math.round((newOffset / newTotal) * 3); // 47% → 50%
            onProgress?.(Math.min(bPct, 50), `Call flow: ${newOffset} / ${newTotal} endpoints`);
          }

          // Check again with fresh values
          if (newTotal !== undefined && newOffset >= newTotal) {
            onLog?.(`[PlannerAgent] Pass B complete — all ${newTotal} entry points traced (${passBRound} rounds).`, 'success');
            break;
          }
        }
        if (passBRound >= MAX_PASS_B_ROUNDS) {
          onLog?.(`[PlannerAgent] Pass B hit round cap (${MAX_PASS_B_ROUNDS}). Proceeding to Pass C.`, 'warning');
        }
        onLog?.('[PlannerAgent] Stage 3B complete — call flows built.', 'success');
      } else {
        onLog?.('[PlannerAgent] Stage 3B skipped — graphs are empty.', 'warning');
      }

      onLog?.('[PlannerAgent] Stage 3C/5: Architecture Synthesis + Counters...', 'info');
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
    const fileIndexKey = ctx.FILE_INDEX_KEY as string | undefined;
    if (!fileIndexKey) return 0;

    const fileIndex: any[] = (ctx[fileIndexKey] as any[]) ?? [];
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
