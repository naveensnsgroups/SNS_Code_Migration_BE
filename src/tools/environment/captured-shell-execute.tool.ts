// =============================================================================
//  tools/environment/captured-shell-execute.tool.ts
//  Mirrors: CapturedShellExecution (snside migration-shell-capture-tool.ts)
// =============================================================================

import path from 'path';
import { ToolRequest } from '../../types/tool.js';

import { ToolContext } from '../../types/tool.js';
import { makeToolTextResult, makeToolErrorResult } from '../../types/language-model.js';

import { ShellExecutor } from '../shellExecutor.js';
import { CAPTURED_SHELL_EXECUTION_ID } from '../../common/workspace-functions.js';

// ── Use the exact SNS IDE constant name from workspace-functions.ts ───────────
// CAPTURED_SHELL_EXECUTION_ID = 'capturedShellExecute'
// Do NOT export a renamed variant — always use the SNS IDE name.

export const capturedShellExecuteTool: ToolRequest = {
  id: CAPTURED_SHELL_EXECUTION_ID,
  name: 'capturedShellExecute',
  providerName: 'migration-environment',
  description:
    'Runs a shell command and returns the FULL captured stdout + stderr output. ' +
    'Unlike run_command, this returns the complete output buffer (last 200 lines). ' +
    'Use for running build tools, package managers, test runners, and linters where full output is needed.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The shell command to execute.' },
      cwd: { type: 'string', description: 'Working directory: "legacy" (source), "modern" (output), or an absolute path. Defaults to "modern".' },
      timeoutMs: { type: 'number', description: 'Timeout in milliseconds (default: 60000).' }
    },
    required: ['command']
  },
  handler: async (arg_string: string, ctx?: ToolContext) => {
    const args: { command: string; cwd?: string; timeoutMs?: number } = JSON.parse(arg_string || '{}');
    const workingDir =
      args.cwd === 'legacy' ? ctx!.legacyPath :
      args.cwd === 'modern' ? ctx!.modernPath :
      (args.cwd && path.isAbsolute(args.cwd)) ? args.cwd :
      ctx!.modernPath;

    const res = await ShellExecutor.execute(ctx!.sessionId, args.command, {
      cwd: workingDir,
      timeoutMs: args.timeoutMs ?? 60000,
      onLog: (msg, isErr) => ctx!.onLog?.(msg, isErr ? 'error' : 'info'),
    });

    const allOutput = [res.stdout, res.stderr].filter(Boolean).join('\n');
    const tails = allOutput.split('\n').slice(-200).join('\n');
    return makeToolTextResult(JSON.stringify({ exitCode: res.code, stdout: res.stdout, stderr: res.stderr, tails, timedOut: res.code === 124, command: args.command }));
  }
};
