// Small pieces shared across the three Stage-2 sub-stage runners
// (migration-planning-runner.ts, code-generation-runner.ts, verification-runner.ts).

import { MigrationTaskEntry } from '../types.js';

export type LogFn = (msg: string, lvl?: 'info' | 'success' | 'error' | 'warning') => void;

// Merges tasks that landed on the SAME targetFile into one task, so Code
// Generation never runs two separate write_file calls against the same path
// (each one fully overwrites the file — a real run confirmed this silently
// destroyed 3 of 4 legacy files' worth of translated logic in one router
// file, leaving only the last-written one on disk with zero warning anywhere).
// Order is preserved from the input list — the first member of a collision
// group becomes the primary task at that position; the rest are folded into
// mergedLegacyFiles and removed as standalone entries.
export function mergeTargetFileCollisions(tasks: MigrationTaskEntry[]): MigrationTaskEntry[] {
  const byTarget = new Map<string, MigrationTaskEntry[]>();
  for (const t of tasks) {
    const group = byTarget.get(t.targetFile);
    if (group) group.push(t); else byTarget.set(t.targetFile, [t]);
  }

  const merged: MigrationTaskEntry[] = [];
  const alreadyEmitted = new Set<string>();

  for (const t of tasks) {
    if (alreadyEmitted.has(t.targetFile)) continue;
    alreadyEmitted.add(t.targetFile);

    const group = byTarget.get(t.targetFile)!;
    if (group.length === 1) {
      merged.push(t);
      continue;
    }

    const groupLegacyFiles = new Set(group.map(g => g.legacyFile));
    const [primary, ...secondaries] = group;

    merged.push({
      ...primary,
      mergedLegacyFiles: secondaries.map(s => s.legacyFile),
      rulesInvolved: [...new Set(group.flatMap(g => g.rulesInvolved))],
      // Dependencies on another member of THIS SAME group are now internal to
      // one generation turn, not a real cross-task ordering dependency.
      dependsOn: [...new Set(group.flatMap(g => g.dependsOn))].filter(d => !groupLegacyFiles.has(d)),
    });
  }

  return merged;
}

export const PLANNING_BATCH_TIMEOUT_MS = 8 * 60_000;
export const GENERATION_TIMEOUT_MS     = 8 * 60_000;
export const RULE_CHECK_TIMEOUT_MS     = 5 * 60_000;
export const BUILD_CHECK_TIMEOUT_MS    = 10 * 60_000;

export function withTimeout<T>(operation: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`[MigrationAgent] "${label}" did not complete within ${Math.round(timeoutMs / 60_000)} min.`));
    }, timeoutMs);
    operation
      .then(result => { clearTimeout(timer); resolve(result); })
      .catch(err   => { clearTimeout(timer); reject(err);    });
  });
}

// Case-insensitive substrings that indicate the model wrote a description of
// what the code should do instead of the code itself — the exact failure mode
// found in a real run (a route file whose handlers were literal comments plus
// a hardcoded placeholder response, and an entrypoint that commented out its
// router registrations "for a future step" even though those routers already
// existed on disk). A file exists check alone cannot catch this — the file
// really was written, just not with real logic.
const STUB_MARKERS = [
  'implementation would go here',
  'would go here',
  'assuming these will be',
  'assuming this will be',
  'will be translated in subsequent steps',
  'in a real migration',
  'to be implemented',
  'not yet implemented',
  'todo: implement',
  'placeholder for',
];

export function findStubMarker(content: string): string | null {
  const lower = content.toLowerCase();
  for (const marker of STUB_MARKERS) {
    if (lower.includes(marker)) return marker;
  }
  return null;
}

export function guessExtension(targetLanguage: string): string {
  const lang = (targetLanguage || '').toLowerCase();
  if (lang.includes('typescript')) return '.ts';
  if (lang.includes('javascript')) return '.js';
  if (lang.includes('python'))     return '.py';
  if (lang.includes('java') && !lang.includes('javascript')) return '.java';
  if (lang.includes('c#') || lang.includes('csharp')) return '.cs';
  if (lang.includes('go'))         return '.go';
  if (lang.includes('rust'))       return '.rs';
  if (lang.includes('ruby'))       return '.rb';
  if (lang.includes('php'))        return '.php';
  if (lang.includes('kotlin'))     return '.kt';
  return '.txt'; // unknown target language — safest inert fallback, never invented
}

function sameStringSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const bSet = new Set(b);
  return a.every(x => bSet.has(x));
}

// A re-plan rebuilds the draft task list from scratch every time (target
// paths can legitimately change after editing Target Configuration). Without
// this, EVERY task resets to 'pending' on every /plan call — including ones
// already 'generated'/'verified' from a prior run whose path/dependencies
// didn't actually change — so the very next /generate silently redoes work
// that was already correct (and, combined with the collision-overwrite bug,
// destroys it a second time). A task keeps its prior status only when its
// identity (legacyFile), targetFile, dependsOn, and merged group are all
// unchanged from the previous plan — anything different is genuinely a new
// task and must start at 'pending'.
export function preservePriorTaskStatus(
  newTasks:      MigrationTaskEntry[],
  previousTasks: MigrationTaskEntry[]
): MigrationTaskEntry[] {
  if (previousTasks.length === 0) return newTasks;
  const previousByLegacyFile = new Map(previousTasks.map(t => [t.legacyFile, t]));

  return newTasks.map(t => {
    const prev = previousByLegacyFile.get(t.legacyFile);
    if (!prev) return t;

    const unchanged =
      prev.targetFile === t.targetFile &&
      sameStringSet(prev.dependsOn, t.dependsOn) &&
      sameStringSet(prev.mergedLegacyFiles ?? [], t.mergedLegacyFiles ?? []);

    if (!unchanged) return t;
    return { ...t, status: prev.status, lastError: prev.lastError };
  });
}

export function withExtension(filePath: string, ext: string): string {
  const dot = filePath.lastIndexOf('.');
  const base = dot > filePath.lastIndexOf('/') ? filePath.slice(0, dot) : filePath;
  return `${base}${ext}`;
}

// legacyFile marker prefix for a synthetic task with no real legacy source —
// scaffolding files a target framework's skill declares as required (see
// buildScaffoldingTasks below). buildCodeGeneratorUserPrompt checks for this
// prefix to skip the normal G1/G2 (read graphs / read legacy source) steps,
// since neither exists for a file that isn't translated from anything.
export const INFRASTRUCTURE_TASK_PREFIX = '__infrastructure__/';

// Generalizes what was originally a single hardcoded "always generate a DB
// connection module first" mechanism into "generate whatever scaffolding this
// target framework's skill file declares" — a shared DB module was only ever
// one specific case of a broader problem: every per-file translation was
// independently guessing framework conventions (DB access, app assembly, etc.)
// with nothing real to import or follow, confirmed in a real run as the direct
// cause of both a hedged stub (DB logic commented out) and a missing/incon-
// sistent app entrypoint. `skill` is null when no skill matched the target
// framework — in that case there is no curated scaffolding to add, and the
// pipeline falls back to today's guess-per-file behavior (with an explicit
// warning logged by the caller).
export function buildScaffoldingTasks(
  skill:     import('../../../knowledge/framework-skills/types.js').FrameworkSkill | null,
  realTasks: MigrationTaskEntry[] // mutated in place: scaffolding deps get added to dependsOn
): { firstTasks: MigrationTaskEntry[]; lastTasks: MigrationTaskEntry[] } {
  if (!skill || skill.scaffolding.length === 0) return { firstTasks: [], lastTasks: [] };

  const scaffoldingTasks: MigrationTaskEntry[] = skill.scaffolding.map(sf => ({
    legacyFile:    `${INFRASTRUCTURE_TASK_PREFIX}${sf.id}`,
    targetFile:    sf.targetFileHint,
    rulesInvolved: [],
    dependsOn:     [],
    status:        'pending' as const,
  }));

  const firstTasks = scaffoldingTasks.filter((_, i) => skill.scaffolding[i].order === 'first');
  const lastTasks  = scaffoldingTasks.filter((_, i) => skill.scaffolding[i].order === 'last');

  // Every real task may depend on every 'first' scaffolding task (e.g. the DB
  // connection module, the dependency manifest) — available from turn one.
  const firstLegacyFiles = firstTasks.map(t => t.legacyFile);
  for (const t of realTasks) t.dependsOn = [...t.dependsOn, ...firstLegacyFiles];

  // Every 'last' scaffolding task (the entrypoint) depends on every real task
  // AND every 'first' task — it only makes sense once everything it mounts exists.
  const everythingElse = [...realTasks.map(t => t.legacyFile), ...firstLegacyFiles];
  for (const t of lastTasks) t.dependsOn = everythingElse;

  return { firstTasks, lastTasks };
}

// Looks up the ScaffoldingFile.generationBrief matching a scaffolding task's
// legacyFile marker (e.g. "__infrastructure__/db-connection" -> the skill's
// "db-connection" entry) — used so the code generator gets the exact curated
// brief for THIS scaffolding kind, not a generic one-size-fits-all fallback.
export function resolveScaffoldingBrief(
  skill:      import('../../../knowledge/framework-skills/types.js').FrameworkSkill | null,
  legacyFile: string
): string | undefined {
  if (!skill || !legacyFile.startsWith(INFRASTRUCTURE_TASK_PREFIX)) return undefined;
  const id = legacyFile.slice(INFRASTRUCTURE_TASK_PREFIX.length);
  return skill.scaffolding.find(sf => sf.id === id)?.generationBrief;
}
