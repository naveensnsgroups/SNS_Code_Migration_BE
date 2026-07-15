

import fs from 'fs-extra';
import path from 'path';
import { ToolRequest } from '../../types/tool.js';
import { ToolContext } from '../../types/tool.js';
import { makeToolTextResult } from '../../types/language-model.js';
import { ShellExecutor } from '../shellExecutor.js';
import { CAPTURED_SHELL_EXECUTION_ID } from '../../common/workspace-functions.js';

interface CapturedShellResult {
  exit_code:   number | null;  
  stdout_tail: string;
  stderr_tail: string;
  timed_out:   boolean;
  log_path:    string;
  command:     string;
  cwd:         string;
}

const FILE_READ_PREFIXES = ['cat ', 'cat\t', 'type ', 'head ', 'tail ', 'less ', 'more '];

export const capturedShellExecuteTool: ToolRequest = {
  id: CAPTURED_SHELL_EXECUTION_ID,
  name: 'capturedShellExecute',
  providerName: 'migration-environment',
  description:
    'Executes a shell command and captures stdout + stderr output. ' +
    'Returns a structured result with exit_code, stdout_tail (last 200 lines), ' +
    'stderr_tail (last 200 lines), timed_out flag, and the path to the full log file. ' +
    'Use this instead of shellExecute whenever you need to READ the command output — ' +
    'for example: npm install, pip install, pytest, go test, cargo build, mvn package. ' +
    'The exit_code field tells you whether the command succeeded (0) or failed (non-zero). ' +
    'The stderr_tail contains the first error line for classification. ' +
    'If timed_out=true, the command exceeded the timeout — retry with a shorter variant. ' +
    'DO NOT use this to read file content — cat, type, head, tail, less are BLOCKED. ' +
    'Use getFileContent or batch-read-files to read source files instead.',
  parameters: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'The shell command to run. Example: "npm install" or "python -m pytest tests/"'
      },
      cwd: {
        type: 'string',
        description:
          'Working directory. Use "legacy" for the source project root, "modern" or "." for the output project root, ' +
          'or a relative path from the modern root (e.g. "backend/"). Default: modern root.'
      },
      timeoutSeconds: {
        type: 'number',
        description: 'Maximum seconds to wait before killing the process. Default: 300 (5 min). Use 120 for builds, 60 for tests.'
      }
    },
    required: ['command']
  },
  handler: async (arg_string: string, ctx?: ToolContext) => {
    const args: { command: string; cwd?: string; timeoutSeconds?: number } = JSON.parse(arg_string || '{}');

    
    
    
    const cmdTrimmed = (args.command || '').trimStart().toLowerCase();
    if (FILE_READ_PREFIXES.some(p => cmdTrimmed.startsWith(p))) {
      const result: Partial<CapturedShellResult> & { error: string } = {
        exit_code: 1,
        timed_out: false,
        command: args.command,
        error:
          'BLOCKED: Shell commands cannot read source files on Windows — CWD is not the project root. ' +
          'Use getFileContent({ file: "relative/path/from/workspace/root" }) or ' +
          'batch-read-files({ files: [{ path: "..." }] }) instead.',
      };
      return makeToolTextResult(JSON.stringify(result));
    }

    // During the full-project verification stage (Workstream 3), ctx.sandbox
    // is set and every command runs inside the real, isolated E2B sandbox
    // instead of this host machine — same tool, same schema, only the
    // execution target changes. "legacy"/"modern" cwd distinctions don't apply
    // inside the sandbox (only the generated project was uploaded there); a
    // relative path is passed through as-is, relative to the uploaded project root.
    if (ctx?.sandbox) {
      const sandboxCwd = (args.cwd && args.cwd !== 'modern' && args.cwd !== '.' && args.cwd !== 'legacy')
        ? args.cwd
        : undefined;
      // Real env vars (parsed from the generated project's own .env, see
      // verification-runner.ts) are injected transparently into every
      // sandboxed command — never requested by the agent itself.
      const sandboxResult = await ctx.sandbox.execInSandbox(args.command, sandboxCwd, args.timeoutSeconds, ctx.envs);
      const response: CapturedShellResult = {
        exit_code:   sandboxResult.exitCode,
        stdout_tail: sandboxResult.stdout.split('\n').slice(-200).join('\n').trim(),
        stderr_tail: sandboxResult.stderr.split('\n').slice(-200).join('\n').trim(),
        timed_out:   false,
        log_path:    '(ran in the verification sandbox — no host log file)',
        command:     args.command,
        cwd:         sandboxCwd ?? '(sandbox project root)',
      };
      return makeToolTextResult(JSON.stringify(response, null, 2));
    }

    const modernPath  = ctx!.modernPath;
    const legacyPath  = ctx!.legacyPath;

    const workingDir =
      args.cwd === 'legacy'                    ? legacyPath :
      args.cwd === 'modern' || args.cwd === '.' || !args.cwd ? modernPath :
      path.isAbsolute(args.cwd)               ? args.cwd :
      path.join(modernPath, args.cwd);          

    const timeoutMs = (args.timeoutSeconds ?? 300) * 1000;
    const timestamp = Date.now();

    
    let res: Awaited<ReturnType<typeof ShellExecutor.execute>>;
    try {
      res = await ShellExecutor.execute(ctx!.sessionId, args.command, {
        cwd: workingDir,
        timeoutMs,
        onLog: (msg, isErr) => ctx!.onLog?.(msg, isErr ? 'error' : 'info'),
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res = { code: 1, stdout: '', stderr: msg, duration: 0, timedOut: false, error: msg };
    }

    
    const logRelPath = `.migration-agent/shell-${timestamp}.log`;
    const logAbsPath = path.join(modernPath, logRelPath);
    const logContent =
      `Command: ${args.command}\n` +
      `Working Directory: ${workingDir}\n` +
      `Exit Code: ${res.code}\n` +
      `Duration: ${res.duration}ms\n` +
      `Timed Out: ${res.timedOut}\n` +
      `\n--- STDOUT ---\n${res.stdout || ''}\n` +
      `\n--- STDERR ---\n${res.stderr || ''}\n`;

    try {
      await fs.ensureDir(path.dirname(logAbsPath));
      await fs.writeFile(logAbsPath, logContent, 'utf-8');
    } catch {
      
    }

    
    const stdoutLines = (res.stdout || '').split('\n');
    const stderrLines = (res.stderr || '').split('\n');

    const response: CapturedShellResult = {
      exit_code:   res.timedOut || res.canceled ? null : (res.code ?? -1), 
      stdout_tail: stdoutLines.slice(-200).join('\n').trim(),
      stderr_tail: stderrLines.slice(-200).join('\n').trim(),
      timed_out:   res.timedOut,
      log_path:    logRelPath,
      command:     args.command,
      cwd:         workingDir,
    };

    return makeToolTextResult(JSON.stringify(response, null, 2));
  }
};

