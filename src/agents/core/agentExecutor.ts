// =============================================================================
//  agentExecutor.ts — SNS IDE Standard Agent Tool Loop (Streaming)
//
//  Mirrors: snside AbstractModeAwareChatAgent invoke() + sendLlmRequest() pattern
//
//  Key changes from old implementation:
//  1. Messages are LanguageModelMessage[] (typed, not plain {role, content})
//  2. Tool handlers called with (arg_string: string, ctx) — raw JSON string
//  3. tool_use → tool_result message pairs built correctly
//  4. Uses GeminiProvider.request() streaming instead of generateCompletion()
//  5. Streams text chunks via SSE as they arrive (token by token)
//  6. Real token counts from UsageResponsePart (not estimates mid-loop)
//  7. Token usage broadcast on every turn (not just every 5)
// =============================================================================

import {
  LanguageModelMessage,
  TextMessage,
  ToolUseMessage,
  ToolResultMessage,
  LanguageModelStreamPart,
  makeToolErrorResult,
  makeToolTextResult,
  isTextResponsePart,
  isUsageResponsePart,
  isToolCallResponsePart,
  ToolCallResult,
  UserRequest,
  StreamingProvider,
  hasToolError,
} from '../../types/language-model.js';
import { ToolRequest, ToolContext } from '../../types/tool.js';
import { EventBroadcaster } from '../../routes/stream.js';
import { SessionManager } from '../../session/sessionManager.js';
import { TokenUsage } from '../../types.js';
import { TokenUsageEntry } from '../../session/types.js';

// ── Context Compaction (extracted to compactor/agent-context-compactor.ts) ───
import {
  resolveCompactionCharBudget,
  compactMessagesIfNeeded,
} from '../compactor/agent-context-compactor.js';

// ── Agent Loop Configuration (all thresholds, error types, recovery messages) ─
// Mirrors the provider-family prefix pattern from agent-context-compactor.ts.
// Zero hardcoded values in this file — all config lives in agent-loop-config.ts.
import {
  resolveLoopConfig,
  classifyToolError,
  buildRecoveryMessage,
  resetStateForErrorType,
  createLoopState,
  LoopState,
} from './agent-loop-config.js';

// ── Cost Estimation (extracted to compactor/agent-cost-estimator.ts) ────────────
// Re-exported for backward compatibility.
export { COST_TABLE, estimateCost } from '../compactor/agent-cost-estimator.js';



// ── Canonical JSON Normalization ─────────────────────────────────────────────
// LLMs produce non-deterministic JSON key ordering across retries.
// Identical tool calls can arrive as:
//   { "data": {}, "graphName": "api", "sourceFile": "x.js" }  ← key order A
//   { "graphName": "api", "data": {}, "sourceFile": "x.js" }  ← key order B
// Without normalization these produce different fingerprints, bypassing the
// duplicate detection guard. sortKeysDeep recursively sorts all object keys
// before JSON.stringify — producing the same canonical string for both.
function sortKeysDeep(val: unknown): unknown {
  if (Array.isArray(val)) return val.map(sortKeysDeep);
  if (val !== null && typeof val === 'object') {
    const obj = val as Record<string, unknown>;
    return Object.keys(obj)
      .sort()
      .reduce<Record<string, unknown>>((acc, k) => { acc[k] = sortKeysDeep(obj[k]); return acc; }, {});
  }
  return val;
}

/** Produces a canonical, key-order-independent fingerprint for a tool call. */
function normalizeToolArgs(rawArgs: string): string {
  try {
    return JSON.stringify(sortKeysDeep(JSON.parse(rawArgs)));
  } catch {
    return rawArgs; // fallback: unparseable args — use raw string
  }
}

// ── Rate Limit Retry Helper ───────────────────────────────────────────────────

// Wraps provider.request() with exponential backoff for 429 / 503 errors.
// Free-tier models (Gemini 15 RPM, Claude/OpenAI limits) can hit rate limits
// during multi-pass analysis. This retries transparently instead of crashing.

const RATE_LIMIT_PATTERNS = [
  'rate limit', 'rate_limit', 'ratelimit',
  'quota exceeded', 'too many requests',
  'resource exhausted', 'resourceexhausted',
  '429', '503',
];

function isRateLimitError(err: unknown): boolean {
  if (!err) return false;
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return RATE_LIMIT_PATTERNS.some(p => msg.includes(p));
}

async function requestWithRetry(
  provider:    { request: (...args: any[]) => any },
  userRequest: any,
  context:     any,
  maxRetries = 4
): Promise<any> {
  let delay = 2000; // start at 2 seconds
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await provider.request(userRequest, context);
    } catch (err: unknown) {
      if (isRateLimitError(err) && attempt < maxRetries) {
        context.onLog?.(
          `[AgentExecutor] Rate limit hit — waiting ${delay / 1000}s before retry ${attempt + 1}/${maxRetries}...`,
          'warning'
        );
        await new Promise(res => setTimeout(res, delay));
        delay = Math.min(delay * 2, 32000); // double delay: 2s → 4s → 8s → 16s → 32s
        continue;
      }
      throw err; // non-rate-limit errors propagate immediately
    }
  }
  throw new Error(`Rate limit persisted after ${maxRetries} retries. Check your API quota.`);
}

// ── Streaming Agent Executor ──────────────────────────────────────────────────

export class AgentExecutor {
  /**
   * Executes a task using the GeminiProvider streaming API.
   *
   * Message chain (SNS IDE standard):
   *   [system:text] → [user:text] → [ai:tool_use] → [user:tool_result] → [ai:tool_use] → ... → [ai:text]
   *
   * @param provider      StreamingProvider instance
   * @param systemPrompt  Agent system persona and rules
   * @param userPrompt    The task instruction for this run
   * @param tools         ToolRequest[] available to this agent (SNS IDE standard)
   * @param context       Session context (sessionId, legacyPath, modernPath, onLog)
   * @param maxIterations Safety limit for tool call loops (default: 40)
   * @param modelName     Model identifier for cost calculation
   */
  static async execute(
    provider: StreamingProvider,
    systemPrompt: string,
    userPrompt: string,
    tools: ToolRequest[],
    context: ToolContext,
    modelName = '',
    agentId = 'migration-agent'
  ): Promise<string> {
    // ── Resolve configs once — reused every turn (same pattern as compactor) ──
    // loopConfig: all thresholds for this provider family (no hardcoded values)
    // loopState:  mutable in-memory counters (fingerprints, noProgressTurns)
    const loopConfig = resolveLoopConfig(modelName);
    const loopState: LoopState = createLoopState();

    // ── Initialize message chain (SNS IDE LanguageModelMessage[]) ─────────
    const messages: LanguageModelMessage[] = [
      { actor: 'system', type: 'text', text: systemPrompt } as TextMessage,
      { actor: 'user',   type: 'text', text: userPrompt   } as TextMessage,
    ];

    let iteration = 0;
    let lastTextResponse = '';
    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    // Resolve compaction budget once (model is fixed for the lifetime of this execute call)
    const compactionCharBudget = resolveCompactionCharBudget(modelName);

    while (iteration < loopConfig.maxIterations) {
      iteration++;

      // ── Context Compaction (logic in compactor/agent-context-compactor.ts) ──
      compactMessagesIfNeeded(messages, compactionCharBudget, iteration, context.onLog);

      context.onLog?.(`[AI Request] Submitting query to LLM (Turn ${iteration})...`, 'info');

      const userRequest: UserRequest = {
        messages: [...messages],
        tools,
        sessionId: context.sessionId,
        requestId: `req_${context.sessionId}_t${iteration}`,
        modelName,
      };

      // Collect streaming output for this turn
      let turnText = '';
      // id → { name, argsJson }
      const pendingToolCalls = new Map<string, { id: string; name: string; args: string }>();

      // ── Stream this turn (with rate-limit retry) ──────────────────────
      const response = await requestWithRetry(provider, userRequest, context);

      for await (const part of response.stream) {
        if (isTextResponsePart(part)) {
          turnText += part.content;
          // Stream text token-by-token to SSE terminal
          EventBroadcaster.broadcast(context.sessionId, 'log', {
            message: part.content,
            level: 'stream',  // Frontend renders this as streaming text
            phase: 'agent'
          });
        } else if (isUsageResponsePart(part)) {
          const partInput = part.input_tokens;
          const partOutput = part.output_tokens;
          const partCacheCreation = part.cache_creation_input_tokens ?? 0;
          const partCacheRead = part.cache_read_input_tokens ?? 0;

          if (partInput > 0 || partOutput > 0 || partCacheCreation > 0 || partCacheRead > 0) {
            await SessionManager.recordTokenUsage(
              context.sessionId,
              partInput,
              partOutput,
              modelName,
              agentId,
              partCacheCreation > 0 ? partCacheCreation : undefined,
              partCacheRead > 0 ? partCacheRead : undefined
            );
          }
        } else if (isToolCallResponsePart(part)) {
          for (const tc of part.tool_calls) {
            if (tc.id && tc.function?.name && !tc.finished) {
              // New tool call announced
              pendingToolCalls.set(tc.id, {
                id: tc.id,
                name: tc.function.name,
                args: tc.function.arguments ?? '{}',
              });
            } else if (tc.id && tc.finished) {
              // Tool completed inside the stream (Gemini recursive loop executed it).
              // SNS IDE pattern: google-language-model.ts calls tool.handler() internally,
              // yields { finished: true, id, result } — our handlers already ran.
              // We must still push a tool_result message to keep the history chain intact
              // (required by Claude/OpenAI providers that validate message sequences).
              const existing = pendingToolCalls.get(tc.id);
              if (existing) {
                // Push tool_result to message history so chain is complete
                if (tc.result !== undefined) {
                  messages.push({
                    actor: 'user',
                    type: 'tool_result',
                    tool_use_id: tc.id,
                    name: existing.name,
                    content: tc.result as ToolCallResult,
                    is_error: hasToolError(tc.result as ToolCallResult),
                  } as ToolResultMessage);
                }
                // Broadcast tool_response event to FE (matches manual tool path)
                EventBroadcaster.broadcast(context.sessionId, 'tool_response', {
                  toolName:  existing.name,
                  success:   !hasToolError(tc.result as ToolCallResult),
                  inStream:  true,
                });
                context.onLog?.(`[Tool Response] ${existing.name} completed (in-stream, result recorded).`, 'success');
                pendingToolCalls.delete(tc.id);
              }
            }
          }
        }
      }

      if (turnText) lastTextResponse = turnText;

      // ── Reasoning Loop Detection ──────────────────────────────────────────
      // Threshold and snippet size come from loopConfig (provider-family aware).
      // flash-lite: 5K chars. gemini/gpt/groq: 10K. claude: 15K.
      // Recovery message built by buildRecoveryMessage() — no inline strings here.
      if (
        turnText.length > loopConfig.reasoningLoopThreshold &&
        pendingToolCalls.size === 0 &&
        iteration > 1
      ) {
        const snippet  = turnText.slice(0, loopConfig.reasoningLoopSnippet);
        const dropped  = Math.round((turnText.length - loopConfig.reasoningLoopSnippet) / 1_000);
        const truncated = snippet +
          `\n[...${dropped}K chars of repeated planning text omitted by orchestrator...]`;

        // Push truncated text as AI turn (keeps message chain valid)
        messages.push({ actor: 'ai', type: 'text', text: truncated } as TextMessage);

        // Recovery message from config — no inline string
        const recoveryMsg = buildRecoveryMessage(
          'reasoning-loop', '', loopConfig, { turnChars: turnText.length }
        );
        messages.push({ actor: 'user', type: 'text', text: recoveryMsg } as TextMessage);

        resetStateForErrorType(loopState, 'reasoning-loop');
        context.onLog?.(
          `[AgentExecutor] REASONING LOOP (${loopConfig.reasoningLoopThreshold / 1_000}K threshold): ` +
          `Turn ${iteration} generated ${Math.round(turnText.length / 1_000)}K chars, zero tool calls — injected recovery.`,
          'warning'
        );
        continue;
      }

      // ── If there are pending tool calls (not handled by stream recursion) ─
      // This path handles non-Gemini providers / fallback cases
      if (pendingToolCalls.size > 0) {
        // Append AI's tool_use messages to history
        for (const tc of pendingToolCalls.values()) {
          let parsedInput: unknown = {};
          try { parsedInput = JSON.parse(tc.args); } catch { /* ignore */ }

          messages.push({
            actor: 'ai',
            type: 'tool_use',
            id: tc.id,
            name: tc.name,
            input: parsedInput,
          } as ToolUseMessage);
        }

        // Execute each tool and append tool_result messages
        for (const tc of pendingToolCalls.values()) {
          const tool = tools.find(t => t.name === tc.name);
          let result: ToolCallResult;

          if (!tool) {
            const errMsg = `Tool '${tc.name}' not registered. Available: ${tools.map(t => t.name).join(', ')}`;
            context.onLog?.(`[AgentExecutor] ${errMsg}`, 'warning');
            result = makeToolErrorResult(
              buildRecoveryMessage('tool-not-found', tc.name, loopConfig),
              'tool-not-found'
            );
          } else {
            // ── Duplicate Call Fingerprint Detection ────────────────────────
            // Sliding window: block calls where (name + args) was already seen
            // fingerprintMaxDupes times. Costs vary by provider family.
            // Window and threshold from loopConfig — no hardcoded values here.
            const fingerprint  = `${tc.name}::${normalizeToolArgs(tc.args)}`;
            const dupeCount    = loopState.toolCallFingerprints.filter(f => f === fingerprint).length;

            if (dupeCount >= loopConfig.fingerprintMaxDupes) {
              // Block duplicate — return structured error, don't call real tool
              const dupeMsg = buildRecoveryMessage('duplicate-blocked', tc.name, loopConfig);
              context.onLog?.(
                `[AgentExecutor] DUPLICATE BLOCKED: "${tc.name}" with same args already called ` +
                `${dupeCount}x (limit: ${loopConfig.fingerprintMaxDupes}).`,
                'warning'
              );
              result = makeToolErrorResult(dupeMsg, 'duplicate-blocked');
              // Do NOT reset fingerprints — they are correctly blocking this call
            } else {
              context.onLog?.(`[Tool Call] Executing tool "${tc.name}"...`, 'info');

              // Broadcast structured tool_call event
              let parsedArgs: Record<string, unknown> = {};
              try { parsedArgs = JSON.parse(tc.args) as Record<string, unknown>; } catch { /* keep empty */ }
              EventBroadcaster.broadcast(context.sessionId, 'tool_call', {
                name: tc.name, args: parsedArgs, agentId,
              });

              try {
                // ← SNS IDE standard: pass raw JSON arg_string
                result = await tool.handler(tc.args, { ...context, toolCallId: tc.id });
                context.onLog?.(`[Tool Response] Completed "${tc.name}" successfully.`, 'success');
                EventBroadcaster.broadcast(context.sessionId, 'tool_response', {
                  name: tc.name, success: true,
                });

                // Track fingerprint only on real (non-blocked) calls
                loopState.toolCallFingerprints.push(fingerprint);
                if (loopState.toolCallFingerprints.length > loopConfig.fingerprintWindow) {
                  loopState.toolCallFingerprints.shift(); // drop oldest
                }
                // On success: clear entries for THIS tool only
                // (different args for same tool = legitimate new call — clear old prints)
                if (!hasToolError(result)) {
                  loopState.toolCallFingerprints = loopState.toolCallFingerprints
                    .filter(f => !f.startsWith(`${tc.name}::`));
                }
              } catch (err: unknown) {
                const errMsg = err instanceof Error ? err.message : 'Unknown tool execution error';
                context.onLog?.(`[Tool Error] Failed executing "${tc.name}": ${errMsg}`, 'error');
                EventBroadcaster.broadcast(context.sessionId, 'tool_response', {
                  name: tc.name, success: false,
                });
                result = makeToolErrorResult(errMsg);

                // Track fingerprint for failed calls too (enables stuck detection)
                loopState.toolCallFingerprints.push(fingerprint);
                if (loopState.toolCallFingerprints.length > loopConfig.fingerprintWindow) {
                  loopState.toolCallFingerprints.shift();
                }
              }
            }
          }

          // Append tool_result to the message chain
          messages.push({
            actor: 'user',
            type: 'tool_result',
            tool_use_id: tc.id,
            name: tc.name,
            content: result,
            is_error: hasToolError(result),
          } as ToolResultMessage);
        }

        // ── Stuck Tool Detection ─────────────────────────────────────────────
        // Window size and error threshold from loopConfig (not hardcoded).
        // Recovery message from buildRecoveryMessage() — no inline strings.
        {
          const allResults = messages.filter(m => m.type === 'tool_result') as ToolResultMessage[];
          const lastN      = allResults.slice(-loopConfig.stuckToolWindow);
          if (lastN.length >= loopConfig.stuckToolWindow) {
            const firstName        = lastN[0].name;
            const allSameToolErrors = lastN.every(
              r => r.name === firstName && r.is_error === true
            );
            if (allSameToolErrors) {
              const stuckMsg = buildRecoveryMessage('stuck-tool', firstName, loopConfig);
              messages.push({ actor: 'user', type: 'text', text: stuckMsg } as TextMessage);
              resetStateForErrorType(loopState, 'stuck-tool');
              context.onLog?.(
                `[AgentExecutor] STUCK DETECTED: "${firstName}" failed ` +
                `${loopConfig.stuckToolMaxErrors}x in a row — injected recovery.`,
                'warning'
              );
            }
          }
        }

        // ── No-Progress Detection ────────────────────────────────────────────
        // If ALL tools this turn returned is_error:true → no state change made.
        // After noProgressMaxTurns consecutive all-error turns → emergency recovery.
        {
          const thisTurnIds    = [...pendingToolCalls.keys()];
          const allResults     = messages.filter(m => m.type === 'tool_result') as ToolResultMessage[];
          const thisTurnErrors = thisTurnIds
            .map(id => {
              // findLast not in ES2020 target — manual reverse search
              const matches = allResults.filter(r => r.tool_use_id === id);
              return matches.length > 0 ? matches[matches.length - 1] : undefined;
            })
            .filter((r): r is ToolResultMessage => r !== undefined)
            .filter(r => r.is_error === true).length;

          if (thisTurnIds.length > 0 && thisTurnErrors === thisTurnIds.length) {
            // All tools this turn errored — no progress
            loopState.noProgressTurns++;
            if (loopState.noProgressTurns >= loopConfig.noProgressMaxTurns) {
              const noProgressMsg = buildRecoveryMessage('no-progress', '', loopConfig);
              messages.push({ actor: 'user', type: 'text', text: noProgressMsg } as TextMessage);
              resetStateForErrorType(loopState, 'no-progress');
              context.onLog?.(
                `[AgentExecutor] NO_PROGRESS: ${loopConfig.noProgressMaxTurns} consecutive all-error turns — injected emergency recovery.`,
                'warning'
              );
            }
          } else if (thisTurnErrors < thisTurnIds.length) {
            // At least one tool succeeded → real progress → reset counter
            loopState.noProgressTurns = 0;
          }
        }

        // Loop back for the next LLM turn with tool results
        continue;
      }

      // ── Final Answer — no more pending tool calls ──────────────────────
      context.onLog?.(`[AI Response] Final completion after ${iteration} turn(s).`, 'success');
      return turnText || lastTextResponse;
    }

    // ── Max Iterations ─────────────────────────────────────────────────────
    context.onLog?.(
      `[AgentExecutor] Max ${loopConfig.maxIterations} iterations reached. Agent may have written output files.`,
      'warning'
    );
    return lastTextResponse || `Agent completed ${loopConfig.maxIterations} turns. Check output workspace for generated files.`;
  }
}
