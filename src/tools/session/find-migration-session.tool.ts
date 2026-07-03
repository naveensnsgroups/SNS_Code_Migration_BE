

import { ToolRequest } from '../../types/tool.js';

import { ToolContext } from '../../types/tool.js';
import { makeToolTextResult, makeToolErrorResult } from '../../types/language-model.js';

import { SessionManager } from '../../session/sessionManager.js';
import { FIND_MIGRATION_SESSION_FUNCTION_ID } from '../../common/workspace-functions.js';

export const findMigrationSessionTool: ToolRequest = {
  id: FIND_MIGRATION_SESSION_FUNCTION_ID,
  name: 'find-migration-session',
  providerName: 'migration-session',
  description: 'Scans all sessions to find incomplete migration sessions. Used for cross-session recovery on startup.',
  parameters: { type: 'object', properties: {}, required: [] },
  handler: async (_arg_string: string, ctx?: ToolContext) => {
    try {
      const sessions = await SessionManager.listSessions();
      const incomplete = sessions
        .filter((s: any) => s.status !== 'complete' && s.status !== 'idle' && s.sessionId !== ctx!.sessionId)
        .map((s: any) => ({
          sessionId: s.sessionId,
          status: s.status,
          phase: s.phases?.find((p: any) => p.status === 'active')?.label || 'Unknown',
          lastAction: s.currentFile || '',
          timestamp: s.startedAt || '',
        }));
      return makeToolTextResult(JSON.stringify({ sessions: incomplete, found: incomplete.length }));
    } catch {
      return makeToolTextResult(JSON.stringify({ sessions: [], found: 0, note: 'Session listing not available.' }));
    }
  }
};
