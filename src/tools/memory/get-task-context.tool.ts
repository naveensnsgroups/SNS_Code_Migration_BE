

import { ToolRequest } from '../../types/tool.js';

import { ToolContext } from '../../types/tool.js';
import { makeToolTextResult, makeToolErrorResult } from '../../types/language-model.js';

import { TaskContextManager } from '../../session/taskContext.js';
import { GET_TASK_CONTEXT_FUNCTION_ID } from '../../common/workspace-functions.js';

export const getTaskContextTool: ToolRequest = {
  id: GET_TASK_CONTEXT_FUNCTION_ID,
  name: 'get_task_context',
  providerName: 'migration-memory',
  description:
    'Retrieves the persistent JSON task context dictionary for the current session. ' +
    'Contains phase indicators (ACTIVE_PHASE), checkpoints (LAST_FILE_ANALYZED, FILE_INDEX_KEY), ' +
    'named keys (file-index, rules-by-file, lang-profiles, dep-matrix), and any saved progress flags. ' +
    'Call this at the start of every session to check where analysis left off. ' +
    'Pass { "key": "file-index" } to fetch ONLY that key (recommended for large arrays); ' +
    'omit key to fetch the full dictionary minus large archived values.',
  parameters: {
    type: 'object',
    properties: {
      key: {
        type: 'string',
        description: 'Optional. Return only this key\'s value (e.g. "file-index"). Omit to return the whole context.'
      }
    },
    required: []
  },
  handler: async (arg_string: string, ctx?: ToolContext) => {
    let args: { key?: string } = {};
    try {
      args = JSON.parse(arg_string || '{}');
    } catch { /* tolerate malformed args — fall through to full-context read */ }

    const result = await TaskContextManager.getContext(ctx!.sessionId);

    if (args.key && typeof args.key === 'string') {
      const exists = Object.prototype.hasOwnProperty.call(result, args.key);
      return makeToolTextResult(JSON.stringify({
        key:    args.key,
        exists,
        value:  exists ? result[args.key] : null,
      }));
    }

    return makeToolTextResult(JSON.stringify(result));
  }
};
