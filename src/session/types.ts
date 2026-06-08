// ── Session Types for Express Backend ──────────────────────────────────────

import { DetectedStack, FileNode, MigrationStatus, TargetStack, TokenUsage } from '../types.js';

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
  tokenUsage?: TokenUsage;                       // cumulative token counts for this session
}

export interface LogEntry {
  id: string;
  timestamp: string;
  level: 'info' | 'success' | 'error' | 'warning' | 'command';
  message: string;
  phase?: string;
}
