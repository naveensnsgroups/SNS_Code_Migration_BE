// ── Session Types for Express Backend ──────────────────────────────────────

import { AIProvider, DetectedStack, FileNode, MigrationStatus, TargetStack } from '../types.js';

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
}

export interface LogEntry {
  id: string;
  timestamp: string;
  level: 'info' | 'success' | 'error' | 'warning' | 'command';
  message: string;
  phase?: string;
}
