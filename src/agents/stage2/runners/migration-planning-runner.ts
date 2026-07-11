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
import { LogFn, PLANNING_BATCH_TIMEOUT_MS, withTimeout, guessExtension, withExtension } from './shared.js';

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
            detectedStack.language, detectedStack.framework
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
  const migrationTaskList: MigrationTaskEntry[] = draftTasks.map(t => ({
    legacyFile:    t.legacyFile,
    targetFile:    targetPaths.get(t.legacyFile) ?? withExtension(t.legacyFile, fallbackExt),
    rulesInvolved: t.rulesInvolved,
    dependsOn:     t.dependsOn,
    status:        'pending',
  }));

  const ruleCoverageReport: RuleCoverageEntry[] = migrationTaskList
    .filter(t => t.rulesInvolved.length > 0)
    .map(t => ({
      legacyFile: t.legacyFile,
      targetFile: t.targetFile,
      rules:      t.rulesInvolved,
    }));

  await SessionManager.updateSession(sessionId, { migrationTaskList, ruleCoverageReport });

  onLog?.(
    `[${MIGRATION_PLANNER_AGENT.name}] Stage 2 complete: ${migrationTaskList.length} file(s) planned, ` +
    `${ruleCoverageReport.length} with business rules to preserve. Awaiting review before code generation.`,
    'success'
  );
}
