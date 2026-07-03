

import { SessionManager }   from '../session/sessionManager.js';
import { AIProviderFactory } from './provider.js';
import { StreamingProvider } from '../types/language-model.js';
import { TargetStack }       from '../types.js';

export function resolveApiKey(
  providerName: string,
  sessionApiKey:  string,
  sessionApiKeys: Record<string, string> | undefined
): string {
  const p = providerName.toLowerCase();

  
  if (sessionApiKeys) {
    const k = sessionApiKeys as any;
    if (p === 'anthropic'   && k.anthropic)   return k.anthropic;
    if (p === 'openai'      && k.openai)      return k.openai;
    if (p === 'google'      && k.google)      return k.google;
    if (p === 'mistral'     && k.mistral)     return k.mistral;
    if (p === 'grok'        && k.grok)        return k.grok;
    if (p === 'groq'        && k.groq)        return k.groq;
    if (p === 'openrouter'  && k.openrouter)  return k.openrouter;
    if (p === 'huggingface' && k.huggingface) return k.huggingface;
  }

  
  if (sessionApiKey) return sessionApiKey;

  
  if (p === 'anthropic')   return process.env.ANTHROPIC_API_KEY  || '';
  if (p === 'openai')      return process.env.OPENAI_API_KEY     || '';
  if (p === 'google')      return process.env.GEMINI_API_KEY     || process.env.GOOGLE_API_KEY || '';
  if (p === 'mistral')     return process.env.MISTRAL_API_KEY    || '';
  if (p === 'grok')        return process.env.XAI_API_KEY        || '';
  if (p === 'groq')        return process.env.GROQ_API_KEY       || '';
  if (p === 'openrouter')  return process.env.OPENROUTER_API_KEY || '';
  if (p === 'huggingface') return process.env.HF_API_KEY         || process.env.HF_TOKEN || '';

  return '';
}

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

  const isGoogle  = targetStack.provider === 'google';
  const isMistral = targetStack.provider === 'mistral';
  const isClaude  = targetStack.provider === 'anthropic';

  const provider = AIProviderFactory.getStreamingProvider(
    targetStack.provider,
    resolvedModel,
    apiKey,
    {
      
      maxRetries:          isGoogle  ? (s?.googleMaxRetries          ?? undefined) : isMistral ? (s?.mistralMaxRetries ?? undefined) : undefined,
      retryDelayRateLimit: isGoogle  ? (s?.googleRetryDelayRateLimit ?? undefined) : isMistral ? (s?.mistralRetryDelayRateLimit ?? undefined) : undefined,
      retryDelayOther:     isGoogle  ? (s?.googleRetryDelayOther     ?? undefined) : isMistral ? (s?.mistralRetryDelayOther ?? undefined) : undefined,
      
      retryDelayOnRateLimitError: isClaude ? (s?.claudeRetryDelayOnRateLimitError ?? undefined) : undefined,
      retryDelayOnOtherErrors:    isClaude ? (s?.claudeRetryDelayOnOtherErrors    ?? undefined) : undefined,
    }
  );

  return { provider, resolvedModel };
}
