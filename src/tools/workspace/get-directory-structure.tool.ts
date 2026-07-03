

import fs from 'fs-extra';
import path from 'path';
import { ToolRequest } from '../../types/tool.js';

import { ToolContext } from '../../types/tool.js';
import { makeToolTextResult, makeToolErrorResult } from '../../types/language-model.js';

import { GET_WORKSPACE_DIRECTORY_STRUCTURE_FUNCTION_ID } from '../../common/workspace-functions.js';

const EXCLUDE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '__pycache__',
  'vendor', 'target', '.next', 'bin', 'obj', '.venv', 'venv'
]);

async function buildTree(dirPath: string, depth = 0): Promise<Record<string, unknown>> {
  if (depth > 8) return {};
  const items = await fs.readdir(dirPath, { withFileTypes: true });
  const result: Record<string, unknown> = {};
  for (const item of items) {
    if (item.isDirectory()) {
      if (EXCLUDE_DIRS.has(item.name) || item.name.startsWith('.')) continue;
      result[item.name] = await buildTree(path.join(dirPath, item.name), depth + 1);
    }
  }
  return result;
}

export const getDirectoryStructureTool: ToolRequest = {
  id: GET_WORKSPACE_DIRECTORY_STRUCTURE_FUNCTION_ID,
  name: 'getWorkspaceDirectoryStructure',
  providerName: 'migration-workspace',
  description:
    'Retrieves the complete directory tree structure of the legacy workspace as a nested JSON object. ' +
    'Lists only directories (no files), excluding common non-essential directories (node_modules, hidden files, etc.). ' +
    'Useful for getting a high-level overview of project organization. ' +
    'For listing files within a specific directory, use getWorkspaceFileList instead. ' +
    'For finding specific files, use findFilesByPattern.',
  parameters: { type: 'object', properties: {}, required: [] },
  handler: async (_arg_string: string, ctx?: ToolContext) => {
    const basePath = path.resolve(ctx!.legacyPath);
    if (!(await fs.pathExists(basePath))) {
      return makeToolTextResult(JSON.stringify({ error: 'Directory does not exist' }));
    }
    const tree = await buildTree(basePath);
    return makeToolTextResult(JSON.stringify(tree, null, 2));
  }
};
