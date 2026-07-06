// Shared argument-parsing helper — the single standard way every tool reads the
// model's JSON arguments. A tool must never call JSON.parse(arg_string) directly:
// malformed model output would throw and surface as a vague generic error instead
// of an actionable "resend valid JSON" message the model can recover from.
//
// Usage:
//   const parsed = parseToolArgs<{ file: string }>(arg_string, 'getFileContent');
//   if (!parsed.ok) return parsed.error;
//   const args = parsed.value;

import { makeToolErrorResult, ToolCallContentWrapper } from '../types/language-model.js';

export type ParsedArgs<T> =
  | { ok: true; value: T }
  | { ok: false; error: ToolCallContentWrapper };

export function parseToolArgs<T = Record<string, unknown>>(
  argString: string,
  toolName: string
): ParsedArgs<T> {
  try {
    const value = JSON.parse(argString || '{}') as T;
    return { ok: true, value };
  } catch {
    return {
      ok: false,
      error: makeToolErrorResult(
        `${toolName}: invalid JSON arguments. Re-send the call with a single valid JSON object.`
      ),
    };
  }
}

// Guard for a required string field. Returns a structured error if missing/blank.
export function requireStringArg(
  value: unknown,
  fieldName: string,
  toolName: string
): { ok: true; value: string } | { ok: false; error: ToolCallContentWrapper } {
  if (typeof value !== 'string' || value.trim() === '') {
    return {
      ok: false,
      error: makeToolErrorResult(
        `${toolName}: missing or empty required parameter "${fieldName}" (expected a non-empty string).`
      ),
    };
  }
  return { ok: true, value };
}
