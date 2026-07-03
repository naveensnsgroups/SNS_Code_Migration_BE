

import Anthropic from '@anthropic-ai/sdk';
import { AIService, AICompletionResponse, ChatMessage } from '../provider.js';
import { ToolDefinition } from '../../tools/registry.js';

export class ClaudeService implements AIService {
  private client: Anthropic;
  private model: string;

  constructor(model: string, apiKey: string) {
    this.client = new Anthropic({ apiKey });
    this.model = model;
  }

  async generateCompletion(
    prompt: string | ChatMessage[],
    systemPrompt?: string,
    tools?: ToolDefinition[]
  ): Promise<AICompletionResponse> {
    try {
      let messages: Anthropic.MessageParam[] = [];
      let finalSystemPrompt = systemPrompt;

      if (typeof prompt === 'string') {
        messages.push({ role: 'user', content: prompt });
      } else {
        
        const systemMsg = prompt.find(m => m.role === 'system');
        if (systemMsg) {
          finalSystemPrompt = systemMsg.content;
        }

        
        
        const nonSystemMsgs = prompt.filter(m => m.role !== 'system');
        const groupedMsgs: any[] = [];
        for (const m of nonSystemMsgs) {
          if (m.role === 'tool') {
            const last = groupedMsgs[groupedMsgs.length - 1];
            if (last && last.role === 'tool_group') {
              last.toolResults.push({ toolCallId: m.toolCallId || '', content: m.content });
            } else {
              groupedMsgs.push({
                role: 'tool_group',
                toolResults: [{ toolCallId: m.toolCallId || '', content: m.content }]
              });
            }
          } else {
            groupedMsgs.push(m);
          }
        }

        messages = groupedMsgs.map(m => {
          if (m.role === 'user') {
            return { role: 'user', content: m.content };
          } else if (m.role === 'assistant') {
            const content: any[] = [];
            if (m.content) content.push({ type: 'text', text: m.content });
            if (m.toolCalls) {
              m.toolCalls.forEach((tc: any) => {
                content.push({
                  type: 'tool_use',
                  id: tc.id,
                  name: tc.function.name,
                  input: JSON.parse(tc.function.arguments)
                });
              });
            }
            return { role: 'assistant', content };
          } else if (m.role === 'tool_group') {
            return {
              role: 'user',
              content: m.toolResults.map((tr: any) => ({
                type: 'tool_result',
                tool_use_id: tr.toolCallId,
                content: [{ type: 'text', text: tr.content }]
              }))
            };
          }
          throw new Error(`Unsupported role in ClaudeService: ${m.role}`);
        });
      }

      const claudeTools = tools && tools.length > 0 ? tools.map(t => ({
        name: t.name,
        description: t.description,
        input_schema: {
          type: 'object' as const,
          properties: t.parameters.properties,
          required: t.parameters.required
        }
      })) : undefined;

      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 4000,
        system: finalSystemPrompt,
        messages,
        tools: claudeTools
      });

      let text = '';
      const toolCalls: any[] = [];

      if (response.content && response.content.length > 0) {
        response.content.forEach(block => {
          if (block.type === 'text') {
            text += block.text;
          } else if (block.type === 'tool_use') {
            toolCalls.push({
              id: block.id,
              type: 'function',
              function: {
                name: block.name,
                arguments: JSON.stringify(block.input)
              }
            });
          }
        });
      }

      return {
        text,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        usage: {
          promptTokens: response.usage?.input_tokens ?? 0,
          completionTokens: response.usage?.output_tokens ?? 0,
          cachedInputTokens: (response.usage as any)?.cache_creation_input_tokens ?? undefined,
          readCachedInputTokens: (response.usage as any)?.cache_read_input_tokens ?? undefined,
        },
      };
    } catch (err: any) {
      console.error('[Claude Service Error]:', err);
      throw new Error(`Claude API request failed: ${err.message}`);
    }
  }
}
