// =============================================================================
//  planner-agent.ts — Stage 1: Codebase Analysis Agent (Phase 1 ONLY)
//
//  Mirrors: snside FileAnalyzer sub-agent pattern
//
//  Goal: Fully understand and document the legacy codebase.
//  Output: Stage1_Analysis.md written to modernPath.
//
//  Phase 2 (migration-plan.md) is a SEPARATE agent — not implemented here.
//  This agent focuses exclusively on READING and UNDERSTANDING the legacy code.
//
//  Rules:
//   - NO target stack context is passed to the LLM
//   - NO "migrate to X" language in any prompt
//   - Pure analysis only — write ONE output: Stage1_Analysis.md
//   - Provider, model, API key resolved from session config (no hardcoding)
//   - System prompt from prompts/analyzer-prompt.ts
//   - Tool IDs from common/workspace-functions.ts via TOOLS_REGISTRY constants
// =============================================================================

import { DetectedStack, TargetStack } from '../types.js';
import { toolRegistry } from '../core/tool-invocation-registry.js';
import { ToolContext } from '../types/tool.js';
import { AgentExecutor } from './agentExecutor.js';
import { TaskContextManager } from '../session/taskContext.js';
import { SessionManager } from '../session/sessionManager.js';
import { AIProviderFactory } from '../ai/provider.js';
import { StreamingProvider } from '../types/language-model.js';
import { ANALYZER_SYSTEM_PROMPT } from '../prompts/analyzer-prompt.js';
import { STAGE1_PLANNER_AGENT } from './agent-definitions.js';
import fs from 'fs-extra';
import path from 'path';

// ── Agent Configuration Constants ─────────────────────────────────────────────
// These are named constants — never hardcoded inline in method calls.

/** Maximum LLM turns for deep codebase analysis (large codebases need more turns). */
const PHASE1_MAX_TURNS = 60;

/** Output file name — defined once, referenced everywhere. */
const PHASE1_OUTPUT_FILE = 'Stage1_Analysis.md';

/** Alias key to resolve the reasoning model from session.aliasesConfig. */
const REASONING_MODEL_ALIAS = 'reasoning-model';

/** Custom prompt fragment ID for injecting user-defined system rules. */
const CUSTOM_RULES_FRAGMENT_ID = 'system-agent-rules';

// NOTE: toToolRequest() removed — all tools are now ToolRequest from the toolRegistry.
// Use toolRegistry.getFunctions(...STAGE1_PLANNER_AGENT.functions) to get agent tools.

// ── PlannerAgent ──────────────────────────────────────────────────────────────

export class PlannerAgent {
  /**
   * Runs Stage 1, Phase 1: Codebase Discovery and Analysis.
   *
   * What this agent does:
   *  1. Loads provider + model from session config (no hardcoding)
   *  2. Builds tool list from STAGE1_PLANNER_AGENT.functions
   *  3. Filters tools based on UI toolsConfig toggle state
   *  4. Runs AgentExecutor with ANALYZER_SYSTEM_PROMPT
   *  5. Verifies Stage1_Analysis.md was written; writes fallback if not
   *
   * What this agent does NOT do:
   *  - Does NOT write migration-plan.md (that is Phase 2 — a separate agent)
   *  - Does NOT mention the target stack to the LLM
   *  - Does NOT hardcode any model names, API keys, or prompt strings
   *
   * @param sessionId      Current migration session ID
   * @param legacyPath     Absolute path to the legacy project (read-only)
   * @param modernPath     Absolute path to the output folder (writes go here)
   * @param detectedStack  Stack detected by ScannerAgent — passed as context only
   * @param targetStack    User's chosen target (used only for model resolution)
   * @param _aiServiceLegacy  Kept for backward compat — provider resolved from session
   * @param onLog          Log callback → SSE terminal stream
   */
  static async run(
    sessionId: string,
    legacyPath: string,
    modernPath: string,
    detectedStack: DetectedStack,
    targetStack: TargetStack,
    /** @deprecated Provider is now resolved from session.apiKeys + session.aliasesConfig. */
    _aiServiceLegacy: unknown,
    onLog?: (message: string, level?: 'info' | 'success' | 'error' | 'warning') => void
  ): Promise<string> {
    onLog?.('🚀 Initializing Stage 1: Codebase Analysis Agent...', 'info');

    // ── Load session config (no hardcoded values below this line) ─────────
    const session = await SessionManager.getSession(sessionId);
    const toolsConfig:   Record<string, boolean> = (session as any)?.toolsConfig   ?? {};
    const promptFragments: Record<string, string> = (session as any)?.promptFragments ?? {};
    const aliasesConfig: Record<string, string>  = (session as any)?.aliasesConfig  ?? {};

    // Resolve model: aliasesConfig['reasoning-model'] → targetStack.model → fallback from agent def
    const modelName = targetStack.model;
    const resolvedModel =
      aliasesConfig[REASONING_MODEL_ALIAS] ??
      modelName ??
      STAGE1_PLANNER_AGENT.languageModelRequirements[0]?.identifier?.replace('alias:', '') ??
      '';

    // Resolve API key for the chosen provider
    const providerName = targetStack.provider.toLowerCase();
    let apiKey = (session as any)?.apiKey ?? '';
    if ((session as any)?.apiKeys) {
      if (providerName === 'anthropic' && (session as any).apiKeys.anthropic) apiKey = (session as any).apiKeys.anthropic;
      else if (providerName === 'openai' && (session as any).apiKeys.openai) apiKey = (session as any).apiKeys.openai;
      else if (providerName === 'google' && (session as any).apiKeys.google) apiKey = (session as any).apiKeys.google;
      else if (providerName === 'grok' && (session as any).apiKeys.grok) apiKey = (session as any).apiKeys.grok;
      else if (providerName === 'groq' && (session as any).apiKeys.groq) apiKey = (session as any).apiKeys.groq;
      else if (providerName === 'openrouter' && (session as any).apiKeys.openrouter) apiKey = (session as any).apiKeys.openrouter;
      else if (providerName === 'huggingface' && (session as any).apiKeys.huggingface) apiKey = (session as any).apiKeys.huggingface;
    }

    if (!apiKey) {
      if (providerName === 'anthropic') apiKey = process.env.ANTHROPIC_API_KEY || '';
      else if (providerName === 'openai') apiKey = process.env.OPENAI_API_KEY || '';
      else if (providerName === 'google') apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
      else if (providerName === 'grok') apiKey = process.env.XAI_API_KEY || '';
      else if (providerName === 'groq') apiKey = process.env.GROQ_API_KEY || '';
      else if (providerName === 'openrouter') apiKey = process.env.OPENROUTER_API_KEY || '';
      else if (providerName === 'huggingface') apiKey = process.env.HF_API_KEY || process.env.HF_TOKEN || '';
    }

    const providerConfig = {
      maxRetries: (session as any)?.googleMaxRetries,
      retryDelayRateLimit: (session as any)?.googleRetryDelayRateLimit,
      retryDelayOther: (session as any)?.googleRetryDelayOther,
    };

    // Build the streaming provider via factory
    const provider: StreamingProvider = AIProviderFactory.getStreamingProvider(
      targetStack.provider,
      resolvedModel,
      apiKey,
      providerConfig
    );

    // ── Tool context ───────────────────────────────────────────────────────
    const context: ToolContext = {
      sessionId,
      legacyPath,
      modernPath,
      onLog: (msg, lvl) => onLog?.(msg, lvl),
    };

    // ── Build ToolRequest[] from STAGE1_PLANNER_AGENT.functions ─────────────
    // Uses the agent definition's declared function list — no inline tool names.
    // Applies toolsConfig toggle filter from the AI Config panel.
    // toolRegistry.getFunctions() returns ToolRequest[] — SNS IDE standard.
    const allPhase1Tools = toolRegistry
      .getFunctions(...STAGE1_PLANNER_AGENT.functions)
      .filter(t => toolsConfig[t.name] !== false);

    // ── Resume support: load active phase from task context ───────────────
    const taskContext = await TaskContextManager.getContext(sessionId);
    const activePhase = taskContext.active_phase || '1';

    if (activePhase !== '1') {
      onLog?.(`ℹ Task context shows phase '${activePhase}' — analysis already completed. Skipping.`, 'info');
      return `Stage 1 Phase 1 already completed (phase: ${activePhase}).`;
    }

    // ── Phase 1: Codebase Discovery and Analysis ───────────────────────────
    onLog?.(' Phase 1: Starting Codebase Discovery & Analysis...', 'info');

    // System prompt: base from prompts file + optional custom rules fragment
    const customRules = promptFragments[CUSTOM_RULES_FRAGMENT_ID];
    const systemPrompt = customRules
      ? `${ANALYZER_SYSTEM_PROMPT}\n\n<custom_rules>\n${customRules}\n</custom_rules>`
      : ANALYZER_SYSTEM_PROMPT;

    // User prompt: built dynamically from detectedStack — no target stack mentioned
    const userPrompt = buildAnalyzerUserPrompt(legacyPath, detectedStack);

    const resultText = await AgentExecutor.execute(
      provider,
      systemPrompt,
      userPrompt,
      allPhase1Tools,
      context,
      PHASE1_MAX_TURNS,
      resolvedModel,
      'planner-agent'
    );

    // ── Verify output was written ──────────────────────────────────────────
    const outputFilePath = path.join(modernPath, PHASE1_OUTPUT_FILE);
    if (!(await fs.pathExists(outputFilePath))) {
      onLog?.(`⚠️ ${PHASE1_OUTPUT_FILE} was not written by the agent. Writing fallback...`, 'warning');
      await fs.ensureDir(path.dirname(outputFilePath));
      await fs.writeFile(
        outputFilePath,
        resultText || `# Stage 1 Analysis\n\nAgent did not produce structured output.`,
        'utf-8'
      );
    }

    // ── Mark phase complete in task context ───────────────────────────────
    await TaskContextManager.updateContext(sessionId, { active_phase: 'phase1-complete' });
    onLog?.(`✅ Phase 1 analysis complete. ${PHASE1_OUTPUT_FILE} written to output workspace.`, 'success');

    return resultText;
  }
}

// ── User Prompt Builder ───────────────────────────────────────────────────────
// Builds the user task prompt for @FileAnalyzer sub-agent.
//
// Rules:
//  - NO target stack mentioned. Pure legacy documentation only.
//  - Discovery-first: workspace tools reveal what exists. No assumptions.
//  - Language-agnostic: adapts to whatever language is found.

function buildAnalyzerUserPrompt(legacyPath: string, detectedStack: DetectedStack): string {
  return `Perform a complete static analysis of the legacy project at: "${legacyPath}"

GOAL: Produce "${PHASE1_OUTPUT_FILE}" covering all 26 required sections.
Do NOT suggest improvements, target technologies, or migration strategies.
This is pure documentation of the legacy codebase exactly as it exists.

Initial heuristic scan (treat as approximate — verify everything by reading manifests):
  Language:        ${detectedStack.language}
  Framework:       ${detectedStack.framework}
  Database:        ${detectedStack.database}
  Package Manager: ${detectedStack.packageManager}
  File Count:      ${detectedStack.fileCount}

Follow your system prompt workflow in order:

STEP 1 — Resume check:
  Call get_task_context. If resuming, start from LAST_FILE_ANALYZED.

STEP 2 — Discover the workspace:
  Call getWorkspaceDirectoryStructure (monorepo check).
  Call getEnvironmentInfo (runtime versions).
  Call getGitLog (HIGH_CHURN_FILES, DEAD_CODE_CANDIDATES).
  Call findFilesByPattern for ALL manifest types to detect language profiles.
  Call scanAssetFiles for asset inventory.
  Save LANGUAGE_PROFILES under key "lang-profiles".

STEP 3 — Build MANDATORY_FILE_INDEX:
  Index every source file discovered. Type determined by content + location, not extension.
  Save under key "file-index". Save FILE_INDEX_KEY and TOTAL_FILES inline.

STEP 4 — Read and analyze EVERY file:
  Follow the 4-tier reading strategy (SMALL/MEDIUM/LARGE/ULTRA_LARGE) per system prompt rules.
  For each file — extract what it contains, adapted to the detected language:
    callable units, data contracts, entry points, external dependencies,
    business logic, configuration values, error types.
  Save under key "analysis:[escaped_path]". Mark DONE in FILE_INDEX.
  Use batch-read-files for groups of SMALL files. Checkpoint every 10 files.

STEP 5 — Trace cross-module call flows:
  Identify 5–10 critical use-cases. Trace the full execution path for each.
  Save under key "call-flows".

STEP 6 — Phase completion audit:
  Verify DONE_COUNT === TOTAL_FILES before writing the report.
  Go back and read any PENDING files if found.

STEP 7 — Write "${PHASE1_OUTPUT_FILE}" via write_file:
  All 26 sections must be present. Adapt content to what was actually found.
  After each section: save SECTION_[N]_WRITTEN=true.
  Sections: 1.Project Identity, 2.Architecture, 3.Source Structure, 4.File Classification,
  5.Domain Models, 6.Dependencies, 7.Functions, 8.Function Behaviors, 9.Business Rules,
  10.API Contracts, 11.Security, 12.Middleware, 13.Database Operations, 14.Call Flows,
  15.Data Transformations, 16.Configuration, 17.Error Handling, 18.Validation Rules,
  19.State Transitions, 20.Async Processing, 21.Testing, 22.Transactions, 23.Event Flows,
  24.External Integrations, 25.Scheduled Jobs, 26.Risk Scorecard.

STEP 8 — Section completion gate:
  Verify all 26 SECTION_[N]_WRITTEN=true. Write any missing section.
  Save ACTIVE_PHASE=complete, STAGE1_ANALYSIS_WRITTEN=true.`;
}


