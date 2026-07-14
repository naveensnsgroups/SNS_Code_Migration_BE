// Wraps the E2B SDK to give the pipeline a real, isolated, per-session sandbox
// for the full-project verification check (Workstream 3) — see the design
// discussion: self-hosting Docker/gVisor was rejected in favor of a managed
// service specifically because guaranteed cleanup (E2B auto-expires a sandbox
// on timeout even if OUR code crashes before calling destroy()), resource
// limits, network policy, and isolation strength all come for free instead of
// being infrastructure this team would have to build and operate itself.
//
// Graceful degradation is load-bearing here, not an afterthought: no
// E2B_API_KEY configured, or the SDK call itself failing (bad key, quota,
// network), must never crash the migration pipeline — it just means this
// run's full-project check falls back to "sandbox unavailable", the same
// signal already used when no host toolchain was available.
import fs   from 'fs-extra';
import path from 'path';
import { Sandbox } from 'e2b';

export interface SandboxExecResult {
  exitCode: number;
  stdout:   string;
  stderr:   string;
}

export interface SandboxHandle {
  sessionId: string;
  // Working directory inside the sandbox where the project was uploaded —
  // callers pass paths relative to this, same convention capturedShellExecute
  // already uses for "cwd: modern root or a relative path from it".
  projectRoot: string;
  // envs: real environment variables (e.g. parsed from the generated project's
  // own .env file) made available to this ONE command — confirmed via E2B's
  // own SDK docs that commands.run accepts an `envs: Record<string,string>`
  // option scoped to that command. Without this, generated code that reads
  // os.getenv("DATABASE_URL") etc. has nothing real to read even inside the
  // sandbox that's supposed to prove it runs.
  execInSandbox(command: string, cwd?: string, timeoutSeconds?: number, envs?: Record<string, string>): Promise<SandboxExecResult>;
  destroy(): Promise<void>;
}

// E2B's public 'base' template already includes common language runtimes
// (Python, Node). A per-language custom template can be swapped in later
// (e.g. one pre-warmed with `uv` installed) without changing this function's
// signature or any caller — this is the one place that decision lives.
function resolveE2BTemplate(_language: string): string {
  return 'base';
}

const PROJECT_ROOT = '/home/user/project'; // E2B's default sandbox user's home directory

const SKIP_DIR_NAMES = new Set(['node_modules', '.git', '__pycache__', '.venv', 'dist', 'build']);

async function collectProjectFiles(hostProjectPath: string): Promise<{ path: string; data: string }[]> {
  const entries: { path: string; data: string }[] = [];

  async function walk(dir: string, relBase: string): Promise<void> {
    const items = await fs.readdir(dir, { withFileTypes: true });
    for (const item of items) {
      if (SKIP_DIR_NAMES.has(item.name)) continue;
      const abs = path.join(dir, item.name);
      const rel = relBase ? `${relBase}/${item.name}` : item.name;
      if (item.isDirectory()) {
        await walk(abs, rel);
      } else {
        const data = await fs.readFile(abs, 'utf-8');
        entries.push({ path: `${PROJECT_ROOT}/${rel}`, data });
      }
    }
  }

  await walk(hostProjectPath, '');
  return entries;
}

export async function provisionSandbox(
  sessionId:       string,
  targetStack:     { language: string },
  hostProjectPath: string
): Promise<SandboxHandle | null> {
  if (!process.env.E2B_API_KEY) return null;

  let sbx: Sandbox;
  try {
    sbx = await Sandbox.create(resolveE2BTemplate(targetStack.language), {
      apiKey:   process.env.E2B_API_KEY,
      metadata: { sessionId },
      timeoutMs: 15 * 60_000, // 15 min — generous for install + full-project check of a small generated project
    });
  } catch {
    return null; // provisioning failed (bad key, quota, network) — degrade the same as "not configured"
  }

  try {
    const files = await collectProjectFiles(hostProjectPath);
    if (files.length > 0) await sbx.files.writeFiles(files);
  } catch {
    await sbx.kill().catch(() => {});
    return null; // couldn't upload the project — nothing useful to check, degrade gracefully
  }

  return {
    sessionId,
    projectRoot: PROJECT_ROOT,
    execInSandbox: async (command, cwd, timeoutSeconds, envs) => {
      try {
        const result = await sbx.commands.run(command, {
          cwd: cwd ? `${PROJECT_ROOT}/${cwd}` : PROJECT_ROOT,
          timeoutMs: (timeoutSeconds ?? 300) * 1000,
          ...(envs && Object.keys(envs).length > 0 ? { envs } : {}),
        });
        return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
      } catch (err: any) {
        // commands.run THROWS CommandExitError on a non-zero exit code — it
        // implements CommandResult, so the real exitCode/stdout/stderr are
        // still on the caught error; extract them instead of losing that
        // information to a generic thrown exception the caller can't inspect.
        if (typeof err?.exitCode === 'number') {
          return { exitCode: err.exitCode, stdout: err.stdout ?? '', stderr: err.stderr ?? String(err.message ?? err) };
        }
        // A real infra failure (timeout, connection lost) — the caller treats
        // an unexpected throw as "this check didn't run", not "it failed".
        throw err;
      }
    },
    destroy: async () => { await sbx.kill(); },
  };
}
