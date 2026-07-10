

import fs   from 'fs-extra';
import path from 'path';
import { DetectedStack, TargetStack } from '../../types.js';
import { toolRegistry }               from '../../core/tool-invocation-registry.js';
import { ToolContext }                 from '../../types/tool.js';
import { AgentExecutor }              from '../core/agentExecutor.js';
import { TaskContextManager }         from '../../session/taskContext.js';
import { SessionManager }             from '../../session/sessionManager.js';
import { resolveStreamingProvider }   from '../../ai/index.js';
import { lockWriteFileTool }          from '../core/tool-locking.js';
import {
  MIGRATION_PLANNER_AGENT, CODE_GENERATOR_AGENT, RULE_COVERAGE_AGENT, BUILD_VERIFICATION_AGENT,
} from '../core/agent-definitions.js';
import {
  MIGRATION_PLANNER_SYSTEM_PROMPT,
  buildMigrationPlannerUserPrompt,
} from '../../prompts/migration-planner-prompt.js';
import {
  CODE_GENERATOR_SYSTEM_PROMPT,
  buildCodeGeneratorUserPrompt,
} from '../../prompts/code-generator-prompt.js';
import {
  RULE_COVERAGE_SYSTEM_PROMPT,
  buildRuleCoverageUserPrompt,
} from '../../prompts/rule-coverage-prompt.js';
import {
  BUILD_VERIFICATION_SYSTEM_PROMPT,
  buildBuildVerificationUserPrompt,
} from '../../prompts/build-verification-prompt.js';
import { buildDraftMigrationTasks, DraftMigrationTask } from './migration-planner.js';
import { checkCrossFileReferences } from './verification.js';
import { MigrationTaskEntry, RuleCoverageEntry } from './types.js';

type LogFn = (msg: string, lvl?: 'info' | 'success' | 'error' | 'warning') => void;

const PLANNING_BATCH_TIMEOUT_MS = 8 * 60_000;
const GENERATION_TIMEOUT_MS     = 8 * 60_000;
const RULE_CHECK_TIMEOUT_MS     = 5 * 60_000;
const BUILD_CHECK_TIMEOUT_MS    = 10 * 60_000;

// Same tiered shape as Stage 1's batch-size heuristic — smaller batches once the
// total file count grows, so a single LLM turn's output (one path per file)
// stays comfortably within a normal response, regardless of project size.
function computePlanningBatchSize(totalCount: number): number {
  if (totalCount < 30)  return 15;
  if (totalCount < 100) return 10;
  if (totalCount < 300) return 6;
  return 4;
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

function findStubMarker(content: string): string | null {
  const lower = content.toLowerCase();
  for (const marker of STUB_MARKERS) {
    if (lower.includes(marker)) return marker;
  }
  return null;
}

function withTimeout<T>(operation: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`[MigrationAgent] "${label}" did not complete within ${Math.round(timeoutMs / 60_000)} min.`));
    }, timeoutMs);
    operation
      .then(result => { clearTimeout(timer); resolve(result); })
      .catch(err   => { clearTimeout(timer); reject(err);    });
  });
}

export class MigrationAgent {

  // Migration Planning sub-stage: builds the per-file task list (target path +
  // rulesInvolved + dependsOn) and the Rule Coverage Manifest, then saves both
  // onto the session for the human checkpoint. No code is written in this stage.
  static async runPlanning(
    sessionId:     string,
    legacyPath:    string,
    modernPath:    string,
    detectedStack: DetectedStack,
    targetStack:   TargetStack,
    onLog?:        LogFn,
    onProgress?:   (percent: number) => void,
  ): Promise<void> {
    onLog?.('[MigrationAgent] Stage 2 Planning: building draft task list from Stage 1 graphs...', 'info');

    const draftTasks = await buildDraftMigrationTasks(modernPath);
    if (draftTasks.length === 0) {
      onLog?.(
        '[MigrationAgent] No migration tasks to plan — imports-graph is empty or missing. ' +
        'Re-run Stage 1 if this is unexpected.',
        'warning'
      );
      await SessionManager.updateSession(sessionId, { migrationTaskList: [], ruleCoverageReport: [] });
      return;
    }

    onLog?.(`[MigrationAgent] Draft task list built: ${draftTasks.length} file(s), dependency-ordered.`, 'success');

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

    onLog?.(`[MigrationAgent] Assigning target paths in ${batches.length} batch(es) of up to ${batchSize} file(s).`, 'info');

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
            `[MigrationAgent] Batch ${i + 1}: ${missing.length} file(s) got no target path — will use fallback naming.`,
            'warning'
          );
        }
      } catch (err: any) {
        onLog?.(`[MigrationAgent] Batch ${i + 1} failed: ${err.message}. Falling back to default naming for this batch.`, 'warning');
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
      `[MigrationAgent] Stage 2 Planning complete: ${migrationTaskList.length} file(s) planned, ` +
      `${ruleCoverageReport.length} with business rules to preserve. Awaiting review before code generation.`,
      'success'
    );
  }

  // Code Generation sub-stage: processes the reviewed task list in the order
  // it's already in (dependency-ordered by the Planner), one file per turn.
  // Each file's write_file call is path-locked to its pre-approved targetFile
  // (see tool-locking.ts) — the model never chooses its own destination.
  // Resumable: tasks already 'generated'/'verified' are skipped, so re-running
  // after a partial failure only retries what's still 'pending'/'failed'.
  static async runCodeGeneration(
    sessionId:       string,
    legacyPath:      string,
    modernPath:      string,
    detectedStack:   DetectedStack,
    targetStack:     TargetStack,
    onLog?:          LogFn,
    onProgress?:     (percent: number) => void,
    onFileGenerated?: (targetFile: string) => void,
  ): Promise<void> {
    const session  = await SessionManager.getSession(sessionId);
    const taskList: MigrationTaskEntry[] = ((session as any)?.migrationTaskList ?? []).map(
      (t: MigrationTaskEntry) => ({ ...t })
    );

    if (taskList.length === 0) {
      onLog?.('[MigrationAgent] No migration task list found — run Migration Planning first.', 'warning');
      return;
    }

    const toolsConfig: Record<string, boolean> = (session as any)?.toolsConfig ?? {};
    const { provider, resolvedModel } = await resolveStreamingProvider(sessionId, targetStack, CODE_GENERATOR_AGENT);

    const context: ToolContext = {
      sessionId,
      legacyPath,
      modernPath,
      onLog: (msg, lvl) => onLog?.(msg, lvl),
    };

    const baseTools = toolRegistry
      .getFunctions(...CODE_GENERATOR_AGENT.functions)
      .filter(t => toolsConfig[t.name] !== false);

    const targetStackForPrompt = {
      framework:     targetStack.framework,
      database:      targetStack.database,
      language:      targetStack.language,
      testFramework: targetStack.testFramework,
    };

    const pendingCount = taskList.filter(t => t.status === 'pending' || t.status === 'failed').length;
    onLog?.(`[MigrationAgent] Stage 2 Code Generation: ${pendingCount} file(s) to generate, dependency-ordered.`, 'info');

    // legacyFile -> targetFile, so each task can tell the generator the EXACT
    // path its dependencies ended up at — without this, a file generated in
    // isolation has to guess a sibling module's name/path, and guesses are
    // exactly what produced the cross-file import mismatches found in review.
    const legacyToTarget = new Map(taskList.map(t => [t.legacyFile, t.targetFile]));

    let processed = 0;

    for (const task of taskList) {
      if (task.status === 'generated' || task.status === 'verified') {
        processed++;
        continue;
      }

      const lockedTools  = lockWriteFileTool(baseTools, task.targetFile);
      const targetAbsPath = path.join(modernPath, task.targetFile);

      const dependencyTargets = task.dependsOn
        .map(legacyFile => {
          const targetFile = legacyToTarget.get(legacyFile);
          return targetFile ? { legacyFile, targetFile } : null;
        })
        .filter((d): d is { legacyFile: string; targetFile: string } => d !== null);

      let success   = false;
      let lastError = '';

      for (let attempt = 1; attempt <= 2 && !success; attempt++) {
        try {
          await withTimeout(
            AgentExecutor.execute(
              provider,
              CODE_GENERATOR_SYSTEM_PROMPT,
              buildCodeGeneratorUserPrompt(
                task.legacyFile, task.targetFile, task.rulesInvolved,
                targetStackForPrompt, detectedStack.language, detectedStack.framework,
                dependencyTargets
              ),
              lockedTools, context, resolvedModel, `code-generation-${task.legacyFile}-attempt${attempt}`,
              undefined, CODE_GENERATOR_AGENT.recoveryHint
            ),
            GENERATION_TIMEOUT_MS,
            `code-generation-${task.legacyFile}`
          );

          const written = await fs.pathExists(targetAbsPath);
          if (!written) {
            lastError = 'file was not created (agent did not call write_file)';
          } else {
            const content = await fs.readFile(targetAbsPath, 'utf-8');
            const stubMarker = findStubMarker(content);
            if (stubMarker) {
              lastError = `generated content is a stub/placeholder (matched "${stubMarker}"), not real translated logic`;
            } else {
              success = true;
            }
          }
        } catch (err: any) {
          lastError = err.message;
        }

        if (!success && attempt === 1) {
          onLog?.(`[MigrationAgent] ${task.legacyFile}: attempt 1 failed (${lastError}). Retrying once.`, 'warning');
        }
      }

      task.status = success ? 'generated' : 'failed';
      if (!success) task.lastError = lastError;
      processed++;

      // Persist after every file, not just at the end — a crash mid-run loses
      // at most the file in progress, not the whole batch's completed work.
      await SessionManager.updateSession(sessionId, { migrationTaskList: [...taskList] });

      if (success) {
        onLog?.(`[MigrationAgent] Generated: ${task.legacyFile} -> ${task.targetFile}`, 'success');
        onFileGenerated?.(task.targetFile);
      } else {
        onLog?.(`[MigrationAgent] FAILED: ${task.legacyFile} - ${lastError}. Continuing to next file.`, 'error');
      }

      onProgress?.(Math.round((processed / taskList.length) * 100));
    }

    const generatedCount = taskList.filter(t => t.status === 'generated').length;
    const failedCount    = taskList.filter(t => t.status === 'failed').length;
    onLog?.(
      `[MigrationAgent] Stage 2 Code Generation complete: ${generatedCount} generated, ${failedCount} failed.`,
      failedCount > 0 ? 'warning' : 'success'
    );
  }

  // Verification sub-stage: deterministic cross-file reference check (see
  // verification.ts for why this is the reliable check available — real
  // build/execute verification needs an installed toolchain for whatever
  // target stack the user chose, which this platform does not provision).
  // On a failed check, attempts ONE bounded regeneration of that file with
  // the exact unresolved reference named, then re-checks.
  static async runVerification(
    sessionId:     string,
    legacyPath:    string,
    modernPath:    string,
    detectedStack: DetectedStack,
    targetStack:   TargetStack,
    onLog?:        LogFn,
    onProgress?:   (percent: number) => void,
  ): Promise<void> {
    const session  = await SessionManager.getSession(sessionId);
    const taskList: MigrationTaskEntry[] = ((session as any)?.migrationTaskList ?? []).map(
      (t: MigrationTaskEntry) => ({ ...t })
    );
    const ruleCoverageReport: RuleCoverageEntry[] = ((session as any)?.ruleCoverageReport ?? []).map(
      (r: RuleCoverageEntry) => ({ ...r })
    );

    // Re-checks EVERY task that has actually been generated at least once —
    // 'generated', 'verified', or 'failed' — not just ones still sitting at
    // 'generated'. Without this, a second "Re-verify" click (e.g. after a
    // manual edit to an already-verified file) has nothing left to check,
    // since a successful first pass moves every task to 'verified'.
    const toVerifyCount = taskList.filter(t => t.status !== 'pending').length;
    if (toVerifyCount === 0) {
      onLog?.('[MigrationAgent] No generated files to verify — run Code Generation first.', 'warning');
      return;
    }

    onLog?.(
      `[MigrationAgent] Stage 2 Verification: checking cross-file references + rule coverage for ${toVerifyCount} file(s).`,
      'info'
    );

    const legacyToTarget = new Map(taskList.map(t => [t.legacyFile, t.targetFile]));

    const toolsConfig: Record<string, boolean> = (session as any)?.toolsConfig ?? {};
    // Each agent used within Verification resolves its OWN provider/model — a
    // rule-coverage judgment, a regeneration fix, and a real build check are
    // three different agents and may genuinely run on three different providers.
    const { provider: ruleCoverageProvider, resolvedModel: ruleCoverageModel } =
      await resolveStreamingProvider(sessionId, targetStack, RULE_COVERAGE_AGENT);
    const { provider: codeGenProvider, resolvedModel: codeGenModel } =
      await resolveStreamingProvider(sessionId, targetStack, CODE_GENERATOR_AGENT);
    const { provider: buildVerificationProvider, resolvedModel: buildVerificationModel } =
      await resolveStreamingProvider(sessionId, targetStack, BUILD_VERIFICATION_AGENT);
    const context: ToolContext = {
      sessionId, legacyPath, modernPath,
      onLog: (msg, lvl) => onLog?.(msg, lvl),
    };
    const codeGenTools = toolRegistry
      .getFunctions(...CODE_GENERATOR_AGENT.functions)
      .filter(t => toolsConfig[t.name] !== false);
    const ruleCheckTools = toolRegistry
      .getFunctions(...RULE_COVERAGE_AGENT.functions)
      .filter(t => toolsConfig[t.name] !== false);
    const targetStackForPrompt = {
      framework:     targetStack.framework,
      database:      targetStack.database,
      language:      targetStack.language,
      testFramework: targetStack.testFramework,
    };

    // Runs the rule-coverage LLM check once against current file content.
    // Returns null (treated as "skip, nothing to check") when the file has
    // no rules attached — most files won't.
    const checkRules = async (rules: string[], legacyFile: string, targetFile: string, fileContent: string): Promise<{ covered: string[]; uncovered: string[] } | null> => {
      if (rules.length === 0) return null;
      try {
        await withTimeout(
          AgentExecutor.execute(
            ruleCoverageProvider,
            RULE_COVERAGE_SYSTEM_PROMPT,
            buildRuleCoverageUserPrompt(legacyFile, targetFile, fileContent, rules),
            ruleCheckTools, context, ruleCoverageModel, `rule-coverage-${targetFile}`,
            undefined, RULE_COVERAGE_AGENT.recoveryHint
          ),
          RULE_CHECK_TIMEOUT_MS,
          `rule-coverage-${targetFile}`
        );
        const ctx = await TaskContextManager.getContext(sessionId);
        const result = ctx.RULE_COVERAGE_RESULT;
        if (result && Array.isArray(result.covered) && Array.isArray(result.uncovered)) {
          return { covered: result.covered, uncovered: result.uncovered };
        }
        // Model didn't report — treat every rule as unconfirmed rather than
        // silently assuming it's fine.
        return { covered: [], uncovered: [...rules] };
      } catch (err: any) {
        onLog?.(`[MigrationAgent] ${targetFile}: rule coverage check failed to run: ${err.message}`, 'warning');
        return { covered: [], uncovered: [...rules] };
      }
    };

    let processed = 0;

    for (const task of taskList) {
      // 'pending' means Code Generation never produced this file at all —
      // nothing on disk to check yet. Everything else ('generated',
      // 'verified', 'failed') gets re-checked against its CURRENT content,
      // since that may have changed since the last verification pass (a
      // regeneration fix, or a manual edit made directly to the file).
      if (task.status === 'pending') {
        continue;
      }

      const targetAbsPath = path.join(modernPath, task.targetFile);
      const dependencyTargetPaths = task.dependsOn
        .map(f => legacyToTarget.get(f))
        .filter((f): f is string => !!f);

      let content = '';
      try { content = await fs.readFile(targetAbsPath, 'utf-8'); } catch { /* treat as empty — will fail below */ }

      let unresolved = checkCrossFileReferences(content, dependencyTargetPaths);

      const dependencyTargets = task.dependsOn
        .map(legacyFile => {
          const targetFile = legacyToTarget.get(legacyFile);
          return targetFile ? { legacyFile, targetFile } : null;
        })
        .filter((d): d is { legacyFile: string; targetFile: string } => d !== null);

      if (unresolved.length > 0) {
        onLog?.(
          `[MigrationAgent] ${task.targetFile}: unresolved reference(s) to ${unresolved.join(', ')}. Attempting one regeneration fix.`,
          'warning'
        );

        const lockedTools = lockWriteFileTool(codeGenTools, task.targetFile);
        try {
          await withTimeout(
            AgentExecutor.execute(
              codeGenProvider,
              CODE_GENERATOR_SYSTEM_PROMPT,
              buildCodeGeneratorUserPrompt(
                task.legacyFile, task.targetFile, task.rulesInvolved,
                targetStackForPrompt, detectedStack.language, detectedStack.framework,
                dependencyTargets,
                `Unresolved reference(s) to: ${unresolved.join(', ')} — these dependencies were not ` +
                `found referenced anywhere in your previous output. Import them correctly this time.`
              ),
              lockedTools, context, codeGenModel, `verification-fix-${task.legacyFile}`,
              undefined, CODE_GENERATOR_AGENT.recoveryHint
            ),
            GENERATION_TIMEOUT_MS,
            `verification-fix-${task.legacyFile}`
          );
          content    = await fs.readFile(targetAbsPath, 'utf-8').catch(() => '');
          unresolved = checkCrossFileReferences(content, dependencyTargetPaths);
        } catch (err: any) {
          onLog?.(`[MigrationAgent] ${task.targetFile}: regeneration fix failed: ${err.message}`, 'error');
        }
      }

      // Rule coverage — only meaningful once cross-file wiring is sound;
      // checking rule logic in a file whose imports are already broken adds
      // nothing. Skips entirely for files with no attached rules.
      let ruleResult: { covered: string[]; uncovered: string[] } | null = null;
      if (unresolved.length === 0) {
        ruleResult = await checkRules(task.rulesInvolved, task.legacyFile, task.targetFile, content);

        if (ruleResult && ruleResult.uncovered.length > 0) {
          onLog?.(
            `[MigrationAgent] ${task.targetFile}: rule(s) not enforced: ${ruleResult.uncovered.join('; ')}. Attempting one regeneration fix.`,
            'warning'
          );

          const lockedTools = lockWriteFileTool(codeGenTools, task.targetFile);
          try {
            await withTimeout(
              AgentExecutor.execute(
                codeGenProvider,
                CODE_GENERATOR_SYSTEM_PROMPT,
                buildCodeGeneratorUserPrompt(
                  task.legacyFile, task.targetFile, task.rulesInvolved,
                  targetStackForPrompt, detectedStack.language, detectedStack.framework,
                  dependencyTargets,
                  `These specific business rule(s) are NOT visibly enforced in your previous output: ` +
                  `${ruleResult.uncovered.join('; ')}. Add the missing validation/branch/error logic for ` +
                  `each of them while keeping everything else intact.`
                ),
                lockedTools, context, codeGenModel, `rule-fix-${task.legacyFile}`,
                undefined, CODE_GENERATOR_AGENT.recoveryHint
              ),
              GENERATION_TIMEOUT_MS,
              `rule-fix-${task.legacyFile}`
            );
            content    = await fs.readFile(targetAbsPath, 'utf-8').catch(() => '');
            unresolved = checkCrossFileReferences(content, dependencyTargetPaths);
            ruleResult = unresolved.length === 0
              ? await checkRules(task.rulesInvolved, task.legacyFile, task.targetFile, content)
              : ruleResult; // cross-file check regressed — don't bother re-checking rules
          } catch (err: any) {
            onLog?.(`[MigrationAgent] ${task.targetFile}: rule fix regeneration failed: ${err.message}`, 'error');
          }
        }
      }

      if (ruleResult) {
        const existingEntry = ruleCoverageReport.find(r => r.legacyFile === task.legacyFile);
        if (existingEntry) {
          existingEntry.covered   = ruleResult.covered;
          existingEntry.uncovered = ruleResult.uncovered;
        } else {
          ruleCoverageReport.push({
            legacyFile: task.legacyFile,
            targetFile: task.targetFile,
            rules:      task.rulesInvolved,
            covered:    ruleResult.covered,
            uncovered:  ruleResult.uncovered,
          });
        }
      }

      const uncoveredRules = ruleResult?.uncovered ?? [];
      const passed = unresolved.length === 0 && uncoveredRules.length === 0;

      task.status = passed ? 'verified' : 'failed';
      if (!passed) {
        const parts: string[] = [];
        if (unresolved.length > 0)    parts.push(`unresolved cross-file reference(s): ${unresolved.join(', ')}`);
        if (uncoveredRules.length > 0) parts.push(`unenforced rule(s): ${uncoveredRules.join('; ')}`);
        task.lastError = parts.join(' | ');
      }
      processed++;

      await SessionManager.updateSession(sessionId, {
        migrationTaskList: [...taskList],
        ruleCoverageReport: [...ruleCoverageReport],
      });

      if (passed) {
        onLog?.(`[MigrationAgent] Verified: ${task.targetFile}`, 'success');
      } else {
        onLog?.(`[MigrationAgent] FAILED verification: ${task.targetFile} — ${task.lastError}`, 'error');
      }

      onProgress?.(Math.round((processed / taskList.length) * 100));
    }

    // Real build check — the Build Verification Agent decides everything
    // itself (what's a dependency vs. stdlib vs. local module, what manifest
    // format, what install/build command) from its own knowledge of the
    // target language, then actually executes it via capturedShellExecute.
    // No hardcoded per-language table here — that would silently do nothing
    // for any language not explicitly coded for. This is the check the two
    // above cannot be: it catches a missing third-party import or an
    // undefined-name error that only surfaces the moment the code actually
    // runs (e.g. a file that uses `Depends` without importing it — valid-
    // looking Python, but a guaranteed crash on import).
    interface BuildCheckOutcome {
      environmentAvailable: boolean;
      results: Record<string, { passed: boolean; error?: string }>;
    }

    const buildTools = toolRegistry
      .getFunctions(...BUILD_VERIFICATION_AGENT.functions)
      .filter(t => toolsConfig[t.name] !== false);

    const runBuildVerification = async (files: string[], tag: string): Promise<BuildCheckOutcome | null> => {
      try {
        await withTimeout(
          AgentExecutor.execute(
            buildVerificationProvider,
            BUILD_VERIFICATION_SYSTEM_PROMPT,
            buildBuildVerificationUserPrompt(files, targetStackForPrompt),
            buildTools, context, buildVerificationModel, tag,
            undefined, BUILD_VERIFICATION_AGENT.recoveryHint
          ),
          BUILD_CHECK_TIMEOUT_MS,
          tag
        );
        const ctx = await TaskContextManager.getContext(sessionId);
        const raw = ctx.REAL_BUILD_RESULT;
        if (raw && typeof raw === 'object' && raw.results && typeof raw.results === 'object') {
          return { environmentAvailable: !!raw.environmentAvailable, results: raw.results };
        }
        onLog?.(`[MigrationAgent] Build verification agent did not report a result — treating as unavailable.`, 'warning');
        return null;
      } catch (err: any) {
        onLog?.(`[MigrationAgent] Build verification agent failed to run: ${err.message}`, 'warning');
        return null;
      }
    };

    const nonPendingTasks = taskList.filter(t => t.status !== 'pending');
    if (nonPendingTasks.length > 0) {
      onLog?.('[MigrationAgent] Running real build verification (agent-directed — no hardcoded per-language logic)...', 'info');

      const buildResult = await runBuildVerification(nonPendingTasks.map(t => t.targetFile), 'build-verification');

      if (buildResult && buildResult.environmentAvailable) {
        for (const task of nonPendingTasks) {
          const fileResult = buildResult.results[task.targetFile];
          if (!fileResult || fileResult.passed) continue;

          const realError = fileResult.error || 'unknown real build error';
          onLog?.(
            `[MigrationAgent] ${task.targetFile}: real error: ${realError.slice(0, 300)}. Attempting one regeneration fix.`,
            'warning'
          );

          const dependencyTargets = task.dependsOn
            .map(legacyFile => {
              const targetFile = legacyToTarget.get(legacyFile);
              return targetFile ? { legacyFile, targetFile } : null;
            })
            .filter((d): d is { legacyFile: string; targetFile: string } => d !== null);

          const lockedTools = lockWriteFileTool(codeGenTools, task.targetFile);
          let fixedError = realError;
          try {
            await withTimeout(
              AgentExecutor.execute(
                codeGenProvider,
                CODE_GENERATOR_SYSTEM_PROMPT,
                buildCodeGeneratorUserPrompt(
                  task.legacyFile, task.targetFile, task.rulesInvolved,
                  targetStackForPrompt, detectedStack.language, detectedStack.framework,
                  dependencyTargets,
                  `Running this file for real produced this error: ${realError.slice(0, 800)}\n` +
                  `Fix the actual bug causing this (e.g. a missing import, undefined name, or syntax ` +
                  `error) while keeping all existing logic and rules intact.`
                ),
                lockedTools, context, codeGenModel, `real-check-fix-${task.legacyFile}`,
                undefined, CODE_GENERATOR_AGENT.recoveryHint
              ),
              GENERATION_TIMEOUT_MS,
              `real-check-fix-${task.legacyFile}`
            );

            const recheck = await runBuildVerification([task.targetFile], `real-check-recheck-${task.legacyFile}`);
            const recheckResult = recheck?.results[task.targetFile];
            fixedError = recheckResult && !recheckResult.passed ? (recheckResult.error || 'still failing') : '';

            if (!fixedError) {
              const targetAbsPath = path.join(modernPath, task.targetFile);
              const content = await fs.readFile(targetAbsPath, 'utf-8').catch(() => '');
              const dependencyTargetPaths = task.dependsOn
                .map(f => legacyToTarget.get(f))
                .filter((f): f is string => !!f);
              const stillResolved = checkCrossFileReferences(content, dependencyTargetPaths).length === 0;
              if (stillResolved) {
                task.status = 'verified';
                task.lastError = undefined;
              } else {
                fixedError = 'regeneration fixed the real build error but broke a cross-file reference';
              }
            }
          } catch (err: any) {
            fixedError = `regeneration fix failed to run: ${err.message}`;
          }

          if (fixedError) {
            task.status = 'failed';
            task.lastError = `real build error: ${fixedError}`;
            onLog?.(`[MigrationAgent] FAILED real build check: ${task.targetFile} — ${fixedError}`, 'error');
          } else {
            onLog?.(`[MigrationAgent] Real build check passed after fix: ${task.targetFile}`, 'success');
          }

          await SessionManager.updateSession(sessionId, { migrationTaskList: [...taskList] });
        }
      } else {
        onLog?.(
          `[MigrationAgent] Real build check did not run for target language "${targetStack.language}" — ` +
          `only the deterministic cross-file check and LLM rule-coverage check ran for this pass.`,
          'warning'
        );
      }
    }

    const verifiedCount = taskList.filter(t => t.status === 'verified').length;
    const failedCount   = taskList.filter(t => t.status === 'failed').length;
    onLog?.(
      `[MigrationAgent] Stage 2 Verification complete: ${verifiedCount} verified, ${failedCount} still failing. ` +
      `Checks performed: deterministic cross-file reference matching, an LLM rule-coverage judgment against each ` +
      `file's Rule Coverage Manifest entries, and — where the Build Verification Agent found a usable toolchain ` +
      `for the target language — a real, agent-directed dependency install + import/build check.`,
      failedCount > 0 ? 'warning' : 'success'
    );
  }
}

function guessExtension(targetLanguage: string): string {
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

function withExtension(filePath: string, ext: string): string {
  const dot = filePath.lastIndexOf('.');
  const base = dot > filePath.lastIndexOf('/') ? filePath.slice(0, dot) : filePath;
  return `${base}${ext}`;
}
