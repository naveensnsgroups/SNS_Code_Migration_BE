// =============================================================================
//  tools/workspace/batch-read-files.tool.ts
//  Mirrors: BatchFileReader (snside migration-batch-reader-tool.ts)
// =============================================================================

import fs from 'fs-extra';
import path from 'path';
import { ToolRequest } from '../../types/tool.js';

import { ToolContext } from '../../types/tool.js';
import { makeToolTextResult, makeToolErrorResult } from '../../types/language-model.js';

import { BATCH_READ_FILES_FUNCTION_ID } from '../../common/workspace-functions.js';

const MAX_TOTAL_BYTES = 300 * 1024; // 300KB

const LANG_MAP: Record<string, string> = {
  '.ts': 'typescript', '.tsx': 'typescript', '.js': 'javascript', '.jsx': 'javascript',
  '.py': 'python', '.java': 'java', '.go': 'go', '.rs': 'rust', '.php': 'php',
  '.rb': 'ruby', '.cs': 'csharp', '.kt': 'kotlin', '.swift': 'swift',
  '.json': 'json', '.yaml': 'yaml', '.yml': 'yaml', '.md': 'markdown',
  '.html': 'html', '.css': 'css', '.scss': 'scss', '.sql': 'sql'
};

export const batchReadFilesTool: ToolRequest = {
  id: BATCH_READ_FILES_FUNCTION_ID,
  name: 'batch-read-files',
  providerName: 'migration-workspace',
  description:
    'Reads up to 10 workspace files in parallel and returns their content in a single call. ' +
    'Use this in Phase 1 (FileAnalyzer) instead of individual getFileContent calls when processing batches. ' +
    'Each entry specifies: path (relative to workspace root), optional offset (start line, 1-based), optional limit (max lines to return). ' +
    'Returns an array with one result per file: { path, content, lineCount, sizeBytes, language, error? }. ' +
    'Max 10 files per call. Max 300KB total payload.',
  parameters: {
    type: 'object',
    properties: {
      files: {
        type: 'array',
        description: 'Array of file read requests. Max 10 entries.',
        items: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path relative to workspace root.' },
            offset: { type: 'number', description: 'Optional. Start line (1-based). Default: 1 (start of file).' },
            limit: { type: 'number', description: 'Optional. Max lines to return. Default: full file.' }
          },
          required: ['path']
        }
      }
    },
    required: ['files']
  },
  handler: async (arg_string: string, ctx?: ToolContext) => {
    const args: { files: Array<{ path: string; offset?: number; limit?: number }> } = JSON.parse(arg_string || '{}');
    const entries = args.files ?? [];
    if (!Array.isArray(entries) || entries.length === 0) {
      return makeToolTextResult(JSON.stringify({ error: 'files array is required and must not be empty' }));
    }
    if (entries.length > 10) {
      return makeToolTextResult(JSON.stringify({ error: 'Max 10 files per batch call. Split into multiple batches.' }));
    }

    let totalBytes = 0;
    const results = await Promise.all(entries.map(async (entry) => {
      const relPath = entry.path;
      const targetPath = path.resolve(ctx!.legacyPath, relPath);
      if (!targetPath.startsWith(path.resolve(ctx!.legacyPath))) {
        return { path: relPath, error: 'Path traversal denied — file is outside workspace' };
      }
      try {
        if (!(await fs.pathExists(targetPath))) return { path: relPath, error: 'File does not exist.' };
        const stat = await fs.stat(targetPath);
        if (stat.isDirectory()) return { path: relPath, error: 'Path is a directory, not a file.' };

        const rawContent = await fs.readFile(targetPath, 'utf-8');
        const allLines = rawContent.split(/\r?\n/);
        const lineCount = allLines.length;
        const offset = Math.max(0, (entry.offset ?? 1) - 1);
        const slicedLines = entry.limit ? allLines.slice(offset, offset + entry.limit) : allLines.slice(offset);
        const content = slicedLines.join('\n');
        const contentBytes = Buffer.byteLength(content, 'utf8');

        totalBytes += contentBytes;
        if (totalBytes > MAX_TOTAL_BYTES) {
          return { path: relPath, error: 'Skipped — total batch payload exceeds 300KB limit. Read this file separately.', lineCount, sizeBytes: stat.size };
        }

        const ext = path.extname(relPath).toLowerCase();
        const language = LANG_MAP[ext] ?? 'plaintext';
        return { path: relPath, content, lineCount, sizeBytes: stat.size, language };
      } catch (err: unknown) {
        return { path: relPath, error: (err as Error).message };
      }
    }));

    return makeToolTextResult(JSON.stringify(results));
  }
};
