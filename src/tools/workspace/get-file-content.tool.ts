

import fs from 'fs-extra';
import path from 'path';
import { ToolRequest } from '../../types/tool.js';

import { ToolContext } from '../../types/tool.js';
import { makeToolTextResult, makeToolErrorResult } from '../../types/language-model.js';

import { FILE_CONTENT_FUNCTION_ID } from '../../common/workspace-functions.js';
import { parseToolArgs } from '../tool-args.js';

export const getFileContentTool: ToolRequest = {
  id: FILE_CONTENT_FUNCTION_ID,
  name: 'getFileContent',
  providerName: 'migration-workspace',
  description:
    'Returns the content of a specified file as a raw string. Reads from the LEGACY ' +
    'workspace by default. Pass workspace:"modern" to read an already-generated file from ' +
    'the modern/output workspace instead (e.g. to inspect a file Code Generation already wrote). ' +
    'The file path must be relative to whichever workspace root you selected. ' +
    'Supports optional offset (zero-based line number) and limit (max lines to return) for reading large files in chunks. ' +
    'It is recommended to read the whole file without offset/limit unless you expect it to be very large. ' +
    'If the file is very large (>300 lines), use offset+limit to page through it in chunks of ~200 lines. ' +
    'Do NOT use this for files you have not located yet — use findFilesByPattern or searchInWorkspace first.',
  parameters: {
    type: 'object',
    properties: {
      file: {
        type: 'string',
        description: 'The relative path to the target file (e.g. "src/index.ts", "package.json"). Must be relative to the selected workspace root.'
      },
      workspace: {
        type: 'string',
        description: 'Which workspace to read from: "legacy" (default, the original source project) or "modern" (the migration output workspace, for reading already-generated files).'
      },
      offset: {
        type: 'number',
        description: 'Zero-based line offset to start reading from (default: 0). Use with limit to page through large files.'
      },
      limit: {
        type: 'number',
        description: 'Maximum number of lines to return (default: entire file). Use with offset to read in chunks.'
      }
    },
    required: ['file']
  },
  handler: async (arg_string: string, ctx?: ToolContext) => {
    const parsed = parseToolArgs<{ file: string; workspace?: string; offset?: number; limit?: number }>(arg_string, 'getFileContent');
    if (!parsed.ok) return parsed.error;
    const args = parsed.value;
    if (!args.file) {
      return makeToolErrorResult('getFileContent: missing required parameter "file".');
    }
    const workspaceRoot = args.workspace === 'modern' ? ctx!.modernPath : ctx!.legacyPath;
    const targetPath = path.resolve(workspaceRoot, args.file);
    if (!targetPath.startsWith(path.resolve(workspaceRoot))) {
      return makeToolErrorResult('getFileContent: access denied — path is outside the workspace.');
    }
    if (!(await fs.pathExists(targetPath))) {
      return makeToolErrorResult(`getFileContent: file does not exist: ${args.file}`);
    }
    const stats = await fs.stat(targetPath);
    if (stats.isDirectory()) {
      return makeToolErrorResult(`getFileContent: "${args.file}" is a directory. Use getWorkspaceFileList to view its contents.`);
    }
    const content = await fs.readFile(targetPath, 'utf-8');
    if (args.offset !== undefined || args.limit !== undefined) {
      const lines = content.split(/\r?\n/);
      const start = args.offset ?? 0;
      const end = args.limit !== undefined ? start + args.limit : lines.length;
      const sliced = lines.slice(start, end);
      const startLine = start + 1;
      const endLine = Math.min(end, lines.length);
      const header = `[Lines ${startLine}–${endLine} of ${lines.length} total. Use offset and limit to read other ranges.]`;
      return makeToolTextResult(`${header}\n${sliced.join('\n')}`);
    }
    return makeToolTextResult(content);
  }
};
