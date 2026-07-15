

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

  // 4th Stage-2 sub-stage — the one real, whole-project check (sandboxed via
  // E2B when configured): does the ENTIRE generated project actually boot/
  // compile as one piece, not just each file individually. Absent until that
  // stage has run at least once for this session.
  fullProjectCheckResult?: FullProjectCheckResult;

  // HITL graph-review checkpoint data — captured when the pipeline halts after
  // graph-resolution (status 'awaiting-graph-review'). Read by the review UI.
  graphResolutionSummary?: GraphResolutionSummary;

  // Non-blocking sanity warning about the Migration Plan the human is about
  // to review (see graph-resolver.ts's checkImportsGraphSanity) — e.g. real
  // files silently missing from imports-graph. Never auto-blocks Code
  // Generation (this check can be wrong for a genuinely tiny project) — it's
  // surfaced in the same review panel so the human can decide, instead of
  // discovering it themselves the way this exact bug was first found.
  planSanityWarning?: string;

  // Free-text issues a human reported directly from a checkpoint panel,
  // each investigated by DIAGNOSTIC_AGENT (read-only — diagnoses, never
  // fixes) once submitted. See routes/migrate/diagnostic-routes.ts.
  reportedIssues?: {
    text:        string;
    stage:       string;
    reportedAt:  string;
    diagnosis?: { rootCause: string; evidence: string; suggestedAction: string };
  }[];
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

// Result of the full-project verification stage — "ran" and "sandboxAvailable"
// are surfaced separately from "errors" so the UI can honestly distinguish
// "we checked and it's clean" from "we never actually got to check this run"
// (no E2B key configured, or provisioning failed) — never conflate the two.
export interface FullProjectCheckResult {
  ran:              boolean;
  sandboxAvailable: boolean;
  errors:           { file: string; message: string }[];
  checkedAt:        string;
}

export interface LogEntry {
  id: string;
  timestamp: string;
  level: 'info' | 'success' | 'error' | 'warning' | 'command';
  message: string;
  phase?: string;
}
