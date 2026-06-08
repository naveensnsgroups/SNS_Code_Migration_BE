// =============================================================================
//  tools/memory/edit-task-context.tool.ts
//  Persistent memory — update/merge into the session task context JSON.
// =============================================================================

import { ToolRequest } from '../../types/tool.js';

import { ToolContext } from '../../types/tool.js';
import { makeToolTextResult, makeToolErrorResult } from '../../types/language-model.js';

import { TaskContextManager } from '../../session/taskContext.js';
import { EDIT_TASK_CONTEXT_FUNCTION_ID } from '../../common/workspace-functions.js';
// EDIT_TASK_CONTEXT_FUNCTION_ID = 'edit_task_context' — SNS IDE exact value

export const editTaskContextTool: ToolRequest = {
  id: EDIT_TASK_CONTEXT_FUNCTION_ID,
  name: 'edit_task_context',
  providerName: 'migration-memory',
  description:
    'Updates or merges specific key-value pairs into the persistent session task context dictionary. ' +
    'Use this to save: ACTIVE_PHASE, LAST_FILE_ANALYZED, FILE_INDEX_KEY, file-index (full array), ' +
    'rules-by-file (per-file map), lang-profiles, dep-matrix, and any checkpoint/progress flags. ' +
    'Always save large objects (file indexes, rule maps) under NAMED KEYS (e.g. key="file-index") not inline.',
  parameters: {
    type: 'object',
    properties: {
      updates: {
        type: 'object',
        description: 'A key-value dictionary of fields to save/update (e.g. { "ACTIVE_PHASE": "2", "file-index": [...] }).'
      }
    },
    required: ['updates']
  },
  handler: async (arg_string: string, ctx?: ToolContext) => {
    const args: { updates: Record<string, unknown> } = JSON.parse(arg_string || '{}');
    await TaskContextManager.updateContext(ctx!.sessionId, args.updates);
    return makeToolTextResult(JSON.stringify({ success: true, keysUpdated: Object.keys(args.updates) }));
  }
};
