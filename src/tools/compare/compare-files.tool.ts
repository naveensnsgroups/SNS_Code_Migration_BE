

import fs from 'fs-extra';
import path from 'path';
import { ToolRequest } from '../../types/tool.js';

import { ToolContext } from '../../types/tool.js';
import { makeToolTextResult, makeToolErrorResult } from '../../types/language-model.js';

import { COMPARE_FILES_FUNCTION_ID } from '../../common/workspace-functions.js';

export const compareFilesTool: ToolRequest = {
  id: COMPARE_FILES_FUNCTION_ID,
  name: 'compareFiles',
  providerName: 'migration-compare',
  description: 'Compares a legacy file with its modern equivalent and returns a unified diff. Use to verify migration fidelity.',
  parameters: {
    type: 'object',
    properties: {
      legacyFile: { type: 'string', description: 'Relative path to the legacy file.' },
      modernFile:  { type: 'string', description: 'Relative path to the modern file (in output workspace).' }
    },
    required: ['legacyFile', 'modernFile']
  },
  handler: async (arg_string: string, ctx?: ToolContext) => {
    const args: { legacyFile: string; modernFile: string } = JSON.parse(arg_string || '{}');
    try {
      const legacyFilePath = path.resolve(ctx!.legacyPath, args.legacyFile);
      const modernFilePath  = path.resolve(ctx!.modernPath,  args.modernFile);
      if (!(await fs.pathExists(legacyFilePath))) {
        return makeToolTextResult(JSON.stringify({ error: `Legacy file not found: ${args.legacyFile}` }));
      }
      if (!(await fs.pathExists(modernFilePath))) {
        return makeToolTextResult(JSON.stringify({ error: `Modern file not found: ${args.modernFile}` }));
      }
      const [legacyLines, modernLines] = await Promise.all([
        fs.readFile(legacyFilePath, 'utf-8').then(c => c.split('\n')),
        fs.readFile(modernFilePath,  'utf-8').then(c => c.split('\n')),
      ]);
      let added = 0; let removed = 0;
      const diff: string[] = [];
      const maxLines = Math.max(legacyLines.length, modernLines.length);
      for (let i = 0; i < maxLines; i++) {
        const lLine = legacyLines[i] ?? '';
        const mLine = modernLines[i] ?? '';
        if (lLine !== mLine) {
          if (legacyLines[i] !== undefined) { diff.push(`- ${lLine}`); removed++; }
          if (modernLines[i] !== undefined) { diff.push(`+ ${mLine}`); added++; }
        }
      }
      const totalChanges = added + removed;
      const similarity = totalChanges === 0 ? 100 : Math.round((1 - totalChanges / (maxLines * 2)) * 100);
      return makeToolTextResult(JSON.stringify({ legacyFile: args.legacyFile, modernFile: args.modernFile, addedLines: added, removedLines: removed, similarity: `${similarity}%`, diff: diff.slice(0, 200).join('\n') }));
    } catch (err: unknown) {
      return makeToolTextResult(JSON.stringify({ error: (err as Error).message }));
    }
  }
};
