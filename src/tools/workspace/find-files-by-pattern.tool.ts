// =============================================================================
//  tools/workspace/find-files-by-pattern.tool.ts
//  Mirrors: FindFilesByPattern (snside workspace-functions.ts)
// =============================================================================

import glob from 'fast-glob';
import { ToolRequest } from '../../types/tool.js';

import { ToolContext } from '../../types/tool.js';
import { makeToolTextResult, makeToolErrorResult } from '../../types/language-model.js';

import { FIND_FILES_BY_PATTERN_FUNCTION_ID } from '../../common/workspace-functions.js';

export const findFilesByPatternTool: ToolRequest = {
  id: FIND_FILES_BY_PATTERN_FUNCTION_ID,
  name: 'findFilesByPattern',
  providerName: 'migration-workspace',
  description:
    'Finds files in the legacy workspace matching a given glob pattern. ' +
    'Use this to locate specific file types (e.g. "**/*.ts"), manifest files (e.g. "package.json"), ' +
    'or language-specific patterns (e.g. "**/*.py", "**/*.java", "CMakeLists.txt"). ' +
    'Use this BEFORE calling getFileContent to confirm the file exists and get its exact path.',
  parameters: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'Glob pattern to match files against (e.g. "**/*.ts", "src/**/*.js", "package.json", "**/*.py").'
      }
    },
    required: ['pattern']
  },
  handler: async (arg_string: string, ctx?: ToolContext) => {
    const args: { pattern: string } = JSON.parse(arg_string || '{}');
    const files = await glob(args.pattern, {
      cwd: ctx!.legacyPath,
      onlyFiles: true,
      ignore: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**',
               '**/__pycache__/**', '**/vendor/**', '**/target/**', '**/.next/**'],
      dot: true
    });
    return makeToolTextResult(JSON.stringify({ files, count: files.length }));
  }
};
