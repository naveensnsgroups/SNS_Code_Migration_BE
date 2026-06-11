// =============================================================================
//  openai/openai-service.ts — OpenAI & OpenAI-Compatible Legacy AIService
//
//  SNS IDE folder structure:
//    src/ai/openai/
//      openai-service.ts    ← this file: legacy blocking AIService
//
//  Supports OpenAI-compatible APIs via custom baseURL:
//    - OpenAI:     (default endpoint)
//    - Grok:       https://api.x.ai/v1
//    - Groq:       https://api.groq.com/openai/v1
//    - OpenRouter: https://openrouter.ai/api/v1
//
//  TODO: Add openai-language-model.ts with chat.completions.stream()
//        to support streaming in AgentExecutor ReAct loop.
// =============================================================================

import OpenAI from 'openai';
import { AIService, AICompletionResponse, ChatMessage } from '../provider.js';
import { ToolDefinition } from '../../tools/registry.js';

export class OpenAIService implements AIService {
  private client: OpenAI;
  private model: string;

  constructor(model: string, apiKey: string, baseURL?: string) {
    this.client = new OpenAI({
      apiKey,
      baseURL: baseURL || undefined,
    });
    this.model = model;
  }

  async generateCompletion(
    prompt: string | ChatMessage[],
    systemPrompt?: string,
    tools?: ToolDefinition[]
  ): Promise<AICompletionResponse> {
    try {
      let messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];

      if (typeof prompt === 'string') {
        if (systemPrompt) {
          messages.push({ role: 'system', content: systemPrompt });
        }
        messages.push({ role: 'user', content: prompt });
      } else {
        messages = prompt.map(m => {
          if (m.role === 'system') {
            return { role: 'system', content: m.content };
          } else if (m.role === 'user') {
            return { role: 'user', content: m.content };
          } else if (m.role === 'assistant') {
            const assistantMsg: OpenAI.Chat.ChatCompletionAssistantMessageParam = {
              role: 'assistant',
              content: m.content || null
            };
            if (m.toolCalls) {
              assistantMsg.tool_calls = m.toolCalls.map(tc => ({
                id: tc.id,
                type: 'function',
                function: { name: tc.function.name, arguments: tc.function.arguments }
              }));
            }
            return assistantMsg;
          } else if (m.role === 'tool') {
            return { role: 'tool', content: m.content, tool_call_id: m.toolCallId || '' };
          }
          throw new Error(`Unsupported chat message role: ${m.role}`);
        });
      }

      const openAiTools = tools && tools.length > 0 ? tools.map(t => ({
        type: 'function' as const,
        function: { name: t.name, description: t.description, parameters: t.parameters }
      })) : undefined;

      const response = await this.client.chat.completions.create({
        model: this.model,
        messages,
        tools: openAiTools,
        temperature: 0.1,
      });

      const choiceMessage = response.choices[0]?.message;

      return {
        text: choiceMessage?.content || '',
        toolCalls: choiceMessage?.tool_calls ? choiceMessage.tool_calls.map(tc => ({
          id: tc.id,
          type: 'function' as const,
          function: { name: tc.function.name, arguments: tc.function.arguments }
        })) : undefined,
        usage: {
          promptTokens: response.usage?.prompt_tokens ?? 0,
          completionTokens: response.usage?.completion_tokens ?? 0,
          readCachedInputTokens: (response.usage as any)?.prompt_tokens_details?.cached_tokens ?? undefined,
        },
      };
    } catch (err: any) {
      console.error('[OpenAI Service Error]:', err);
      throw new Error(`OpenAI API request failed: ${err.message}`);
    }
  }
}
