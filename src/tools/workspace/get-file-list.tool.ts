

import fs from 'fs-extra';
import path from 'path';
import { ToolRequest } from '../../types/tool.js';

import { ToolContext } from '../../types/tool.js';
import { makeToolTextResult, makeToolErrorResult } from '../../types/language-model.js';

import { GET_WORKSPACE_FILE_LIST_FUNCTION_ID } from '../../common/workspace-functions.js';
import { parseToolArgs } from '../tool-args.js';

const EXCLUDE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '__pycache__',
  'vendor', 'target', '.next', 'bin', 'obj', '.venv', 'venv'
]);

export const getFileListTool: ToolRequest = {
  id: GET_WORKSPACE_FILE_LIST_FUNCTION_ID,
  name: 'getWorkspaceFileList',
  providerName: 'migration-workspace',
  description:
    'Lists files and directories within a specified directory of the legacy workspace. ' +
    'Returns an array of names where directories are suffixed with "/" (e.g. ["src/", "package.json", "README.md"]). ' +
    'Use this to explore directory structure step by step. ' +
    'For finding specific files by pattern, use findFilesByPattern instead. ' +
    'For searching file contents, use searchInWorkspace instead.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Relative path to a directory within the legacy workspace. Use "" or "." for the root.'
      }
    },
    required: ['path']
  },
  handler: async (arg_string: string, ctx?: ToolContext) => {
    const parsed = parseToolArgs<{ path?: string }>(arg_string, 'getWorkspaceFileList');
    if (!parsed.ok) return parsed.error;
    const args = parsed.value;
    const targetPath = path.resolve(ctx!.legacyPath, args.path || '');
    if (!targetPath.startsWith(path.resolve(ctx!.legacyPath))) {
      return makeToolErrorResult('getWorkspaceFileList: access denied — path is outside the workspace.');
    }
    if (!(await fs.pathExists(targetPath))) {
      return makeToolErrorResult(`getWorkspaceFileList: directory does not exist: ${args.path || '/'}`);
    }
    const items = await fs.readdir(targetPath, { withFileTypes: true });
    const result = items
      .filter(item => {
        if (EXCLUDE_DIRS.has(item.name)) return false;
        if (item.name.startsWith('.') && item.name !== '.env' && item.name !== '.env.example' && item.name !== '.gitignore') return false;
        return true;
      })
      .map(item => item.isDirectory() ? `${item.name}/` : item.name);
    return makeToolTextResult(JSON.stringify(result));
  }
};
