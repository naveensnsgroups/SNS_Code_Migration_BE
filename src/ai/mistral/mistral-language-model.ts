// =============================================================================
//  mistral-language-model.ts — Mistral AI Streaming Provider (SNS IDE Standard)
//
//  Mirrors: src/ai/anthropic/anthropic-language-model.ts and
//           src/ai/google/gemini-language-model.ts
//
//  Key implementation facts (verified from @mistralai/mistralai v2 SDK source):
//  1. SDK: `new Mistral({ apiKey })` — NOT new MistralClient()
//  2. Streaming: `client.chat.stream({ model, messages, tools, toolChoice })`
//  3. Each stream event: `event.data.choices[0].delta` (delta has .content + .toolCalls)
//  4. toolCalls field is camelCase — NOT tool_calls
//  5. Tool result message: { role:"tool", toolCallId, content, name } — toolCallId camelCase
//  6. FunctionCall.arguments: can be object OR string — handle both
//  7. Tool format: OpenAI-compatible { type:"function", function:{ name, description, parameters }}
//  8. Tool choice: "auto" | "any" | "none"
//  9. UsageInfo: event.data.usage (may be null until final chunk)
// =============================================================================

import { Mistral } from '@mistralai/mistralai';
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

// ── Config ─────────────────────────────────────────────────────────────────────

export interface MistralProviderConfig {
  maxRetries?: number;
  retryDelayRateLimit?: number;   // seconds to wait on 429 (default 60)
  retryDelayOther?: number;       // seconds to wait on other errors (default -1 = no retry)
  maxTokens?: number;             // default 8192
}

// ── Rate Limit Detection ────────────────────────────────────────────────────────

function isRateLimitError(err: any): boolean {
  const msg    = String(err?.message || err || '').toLowerCase();
  const status = err?.status || err?.statusCode || err?.status_code;
  if (status === 429) return true;
  return (
    msg.includes('429')               ||
    msg.includes('rate limit')        ||
    msg.includes('rate_limit')        ||
    msg.includes('quota')             ||
    msg.includes('resource_exhausted')||
    msg.includes('too many requests')
  );
}

// ── Message Conversion ──────────────────────────────────────────────────────────
//
// Converts our LanguageModelMessage[] → Mistral's message array format.
// Mistral uses OpenAI-compatible roles: system / user / assistant / tool
//
// Mapping:
//   TextMessage { actor:'system' }  → { role:'system',    content: str }
//   TextMessage { actor:'user'   }  → { role:'user',      content: str }
//   TextMessage { actor:'ai'     }  → { role:'assistant', content: str }
//   ToolUseMessage                  → { role:'assistant', toolCalls:[{ id, type, function }] }
//   ToolResultMessage               → { role:'tool',      toolCallId, content, name }
//
// Mistral SDK v2 field names are CAMELCASE (toolCalls, toolCallId — NOT snake_case).

type MistralMessage =
  | { role: 'system';    content: string }
  | { role: 'user';      content: string }
  | { role: 'assistant'; content: string; toolCalls?: MistralToolCall[] }
  | { role: 'tool';      toolCallId: string; name: string; content: string };

type MistralToolCall = {
  id:       string;
  type:     'function';
  function: { name: string; arguments: string };
};

type MistralTool = {
  type: 'function';
  function: {
    name:        string;
    description: string;
    // Mistral SDK v2 Zod schema requires parameters to be a record — never undefined.
    // Always provide at minimum { type:'object', properties:{} }
    parameters: {
      type:       'object';
      properties: Record<string, unknown>;
      required?:  string[];
    };
  };
};

function transformToMistralMessages(messages: readonly LanguageModelMessage[]): MistralMessage[] {
  const result: MistralMessage[] = [];

  for (const msg of messages) {
    if (msg.type === 'text') {
      if (msg.actor === 'system') {
        result.push({ role: 'system', content: msg.text });
      } else if (msg.actor === 'user') {
        result.push({ role: 'user', content: msg.text });
      } else if (msg.actor === 'ai') {
        result.push({ role: 'assistant', content: msg.text });
      }
    } else if (msg.type === 'tool_use') {
      // AI tool call — assistant message with toolCalls array (camelCase)
      let argsStr: string;
      if (typeof msg.input === 'string') {
        argsStr = msg.input;
      } else if (msg.input && typeof msg.input === 'object') {
        try { argsStr = JSON.stringify(msg.input); } catch { argsStr = '{}'; }
      } else {
        argsStr = '{}';
      }
      result.push({
        role: 'assistant',
        content: '',
        toolCalls: [{
          id:       msg.id,
          type:     'function',
          function: { name: msg.name, arguments: argsStr },
        }],
      });
    } else if (msg.type === 'tool_result') {
      // Tool result — role:"tool" with toolCallId (camelCase, confirmed from SDK source)
      const contentStr = extractToolResultText(msg.content);
      result.push({
        role:       'tool',
        toolCallId: msg.tool_use_id,
        name:       msg.name ?? '',
        content:    contentStr,
      });
    }
  }

  return result;
}

function extractToolResultText(result: ToolCallResult): string {
  if (result === null || result === undefined) return '';
  if (typeof result === 'string') return result;
  if (typeof result === 'object' && 'content' in result) {
    const wrapper = result as { content: Array<{ type: string; text?: string; data?: string }> };
    return wrapper.content.map(c => c.text || c.data || '').filter(Boolean).join('\n');
  }
  if (typeof result === 'object') {
    try { return JSON.stringify(result, null, 2); } catch { return String(result); }
  }
  return String(result);
}

// ── Tool Declaration Conversion ─────────────────────────────────────────────────

function buildMistralTools(tools: ToolRequest[]): MistralTool[] {
  return tools.map(t => ({
    type: 'function' as const,
    function: {
      name:        t.name,
      description: t.description,
      // Mistral SDK v2 Zod validation requires parameters to always be a record.
      // Always include it — use empty properties object for parameter-less tools.
      parameters: {
        type:       'object' as const,
        properties: t.parameters?.properties ?? {},
        ...(t.parameters?.required && t.parameters.required.length > 0
          ? { required: t.parameters.required }
          : {}),
      },
    },
  }));
}

// ── Mistral Streaming Provider ──────────────────────────────────────────────────

export class MistralProvider implements StreamingProvider {
  private readonly client: Mistral;
  private readonly modelName: string;
  private readonly config: Required<MistralProviderConfig>;

  constructor(model: string, apiKey: string, config?: MistralProviderConfig) {
    this.modelName = model;
    this.client    = new Mistral({ apiKey });
    this.config = {
      maxRetries:          config?.maxRetries          ?? 3,
      retryDelayRateLimit: config?.retryDelayRateLimit ?? 60,
      retryDelayOther:     config?.retryDelayOther     ?? -1,
      maxTokens:           config?.maxTokens           ?? 8192,
    };
  }

  private async withRetry<T>(fn: () => Promise<T>, toolCtx?: ToolContext): Promise<T> {
    const { maxRetries, retryDelayRateLimit, retryDelayOther } = this.config;
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
          if (retryDelayRateLimit < 0) throw err;
          delaySeconds = retryDelayRateLimit;
        } else {
          if (retryDelayOther < 0) throw err;
          delaySeconds = retryDelayOther;
        }

        const msg    = err instanceof Error ? err.message : String(err);
        const logMsg = `Mistral API call failed (${msg}). Retrying attempt ${attempt}/${maxRetries} in ${delaySeconds}s...`;
        if (toolCtx?.onLog) { toolCtx.onLog(logMsg, 'warning'); }
        else                 { console.warn(logMsg); }

        await new Promise<void>(res => setTimeout(res, delaySeconds * 1000));
      }
    }
  }

  /**
   * Sends a streaming request to Mistral.
   * Returns a LanguageModelStreamResponse with async iterable stream.
   * Each streamed part is: TextResponsePart | ToolCallResponsePart | UsageResponsePart.
   */
  async request(userRequest: UserRequest, toolCtx?: ToolContext): Promise<LanguageModelStreamResponse> {
    const mistralMessages = transformToMistralMessages(userRequest.messages);
    const tools           = userRequest.tools ?? [];
    const mistralTools    = tools.length > 0 ? buildMistralTools(tools) : undefined;
    const provider        = this;

    const asyncIterator: LanguageModelStreamResponse = {
      stream: (async function* (): AsyncIterable<LanguageModelStreamPart> {
        yield* provider.streamOneTurn(
          mistralMessages,
          mistralTools,
          tools,
          userRequest,
          toolCtx
        );
      })(),
    };

    return asyncIterator;
  }

  /**
   * Runs a single Mistral streaming turn.
   * Processes delta chunks: text → TextResponsePart, toolCalls → ToolCallResponsePart.
   * If tool calls are returned, executes them and recursively continues the conversation.
   */
  private async *streamOneTurn(
    messages:      MistralMessage[],
    mistralTools:  MistralTool[] | undefined,
    toolRequests:  ToolRequest[],
    userRequest:   UserRequest,
    toolCtx:       ToolContext | undefined
  ): AsyncIterable<LanguageModelStreamPart> {

    // Open the streaming request (with retry on transient errors)
    const stream = await this.withRetry(
      () => this.client.chat.stream({
        model:      this.modelName,
        messages:   messages as any,           // cast: our MistralMessage[] is structurally correct
        tools:      mistralTools as any,
        toolChoice: mistralTools ? 'auto' : undefined,
        maxTokens:  this.config.maxTokens,
        temperature: 0.1,
      } as any),
      toolCtx
    );

    // Accumulate tool call argument buffers across delta chunks
    // Map: toolCallId → { name, argsBuffer }
    const toolCallMap = new Map<string, { name: string; args: string; id: string }>();
    let accumulatedText = '';

    // ── Process each SSE event ────────────────────────────────────────────────
    // SDK v2 event shape (confirmed from source): CompletionEvent = { data: CompletionChunk }
    // CompletionChunk.choices[0].delta is DeltaMessage:
    //   { content?: string | null; toolCalls?: ToolCall[] | null }
    // IMPORTANT: field is `toolCalls` (camelCase) — NOT `tool_calls`

    for await (const event of stream) {
      const chunk  = event.data;
      const choice = chunk?.choices?.[0];
      const delta  = choice?.delta as any;  // DeltaMessage — typed as any to avoid SDK version drift

      if (delta) {
        // ── Text chunk ─────────────────────────────────────────────────────────
        if (typeof delta.content === 'string' && delta.content.length > 0) {
          accumulatedText += delta.content;
          const textPart: TextResponsePart = { content: delta.content };
          yield textPart;
        }

        // ── Tool call chunk ────────────────────────────────────────────────────
        // delta.toolCalls is camelCase (confirmed from deltamessage.ts SDK source)
        const toolCallDeltas = delta.toolCalls ?? delta.tool_calls; // fallback for safety
        if (Array.isArray(toolCallDeltas) && toolCallDeltas.length > 0) {
          for (const tc of toolCallDeltas) {
            const tcId = tc.id ?? `call_${tc.function?.name}_${Date.now()}`;

            // Normalize arguments: FunctionCall.arguments can be object OR string
            let argsStr: string;
            if (typeof tc.function?.arguments === 'string') {
              argsStr = tc.function.arguments;
            } else if (tc.function?.arguments && typeof tc.function.arguments === 'object') {
              try { argsStr = JSON.stringify(tc.function.arguments); } catch { argsStr = '{}'; }
            } else {
              argsStr = '';
            }

            if (!toolCallMap.has(tcId)) {
              // First chunk for this tool call — announce it
              toolCallMap.set(tcId, { name: tc.function?.name ?? '', args: argsStr, id: tcId });
              const toolCallPart: ToolCallResponsePart = {
                tool_calls: [{
                  id:       tcId,
                  finished: false,
                  function: { name: tc.function?.name ?? '', arguments: argsStr },
                }],
              };
              yield toolCallPart;
            } else {
              // Subsequent chunk — accumulate args
              const existing = toolCallMap.get(tcId)!;
              existing.args += argsStr;
              if (argsStr.length > 0) {
                const deltaCallPart: ToolCallResponsePart = {
                  tool_calls: [{
                    id:            tcId,
                    function:      { arguments: argsStr },
                    argumentsDelta: true,
                  }],
                };
                yield deltaCallPart;
              }
            }
          }
        }
      }

      // ── Usage chunk ───────────────────────────────────────────────────────────
      // event.data.usage — present in the final chunk (may be null on intermediate chunks)
      const usage = chunk?.usage as any;
      if (usage && (usage.promptTokens !== undefined || usage.prompt_tokens !== undefined)) {
        const usagePart: UsageResponsePart = {
          input_tokens:  usage.promptTokens    ?? usage.prompt_tokens    ?? 0,
          output_tokens: usage.completionTokens ?? usage.completion_tokens ?? 0,
        };
        yield usagePart;
      }
    }

    // ── Execute tool calls and recurse ────────────────────────────────────────
    if (toolCallMap.size > 0) {
      const finishedCalls: StreamToolCall[] = [];
      const toolResultMessages: MistralMessage[] = [];

      // Build assistant message with all tool calls (for conversation history)
      const assistantMsg: MistralMessage = {
        role:    'assistant',
        content: accumulatedText,
        toolCalls: Array.from(toolCallMap.values()).map(tc => ({
          id:       tc.id,
          type:     'function' as const,
          function: { name: tc.name, arguments: tc.args },
        })),
      };

      // Execute all tool calls in parallel
      await Promise.all(
        Array.from(toolCallMap.values()).map(async (tc) => {
          const tool = toolRequests.find(t => t.name === tc.name);
          let result: ToolCallResult;

          if (!tool) {
            result = makeToolErrorResult(
              `Tool '${tc.name}' not found in available tools.`,
              'tool-not-available'
            );
          } else {
            try {
              toolCtx?.onLog?.(`[Tool Call] ${tc.name}(${tc.args.slice(0, 80)}...)`, 'info');
              result = await tool.handler(tc.args || '{}', toolCtx ? { ...toolCtx, toolCallId: tc.id } : undefined);
              toolCtx?.onLog?.(`[Tool Response] ${tc.name} completed.`, 'success');
            } catch (e: unknown) {
              const msg = e instanceof Error ? e.message : 'Tool execution failed';
              toolCtx?.onLog?.(`[Tool Error] ${tc.name}: ${msg}`, 'error');
              result = makeToolErrorResult(msg);
            }
          }

          const resultText = extractToolResultText(result);

          // Tool result message: toolCallId is camelCase (confirmed from toolmessage.ts SDK source)
          toolResultMessages.push({
            role:       'tool',
            toolCallId: tc.id,
            name:       tc.name,
            content:    resultText,
          });

          finishedCalls.push({
            id:       tc.id,
            finished: true,
            result,
            function: { name: tc.name, arguments: tc.args },
          });
        })
      );

      // Yield all finished tool call parts
      yield { tool_calls: finishedCalls } as ToolCallResponsePart;

      // Build continuation messages and recurse
      const continuationMessages: MistralMessage[] = [
        ...messages,
        assistantMsg,
        ...toolResultMessages,
      ];

      yield* this.streamOneTurn(
        continuationMessages,
        mistralTools,
        toolRequests,
        userRequest,
        toolCtx
      );
    }
  }
}

// ── Legacy Compatibility Shim ─────────────────────────────────────────────────
// Mirrors GeminiService / ClaudeService pattern.
// Allows legacy code that uses AIService.generateCompletion() to call Mistral.

import { AIService, AICompletionResponse, ChatMessage } from '../provider.js';
import { ToolDefinition } from '../../tools/registry.js';

export class MistralService implements AIService {
  private readonly provider: MistralProvider;

  constructor(model: string, apiKey: string, config?: MistralProviderConfig) {
    this.provider = new MistralProvider(model, apiKey, config);
  }

  async generateCompletion(
    prompt: string | ChatMessage[],
    systemPrompt?: string,
    tools?: ToolDefinition[]
  ): Promise<AICompletionResponse> {
    const { buildMessages } = await import('../message-builder.js');
    const messages = buildMessages(prompt, systemPrompt);

    const toolRequests = (tools ?? []).map(t => ({
      id:          (t as any).name,
      name:        (t as any).name,
      description: (t as any).description,
      parameters:  (t as any).parameters,
      handler:     (t as any).handler as (arg_string: string) => Promise<ToolCallResult>,
      providerName: 'registry',
    }));

    const userRequest: UserRequest = {
      messages,
      tools:     toolRequests,
      sessionId: 'legacy-shim',
      requestId: `req_${Date.now()}`,
    };

    const response = await this.provider.request(userRequest);

    let text = '';
    const toolCalls: AICompletionResponse['toolCalls'] = [];
    let promptTokens = 0;
    let completionTokens = 0;

    for await (const part of response.stream) {
      if ('content' in part && typeof (part as any).content === 'string') {
        text += (part as any).content;
      } else if ('input_tokens' in part) {
        promptTokens    = (part as UsageResponsePart).input_tokens;
        completionTokens = (part as UsageResponsePart).output_tokens;
      } else if ('tool_calls' in part) {
        for (const tc of (part as ToolCallResponsePart).tool_calls) {
          if (tc.function?.name && !tc.finished && tc.id) {
            toolCalls.push({
              id:   tc.id,
              type: 'function',
              function: {
                name:      tc.function.name,
                arguments: tc.function.arguments ?? '{}',
              },
            });
          }
        }
      }
    }

    return {
      text,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: { promptTokens, completionTokens },
    };
  }
}
