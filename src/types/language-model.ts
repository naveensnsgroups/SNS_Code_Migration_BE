// =============================================================================
//  language-model.ts — SNS IDE Standard Message Types
//
//  Mirrors: snside/packages/ai-core/src/common/language-model.ts
//
//  All provider adapters (Gemini, Anthropic, OpenAI) MUST convert their
//  native response formats into these types before returning.
// =============================================================================

// ── Message Actors ────────────────────────────────────────────────────────────

/** Who sent this message. Mirrors SNS IDE MessageActor. */
export type MessageActor = 'user' | 'ai' | 'system';

// ── Message Types (the 4 we use in our tool loop) ────────────────────────────

/** A plain text message from user, system, or AI. */
export interface TextMessage {
  actor: MessageActor;
  type: 'text';
  text: string;
}

/**
 * An AI request to call a tool.
 * actor is always 'ai'. input is the parsed arguments object.
 * Mirrors SNS IDE ToolUseMessage.
 */
export interface ToolUseMessage {
  actor: 'ai';
  type: 'tool_use';
  /** Unique ID assigned by the LLM for this specific call — used to match the result. */
  id: string;
  /** Tool name (same as ToolRequest.name). */
  name: string;
  /** Raw parsed arguments object from the LLM. */
  input: unknown;
}

/**
 * The result of a tool call fed back to the LLM.
 * actor is always 'user'. Mirrors SNS IDE ToolResultMessage.
 */
export interface ToolResultMessage {
  actor: 'user';
  type: 'tool_result';
  /** Must match the ToolUseMessage.id this result answers. */
  tool_use_id: string;
  /** Tool name — required by Gemini for functionResponse.name. */
  name: string;
  /** The result content from the tool handler. */
  content: ToolCallResult;
  /** Set true if the tool threw an error. */
  is_error?: boolean;
}

/** Union of all message types used in a conversation. */
export type LanguageModelMessage = TextMessage | ToolUseMessage | ToolResultMessage;

// ── Type Guards ───────────────────────────────────────────────────────────────

export namespace LanguageModelMessage {
  export function isText(m: LanguageModelMessage): m is TextMessage {
    return m.type === 'text';
  }
  export function isToolUse(m: LanguageModelMessage): m is ToolUseMessage {
    return m.type === 'tool_use';
  }
  export function isToolResult(m: LanguageModelMessage): m is ToolResultMessage {
    return m.type === 'tool_result';
  }
}

// ── Tool Call Result Types ────────────────────────────────────────────────────
// Mirrors SNS IDE ToolCallResult / ToolCallContent

export interface ToolCallTextContent  { type: 'text';  text: string }
export interface ToolCallErrorContent { type: 'error'; data: string; errorKind?: 'tool-not-available' }
export interface ToolCallContentWrapper {
  content: Array<ToolCallTextContent | ToolCallErrorContent>;
}

/**
 * What a tool handler returns.
 * Mirrors SNS IDE:  ToolCallResult = undefined | object | string | ToolCallContent
 */
export type ToolCallResult = undefined | object | string | ToolCallContentWrapper;

export function makeToolTextResult(text: string): ToolCallContentWrapper {
  return { content: [{ type: 'text', text }] };
}

export function makeToolErrorResult(message: string, errorKind?: 'tool-not-available'): ToolCallContentWrapper {
  return { content: [errorKind ? { type: 'error', data: message, errorKind } : { type: 'error', data: message }] };
}

export function isToolCallContentWrapper(r: ToolCallResult): r is ToolCallContentWrapper {
  return !!r && typeof r === 'object' && 'content' in r && Array.isArray((r as ToolCallContentWrapper).content);
}

export function hasToolError(r: ToolCallResult): boolean {
  return isToolCallContentWrapper(r) && r.content.some(c => c.type === 'error');
}

// ── Stream Response Parts ─────────────────────────────────────────────────────
// Mirrors SNS IDE LanguageModelStreamResponsePart

/** A text chunk streamed from the LLM. */
export interface TextResponsePart {
  content: string;
}

/** Token usage metadata — yielded at end of stream. */
export interface UsageResponsePart {
  /** Total input/prompt tokens for this request. */
  input_tokens: number;
  /** Total output/completion tokens for this request. */
  output_tokens: number;
  /** Optional: tokens written to cache (Anthropic). */
  cache_creation_input_tokens?: number;
  /** Optional: tokens read from cache (Anthropic). */
  cache_read_input_tokens?: number;
}

/** A tool call streamed from the LLM (may be partial — argumentsDelta = true). */
export interface ToolCallResponsePart {
  tool_calls: StreamToolCall[];
}

export interface StreamToolCall {
  id?: string;
  function?: {
    name?: string;
    /** If argumentsDelta = true, this is a delta to append. Otherwise it's complete. */
    arguments?: string;
  };
  /** True when the full call is complete and the result is attached. */
  finished?: boolean;
  result?: ToolCallResult;
  /** When true, function.arguments is a delta chunk, not complete JSON. */
  argumentsDelta?: boolean;
}

export type LanguageModelStreamPart = TextResponsePart | UsageResponsePart | ToolCallResponsePart;

export function isTextResponsePart(p: LanguageModelStreamPart): p is TextResponsePart {
  return 'content' in p && typeof (p as TextResponsePart).content === 'string';
}

export function isUsageResponsePart(p: LanguageModelStreamPart): p is UsageResponsePart {
  return 'input_tokens' in p && 'output_tokens' in p;
}

export function isToolCallResponsePart(p: LanguageModelStreamPart): p is ToolCallResponsePart {
  return 'tool_calls' in p && Array.isArray((p as ToolCallResponsePart).tool_calls);
}

// ── Language Model Request ────────────────────────────────────────────────────
// Mirrors SNS IDE LanguageModelRequest + UserRequest

export interface LanguageModelRequest {
  messages: LanguageModelMessage[];
  tools?: import('./tool.js').ToolRequest[];
  settings?: Record<string, unknown>;
}

export interface UserRequest extends LanguageModelRequest {
  sessionId: string;
  requestId: string;
  agentId?: string;
  modelName?: string;
}

// ── Language Model Response ───────────────────────────────────────────────────

export interface LanguageModelStreamResponse {
  stream: AsyncIterable<LanguageModelStreamPart>;
}

export interface StreamingProvider {
  request(
    userRequest: UserRequest,
    toolCtx?: import('./tool.js').ToolContext
  ): Promise<LanguageModelStreamResponse>;
}

