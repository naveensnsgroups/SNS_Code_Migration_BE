// =============================================================================
//  tool.ts — SNS IDE Standard Tool Types
//
//  Mirrors: snside/packages/ai-core/src/common/language-model.ts (ToolRequest)
//           snside/packages/ai-core/src/common/tool-invocation-registry.ts
//
//  CRITICAL: handler(arg_string: string, ctx?) — arg_string is raw JSON,
//  NOT a pre-parsed object. This matches SNS IDE exactly.
// =============================================================================

import { ToolCallResult } from './language-model.js';

// ── Tool Invocation Context ───────────────────────────────────────────────────
// Mirrors SNS IDE ToolInvocationContext + WorkspaceFunctionScope

/**
 * Context passed to every tool handler.
 * Mirrors SNS IDE ToolInvocationContext and WorkspaceFunctionScope combined.
 */
export interface ToolContext {
  /** Migration session identifier. */
  sessionId: string;
  /** Absolute path to the legacy (source) project root — read-only workspace. */
  legacyPath: string;
  /** Absolute path to the modern (output) project root — write target. */
  modernPath: string;
  /**
   * Log callback — tool handlers call this to stream messages to the terminal.
   * Mirrors SNS IDE onLog/logger pattern.
   */
  onLog?: (message: string, level?: 'info' | 'success' | 'error' | 'warning') => void;
  /**
   * The unique ID assigned by the LLM for this specific tool call.
   * Used to correlate tool_use ↔ tool_result messages.
   * Mirrors SNS IDE ToolInvocationContext.toolCallId.
   */
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

// ── Tool Parameter Schema ─────────────────────────────────────────────────────
// Mirrors SNS IDE ToolRequestParameterProperty / ToolRequestParameters

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

// ── Tool Request ──────────────────────────────────────────────────────────────
/**
 * Defines a tool that can be called by an LLM agent.
 *
 * Mirrors SNS IDE ToolRequest exactly. Key differences from legacy ToolDefinition:
 *  - handler receives `arg_string: string` (raw JSON from LLM), NOT a parsed object
 *  - handler returns `Promise<ToolCallResult>` (ToolCallContentWrapper | string | object)
 *  - has `providerName` for registry tracking
 *  - has `confirmAlwaysAllow` for dangerous tools (shell execution)
 */
export interface ToolRequest {
  /** Unique tool identifier. Must match the function name sent to the LLM. */
  id: string;
  /** Human-readable name — same as id. Used in prompts and API function declarations. */
  name: string;
  /** Description the LLM reads to decide when to use this tool. */
  description: string;
  /** JSON Schema for the tool's arguments. */
  parameters: ToolParameters;
  /**
   * The tool implementation.
   *
   * @param arg_string  Raw JSON string from the LLM (e.g. '{"path":"src/main.ts"}').
   *                    Parse with JSON.parse(arg_string) inside the handler.
   * @param ctx         Session context with paths, log callback, and toolCallId.
   * @returns           ToolCallResult: use makeToolTextResult() for success,
   *                    makeToolErrorResult() for errors.
   */
  handler: (arg_string: string, ctx?: ToolContext) => Promise<ToolCallResult>;
  /**
   * Which package/module registered this tool.
   * Used by ToolInvocationRegistry to unregister by provider.
   */
  providerName?: string;
  /**
   * If set, shell-level confirmation is required before auto-approval.
   * Set to true for tools with broad access (shell execution, file deletion).
   * Mirrors SNS IDE ToolRequest.confirmAlwaysAllow.
   */
  confirmAlwaysAllow?: boolean | string;
  /**
   * Optional: returns a short human-readable label for the tool's arguments
   * to display in the terminal/UI tool call summary.
   */
  getArgumentsShortLabel?(args: string): { label: string; hasMore: boolean } | undefined;
}

// ── Tool Provider ─────────────────────────────────────────────────────────────
// Mirrors SNS IDE ToolProvider interface

export interface ToolProvider {
  getTool(): ToolRequest;
}
