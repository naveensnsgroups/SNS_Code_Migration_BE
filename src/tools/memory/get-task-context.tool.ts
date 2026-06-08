// =============================================================================
//  tools/memory/get-task-context.tool.ts
//  Persistent memory — read the session task context JSON.
// =============================================================================

import { ToolRequest } from '../../types/tool.js';

import { ToolContext } from '../../types/tool.js';
import { makeToolTextResult, makeToolErrorResult } from '../../types/language-model.js';

import { TaskContextManager } from '../../session/taskContext.js';
import { GET_TASK_CONTEXT_FUNCTION_ID } from '../../common/workspace-functions.js';
// GET_TASK_CONTEXT_FUNCTION_ID = 'get_task_context' — SNS IDE exact value

export const getTaskContextTool: ToolRequest = {
  id: GET_TASK_CONTEXT_FUNCTION_ID,
  name: 'get_task_context',
  providerName: 'migration-memory',
  description:
    'Retrieves the complete persistent JSON task context dictionary for the current session. ' +
    'Contains phase indicators (ACTIVE_PHASE), checkpoints (LAST_FILE_ANALYZED, FILE_INDEX_KEY), ' +
    'named keys (file-index, rules-by-file, lang-profiles, dep-matrix), and any saved progress flags. ' +
    'Call this at the start of every session to check where analysis left off.',
  parameters: { type: 'object', properties: {}, required: [] },
  handler: async (_arg_string: string, ctx?: ToolContext) => {
    const result = await TaskContextManager.getContext(ctx!.sessionId);
    return makeToolTextResult(JSON.stringify(result));
  }
};
