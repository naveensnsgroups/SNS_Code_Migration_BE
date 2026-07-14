// Verification sub-stage — three checks per file, then one whole-project check:
//   1. Deterministic cross-file reference check (see verification.ts).
//   2. LLM rule-coverage judgment against each file's attached business rules.
//   3. A REAL build check: a real E2B sandbox (see sandbox-manager.ts) installs
//      dependencies and imports/builds every file for real, including the
//      assembled entrypoint. Degrades to a best-effort host-toolchain check
//      if no sandbox is configured/available.
// On a failed check, attempts up to 2 bounded regeneration fixes, each staged
// to a temp path (or backed up first, for the real-build-error case, since its
// recheck runs against the real path) — a fix is only kept if it's actually
// better than what was there, and each attempt is told what the previous one
// already tried (task.fixAttempts).
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
  selectRelevantConventions,
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
import { LogFn, GENERATION_TIMEOUT_MS, RULE_CHECK_TIMEOUT_MS, BUILD_CHECK_TIMEOUT_MS, withTimeout, INFRASTRUCTURE_TASK_PREFIX, resolveScaffoldingBrief } from './shared.js';
import { resolveFrameworkSkill } from '../../../knowledge/framework-skills/registry.js';
import { extractExportedSymbols } from '../symbol-extraction.js';
import { provisionSandbox } from '../../../sandbox/sandbox-manager.js';
import { FullProjectCheckResult } from '../../../session/types.js';

// A shared scaffolding dependency (e.g. the DB connection module — see
// buildScaffoldingTasks) is wired into EVERY task's dependsOn so it's available
// for the generator to import if relevant — it is NOT mandatory. A file with
// no real need for it (a pure JSON/hash utility, confirmed in a real run)
// correctly won't reference it, and the deterministic cross-file check must
// not fail it for that — only a REAL legacy-to-legacy dependency (the
// Planner's dependsOn edges from the imports-graph) is something the
// generated file is actually required to reference.
//
// A 'last'-order scaffolding task (the entrypoint) is a SEPARATE case: its own
// dependsOn is set to every real task in the project so it's always generated
// LAST (an ordering need), not because it must literally import every one of
// them. A real run confirmed this produces a false failure: main.py correctly
// does not import app/dependencies.py (only the routers use it) or schema.sql
// (not even a Python file) — yet the deterministic check demanded both be
// "referenced". The entrypoint's own generated correctness is already proven
// by the real, sandboxed full-project build check (which actually imports it) —
// the crude string-presence heuristic below is the wrong tool for this task,
// so it's skipped entirely for any task whose OWN legacyFile is a scaffolding marker.
function mandatoryDependsOn(ownerLegacyFile: string, dependsOn: string[]): string[] {
  if (ownerLegacyFile.startsWith(INFRASTRUCTURE_TASK_PREFIX)) return [];
  return dependsOn.filter(d => !d.startsWith(INFRASTRUCTURE_TASK_PREFIX));
}

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

  // Includes every merged-in secondary legacy file (see mergeTargetFileCollisions)
  // so a dependent task can still resolve the correct target path for one.
  const legacyToTarget = new Map(
    taskList.flatMap(t => [t.legacyFile, ...(t.mergedLegacyFiles ?? [])].map(lf => [lf, t.targetFile] as const))
  );

  // Curated per-target-framework conventions — see migration-planning-runner.ts.
  // Resolved once; the SELECTION of which sections apply is done per-task
  // below (selectRelevantConventions), since it depends on each task's own
  // targetFile, not a single fixed bundle for every regeneration-fix call.
  const skill = await resolveFrameworkSkill(targetStack.framework);

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

    const allLegacyFiles = [task.legacyFile, ...(task.mergedLegacyFiles ?? [])];
    const taskLabel = allLegacyFiles.join(' + ');

    // Selected per-task, not once for the whole run — see selectRelevantConventions.
    const frameworkConventions = skill
      ? selectRelevantConventions(skill, task.targetFile)
      : undefined;

    const targetAbsPath = path.join(modernPath, task.targetFile);
    const dependencyTargetPaths = mandatoryDependsOn(task.legacyFile, task.dependsOn)
      .map(f => legacyToTarget.get(f))
      .filter((f): f is string => !!f);

    let content = '';
    try { content = await fs.readFile(targetAbsPath, 'utf-8'); } catch { /* treat as empty — will fail below */ }

    let unresolved = checkCrossFileReferences(content, dependencyTargetPaths);

    const dependencyTargets = task.dependsOn
      .map(legacyFile => {
        const targetFile = legacyToTarget.get(legacyFile);
        if (!targetFile) return null;
        const owner = taskList.find(t => t.legacyFile === legacyFile || t.mergedLegacyFiles?.includes(legacyFile));
        return { legacyFile, targetFile, exportedSymbols: owner?.exportedSymbols };
      })
      .filter((d): d is NonNullable<typeof d> => d !== null);

    for (let attempt = 1; attempt <= 2 && unresolved.length > 0; attempt++) {
      onLog?.(
        `[Verification] ${task.targetFile}: unresolved reference(s) to ${unresolved.join(', ')}. ` +
        `Attempting fix ${attempt}/2 via ${CODE_GENERATOR_AGENT.name}.`,
        'warning'
      );

      // Checkpoint: fix attempts write to a temp path, never the real target
      // directly — a fix that doesn't actually resolve the reference must
      // never overwrite the last-known-good file with something worse.
      const tempRelPath = `${task.targetFile}.fixing.tmp`;
      const tempAbsPath = path.join(modernPath, tempRelPath);
      const lockedTools = lockWriteFileTool(codeGenTools, tempRelPath);

      task.fixAttempts = [
        ...(task.fixAttempts ?? []),
        `Unresolved reference(s) to: ${unresolved.join(', ')} — these dependencies were not ` +
        `found referenced anywhere in your previous output. Import them correctly this time.`,
      ];
      const attemptHistory = task.fixAttempts
        .map((e, i) => `Attempt ${i + 1}: ${e}`)
        .join('\n');

      try {
        await withTimeout(
          AgentExecutor.execute(
            codeGenProvider,
            CODE_GENERATOR_SYSTEM_PROMPT,
            buildCodeGeneratorUserPrompt(
              allLegacyFiles, task.targetFile, task.rulesInvolved,
              targetStackForPrompt, detectedStack.language, detectedStack.framework,
              dependencyTargets,
              attemptHistory,
              resolveScaffoldingBrief(skill, task.legacyFile),
              frameworkConventions
            ),
            lockedTools, context, codeGenModel, `verification-fix-${taskLabel}-attempt${attempt}`,
            undefined, CODE_GENERATOR_AGENT.recoveryHint
          ),
          GENERATION_TIMEOUT_MS,
          `verification-fix-${taskLabel}`
        );
        const newContent = await fs.readFile(tempAbsPath, 'utf-8').catch(() => '');
        const stillUnresolved = checkCrossFileReferences(newContent, dependencyTargetPaths);
        if (stillUnresolved.length < unresolved.length) {
          // Promote only when the fix actually improved things — never
          // overwrite the real file with something equally or more broken.
          await fs.ensureDir(path.dirname(targetAbsPath));
          await fs.move(tempAbsPath, targetAbsPath, { overwrite: true });
          content = newContent;
          // Re-extract — a fix can change what this file exports (a rename, a
          // new/removed function, a change in async-ness); anything that reads
          // task.exportedSymbols after this point must see the CURRENT content,
          // not what the first generation pass produced.
          if (content) task.exportedSymbols = extractExportedSymbols(content, targetStack.language);
        } else {
          await fs.remove(tempAbsPath).catch(() => {});
        }
        unresolved = stillUnresolved;
      } catch (err: any) {
        await fs.remove(tempAbsPath).catch(() => {});
        onLog?.(`[${CODE_GENERATOR_AGENT.name}] ${task.targetFile}: regeneration fix attempt ${attempt} failed: ${err.message}`, 'error');
      }
    }

    // Rule coverage — only meaningful once cross-file wiring is sound;
    // checking rule logic in a file whose imports are already broken adds
    // nothing. Skips entirely for files with no attached rules.
    let ruleResult: { covered: string[]; uncovered: string[] } | null = null;
    if (unresolved.length === 0) {
      ruleResult = await checkRules(task.rulesInvolved, taskLabel, task.targetFile, content);

      for (let attempt = 1; attempt <= 2 && ruleResult && ruleResult.uncovered.length > 0; attempt++) {
        onLog?.(
          `[Verification] ${task.targetFile}: rule(s) not enforced: ${ruleResult.uncovered.join('; ')}. ` +
          `Attempting fix ${attempt}/2 via ${CODE_GENERATOR_AGENT.name}.`,
          'warning'
        );

        const tempRelPath = `${task.targetFile}.fixing.tmp`;
        const tempAbsPath = path.join(modernPath, tempRelPath);
        const lockedTools = lockWriteFileTool(codeGenTools, tempRelPath);

        task.fixAttempts = [
          ...(task.fixAttempts ?? []),
          `These specific business rule(s) are NOT visibly enforced in your previous output: ` +
          `${ruleResult.uncovered.join('; ')}. Add the missing validation/branch/error logic for ` +
          `each of them while keeping everything else intact.`,
        ];
        const attemptHistory = task.fixAttempts
          .map((e, i) => `Attempt ${i + 1}: ${e}`)
          .join('\n');

        try {
          await withTimeout(
            AgentExecutor.execute(
              codeGenProvider,
              CODE_GENERATOR_SYSTEM_PROMPT,
              buildCodeGeneratorUserPrompt(
                allLegacyFiles, task.targetFile, task.rulesInvolved,
                targetStackForPrompt, detectedStack.language, detectedStack.framework,
                dependencyTargets,
                attemptHistory,
                resolveScaffoldingBrief(skill, task.legacyFile),
                frameworkConventions
              ),
              lockedTools, context, codeGenModel, `rule-fix-${taskLabel}-attempt${attempt}`,
              undefined, CODE_GENERATOR_AGENT.recoveryHint
            ),
            GENERATION_TIMEOUT_MS,
            `rule-fix-${taskLabel}`
          );
          const newContent = await fs.readFile(tempAbsPath, 'utf-8').catch(() => '');
          const newUnresolved = checkCrossFileReferences(newContent, dependencyTargetPaths);
          const newRuleResult = newUnresolved.length === 0
            ? await checkRules(task.rulesInvolved, taskLabel, task.targetFile, newContent)
            : ruleResult; // cross-file check regressed — don't bother re-checking rules

          const improved = newUnresolved.length === 0
            && (!newRuleResult || newRuleResult.uncovered.length < ruleResult.uncovered.length);
          if (improved) {
            await fs.ensureDir(path.dirname(targetAbsPath));
            await fs.move(tempAbsPath, targetAbsPath, { overwrite: true });
            content    = newContent;
            unresolved = newUnresolved;
            ruleResult = newRuleResult;
            if (content) task.exportedSymbols = extractExportedSymbols(content, targetStack.language);
          } else {
            await fs.remove(tempAbsPath).catch(() => {});
          }
        } catch (err: any) {
          await fs.remove(tempAbsPath).catch(() => {});
          onLog?.(`[${CODE_GENERATOR_AGENT.name}] ${task.targetFile}: rule fix attempt ${attempt} failed: ${err.message}`, 'error');
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

  // A real, isolated, guaranteed sandbox (E2B) for this check — see
  // sandbox-manager.ts for why: capturedShellExecute routes through it when
  // present (ctx.sandbox), so every install/build command below runs there
  // instead of on this host. null (no E2B_API_KEY, or provisioning failed)
  // degrades gracefully to today's best-effort host-toolchain behavior.
  const sandbox = await provisionSandbox(sessionId, targetStack, modernPath);
  onLog?.(
    sandbox
      ? '[Verification] Real build check will run inside an isolated E2B sandbox.'
      : '[Verification] No E2B sandbox available (not configured, or provisioning failed) — falling back to whatever toolchain this host happens to have installed.',
    sandbox ? 'info' : 'warning'
  );
  let buildContext: ToolContext = sandbox ? ToolContext.withSandbox(context, sandbox) : context;

  // Real env vars from the generated project's own .env scaffolding file
  // (see fastapi/skill.md's env-file entry) — parsed here and attached so
  // every sandboxed command below actually has what db.py's os.getenv(...)
  // calls expect, instead of nothing. Simple KEY=VALUE line parse — no new
  // dependency needed for this.
  const envFileContent = await fs.readFile(path.join(modernPath, '.env'), 'utf-8').catch(() => null);
  if (envFileContent) {
    const parsedEnvs: Record<string, string> = {};
    for (const line of envFileContent.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;
      parsedEnvs[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
    }
    if (Object.keys(parsedEnvs).length > 0) {
      buildContext = ToolContext.withEnvs(buildContext, parsedEnvs);
      onLog?.(`[Verification] Loaded ${Object.keys(parsedEnvs).length} env var(s) from .env for the real build check.`, 'info');
    }
  }

  // The one real file that proves the WHOLE project is wired together, not
  // just individually well-formed files — see buildScaffoldingTasks (Workstream 1).
  const entrypointTask = taskList.find(t => t.legacyFile === `${INFRASTRUCTURE_TASK_PREFIX}entrypoint`);

  const runBuildVerification = async (files: string[], tag: string, entrypointFile?: string): Promise<BuildCheckOutcome | null> => {
    try {
      await withTimeout(
        AgentExecutor.execute(
          buildVerificationProvider,
          BUILD_VERIFICATION_SYSTEM_PROMPT,
          buildBuildVerificationUserPrompt(files, targetStackForPrompt, entrypointFile),
          buildTools, buildContext, buildVerificationModel, tag,
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
  let fullProjectCheckResult: FullProjectCheckResult = {
    ran: false, sandboxAvailable: !!sandbox, errors: [], checkedAt: new Date().toISOString(),
  };

  if (nonPendingTasks.length > 0) {
    onLog?.(`[${BUILD_VERIFICATION_AGENT.name}] Running real build verification (agent-directed — no hardcoded per-language logic)...`, 'info');

    const buildResult = await runBuildVerification(
      nonPendingTasks.map(t => t.targetFile), 'build-verification', entrypointTask?.targetFile
    );
    fullProjectCheckResult = {
      ran: !!buildResult?.environmentAvailable,
      sandboxAvailable: !!sandbox,
      errors: buildResult
        ? Object.entries(buildResult.results).filter(([, r]) => !r.passed).map(([file, r]) => ({ file, message: r.error || 'unknown real build error' }))
        : [],
      checkedAt: new Date().toISOString(),
    };

    if (buildResult && buildResult.environmentAvailable) {
      for (const task of nonPendingTasks) {
        const fileResult = buildResult.results[task.targetFile];
        if (!fileResult || fileResult.passed) continue;

        const realError = fileResult.error || 'unknown real build error';
        const allLegacyFiles = [task.legacyFile, ...(task.mergedLegacyFiles ?? [])];
        const taskLabel = allLegacyFiles.join(' + ');

        // Selected per-task, not once for the whole run — see selectRelevantConventions.
        const frameworkConventions = skill
          ? selectRelevantConventions(skill, task.targetFile)
          : undefined;

        const dependencyTargets = task.dependsOn
          .map(legacyFile => {
            const targetFile = legacyToTarget.get(legacyFile);
            if (!targetFile) return null;
            const owner = taskList.find(t => t.legacyFile === legacyFile || t.mergedLegacyFiles?.includes(legacyFile));
            return { legacyFile, targetFile, exportedSymbols: owner?.exportedSymbols };
          })
          .filter((d): d is NonNullable<typeof d> => d !== null);

        const lockedTools = lockWriteFileTool(codeGenTools, task.targetFile);
        const targetAbsPathForFix = path.join(modernPath, task.targetFile);
        // Checkpoint: the recheck below re-runs the real sandboxed build
        // check against this exact real path (not a temp path — the Build
        // Verification Agent's own file list names the real path), so the
        // rollback here is backup-then-restore instead of write-temp-then-
        // promote. Either way, a fix attempt that doesn't actually pass never
        // leaves the real file worse than it started.
        const lastGoodContent = await fs.readFile(targetAbsPathForFix, 'utf-8').catch(() => null);

        let fixedError = realError;
        for (let attempt = 1; attempt <= 2 && fixedError; attempt++) {
          onLog?.(
            `[${BUILD_VERIFICATION_AGENT.name}] ${task.targetFile}: real error: ${fixedError.slice(0, 300)}. ` +
            `Attempting fix ${attempt}/2 via ${CODE_GENERATOR_AGENT.name}.`,
            'warning'
          );

          task.fixAttempts = [
            ...(task.fixAttempts ?? []),
            `Running this file for real produced this error: ${fixedError.slice(0, 800)}\n` +
            `Fix the actual bug causing this (e.g. a missing import, undefined name, or syntax ` +
            `error) while keeping all existing logic and rules intact.`,
          ];
          const attemptHistory = task.fixAttempts
            .map((e, i) => `Attempt ${i + 1}: ${e}`)
            .join('\n');

          try {
            await withTimeout(
              AgentExecutor.execute(
                codeGenProvider,
                CODE_GENERATOR_SYSTEM_PROMPT,
                buildCodeGeneratorUserPrompt(
                  allLegacyFiles, task.targetFile, task.rulesInvolved,
                  targetStackForPrompt, detectedStack.language, detectedStack.framework,
                  dependencyTargets,
                  attemptHistory,
                  resolveScaffoldingBrief(skill, task.legacyFile),
                  frameworkConventions
                ),
                lockedTools, context, codeGenModel, `real-check-fix-${taskLabel}-attempt${attempt}`,
                undefined, CODE_GENERATOR_AGENT.recoveryHint
              ),
              GENERATION_TIMEOUT_MS,
              `real-check-fix-${taskLabel}`
            );

            const recheck = await runBuildVerification([task.targetFile], `real-check-recheck-${taskLabel}`);
            const recheckResult = recheck?.results[task.targetFile];
            fixedError = recheckResult && !recheckResult.passed ? (recheckResult.error || 'still failing') : '';

            if (!fixedError) {
              const content = await fs.readFile(targetAbsPathForFix, 'utf-8').catch(() => '');
              const dependencyTargetPaths = mandatoryDependsOn(task.legacyFile, task.dependsOn)
                .map(f => legacyToTarget.get(f))
                .filter((f): f is string => !!f);
              const stillResolved = checkCrossFileReferences(content, dependencyTargetPaths).length === 0;
              if (content) task.exportedSymbols = extractExportedSymbols(content, targetStack.language);
              if (stillResolved) {
                task.status = 'verified';
                task.lastError = undefined;
              } else {
                fixedError = 'regeneration fixed the real build error but broke a cross-file reference';
              }
            }
          } catch (err: any) {
            fixedError = `regeneration fix attempt ${attempt} failed to run: ${err.message}`;
          }
        }

        // Rollback: every attempt failed — restore the last-known-good
        // content instead of leaving whatever the final failed attempt wrote.
        if (fixedError && lastGoodContent !== null) {
          await fs.writeFile(targetAbsPathForFix, lastGoodContent, 'utf-8').catch(() => {});
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

  if (sandbox) await sandbox.destroy().catch(() => {});
  await SessionManager.updateSession(sessionId, { fullProjectCheckResult });

  const verifiedCount = taskList.filter(t => t.status === 'verified').length;
  const failedCount   = taskList.filter(t => t.status === 'failed').length;
  onLog?.(
    `[Verification] Stage 2 complete: ${verifiedCount} verified, ${failedCount} still failing. ` +
    `Checks performed: deterministic cross-file reference matching, an LLM rule-coverage judgment against each ` +
    `file's Rule Coverage Manifest entries, and ${fullProjectCheckResult.ran
      ? `a real, agent-directed dependency install + import/build check${fullProjectCheckResult.sandboxAvailable ? ' (ran inside an isolated E2B sandbox)' : ' (ran on this host — no sandbox was available)'}, ${fullProjectCheckResult.errors.length} real error(s) found`
      : 'no real build check this pass (no usable toolchain — sandbox unavailable and no host toolchain either)'}.`,
    failedCount > 0 ? 'warning' : 'success'
  );
}
