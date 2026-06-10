// =============================================================================
//  src/ai/anthropic/index.ts — Public API for Anthropic provider
//
//  Standard: SNS IDE package index pattern
//  Consumers import from here — not from internal files directly.
//
//  Usage:
//    import { ClaudeProvider, ClaudeService } from '../ai/anthropic/index.js';
// =============================================================================

// Streaming provider (SNS IDE standard — use this for AgentExecutor)
export { ClaudeProvider, type ClaudeProviderConfig } from './anthropic-language-model.js';

// Legacy blocking service (backward compat only — do not use for new agents)
export { ClaudeService } from './claude-service.js';
