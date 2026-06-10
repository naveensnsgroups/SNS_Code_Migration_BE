// ── Session Types for Express Backend ──────────────────────────────────────

import { DetectedStack, FileNode, MigrationStatus, TargetStack, TokenUsage } from '../types.js';

/**
 * Per-request token usage record — mirrors SNS IDE TokenUsageService.TokenUsage.
 * Stored as an array in session.json so the frontend can aggregate by model.
 */
export interface TokenUsageEntry {
  agentId: string;     // agent that made the request
  model: string;       // model identifier
  requestId: string;   // unique per LLM request turn
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  readCachedInputTokens?: number;
  timestamp: string;   // ISO string
}

export interface MigrationSession {
  sessionId: string;
  status: MigrationStatus;
  projectPath: string; // Path to the legacy files
  modernPath: string;  // Path to the modern files
  detectedStack?: DetectedStack;
  targetStack?: TargetStack;
  apiKey?: string;
  totalFiles: number;
  completedFiles: number;
  currentFile?: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  fileTree: FileNode[];
  phases: {
    id: string;
    label: string;
    status: 'pending' | 'active' | 'done' | 'error';
  }[];
  apiKeys?: {
    anthropic?: string;
    openai?: string;
    google?: string;
    grok?: string;
    groq?: string;
    openrouter?: string;
    huggingface?: string;
  };
  agentsConfig?: any;
  // AI Config panel state
  toolsConfig?: Record<string, boolean>;        // tool enablement map
  aliasesConfig?: Record<string, string>;        // alias → resolved model string
  promptFragments?: Record<string, string>;      // fragment id → custom prompt text
  googleMaxRetries?: number;
  googleRetryDelayRateLimit?: number;
  googleRetryDelayOther?: number;
  tokenUsage?: TokenUsage;                       // cumulative token counts for this session
  tokenUsageHistory?: TokenUsageEntry[];          // per-request history (SNS IDE TokenUsageService pattern)
}

export interface LogEntry {
  id: string;
  timestamp: string;
  level: 'info' | 'success' | 'error' | 'warning' | 'command';
  message: string;
  phase?: string;
}
