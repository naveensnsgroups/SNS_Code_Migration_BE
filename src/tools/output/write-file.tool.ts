// =============================================================================
//  tools/output/write-file.tool.ts
//  Writes output files (Stage1_Analysis.md etc.) to modernPath.
// =============================================================================

import { ToolRequest } from '../../types/tool.js';

import { ToolContext } from '../../types/tool.js';
import { makeToolTextResult, makeToolErrorResult } from '../../types/language-model.js';

import { writeSessionFile } from '../fileWriter.js';
import { WRITE_FILE_FUNCTION_ID } from '../../common/workspace-functions.js';
// WRITE_FILE_FUNCTION_ID = 'write_file' — SNS IDE exact value

export const writeFileTool: ToolRequest = {
  id: WRITE_FILE_FUNCTION_ID,
  name: 'write_file',
  providerName: 'migration-output',
  description:
    'Writes content to a file in the output workspace (modernPath). ' +
    'Use this to write Stage1_Analysis.md, migration-plan.md, or any analysis report. ' +
    'Always writes to the modern output directory — never modifies the legacy source files.',
  parameters: {
    type: 'object',
    properties: {
      relativePath: { type: 'string', description: 'The relative destination file path inside the output directory (e.g. "Stage1_Analysis.md").' },
      path: { type: 'string', description: 'Alias for relativePath.' },
      file_path: { type: 'string', description: 'Alias for relativePath.' },
      content: { type: 'string', description: 'The complete string content to write to the file.' }
    },
    required: ['content']
  },
  handler: async (arg_string: string, ctx?: ToolContext) => {
    const args: { relativePath?: string; path?: string; file_path?: string; content: string } = JSON.parse(arg_string || '{}');
    const resolvedPath = args.relativePath || args.path || args.file_path;
    if (!resolvedPath) {
      return makeToolTextResult(JSON.stringify({ error: 'Missing destination path. Provide relativePath, path, or file_path.' }));
    }
    await writeSessionFile(ctx!.modernPath, resolvedPath, args.content);
    return makeToolTextResult(JSON.stringify({ success: true, path: resolvedPath, message: `File written successfully to ${resolvedPath}` }));
  }
};
