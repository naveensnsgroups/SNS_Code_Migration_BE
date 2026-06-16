// =============================================================================
//  gemini.ts — Google Gemini Provider (SNS IDE Standard)
//
//  Mirrors: snside/packages/ai-google/src/node/google-language-model.ts
//
//  Key changes from old implementation:
//  1. Uses generateContentStream (streaming, not generateContent)
//  2. systemInstruction extracted separately (not part of contents array)
//  3. Yields LanguageModelStreamPart (TextResponsePart | ToolCallResponsePart | UsageResponsePart)
//  4. Proper LanguageModelMessage → Gemini Content[] conversion
//  5. tool.handler called with (arg_string: string, ctx?) — raw JSON string
//  6. Tool results built as functionResponse parts, fed into next stream call
// =============================================================================

import {
  GoogleGenAI,
  FunctionCallingConfigMode,
  FunctionDeclaration,
  Content,
  Schema,
  Part,
  Modality,
} from '@google/genai';
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
} from '../../types/language-model.js';
import { ToolRequest, ToolContext } from '../../types/tool.js';
import { UserRequest } from '../../types/language-model.js';

// ── Message Conversion ────────────────────────────────────────────────────────
// Mirrors google-language-model.ts transformToGeminiMessages()

function convertMessageToPart(message: LanguageModelMessage): Part[] | undefined {
  if (LanguageModelMessage.isText(message) && message.text.length > 0) {
    return [{ text: message.text }];
  }
  if (LanguageModelMessage.isToolUse(message)) {
    return [{
      functionCall: {
        id: message.id,
        name: message.name,
        args: message.input as Record<string, unknown>,
      }
    }];
  }
  if (LanguageModelMessage.isToolResult(message)) {
    const response = toFunctionResponse(message.content);
    return [{ functionResponse: { name: message.name, response } }];
  }
  return undefined;
}

function toFunctionResponse(content: ToolCallResult): Record<string, unknown> {
  if (content === undefined) return {};
  if (Array.isArray(content)) return { result: content };
  if (typeof content === 'object' && 'content' in content) {
    // ToolCallContentWrapper — extract text
    const wrapper = content as { content: Array<{ type: string; text?: string; data?: string }> };
    const texts = wrapper.content.filter(c => c.type === 'text').map(c => c.text ?? '');
    return texts.length === 1 ? { result: texts[0] } : { result: texts.join('\n') };
  }
  if (typeof content === 'object') return content as Record<string, unknown>;
  return { result: content };
}

function transformToGeminiMessages(
  messages: readonly LanguageModelMessage[]
): { contents: Content[]; systemMessage?: string } {
  const systemMsgObj = messages.find(m => m.actor === 'system');
  const systemMessage =
    systemMsgObj && LanguageModelMessage.isText(systemMsgObj) ? systemMsgObj.text : undefined;

  const contents: Content[] = [];

  for (const message of messages) {
    if (message.actor === 'system') continue; // Extracted above
    const resultParts = convertMessageToPart(message);
    if (!resultParts) continue;

    const role: 'user' | 'model' = message.actor === 'ai' ? 'model' : 'user';
    const lastContent = contents[contents.length - 1];

    if (!lastContent) {
      contents.push({ role, parts: resultParts });
    } else if (lastContent.role !== role) {
      contents.push({ role, parts: resultParts });
    } else {
      // Merge with same-role last entry
      lastContent.parts = [...(lastContent.parts || []), ...resultParts];
    }
  }

  return { contents, systemMessage };
}

// ── Tool Result Preview ───────────────────────────────────────────────────────
// Formats a tool result into a short readable string for the terminal display.
// Mirrors SNS IDE's inline result preview in expandable tool call rows.
function formatResultPreview(result: ToolCallResult): string {
  if (result === null || result === undefined) return '';
  try {
    // ToolCallContentWrapper (has .content array)
    if (typeof result === 'object' && 'content' in result) {
      const wrapper = result as { content: Array<{ type: string; text?: string }> };
      const texts = wrapper.content.filter(c => c.type === 'text').map(c => c.text ?? '');
      const joined = texts.join('\n');
      return joined.slice(0, 400) + (joined.length > 400 ? '\n...' : '');
    }
    // Array result
    if (Array.isArray(result)) {
      const s = JSON.stringify(result, null, 2);
      return s.slice(0, 400) + (s.length > 400 ? '\n...' : '');
    }
    // Object result
    if (typeof result === 'object') {
      const s = JSON.stringify(result, null, 2);
      return s.slice(0, 400) + (s.length > 400 ? '\n...' : '');
    }
    return String(result).slice(0, 400);
  } catch {
    return '';
  }
}

// ── Gemini Provider ───────────────────────────────────────────────────────────

export interface GeminiProviderConfig {
  maxRetries?: number;
  retryDelayRateLimit?: number;
  retryDelayOther?: number;
}

function isRateLimitError(err: any): boolean {
  const errMsg = String(err?.message || err || '').toLowerCase();
  const status = err?.status || err?.statusCode || err?.status_code;

  // 429 = rate limit / quota exhausted
  if (status === 429) return true;

  // 503 = "Service Unavailable" / "high demand" — Gemini temporary overload.
  // Treat as retryable exactly like 429.
  if (status === 503) return true;

  return (
    errMsg.includes('429') ||
    errMsg.includes('503') ||
    errMsg.includes('resourceexhausted') ||
    errMsg.includes('resource_exhausted') ||
    errMsg.includes('quota') ||
    errMsg.includes('rate limit') ||
    errMsg.includes('high demand') ||           // Gemini 503 message text
    errMsg.includes('service unavailable') ||   // HTTP 503 standard text
    errMsg.includes('unavailable')              // gRPC UNAVAILABLE status
  );
}

export class GeminiProvider {
  private readonly modelName: string;
  private readonly apiKey: string;
  private readonly config?: GeminiProviderConfig;

  constructor(model: string, apiKey: string, config?: GeminiProviderConfig) {
    this.modelName = model;
    this.apiKey = apiKey;
    this.config = config;
  }

  private async withRetry<T>(
    fn: () => Promise<T>,
    toolCtx?: ToolContext
  ): Promise<T> {
    const maxRetries = this.config?.maxRetries ?? 3;
    const retryDelayRateLimit = this.config?.retryDelayRateLimit ?? 60; // seconds to wait on 429/503
    const retryDelayOther = this.config?.retryDelayOther ?? 30;         // seconds to wait on other transient errors (was -1 = no retry)

    let attempt = 0;
    while (true) {
      try {
        return await fn();
      } catch (err: any) {
        attempt++;
        if (attempt > maxRetries) {
          throw err;
        }

        const isRateLimit = isRateLimitError(err);
        let delaySeconds = 0;

        if (isRateLimit) {
          if (retryDelayRateLimit < 0) {
            throw err;
          }
          delaySeconds = retryDelayRateLimit;
        } else {
          if (retryDelayOther < 0) {
            throw err;
          }
          delaySeconds = retryDelayOther;
        }

        const errMsg = err instanceof Error ? err.message : String(err);
        const logMsg = `Gemini API call failed (${errMsg}). Retrying attempt ${attempt}/${maxRetries} in ${delaySeconds}s...`;

        if (toolCtx?.onLog) {
          toolCtx.onLog(logMsg, 'warning');
        } else {
          console.warn(logMsg);
        }

        await new Promise((resolve) => setTimeout(resolve, delaySeconds * 1000));
      }
    }
  }

  /**
   * Sends a streaming request to Gemini.
   * Mirrors SNS IDE GoogleModel.request() → handleStreamingRequest().
   *
   * Returns an async iterable of LanguageModelStreamPart.
   * Consumers iterate with `for await (const part of response.stream)`.
   */
  async request(
    userRequest: UserRequest,
    toolCtx?: ToolContext
  ): Promise<LanguageModelStreamResponse> {
    // NOTE: No timeout set — migration analysis can run for hours on large codebases.
    // The GoogleGenAI SDK default is no timeout (unlimited), which is correct here.
    const genAI = new GoogleGenAI({
      apiKey: this.apiKey,
    });
    return this.handleStreamingRequest(genAI, userRequest, toolCtx, []);
  }

  private async handleStreamingRequest(
    genAI: GoogleGenAI,
    userRequest: UserRequest,
    toolCtx: ToolContext | undefined,
    extraContents: Content[]
  ): Promise<LanguageModelStreamResponse> {
    const { contents, systemMessage } = transformToGeminiMessages(userRequest.messages);
    const tools = userRequest.tools ?? [];

    const functionDeclarations: FunctionDeclaration[] = tools.map(t => ({
      name: t.name,
      description: t.description,
      parameters: (t.parameters && Object.keys(t.parameters.properties || {}).length > 0)
        ? t.parameters as unknown as Schema
        : undefined,
    }));

    const allContents = [...contents, ...extraContents];

    const stream = await this.withRetry(
      () =>
        genAI.models.generateContentStream({
          model: this.modelName,
          config: {
            systemInstruction: systemMessage, // ← separate from contents
            responseModalities: [Modality.TEXT],
            ...(functionDeclarations.length > 0 && {
              toolConfig: {
                functionCallingConfig: { mode: FunctionCallingConfigMode.AUTO },
              },
              tools: [{ functionDeclarations }],
            }),
            temperature: 0.1,
          },
          contents: allContents,
        }),
      toolCtx
    );

    // Store refs for the recursive tool call
    const providerThis = this;

    const asyncIterator: LanguageModelStreamResponse = {
      stream: (async function* (): AsyncIterable<LanguageModelStreamPart> {
        // Map of callId → { name, argsJson } for all function calls in this turn
        const toolCallMap = new Map<string, { name: string; args: string; id: string }>();
        const collectedParts: Part[] = [];

        for await (const chunk of stream) {
          const parts = chunk.candidates?.[0]?.content?.parts;

          if (parts) {
            for (const part of parts) {
              collectedParts.push(part);
              if (part.text) {
                const textPart: TextResponsePart = { content: part.text };
                yield textPart;
              } else if (part.functionCall) {
                const fc = part.functionCall;
                const callId = fc.id ?? `call_${fc.name}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
                fc.id = callId;

                if (!toolCallMap.has(callId)) {
                  const argsStr = fc.args ? JSON.stringify(fc.args) : '{}';
                  toolCallMap.set(callId, { name: fc.name ?? '', args: argsStr, id: callId });

                  const toolCallPart: ToolCallResponsePart = {
                    tool_calls: [{
                      id: callId,
                      finished: false,
                      function: { name: fc.name ?? '', arguments: argsStr },
                    }]
                  };
                  yield toolCallPart;
                } else {
                  // Delta update
                  const existing = toolCallMap.get(callId)!;
                  existing.args = fc.args ? JSON.stringify(fc.args) : existing.args;
                  const deltaCallPart: ToolCallResponsePart = {
                    tool_calls: [{
                      id: callId,
                      function: { arguments: existing.args },
                      argumentsDelta: false,
                    }]
                  };
                  yield deltaCallPart;
                }
              }
            }
          } else if (chunk.text) {
            yield { content: chunk.text } as TextResponsePart;
          }

          // Yield token usage metadata
          if (chunk.usageMetadata) {
            const promptTokens = chunk.usageMetadata.promptTokenCount;
            const completionTokens = chunk.usageMetadata.candidatesTokenCount;
            if (promptTokens !== undefined && completionTokens !== undefined) {
              const usagePart: UsageResponsePart = {
                input_tokens: promptTokens,
                output_tokens: completionTokens,
              };
              yield usagePart;
            }
          }
        }

        // ── Process tool calls (recursive loop like SNS IDE) ──────────────
        if (toolCallMap.size > 0) {
          const toolResultList: Array<{ name: string; result: ToolCallResult; id: string; arguments: string }> = [];
          const finishedCalls: StreamToolCall[] = [];

          for (const [callId, tc] of toolCallMap) {
            const tool = tools.find(t => t.name === tc.name);
            let result: ToolCallResult;

            if (!tool) {
              result = makeToolErrorResult(
                `Tool '${tc.name}' not found in available tools.`,
                'tool-not-available'
              );
            } else {
              try {
                toolCtx?.onLog?.(`[Tool Call] ${tc.name}(${tc.args.slice(0, 80)}...)`, 'info');
                // ← SNS IDE standard: pass raw arg_string, NOT parsed object
                result = await tool.handler(tc.args, toolCtx ? { ...toolCtx, toolCallId: callId } : undefined);
                toolCtx?.onLog?.(`[Tool Response] ${tc.name} completed.`, 'success');
                // Emit the actual response data so the terminal can show it in the expanded row
                const resultPreview = formatResultPreview(result);
                if (resultPreview) {
                  toolCtx?.onLog?.(`[Tool Data] ${resultPreview}`, 'info');
                }
              } catch (e: unknown) {
                const msg = e instanceof Error ? e.message : 'Tool execution failed';
                toolCtx?.onLog?.(`[Tool Error] ${tc.name}: ${msg}`, 'error');
                result = makeToolErrorResult(msg);
              }
            }

            toolResultList.push({
              name: tc.name,
              result,
              id: callId,
              arguments: tc.args
            });

            finishedCalls.push({
              id: callId,
              finished: true,
              result,
              function: { name: tc.name, arguments: tc.args },
            });

            yield { tool_calls: finishedCalls } as ToolCallResponsePart;
          }

          // Format tool responses for Gemini
          // According to Gemini docs and SNS IDE implementation, functionResponse needs name and response
          const toolResponses: Part[] = toolResultList.map(call => ({
            functionResponse: {
              name: call.name,
              response: toFunctionResponse(call.result)
            }
          }));
          const responseMessage: Content = { role: 'user', parts: toolResponses };

          // Build the model's response content from collected parts
          const modelResponseParts = collectedParts.filter(p => !p.thought);
          const modelContent: Content = { role: 'model', parts: modelResponseParts };

          const recursiveContents = [...extraContents, modelContent, responseMessage];

          // Recursive: send tool results back to Gemini for next LLM turn
          const nextResponse = await providerThis.handleStreamingRequest(
            genAI,
            userRequest,
            toolCtx,
            recursiveContents
          );

          for await (const part of nextResponse.stream) {
            yield part;
          }
        }
      })(),
    };

    return asyncIterator;
  }
}

// ── Legacy Compatibility Shim ─────────────────────────────────────────────────
// Keeps existing calling patterns working while we migrate to full streaming.
// Will be removed once agentExecutor is fully ported to streaming.

import { AIService, AICompletionResponse } from '../provider.js';
import { ToolDefinition } from '../../tools/registry.js';

export class GeminiService implements AIService {
  private readonly provider: GeminiProvider;

  constructor(model: string, apiKey: string) {
    this.provider = new GeminiProvider(model, apiKey);
  }

  async generateCompletion(
    prompt: string | import('../provider.js').ChatMessage[],
    _systemPrompt?: string,
    tools?: ToolDefinition[]
  ): Promise<AICompletionResponse> {
    // Build LanguageModelMessage[] from legacy ChatMessage[] / string
    const { buildMessages } = await import('../message-builder.js');
    const messages = buildMessages(prompt, _systemPrompt);

    const toolRequests = (tools ?? []).map(t => ({
      id: (t as any).name,
      name: (t as any).name,
      description: (t as any).description,
      parameters: (t as any).parameters,
      handler: (t as any).handler as unknown as (arg_string: string) => Promise<import('../../types/language-model.js').ToolCallResult>,
      providerName: 'registry',
    }));

    const userRequest: UserRequest = {
      messages,
      tools: toolRequests,
      sessionId: 'legacy-shim',
      requestId: `req_${Date.now()}`,
    };

    const response = await this.provider.request(userRequest);

    // Consume the stream and collect text + tool calls for the legacy caller
    let text = '';
    const toolCalls: AICompletionResponse['toolCalls'] = [];
    let promptTokens = 0;
    let completionTokens = 0;

    for await (const part of response.stream) {
      if ('content' in part && typeof (part as { content?: unknown }).content === 'string') {
        text += (part as { content: string }).content;
      } else if ('input_tokens' in part) {
        promptTokens = (part as UsageResponsePart).input_tokens;
        completionTokens = (part as UsageResponsePart).output_tokens;
      } else if ('tool_calls' in part) {
        for (const tc of (part as ToolCallResponsePart).tool_calls) {
          if (tc.function?.name && !tc.finished && tc.id) {
            toolCalls.push({
              id: tc.id,
              type: 'function',
              function: {
                name: tc.function.name,
                arguments: tc.function.arguments ?? '{}',
              }
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
