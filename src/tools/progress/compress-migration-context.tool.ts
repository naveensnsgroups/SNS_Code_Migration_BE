

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
    if (!ctx?.sessionId) {
      return makeToolErrorResult('compress-migration-context: sessionId missing from tool context.');
    }

    const ARCHIVE_KEYS = ['file-index', 'rules-by-file', 'lang-profiles', 'dep-matrix', 'symbols', 'analysis'];
    const archived: string[] = [];
    const keptKeys: string[] = [];

    // The decide-what-to-archive step and the archive+delete step run atomically
    // inside the per-session context queue. Deciding from a separate earlier read
    // would let a concurrent write land in between and then be deleted here.
    await TaskContextManager.transformContext(ctx.sessionId, (taskCtx) => {
      const updated: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(taskCtx)) {
        const shouldArchive = ARCHIVE_KEYS.some(ak => key === ak || key.startsWith(ak + ':'));
        if (shouldArchive && value !== undefined) {
          updated['archive-' + key] = value;
          archived.push(key);
        } else {
          updated[key] = value;
          keptKeys.push(key);
        }
      }
      updated.CONTEXT_COMPACTED    = true;
      updated.CONTEXT_SIZE_WARNING = false;
      return updated;
    });

    ctx.onLog?.(`[Context] Archived ${archived.length} large keys. Kept ${keptKeys.length} HOT keys.`, 'info');
    return makeToolTextResult(JSON.stringify({ archived, keptKeys, contextSizeReduced: archived.length > 0 }));
  }
};
