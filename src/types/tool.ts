

import { ToolCallResult } from './language-model.js';
import { SandboxHandle } from '../sandbox/sandbox-manager.js';

export interface ToolContext {

  sessionId: string;

  legacyPath: string;

  modernPath: string;

  onLog?: (message: string, level?: 'info' | 'success' | 'error' | 'warning') => void;

  toolCallId?: string;

  // Present only during the full-project verification stage (Workstream 3) —
  // when set, capturedShellExecute routes commands through this real,
  // isolated sandbox instead of the host machine. Absent everywhere else.
  sandbox?: SandboxHandle;

  // Real environment variables (parsed from the generated project's own
  // .env scaffolding file) that capturedShellExecute passes to every sandboxed
  // command automatically — never requested by the agent itself, since these
  // are real local-dev credentials/connection strings, not something a model
  // should need to know to ask for. Absent when no .env was found/parsed.
  envs?: Record<string, string>;
}

export namespace ToolContext {
  export function create(
    sessionId: string,
    legacyPath: string,
    modernPath: string,
    toolCallId?: string,
    onLog?: ToolContext['onLog']
  ): ToolContext {
    return { sessionId, legacyPath, modernPath, toolCallId, onLog };
  }

  export function withSandbox(ctx: ToolContext, sandbox: SandboxHandle): ToolContext {
    return { ...ctx, sandbox };
  }

  export function withEnvs(ctx: ToolContext, envs: Record<string, string>): ToolContext {
    return { ...ctx, envs };
  }

  export function withToolCallId(ctx: ToolContext, toolCallId: string): ToolContext {
    return { ...ctx, toolCallId };
  }
}

export interface ToolParam {
  type?: 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array' | 'null';
  description?: string;
  items?: ToolParam;
  properties?: Record<string, ToolParam>;
  required?: string[];
  anyOf?: ToolParam[];
  enum?: unknown[];
  [key: string]: unknown;
}

export interface ToolParameters {
  type: 'object';
  properties: Record<string, ToolParam>;
  required?: string[];
}

export interface ToolRequest {
  
  id: string;
  
  name: string;
  
  description: string;
  
  parameters: ToolParameters;
  
  handler: (arg_string: string, ctx?: ToolContext) => Promise<ToolCallResult>;
  
  providerName?: string;
  
  confirmAlwaysAllow?: boolean | string;
  
  getArgumentsShortLabel?(args: string): { label: string; hasMore: boolean } | undefined;
}

export interface ToolProvider {
  getTool(): ToolRequest;
}
