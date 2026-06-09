import { AIProviderFactory } from '../ai/provider.js';
import { SessionManager } from '../session/sessionManager.js';
import { EventBroadcaster } from '../routes/stream.js';
import { TaskContextManager } from '../session/taskContext.js';
import { PlannerAgent } from './planner-agent.js';
import { ShellExecutor } from '../tools/shellExecutor.js';
import { writeSessionFile } from '../tools/fileWriter.js';
import { scanProjectDirectory } from '../tools/fileScanner.js';
import { DetectedStack, TargetStack, MigrationStatus } from '../types.js';

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
      await log('🎉 Stage 1 Analysis complete. Review Stage1_Analysis.md and migration-plan.md in the output workspace.', 'success', 'plan');
      
      // Clear API key on complete for security
      await SessionManager.updateSession(sessionId, { status: 'complete', apiKey: undefined });
      EventBroadcaster.broadcast(sessionId, 'complete', { success: true });
      return;
    }
  }
}
