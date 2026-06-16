// =============================================================================
//  compactor/agent-context-compactor.ts
//
//  Context compaction logic for the AgentExecutor streaming tool loop.
//
//  Responsibility: detect when the LLM message history is approaching the
//  provider's context window limit and trim old tool-call/result pairs.
//
//  WHY a separate file:
//    agentExecutor.ts = streaming loop only (single responsibility)
//    agent-context-compactor.ts = compaction logic only (single responsibility)
//
//  Called from agentExecutor.ts — one import, one call per turn:
//    import { resolveCompactionCharBudget, compactMessagesIfNeeded }
//      from './compactor/agent-context-compactor.js';
// =============================================================================

import { LanguageModelMessage } from '../../types/language-model.js';

// ── Provider-Family Context Limits ────────────────────────────────────────────
//
// Detected by PROVIDER FAMILY from the model string prefix — not by exact model
// names. This means ANY model the user configures (current or future) gets the
// right budget automatically.
//
// Detection order:
//   1. Starts with 'gemini-' / includes 'gemini' → Google family → 1M tokens
//   2. Starts with 'claude-' / includes 'claude' → Anthropic family → 200K tokens
//   3. Starts with 'gpt-'    / includes 'gpt'    → OpenAI family → 128K tokens
//   4. Starts with 'groq-'   / includes 'groq'   → Groq family → 128K tokens
//   5. Any other string                           → conservative 128K default
//
// Budget ratio = 60%: compact when 60% of context is used.
// Leaves 40% headroom for the next LLM turn + tool results.
//
// KEEP_RECENT_CHARS: always keep the last 40K chars (≈ 10K tokens) of the
// most recent tool-call/result history so the agent has full context of
// its most recent work.

const COMPACTION_BUDGET_RATIO = 0.60;   // compact when 60% of context is used
const KEEP_RECENT_CHARS       = 40_000; // chars of recent tool history to always keep

// Chars per provider family  (tokens × 4 chars/token × budget ratio)
const PROVIDER_CHAR_BUDGET: Record<string, number> = {
  gemini:  1_000_000 * 4 * COMPACTION_BUDGET_RATIO, // 2,400,000 chars
  claude:    200_000 * 4 * COMPACTION_BUDGET_RATIO, //   480,000 chars
  gpt:       128_000 * 4 * COMPACTION_BUDGET_RATIO, //   307,200 chars
  groq:      128_000 * 4 * COMPACTION_BUDGET_RATIO, //   307,200 chars
  default:   128_000 * 4 * COMPACTION_BUDGET_RATIO, //   307,200 chars (conservative)
};

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Resolves the char compaction budget for a given model name.
 * Detects provider family from the model identifier prefix (gemini-*, claude-*, etc.).
 * No hardcoded model names — works for any model the user configures.
 *
 * Called ONCE at the start of AgentExecutor.execute() — result is reused every turn.
 *
 * @param modelName  e.g. "gemini-2.5-flash", "claude-3-haiku", "gpt-4o", ""
 * @returns          char budget threshold for this provider family
 */
export function resolveCompactionCharBudget(modelName: string): number {
  const m = (modelName ?? '').toLowerCase().trim();
  if (m.startsWith('gemini-') || m.includes('gemini')) return PROVIDER_CHAR_BUDGET.gemini;
  if (m.startsWith('claude-') || m.includes('claude')) return PROVIDER_CHAR_BUDGET.claude;
  if (m.startsWith('gpt-')    || m.includes('gpt'))    return PROVIDER_CHAR_BUDGET.gpt;
  if (m.startsWith('groq-')   || m.includes('groq'))   return PROVIDER_CHAR_BUDGET.groq;
  return PROVIDER_CHAR_BUDGET.default;
}

/**
 * Estimates the total character count across all messages in the chain.
 * Uses actual .text / .content / .input fields — no API calls needed.
 * Called every turn to check if compaction is needed.
 *
 * @param msgs  Current LanguageModelMessage[] chain
 * @returns     Total estimated chars across all messages
 */
export function estimateContextChars(msgs: LanguageModelMessage[]): number {
  return msgs.reduce((sum, m) => {
    if ('text' in m    && m.text)    return sum + (m.text as string).length;
    if ('content' in m && m.content) return sum + JSON.stringify(m.content).length;
    if ('input' in m   && m.input)   return sum + JSON.stringify(m.input).length;
    return sum + 64; // minimum estimate for unknown message types
  }, 0);
}

/**
 * Compacts the message chain IN PLACE if the estimated char count exceeds the budget.
 *
 * Strategy:
 *   - Always keep: messages[0] (system) + messages[1] (initial user prompt)
 *   - Walk backwards from the end, collecting the most recent messages
 *     until KEEP_RECENT_CHARS is reached
 *   - Drop everything in between (stale tool call/result history)
 *
 * The dropped messages are already persisted to disk (graph JSON files) —
 * no data is lost. Only the in-memory message history is trimmed.
 *
 * @param messages   The live message chain (mutated in place)
 * @param budget     Char budget from resolveCompactionCharBudget()
 * @param iteration  Current turn number (for log message)
 * @param onLog      Optional logger from ToolContext
 * @returns          true if compaction was performed, false if not needed
 */
export function compactMessagesIfNeeded(
  messages:  LanguageModelMessage[],
  budget:    number,
  iteration: number,
  onLog?:    (msg: string, lvl?: 'info' | 'success' | 'error' | 'warning') => void
): boolean {
  const currentChars = estimateContextChars(messages);

  // Only compact if over budget AND there are messages beyond system + user prompt
  if (currentChars <= budget || messages.length <= 2) return false;

  const head = messages.slice(0, 2); // always keep: system + initial user prompt
  const tail: LanguageModelMessage[] = [];
  let   tailChars = 0;

  // Walk backwards: collect most recent messages until KEEP_RECENT_CHARS is reached
  for (let i = messages.length - 1; i >= 2; i--) {
    const m = messages[i];
    const c = 'text' in m    && m.text    ? (m.text as string).length
            : 'content' in m && m.content ? JSON.stringify(m.content).length
            : 'input' in m   && m.input   ? JSON.stringify(m.input).length
            : 64;
    if (tailChars + c > KEEP_RECENT_CHARS) break;
    tail.unshift(m);
    tailChars += c;
  }

  const before = messages.length;
  messages.splice(0, messages.length, ...head, ...tail);

  onLog?.(
    `[ContextCompactor] Turn ${iteration}: ` +
    `${Math.round(currentChars / 1000)}K chars > ${Math.round(budget / 1000)}K budget. ` +
    `Compacted ${before} → ${messages.length} messages ` +
    `(kept last ${Math.round(tailChars / 1000)}K chars of history).`,
    'info'
  );

  return true;
}
