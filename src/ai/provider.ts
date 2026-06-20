// =============================================================================
//  provider.ts — AI Provider Factory
// =============================================================================

// ── Sub-folder imports (SNS IDE structure) ────────────────────────────────────
import { ClaudeService }    from './anthropic/claude-service.js';
import { ClaudeProvider, ClaudeProviderConfig } from './anthropic/anthropic-language-model.js';
import { GeminiService, GeminiProvider, GeminiProviderConfig } from './google/gemini-language-model.js';
import { MistralService, MistralProvider, MistralProviderConfig } from './mistral/mistral-language-model.js';
import { OpenAIService }    from './openai/openai-service.js';
import { HuggingFaceService } from './huggingface/huggingface-service.js';

import { ToolDefinition }   from '../tools/registry.js';
import { StreamingProvider } from '../types/language-model.js';

// ── Shared Interfaces ─────────────────────────────────────────────────────────
// Re-exported so downstream modules can import from 'provider.js' directly.

export interface AICompletionResponse {
  text: string;
  toolCalls?: {
    id: string;
    type: 'function';
    function: {
      name: string;
      arguments: string;
    };
  }[];
  usage?: {
    promptTokens: number;
    completionTokens: number;
    cachedInputTokens?: number;
    readCachedInputTokens?: number;
  };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;
  toolCallId?: string;
  toolCalls?: any[];
}

export interface AIService {
  generateCompletion(
    prompt: string | ChatMessage[],
    systemPrompt?: string,
    tools?: ToolDefinition[]
  ): Promise<AICompletionResponse>;
}

// ── Provider Factory ──────────────────────────────────────────────────────────

export class AIProviderFactory {

  /**
   * Returns a legacy (blocking, non-streaming) AIService.
   * Used only by legacy code paths — prefer getStreamingProvider() for new agent code.
   */
  static getService(
    provider: string,
    model: string,
    apiKey: string
  ): AIService {
    switch (provider.toLowerCase()) {
      case 'anthropic':
        return new ClaudeService(model, apiKey);
      case 'openai':
        return new OpenAIService(model, apiKey);
      case 'google':
        return new GeminiService(model, apiKey);
      case 'mistral':
        return new MistralService(model, apiKey);
      case 'grok':
        return new OpenAIService(model, apiKey, 'https://api.x.ai/v1');
      case 'groq':
        return new OpenAIService(model, apiKey, 'https://api.groq.com/openai/v1');
      case 'openrouter':
        return new OpenAIService(model, apiKey, 'https://openrouter.ai/api/v1');
      case 'huggingface':
        return new HuggingFaceService(model, apiKey);
      default:
        throw new Error(`Unsupported AI provider: "${provider}"`);
    }
  }

  /**
   * Returns a StreamingProvider — the SNS IDE standard for agent execution.
   * Used by AgentExecutor and PlannerAgent for all migration sessions.
   *
   * Providers:
   *   google    → GeminiProvider    (src/ai/google/gemini-language-model.ts)
   *   anthropic → ClaudeProvider    (src/ai/anthropic/anthropic-language-model.ts)
   *   openai    → (TODO: OpenAIProvider — not yet implemented)
   */
  static getStreamingProvider(
    provider: string,
    model: string,
    apiKey: string,
    config?: GeminiProviderConfig & ClaudeProviderConfig & MistralProviderConfig
  ): StreamingProvider {
    switch (provider.toLowerCase()) {

      // ── Google / Gemini ───────────────────────────────────────────────────
      case 'google':
        return new GeminiProvider(model, apiKey, config);

      // ── Anthropic / Claude ────────────────────────────────────────────────
      // Uses messages.stream() (true streaming) — NOT messages.create() (blocking)
      // No timeout — migration sessions can run for hours on large codebases.
      case 'anthropic':
        return new ClaudeProvider(model, apiKey, config);

      // ── Mistral AI ────────────────────────────────────────────────────────
      // Uses client.chat.stream() with OpenAI-compatible tool calling.
      // Models: mistral-large-latest, mistral-small-latest, codestral-latest
      case 'mistral':
        return new MistralProvider(model, apiKey, config);

      // ── OpenAI-compatible ─────────────────────────────────────────────────
      // All use same OpenAI-compatible streaming API, different baseURLs.
      // TODO: Implement OpenAIProvider in src/ai/openai/openai-provider.ts
      case 'openai':
      case 'grok':
      case 'groq':
      case 'openrouter':
        throw new Error(
          `Streaming provider "${provider}" (OpenAI-compatible) is not yet implemented. ` +
          `Add OpenAIProvider to src/ai/openai/openai-provider.ts and register it here.`
        );

      case 'huggingface':
        throw new Error(`HuggingFace streaming provider not yet implemented.`);

      default:
        throw new Error(
          `Unsupported streaming provider: "${provider}". ` +
          `Available: google, anthropic, mistral. Coming soon: openai, grok, groq, openrouter.`
        );
    }
  }
}
