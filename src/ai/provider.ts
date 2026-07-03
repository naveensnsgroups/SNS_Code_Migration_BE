

import { ClaudeService }    from './anthropic/claude-service.js';
import { ClaudeProvider, ClaudeProviderConfig } from './anthropic/anthropic-language-model.js';
import { GeminiService, GeminiProvider, GeminiProviderConfig } from './google/gemini-language-model.js';
import { MistralService, MistralProvider, MistralProviderConfig } from './mistral/mistral-language-model.js';
import { OpenAIService }    from './openai/openai-service.js';
import { HuggingFaceService } from './huggingface/huggingface-service.js';

import { ToolDefinition }   from '../tools/registry.js';
import { StreamingProvider } from '../types/language-model.js';

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

export class AIProviderFactory {

  
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

  
  static getStreamingProvider(
    provider: string,
    model: string,
    apiKey: string,
    config?: GeminiProviderConfig & ClaudeProviderConfig & MistralProviderConfig
  ): StreamingProvider {
    switch (provider.toLowerCase()) {

      
      case 'google':
        return new GeminiProvider(model, apiKey, config);

      
      
      
      case 'anthropic':
        return new ClaudeProvider(model, apiKey, config);

      
      
      
      case 'mistral':
        return new MistralProvider(model, apiKey, config);

      
      
      
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
