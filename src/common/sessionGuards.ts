// Server-side enforcement of rules the frontend only *represents* via disabled/
// hidden UI (a locked Target Configuration, Stop/Pause only shown while
// running). Any of these HTTP endpoints can be hit directly, bypassing the
// frontend entirely, so the same rules must be re-checked here.
import { TargetStack, MigrationStatus } from '../types.js';

// Field-by-field comparison, mirroring the frontend's own "is this the same
// value" check (StackBadge.tsx's LayerRow) — trimmed, case-insensitive.
export function targetStackEquals(a: TargetStack, b: TargetStack): boolean {
  const norm = (s: string | undefined) => (s ?? '').trim().toLowerCase();
  return (
    norm(a.framework)     === norm(b.framework) &&
    norm(a.database)      === norm(b.database) &&
    norm(a.language)      === norm(b.language) &&
    norm(a.testFramework) === norm(b.testFramework)
  );
}

// Stage-1 pipeline statuses during which Stop/Pause are meaningful — mirrors
// the frontend's useMigration.ts `isRunning` derivation.
export const STAGE1_RUNNING_STATUSES: ReadonlySet<MigrationStatus> = new Set([
  'scanning', 'planning', 'discovery', 'file-analysis',
  'graph-resolution', 'section-writing', 'assembly',
]);
