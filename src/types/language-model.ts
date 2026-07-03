

export type MessageActor = 'user' | 'ai' | 'system';

export interface TextMessage {
  actor: MessageActor;
  type: 'text';
  text: string;
}

export interface ToolUseMessage {
  actor: 'ai';
  type: 'tool_use';
  
  id: string;
  
  name: string;
  
  input: unknown;
}

export interface ToolResultMessage {
  actor: 'user';
  type: 'tool_result';
  
  tool_use_id: string;
  
  name: string;
  
  content: ToolCallResult;
  
  is_error?: boolean;
}

export type LanguageModelMessage = TextMessage | ToolUseMessage | ToolResultMessage;

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

export interface ToolCallTextContent  { type: 'text';  text: string }
export interface ToolCallErrorContent { type: 'error'; data: string; errorKind?: string }
export interface ToolCallContentWrapper {
  content: Array<ToolCallTextContent | ToolCallErrorContent>;
}

export type ToolCallResult = undefined | object | string | ToolCallContentWrapper;

export function makeToolTextResult(text: string): ToolCallContentWrapper {
  return { content: [{ type: 'text', text }] };
}

export function makeToolErrorResult(message: string, errorKind?: string): ToolCallContentWrapper {
  return { content: [errorKind ? { type: 'error', data: message, errorKind } : { type: 'error', data: message }] };
}

export function isToolCallContentWrapper(r: ToolCallResult): r is ToolCallContentWrapper {
  return !!r && typeof r === 'object' && 'content' in r && Array.isArray((r as ToolCallContentWrapper).content);
}

export function hasToolError(r: ToolCallResult): boolean {
  return isToolCallContentWrapper(r) && r.content.some(c => c.type === 'error');
}

export interface TextResponsePart {
  content: string;
}

export interface UsageResponsePart {
  
  input_tokens: number;
  
  output_tokens: number;
  
  cache_creation_input_tokens?: number;
  
  cache_read_input_tokens?: number;
}

export interface ToolCallResponsePart {
  tool_calls: StreamToolCall[];
}

export interface StreamToolCall {
  id?: string;
  function?: {
    name?: string;
    
    arguments?: string;
  };
  
  finished?: boolean;
  result?: ToolCallResult;
  
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

export interface LanguageModelStreamResponse {
  stream: AsyncIterable<LanguageModelStreamPart>;
}

export interface StreamingProvider {
  request(
    userRequest: UserRequest,
    toolCtx?: import('./tool.js').ToolContext
  ): Promise<LanguageModelStreamResponse>;
}

