

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
  
  toolsConfig?: Record<string, boolean>;                  
  aliasesConfig?: Record<string, string>;                 
  promptFragments?: Record<string, string>;               
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
    | 'token_usage'    
    | 'todo_update'    
    | 'tool_call'          
    | 'tool_response'      
    | 'file_tree_changed'; 
  data: any;
  timestamp: string;
}
