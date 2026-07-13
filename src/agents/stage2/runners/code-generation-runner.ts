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
} from '../../../prompts/code-generator-prompt.js';
import { MigrationTaskEntry } from '../types.js';
import { LogFn, GENERATION_TIMEOUT_MS, withTimeout, findStubMarker } from './shared.js';

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

  const pendingCount = taskList.filter(t => t.status === 'pending' || t.status === 'failed').length;
  onLog?.(`[${CODE_GENERATOR_AGENT.name}] Stage 2: ${pendingCount} file(s) to generate, dependency-ordered.`, 'info');

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
        onLog?.(`[${CODE_GENERATOR_AGENT.name}] ${task.legacyFile}: attempt 1 failed (${lastError}). Retrying once.`, 'warning');
      }
    }

    task.status = success ? 'generated' : 'failed';
    if (!success) task.lastError = lastError;
    processed++;

    // Persist after every file, not just at the end — a crash mid-run loses
    // at most the file in progress, not the whole batch's completed work.
    await SessionManager.updateSession(sessionId, { migrationTaskList: [...taskList] });

    if (success) {
      onLog?.(`[${CODE_GENERATOR_AGENT.name}] Generated: ${task.legacyFile} -> ${task.targetFile}`, 'success');
      onFileGenerated?.(task.targetFile);
    } else {
      onLog?.(`[${CODE_GENERATOR_AGENT.name}] FAILED: ${task.legacyFile} - ${lastError}. Continuing to next file.`, 'error');
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
