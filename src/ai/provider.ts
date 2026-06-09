import { ClaudeService } from './claude.js';
import { OpenAIService } from './openai.js';
import { GeminiService } from './gemini.js';
import { HuggingFaceService } from './huggingface.js';
import { ToolDefinition } from '../tools/registry.js';

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
      case 'grok':
        return new OpenAIService(model, apiKey, 'https://api.x.ai/v1');
      case 'groq':
        return new OpenAIService(model, apiKey, 'https://api.groq.com/openai/v1');
      case 'openrouter':
        return new OpenAIService(model, apiKey, 'https://openrouter.ai/api/v1');
      case 'huggingface':
        return new HuggingFaceService(model, apiKey);
      default:
        throw new Error(`Unsupported AI provider: ${provider}`);
    }
  }
}
