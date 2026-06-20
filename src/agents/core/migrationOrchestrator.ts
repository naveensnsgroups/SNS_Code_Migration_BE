import { SessionManager } from '../../session/sessionManager.js';
import { EventBroadcaster } from '../../routes/stream.js';
import { TaskContextManager } from '../../session/taskContext.js';
import { PlannerAgent } from '../stage1/planner-agent.js';
import { ShellExecutor } from '../../tools/shellExecutor.js';
import { writeSessionFile } from '../../tools/fileWriter.js';
import { scanProjectDirectory } from '../../tools/fileScanner.js';
import { DetectedStack, TargetStack, MigrationStatus } from '../../types.js';
import { resolveApiKey, resolveModelAlias } from '../../ai/index.js';

export class MigrationOrchestrator {
  private static pausedSessions:  Set<string> = new Set();
  private static stoppedSessions: Set<string> = new Set();

  // ── Mutex guard: prevents two concurrent pipelines on the same session ────
  // SNS IDE equivalent: TaskManager ensures one task runs per workspace at a time.
  // Without this guard, double-clicking "Start" corrupts FILE_INDEX (two agents
  // both write edit_task_context simultaneously → one overwrites the other's work).
  private static activeSessions:  Set<string> = new Set();

  /**
   * Request session execution stop
   */
  static stopSession(sessionId: string) {
    this.stoppedSessions.add(sessionId);
    this.pausedSessions.delete(sessionId);
    this.activeSessions.delete(sessionId);  // release mutex so user can restart cleanly
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
    // ── Double-start guard ────────────────────────────────────────────────
    // If a pipeline is already running for this session, do NOT start another.
    // This prevents FILE_INDEX corruption from two concurrent agent instances.
    if (this.activeSessions.has(sessionId)) {
      console.warn(`[MigrationOrchestrator] Session ${sessionId} is already running. Ignoring duplicate startMigration call.`);
      return;
    }

    // Reset control flags
    this.pausedSessions.delete(sessionId);
    this.stoppedSessions.delete(sessionId);

    const session = await SessionManager.getSession(sessionId);
    if (!session) return;

    // Initialize task context ONLY for fresh sessions.
    // If active_phase already exists, this is a RESUME — preserve all existing state
    // (TOTAL_FILES, FILE_INDEX, LAST_FILE_ANALYZED, graph data, etc.).
    // Overwriting on resume would force the pipeline to restart from scratch,
    // wasting all LLM tokens already spent on the previous run.
    const existingCtx = await TaskContextManager.getContext(sessionId);
    const isResume    = !!existingCtx.active_phase && existingCtx.active_phase !== 'complete';
    if (!isResume) {
      // Fresh start — initialize task context
      await TaskContextManager.saveContext(sessionId, { active_phase: 'discovery' });
    } else {
      // Resume — log which phase we are resuming from
      console.log(`[MigrationOrchestrator] Resuming session ${sessionId} from phase "${existingCtx.active_phase}".`);
    }

    // Save target stack configuration to session
    await SessionManager.updateSession(sessionId, {
      targetStack,
      status: 'planning',
      apiKey, // save temporarily for background tasks
      apiKeys,
      agentsConfig,
    });

    // Mark session as active — mutex lock acquired
    this.activeSessions.add(sessionId);

    // Run background sequence
    this.runPipeline(sessionId).catch(async (err) => {
      console.error(`Pipeline error in session ${sessionId}:`, err);

      await SessionManager.updateSession(sessionId, { status: 'error', error: err.message });
      await SessionManager.addLog(sessionId, `Pipeline failed: ${err.message}`, 'error');

      EventBroadcaster.broadcast(sessionId, 'error', { message: err.message });
    }).finally(() => {
      // ── Release mutex lock — session is no longer active ─────────────────
      this.activeSessions.delete(sessionId);
    });
  }

  private static async runPipeline(sessionId: string): Promise<void> {
    let session = await SessionManager.getSession(sessionId);
    if (!session || !session.targetStack || !session.detectedStack) {
      throw new Error('Session is missing configuration properties.');
    }

    // Only need apiKey to validate it exists — PlannerAgent resolves its own
    // streaming provider from session config via resolveStreamingProvider()
    const resolvedModel = resolveModelAlias(session.targetStack.model, (session as any).aliasesConfig ?? {});
    const apiKey = resolveApiKey(
      session.targetStack.provider,
      session.apiKey || '',
      session.apiKeys
    );
    if (!apiKey) {
      throw new Error(`API key for provider "${session.targetStack.provider}" could not be resolved.`);
    }
    // Suppress unused-var — kept for future Stage 2+ orchestration
    void resolvedModel;

    // ── Agent enable/disable check (from agentsConfig sent by UI) ─────────────
    // agentsConfig can arrive as:
    //   { "agent-id": { enabled, selectedModel } }  ← object from localStorage
    //   [{ id, enabled, selectedModel }]             ← array (future format)
    const resolveAgent = (agentId: string): any | undefined => {
      if (!session.agentsConfig) return undefined;
      if (Array.isArray(session.agentsConfig)) {
        return session.agentsConfig.find((a: any) => a.id === agentId);
      }
      return (session.agentsConfig as Record<string, any>)[agentId];
    };

    const isAgentEnabled = (agentId: string): boolean => {
      const agent = resolveAgent(agentId);
      if (agent === undefined) return true; // not in config → enabled by default
      return agent.enabled !== false;
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

    // ── Stage 1: Run all 5 sub-phases via PlannerAgent ──────────────────────
    if (isAgentEnabled('planner-agent')) {
      await updatePhase('discovery', 'active');
      // PlannerAgent resolves its own streaming provider from session config.
      // Pass null as the deprecated _aiServiceLegacy param.
      await PlannerAgent.run(
        sessionId,
        legacyPath,
        modernPath,
        session.detectedStack,
        session.targetStack,
        null,  // _aiServiceLegacy — deprecated, ignored by PlannerAgent
        async (msg, lvl) => log(msg, lvl ?? 'info', 'stage1'),
        async (percent, currentFile) => {
          // Fix 6: persist progress to session.json so SSE reconnect can replay it
          await SessionManager.updateSession(sessionId, {
            progress:    percent,
            currentFile: currentFile ?? '',
          });
          EventBroadcaster.broadcast(sessionId, 'progress', { percent, currentFile: currentFile ?? '' });
        },
        updatePhase   // ← pass updatePhase so PlannerAgent can broadcast sub-phase transitions
      );
    } else {
      await log('Skipping Stage 1: Analysis Agent is disabled in settings.', 'warning', 'stage1');
      await writeSessionFile(modernPath, 'Stage1_Analysis.md', '# Legacy Codebase Analysis\n\nSkipped by user settings.');
      // Mark all sub-phases done if skipped
      for (const id of ['discovery', 'file-analysis', 'graph-resolution', 'section-writing', 'assembly']) {
        await updatePhase(id, 'done');
      }
    }

    // Pause pipeline here — let the user review Stage1_Analysis.md before next stage
    await log('[Pipeline] Stage 1 Analysis complete. Review Stage1_Analysis.md in the output workspace.', 'success', 'stage1');

    // Clear API keys on complete for security
    await SessionManager.updateSession(sessionId, { status: 'complete', apiKey: undefined, apiKeys: undefined });
    EventBroadcaster.broadcast(sessionId, 'complete', { success: true });
  }
}
