

import { ToolRequest } from '../../types/tool.js';
import { makeToolTextResult, makeToolErrorResult } from '../../types/language-model.js';
import { GET_FILE_DIAGNOSTICS_ID } from '../../common/workspace-functions.js';

export const getFileDiagnosticsTool: ToolRequest = {
  id: GET_FILE_DIAGNOSTICS_ID,
  name: 'getFileDiagnostics',
  providerName: 'migration-workspace',
  description: 'Retrieves diagnostic warnings and errors for a specific file. Note: in backend mode this returns an empty list as no LSP is available.',
  parameters: {
    type: 'object',
    properties: {
      file: { type: 'string', description: 'Relative path of the file to check.' }
    },
    required: ['file']
  },
  handler: async (_arg_string: string, _ctx?) => {
    return makeToolTextResult(JSON.stringify({ diagnostics: [], note: 'No LSP diagnostics available in backend mode.' }));
  }
};
