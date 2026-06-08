// =============================================================================
//  tools/environment/get-environment-info.tool.ts
//  Mirrors: GetEnvironmentInfo (snside migration-env-tools.ts)
// =============================================================================

import { ToolRequest } from '../../types/tool.js';

import { ToolContext } from '../../types/tool.js';
import { makeToolTextResult, makeToolErrorResult } from '../../types/language-model.js';

import { ShellExecutor } from '../shellExecutor.js';
import { GET_ENVIRONMENT_INFO_FUNCTION_ID } from '../../common/workspace-functions.js';

// ── Use the exact SNS IDE constant from workspace-functions.ts ────────────────
// GET_ENVIRONMENT_INFO_FUNCTION_ID = 'getEnvironmentInfo'

export const getEnvironmentInfoTool: ToolRequest = {
  id: GET_ENVIRONMENT_INFO_FUNCTION_ID,
  name: 'getEnvironmentInfo',
  providerName: 'migration-environment',
  description:
    'Detects runtime versions (Node.js, Python, Java, Go, Rust, PHP, Ruby), package managers, ' +
    'and system environment info. Call once at the start of Phase 1 environment probe.',
  parameters: { type: 'object', properties: {}, required: [] },
  handler: async (_arg_string: string, ctx?: ToolContext) => {
    const results: Record<string, string> = {
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
    };

    const cmds: [string, string][] = [
      ['pythonVersion',  'python --version'],
      ['python3Version', 'python3 --version'],
      ['javaVersion',    'java -version'],
      ['goVersion',      'go version'],
      ['rustVersion',    'rustc --version'],
      ['phpVersion',     'php --version'],
      ['rubyVersion',    'ruby --version'],
      ['gitVersion',     'git --version'],
      ['dockerVersion',  'docker --version'],
      ['npmVersion',     'npm --version'],
      ['yarnVersion',    'yarn --version'],
      ['pnpmVersion',    'pnpm --version'],
      ['dotnetVersion',  'dotnet --version'],
    ];

    for (const [key, cmd] of cmds) {
      try {
        const res = await ShellExecutor.execute(ctx!.sessionId, cmd, { cwd: ctx!.legacyPath, timeoutMs: 5000 });
        results[key] = res.code === 0 ? (res.stdout || res.stderr || '').trim().split('\n')[0] : 'not installed';
      } catch {
        results[key] = 'not installed';
      }
    }
    return makeToolTextResult(JSON.stringify(results));
  }
};
