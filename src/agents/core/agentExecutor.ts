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

// ── Cost Estimation (extracted to compactor/agent-cost-estimator.ts) ────────────
// Re-exported for backward compatibility.
export { COST_TABLE, estimateCost } from '../compactor/agent-cost-estimator.js';



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
    // Agent stops naturally when it has no more tool calls — this is only a safety net
    // against infinite loops caused by bugs. Set very high so it is never reached in practice.
    maxIterations = 10_000,
    modelName = '',
    agentId = 'migration-agent'
  ): Promise<string> {
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

    while (iteration < maxIterations) {
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
            result = makeToolErrorResult(errMsg, 'tool-not-available');
          } else {
            context.onLog?.(`[Tool Call] Executing tool "${tc.name}"...`, 'info');

            // Broadcast structured tool_call event — FE receives clean JSON (no log parsing)
            let parsedArgs: Record<string, unknown> = {};
            try { parsedArgs = JSON.parse(tc.args) as Record<string, unknown>; } catch { /* keep empty */ }
            EventBroadcaster.broadcast(context.sessionId, 'tool_call', {
              name:    tc.name,
              args:    parsedArgs,
              agentId,
            });

            try {
              // ← SNS IDE standard: pass raw JSON arg_string
              result = await tool.handler(tc.args, { ...context, toolCallId: tc.id });
              context.onLog?.(`[Tool Response] Completed "${tc.name}" successfully.`, 'success');

              // Broadcast tool_response (success)
              EventBroadcaster.broadcast(context.sessionId, 'tool_response', {
                name:    tc.name,
                success: true,
              });
            } catch (err: unknown) {
              const errMsg = err instanceof Error ? err.message : 'Unknown tool execution error';
              context.onLog?.(`[Tool Error] Failed executing "${tc.name}": ${errMsg}`, 'error');

              // Broadcast tool_response (failure)
              EventBroadcaster.broadcast(context.sessionId, 'tool_response', {
                name:    tc.name,
                success: false,
              });
              result = makeToolErrorResult(errMsg);
            }
          }

          // Append tool_result to the message chain
          // is_error MUST reflect the actual outcome:
          //   true  → Claude/Anthropic treats this as a failure and knows to retry
          //   false → LLM treats this as success (wrong if tool actually failed)
          messages.push({
            actor: 'user',
            type: 'tool_result',
            tool_use_id: tc.id,
            name: tc.name,
            content: result,
            is_error: hasToolError(result),  // ← reads actual error status from result
          } as ToolResultMessage);
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
      `[AgentExecutor] Max ${maxIterations} iterations reached. Agent may have written output files.`,
      'warning'
    );
    return lastTextResponse || `Agent completed ${maxIterations} turns. Check output workspace for generated files.`;
  }
}
