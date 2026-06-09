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
// Constructs the user-facing task prompt for the FileAnalyzer sub-agent.
//
// KEY RULES:
//  - NO target stack mentioned — pure legacy analysis only
//  - NO "migrate to X" language
//  - Passes detectedStack as approximate context (LLM must verify by reading files)

function buildAnalyzerUserPrompt(legacyPath: string, detectedStack: DetectedStack): string {
  return `Please perform a complete static analysis of the legacy project located at "${legacyPath}".

Your task is to fully understand and document this codebase as it currently exists.
Do NOT suggest any changes or target technologies. Do NOT mention a migration target.

Initial heuristic scan detected:
  - Language:         ${detectedStack.language}
  - Framework:        ${detectedStack.framework}
  - Database:         ${detectedStack.database}
  - Package Manager:  ${detectedStack.packageManager}
  - File Count:       ${detectedStack.fileCount}

These detections may be approximate — verify them by reading the actual manifest files.

Follow your system prompt workflow exactly:
  1. Load task context to check for any prior progress (LAST_FILE_ANALYZED, file-index).
  2. Call getEnvironmentInfo to detect runtime versions and system environment.
  3. Call getGitLog to identify high-churn files (migration risks) and dead code candidates.
  4. Call getWorkspaceDirectoryStructure to understand the project layout.
  5. Run Language Profile Detection: find all manifest files via findFilesByPattern.
  6. Call scanAssetFiles for mandatory asset inventory.
  7. Build the MANDATORY_FILE_INDEX of all source files and save it via edit_task_context.
  8. For EACH file in the index:
     a. Call extractFileSymbols to determine reading strategy (SMALL / MEDIUM / LARGE / ULTRA_LARGE).
     b. Read the file according to the determined strategy.
     c. Call todoWrite to mark it completed in the audit trail.
     d. Every 10 files: call update-migration-dashboard with current progress %.
  9. Build BUSINESS_RULES_BY_FILE per-file map and save via edit_task_context.
  10. Build DEPENDENCY_MAP via getDependencyTree.
  11. Write the comprehensive "${PHASE1_OUTPUT_FILE}" report via write_file.`;
}
