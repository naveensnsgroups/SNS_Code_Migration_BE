// =============================================================================
//  tools/shellExecutor.ts
//  Mirrors: ShellExecutionServerImpl (snside/packages/ai-terminal/src/node/shell-execution-server-impl.ts)
//
//  Key facts from SNS IDE reference:
//  1. MAX_OUTPUT_SIZE = 1MB cap per stream (prevent memory blow-up)
//  2. detached=true on non-Windows (for process group kill via -pid)
//  3. windowsHide=true (prevent console windows from flashing on Windows)
//  4. killProcessTree uses taskkill /T /F on Windows (kills child processes too)
//  5. On close: timed_out detected via killed flag (not exit code 124)
//  6. Returns { code, stdout, stderr, duration, timedOut, canceled }
//  7. error event resolves (not rejects) — callers should check code !== 0
// =============================================================================

import { spawn, ChildProcess, execSync } from 'child_process';

const DEFAULT_TIMEOUT_MS = 120_000;  // 2 minutes (matches SNS IDE)
const MAX_TIMEOUT_MS     = 600_000;  // 10 minutes cap
const MAX_OUTPUT_SIZE    = 1024 * 1024; // 1 MB per stream

interface CommandOptions {
  cwd: string;
  onLog?: (message: string, isError: boolean) => void;
  timeoutMs?: number;
}

// ── Return type — matches ShellExecutionResult from SNS IDE ──────────────────
// Source: snside/packages/ai-terminal/src/common/shell-execution-server.ts
export interface ShellResult {
  code:        number;           // exitCode from SNS IDE (0=success, undefined→-1 for killed)
  stdout:      string;
  stderr:      string;
  error?:      string;
  duration:    number;
  timedOut:    boolean;          // derived from killed flag (not in SNS IDE directly)
  canceled?:   boolean;          // matches SNS IDE: canceled?: boolean
  resolvedCwd?: string;          // matches SNS IDE: resolvedCwd?: string
}

export class ShellExecutor {
  private static activeProcesses: Map<string, ChildProcess> = new Map();
  private static canceledSessions: Set<string>             = new Set();

  /**
   * Run a terminal command inside the specified working directory.
   * Mirrors ShellExecutionServerImpl.execute() from SNS IDE.
   *
   * Differences from SNS IDE (necessary for our standalone Express context):
   *  - Uses sessionId instead of executionId (same semantics)
   *  - onLog streams each line to SSE (SNS IDE uses Theia terminal widget)
   *  - FORCE_COLOR=1 so build tools produce coloured output in the FE terminal
   */
  static execute(
    sessionId: string,
    command: string,
    options: CommandOptions
  ): Promise<ShellResult> {
    const effectiveTimeout = Math.min(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
    const startTime = Date.now();

    return new Promise<ShellResult>(resolve => {
      options.onLog?.(`$ ${command}`, false);

      let stdout  = '';
      let stderr  = '';
      let killed  = false;
      let settled = false;

      // ── Spawn (matches SNS IDE spawn options exactly) ──────────────────────
      const child = spawn(command, [], {
        cwd:         options.cwd,
        shell:       true,
        detached:    process.platform !== 'win32', // process group kill on Unix
        windowsHide: true,                         // no console flash on Windows
        env: { ...process.env, FORCE_COLOR: '1' },
      });

      this.activeProcesses.set(sessionId, child);

      // ── Accumulate stdout (capped at 1 MB — matches SNS IDE) ──────────────
      child.stdout?.on('data', (data: Buffer) => {
        const str = data.toString();
        if (stdout.length < MAX_OUTPUT_SIZE) {
          stdout += str;
        }
        // Also stream each line to SSE terminal (our extension over SNS IDE)
        str.split(/\r?\n/).forEach(line => {
          if (line.trim()) options.onLog?.(line, false);
        });
      });

      // ── Accumulate stderr (capped at 1 MB — matches SNS IDE) ──────────────
      child.stderr?.on('data', (data: Buffer) => {
        const str = data.toString();
        if (stderr.length < MAX_OUTPUT_SIZE) {
          stderr += str;
        }
        str.split(/\r?\n/).forEach(line => {
          if (line.trim()) options.onLog?.(line, true);
        });
      });

      // ── Timeout (matches SNS IDE setTimeout → killProcessTree) ─────────────
      const timeoutTimer = setTimeout(() => {
        killed = true;
        options.onLog?.(
          `[Timeout] Command exceeded ${effectiveTimeout / 1000}s limit. Terminating.`,
          true
        );
        this.killProcessTree(child);
      }, effectiveTimeout);

      // ── Process close (matches SNS IDE 'close' handler) ────────────────────
      child.on('close', (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutTimer);
        this.activeProcesses.delete(sessionId);

        const duration    = Date.now() - startTime;
        const wasCanceled = this.canceledSessions.has(sessionId);
        this.canceledSessions.delete(sessionId);

        if (signal || killed) {
          resolve({
            code:        wasCanceled ? -2 : -1,
            stdout,
            stderr,
            duration,
            timedOut:    !wasCanceled && killed,
            canceled:    wasCanceled,
            resolvedCwd: options.cwd,
            error:       wasCanceled
              ? 'Command canceled by user'
              : `Command timed out after ${effectiveTimeout}ms`,
          });
        } else {
          resolve({
            code:        code ?? 0,
            stdout,
            stderr,
            duration,
            timedOut:    false,
            resolvedCwd: options.cwd,
          });
        }
      });

      // ── Process error (matches SNS IDE 'error' handler — resolves not rejects) ──
      child.on('error', (err: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutTimer);
        this.activeProcesses.delete(sessionId);
        this.canceledSessions.delete(sessionId);

        options.onLog?.(`[Command execution error]: ${err.message}`, true);

        // Resolve (not reject) so callers always get a result — check code !== 0
        resolve({
          code:        1,
          stdout,
          stderr,
          duration:    Date.now() - startTime,
          timedOut:    false,
          resolvedCwd: options.cwd,
          error:       err.message,
        });
      });
    });
  }

  /**
   * Kills any currently running command for a session.
   * Mirrors ShellExecutionServerImpl.cancel() + killProcessTree().
   */
  static kill(sessionId: string): boolean {
    const child = this.activeProcesses.get(sessionId);
    if (!child) return false;

    this.canceledSessions.add(sessionId);
    this.killProcessTree(child);
    this.activeProcesses.delete(sessionId);
    return true;
  }

  /**
   * Kills the process and its entire child tree.
   * Mirrors ShellExecutionServerImpl.killProcessTree().
   * On Windows: taskkill /T /F (terminate tree, force)
   * On Unix: kill(-pid, SIGTERM) on the process group
   */
  private static killProcessTree(child: ChildProcess): void {
    if (!child.pid) return;

    try {
      if (process.platform === 'win32') {
        // /T = kill entire process tree, /F = force
        execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: 'ignore' });
      } else {
        // Negative PID kills the whole process group (requires detached=true)
        process.kill(-child.pid, 'SIGTERM');
      }
    } catch {
      try {
        child.kill('SIGKILL');
      } catch {
        // Process already dead
      }
    }
  }
}
