

import Anthropic from '@anthropic-ai/sdk';
import {
  LanguageModelMessage,
  LanguageModelStreamPart,
  LanguageModelStreamResponse,
  TextResponsePart,
  ToolCallResponsePart,
  UsageResponsePart,
  ToolCallResult,
  UserRequest,
  StreamingProvider,
} from '../../types/language-model.js';
import { ToolRequest, ToolContext } from '../../types/tool.js';

export interface ClaudeProviderConfig {
  maxRetries?: number;
  retryDelayOnRateLimitError?: number;  
  retryDelayOnOtherErrors?: number;     
  maxTokens?: number;                   
}

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
      
      let parsedInput: Record<string, unknown> = {};
      if (typeof msg.input === 'string') {
        try { parsedInput = JSON.parse(msg.input); } catch {  }
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

  
  if (anthropicMessages.length > 0 && anthropicMessages[0].role !== 'user') {
    anthropicMessages.unshift({ role: 'user', content: 'Please proceed.' });
  }

  return { messages: anthropicMessages, systemPrompt };
}

function mergeOrPush(
  messages: AnthMessageParam[],
  role: 'user' | 'assistant',
  blocks: AnthContentBlock[]
): void {
  const last = messages[messages.length - 1];
  if (last && last.role === role) {
    
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

  
  
  
  if (result.length > 0) {
    result[result.length - 1].cache_control = { type: 'ephemeral' };
  }

  return result;
}

function applyMessageCacheBreakpoints(messages: AnthMessageParam[]): AnthMessageParam[] {
  
  if (messages.length < 6) return messages;

  
  const userIndices = messages
    .map((m, i) => (m.role === 'user' ? i : -1))
    .filter(i => i >= 0);

  
  const stableIndices = new Set(userIndices.slice(0, -1).slice(-2));
  if (stableIndices.size === 0) return messages;

  return messages.map((msg, i) => {
    if (!stableIndices.has(i)) return msg;

    const content = msg.content;
    
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

function isRateLimitError(err: any): boolean {
  const msg = String(err?.message || err || '').toLowerCase();
  const status = err?.status || err?.statusCode;
  if (status === 429) return true;
  return msg.includes('429') || msg.includes('rate_limit') || msg.includes('rate limit') ||
         msg.includes('overloaded') || msg.includes('resource_exhausted');
}

export class ClaudeProvider implements StreamingProvider {
  private readonly client: Anthropic;
  private readonly modelName: string;
  private readonly config: Required<ClaudeProviderConfig>;

  constructor(model: string, apiKey: string, config?: ClaudeProviderConfig) {
    this.modelName = model;
    this.client = new Anthropic({
      apiKey,
      
      maxRetries: 0, 
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
          toolCtx
        );
      })(),
    };

    return asyncIterator;
  }

  
  private async *streamOneTurn(
    messages: AnthMessageParam[],
    systemPrompt: string | undefined,
    anthropicTools: AnthTool[] | undefined,
    toolCtx: ToolContext | undefined
  ): AsyncIterable<LanguageModelStreamPart> {
    
    
    
    
    
    const systemBlocks: AnthSystemBlock[] | undefined = systemPrompt
      ? [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }]
      : undefined;

    
    
    const cachedMessages = applyMessageCacheBreakpoints(messages);

    
    
    
    const stream = await this.withRetry(
      async () => this.client.messages.stream({
        model: this.modelName,
        max_tokens: this.config.maxTokens,
        system: systemBlocks as any,   
        messages: cachedMessages as any,
        tools: anthropicTools as any,
        tool_choice: anthropicTools ? { type: 'auto' } : undefined,
      } as any),
      toolCtx
    );

    
    
    const toolUseBlocks: Array<{ id: string; name: string; inputJson: string }> = [];
    let accumulatedText = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheCreationTokens = 0;
    let cacheReadTokens = 0;

    
    const toolArgBuffers = new Map<string, string>();

    
    for await (const event of stream) {
      switch (event.type) {
        case 'message_start': {
          
          inputTokens = event.message.usage?.input_tokens ?? 0;
          cacheCreationTokens = (event.message.usage as any)?.cache_creation_input_tokens ?? 0;
          cacheReadTokens = (event.message.usage as any)?.cache_read_input_tokens ?? 0;
          break;
        }

        case 'content_block_start': {
          if (event.content_block.type === 'tool_use') {
            
            const tc = event.content_block;
            toolArgBuffers.set(tc.id, '');
            toolUseBlocks.push({ id: tc.id, name: tc.name, inputJson: '' });

            
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
            
            const textPart: TextResponsePart = { content: event.delta.text };
            accumulatedText += event.delta.text;
            yield textPart;

          } else if (event.delta.type === 'input_json_delta') {
            
            
            const activeBlock = toolUseBlocks[toolUseBlocks.length - 1];
            if (activeBlock) {
              const current = toolArgBuffers.get(activeBlock.id) ?? '';
              const updated = current + event.delta.partial_json;
              toolArgBuffers.set(activeBlock.id, updated);
              activeBlock.inputJson = updated;

              
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
          
          outputTokens = event.usage?.output_tokens ?? outputTokens;
          break;
        }

        case 'message_stop': {
          
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

    // Single-turn contract: emit each tool call with its COMPLETE accumulated
    // arguments (finished:false, no result) and STOP. The AgentExecutor owns the
    // loop — it executes the tools, runs loop/stuck/duplicate detection, appends
    // the results, and re-invokes request() for the next turn. Providers must NOT
    // execute tools or self-recurse; doing so bypassed every executor safety net.
    if (toolUseBlocks.length > 0) {
      for (const block of toolUseBlocks) {
        const consolidated: ToolCallResponsePart = {
          tool_calls: [{
            id: block.id,
            finished: false,
            function: { name: block.name, arguments: block.inputJson || '{}' },
          }],
        };
        yield consolidated;
      }
    }
  }
}
