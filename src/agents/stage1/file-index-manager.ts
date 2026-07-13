// FILE_INDEX key-resolution, normalization, and reconciliation — a distinct
// dedup/merge/path-validation concern that was previously bolted onto
// planner-agent.ts alongside the actual phase-sequencing logic.
import fs   from 'fs-extra';
import path from 'path';
import { TaskContextManager } from '../../session/taskContext.js';
import { LogFn } from '../core/agent-concurrency-utils.js';

const FILE_INDEX_CANDIDATE_KEYS = ['file_index', 'file-index', 'FILE_INDEX'] as const;

export function resolveFileIndexFromContext(ctx: Record<string, unknown>): { key: string; entries: any[] } {

  const indirectKey = ctx['FILE_INDEX_KEY'] as string | undefined;
  if (indirectKey && Array.isArray(ctx[indirectKey]) && (ctx[indirectKey] as any[]).length > 0) {
    return { key: indirectKey, entries: ctx[indirectKey] as any[] };
  }

  for (const candidate of FILE_INDEX_CANDIDATE_KEYS) {
    const val = ctx[candidate];
    if (Array.isArray(val) && val.length > 0) {
      return { key: candidate, entries: val as any[] };
    }
  }

  for (const [k, v] of Object.entries(ctx)) {
    if (
      Array.isArray(v) && v.length > 0 &&
      typeof (v as any[])[0] === 'object' &&
      (v as any[])[0] !== null &&
      'path' in (v as any[])[0] &&
      'read_status' in (v as any[])[0]
    ) {
      return { key: k, entries: v as any[] };
    }
  }

  return { key: indirectKey ?? 'file_index', entries: [] };
}

// Merges every FILE_INDEX key variant the LLM may have written ("file_index",
// "FILE_INDEX", "fileIndex", ...) into the single canonical "file-index" key,
// deduplicates by path (DONE wins over PENDING), validates paths on disk, and
// purges the alternate keys. Runs after discovery AND after every analysis pass,
// so a mis-keyed save-back mid-analysis can never permanently orphan progress.
export async function normalizeFileIndexKeys(
  sessionId:  string,
  legacyPath: string,
  onLog?:     LogFn
): Promise<void> {
  try {
    const staleCtx = await TaskContextManager.getContext(sessionId);

    // Collect every possible key the LLM may have used
    const CANDIDATE_KEYS = ['file-index', 'file_index', 'FILE_INDEX', 'fileIndex'] as const;
    const foundArrays = new Map<string, any[]>();
    for (const key of CANDIDATE_KEYS) {
      const val = staleCtx[key];
      if (Array.isArray(val) && val.length > 0) {
        foundArrays.set(key, val as any[]);
      }
    }

    if (foundArrays.size === 0) return;

    // Fast path: only the canonical key exists — nothing to merge or purge.
    if (foundArrays.size === 1 && foundArrays.has('file-index')) {
      if (staleCtx['FILE_INDEX_KEY'] !== 'file-index') {
        await TaskContextManager.updateContext(sessionId, { FILE_INDEX_KEY: 'file-index' });
      }
      return;
    }

    // Flatten all entries from all found keys
    const allEntries: any[] = Array.from(foundArrays.values()).flat();

    // ── Deduplicate by path ─────────────────────────────────────────────
    // Strategy: for the same logical file, keep the entry with:
    //   1. DONE status (over PENDING)
    //   2. Longer/more complete path (fix truncated path bug)
    const byPath = new Map<string, any>();
    for (const entry of allEntries) {
      const entryPath: string | undefined = entry?.path;
      if (!entryPath || typeof entryPath !== 'string') continue;

      const existing = byPath.get(entryPath);
      if (!existing) {
        byPath.set(entryPath, entry);
      } else {
        // Prefer DONE over PENDING
        const existingDone = existing.read_status === 'DONE';
        const entryDone    = entry.read_status    === 'DONE';
        if (!existingDone && entryDone) {
          byPath.set(entryPath, entry);
        }
      }
    }

    // ── Cross-key reconciliation: same basename, different paths ────────
    // Handles the truncated-path bug where file_index used shortened paths
    // and file-index used the full correct paths.
    // Prefer DONE status from any key for files with matching basenames.
    if (foundArrays.size > 1) {
      const allPaths = Array.from(byPath.keys());
      for (const p of allPaths) {
        const basename = path.basename(p);
        // Find any other entry with the same basename but different path
        for (const [otherPath, otherEntry] of byPath) {
          if (otherPath !== p && path.basename(otherPath) === basename) {
            // Two entries resolve to the same file — keep longer (fuller) path with DONE priority
            const current = byPath.get(p)!;
            const keepLonger  = p.length >= otherPath.length;
            const keepPath    = keepLonger ? p : otherPath;
            const dropPath    = keepLonger ? otherPath : p;
            const keepEntry   = keepLonger ? current : otherEntry;
            const dropEntry   = keepLonger ? otherEntry : current;
            // If the shorter path has DONE and longer is PENDING, merge status
            const mergedStatus =
              dropEntry.read_status === 'DONE' || keepEntry.read_status === 'DONE'
                ? 'DONE'
                : 'PENDING';
            byPath.set(keepPath, { ...keepEntry, read_status: mergedStatus });
            byPath.delete(dropPath);
            break;
          }
        }
      }
    }

    const merged: any[] = Array.from(byPath.values());

    // ── Path validation: detect suspicious/truncated paths ─────────────
    let pathErrorCount = 0;
    const validatedMerged = await Promise.all(
      merged.map(async (entry: any) => {
        if (!entry?.path) return entry;
        const abs = path.join(legacyPath, entry.path);
        try {
          const exists = await fs.pathExists(abs);
          if (!exists) {
            pathErrorCount++;
            return { ...entry, read_status: 'PATH_ERROR' };
          }
        } catch { /* fs errors treated as non-blocking */ }
        return entry;
      })
    );

    if (pathErrorCount > 0) {
      onLog?.(
        `[PlannerAgent] FILE_INDEX path validation: ${pathErrorCount} entries point to ` +
        `non-existent files (marked PATH_ERROR). This is usually caused by the Discovery Agent ` +
        `writing truncated paths. These files will be skipped in Phase 2.`,
        'warning'
      );
    }

    // ── Compute accurate source file count ────────────────────────────
    const totalSourceFiles = validatedMerged.filter(
      (e: any) => e?.type === 'source' && e?.read_status !== 'PATH_ERROR'
    ).length;

    // ── Compute total estimated lines ONCE, deterministically ─────────
    // Section 1 and Section 4 are separate isolated LLM calls; each summing
    // estimatedLines itself let their totals silently disagree (arithmetic is
    // not something to delegate to an LLM). Compute it here and have both
    // sections read this fixed counter instead of re-summing it themselves.
    const totalEstimatedLines = validatedMerged.reduce(
      (sum: number, e: any) => sum + (typeof e?.estimatedLines === 'number' ? e.estimatedLines : 0),
      0
    );

    // ── Save canonical index + clear all alternate keys ───────────────
    const patch: Record<string, any> = {
      'file-index':            validatedMerged,
      'FILE_INDEX_KEY':        'file-index',
      'TOTAL_SOURCE_FILES':    totalSourceFiles,
      'TOTAL_ESTIMATED_LINES': totalEstimatedLines,
    };
    for (const key of foundArrays.keys()) {
      if (key !== 'file-index') patch[key] = null; // purge alternate keys
    }
    await TaskContextManager.updateContext(sessionId, patch);

    const keyNames = [...foundArrays.keys()].join(', ');
    onLog?.(
      `[PlannerAgent] FILE_INDEX normalized: merged ${allEntries.length} raw entries ` +
      `from [${keyNames}] → ${validatedMerged.length} unique entries in "file-index". ` +
      `Source files: ${totalSourceFiles}. Path errors: ${pathErrorCount}.`,
      'info'
    );
  } catch (normErr: any) {
    onLog?.(
      `[PlannerAgent] FILE_INDEX normalization warning: ${normErr?.message ?? String(normErr)}. Continuing.`,
      'warning'
    );
  }
}

export async function cleanupAnalysisKeys(sessionId: string): Promise<void> {
  const ctx          = await TaskContextManager.getContext(sessionId);
  const analysisKeys = Object.keys(ctx).filter(k => k.startsWith('analysis:'));
  if (analysisKeys.length === 0) return;

  const deletions: Record<string, null> = {};
  analysisKeys.forEach(k => { deletions[k] = null; });
  try {
    await TaskContextManager.updateContext(sessionId, deletions);
  } catch {

  }
}

export async function reconcileFileDoneStatus(
  sessionId:  string,
  modernPath: string
): Promise<number> {
  const analysisDir = path.join(modernPath, '_analysis');
  if (!(await fs.pathExists(analysisDir))) return 0;

  const allSources = new Set<string>();
  try {
    const dirEntries = await fs.readdir(analysisDir);
    for (const entry of dirEntries) {
      if (!entry.endsWith('-graph.json')) continue;
      try {
        const graphData = await fs.readJson(path.join(analysisDir, entry)) as Record<string, unknown>;
        if (Array.isArray(graphData._sources)) {
          for (const src of graphData._sources as string[]) {

            if (src && !src.startsWith('_resolver/')) {
              allSources.add(src);
            }
          }
        }
      } catch {  }
    }
  } catch { return 0; }

  if (allSources.size === 0) return 0;

  const ctx = await TaskContextManager.getContext(sessionId);
  const { key: fileIndexKey, entries: fileIndex } = resolveFileIndexFromContext(ctx as Record<string, unknown>);
  if (fileIndex.length === 0) return 0;

  let updatedCount = 0;

  const NON_CODE_BASENAMES = new Set([
    'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'npm-shrinkwrap.json',
    'poetry.lock', 'pipfile.lock', 'cargo.lock', 'composer.lock', 'gemfile.lock', 'go.sum',
    '.gitignore', '.gitattributes', '.npmignore', '.dockerignore', '.eslintignore',
    '.prettierignore', '.editorconfig', '.nvmrc', '.node-version',
    'license', 'license.md', 'license.txt', 'changelog.md', 'changelog.txt',
    'contributing.md', 'security.md', 'readme.md', 'readme.rst', 'readme.txt', 'notice',
  ]);
  const NON_CODE_EXTENSIONS = new Set([
    '.lock', '.log', '.map',
    '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico',
    '.woff', '.woff2', '.ttf', '.eot', '.otf',
  ]);

  const NON_CODE_TYPES = new Set(['doc', 'asset']);

  for (const entry of fileIndex) {
    if (entry?.read_status === 'DONE') continue;

    if (allSources.has(entry?.path)) {
      entry.read_status = 'DONE';
      updatedCount++;
      continue;
    }

    if (entry?.path) {
      const basename  = path.basename(entry.path).toLowerCase();
      const extension = path.extname(entry.path).toLowerCase();
      const fileType  = (entry.type ?? '').toLowerCase();
      if (
        NON_CODE_TYPES.has(fileType) ||
        NON_CODE_BASENAMES.has(basename) ||
        NON_CODE_EXTENSIONS.has(extension)
      ) {
        entry.read_status = 'DONE';
        updatedCount++;
      }
    }
  }

  if (updatedCount === 0) return 0;

  try {
    await TaskContextManager.updateContext(sessionId, { [fileIndexKey]: fileIndex });
  } catch {  }

  return updatedCount;
}
