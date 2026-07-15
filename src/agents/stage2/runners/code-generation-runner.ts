// Code Generation sub-stage: processes the reviewed task list in the order
// it's already in (dependency-ordered by the Planner), one file per turn.
// Each file's write_file call is path-locked to its pre-approved targetFile
// (see tool-locking.ts) — the model never chooses its own destination.
// Resumable: tasks already 'generated'/'verified' are skipped, so re-running
// after a partial failure only retries what's still 'pending'/'failed'.
import fs   from 'fs-extra';
import path from 'path';
import { DetectedStack, TargetStack } from '../../../types.js';
import { toolRegistry }               from '../../../core/tool-invocation-registry.js';
import { ToolContext }                from '../../../types/tool.js';
import { AgentExecutor }              from '../../core/agentExecutor.js';
import { SessionManager }             from '../../../session/sessionManager.js';
import { resolveStreamingProvider }   from '../../../ai/index.js';
import { lockWriteFileTool }          from '../../core/tool-locking.js';
import { CODE_GENERATOR_AGENT }       from '../../core/agent-definitions.js';
import {
  CODE_GENERATOR_SYSTEM_PROMPT,
  buildCodeGeneratorUserPrompt,
  selectRelevantConventions,
} from '../../../prompts/code-generator-prompt.js';
import { MigrationTaskEntry } from '../types.js';
import { LogFn, GENERATION_TIMEOUT_MS, withTimeout, findStubMarker, resolveScaffoldingBrief } from './shared.js';
import { resolveFrameworkSkill } from '../../../knowledge/framework-skills/registry.js';
import { extractExportedSymbols } from '../symbol-extraction.js';

export async function runCodeGeneration(
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
    onLog?.(`[${CODE_GENERATOR_AGENT.name}] No migration task list found — run Migration Planning first.`, 'warning');
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

  // Curated per-target-framework conventions — see migration-planning-runner.ts
  // for the fuller explanation. Resolved once here; the SELECTION of which
  // sections apply happens per-task below (selectRelevantConventions), since
  // it depends on each task's own targetFile — a models.py turn doesn't need
  // Router Pattern's APIRouter/prefix rules, a schemas file needs none of it.
  const skill = await resolveFrameworkSkill(targetStack.framework);

  const pendingCount = taskList.filter(t => t.status === 'pending' || t.status === 'failed').length;
  onLog?.(`[${CODE_GENERATOR_AGENT.name}] Stage 2: ${pendingCount} file(s) to generate, dependency-ordered.`, 'info');

  // legacyFile -> targetFile, including every merged-in secondary file (see
  // mergeTargetFileCollisions) — so a dependent task can still resolve the
  // correct target path even though the secondary no longer has its own
  // standalone task entry.
  const legacyToTarget = new Map(
    taskList.flatMap(t => [t.legacyFile, ...(t.mergedLegacyFiles ?? [])].map(lf => [lf, t.targetFile] as const))
  );

  let processed = 0;

  for (const task of taskList) {
    if (task.status === 'generated' || task.status === 'verified') {
      processed++;
      continue;
    }

    const allLegacyFiles = [task.legacyFile, ...(task.mergedLegacyFiles ?? [])];
    const taskLabel = allLegacyFiles.join(' + ');

    // A fresh generation pass means whatever fix-attempt history Verification
    // accumulated against the PREVIOUS content no longer applies — that content
    // doesn't exist anymore. Without this, a later verification pass could
    // feed a regeneration prompt attempt history describing a completely
    // different (now-overwritten) version of this file.
    task.fixAttempts = undefined;

    // Write to a temp path first — the real targetFile is only ever touched
    // with content that already passed the stub check. Without this, a
    // rejected stub attempt still lands on disk at the real path (a real run
    // confirmed this: the FAILED attempt's stub content was what a developer
    // would actually find at the target file, not any of the successful ones).
    const tempRelPath  = `${task.targetFile}.generating.tmp`;
    const tempAbsPath  = path.join(modernPath, tempRelPath);
    const targetAbsPath = path.join(modernPath, task.targetFile);
    const lockedTools  = lockWriteFileTool(baseTools, tempRelPath);

    const dependencyTargets = task.dependsOn
      .map(legacyFile => {
        const targetFile = legacyToTarget.get(legacyFile);
        if (!targetFile) return null;
        // exportedSymbols was populated on the dependency's OWN task entry
        // when it was generated earlier (dependency order guarantees it ran
        // first) — look it up by whichever task actually owns this legacyFile.
        const owner = taskList.find(t => t.legacyFile === legacyFile || t.mergedLegacyFiles?.includes(legacyFile));
        return { legacyFile, targetFile, exportedSymbols: owner?.exportedSymbols };
      })
      .filter((d): d is NonNullable<typeof d> => d !== null);

    // Selected per-task, not once for the whole run — depends on THIS task's
    // own targetFile (see selectRelevantConventions).
    const frameworkConventions = skill
      ? selectRelevantConventions(skill, task.targetFile)
      : undefined;

    let success   = false;
    let lastError = '';

    for (let attempt = 1; attempt <= 2 && !success; attempt++) {
      try {
        await withTimeout(
          AgentExecutor.execute(
            provider,
            CODE_GENERATOR_SYSTEM_PROMPT,
            buildCodeGeneratorUserPrompt(
              allLegacyFiles, task.targetFile, task.rulesInvolved,
              targetStackForPrompt, detectedStack.language, detectedStack.framework,
              dependencyTargets,
              attempt > 1 ? lastError : undefined,
              resolveScaffoldingBrief(skill, task.legacyFile),
              frameworkConventions
            ),
            lockedTools, context, resolvedModel, `code-generation-${taskLabel}-attempt${attempt}`,
            undefined, CODE_GENERATOR_AGENT.recoveryHint
          ),
          GENERATION_TIMEOUT_MS,
          `code-generation-${taskLabel}`
        );

        const written = await fs.pathExists(tempAbsPath);
        if (!written) {
          lastError = 'file was not created (agent did not call write_file)';
        } else {
          const content = await fs.readFile(tempAbsPath, 'utf-8');
          const stubMarker = findStubMarker(content);
          if (stubMarker) {
            lastError = `generated content is a stub/placeholder (matched "${stubMarker}"), not real translated logic`;
            await fs.remove(tempAbsPath); // discard — real target path stays untouched
          } else {
            await fs.ensureDir(path.dirname(targetAbsPath));
            await fs.move(tempAbsPath, targetAbsPath, { overwrite: true }); // promote
            success = true;
            // The generated file is written in the TARGET language, not the
            // legacy/detected one — extracting against the wrong language
            // would silently return zero symbols every time.
            task.exportedSymbols = extractExportedSymbols(content, targetStack.language);
          }
        }
      } catch (err: any) {
        lastError = err.message;
        await fs.remove(tempAbsPath).catch(() => {});
      }

      if (!success && attempt === 1) {
        onLog?.(`[${CODE_GENERATOR_AGENT.name}] ${taskLabel}: attempt 1 failed (${lastError}). Retrying once with that failure reason included.`, 'warning');
      }
    }

    task.status = success ? 'generated' : 'failed';
    if (!success) task.lastError = lastError;
    processed++;

    // Persist after every file, not just at the end — a crash mid-run loses
    // at most the file in progress, not the whole batch's completed work.
    await SessionManager.updateSession(sessionId, { migrationTaskList: [...taskList] });

    if (success) {
      onLog?.(`[${CODE_GENERATOR_AGENT.name}] Generated: ${taskLabel} -> ${task.targetFile}`, 'success');
      onFileGenerated?.(task.targetFile);
    } else {
      onLog?.(`[${CODE_GENERATOR_AGENT.name}] FAILED: ${taskLabel} - ${lastError}. Continuing to next file.`, 'error');
    }

    onProgress?.(Math.round((processed / taskList.length) * 100));
  }

  const generatedCount = taskList.filter(t => t.status === 'generated').length;
  const failedCount    = taskList.filter(t => t.status === 'failed').length;
  onLog?.(
    `[${CODE_GENERATOR_AGENT.name}] Stage 2 complete: ${generatedCount} generated, ${failedCount} failed.`,
    failedCount > 0 ? 'warning' : 'success'
  );
}
