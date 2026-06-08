import { GoogleGenerativeAI, Content, Part } from '@google/generative-ai';
import { AIService, AICompletionResponse, ChatMessage } from './provider.js';
import { ToolDefinition } from '../tools/registry.js';

function convertType(t: string): string {
  if (!t) return 'STRING';
  const upper = t.toUpperCase();
  if (upper === 'OBJECT') return 'OBJECT';
  if (upper === 'ARRAY') return 'ARRAY';
  if (upper === 'NUMBER' || upper === 'FLOAT' || upper === 'DOUBLE') return 'NUMBER';
  if (upper === 'INTEGER' || upper === 'INT') return 'INTEGER';
  if (upper === 'BOOLEAN' || upper === 'BOOL') return 'BOOLEAN';
  return 'STRING';
}

function mapSchema(schema: any): any {
  if (!schema) return undefined;
  
  const properties: any = {};
  if (schema.properties) {
    for (const key of Object.keys(schema.properties)) {
      const prop = schema.properties[key];
      properties[key] = {
        type: convertType(prop.type),
        description: prop.description || '',
      };
      if (prop.type === 'object') {
        properties[key].properties = mapSchema(prop).properties;
        properties[key].required = prop.required;
      } else if (prop.type === 'array') {
        properties[key].items = {
          type: convertType(prop.items?.type)
        };
      }
    }
  }

  return {
    type: convertType(schema.type),
    properties,
    required: schema.required || [],
  };
}

export class GeminiService implements AIService {
  private genAI: GoogleGenerativeAI;
  private modelName: string;

  constructor(model: string, apiKey: string) {
    this.genAI = new GoogleGenerativeAI(apiKey);
    this.modelName = model;
  }

  async generateCompletion(
    prompt: string | ChatMessage[],
    systemPrompt?: string,
    tools?: ToolDefinition[]
  ): Promise<AICompletionResponse> {
    try {
      let finalSystemPrompt = systemPrompt;
      let contents: Content[] = [];

      if (typeof prompt === 'string') {
        contents.push({
          role: 'user',
          parts: [{ text: prompt }]
        });
      } else {
        // Extract system prompt if present in chat messages
        const systemMsg = prompt.find(m => m.role === 'system');
        if (systemMsg) {
          finalSystemPrompt = systemMsg.content;
        }

        // Group consecutive tool messages to prevent alternate role errors and support parallel tool calls in Gemini
        const nonSystemMsgs = prompt.filter(m => m.role !== 'system');
        const groupedMsgs: any[] = [];
        for (const m of nonSystemMsgs) {
          if (m.role === 'tool') {
            const last = groupedMsgs[groupedMsgs.length - 1];
            if (last && last.role === 'tool_group') {
              last.toolResults.push({
                name: m.name || '',
                content: m.content
              });
            } else {
              groupedMsgs.push({
                role: 'tool_group',
                toolResults: [{
                  name: m.name || '',
                  content: m.content
                }]
              });
            }
          } else {
            groupedMsgs.push(m);
          }
        }

        // Convert the rest of messages
        contents = groupedMsgs.map(m => {
          const role = m.role === 'assistant' ? 'model' : 'user';
          const parts: Part[] = [];

          if (m.content) {
            parts.push({ text: m.content });
          }

          if (m.role === 'assistant' && m.toolCalls) {
            m.toolCalls.forEach((tc: any) => {
              parts.push({
                functionCall: {
                  name: tc.function.name,
                  args: JSON.parse(tc.function.arguments || '{}')
                }
              });
            });
          }

          if (m.role === 'tool_group') {
            m.toolResults.forEach((tr: any) => {
              let responseObj: any = {};
              try {
                const parsed = JSON.parse(tr.content);
                if (Array.isArray(parsed)) {
                  responseObj = { result: parsed };
                } else if (parsed && typeof parsed === 'object') {
                  responseObj = parsed;
                } else {
                  responseObj = { result: parsed };
                }
              } catch {
                responseObj = { result: tr.content };
              }
              parts.push({
                functionResponse: {
                  name: tr.name || '',
                  response: responseObj
                }
              });
            });
          }

          return { role, parts };
        });
      }

      // Map tools to Gemini tools format
      const geminiTools = tools && tools.length > 0 ? [{
        functionDeclarations: tools.map(t => ({
          name: t.name,
          description: t.description,
          parameters: mapSchema(t.parameters)
        }))
      }] : undefined;

      const model = this.genAI.getGenerativeModel({
        model: this.modelName,
        systemInstruction: finalSystemPrompt || undefined,
        tools: geminiTools
      }, {
        apiVersion: 'v1beta' // systemInstruction and function calling work best in v1beta
      });

      const result = await model.generateContent({ contents });
      const response = await result.response;
      
      // Extract text content and function calls
      const text = response.text ? response.text() : '';
      const functionCalls = response.functionCalls ? response.functionCalls() : undefined;
      const toolCalls = functionCalls ? functionCalls.map((fc, idx) => ({
        id: `call_${fc.name}_${idx}_${Date.now()}`,
        type: 'function' as const,
        function: {
          name: fc.name,
          arguments: JSON.stringify(fc.args)
        }
      })) : undefined;

      const promptTokens = response.usageMetadata?.promptTokenCount ?? 0;
      const completionTokens = response.usageMetadata?.candidatesTokenCount ?? 0;

      return {
        text,
        toolCalls,
        usage: {
          promptTokens,
          completionTokens,
        },
      };
    } catch (err: any) {
      console.error('[Gemini Service Error]:', err);
      throw new Error(`Gemini API request failed: ${err.message}`);
    }
  }
}
