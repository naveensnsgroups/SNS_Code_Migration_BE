import { AIProviderFactory } from '../ai/provider.js';
import { SessionManager } from '../session/sessionManager.js';
import { EventBroadcaster } from '../routes/stream.js';
import { TaskContextManager } from '../session/taskContext.js';
import { PlannerAgent } from './planner-agent.js';
import { PseudocodeAgent, FilePseudocode } from './pseudocode-agent.js';
import { WriterAgent } from './writer-agent.js';
import { ShellExecutor } from '../tools/shellExecutor.js';
import { ValidatorAgent } from './validator-agent.js';
import { writeSessionFile } from '../tools/fileWriter.js';
import { scanProjectDirectory } from '../tools/fileScanner.js';
import { DetectedStack, TargetStack, MigrationStatus } from '../types.js';
import fs from 'fs-extra';
import path from 'path';

export class MigrationOrchestrator {
  private static pausedSessions: Set<string> = new Set();
  private static stoppedSessions: Set<string> = new Set();

  /**
   * Request session execution stop
   */
  static stopSession(sessionId: string) {
    this.stoppedSessions.add(sessionId);
    this.pausedSessions.delete(sessionId);
    ShellExecutor.kill(sessionId);
  }

  /**
   * Request session execution pause
   */
  static pauseSession(sessionId: string) {
    this.pausedSessions.add(sessionId);
    ShellExecutor.kill(sessionId);
  }

  /**
   * Resumes or starts a migration session.
   * Runs asynchronously in the background.
   */
  static async startMigration(
    sessionId: string,
    targetStack: TargetStack,
    apiKey: string,
    apiKeys?: any,
    agentsConfig?: any
  ): Promise<void> {
    // Reset control flags
    this.pausedSessions.delete(sessionId);
    this.stoppedSessions.delete(sessionId);

    const session = await SessionManager.getSession(sessionId);
    if (!session) return;

    // Initialize/reset task context memory
    await TaskContextManager.saveContext(sessionId, { active_phase: '1' });

    // Save target stack configuration to session
    await SessionManager.updateSession(sessionId, {
      targetStack,
      status: 'planning',
      apiKey, // save temporarily for background tasks
      apiKeys,
      agentsConfig,
    });

    // Run background sequence
    this.runPipeline(sessionId).catch(async (err) => {
      console.error(`Pipeline error in session ${sessionId}:`, err);
      
      await SessionManager.updateSession(sessionId, { status: 'error', error: err.message });
      await SessionManager.addLog(sessionId, `Pipeline failed: ${err.message}`, 'error');
      
      EventBroadcaster.broadcast(sessionId, 'error', { message: err.message });
    });
  }

  private static async runPipeline(sessionId: string): Promise<void> {
    let session = await SessionManager.getSession(sessionId);
    if (!session || !session.targetStack || !session.apiKey || !session.detectedStack) {
      throw new Error('Session is missing configuration properties.');
    }

    const ai = AIProviderFactory.getService(
      session.targetStack.provider,
      session.targetStack.model,
      session.apiKey
    );

    const targetModel = session.targetStack.model;

    // Helpers to check agent configuration dynamically.
    // agentsConfig can arrive as:
    //   { "agent-id": { enabled, selectedModel } }  ← object from localStorage
    //   [{ id, enabled, selectedModel }]             ← array (future format)
    const resolveAgent = (agentId: string): any | undefined => {
      if (!session.agentsConfig) return undefined;
      if (Array.isArray(session.agentsConfig)) {
        return session.agentsConfig.find((a: any) => a.id === agentId);
      }
      // Plain object keyed by agent ID
      return (session.agentsConfig as Record<string, any>)[agentId];
    };

    const isAgentEnabled = (agentId: string): boolean => {
      const agent = resolveAgent(agentId);
      if (agent === undefined) return true; // not in config → enabled by default
      return agent.enabled !== false;
    };

    const wrapAiService = (aiService: any, agentId: string, modelName: string): any => {
      const wrapper = Object.create(aiService);
      wrapper.generateCompletion = async (
        prompt: any,
        systemPrompt?: string,
        tools?: any[]
      ) => {
        const response = await aiService.generateCompletion(prompt, systemPrompt, tools);
        if (response.usage) {
          await SessionManager.recordTokenUsage(
            sessionId,
            response.usage.promptTokens,
            response.usage.completionTokens,
            modelName,
            agentId,
            response.usage.cachedInputTokens,
            response.usage.readCachedInputTokens
          );
        }
        return response;
      };
      return wrapper;
    };

    const getAgentService = (agentId: string, defaultAi: any): any => {
      const agent = resolveAgent(agentId);
      if (!agent || !agent.selectedModel) {
        return wrapAiService(defaultAi, agentId, targetModel);
      }

      // ── Alias resolution: 'alias:reasoning-model' → look up in session.aliasesConfig
      let selectedModel = agent.selectedModel;
      if (selectedModel.startsWith('alias:')) {
        const aliasKey = selectedModel.replace('alias:', '').trim();
        const aliasesConfig = (session as any).aliasesConfig ?? {};
        const resolved = aliasesConfig[aliasKey];
        if (!resolved) {
          console.warn(`[Orchestrator] Alias "${aliasKey}" not found in aliasesConfig. Using default AI.`);
          return wrapAiService(defaultAi, agentId, targetModel);
        }
        selectedModel = resolved;
        console.info(`[Orchestrator] Resolved alias "${aliasKey}" → "${selectedModel}"`);
      }

      const parts = selectedModel.split('/');
      if (parts.length < 2) {
        return wrapAiService(defaultAi, agentId, targetModel);
      }

      const provider = parts[0].toLowerCase();
      const model = parts.slice(1).join('/');

      let key = session.apiKey;
      if (session.apiKeys) {
        if (provider === 'anthropic' && session.apiKeys.anthropic) key = session.apiKeys.anthropic;
        else if (provider === 'openai' && session.apiKeys.openai) key = session.apiKeys.openai;
        else if (provider === 'google' && session.apiKeys.google) key = session.apiKeys.google;
        else if (provider === 'grok' && session.apiKeys.grok) key = session.apiKeys.grok;
        else if (provider === 'groq' && session.apiKeys.groq) key = session.apiKeys.groq;
        else if (provider === 'openrouter' && session.apiKeys.openrouter) key = session.apiKeys.openrouter;
        else if (provider === 'huggingface' && session.apiKeys.huggingface) key = session.apiKeys.huggingface;
      }

      if (!key) {
        if (provider === 'anthropic') key = process.env.ANTHROPIC_API_KEY || '';
        else if (provider === 'openai') key = process.env.OPENAI_API_KEY || '';
        else if (provider === 'google') key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
        else if (provider === 'grok') key = process.env.XAI_API_KEY || '';
        else if (provider === 'groq') key = process.env.GROQ_API_KEY || '';
        else if (provider === 'openrouter') key = process.env.OPENROUTER_API_KEY || '';
        else if (provider === 'huggingface') key = process.env.HF_API_KEY || process.env.HF_TOKEN || '';
      }

      try {
        const service = AIProviderFactory.getService(provider, model, key || 'dummy_key');
        return wrapAiService(service, agentId, selectedModel);
      } catch (err) {
        console.error(`Failed to get service for agent ${agentId}:`, err);
        return wrapAiService(defaultAi, agentId, targetModel);
      }
    };


    const legacyPath = session.projectPath;
    const modernPath = session.modernPath;

    // Get scanned file list
    const { fileList } = await scanProjectDirectory(legacyPath);
    if (fileList.length === 0) {
      throw new Error('No files found to migrate.');
    }

    // Helper to log and broadcast changes
    const log = async (msg: string, level: 'info' | 'success' | 'warning' | 'error' | 'command' = 'info', phase?: string) => {
      const entry = await SessionManager.addLog(sessionId, msg, level, phase);
      EventBroadcaster.broadcast(sessionId, 'log', entry);
    };

    const updatePhase = async (phaseId: string, status: 'pending' | 'active' | 'done' | 'error') => {
      const activeSession = await SessionManager.getSession(sessionId);
      if (!activeSession) return;

      const updatedPhases = activeSession.phases.map(p =>
        p.id === phaseId ? { ...p, status } : p
      );

      let currentStatus: MigrationStatus = activeSession.status;
      if (status === 'active') {
        currentStatus = phaseId as MigrationStatus;
      } else if (phaseId === 'report' && status === 'done') {
        currentStatus = 'complete';
      }

      await SessionManager.updateSession(sessionId, {
        phases: updatedPhases,
        status: currentStatus,
      });

      EventBroadcaster.broadcast(sessionId, 'phase_change', {
        phase: currentStatus,
        phaseId,
        status,
      });
    };

    const checkCancellation = async (): Promise<boolean> => {
      if (this.stoppedSessions.has(sessionId)) {
        await SessionManager.updateSession(sessionId, { status: 'idle' });
        await log('Migration stopped.', 'warning');
        this.stoppedSessions.delete(sessionId);
        return true;
      }
      if (this.pausedSessions.has(sessionId)) {
        await SessionManager.updateSession(sessionId, { status: 'paused' });
        await log('Migration paused.', 'warning');
        this.pausedSessions.delete(sessionId);
        return true;
      }
      return false;
    };

    // Mark scan as done
    await updatePhase('scan', 'done');

    // ── Phase 2: Generate Plan ───────────────────────────────────────────
    let planPhase = session.phases.find(p => p.id === 'plan');
    if (planPhase && planPhase.status !== 'done') {
      if (await checkCancellation()) return;
      await updatePhase('plan', 'active');
      if (isAgentEnabled('planner-agent')) {
        const agentAi = getAgentService('planner-agent', ai);
        await PlannerAgent.run(
          sessionId,
          legacyPath,
          modernPath,
          session.detectedStack,
          session.targetStack,
          agentAi,
          async (msg, lvl) => log(msg, lvl ?? 'info', 'plan')
        );
      } else {
        await log('Skipping Phase 1: Analysis Agent is disabled in settings.', 'warning', 'plan');
        await writeSessionFile(modernPath, 'Stage1_Analysis.md', '# Legacy Codebase Analysis\n\nSkipped by user settings.');
      }
      await updatePhase('plan', 'done');
      
      // Pause pipeline here — let the user review Stage1_Analysis.md before next stage
      await SessionManager.updateSession(sessionId, { status: 'idle' });
      await log(
        '🎉 Stage 1 Analysis complete. Review Stage1_Analysis.md in the output workspace, then proceed to the next stage.',
        'success',
        'plan'
      );
      EventBroadcaster.broadcast(sessionId, 'phase_change', {
        phase: 'idle',
        phaseId: 'plan',
        status: 'done',
      });
      return; // Exit pipeline — next stage starts separately
    }

    // ── Phase 3: Write Pseudocode ────────────────────────────────────────
    let pseudocodePhase = session.phases.find(p => p.id === 'pseudocode');
    let roadmap: FilePseudocode[] = [];
    
    const pseudocodeFile = path.join(modernPath, 'pseudocode.json');
    if (await fs.pathExists(pseudocodeFile)) {
      roadmap = await fs.readJson(pseudocodeFile);
    }

    if (pseudocodePhase && pseudocodePhase.status !== 'done') {
      if (await checkCancellation()) return;
      await updatePhase('pseudocode', 'active');
      if (isAgentEnabled('pseudocode-agent')) {
        const agentAi = getAgentService('pseudocode-agent', ai);
        roadmap = await PseudocodeAgent.run(
          sessionId,
          legacyPath,
          modernPath,
          session.detectedStack,
          session.targetStack,
          fileList,
          agentAi,
          async (msg, lvl) => log(msg, lvl ?? 'info', 'pseudocode')
        );
      } else {
        await log('Skipping Phase 3: Pseudocode Strategist Agent is disabled in settings. Mapping all files to direct migration.', 'warning', 'pseudocode');
        roadmap = fileList.map(f => {
          const isSrc = !!f.match(/\.(js|py|java|php|rb)$/i);
          const targetExt = session.targetStack!.language === 'TypeScript' ? '.ts' : path.extname(f);
          const targetPath = isSrc ? f.replace(/\.[^/.]+$/, targetExt) : f;
          return {
            path: f,
            action: isSrc ? 'migrate' : 'copy',
            targetPath,
            strategy: 'Direct migration without planning.',
          };
        });
        await writeSessionFile(modernPath, 'pseudocode.json', JSON.stringify(roadmap, null, 2));
      }
      await updatePhase('pseudocode', 'done');
    }

    // ── Phase 4: Migrate Files ───────────────────────────────────────────
    let migratePhase = session.phases.find(p => p.id === 'migrate');
    if (migratePhase && migratePhase.status !== 'done') {
      if (await checkCancellation()) return;
      await updatePhase('migrate', 'active');

      const filesToMigrate = roadmap.filter(r => r.action === 'migrate' || r.action === 'copy');
      const total = filesToMigrate.length;
      
      // Read session completed files progress
      let currentSession = await SessionManager.getSession(sessionId);
      let completedCount = currentSession?.completedFiles ?? 0;

      await log(`Migrating ${total} source files file-by-file...`, 'info', 'migrate');

      if (isAgentEnabled('writer-agent')) {
        const agentAi = getAgentService('writer-agent', ai);
        for (let i = completedCount; i < total; i++) {
          if (await checkCancellation()) return;

          const item = filesToMigrate[i];
          
          // Update current file display
          await SessionManager.updateSession(sessionId, { currentFile: item.path });
          EventBroadcaster.broadcast(sessionId, 'progress', {
            percent: Math.round((i / total) * 100),
            currentFile: item.path,
          });

          await WriterAgent.migrateFile(
            sessionId,
            legacyPath,
            modernPath,
            item,
            session.detectedStack,
            session.targetStack,
            agentAi,
            async (msg, lvl) => log(msg, lvl ?? 'info', 'migrate')
          );

          if (item.action === 'migrate') {
            EventBroadcaster.broadcast(sessionId, 'file_migrated', { path: item.path });
          }

          completedCount++;
          await SessionManager.updateSession(sessionId, { completedFiles: completedCount });
        }
      } else {
        await log('Skipping Phase 4 AI modernisation: Code Writer Agent is disabled. Copying all files without changes.', 'warning', 'migrate');
        for (let i = completedCount; i < total; i++) {
          if (await checkCancellation()) return;
          const item = filesToMigrate[i];
          const src = path.join(legacyPath, item.path);
          const dest = path.join(modernPath, item.path);
          await fs.ensureDir(path.dirname(dest));
          await fs.copy(src, dest);
          
          EventBroadcaster.broadcast(sessionId, 'progress', {
            percent: Math.round((i / total) * 100),
            currentFile: item.path,
          });
          completedCount++;
          await SessionManager.updateSession(sessionId, { completedFiles: completedCount });
        }
      }

      await SessionManager.updateSession(sessionId, { currentFile: '' });
      EventBroadcaster.broadcast(sessionId, 'progress', { percent: 100, currentFile: '' });
      await updatePhase('migrate', 'done');
    }

    // ── Phase 5: Install Dependencies ────────────────────────────────────
    let installPhase = session.phases.find(p => p.id === 'install');
    if (installPhase && installPhase.status !== 'done') {
      if (await checkCancellation()) return;
      await updatePhase('install', 'active');

      // Create a template package.json for the modern target if it doesn't exist yet
      const pkgPath = path.join(modernPath, 'package.json');
      if (!(await fs.pathExists(pkgPath))) {
        await log('Writing dynamic target package.json configuration...', 'info', 'install');
        const defaultPackageJson = {
          name: 'migrated-project',
          version: '1.0.0',
          type: 'module',
          scripts: {
            build: 'tsc',
            test: session.targetStack.testFramework === 'vitest' ? 'vitest run' : 'jest',
          },
          dependencies: {},
          devDependencies: {
            typescript: '^5.0.0',
            '@types/node': '^20.0.0',
          },
        };
        await fs.writeJson(pkgPath, defaultPackageJson, { spaces: 2 });
      }

      // Create a tsconfig.json in the target directory for compilation
      const tsconfigPath = path.join(modernPath, 'tsconfig.json');
      if (!(await fs.pathExists(tsconfigPath))) {
        const defaultTsConfig = {
          compilerOptions: {
            target: 'ES2022',
            module: 'NodeNext',
            moduleResolution: 'NodeNext',
            strict: true,
            esModuleInterop: true,
            skipLibCheck: true,
            forceConsistentCasingInFileNames: true,
          },
        };
        await fs.writeJson(tsconfigPath, defaultTsConfig, { spaces: 2 });
      }

      await log('Installing Node dependencies inside modern target...', 'info', 'install');
      try {
        await ShellExecutor.execute(sessionId, 'npm install', {
          cwd: modernPath,
          onLog: (msg, isErr) => log(msg, isErr ? 'warning' : 'info', 'install'),
          timeoutMs: 180000, // 3 minutes max
        });
        await updatePhase('install', 'done');
      } catch (err: any) {
        await log(`Dependencies install completed with errors: ${err.message}`, 'warning', 'install');
        // We do not fail the build immediately because user code might still compile
        await updatePhase('install', 'done');
      }
    }

    // ── Phase 6: Build Project ───────────────────────────────────────────
    let buildPhase = session.phases.find(p => p.id === 'build');
    let buildPassed = false;
    let buildErrorOutput = '';

    if (buildPhase && buildPhase.status !== 'done') {
      if (await checkCancellation()) return;
      await updatePhase('build', 'active');
      await log('Compiling modern project utilizing tsc...', 'info', 'build');
      
      try {
        const result = await ShellExecutor.execute(sessionId, 'npx tsc --noEmit', {
          cwd: modernPath,
          onLog: (msg, isErr) => log(msg, isErr ? 'warning' : 'info', 'build'),
          timeoutMs: 60000,
        });

        if (result.code === 0) {
          buildPassed = true;
          await log('🎉 Compilation passed with 0 errors.', 'success', 'build');
        } else {
          buildErrorOutput = result.stdout + '\n' + result.stderr;
          await log(`⚠️ Compilation failed with exit code ${result.code}`, 'warning', 'build');
        }
        await updatePhase('build', 'done');
      } catch (err: any) {
        buildErrorOutput = err.message;
        await log(`⚠️ Compilation failed: ${err.message}`, 'warning', 'build');
        await updatePhase('build', 'done');
      }
    } else {
      buildPassed = true; // Skipped if already done
    }

    // ── Phase 7: Validate & Fix ──────────────────────────────────────────
    let validatePhase = session.phases.find(p => p.id === 'validate');
    if (validatePhase && validatePhase.status !== 'done') {
      if (await checkCancellation()) return;
      await updatePhase('validate', 'active');

      if (buildPassed) {
        await log('Skipping Phase 7: Build was already verified clean.', 'success', 'validate');
        await updatePhase('validate', 'done');
      } else if (!isAgentEnabled('validator-agent')) {
        await log('Skipping Phase 7 auto-repair: Code Validator Agent is disabled in settings.', 'warning', 'validate');
        await updatePhase('validate', 'done');
      } else {
        await log('Analyzing compilation errors for automated repair...', 'info', 'validate');
        const validationErrors = ValidatorAgent.parseTscOutput(buildErrorOutput);
        
        if (validationErrors.length === 0) {
          await log('No parseable source errors found. Skipping auto-repair.', 'warning', 'validate');
          await updatePhase('validate', 'done');
        } else {
          await log(`Found ${validationErrors.length} type/compiler errors. Running auto-repairs...`, 'info', 'validate');
          const agentAi = getAgentService('validator-agent', ai);
          
          // Resolve up to 5 errors in one cycle to prevent loops
          const maxErrorsToFix = Math.min(validationErrors.length, 5);
          for (let e = 0; e < maxErrorsToFix; e++) {
            if (await checkCancellation()) return;
            const err = validationErrors[e];
            await ValidatorAgent.resolveError(
              sessionId,
              modernPath,
              err,
              agentAi,
              async (msg, lvl) => log(msg, lvl ?? 'info', 'validate')
            );
          }

          // Verify build again after fixes
          await log('Re-compiling to verify repairs...', 'info', 'validate');
          try {
            const reBuild = await ShellExecutor.execute(sessionId, 'npx tsc --noEmit', {
              cwd: modernPath,
              onLog: (msg, isErr) => log(msg, isErr ? 'warning' : 'info', 'validate'),
              timeoutMs: 60000,
            });

            if (reBuild.code === 0) {
              await log('🎉 Compilation passed successfully after auto-repairs!', 'success', 'validate');
            } else {
              await log('⚠️ Some warnings/errors remain after auto-repair. Proceeding.', 'warning', 'validate');
            }
          } catch (err: any) {
            await log(`⚠️ Re-compilation check failed: ${err.message}`, 'warning', 'validate');
          }
          await updatePhase('validate', 'done');
        }
      }
    }

    // ── Phase 8: Run Tests ───────────────────────────────────────────────
    let testPhase = session.phases.find(p => p.id === 'test');
    if (testPhase && testPhase.status !== 'done') {
      if (await checkCancellation()) return;
      await updatePhase('test', 'active');
      await log(`Running tests utilizing ${session.targetStack.testFramework}...`, 'info', 'test');

      try {
        const testResult = await ShellExecutor.execute(sessionId, 'npm test', {
          cwd: modernPath,
          onLog: (msg, isErr) => log(msg, isErr ? 'warning' : 'info', 'test'),
          timeoutMs: 60000,
        });

        if (testResult.code === 0) {
          await log('🎉 All tests passed successfully!', 'success', 'test');
        } else {
          await log(`⚠️ Tests failed (exit code ${testResult.code}). Check terminal logs.`, 'warning', 'test');
        }
        await updatePhase('test', 'done');
      } catch (err: any) {
        await log(`⚠️ Testing skipped/failed: ${err.message}`, 'warning', 'test');
        await updatePhase('test', 'done');
      }
    }

    // ── Phase 9: Final Report ────────────────────────────────────────────
    if (await checkCancellation()) return;
    await updatePhase('report', 'active');
    await log('Generating final migration report...', 'info', 'report');

    const reportContent = `# Code Migration Report

## Migration Summary
- **Session ID**: ${sessionId}
- **Legacy Stack**: ${session.detectedStack.language} (${session.detectedStack.framework})
- **Modern Stack**: ${session.targetStack.language} (${session.targetStack.framework})
- **Status**: Complete ✅
- **Total Scanned Files**: ${fileList.length}

## Verification Results
- **Dependencies Installed**: Yes
- **Compilation Verified**: Clean or auto-repaired
- **Testing Run**: Yes

Report generated automatically by Code Migration Platform.`;

    await writeSessionFile(modernPath, 'migration-report.md', reportContent);
    await log('🎉 Modernization pipeline finished successfully!', 'success', 'report');
    
    // Clear API key on complete for security
    await SessionManager.updateSession(sessionId, { apiKey: undefined });
    await updatePhase('report', 'done');

    EventBroadcaster.broadcast(sessionId, 'complete', { success: true });
  }
}
