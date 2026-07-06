

import fs from 'fs-extra';
import path from 'path';
import { ToolRequest } from '../../types/tool.js';

import { ToolContext } from '../../types/tool.js';
import { makeToolTextResult, makeToolErrorResult } from '../../types/language-model.js';

import { COPY_STATIC_ASSETS_FUNCTION_ID } from '../../common/workspace-functions.js';

export const copyStaticAssetsTool: ToolRequest = {
  id: COPY_STATIC_ASSETS_FUNCTION_ID,
  name: 'copyStaticAssets',
  providerName: 'migration-output',
  description: 'Copies specified asset files from the legacy workspace to the same relative path in the modern output workspace.',
  parameters: {
    type: 'object',
    properties: {
      files: { type: 'array', items: { type: 'string' }, description: 'Array of relative file paths to copy from legacy to modern.' }
    },
    required: ['files']
  },
  handler: async (arg_string: string, ctx?: ToolContext) => {
    const args: { files: string[] } = JSON.parse(arg_string || '{}');
    const copied: string[] = [];
    const errors: string[] = [];
    for (const relPath of args.files) {
      try {
        const src = path.resolve(ctx!.legacyPath, relPath);
        const dest = path.resolve(ctx!.modernPath, relPath);
        if (!src.startsWith(path.resolve(ctx!.legacyPath))) { errors.push(`Access denied: ${relPath}`); continue; }
        await fs.ensureDir(path.dirname(dest));
        await fs.copy(src, dest);
        copied.push(relPath);
      } catch (err: unknown) {
        errors.push(`${relPath}: ${(err as Error).message}`);
      }
    }
    return makeToolTextResult(JSON.stringify({ copied, errors, totalCopied: copied.length }));
  }
};
