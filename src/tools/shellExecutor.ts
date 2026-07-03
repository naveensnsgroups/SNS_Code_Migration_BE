

import { spawn, ChildProcess, execSync } from 'child_process';

const DEFAULT_TIMEOUT_MS = 120_000;  
const MAX_TIMEOUT_MS     = 600_000;  
const MAX_OUTPUT_SIZE    = 1024 * 1024; 

interface CommandOptions {
  cwd: string;
  onLog?: (message: string, isError: boolean) => void;
  timeoutMs?: number;
}

export interface ShellResult {
  code:        number;           
  stdout:      string;
  stderr:      string;
  error?:      string;
  duration:    number;
  timedOut:    boolean;          
  canceled?:   boolean;          
  resolvedCwd?: string;          
}

export class ShellExecutor {
  private static activeProcesses: Map<string, ChildProcess> = new Map();
  private static canceledSessions: Set<string>             = new Set();

  
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

      
      const child = spawn(command, [], {
        cwd:         options.cwd,
        shell:       true,
        detached:    process.platform !== 'win32', 
        windowsHide: true,                         
        env: { ...process.env, FORCE_COLOR: '1' },
      });

      this.activeProcesses.set(sessionId, child);

      
      child.stdout?.on('data', (data: Buffer) => {
        const str = data.toString();
        if (stdout.length < MAX_OUTPUT_SIZE) {
          stdout += str;
        }
        
        str.split(/\r?\n/).forEach(line => {
          if (line.trim()) options.onLog?.(line, false);
        });
      });

      
      child.stderr?.on('data', (data: Buffer) => {
        const str = data.toString();
        if (stderr.length < MAX_OUTPUT_SIZE) {
          stderr += str;
        }
        str.split(/\r?\n/).forEach(line => {
          if (line.trim()) options.onLog?.(line, true);
        });
      });

      
      const timeoutTimer = setTimeout(() => {
        killed = true;
        options.onLog?.(
          `[Timeout] Command exceeded ${effectiveTimeout / 1000}s limit. Terminating.`,
          true
        );
        this.killProcessTree(child);
      }, effectiveTimeout);

      
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

      
      child.on('error', (err: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutTimer);
        this.activeProcesses.delete(sessionId);
        this.canceledSessions.delete(sessionId);

        options.onLog?.(`[Command execution error]: ${err.message}`, true);

        
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

  
  static kill(sessionId: string): boolean {
    const child = this.activeProcesses.get(sessionId);
    if (!child) return false;

    this.canceledSessions.add(sessionId);
    this.killProcessTree(child);
    this.activeProcesses.delete(sessionId);
    return true;
  }

  
  private static killProcessTree(child: ChildProcess): void {
    if (!child.pid) return;

    try {
      if (process.platform === 'win32') {
        
        execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: 'ignore' });
      } else {
        
        process.kill(-child.pid, 'SIGTERM');
      }
    } catch {
      try {
        child.kill('SIGKILL');
      } catch {
        
      }
    }
  }
}
