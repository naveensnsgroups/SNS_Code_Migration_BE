

import { ToolRequest } from '../../types/tool.js';

import { ToolContext } from '../../types/tool.js';
import { makeToolTextResult, makeToolErrorResult } from '../../types/language-model.js';

import { EventBroadcaster } from '../../routes/stream.js';
import { SessionManager } from '../../session/sessionManager.js';
import { UPDATE_MIGRATION_DASHBOARD_FUNCTION_ID } from '../../common/workspace-functions.js';

export const updateMigrationDashboardTool: ToolRequest = {
  id: UPDATE_MIGRATION_DASHBOARD_FUNCTION_ID,
  name: 'update-migration-dashboard',
  providerName: 'migration-progress',
  description:
    'Broadcasts a live progress update to the frontend dashboard. ' +
    'Call after every batch of files to update the progress bar and current file indicator. ' +
    'Also saves progress to session for reconnection hydration.',
  parameters: {
    type: 'object',
    properties: {
      filesCompleted: { type: 'number', description: 'Number of files analyzed/migrated so far.' },
      totalFiles:     { type: 'number', description: 'Total files in the index.' },
      currentFile:    { type: 'string', description: 'The file currently being processed.' },
      phase:          { type: 'string', description: 'Current phase name (e.g. "Phase 1: FileAnalyzer").' }
    },
    required: ['filesCompleted', 'totalFiles']
  },
  handler: async (arg_string: string, ctx?: ToolContext) => {
    const args: { filesCompleted: number; totalFiles: number; currentFile?: string; phase?: string } = JSON.parse(arg_string || '{}');
    const percent = args.totalFiles > 0 ? Math.round((args.filesCompleted / args.totalFiles) * 100) : 0;

    EventBroadcaster.broadcast(ctx!.sessionId, 'progress', {
      percent,
      filesCompleted: args.filesCompleted,
      totalFiles: args.totalFiles,
      currentFile: args.currentFile || '',
      phase: args.phase || 'Analysis',
    });

    ctx!.onLog?.(`[Progress] ${args.filesCompleted}/${args.totalFiles} files (${percent}%)${args.currentFile ? ` — ${args.currentFile}` : ''}`, 'info');

    await SessionManager.updateSession(ctx!.sessionId, {
      completedFiles: args.filesCompleted,
      totalFiles: args.totalFiles,
      currentFile: args.currentFile,
    });

    return makeToolTextResult(JSON.stringify({ broadcasted: true, percent }));
  }
};
