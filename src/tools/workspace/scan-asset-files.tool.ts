

import glob from 'fast-glob';
import { ToolRequest } from '../../types/tool.js';

import { ToolContext } from '../../types/tool.js';
import { makeToolTextResult, makeToolErrorResult } from '../../types/language-model.js';

import { SCAN_ASSET_FILES_FUNCTION_ID } from '../../common/workspace-functions.js';

export const scanAssetFilesTool: ToolRequest = {
  id: SCAN_ASSET_FILES_FUNCTION_ID,
  name: 'scanAssetFiles',
  providerName: 'migration-workspace',
  description:
    'Scans the legacy workspace for all non-code asset files: images, fonts, stylesheets, ' +
    'env files, Dockerfiles, SQL scripts, config files, etc. ' +
    'Call during Phase 1 as mandatory asset inventory before generating Stage1_Analysis.md.',
  parameters: { type: 'object', properties: {}, required: [] },
  handler: async (_arg_string: string, ctx?: ToolContext) => {
    const base = ctx!.legacyPath;
    const ignore = ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**', '**/__pycache__/**'];
    const scan = (patterns: string[]) => glob(patterns, { cwd: base, onlyFiles: true, ignore, dot: true });

    const [images, fonts, stylesheets, envFiles, dockerFiles, sqlFiles, configFiles] = await Promise.all([
      scan(['**/*.png', '**/*.jpg', '**/*.jpeg', '**/*.gif', '**/*.svg', '**/*.ico', '**/*.webp']),
      scan(['**/*.ttf', '**/*.woff', '**/*.woff2', '**/*.eot', '**/*.otf']),
      scan(['**/*.css', '**/*.scss', '**/*.sass', '**/*.less', '**/*.styl']),
      scan(['.env', '.env.*', '**/.env', '**/.env.*']),
      scan(['**/Dockerfile', '**/docker-compose*.yml', '**/docker-compose*.yaml']),
      scan(['**/*.sql', '**/migrations/**', '**/schema.sql', '**/seed.sql']),
      scan(['**/*.yaml', '**/*.yml', '**/*.toml', '**/*.ini', '**/*.conf', '**/config.*', '**/*.config.*']),
    ]);

    const result = {
      images: images.slice(0, 100), fonts, stylesheets, envFiles, dockerFiles, sqlFiles,
      configFiles: configFiles.slice(0, 50),
      totalAssets: images.length + fonts.length + stylesheets.length + envFiles.length + dockerFiles.length + sqlFiles.length + configFiles.length,
    };
    return makeToolTextResult(JSON.stringify(result));
  }
};
