

import { SessionManager }   from '../session/sessionManager.js';
import { AIProviderFactory } from './provider.js';
import { StreamingProvider } from '../types/language-model.js';
import { AgentDefinition }   from '../types/agent.js';

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

// A per-agent override or a resolved alias is a "provider/model" compound string
// (see constants/models.ts's getDefaultAliases and the AI Config "OVERRIDE MODEL"
// dropdown, which both save "anthropic/claude-opus-4-6"-style values). targetStack
// itself keeps provider and model as separate fields. Split whichever form we end
// up with into the two real parts, falling back to targetStack.provider when the
// spec has no "/" (a bare model name, e.g. targetStack.model itself).
function splitProviderModel(spec: string, fallbackProvider: string): { provider: string; model: string } {
  const slash = spec.indexOf('/');
  if (slash > 0) {
    return { provider: spec.slice(0, slash), model: spec.slice(slash + 1) };
  }
  return { provider: fallbackProvider, model: spec };
}

// Per-agent explicit override saved by the AI Config "OVERRIDE MODEL" dropdown —
// see AIConfigTab.tsx's handleUpdateModel. Empty/unset (the "Use alias default"
// option) means no override, not a real value.
function resolveAgentOverride(agentsConfig: unknown, agentId: string): string | undefined {
  if (!agentsConfig) return undefined;
  const entry = Array.isArray(agentsConfig)
    ? (agentsConfig as any[]).find(a => a?.id === agentId)
    : (agentsConfig as Record<string, any>)[agentId];
  const value = entry?.selectedModel;
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

export async function resolveStreamingProvider(
  sessionId:   string,
  // Only provider+model are actually read here — accepting this narrower shape
  // (which a full TargetStack satisfies structurally) lets callers with no real
  // TargetStack yet (e.g. the Scanner, which runs before Stage 2 target config
  // exists) pass their own fallback without fabricating unused fields.
  targetStack: { provider: string; model: string },
  // Optional — the agent actually making this call. When given, resolution
  // prefers (1) a per-agent override the user explicitly configured, then
  // (2) the agent's own declared languageModelRequirements alias, before
  // falling back to (3) the one global targetStack model — the only behavior
  // that existed before per-agent model selection was wired up. Omit this to
  // keep the old global-only behavior.
  agentDefinition?: AgentDefinition
): Promise<{ provider: StreamingProvider; resolvedModel: string }> {
  const session      = await SessionManager.getSession(sessionId);
  const s            = session as any;
  const aliasesConfig: Record<string, string> = s?.aliasesConfig ?? {};

  const perAgentOverride = agentDefinition
    ? resolveAgentOverride(s?.agentsConfig, agentDefinition.id)
    : undefined;

  const agentAlias = agentDefinition?.languageModelRequirements?.[0]?.identifier;
  const aliasResolved = agentAlias ? resolveModelAlias(agentAlias, aliasesConfig) : undefined;
  // resolveModelAlias returns the alias identifier UNCHANGED if aliasesConfig has
  // no mapping for it — that's not a real resolved value, so don't treat a literal
  // "alias:reasoning-model" string as if it were an actual provider/model spec.
  const aliasSpec = aliasResolved && !aliasResolved.startsWith('alias:') ? aliasResolved : undefined;

  const rawSpec = perAgentOverride || aliasSpec || targetStack.model;
  const { provider: resolvedProvider, model: rawModel } = splitProviderModel(rawSpec, targetStack.provider);
  const resolvedModel = resolveModelAlias(rawModel, aliasesConfig);

  const apiKey = resolveApiKey(
    resolvedProvider,
    s?.apiKey ?? '',
    s?.apiKeys
  );

  const isGoogle  = resolvedProvider === 'google';
  const isMistral = resolvedProvider === 'mistral';
  const isClaude  = resolvedProvider === 'anthropic';

  const provider = AIProviderFactory.getStreamingProvider(
    resolvedProvider,
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
