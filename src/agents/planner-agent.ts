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

import { DetectedStack, TargetStack } from '../types.js';
import { toolRegistry }               from '../core/tool-invocation-registry.js';
import { ToolContext }                 from '../types/tool.js';
import { AgentExecutor }              from './agentExecutor.js';
import { TaskContextManager }         from '../session/taskContext.js';
import { SessionManager }             from '../session/sessionManager.js';
import { resolveStreamingProvider }   from '../ai/index.js';
import { StreamingProvider }          from '../types/language-model.js';
import {
  DISCOVERY_AGENT,
  GRAPH_RESOLVER_AGENT,
  SECTION_WRITER_AGENT,
  STAGE1_PLANNER_AGENT,
} from './agent-definitions.js';
import {
  DISCOVERY_SYSTEM_PROMPT,
  buildDiscoveryUserPrompt,
} from '../prompts/discovery-prompt.js';
import {
  FILE_ANALYSIS_SYSTEM_PROMPT,
  buildAnalysisUserPrompt,
} from '../prompts/file-analysis-prompt.js';
import {
  GRAPH_RESOLUTION_SYSTEM_PROMPT,
  buildGraphResolutionUserPrompt,
} from '../prompts/graph-resolution-prompt.js';
import {
  SECTION_SYSTEM_PROMPT,
  SECTION_CONFIG,
  SectionConfig,
  buildSectionUserPrompt,
  buildParallelSectionGroups,
} from '../prompts/section-writer-prompt.js';
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
    /** @deprecated Provider resolved from session config — not used. */
    _aiServiceLegacy: unknown,
    onLog?:      (message: string, level?: 'info' | 'success' | 'error' | 'warning') => void,
    onProgress?: (percent: number, currentFile?: string) => void
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

      await AgentExecutor.execute(
        provider,
        DISCOVERY_SYSTEM_PROMPT + customSuffix,
        buildDiscoveryUserPrompt(legacyPath, detectedStack),
        discoveryTools,
        context,
        undefined,       // maxIterations — agent stops naturally; undefined uses the default
        resolvedModel,
        'discovery-agent'
      );

      taskCtx = await TaskContextManager.getContext(sessionId);
      const totalFiles = (taskCtx.TOTAL_FILES as number | undefined) ?? 0;
      if (totalFiles === 0) {
        onLog?.(
          '[PlannerAgent] WARNING: TOTAL_FILES=0 after discovery. ' +
          'Workspace may have no source files, or the discovery agent hit an error. ' +
          'Advancing to analysis — agent will attempt to build FILE_INDEX from scratch.',
          'warning'
        );
      }

      onLog?.(`[PlannerAgent] Discovery complete: ${totalFiles} files indexed.`, 'success');
      onProgress?.(5, 'Workspace Discovery');
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

      let passNumber   = 0;
      let prevDone     = -1;    // sentinel: tracks progress between passes
      const MAX_PASSES = 20;    // safety ceiling — no infinite loop ever

      while (passNumber < MAX_PASSES) {
        passNumber++;

        // Re-read context to get LAST_FILE_ANALYZED for resume prompt
        taskCtx = await TaskContextManager.getContext(sessionId);
        const lastAnalyzed = taskCtx.LAST_FILE_ANALYZED as string | undefined;

        // Check current done count BEFORE running
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

        await AgentExecutor.execute(
          provider,
          FILE_ANALYSIS_SYSTEM_PROMPT + customSuffix,
          buildAnalysisUserPrompt(legacyPath, lastAnalyzed, turnCap, batchSize),
          analysisTools,
          context,
          undefined,   // maxIterations — agent stops naturally; undefined uses the default
          resolvedModel,
          agentId
        );

        await PlannerAgent.cleanupAnalysisKeys(sessionId);

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

        // Stall guard: if this pass made zero progress, agent is stuck — advance to next stage
        if (doneAfter <= prevDone) {
          onLog?.(
            `[PlannerAgent] Stall detected after pass ${passNumber} — no new files analyzed. ` +
            `Advancing with ${doneAfter}/${totalFiles} files done.`,
            'warning'
          );
          onProgress?.(45, `Stalled at ${doneAfter} / ${totalFiles} files`);
          break;
        }

        // Real incremental progress — 5% base + up to 40% for analysis phase
        const analysisPct = 5 + Math.min(Math.round((doneAfter / Math.max(totalFiles, 1)) * 40), 40);
        onProgress?.(analysisPct, `Analyzed ${doneAfter} / ${totalFiles} files`);
        prevDone = doneAfter;
      }

      if (passNumber >= MAX_PASSES) {
        onLog?.(`[PlannerAgent] Max passes (${MAX_PASSES}) reached. Advancing with partial analysis.`, 'warning');
      }

      onLog?.('[PlannerAgent] Stage 2/5: File analysis complete.', 'success');
      await TaskContextManager.updateContext(sessionId, { active_phase: 'graph-resolution' });
      activePhase = 'graph-resolution';
    }


    // ═════════════════════════════════════════════════════════════════════════
    // STAGE 3 — Graph Resolution
    // ONE call. Agent resolves cross-refs, synthesizes architecture, saves counters.
    // Agent self-manages: reads all graphs, resolves references, stops naturally.
    // ═════════════════════════════════════════════════════════════════════════
    if (activePhase === 'graph-resolution') {
      onLog?.('[PlannerAgent] Stage 3/5: Graph Resolution...', 'info');

      await AgentExecutor.execute(
        provider,
        GRAPH_RESOLUTION_SYSTEM_PROMPT + customSuffix,
        buildGraphResolutionUserPrompt(legacyPath),
        graphTools,
        context,
        undefined,       // maxIterations — agent stops naturally; undefined uses the default
        resolvedModel,
        'graph-resolver-agent'
      );

      // ── Validate that G5 counters were saved ─────────────────────────────────
      // If the graph resolver stopped before G5, Section 26 will show zeros.
      // We detect this and emit a clear warning so it's visible in the terminal log.
      const ctxAfterGraph = await TaskContextManager.getContext(sessionId);
      const countersPresent = ctxAfterGraph.TOTAL_CALLABLE_UNITS !== undefined
                           || ctxAfterGraph.TOTAL_DATA_ENTITIES  !== undefined
                           || ctxAfterGraph.TOTAL_API_ENDPOINTS  !== undefined;
      if (!countersPresent) {
        onLog?.(
          '[PlannerAgent] WARNING: Graph resolver did not save counters (TOTAL_CALLABLE_UNITS missing). ' +
          'Section 26 (Risk Scorecard) may show zeros. This happens when the resolver stops before step G5. ' +
          'Check the graph-resolver-agent logs for errors.',
          'warning'
        );
      } else {
        onLog?.(
          `[PlannerAgent] Graph counters: ${ctxAfterGraph.TOTAL_CALLABLE_UNITS ?? 0} functions | ` +
          `${ctxAfterGraph.TOTAL_DATA_ENTITIES ?? 0} entities | ` +
          `${ctxAfterGraph.TOTAL_API_ENDPOINTS ?? 0} endpoints | ` +
          `${ctxAfterGraph.TOTAL_BUSINESS_RULES ?? 0} rules`,
          'info'
        );
      }

      onLog?.('[PlannerAgent] Stage 3/5: Graph resolution complete.', 'success');
      onProgress?.(55, 'Graph Resolution');
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

      // Check which sections already exist on disk (resume support)
      const alreadyWritten = await getWrittenSections(modernPath);

      // Shared counter for real per-section progress (55–90%)
      // JS is single-threaded — counter increments are safe despite parallel awaits
      let sectionsWritten = alreadyWritten.size;
      const totalSections = SECTION_CONFIG.length; // 26

      // Run sections in parallel batches (sections sharing a graph run sequentially)
      const batches = buildParallelSectionGroups(SECTION_CONFIG);

      for (const batch of batches) {
        await Promise.all(
          batch.map(section =>
            PlannerAgent.writeSingleSection(
              section,
              provider,
              SECTION_SYSTEM_PROMPT + customSuffix,
              modernPath,
              sectionTools,
              context,
              resolvedModel,
              alreadyWritten,
              onLog,
              () => {
                sectionsWritten++;
                const pct = 55 + Math.round((sectionsWritten / totalSections) * 35);
                onProgress?.(Math.min(pct, 90), `Section ${sectionsWritten} / ${totalSections}`);
              }
            )
          )
        );
      }

      await TaskContextManager.updateContext(sessionId, { active_phase: 'assembly' });
      activePhase = 'assembly';
    }

    // ═════════════════════════════════════════════════════════════════════════
    // STAGE 5 — Assembly (TypeScript only — no LLM)
    // Reads all 26 section files. Adds table of contents. Writes Stage1_Analysis.md.
    // ═════════════════════════════════════════════════════════════════════════
    if (activePhase === 'assembly') {
      onLog?.('[PlannerAgent] Stage 5/5: Assembling Stage1_Analysis.md...', 'info');

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
    section:        SectionConfig,
    provider:       StreamingProvider,
    systemPrompt:   string,
    modernPath:     string,
    tools:          ReturnType<typeof toolRegistry.getFunctions>,
    context:        ToolContext,
    resolvedModel:  string,
    alreadyWritten: Set<number>,
    onLog?:         (msg: string, lvl?: 'info' | 'success' | 'error' | 'warning') => void,
    onSectionDone?: () => void
  ): Promise<void> {
    const nn          = String(section.n).padStart(2, '0');
    const sectionFile = path.join(modernPath, '_analysis', 'sections', `section-${nn}.md`);

    if (alreadyWritten.has(section.n)) {
      onLog?.(`[PlannerAgent] Section ${section.n} already on disk — skipping.`, 'info');
      // Already counted in sectionsWritten initial value — do NOT call onSectionDone again
      return;
    }

    onLog?.(`[PlannerAgent] Writing section ${section.n}: ${section.name}...`, 'info');
    const userPrompt = buildSectionUserPrompt(section, modernPath);

    await AgentExecutor.execute(
      provider, systemPrompt, userPrompt, tools, context,
      undefined, resolvedModel, `section-${section.n}`
    );

    // Check file exists AND has meaningful content (> 500 bytes)
    // A section file < 500 bytes means the agent wrote only the header and stopped.
    const MIN_SECTION_BYTES = 500;
    if (await fs.pathExists(sectionFile)) {
      const stat = await fs.stat(sectionFile);
      if (stat.size >= MIN_SECTION_BYTES) {
        onLog?.(`[PlannerAgent] Section ${section.n} written: ${section.name} (${stat.size} bytes)`, 'success');
        onSectionDone?.();
        return;
      }
      // File exists but content is too thin — treat as failed and retry
      onLog?.(
        `[PlannerAgent] Section ${section.n} file is only ${stat.size} bytes (< ${MIN_SECTION_BYTES}). ` +
        `Content too thin — retrying with explicit instruction.`,
        'warning'
      );
    } else {
      onLog?.(`[PlannerAgent] Section ${section.n} file missing — retrying once.`, 'warning');
    }

    // One retry with explicit reminder — covers both missing and thin files
    await AgentExecutor.execute(
      provider,
      systemPrompt,
      userPrompt +
        `\n\nIMPORTANT: The output file was either NOT written or is nearly empty (< ${MIN_SECTION_BYTES} bytes). ` +
        'You MUST write a COMPLETE section with full content. ' +
        'Read the graph/data source again and write ALL entries found. Then call write_file to save.',
      tools, context, undefined, resolvedModel, `section-${section.n}-retry`
    );

    if (await fs.pathExists(sectionFile)) {
      const retryStat = await fs.stat(sectionFile);
      if (retryStat.size >= MIN_SECTION_BYTES) {
        onLog?.(`[PlannerAgent] Section ${section.n} written on retry (${retryStat.size} bytes).`, 'success');
      } else {
        onLog?.(`[PlannerAgent] ERROR: Section ${section.n} still thin (${retryStat.size} bytes) after retry — placeholder inserted.`, 'error');
      }
    } else {
      onLog?.(`[PlannerAgent] ERROR: Section ${section.n} failed after retry — will appear as placeholder.`, 'error');
    }
    // Always mark section as attempted — keeps progress counter accurate
    onSectionDone?.();
  }

  /**
   * Removes all analysis:[file] keys from task context after Stage 2.
   * These keys are 2-10 KB each and are no longer needed once their data
   * has been merged into knowledge graphs (which are stored separately as JSON files).
   * Removing them keeps Stage 3 and Stage 4 agent context windows small.
   */
  private static async cleanupAnalysisKeys(sessionId: string): Promise<void> {
    const ctx         = await TaskContextManager.getContext(sessionId);
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
}

// ── Backward-compat export ────────────────────────────────────────────────────

export { buildAnalysisUserPrompt as buildAnalyzerUserPrompt } from '../prompts/file-analysis-prompt.js';
