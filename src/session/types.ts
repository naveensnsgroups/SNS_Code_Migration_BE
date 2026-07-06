

import { DetectedStack, FileNode, MigrationStatus, TargetStack, TokenUsage } from '../types.js';
import { ModelPricingConfig } from '../agents/compactor/agent-cost-estimator.js';

export interface TokenUsageEntry {
  agentId: string;     
  model: string;       
  requestId: string;   
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  readCachedInputTokens?: number;
  timestamp: string;   
}

export interface MigrationSession {
  sessionId: string;
  status: MigrationStatus;
  projectPath: string; 
  modernPath: string;  
  detectedStack?: DetectedStack;
  targetStack?: TargetStack;
  apiKey?: string;
  totalFiles: number;
  rawFileCount?: number;
  completedFiles: number;
  progress?: number;       
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
    mistral?: string;
    huggingface?: string;
  };
  agentsConfig?: any;
  
  toolsConfig?: Record<string, boolean>;
  aliasesConfig?: Record<string, string>;
  promptFragments?: Record<string, string>;
  /** User-supplied per-model $/1M-token rates — see agent-cost-estimator.ts for why
   *  this is never a hardcoded table. Absent/unconfigured models price as null. */
  modelPricing?: ModelPricingConfig;
  googleMaxRetries?: number;
  googleRetryDelayRateLimit?: number;
  googleRetryDelayOther?: number;
  mistralMaxRetries?: number;
  mistralRetryDelayRateLimit?: number;
  mistralRetryDelayOther?: number;
  tokenUsage?: TokenUsage;                       
  tokenUsageHistory?: TokenUsageEntry[];          
}

export interface LogEntry {
  id: string;
  timestamp: string;
  level: 'info' | 'success' | 'error' | 'warning' | 'command';
  message: string;
  phase?: string;
}
