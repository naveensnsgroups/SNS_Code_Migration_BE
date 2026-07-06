

import fs from 'fs-extra';
import path from 'path';
import glob from 'fast-glob';
import { ToolRequest } from '../../types/tool.js';

import { ToolContext } from '../../types/tool.js';
import { makeToolTextResult, makeToolErrorResult } from '../../types/language-model.js';

import { SEARCH_IN_WORKSPACE_FUNCTION_ID } from '../../common/workspace-functions.js';
import { parseToolArgs, requireStringArg } from '../tool-args.js';

const IGNORE_PATTERNS = [
  '**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**',
  '**/__pycache__/**', '**/vendor/**', '**/target/**', '**/.next/**'
];

export const searchInWorkspaceTool: ToolRequest = {
  id: SEARCH_IN_WORKSPACE_FUNCTION_ID,
  name: 'searchInWorkspace',
  providerName: 'migration-workspace',
  description:
    'Searches all text files in the legacy workspace for lines matching a specified text query. ' +
    'Returns matching lines with file path and line number. Maximum 100 results. ' +
    'Use this to find specific function definitions, class names, or patterns across all files. ' +
    'Do NOT use this for directory listing — use getWorkspaceFileList instead.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'The search query string (e.g. a function name, class name, or import pattern). Case-insensitive.'
      }
    },
    required: ['query']
  },
  handler: async (arg_string: string, ctx?: ToolContext) => {
    const parsed = parseToolArgs<{ query: string }>(arg_string, 'searchInWorkspace');
    if (!parsed.ok) return parsed.error;
    const q = requireStringArg(parsed.value.query, 'query', 'searchInWorkspace');
    if (!q.ok) return q.error;
    const args = { query: q.value };
    const basePath = ctx!.legacyPath;
    const files = await glob('**/*', { cwd: basePath, onlyFiles: true, ignore: IGNORE_PATTERNS, dot: true });
    const results: { file: string; line: number; content: string }[] = [];
    const lowerQuery = args.query.toLowerCase();

    for (const file of files) {
      const filePath = path.join(basePath, file);
      try {
        const content = await fs.readFile(filePath, 'utf-8');
        const lines = content.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].toLowerCase().includes(lowerQuery)) {
            results.push({ file, line: i + 1, content: lines[i].trim() });
            if (results.length >= 100) {
              return makeToolTextResult(JSON.stringify({ results, limitReached: true, message: 'Result limit of 100 reached.' }));
            }
          }
        }
      } catch {  }
    }

    return makeToolTextResult(JSON.stringify({ results, total: results.length }));
  }
};
