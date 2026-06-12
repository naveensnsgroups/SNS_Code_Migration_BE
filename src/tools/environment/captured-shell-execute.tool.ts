// =============================================================================
//  tools/environment/captured-shell-execute.tool.ts
//  Mirrors: CapturedShellExecution (snside migration-shell-capture-tool.ts)
//
//  Key facts from SNS IDE reference:
//  1. Returns: exit_code, stdout_tail, stderr_tail, timed_out, log_path, cwd, command
//  2. Parameter is timeoutSeconds (NOT timeoutMs) — default 300
//  3. Writes full output to .migration-agent/shell-[timestamp].log in modernPath
//  4. cwd supports: "legacy", "modern", "." (workspace root), or relative from modernPath
//  5. cat/type/head/tail/less BLOCKED — use getFileContent or batch-read-files
// =============================================================================

import fs from 'fs-extra';
import path from 'path';
import { ToolRequest } from '../../types/tool.js';
import { ToolContext } from '../../types/tool.js';
import { makeToolTextResult } from '../../types/language-model.js';
import { ShellExecutor } from '../shellExecutor.js';
import { CAPTURED_SHELL_EXECUTION_ID } from '../../common/workspace-functions.js';

// ── Response shape — exact match of CapturedShellResult from SNS IDE ─────────
// Source: snside/packages/ai-ide/src/browser/migration-shell-capture-tool.ts
interface CapturedShellResult {
  exit_code:   number | null;  // null when process killed/timed-out (SNS IDE: number | null)
  stdout_tail: string;
  stderr_tail: string;
  timed_out:   boolean;
  log_path:    string;
  command:     string;
  cwd:         string;
}

// ── File-read commands blocked on Windows (CWD mismatch causes "file not found") ──
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

    // ── Block file-reading shell commands ──────────────────────────────────────
    // cat/type/head/tail/less fail on Windows because CWD is NEVER the legacy root.
    // Use getFileContent or batch-read-files to read source files.
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

    // ── Resolve working directory ──────────────────────────────────────────────
    // Mirrors SNS IDE: resolves cwd relative to modernPath (workspace root for output)
    const modernPath  = ctx!.modernPath;
    const legacyPath  = ctx!.legacyPath;

    const workingDir =
      args.cwd === 'legacy'                    ? legacyPath :
      args.cwd === 'modern' || args.cwd === '.' || !args.cwd ? modernPath :
      path.isAbsolute(args.cwd)               ? args.cwd :
      path.join(modernPath, args.cwd);          // relative from modern root

    const timeoutMs = (args.timeoutSeconds ?? 300) * 1000;
    const timestamp = Date.now();

    // ── Execute ────────────────────────────────────────────────────────────────
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

    // ── Write log file (mirrors SNS IDE .migration-agent/shell-[ts].log) ──────
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
      // Non-fatal — log file write failure must not crash the tool
    }

    // ── Build response (exact SNS IDE CapturedShellResult shape) ──────────────
    const stdoutLines = (res.stdout || '').split('\n');
    const stderrLines = (res.stderr || '').split('\n');

    const response: CapturedShellResult = {
      exit_code:   res.timedOut || res.canceled ? null : (res.code ?? -1), // null when killed
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

