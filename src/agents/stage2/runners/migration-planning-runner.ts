// Migration Planning sub-stage: builds the per-file task list (target path +
// rulesInvolved + dependsOn) and the Rule Coverage Manifest, then saves both
// onto the session for the human checkpoint. No code is written in this stage.
import { DetectedStack, TargetStack } from '../../../types.js';
import { toolRegistry }               from '../../../core/tool-invocation-registry.js';
import { ToolContext }                from '../../../types/tool.js';
import { AgentExecutor }              from '../../core/agentExecutor.js';
import { TaskContextManager }         from '../../../session/taskContext.js';
import { SessionManager }             from '../../../session/sessionManager.js';
import { resolveStreamingProvider }   from '../../../ai/index.js';
import { MIGRATION_PLANNER_AGENT }    from '../../core/agent-definitions.js';
import {
  MIGRATION_PLANNER_SYSTEM_PROMPT,
  buildMigrationPlannerUserPrompt,
} from '../../../prompts/migration-planner-prompt.js';
import { buildDraftMigrationTasks, DraftMigrationTask } from '../migration-planner.js';
import { MigrationTaskEntry, RuleCoverageEntry } from '../types.js';
import { LogFn, PLANNING_BATCH_TIMEOUT_MS, withTimeout, guessExtension, withExtension, mergeTargetFileCollisions, preservePriorTaskStatus, buildScaffoldingTasks } from './shared.js';
import { resolveFrameworkSkill } from '../../../knowledge/framework-skills/registry.js';
import { checkImportsGraphSanity } from '../../stage1/graph-resolver.js';

// Same tiered shape as Stage 1's batch-size heuristic — smaller batches once the
// total file count grows, so a single LLM turn's output (one path per file)
// stays comfortably within a normal response, regardless of project size.
function computePlanningBatchSize(totalCount: number): number {
  if (totalCount < 30)  return 15;
  if (totalCount < 100) return 10;
  if (totalCount < 300) return 6;
  return 4;
}

export async function runPlanning(
  sessionId:     string,
  legacyPath:    string,
  modernPath:    string,
  detectedStack: DetectedStack,
  targetStack:   TargetStack,
  onLog?:        LogFn,
  onProgress?:   (percent: number) => void,
): Promise<void> {
  onLog?.(`[${MIGRATION_PLANNER_AGENT.name}] Stage 2: building draft task list from Stage 1 graphs...`, 'info');

  const draftTasks = await buildDraftMigrationTasks(modernPath);
  if (draftTasks.length === 0) {
    onLog?.(
      `[${MIGRATION_PLANNER_AGENT.name}] No migration tasks to plan — imports-graph is empty or missing. ` +
      'Re-run Stage 1 if this is unexpected.',
      'warning'
    );
    await SessionManager.updateSession(sessionId, { migrationTaskList: [], ruleCoverageReport: [] });
    return;
  }

  onLog?.(`[${MIGRATION_PLANNER_AGENT.name}] Draft task list built: ${draftTasks.length} file(s), dependency-ordered.`, 'success');

  const session      = await SessionManager.getSession(sessionId);
  // Captured now, before this run overwrites it — used to carry forward
  // status/lastError for any task whose identity didn't actually change.
  const previousTaskList: MigrationTaskEntry[] = (session as any)?.migrationTaskList ?? [];
  const toolsConfig: Record<string, boolean> = (session as any)?.toolsConfig ?? {};
  const { provider, resolvedModel } = await resolveStreamingProvider(sessionId, targetStack, MIGRATION_PLANNER_AGENT);

  const context: ToolContext = {
    sessionId,
    legacyPath,
    modernPath,
    onLog: (msg, lvl) => onLog?.(msg, lvl),
  };

  const tools = toolRegistry
    .getFunctions(...MIGRATION_PLANNER_AGENT.functions)
    .filter(t => toolsConfig[t.name] !== false);

  const targetStackForPrompt = {
    framework:     targetStack.framework,
    database:      targetStack.database,
    language:      targetStack.language,
    testFramework: targetStack.testFramework,
  };

  // Curated, per-target-framework conventions (folder layout, router/DI/async
  // idioms, required scaffolding) — see src/knowledge/framework-skills/*.md.
  // Resolved once here: reused both for the path-assignment prompt below and
  // for the scaffolding-task step further down. A framework with no matching
  // skill falls back to today's prose-guessing behavior — explicitly, not silently.
  const skill = await resolveFrameworkSkill(targetStack.framework);
  onLog?.(
    skill
      ? `[${MIGRATION_PLANNER_AGENT.name}] Using curated conventions for target framework "${targetStack.framework}".`
      : `[${MIGRATION_PLANNER_AGENT.name}] No curated skill for target framework "${targetStack.framework}" — ` +
        `proceeding with general LLM knowledge; architecture consistency across files is not guaranteed.`,
    skill ? 'info' : 'warning'
  );

  // legacyFile -> targetFile, filled in batch by batch. Kept in TS memory and
  // reconciled from each batch's isolated result — never trusted to survive
  // correctly inside shared task-context state across many LLM turns (the
  // same reasoning as Stage 1's path-locking: don't ask a model to correctly
  // round-trip large shared state across turns when TS can just do it).
  const targetPaths = new Map<string, string>();

  const batchSize = computePlanningBatchSize(draftTasks.length);
  const batches: DraftMigrationTask[][] = [];
  for (let i = 0; i < draftTasks.length; i += batchSize) {
    batches.push(draftTasks.slice(i, i + batchSize));
  }

  onLog?.(`[${MIGRATION_PLANNER_AGENT.name}] Assigning target paths in ${batches.length} batch(es) of up to ${batchSize} file(s).`, 'info');

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    try {
      await withTimeout(
        AgentExecutor.execute(
          provider,
          MIGRATION_PLANNER_SYSTEM_PROMPT,
          buildMigrationPlannerUserPrompt(
            legacyPath, batch, targetStackForPrompt,
            detectedStack.language, detectedStack.framework,
            skill?.folderLayout
          ),
          tools, context, resolvedModel, `migration-planning-batch-${i + 1}`,
          undefined, MIGRATION_PLANNER_AGENT.recoveryHint
        ),
        PLANNING_BATCH_TIMEOUT_MS,
        `migration-planning-batch-${i + 1}`
      );

      const ctx = await TaskContextManager.getContext(sessionId);
      const batchResult: Array<{ legacyFile: string; targetFile: string }> =
        Array.isArray(ctx.MIGRATION_TASK_BATCH_RESULT) ? ctx.MIGRATION_TASK_BATCH_RESULT : [];

      for (const entry of batchResult) {
        if (entry?.legacyFile && entry?.targetFile) {
          targetPaths.set(entry.legacyFile, entry.targetFile);
        }
      }

      const missing = batch.filter(t => !targetPaths.has(t.legacyFile));
      if (missing.length > 0) {
        onLog?.(
          `[${MIGRATION_PLANNER_AGENT.name}] Batch ${i + 1}: ${missing.length} file(s) got no target path — will use fallback naming.`,
          'warning'
        );
      }
    } catch (err: any) {
      onLog?.(`[${MIGRATION_PLANNER_AGENT.name}] Batch ${i + 1} failed: ${err.message}. Falling back to default naming for this batch.`, 'warning');
    }

    onProgress?.(Math.round(((i + 1) / batches.length) * 100));
  }

  // Deterministic fallback for anything the LLM batch didn't resolve: mirror
  // the legacy relative path under the target language's extension. Never
  // leave a task without a target path — an unresolved path silently blocks
  // Phase 3 (Code Generator) from knowing where to write.
  const fallbackExt = guessExtension(targetStack.language);
  const rawTaskList: MigrationTaskEntry[] = draftTasks.map(t => ({
    legacyFile:    t.legacyFile,
    targetFile:    targetPaths.get(t.legacyFile) ?? withExtension(t.legacyFile, fallbackExt),
    rulesInvolved: t.rulesInvolved,
    dependsOn:     t.dependsOn,
    status:        'pending',
  }));

  // Add whatever scaffolding the resolved skill declares as required (e.g. a
  // shared DB connection module, a dependency manifest, an app entrypoint) —
  // 'first'-order files go before everything and become a dependency of every
  // real task; 'last'-order files (the entrypoint) go after everything and
  // depend on every real + 'first' task. Without this, each file independently
  // guesses its own framework conventions (confirmed in a real run as the
  // direct cause of both a hedged DB-access stub and an app with no entrypoint).
  const { firstTasks, lastTasks } = buildScaffoldingTasks(skill, rawTaskList);
  if (firstTasks.length + lastTasks.length > 0) {
    onLog?.(
      `[${MIGRATION_PLANNER_AGENT.name}] Added ${firstTasks.length + lastTasks.length} required scaffolding ` +
      `file(s) for "${targetStack.framework}": ${[...firstTasks, ...lastTasks].map(t => t.targetFile).join(', ')}.`,
      'info'
    );
  }
  const scaffoldedTaskList = [...firstTasks, ...rawTaskList, ...lastTasks];

  // Fold any legacy files the Planner assigned to the SAME targetFile into one
  // task — Code Generation writes one complete file per task, so two tasks
  // sharing a target would just have the second write silently erase the first.
  const mergedTaskList = mergeTargetFileCollisions(scaffoldedTaskList);
  const collisionCount = scaffoldedTaskList.length - mergedTaskList.length;
  if (collisionCount > 0) {
    onLog?.(
      `[${MIGRATION_PLANNER_AGENT.name}] ${collisionCount} file(s) shared a target path with another file — ` +
      `merged into a single combined-generation task each, so they'll be translated together into one file instead ` +
      `of overwriting each other.`,
      'info'
    );
  }

  // Carry forward status/lastError for any task whose legacyFile, targetFile,
  // dependsOn, and merged group are unchanged from the previous plan — a
  // re-plan should not silently discard already-completed generation work.
  const migrationTaskList = preservePriorTaskStatus(mergedTaskList, previousTaskList);
  const preservedCount = migrationTaskList.filter(t => t.status !== 'pending').length;
  if (preservedCount > 0) {
    onLog?.(
      `[${MIGRATION_PLANNER_AGENT.name}] ${preservedCount} file(s) unchanged since the last plan — ` +
      `their generation/verification status was preserved, not reset.`,
      'info'
    );
  }

  // Preserve prior covered/uncovered verdicts too — a task carrying forward
  // its status (unchanged since the last plan) shouldn't lose its already-
  // judged rule coverage just because /plan ran again.
  const previousRuleCoverageReport: RuleCoverageEntry[] = (session as any)?.ruleCoverageReport ?? [];
  const previousCoverageByLegacyFile = new Map(previousRuleCoverageReport.map(r => [r.legacyFile, r]));

  const ruleCoverageReport: RuleCoverageEntry[] = migrationTaskList
    .filter(t => t.rulesInvolved.length > 0)
    .map(t => {
      const prior = t.status !== 'pending' ? previousCoverageByLegacyFile.get(t.legacyFile) : undefined;
      return {
        legacyFile: t.legacyFile,
        targetFile: t.targetFile,
        rules:      t.rulesInvolved,
        covered:    prior?.covered,
        uncovered:  prior?.uncovered,
      };
    });

  // Non-blocking sanity check — real files silently missing from imports-graph
  // (the exact confirmed bug: every file's data collapsing into one shared
  // key) produce a "valid-looking" but wrong plan otherwise. Surfaced in the
  // same review panel the human already checks before generating code, not
  // left for them to notice unaided.
  const planSanityWarning = await checkImportsGraphSanity(modernPath);
  if (planSanityWarning) {
    onLog?.(`[${MIGRATION_PLANNER_AGENT.name}] SANITY WARNING: ${planSanityWarning}`, 'warning');
  }

  await SessionManager.updateSession(sessionId, { migrationTaskList, ruleCoverageReport, planSanityWarning: planSanityWarning ?? undefined });

  onLog?.(
    `[${MIGRATION_PLANNER_AGENT.name}] Stage 2 complete: ${migrationTaskList.length} file(s) planned, ` +
    `${ruleCoverageReport.length} with business rules to preserve. Awaiting review before code generation.`,
    'success'
  );
}
