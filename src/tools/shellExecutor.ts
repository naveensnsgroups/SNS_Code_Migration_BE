import { spawn, ChildProcess } from 'child_process';

interface CommandOptions {
  cwd: string;
  onLog: (message: string, isError: boolean) => void;
  timeoutMs?: number;
}

export class ShellExecutor {
  private static activeProcesses: Map<string, ChildProcess> = new Map();

  /**
   * Run a terminal command inside the specified workspace directory.
   * Streams stdout and stderr line-by-line.
   */
  static execute(
    sessionId: string,
    command: string,
    options: CommandOptions
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      options.onLog(`$ ${command}`, false);

      // Windows requires shell: true to resolve commands like 'npm' or 'npx'
      const child = spawn(command, {
        cwd: options.cwd,
        shell: true,
        env: { ...process.env, FORCE_COLOR: '1' },
      });

      this.activeProcesses.set(sessionId, child);

      let stdoutAccumulator = '';
      let stderrAccumulator = '';
      let isSettled = false;

      // Handle timeout
      let timeoutTimer: NodeJS.Timeout | null = null;
      if (options.timeoutMs) {
        timeoutTimer = setTimeout(() => {
          if (!isSettled) {
            options.onLog(`[Timeout] Command exceeded limit of ${options.timeoutMs}ms. Terminating.`, true);
            this.kill(sessionId);
            isSettled = true;
            reject(new Error(`Command timed out after ${options.timeoutMs}ms`));
          }
        }, options.timeoutMs);
      }

      // Stream stdout line-by-line
      child.stdout?.on('data', (data) => {
        const str = data.toString();
        stdoutAccumulator += str;
        
        // Split and send each full line
        const lines = str.split(/\r?\n/);
        for (const line of lines) {
          if (line.trim()) {
            options.onLog(line, false);
          }
        }
      });

      // Stream stderr line-by-line
      child.stderr?.on('data', (data) => {
        const str = data.toString();
        stderrAccumulator += str;

        const lines = str.split(/\r?\n/);
        for (const line of lines) {
          if (line.trim()) {
            options.onLog(line, true);
          }
        }
      });

      child.on('error', (err) => {
        if (isSettled) return;
        isSettled = true;
        if (timeoutTimer) clearTimeout(timeoutTimer);
        this.activeProcesses.delete(sessionId);
        
        options.onLog(`[Command execution error]: ${err.message}`, true);
        reject(err);
      });

      child.on('close', (code) => {
        if (isSettled) return;
        isSettled = true;
        if (timeoutTimer) clearTimeout(timeoutTimer);
        this.activeProcesses.delete(sessionId);

        const exitCode = code ?? 0;
        resolve({
          code: exitCode,
          stdout: stdoutAccumulator,
          stderr: stderrAccumulator,
        });
      });
    });
  }

  /**
   * Kills any currently running command for a session.
   */
  static kill(sessionId: string): boolean {
    const childProcess = this.activeProcesses.get(sessionId);
    if (childProcess) {
      optionsLog(sessionId, '⚠️ Terminating active shell command...', 'warning');
      
      // On Windows, taskkill is safer to kill spawned processes and their trees
      if (childProcess.pid) {
        try {
          if (globalThis.process.platform === 'win32') {
            spawn('taskkill', ['/pid', childProcess.pid.toString(), '/f', '/t']);
          } else {
            childProcess.kill('SIGTERM');
          }
        } catch {
          childProcess.kill('SIGKILL');
        }
      }
      this.activeProcesses.delete(sessionId);
      return true;
    }
    return false;
  }
}

// Internal helper for logging when manager is not fully initialized or routing is needed
function optionsLog(sessionId: string, message: string, level: 'info' | 'warning' | 'error') {
  // Broadcaster handles log distribution; we will wire this into Express server's log broadcaster
  console.log(`[ShellExecutor][Session ${sessionId}] [${level.toUpperCase()}] ${message}`);
}
