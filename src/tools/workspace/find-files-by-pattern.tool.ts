
import glob from 'fast-glob';
import fs   from 'fs-extra';
import path from 'path';
import { ToolRequest } from '../../types/tool.js';
import { ToolContext }  from '../../types/tool.js';
import { makeToolTextResult, makeToolErrorResult } from '../../types/language-model.js';
import { FIND_FILES_BY_PATTERN_FUNCTION_ID } from '../../common/workspace-functions.js';

const GLOB_IGNORE = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/build/**',
  '**/__pycache__/**',
  '**/vendor/**',
  '**/target/**',
  '**/.next/**',
  '**/.gradle/**',
  '**/.m2/**',
];

/**
 * Fetch fs.stat for a batch of absolute paths in parallel,
 * capped to avoid file-descriptor exhaustion on large projects.
 */
async function statBatch(
  absPaths: string[]
): Promise<{ sizeBytes: number; estimatedLines: number }[]> {
  const CONCURRENCY = 64;
  const results: { sizeBytes: number; estimatedLines: number }[] = [];

  for (let i = 0; i < absPaths.length; i += CONCURRENCY) {
    const chunk = absPaths.slice(i, i + CONCURRENCY);
    const settled = await Promise.allSettled(
      chunk.map((abs) => fs.stat(abs))
    );
    for (const r of settled) {
      if (r.status === 'fulfilled') {
        const size = r.value.size;
        results.push({ sizeBytes: size, estimatedLines: Math.round(size / 35) });
      } else {
        results.push({ sizeBytes: 0, estimatedLines: 0 });
      }
    }
  }
  return results;
}

export const findFilesByPatternTool: ToolRequest = {
  id: FIND_FILES_BY_PATTERN_FUNCTION_ID,
  name: 'findFilesByPattern',
  providerName: 'migration-workspace',
  description:
    'Finds files in the legacy workspace matching a given glob pattern. ' +
    'Each result includes: path (relative to workspace root), sizeBytes (actual on-disk size), ' +
    'and estimatedLines (= Math.round(sizeBytes / 35)). ' +
    'IMPORTANT: Copy estimatedLines directly into FILE_INDEX entries — never compute or guess it yourself. ' +
    'Common patterns: "**/*" (all files), "**/*.java", "**/*.py", "pom.xml". ' +
    'Already excludes: node_modules, .git, dist, build, target, vendor, __pycache__, .gradle, .m2.',
  parameters: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description:
          'Glob pattern to match files (e.g. "**/*", "**/*.ts", "pom.xml", "**/*.java"). ' +
          'Use "**/*" to enumerate every file with accurate size metadata.',
      },
    },
    required: ['pattern'],
  },

  handler: async (arg_string: string, ctx?: ToolContext) => {
    let args: { pattern: string };
    try {
      args = JSON.parse(arg_string || '{}');
    } catch {
      return makeToolErrorResult('Invalid JSON in arguments.');
    }

    if (!args.pattern || typeof args.pattern !== 'string') {
      return makeToolErrorResult('Missing required parameter: pattern (string).');
    }

    // ── 1. Glob scan ────────────────────────────────────────────────────────
    let files: string[];
    try {
      files = await glob(args.pattern, {
        cwd: ctx!.legacyPath,
        onlyFiles: true,
        ignore: GLOB_IGNORE,
        dot: true,
      });
    } catch (err: any) {
      return makeToolErrorResult(`Glob error: ${err?.message ?? String(err)}`);
    }

    // ── 2. Stat every file for accurate size data ────────────────────────────
    const absPaths = files.map((f) => path.join(ctx!.legacyPath, f));
    const metas    = await statBatch(absPaths);

    const result = files.map((f, i) => ({
      path:          f,
      sizeBytes:     metas[i].sizeBytes,
      estimatedLines: metas[i].estimatedLines,
    }));

    return makeToolTextResult(
      JSON.stringify({ files: result, count: result.length })
    );
  },
};
