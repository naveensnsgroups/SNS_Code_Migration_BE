// Verification sub-stage: deterministic cross-file reference check (see
// verification.ts for why this is the reliable check available — real
// build/execute verification needs an installed toolchain for whatever
// target stack the user chose, which this platform does not provision).
// On a failed check, attempts ONE bounded regeneration of that file with
// the exact unresolved reference named, then re-checks.
import fs   from 'fs-extra';
import path from 'path';
import { DetectedStack, TargetStack } from '../../../types.js';
import { toolRegistry }               from '../../../core/tool-invocation-registry.js';
import { ToolContext }                from '../../../types/tool.js';
import { AgentExecutor }              from '../../core/agentExecutor.js';
import { TaskContextManager }         from '../../../session/taskContext.js';
import { SessionManager }             from '../../../session/sessionManager.js';
import { resolveStreamingProvider }   from '../../../ai/index.js';
import { lockWriteFileTool }          from '../../core/tool-locking.js';
import {
  CODE_GENERATOR_AGENT, RULE_COVERAGE_AGENT, BUILD_VERIFICATION_AGENT,
} from '../../core/agent-definitions.js';
import {
  CODE_GENERATOR_SYSTEM_PROMPT,
  buildCodeGeneratorUserPrompt,
} from '../../../prompts/code-generator-prompt.js';
import {
  RULE_COVERAGE_SYSTEM_PROMPT,
  buildRuleCoverageUserPrompt,
} from '../../../prompts/rule-coverage-prompt.js';
import {
  BUILD_VERIFICATION_SYSTEM_PROMPT,
  buildBuildVerificationUserPrompt,
} from '../../../prompts/build-verification-prompt.js';
import { checkCrossFileReferences } from '../verification.js';
import { MigrationTaskEntry, RuleCoverageEntry } from '../types.js';
import { LogFn, GENERATION_TIMEOUT_MS, RULE_CHECK_TIMEOUT_MS, BUILD_CHECK_TIMEOUT_MS, withTimeout } from './shared.js';

export async function runVerification(
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
    onLog?.('[Verification] No generated files to verify — run Code Generation first.', 'warning');
    return;
  }

  onLog?.(
    `[Verification] Stage 2: checking cross-file references + rule coverage for ${toVerifyCount} file(s).`,
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
      onLog?.(`[${RULE_COVERAGE_AGENT.name}] ${targetFile}: rule coverage check failed to run: ${err.message}`, 'warning');
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
        `[Verification] ${task.targetFile}: unresolved reference(s) to ${unresolved.join(', ')}. Attempting one regeneration fix via ${CODE_GENERATOR_AGENT.name}.`,
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
        onLog?.(`[${CODE_GENERATOR_AGENT.name}] ${task.targetFile}: regeneration fix failed: ${err.message}`, 'error');
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
          `[Verification] ${task.targetFile}: rule(s) not enforced: ${ruleResult.uncovered.join('; ')}. Attempting one regeneration fix via ${CODE_GENERATOR_AGENT.name}.`,
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
          onLog?.(`[${CODE_GENERATOR_AGENT.name}] ${task.targetFile}: rule fix regeneration failed: ${err.message}`, 'error');
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
      onLog?.(`[Verification] Verified: ${task.targetFile}`, 'success');
    } else {
      onLog?.(`[Verification] FAILED verification: ${task.targetFile} — ${task.lastError}`, 'error');
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
      onLog?.(`[${BUILD_VERIFICATION_AGENT.name}] did not report a result — treating as unavailable.`, 'warning');
      return null;
    } catch (err: any) {
      onLog?.(`[${BUILD_VERIFICATION_AGENT.name}] failed to run: ${err.message}`, 'warning');
      return null;
    }
  };

  const nonPendingTasks = taskList.filter(t => t.status !== 'pending');
  if (nonPendingTasks.length > 0) {
    onLog?.(`[${BUILD_VERIFICATION_AGENT.name}] Running real build verification (agent-directed — no hardcoded per-language logic)...`, 'info');

    const buildResult = await runBuildVerification(nonPendingTasks.map(t => t.targetFile), 'build-verification');

    if (buildResult && buildResult.environmentAvailable) {
      for (const task of nonPendingTasks) {
        const fileResult = buildResult.results[task.targetFile];
        if (!fileResult || fileResult.passed) continue;

        const realError = fileResult.error || 'unknown real build error';
        onLog?.(
          `[${BUILD_VERIFICATION_AGENT.name}] ${task.targetFile}: real error: ${realError.slice(0, 300)}. Attempting one regeneration fix via ${CODE_GENERATOR_AGENT.name}.`,
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
          onLog?.(`[${BUILD_VERIFICATION_AGENT.name}] FAILED real build check: ${task.targetFile} — ${fixedError}`, 'error');
        } else {
          onLog?.(`[${BUILD_VERIFICATION_AGENT.name}] Real build check passed after fix: ${task.targetFile}`, 'success');
        }

        await SessionManager.updateSession(sessionId, { migrationTaskList: [...taskList] });
      }
    } else {
      onLog?.(
        `[${BUILD_VERIFICATION_AGENT.name}] Real build check did not run for target language "${targetStack.language}" — ` +
        `only the deterministic cross-file check and LLM rule-coverage check ran for this pass.`,
        'warning'
      );
    }
  }

  const verifiedCount = taskList.filter(t => t.status === 'verified').length;
  const failedCount   = taskList.filter(t => t.status === 'failed').length;
  onLog?.(
    `[Verification] Stage 2 complete: ${verifiedCount} verified, ${failedCount} still failing. ` +
    `Checks performed: deterministic cross-file reference matching, an LLM rule-coverage judgment against each ` +
    `file's Rule Coverage Manifest entries, and — where the Build Verification Agent found a usable toolchain ` +
    `for the target language — a real, agent-directed dependency install + import/build check.`,
    failedCount > 0 ? 'warning' : 'success'
  );
}
