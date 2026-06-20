// ── Standalone Types for Backend ──────────────────────────────────────────

export type MigrationStatus =
  | 'idle'
  | 'scanning'
  | 'planning'
  | 'complete'
  | 'error'
  | 'paused';

export type LogLevel = 'info' | 'success' | 'error' | 'warning' | 'command';

export interface LogEntry {
  id: string;
  timestamp: string;
  level: LogLevel;
  message: string;
  phase?: string;
}

export interface DetectedStack {
  language: string;
  framework: string;
  database: string;
  packageManager: string;
  fileCount: number;
  testFramework?: string;
  styling?: string;
  frontend?: string;
  apiLayer?: string;
  backend?: string;
  databaseLayer?: string;
  cloudInfrastructure?: string;
}

export interface TargetStack {
  provider: AIProvider;
  model: string;
  framework: string;
  database: string;
  language: string;
  testFramework: string;
  outputMode: 'direct' | 'suggest';
}

export type AIProvider = 'anthropic' | 'openai' | 'google' | 'grok' | 'groq' | 'openrouter' | 'mistral' | 'huggingface';

export interface FileNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: FileNode[];
  migrated?: boolean;
  language?: string;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  readCachedInputTokens?: number;
  totalTokens: number;
  estimatedCost: number;
  provider?: string;
  model?: string;
}

export interface MigrateStartRequest {
  sessionId: string;
  targetStack: TargetStack;
  apiKey: string;
  localOutputPath?: string;
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
  // AI Config panel state — saved to session and used by orchestrator/agents
  toolsConfig?: Record<string, boolean>;                  // tool enablement map
  aliasesConfig?: Record<string, string>;                 // alias → resolved model string
  promptFragments?: Record<string, string>;               // fragment id → custom text
}

export interface SSEEvent {
  type:
    | 'log'
    | 'progress'
    | 'phase_change'
    | 'file_migrated'
    | 'complete'
    | 'error'
    | 'heartbeat'
    | 'token_usage'    // Real token counts broadcast from AgentExecutor
    | 'todo_update'    // Per-file progress from todoWrite tool
    | 'tool_call'          // Structured tool start event — FE sets activeTool state
    | 'tool_response'      // Structured tool done event  — FE clears activeTool state
    | 'file_tree_changed'; // @parcel/watcher detected new/changed/deleted file in modernPath
  data: any;
  timestamp: string;
}
