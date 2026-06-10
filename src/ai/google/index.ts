// =============================================================================
//  src/ai/google/index.ts — Public API for Google provider
//
//  Standard: SNS IDE package index pattern
//  Consumers import from here — not from internal files directly.
//
//  Usage:
//    import { GeminiProvider, GeminiService } from '../ai/google/index.js';
// =============================================================================

// Streaming provider (SNS IDE standard — use this for AgentExecutor)
export { GeminiProvider, type GeminiProviderConfig } from './gemini-language-model.js';

// Legacy blocking service (backward compat only — do not use for new agents)
export { GeminiService } from './gemini-language-model.js';
