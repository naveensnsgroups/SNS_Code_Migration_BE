// =============================================================================
//  resolve-provider.ts — Shared Provider + API Key Resolution
//
//  SNS IDE standard: all agents use this single utility to resolve
//  a StreamingProvider from a session. No agent should contain its own
//  API key or provider resolution logic.
//
//  Usage:
//    const provider = await resolveStreamingProvider(sessionId, targetStack);
// =============================================================================

import { SessionManager }   from '../session/sessionManager.js';
import { AIProviderFactory } from './provider.js';
import { StreamingProvider } from '../types/language-model.js';
import { TargetStack }       from '../types.js';

// ── API Key Resolution ────────────────────────────────────────────────────────

/**
 * Resolves the API key for a given provider from three sources, in order:
 *   1. Session-level per-provider keys (apiKeys.{provider})
 *   2. Session-level master key (apiKey)
 *   3. Environment variables (ANTHROPIC_API_KEY, GEMINI_API_KEY, etc.)
 */
export function resolveApiKey(
  providerName: string,
  sessionApiKey:  string,
  sessionApiKeys: Record<string, string> | undefined
): string {
  const p = providerName.toLowerCase();

  // 1. Per-provider key from session
  if (sessionApiKeys) {
    const k = sessionApiKeys as any;
    if (p === 'anthropic'   && k.anthropic)   return k.anthropic;
    if (p === 'openai'      && k.openai)      return k.openai;
    if (p === 'google'      && k.google)      return k.google;
    if (p === 'grok'        && k.grok)        return k.grok;
    if (p === 'groq'        && k.groq)        return k.groq;
    if (p === 'openrouter'  && k.openrouter)  return k.openrouter;
    if (p === 'huggingface' && k.huggingface) return k.huggingface;
  }

  // 2. Session master key
  if (sessionApiKey) return sessionApiKey;

  // 3. Environment variables
  if (p === 'anthropic')   return process.env.ANTHROPIC_API_KEY  || '';
  if (p === 'openai')      return process.env.OPENAI_API_KEY     || '';
  if (p === 'google')      return process.env.GEMINI_API_KEY     || process.env.GOOGLE_API_KEY || '';
  if (p === 'grok')        return process.env.XAI_API_KEY        || '';
  if (p === 'groq')        return process.env.GROQ_API_KEY       || '';
  if (p === 'openrouter')  return process.env.OPENROUTER_API_KEY || '';
  if (p === 'huggingface') return process.env.HF_API_KEY         || process.env.HF_TOKEN || '';

  return '';
}

// ── Model Alias Resolution ────────────────────────────────────────────────────

/**
 * Resolves a model alias (e.g. "alias:reasoning-model") to a concrete model identifier.
 * If the alias is not in aliasesConfig, returns the raw model name unchanged.
 */
export function resolveModelAlias(
  modelName:    string,
  aliasesConfig: Record<string, string>
): string {
  if (!modelName) return '';
  if (modelName.startsWith('alias:')) {
    const key = modelName.replace('alias:', '').trim();
    return aliasesConfig[key] ?? modelName;
  }
  return aliasesConfig[modelName] ?? modelName;
}

// ── Full Provider Resolution ──────────────────────────────────────────────────

/**
 * Resolves a StreamingProvider from a session ID and target stack.
 * This is the single entry point all agents should use.
 *
 * Handles:
 *   - API key lookup (per-provider > master key > env vars)
 *   - Model alias resolution (aliasesConfig)
 *   - Google retry configuration (googleMaxRetries, googleRetryDelayRateLimit, etc.)
 *
 * @param sessionId   Active session
 * @param targetStack Provider + model from user configuration
 * @returns           { provider, resolvedModel } — both needed by AgentExecutor
 */
export async function resolveStreamingProvider(
  sessionId:   string,
  targetStack: TargetStack
): Promise<{ provider: StreamingProvider; resolvedModel: string }> {
  const session      = await SessionManager.getSession(sessionId);
  const s            = session as any;
  const aliasesConfig: Record<string, string> = s?.aliasesConfig ?? {};

  const resolvedModel = resolveModelAlias(targetStack.model, aliasesConfig);

  const apiKey = resolveApiKey(
    targetStack.provider,
    s?.apiKey ?? '',
    s?.apiKeys
  );

  const provider = AIProviderFactory.getStreamingProvider(
    targetStack.provider,
    resolvedModel,
    apiKey,
    {
      maxRetries:          s?.googleMaxRetries,
      retryDelayRateLimit: s?.googleRetryDelayRateLimit,
      retryDelayOther:     s?.googleRetryDelayOther,
    }
  );

  return { provider, resolvedModel };
}
