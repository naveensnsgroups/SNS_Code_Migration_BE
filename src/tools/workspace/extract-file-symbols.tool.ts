

import fs from 'fs-extra';
import path from 'path';
import { ToolRequest } from '../../types/tool.js';

import { ToolContext } from '../../types/tool.js';
import { makeToolTextResult, makeToolErrorResult } from '../../types/language-model.js';

import { EXTRACT_FILE_SYMBOLS_FUNCTION_ID } from '../../common/workspace-functions.js';
import { parseToolArgs } from '../tool-args.js';

export const extractFileSymbolsTool: ToolRequest = {
  id: EXTRACT_FILE_SYMBOLS_FUNCTION_ID,
  name: 'extractFileSymbols',
  providerName: 'migration-workspace',
  description:
    'Returns the file line count, a size-based reading strategy, and a BEST-EFFORT list of ' +
    'top-level symbols (functions, classes, methods) found by regex. ' +
    'The symbol list is a heuristic aid for planning reads — it is NOT a complete parse and may ' +
    'miss or mislabel symbols, especially in languages other than JS/TS, Python, Java, Go, and PHP. ' +
    'Treat symbolCount as approximate; always read the actual file content for real analysis. ' +
    'readingStrategy: SMALL (≤200 lines) = read whole file; MEDIUM (201-500) = symbol-targeted reads; ' +
    'LARGE (501-2500) = chunked reads with checkpoints; ULTRA_LARGE (2500+) = multi-pass streaming. ' +
    'Useful to call before getFileContent on a source file to pick the reading strategy.',
  parameters: {
    type: 'object',
    properties: {
      file: { type: 'string', description: 'Relative path to the source file within the legacy workspace.' }
    },
    required: ['file']
  },
  handler: async (arg_string: string, ctx?: ToolContext) => {
    const parsed = parseToolArgs<{ file: string }>(arg_string, 'extractFileSymbols');
    if (!parsed.ok) return parsed.error;
    const args = parsed.value;
    if (!args.file) {
      return makeToolErrorResult('extractFileSymbols: missing required parameter "file".');
    }
    const targetPath = path.resolve(ctx!.legacyPath, args.file);
    if (!targetPath.startsWith(path.resolve(ctx!.legacyPath))) {
      return makeToolErrorResult('extractFileSymbols: access denied — path is outside the workspace.');
    }
    if (!(await fs.pathExists(targetPath))) {
      return makeToolErrorResult(`extractFileSymbols: file not found: ${args.file}`);
    }
    const stat = await fs.stat(targetPath);
    if (stat.isDirectory()) {
      return makeToolErrorResult(`extractFileSymbols: "${args.file}" is a directory.`);
    }

    const content = await fs.readFile(targetPath, 'utf-8');
    const lines = content.split(/\r?\n/);
    const lineCount = lines.length;

    const readingStrategy =
      lineCount <= 200 ? 'SMALL' :
      lineCount <= 500 ? 'MEDIUM' :
      lineCount <= 2500 ? 'LARGE' : 'ULTRA_LARGE';

    const patterns = [
      { regex: /^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(/gm,    type: 'function' },
      { regex: /^\s*(?:export\s+)?class\s+(\w+)/gm,                          type: 'class' },
      { regex: /^\s*(?:public|private|protected|static|async)?\s+(\w+)\s*\([^)]*\)\s*[:{]/gm, type: 'method' },
      { regex: /^\s*const\s+(\w+)\s*=\s*(?:async\s+)?(?:\([^)]*\)|\w+)\s*=>/gm, type: 'arrow_fn' },
      { regex: /^def\s+(\w+)\s*\(/gm,      type: 'function' },
      { regex: /^class\s+(\w+)/gm,          type: 'class' },
      { regex: /(?:public|private|protected|static)\s+\w+\s+(\w+)\s*\(/gm, type: 'method' },
      { regex: /^func\s+(?:\(\w+\s+\*?\w+\)\s+)?(\w+)\s*\(/gm, type: 'function' },
      { regex: /^\s*(?:public|private|protected)?\s*function\s+(\w+)\s*\(/gm, type: 'function' },
      { regex: /^\s*def\s+(\w+)/gm, type: 'function' },
    ];

    const symbols: { name: string; type: string; startLine: number; endLine: number }[] = [];
    const seen = new Set<string>();
    for (const { regex, type } of patterns) {
      let match;
      regex.lastIndex = 0;
      while ((match = regex.exec(content)) !== null) {
        const name = match[1];
        if (!name || seen.has(name)) continue;
        seen.add(name);
        const before = content.slice(0, match.index);
        const startLine = before.split('\n').length;
        symbols.push({ name, type, startLine, endLine: startLine + 5 });
      }
    }

    const result = {
      file: args.file, lineCount, readingStrategy, symbolCount: symbols.length,
      symbols: symbols.slice(0, 200),
      recommendation:
        readingStrategy === 'SMALL' ? 'Read entire file with getFileContent (no offset/limit needed).' :
        readingStrategy === 'MEDIUM' ? 'Use getFileContent with offset/limit per symbol (startLine-1, lineCount).' :
        readingStrategy === 'LARGE' ? 'Read 10 symbols per turn using getFileContent with offset/limit. Save CHUNK_PROGRESS checkpoints.' :
        'MANDATORY MULTI-PASS: 5 symbols per turn max. Save per-symbol analysis notes after each batch.'
    };
    return makeToolTextResult(JSON.stringify(result));
  }
};
