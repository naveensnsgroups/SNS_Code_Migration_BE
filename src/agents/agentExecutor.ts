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
} from '../types/language-model.js';
import { ToolRequest, ToolContext } from '../types/tool.js';
import { EventBroadcaster } from '../routes/stream.js';
import { SessionManager } from '../session/sessionManager.js';
import { TokenUsage } from '../types.js';
import { TokenUsageEntry } from '../session/types.js';
import { GeminiProvider } from '../ai/gemini.js';

// ── Per-provider cost table (USD per 1M tokens) ───────────────────────────────
export const COST_TABLE: Record<string, [number, number]> = {
  'claude-opus-4':      [15,    75],
  'claude-opus-4-5':    [15,    75],
  'claude-sonnet-4':    [3,     15],
  'claude-sonnet-4-5':  [3,     15],
  'claude-3-5-sonnet':  [3,     15],
  'claude-3-opus':      [15,    75],
  'claude-3-haiku':     [0.25,  1.25],
  'gpt-4o':             [2.5,   10],
  'gpt-4o-mini':        [0.15,  0.6],
  'gpt-4-turbo':        [10,    30],
  'gpt-3.5-turbo':      [0.5,   1.5],
  'gemini-2.5-pro':     [1.25,  10],
  'gemini-2.0-flash':   [0.075, 0.3],
  'gemini-1.5-pro':     [1.25,  5],
  'gemini-1.5-flash':   [0.075, 0.3],
  'default':            [1,     3],
};

export function estimateCost(inputTokens: number, outputTokens: number, model: string): number {
  const entry = Object.entries(COST_TABLE).find(([key]) => model.toLowerCase().includes(key));
  const [inCostPerM, outCostPerM] = entry ? entry[1] : COST_TABLE['default'];
  return Math.round(((inputTokens / 1_000_000) * inCostPerM + (outputTokens / 1_000_000) * outCostPerM) * 10000) / 10000;
}

// ── Streaming Agent Executor ──────────────────────────────────────────────────

export class AgentExecutor {
  /**
   * Executes a task using the GeminiProvider streaming API.
   *
   * Message chain (SNS IDE standard):
   *   [system:text] → [user:text] → [ai:tool_use] → [user:tool_result] → [ai:tool_use] → ... → [ai:text]
   *
   * @param provider      GeminiProvider instance
   * @param systemPrompt  Agent system persona and rules
   * @param userPrompt    The task instruction for this run
   * @param tools         ToolRequest[] available to this agent (SNS IDE standard)
   * @param context       Session context (sessionId, legacyPath, modernPath, onLog)
   * @param maxIterations Safety limit for tool call loops (default: 40)
   * @param modelName     Model identifier for cost calculation
   */
  static async execute(
    provider: GeminiProvider,
    systemPrompt: string,
    userPrompt: string,
    tools: ToolRequest[],
    context: ToolContext,
    maxIterations = 40,
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

    while (iteration < maxIterations) {
      iteration++;
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

      // ── Stream this turn ───────────────────────────────────────────────
      const response = await provider.request(userRequest, context);

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
            } else if (tc.id && tc.finished && pendingToolCalls.has(tc.id)) {
              // Tool completed inside the stream (recursive Gemini loop handled it)
              // The result is already fed back — just log it
              const existing = pendingToolCalls.get(tc.id)!;
              context.onLog?.(`[Tool Response] ${existing.name} completed (in-stream).`, 'success');
              pendingToolCalls.delete(tc.id);
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
            try {
              // ← SNS IDE standard: pass raw JSON arg_string
              result = await tool.handler(tc.args, { ...context, toolCallId: tc.id });
              context.onLog?.(`[Tool Response] Completed "${tc.name}" successfully.`, 'success');
            } catch (err: unknown) {
              const errMsg = err instanceof Error ? err.message : 'Unknown tool execution error';
              context.onLog?.(`[Tool Error] Failed executing "${tc.name}": ${errMsg}`, 'error');
              result = makeToolErrorResult(errMsg);
            }
          }

          // Append tool_result to the message chain
          messages.push({
            actor: 'user',
            type: 'tool_result',
            tool_use_id: tc.id,
            name: tc.name,
            content: result,
            is_error: false,
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
