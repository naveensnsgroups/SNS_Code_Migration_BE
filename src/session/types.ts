

import { DetectedStack, FileNode, MigrationStatus, TargetStack, TokenUsage } from '../types.js';
import { ModelPricingConfig } from '../agents/compactor/agent-cost-estimator.js';
import { MigrationTaskEntry, RuleCoverageEntry } from '../agents/stage2/types.js';

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

  // Stage 2 — populated by MIGRATION_PLANNER_AGENT / CODE_GENERATOR_AGENT /
  // the verification loop. Absent entirely until a session reaches Stage 2.
  migrationTaskList?: MigrationTaskEntry[];
  ruleCoverageReport?: RuleCoverageEntry[];

  // HITL graph-review checkpoint data — captured when the pipeline halts after
  // graph-resolution (status 'awaiting-graph-review'). Read by the review UI.
  graphResolutionSummary?: GraphResolutionSummary;
}

// Real per-run graph-resolution result the human reviews at the checkpoint —
// all values come from what graph-resolution actually computed, never invented.
export interface GraphResolutionSummary {
  // Every TOTAL_* counter graph-resolution wrote to task context (callable units,
  // API endpoints, data entities, DB tables, business rules, events, etc.). Kept
  // as an open record so a newly-added counter flows through with no code change.
  counters: Record<string, number>;
  // True when the 3 primary graphs (symbol/entity/api) are all empty on disk —
  // continuing or skipping is pointless in that case, so the UI blocks both.
  primaryGraphsEmpty: boolean;
  generatedAt: string;
}

export interface LogEntry {
  id: string;
  timestamp: string;
  level: 'info' | 'success' | 'error' | 'warning' | 'command';
  message: string;
  phase?: string;
}
