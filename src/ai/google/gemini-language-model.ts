

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
  ToolCallResult,
} from '../../types/language-model.js';
import { ToolRequest, ToolContext } from '../../types/tool.js';
import { UserRequest } from '../../types/language-model.js';

function convertMessageToPart(message: LanguageModelMessage): Part[] | undefined {
  if (LanguageModelMessage.isText(message) && message.text.length > 0) {
    return [{ text: message.text }];
  }
  if (LanguageModelMessage.isToolUse(message)) {
    const part: Part = {
      functionCall: {
        id: message.id,
        name: message.name,
        args: message.input as Record<string, unknown>,
      }
    };
    // Gemini requires the original thoughtSignature to be echoed back on the
    // functionCall part in history, or it rejects the request (400).
    const sig = message.providerMetadata?.thoughtSignature;
    if (typeof sig === 'string' && sig.length > 0) {
      (part as { thoughtSignature?: string }).thoughtSignature = sig;
    }
    return [part];
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
    if (message.actor === 'system') continue; 
    const resultParts = convertMessageToPart(message);
    if (!resultParts) continue;

    const role: 'user' | 'model' = message.actor === 'ai' ? 'model' : 'user';
    const lastContent = contents[contents.length - 1];

    if (!lastContent) {
      contents.push({ role, parts: resultParts });
    } else if (lastContent.role !== role) {
      contents.push({ role, parts: resultParts });
    } else {
      
      lastContent.parts = [...(lastContent.parts || []), ...resultParts];
    }
  }

  return { contents, systemMessage };
}

export interface GeminiProviderConfig {
  maxRetries?: number;
  retryDelayRateLimit?: number;
  retryDelayOther?: number;
}

function isRateLimitError(err: any): boolean {
  const errMsg = String(err?.message || err || '').toLowerCase();
  const status = err?.status || err?.statusCode || err?.status_code;

  
  if (status === 429) return true;

  
  
  if (status === 503) return true;

  return (
    errMsg.includes('429') ||
    errMsg.includes('503') ||
    errMsg.includes('resourceexhausted') ||
    errMsg.includes('resource_exhausted') ||
    errMsg.includes('quota') ||
    errMsg.includes('rate limit') ||
    errMsg.includes('high demand') ||           
    errMsg.includes('service unavailable') ||   
    errMsg.includes('unavailable')              
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
    const retryDelayRateLimit = this.config?.retryDelayRateLimit ?? 60; 
    const retryDelayOther = this.config?.retryDelayOther ?? 30;         

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

  
  async request(
    userRequest: UserRequest,
    toolCtx?: ToolContext
  ): Promise<LanguageModelStreamResponse> {
    
    
    const genAI = new GoogleGenAI({
      apiKey: this.apiKey,
    });
    return this.handleStreamingRequest(genAI, userRequest, toolCtx);
  }

  private async handleStreamingRequest(
    genAI: GoogleGenAI,
    userRequest: UserRequest,
    toolCtx: ToolContext | undefined
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

    const stream = await this.withRetry(
      () =>
        genAI.models.generateContentStream({
          model: this.modelName,
          config: {
            systemInstruction: systemMessage,
            responseModalities: [Modality.TEXT],
            ...(functionDeclarations.length > 0 && {
              toolConfig: {
                functionCallingConfig: { mode: FunctionCallingConfigMode.AUTO },
              },
              tools: [{ functionDeclarations }],
            }),
            temperature: 0.1,
          },
          contents,
        }),
      toolCtx
    );

    const asyncIterator: LanguageModelStreamResponse = {
      stream: (async function* (): AsyncIterable<LanguageModelStreamPart> {
        
        const toolCallMap = new Map<string, { name: string; args: string; id: string; thoughtSignature?: string }>();

        for await (const chunk of stream) {
          const parts = chunk.candidates?.[0]?.content?.parts;

          if (parts) {
            for (const part of parts) {
              if (part.text) {
                const textPart: TextResponsePart = { content: part.text };
                yield textPart;
              } else if (part.functionCall) {
                const fc = part.functionCall;
                const callId = fc.id ?? `call_${fc.name}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
                fc.id = callId;
                // Gemini attaches a thoughtSignature to the Part carrying the
                // functionCall; it MUST be echoed back on the next turn or the
                // API rejects the request. Capture it to round-trip.
                const thoughtSignature = (part as { thoughtSignature?: string }).thoughtSignature;

                if (!toolCallMap.has(callId)) {
                  const argsStr = fc.args ? JSON.stringify(fc.args) : '{}';
                  toolCallMap.set(callId, { name: fc.name ?? '', args: argsStr, id: callId, thoughtSignature });

                  const toolCallPart: ToolCallResponsePart = {
                    tool_calls: [{
                      id: callId,
                      finished: false,
                      function: { name: fc.name ?? '', arguments: argsStr },
                    }]
                  };
                  yield toolCallPart;
                } else {
                  
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

        // Single-turn contract: emit each tool call with its COMPLETE accumulated
        // arguments (finished:false, no result) and STOP. The AgentExecutor owns
        // the loop — it executes tools, runs loop/stuck/duplicate detection, appends
        // results, and re-invokes request(). Providers must NOT execute or recurse.
        if (toolCallMap.size > 0) {
          for (const [callId, tc] of toolCallMap) {
            const consolidated: ToolCallResponsePart = {
              tool_calls: [{
                id: callId,
                finished: false,
                function: { name: tc.name, arguments: tc.args || '{}' },
                providerMetadata: tc.thoughtSignature ? { thoughtSignature: tc.thoughtSignature } : undefined,
              }],
            };
            yield consolidated;
          }
        }
      })(),
    };

    return asyncIterator;
  }
}

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
