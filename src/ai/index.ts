// =============================================================================
//  src/ai/index.ts — Public API for the entire AI layer
//
//  Standard: SNS IDE package index pattern
//
//  This is the SINGLE entry point for all AI provider imports.
//  All code outside src/ai/ should import from here:
//
//    import { AIProviderFactory, ClaudeProvider, GeminiProvider } from '../ai/index.js';
//    import { buildMessages } from '../ai/index.js';
//
//  Internal files (e.g. planner-agent.ts) use this — not deep paths.
// =============================================================================

// ── Factory + Shared Interfaces ───────────────────────────────────────────────
export {
  AIProviderFactory,
  type AIService,
  type AICompletionResponse,
  type ChatMessage,
} from './provider.js';

// ── Message Utilities ─────────────────────────────────────────────────────────
export { buildMessages } from './message-builder.js';

// ── Google / Gemini ───────────────────────────────────────────────────────────
export {
  GeminiProvider,
  GeminiService,
  type GeminiProviderConfig,
} from './google/index.js';

// ── Anthropic / Claude ────────────────────────────────────────────────────────
export {
  ClaudeProvider,
  ClaudeService,
  type ClaudeProviderConfig,
} from './anthropic/index.js';

// ── OpenAI-Compatible (OpenAI, Grok, Groq, OpenRouter) ───────────────────────
export { OpenAIService } from './openai/index.js';

// ── HuggingFace ───────────────────────────────────────────────────────────────
export { HuggingFaceService } from './huggingface/index.js';

// ── Shared Provider Resolution ────────────────────────────────────────────────
export {
  resolveApiKey,
  resolveModelAlias,
  resolveStreamingProvider,
} from './resolve-provider.js';

