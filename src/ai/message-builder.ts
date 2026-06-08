// =============================================================================
//  message-builder.ts — Converts legacy ChatMessage[] to LanguageModelMessage[]
//
//  Used by the GeminiService shim to bridge the old provider interface
//  with the new SNS IDE standard message types.
//  Will be removed when all callers use UserRequest directly.
// =============================================================================

import { LanguageModelMessage, TextMessage, ToolUseMessage, ToolResultMessage } from '../types/language-model.js';
import { ChatMessage } from './provider.js';

export function buildMessages(
  prompt: string | ChatMessage[],
  systemPrompt?: string
): LanguageModelMessage[] {
  const messages: LanguageModelMessage[] = [];

  if (typeof prompt === 'string') {
    if (systemPrompt) {
      messages.push({ actor: 'system', type: 'text', text: systemPrompt } as TextMessage);
    }
    messages.push({ actor: 'user', type: 'text', text: prompt } as TextMessage);
    return messages;
  }

  for (const m of prompt) {
    if (m.role === 'system') {
      messages.push({ actor: 'system', type: 'text', text: m.content } as TextMessage);
    } else if (m.role === 'user') {
      messages.push({ actor: 'user', type: 'text', text: m.content } as TextMessage);
    } else if (m.role === 'assistant') {
      if (m.toolCalls && m.toolCalls.length > 0) {
        for (const tc of m.toolCalls) {
          let parsedArgs: unknown = {};
          try { parsedArgs = JSON.parse(tc.function?.arguments || '{}'); } catch { /* ignore */ }
          messages.push({
            actor: 'ai',
            type: 'tool_use',
            id: tc.id ?? `call_${Date.now()}`,
            name: tc.function?.name ?? '',
            input: parsedArgs,
          } as ToolUseMessage);
        }
      } else if (m.content) {
        messages.push({ actor: 'ai', type: 'text', text: m.content } as TextMessage);
      }
    } else if (m.role === 'tool') {
      messages.push({
        actor: 'user',
        type: 'tool_result',
        tool_use_id: m.toolCallId ?? '',
        name: m.name ?? '',
        content: m.content,
      } as ToolResultMessage);
    }
  }

  return messages;
}
