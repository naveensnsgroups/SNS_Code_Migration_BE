// =============================================================================
//  claude-provider.ts — Anthropic Claude Streaming Provider (SNS IDE Standard)
//
//  Mirrors: snside/packages/ai-anthropic/src/node/anthropic-language-model.ts
//
//  Key implementation facts:
//  1. Uses client.messages.stream() — NOT messages.create() (that is blocking)
//  2. System prompt sent as top-level { system } param — NOT as first message
//  3. Tool calling: consecutive tool_use blocks grouped in ONE assistant message
//  4. Tool results: sent as user message with array of tool_result content blocks
//  5. Yields TextResponsePart, ToolCallResponsePart, UsageResponsePart
//  6. Retry logic: matches google-language-model.ts retry pattern exactly
//  7. Cache tokens: extracted from message_start event (input_tokens_cache_read/write)
// =============================================================================

import Anthropic from '@anthropic-ai/sdk';
import {
  LanguageModelMessage,
  LanguageModelStreamPart,
  LanguageModelStreamResponse,
  TextResponsePart,
  ToolCallResponsePart,
  UsageResponsePart,
  StreamToolCall,
  makeToolErrorResult,
  ToolCallResult,
  UserRequest,
  StreamingProvider,
} from '../../types/language-model.js';
import { ToolRequest, ToolContext } from '../../types/tool.js';

// ── Config ────────────────────────────────────────────────────────────────────

export interface ClaudeProviderConfig {
  maxRetries?: number;
  retryDelayOnRateLimitError?: number;  // seconds; -1 = no retry on rate limit
  retryDelayOnOtherErrors?: number;     // seconds; -1 = no retry on other errors
  maxTokens?: number;                   // default 8192
}

// ── Message Conversion ────────────────────────────────────────────────────────
// Converts our LanguageModelMessage[] to Anthropic.MessageParam[].
// Rules:
//   - system messages → extracted as top-level system param (NOT in messages array)
//   - user text → { role: 'user', content: string }
//   - ai text → { role: 'assistant', content: [TextBlock] }
//   - ai tool_use → { role: 'assistant', content: [TextBlock?, ...ToolUseBlock[]] }
//   - user tool_result → { role: 'user', content: [ToolResultBlock, ...] }
//   - Consecutive same-role messages are MERGED (Anthropic requires alternating roles)

// Anthropic SDK v0.22 uses these type shapes — defined inline to avoid SDK version drift
type CacheControl      = { type: 'ephemeral' };
type AnthMessageParam  = { role: 'user' | 'assistant'; content: string | AnthContentBlock[] };
type AnthContentBlock  = AnthTextBlock | AnthToolUseBlock | AnthToolResultBlock;
type AnthTextBlock     = { type: 'text';        text: string;                                  cache_control?: CacheControl };
type AnthToolUseBlock  = { type: 'tool_use';    id: string; name: string; input: Record<string, unknown> };
type AnthToolResultBlock={ type: 'tool_result'; tool_use_id: string; content: Array<{ type: 'text'; text: string }>; is_error?: boolean; cache_control?: CacheControl };
type AnthSystemBlock   = { type: 'text';        text: string;                                  cache_control?: CacheControl };
type AnthTool          = { name: string; description: string; input_schema: { type: 'object'; properties: Record<string, unknown>; required?: string[] }; cache_control?: CacheControl };

function transformToAnthropicMessages(messages: readonly LanguageModelMessage[]): {
  messages: AnthMessageParam[];
  systemPrompt?: string;
} {
  // Extract system message
  const systemMsgObj = messages.find(m => m.actor === 'system' && m.type === 'text');
  const systemPrompt = systemMsgObj && 'text' in systemMsgObj ? systemMsgObj.text : undefined;

  const anthropicMessages: AnthMessageParam[] = [];

  for (const msg of messages) {
    if (msg.actor === 'system') continue;

    if (msg.type === 'text') {
      const role = msg.actor === 'ai' ? 'assistant' : 'user';
      const block: AnthTextBlock = { type: 'text', text: msg.text };
      mergeOrPush(anthropicMessages, role, [block]);
    } else if (msg.type === 'tool_use') {
      // AI tool call
      let parsedInput: Record<string, unknown> = {};
      if (typeof msg.input === 'string') {
        try { parsedInput = JSON.parse(msg.input); } catch { /* keep {} */ }
      } else if (msg.input && typeof msg.input === 'object') {
        parsedInput = msg.input as Record<string, unknown>;
      }
      const block: AnthToolUseBlock = {
        type: 'tool_use',
        id: msg.id,
        name: msg.name,
        input: parsedInput,
      };
      mergeOrPush(anthropicMessages, 'assistant', [block]);
    } else if (msg.type === 'tool_result') {
      // User tool result
      const contentText = extractTextFromToolResult(msg.content);
      const block: AnthToolResultBlock = {
        type: 'tool_result',
        tool_use_id: msg.tool_use_id,
        content: [{ type: 'text', text: contentText }],
        is_error: msg.is_error ?? false,
      };
      mergeOrPush(anthropicMessages, 'user', [block]);
    }
  }

  // Ensure conversation starts with user message (Anthropic requirement)
  if (anthropicMessages.length > 0 && anthropicMessages[0].role !== 'user') {
    anthropicMessages.unshift({ role: 'user', content: 'Please proceed.' });
  }

  return { messages: anthropicMessages, systemPrompt };
}

/**
 * Merges content blocks into the last message if same role,
 * otherwise pushes a new message.
 * This prevents "consecutive same-role" errors from Anthropic API.
 */
function mergeOrPush(
  messages: AnthMessageParam[],
  role: 'user' | 'assistant',
  blocks: AnthContentBlock[]
): void {
  const last = messages[messages.length - 1];
  if (last && last.role === role) {
    // Merge into last message
    if (typeof last.content === 'string') {
      last.content = [{ type: 'text', text: last.content }, ...blocks];
    } else {
      (last.content as AnthContentBlock[]).push(...blocks);
    }
  } else {
    messages.push({ role, content: blocks });
  }
}

function extractTextFromToolResult(result: ToolCallResult): string {
  if (result === null || result === undefined) return '';
  if (typeof result === 'string') return result;
  if (typeof result === 'object' && 'content' in result) {
    const wrapper = result as { content: Array<{ type: string; text?: string; data?: string }> };
    const texts = wrapper.content.map(c => c.text || c.data || '').filter(Boolean);
    return texts.join('\n');
  }
  if (typeof result === 'object') {
    try { return JSON.stringify(result, null, 2); } catch { return String(result); }
  }
  return String(result);
}

// ── Tool Declaration Conversion ───────────────────────────────────────────────

function buildAnthropicTools(tools: ToolRequest[]): AnthTool[] {
  const result: AnthTool[] = tools.map(t => ({
    name: t.name,
    description: t.description,
    input_schema: {
      type: 'object' as const,
      properties: t.parameters?.properties ?? {},
      required: t.parameters?.required ?? [],
    },
  }));

  // ── Prompt Caching: mark last tool as cache breakpoint ─────────────────
  // Anthropic caches everything UP TO this breakpoint (tools are static per session).
  // Cost on cached turns: ~10% of full tool schema cost.
  if (result.length > 0) {
    result[result.length - 1].cache_control = { type: 'ephemeral' };
  }

  return result;
}

// ── Message History Cache Breakpoints ────────────────────────────────────────────
// As the agent loop accumulates tool_use → tool_result turns, the message
// history grows. The stable part (older turns) can be cached so that each
// new turn only pays for the new messages, not the full history.
//
// Strategy: mark the content of the penultimate user message (the last one
// that is "settled" and won't change). This gives Anthropic a breakpoint
// at which to cache the entire conversation up to that point.
// Anthropic allows 4 breakpoints total:
//   1 = system prompt (always marked)
//   2 = last tool definition (marked in buildAnthropicTools)
//   3-4 = conversation history (marked here in the 2 oldest stable user messages)

function applyMessageCacheBreakpoints(messages: AnthMessageParam[]): AnthMessageParam[] {
  // Only apply when conversation is long enough to benefit (>= 3 exchanges)
  if (messages.length < 6) return messages;

  // Find indices of all user messages
  const userIndices = messages
    .map((m, i) => (m.role === 'user' ? i : -1))
    .filter(i => i >= 0);

  // Cache the 2 oldest stable user messages (all except the very last, which is still being built)
  const stableIndices = new Set(userIndices.slice(0, -1).slice(-2));
  if (stableIndices.size === 0) return messages;

  return messages.map((msg, i) => {
    if (!stableIndices.has(i)) return msg;

    const content = msg.content;
    // Add cache_control to the last content block of this user message
    if (typeof content === 'string') {
      return {
        ...msg,
        content: [{ type: 'text' as const, text: content, cache_control: { type: 'ephemeral' } as CacheControl }],
      };
    }
    if (Array.isArray(content) && content.length > 0) {
      const newContent = [...content] as AnthContentBlock[];
      const last = newContent[newContent.length - 1];
      newContent[newContent.length - 1] = { ...last, cache_control: { type: 'ephemeral' } } as AnthContentBlock;
      return { ...msg, content: newContent };
    }
    return msg;
  });
}

// ── Retry Helpers ─────────────────────────────────────────────────────────────

function isRateLimitError(err: any): boolean {
  const msg = String(err?.message || err || '').toLowerCase();
  const status = err?.status || err?.statusCode;
  if (status === 429) return true;
  return msg.includes('429') || msg.includes('rate_limit') || msg.includes('rate limit') ||
         msg.includes('overloaded') || msg.includes('resource_exhausted');
}

// ── Claude Streaming Provider ─────────────────────────────────────────────────

export class ClaudeProvider implements StreamingProvider {
  private readonly client: Anthropic;
  private readonly modelName: string;
  private readonly config: Required<ClaudeProviderConfig>;

  constructor(model: string, apiKey: string, config?: ClaudeProviderConfig) {
    this.modelName = model;
    this.client = new Anthropic({
      apiKey,
      // No custom timeouts — Anthropic SDK handles stream lifecycle
      maxRetries: 0, // We manage retries ourselves (same as SNS IDE pattern)
    });
    this.config = {
      maxRetries: config?.maxRetries ?? 3,
      retryDelayOnRateLimitError: config?.retryDelayOnRateLimitError ?? 60,
      retryDelayOnOtherErrors: config?.retryDelayOnOtherErrors ?? -1,
      maxTokens: config?.maxTokens ?? 8192,
    };
  }

  private async withRetry<T>(fn: () => Promise<T>, toolCtx?: ToolContext): Promise<T> {
    const { maxRetries, retryDelayOnRateLimitError, retryDelayOnOtherErrors } = this.config;
    let attempt = 0;
    while (true) {
      try {
        return await fn();
      } catch (err: any) {
        attempt++;
        if (attempt > maxRetries) throw err;

        const isRateLimit = isRateLimitError(err);
        let delaySeconds: number;

        if (isRateLimit) {
          if (retryDelayOnRateLimitError < 0) throw err;
          delaySeconds = retryDelayOnRateLimitError;
        } else {
          if (retryDelayOnOtherErrors < 0) throw err;
          delaySeconds = retryDelayOnOtherErrors;
        }

        const msg = err instanceof Error ? err.message : String(err);
        const logMsg = `Claude API call failed (${msg}). Retrying attempt ${attempt}/${maxRetries} in ${delaySeconds}s...`;

        if (toolCtx?.onLog) {
          toolCtx.onLog(logMsg, 'warning');
        } else {
          console.warn(logMsg);
        }

        await new Promise<void>(res => setTimeout(res, delaySeconds * 1000));
      }
    }
  }

  /**
   * Sends a streaming request to Anthropic Claude.
   * Mirrors SNS IDE AnthropicLanguageModel.request() → handleStreamingRequest().
   *
   * Returns a LanguageModelStreamResponse with async iterable stream.
   * Each streamed part is one of: TextResponsePart | ToolCallResponsePart | UsageResponsePart.
   */
  async request(userRequest: UserRequest, toolCtx?: ToolContext): Promise<LanguageModelStreamResponse> {
    const { messages: anthropicMessages, systemPrompt } = transformToAnthropicMessages(userRequest.messages);
    const tools = userRequest.tools ?? [];
    const anthropicTools = tools.length > 0 ? buildAnthropicTools(tools) : undefined;

    const provider = this;

    const asyncIterator: LanguageModelStreamResponse = {
      stream: (async function* (): AsyncIterable<LanguageModelStreamPart> {
        yield* provider.streamOneTurn(
          anthropicMessages,
          systemPrompt,
          anthropicTools,
          tools,
          userRequest,
          toolCtx
        );
      })(),
    };

    return asyncIterator;
  }

  /**
   * Runs a single Anthropic streaming turn.
   * If the response contains tool_use blocks, executes tools and recursively yields
   * results from the next turn — mirrors SNS IDE's handleStreamingRequest recursion.
   */
  private async *streamOneTurn(
    messages: AnthMessageParam[],
    systemPrompt: string | undefined,
    anthropicTools: AnthTool[] | undefined,
    toolRequests: ToolRequest[],
    userRequest: UserRequest,
    toolCtx: ToolContext | undefined
  ): AsyncIterable<LanguageModelStreamPart> {
    // ── Build cached system prompt (array format with cache_control) ────────────
    // Anthropic caches the system prompt for 5 minutes.
    // Cost on cached turns: ~10% of full system prompt token cost.
    // The system prompt must be >= 1024 tokens to qualify (our prompts are 300-800 lines,
    // well above threshold).
    const systemBlocks: AnthSystemBlock[] | undefined = systemPrompt
      ? [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }]
      : undefined;

    // ── Apply message history cache breakpoints ───────────────────────────────
    // Marks stable older user messages so Anthropic caches the conversation history.
    const cachedMessages = applyMessageCacheBreakpoints(messages);

    // ── Create streaming request (with retry) ─────────────────────────────
    // messages.stream() returns a MessageStream directly (not a Promise<MessageStream>)
    // withRetry wraps it in a try/catch for retry on failure
    const stream = await this.withRetry(
      async () => this.client.messages.stream({
        model: this.modelName,
        max_tokens: this.config.maxTokens,
        system: systemBlocks as any,   // array with cache_control (Anthropic SDK accepts both string and array)
        messages: cachedMessages as any,
        tools: anthropicTools as any,
        tool_choice: anthropicTools ? { type: 'auto' } : undefined,
      } as any),
      toolCtx
    );

    // ── Collect streaming parts ───────────────────────────────────────────
    // Accumulated for tool call continuation
    const toolUseBlocks: Array<{ id: string; name: string; inputJson: string }> = [];
    let accumulatedText = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheCreationTokens = 0;
    let cacheReadTokens = 0;

    // Track per-tool-call args accumulation
    const toolArgBuffers = new Map<string, string>();

    // ── Process stream events ─────────────────────────────────────────────
    for await (const event of stream) {
      switch (event.type) {
        case 'message_start': {
          // Input token counts (including cache) come from message_start
          inputTokens = event.message.usage?.input_tokens ?? 0;
          cacheCreationTokens = (event.message.usage as any)?.cache_creation_input_tokens ?? 0;
          cacheReadTokens = (event.message.usage as any)?.cache_read_input_tokens ?? 0;
          break;
        }

        case 'content_block_start': {
          if (event.content_block.type === 'tool_use') {
            // New tool call starting
            const tc = event.content_block;
            toolArgBuffers.set(tc.id, '');
            toolUseBlocks.push({ id: tc.id, name: tc.name, inputJson: '' });

            // Announce tool call (not-finished yet — arguments still streaming)
            const toolCallPart: ToolCallResponsePart = {
              tool_calls: [{
                id: tc.id,
                finished: false,
                function: { name: tc.name, arguments: '' },
              }],
            };
            yield toolCallPart;
          }
          break;
        }

        case 'content_block_delta': {
          if (event.delta.type === 'text_delta') {
            // Text chunk
            const textPart: TextResponsePart = { content: event.delta.text };
            accumulatedText += event.delta.text;
            yield textPart;

          } else if (event.delta.type === 'input_json_delta') {
            // Tool args chunk — accumulate per tool_use_id
            // Find which tool call is currently active (last in toolUseBlocks)
            const activeBlock = toolUseBlocks[toolUseBlocks.length - 1];
            if (activeBlock) {
              const current = toolArgBuffers.get(activeBlock.id) ?? '';
              const updated = current + event.delta.partial_json;
              toolArgBuffers.set(activeBlock.id, updated);
              activeBlock.inputJson = updated;

              // Stream delta to frontend (argumentsDelta=true means it's partial)
              const deltaCallPart: ToolCallResponsePart = {
                tool_calls: [{
                  id: activeBlock.id,
                  function: { arguments: event.delta.partial_json },
                  argumentsDelta: true,
                }],
              };
              yield deltaCallPart;
            }
          }
          break;
        }

        case 'message_delta': {
          // Output token count comes from message_delta.usage
          outputTokens = event.usage?.output_tokens ?? outputTokens;
          break;
        }

        case 'message_stop': {
          // Final usage yields — mirrors SNS IDE UsageResponsePart
          const usagePart: UsageResponsePart = {
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            cache_creation_input_tokens: cacheCreationTokens > 0 ? cacheCreationTokens : undefined,
            cache_read_input_tokens: cacheReadTokens > 0 ? cacheReadTokens : undefined,
          };
          yield usagePart;
          break;
        }

        default:
          break;
      }
    }

    // ── Process tool calls ────────────────────────────────────────────────
    if (toolUseBlocks.length > 0) {
      // Build the assistant message with tool_use blocks (for conversation history)
      const assistantContent: AnthContentBlock[] = [];
      if (accumulatedText.trim()) {
        assistantContent.push({ type: 'text', text: accumulatedText });
      }
      for (const block of toolUseBlocks) {
        let parsedInput: Record<string, unknown> = {};
        try { parsedInput = JSON.parse(block.inputJson || '{}'); } catch { /* keep {} */ }
        assistantContent.push({
          type: 'tool_use',
          id: block.id,
          name: block.name,
          input: parsedInput,
        });
      }

      // Execute all tool calls in parallel (same as SNS IDE Promise.all pattern)
      const toolResultBlocks: AnthToolResultBlock[] = [];
      const finishedCalls: StreamToolCall[] = [];

      await Promise.all(toolUseBlocks.map(async (block) => {
        const tool = toolRequests.find(t => t.name === block.name);
        let result: ToolCallResult;

        if (!tool) {
          result = makeToolErrorResult(
            `Tool '${block.name}' not found in available tools.`,
            'tool-not-available'
          );
        } else {
          try {
            toolCtx?.onLog?.(`[Tool Call] ${block.name}(${block.inputJson.slice(0, 80)}...)`, 'info');
            // SNS IDE standard: pass raw JSON arg_string to handler
            result = await tool.handler(block.inputJson || '{}', toolCtx ? { ...toolCtx, toolCallId: block.id } : undefined);
            toolCtx?.onLog?.(`[Tool Response] ${block.name} completed.`, 'success');
          } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : 'Tool execution failed';
            toolCtx?.onLog?.(`[Tool Error] ${block.name}: ${msg}`, 'error');
            result = makeToolErrorResult(msg);
          }
        }

        const resultText = extractTextFromToolResult(result);

        toolResultBlocks.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: [{ type: 'text', text: resultText }],
          is_error: false,
        } as AnthToolResultBlock);

        finishedCalls.push({
          id: block.id,
          finished: true,
          result,
          function: { name: block.name, arguments: block.inputJson },
        });
      }));

      // Yield all finished tool call results
      yield { tool_calls: finishedCalls } as ToolCallResponsePart;

      // Build continuation messages = [...existing, assistant turn, user tool_results turn]
      const continuationMessages: AnthMessageParam[] = [
        ...messages,
        { role: 'assistant', content: assistantContent },
        { role: 'user', content: toolResultBlocks },
      ];

      // Recursively continue the conversation with tool results
      yield* this.streamOneTurn(
        continuationMessages,
        systemPrompt,
        anthropicTools,
        toolRequests,
        userRequest,
        toolCtx
      );
    }
  }
}
