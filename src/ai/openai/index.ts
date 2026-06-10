// =============================================================================
//  src/ai/openai/index.ts — Public API for OpenAI-compatible providers
//
//  Standard: SNS IDE package index pattern
//  Consumers import from here — not from internal files directly.
//
//  Covers: OpenAI, Grok (xAI), Groq, OpenRouter — all OpenAI-compatible APIs.
//
//  Usage:
//    import { OpenAIService } from '../ai/openai/index.js';
// =============================================================================

// Legacy blocking service (backward compat + OpenAI-compatible APIs)
export { OpenAIService } from './openai-service.js';

// TODO: Export OpenAIStreamingProvider once implemented
// export { OpenAIProvider, type OpenAIProviderConfig } from './openai-language-model.js';
