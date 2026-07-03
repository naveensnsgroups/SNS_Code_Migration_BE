

import { ToolCallResult } from './language-model.js';

export interface ToolContext {
  
  sessionId: string;
  
  legacyPath: string;
  
  modernPath: string;
  
  onLog?: (message: string, level?: 'info' | 'success' | 'error' | 'warning') => void;
  
  toolCallId?: string;
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
