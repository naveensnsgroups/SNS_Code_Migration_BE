

import { ToolRequest } from '../../types/tool.js';

import { ToolContext } from '../../types/tool.js';
import { makeToolTextResult, makeToolErrorResult } from '../../types/language-model.js';

import { TaskContextManager } from '../../session/taskContext.js';
import { COMPRESS_MIGRATION_CONTEXT_FUNCTION_ID } from '../../common/workspace-functions.js';

export const compressMigrationContextTool: ToolRequest = {
  id: COMPRESS_MIGRATION_CONTEXT_FUNCTION_ID,
  name: 'compress-migration-context',
  providerName: 'migration-progress',
  description:
    'Archives completed phase data to free up context window space. ' +
    'Moves large keys (file-index, rules-by-file, dep-matrix) to archive-* named keys, ' +
    'keeping only HOT keys (ACTIVE_PHASE, *_KEY pointers, TOTAL_FILES) inline. ' +
    'Call when CONTEXT_SIZE_WARNING=true is set in task context.',
  parameters: { type: 'object', properties: {}, required: [] },
  handler: async (_arg_string: string, ctx?: ToolContext) => {
    const taskCtx = await TaskContextManager.getContext(ctx!.sessionId);
    const ARCHIVE_KEYS = ['file-index', 'rules-by-file', 'lang-profiles', 'dep-matrix', 'symbols', 'analysis'];
    const archived: string[] = [];
    const archiveData: Record<string, unknown> = {};
    const keptKeys: string[] = [];

    for (const [key, value] of Object.entries(taskCtx)) {
      const shouldArchive = ARCHIVE_KEYS.some(ak => key === ak || key.startsWith(ak + ':'));
      if (shouldArchive && value !== undefined) { archiveData['archive-' + key] = value; archived.push(key); }
      else { keptKeys.push(key); }
    }

    const updates: Record<string, unknown> = { ...archiveData, CONTEXT_COMPACTED: true, CONTEXT_SIZE_WARNING: false };
    for (const key of archived) updates[key] = undefined;

    await TaskContextManager.updateContext(ctx!.sessionId, updates);
    ctx!.onLog?.(`[Context] Archived ${archived.length} large keys. Kept ${keptKeys.length} HOT keys.`, 'info');
    return makeToolTextResult(JSON.stringify({ archived, keptKeys, contextSizeReduced: archived.length > 0 }));
  }
};
