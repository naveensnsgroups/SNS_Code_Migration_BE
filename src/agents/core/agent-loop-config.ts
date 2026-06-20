// =============================================================================
//  agent-loop-config.ts — Agent Loop Behaviour Configuration
//
//  Mirrors the provider-family prefix pattern from:
//    compactor/agent-context-compactor.ts → resolveCompactionCharBudget()
//
//  All loop thresholds, error signatures, recovery messages, and state-reset
//  strategies live here. agentExecutor.ts imports and uses them — it contains
//  ZERO hardcoded magic numbers or inline error strings.
//
//  Provider-family detection (same as compactor — no exact model names):
//    'flash-lite' → gemini-lite   (weak model, tighter thresholds)
//    'gemini-*'   → gemini        (standard google family)
//    'claude-*'   → claude        (anthropic — stricter, needs fewer retries)
//    'gpt-*'      → gpt           (openai family)
//    'groq-*'     → groq          (groq family)
//    anything else→ default       (conservative safe fallback)
//
//  Called ONCE at the start of AgentExecutor.execute() — result is reused
//  every turn, exactly like resolveCompactionCharBudget().
// =============================================================================

// ── Config Shape ──────────────────────────────────────────────────────────────

/**
 * All tuneable parameters for one agent execution loop.
 * Resolved per provider family — no values are ever inlined in agentExecutor.
 */
export interface AgentLoopConfig {
  // Safety cap — absolute maximum turns before forced stop.
  maxIterations: number;

  // ── Reasoning Loop Detection ─────────────────────────────────────────────
  // A turn with > reasoningLoopThreshold chars of text AND zero tool calls
  // means the LLM is generating "Wait, I need to execute step..." text
  // instead of acting. Flash-lite loops faster → lower threshold.
  reasoningLoopThreshold: number;  // chars
  reasoningLoopSnippet:   number;  // chars to keep from looping text (for context)

  // ── Stuck Tool Detection ─────────────────────────────────────────────────
  // Inspect the last stuckToolWindow tool_result messages. If every one of
  // them has the same tool name AND is_error:true → inject recovery.
  stuckToolWindow:    number;  // rolling window size
  stuckToolMaxErrors: number;  // consecutive same-tool errors before intervention

  // ── Duplicate Call Fingerprinting ────────────────────────────────────────
  // Track (tool_name + args_json) fingerprints in a sliding window.
  // If the same fingerprint appears fingerprintMaxDupes times → block the
  // call and return a structured error so the LLM can self-correct.
  fingerprintWindow:   number;  // max fingerprints to keep in the sliding window
  fingerprintMaxDupes: number;  // allowed repeats before blocking

  // ── No-Progress Detection ────────────────────────────────────────────────
  // Count consecutive turns where ALL tool calls returned is_error:true.
  // Zero net state change for noProgressMaxTurns turns → emergency recovery.
  noProgressMaxTurns: number;
}

// ── Per-Provider-Family Configs ───────────────────────────────────────────────
//
// Same pattern as PROVIDER_CHAR_BUDGET in agent-context-compactor.ts.
// Keys are provider FAMILIES, not exact model names. Any model the user
// configures maps automatically by prefix matching in resolveLoopConfig().

const FAMILY_LOOP_CONFIGS: Record<string, AgentLoopConfig> = {

  // gemini-*-flash-lite — weakest free-tier model. Loops faster and
  // generates reasoning text much more aggressively → tighter thresholds.
  'gemini-lite': {
    maxIterations:          10_000,
    reasoningLoopThreshold:  5_000, // 5K chars (vs 10K for stronger models)
    reasoningLoopSnippet:    1_000,
    stuckToolWindow:             3,
    stuckToolMaxErrors:          3,
    fingerprintWindow:           6,
    fingerprintMaxDupes:         2,
    noProgressMaxTurns:          3,
  },

  // gemini-2.x-flash, gemini-2.x-pro — standard Google family.
  'gemini': {
    maxIterations:          10_000,
    reasoningLoopThreshold: 10_000,
    reasoningLoopSnippet:    1_500,
    stuckToolWindow:             3,
    stuckToolMaxErrors:          3,
    fingerprintWindow:           6,
    fingerprintMaxDupes:         2,
    noProgressMaxTurns:          3,
  },

  // claude-3-*, claude-3.5-* — Anthropic. Claude almost never generates
  // planning loops but is strict about repeated tool use → tighter dupe limit.
  'claude': {
    maxIterations:          10_000,
    reasoningLoopThreshold: 15_000, // Claude rarely loops — higher threshold
    reasoningLoopSnippet:    2_000,
    stuckToolWindow:             3,
    stuckToolMaxErrors:          2, // 2 errors enough for Claude (more decisive)
    fingerprintWindow:           4,
    fingerprintMaxDupes:         1, // Claude almost never needs duplicate calls
    noProgressMaxTurns:          2,
  },

  // gpt-4o, gpt-4-turbo, gpt-3.5-* — OpenAI family.
  'gpt': {
    maxIterations:          10_000,
    reasoningLoopThreshold: 10_000,
    reasoningLoopSnippet:    1_500,
    stuckToolWindow:             3,
    stuckToolMaxErrors:          3,
    fingerprintWindow:           6,
    fingerprintMaxDupes:         2,
    noProgressMaxTurns:          3,
  },

  // groq-* — Groq-hosted models (usually Llama variants).
  'groq': {
    maxIterations:          10_000,
    reasoningLoopThreshold:  8_000, // Llama models loop moderately
    reasoningLoopSnippet:    1_500,
    stuckToolWindow:             3,
    stuckToolMaxErrors:          3,
    fingerprintWindow:           6,
    fingerprintMaxDupes:         2,
    noProgressMaxTurns:          3,
  },

  // mistral-* / codestral-* — Mistral AI models.
  // Mistral is code-aware (especially codestral) and loops moderately.
  // Similar profile to groq but slightly higher reasoning threshold.
  'mistral': {
    maxIterations:          10_000,
    reasoningLoopThreshold:  9_000,
    reasoningLoopSnippet:    1_500,
    stuckToolWindow:             3,
    stuckToolMaxErrors:          3,
    fingerprintWindow:           6,
    fingerprintMaxDupes:         2,
    noProgressMaxTurns:          3,
  },

  // Any unknown model — conservative safe fallback.
  'default': {
    maxIterations:          10_000,
    reasoningLoopThreshold: 10_000,
    reasoningLoopSnippet:    1_500,
    stuckToolWindow:             3,
    stuckToolMaxErrors:          3,
    fingerprintWindow:           6,
    fingerprintMaxDupes:         2,
    noProgressMaxTurns:          3,
  },
};

/**
 * Resolves the agent loop config for a given model name.
 *
 * Detection order (more specific prefix wins):
 *   1. Includes 'flash-lite'              → gemini-lite  (weakest, tightest)
 *   2. Starts with 'gemini-' / 'gemini'   → gemini
 *   3. Starts with 'claude-' / 'claude'   → claude
 *   4. Starts with 'gpt-' / 'gpt'         → gpt
 *   5. Starts with 'groq-' / 'groq'       → groq
 *   6. Anything else                       → default (conservative)
 *
 * Called ONCE at the start of AgentExecutor.execute(). Result is stored in
 * `loopConfig` and reused every turn — same pattern as resolveCompactionCharBudget().
 */
export function resolveLoopConfig(modelName: string): AgentLoopConfig {
  const m = (modelName ?? '').toLowerCase().trim();
  if (m.includes('flash-lite'))                        return FAMILY_LOOP_CONFIGS['gemini-lite'];
  if (m.startsWith('gemini-') || m.includes('gemini')) return FAMILY_LOOP_CONFIGS['gemini'];
  if (m.startsWith('claude-') || m.includes('claude')) return FAMILY_LOOP_CONFIGS['claude'];
  if (m.startsWith('gpt-')    || m.includes('gpt'))    return FAMILY_LOOP_CONFIGS['gpt'];
  if (m.startsWith('groq-')   || m.includes('groq'))   return FAMILY_LOOP_CONFIGS['groq'];
  if (m.includes('mistral')   || m.includes('codestral') || m.includes('ministral') || m.includes('devstral')) return FAMILY_LOOP_CONFIGS['mistral'];
  return FAMILY_LOOP_CONFIGS['default'];
}

// ── Error Type Taxonomy ───────────────────────────────────────────────────────
//
// Every error the agent loop can encounter is classified into one of these
// types. The classifier reads the tool error TEXT (produced by our tools) and
// returns the type. Recovery messages and state-reset strategies are keyed
// on this type — no inline strings in agentExecutor.ts.

export type AgentLoopErrorType =
  | 'empty-data'        // append-to-knowledge-graph called with data:{}
  | 'duplicate-blocked' // same (tool + args) blocked by fingerprint window
  | 'config-error'      // modernPath null / session not initialized
  | 'tool-not-found'    // tool name not registered in tool registry
  | 'stuck-tool'        // same tool failed stuckToolMaxErrors times in a row
  | 'reasoning-loop'    // turn > reasoningLoopThreshold chars, zero tool calls
  | 'no-progress'       // all tools failed for noProgressMaxTurns turns
  | 'rate-limit'        // 429 / quota exceeded (handled upstream by retry)
  | 'unknown';          // catch-all

// ── Error Signatures ─────────────────────────────────────────────────────────
//
// Substring patterns that identify each error type from the tool error TEXT.
// Ordered most-specific first (first match wins).
// These strings MUST match the error messages written in our tool implementations.
// Adding a new tool error? Add its signature here — agentExecutor.ts unchanged.

const ERROR_SIGNATURES: ReadonlyArray<[string, AgentLoopErrorType]> = [
  ['EMPTY DATA REJECTED',  'empty-data'],
  ['DUPLICATE CALL BLOCKED','duplicate-blocked'],
  ['modernPath not set',   'config-error'],
  ['not initialized',      'config-error'],
  ['Path must be a string','config-error'],
  ['not registered',       'tool-not-found'],
  ['unknown tool',         'tool-not-found'],
  ['rate limit',           'rate-limit'],
  ['429',                  'rate-limit'],
  ['quota exceeded',       'rate-limit'],
  ['resource exhausted',   'rate-limit'],
  ['too many requests',    'rate-limit'],
];

/**
 * Classifies a tool error message into a typed AgentLoopErrorType.
 * Reads the error TEXT produced by tool implementations (not hardcoded in executor).
 *
 * @param errorText  The string content of the tool_result message (is_error:true)
 * @returns          The matched AgentLoopErrorType, or 'unknown' if no match
 */
export function classifyToolError(errorText: string): AgentLoopErrorType {
  const lower = (errorText ?? '').toLowerCase();
  for (const [signature, type] of ERROR_SIGNATURES) {
    if (lower.includes(signature.toLowerCase())) return type;
  }
  return 'unknown';
}

// ── In-Memory Loop State ──────────────────────────────────────────────────────
//
// Mutable state that lives for the duration of one AgentExecutor.execute() call.
// This is NOT persisted to disk — disk state (FILE_INDEX, LAST_FILE_ANALYZED)
// is managed entirely by edit_task_context and get_task_context.

export interface LoopState {
  /** Sliding window of (tool_name + '::' + args_json) fingerprints. */
  toolCallFingerprints: string[];
  /** Consecutive turns where ALL tool calls returned is_error:true. */
  noProgressTurns: number;
}

/** Creates a fresh LoopState. Call at the start of AgentExecutor.execute(). */
export function createLoopState(): LoopState {
  return {
    toolCallFingerprints: [],
    noProgressTurns: 0,
  };
}

/**
 * Resets the correct parts of LoopState for a given error type.
 *
 * Rule: reset ONLY what is necessary for recovery. Never reset more than needed.
 *   STUCK_TOOL    → clear all (new file context is starting)
 *   REASONING_LOOP→ reset noProgress only (no tools called, fingerprints unchanged)
 *   NO_PROGRESS   → full reset (agent is restarting from checkpoint)
 *   DUPLICATE     → do NOT reset (fingerprints are correctly blocking — that's working)
 *   CONFIG_ERROR  → full reset (non-recoverable — clear state for clean exit)
 *   others        → no reset (preserve state for debugging)
 */
export function resetStateForErrorType(state: LoopState, errorType: AgentLoopErrorType): void {
  switch (errorType) {
    case 'stuck-tool':
      state.toolCallFingerprints = [];
      state.noProgressTurns      = 0;
      break;
    case 'reasoning-loop':
      // Fingerprints unchanged — reasoning loops don't call tools.
      state.noProgressTurns = 0;
      break;
    case 'no-progress':
      state.toolCallFingerprints = [];
      state.noProgressTurns      = 0;
      break;
    case 'config-error':
      state.toolCallFingerprints = [];
      state.noProgressTurns      = 0;
      break;
    case 'duplicate-blocked':
      // Do NOT reset fingerprints — they are working correctly by blocking.
      // noProgressTurns also unchanged: a blocked duplicate is not a "failure turn".
      break;
    default:
      // Unknown errors: preserve all state for post-mortem logging.
      break;
  }
}

// ── Recovery Messages ─────────────────────────────────────────────────────────
//
// Every error type has EXACTLY ONE recovery message. The message is assembled
// here from the config (so thresholds in the message match the actual config).
// agentExecutor.ts never constructs recovery strings — it only calls this function.

/**
 * Builds the orchestrator intervention message for a given error type.
 * The message is injected as a user TextMessage into the LLM message chain.
 *
 * @param errorType  Classified error type
 * @param toolName   Name of the failing / duplicate tool (if applicable)
 * @param config     Resolved AgentLoopConfig for this session's model
 * @param extra      Optional extra data (e.g. turnChars for REASONING_LOOP)
 */
export function buildRecoveryMessage(
  errorType: AgentLoopErrorType,
  toolName:  string,
  config:    AgentLoopConfig,
  extra?:    { turnChars?: number }
): string {
  switch (errorType) {

    case 'stuck-tool':
      return (
        `[ORCHESTRATOR INTERVENTION] Tool "${toolName}" returned an error ` +
        `${config.stuckToolMaxErrors} consecutive times. You are stuck. ` +
        `STOP calling "${toolName}" for the current file. ` +
        `Mark the current file DONE: set read_status="DONE" inside the FILE_INDEX array ` +
        `and re-save via edit_task_context. Then move to the next PENDING file.`
      );

    case 'reasoning-loop':
      return (
        `[ORCHESTRATOR INTERVENTION] You generated ` +
        `${Math.round((extra?.turnChars ?? 0) / 1_000)}K characters of planning text ` +
        `("Wait, I need to execute step...") but called NO tools. ` +
        `You are stuck in a reasoning loop. STOP WRITING PLANNING TEXT. ` +
        `NOW call the tools: ` +
        `(1) append-to-knowledge-graph for files with real extracted data. ` +
        `(2) edit_task_context to mark each file DONE (read_status="DONE" in file-index array). ` +
        `Do not write "Wait, I need to..." text. Just call the tools.`
      );

    case 'no-progress':
      return (
        `[ORCHESTRATOR INTERVENTION] ${config.noProgressMaxTurns} consecutive turns had ALL ` +
        `tools return errors. Zero state change. EMERGENCY RECOVERY: ` +
        `(1) Call get_task_context() with NO key parameter — get FILE_INDEX_KEY value and LAST_FILE_ANALYZED. ` +
        `(2) Call get_task_context({ key: "file-index" }) — load the actual file list. ` +
        `(3) Find the FIRST file where read_status="PENDING". ` +
        `(4) Mark it DONE: update read_status="DONE" inside FILE_INDEX array and call edit_task_context. ` +
        `(5) Move to the next PENDING file. Skip files that keep erroring.`
      );

    case 'duplicate-blocked':
      return (
        `[ORCHESTRATOR INTERVENTION] "${toolName}" was called with identical arguments ` +
        `${config.fingerprintMaxDupes} times. This action already completed. ` +
        `Do NOT repeat it. Move to the NEXT required action ` +
        `(next graph type or next file in FILE_INDEX).`
      );

    case 'config-error':
      return (
        `[ORCHESTRATOR INTERVENTION] A configuration error occurred in "${toolName}". ` +
        `The session context is missing required properties (e.g. modernPath is null). ` +
        `This is not recoverable by retrying the same tool call. ` +
        `Stop tool execution and report the error.`
      );

    case 'tool-not-found':
      return (
        `[ORCHESTRATOR INTERVENTION] Tool "${toolName}" is not registered. ` +
        `Only call tools from the tools list provided at the start of this session. ` +
        `Check the available tool names and use the correct one.`
      );

    default:
      return (
        `[ORCHESTRATOR INTERVENTION] An unexpected error occurred in "${toolName}". ` +
        `Read the tool result error message above and decide the correct recovery action. ` +
        `If you cannot recover, mark the current file DONE and move to the next PENDING file.`
      );
  }
}
