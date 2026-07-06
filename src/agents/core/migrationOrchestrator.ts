import { SessionManager } from '../../session/sessionManager.js';
import { EventBroadcaster } from '../../routes/stream.js';
import { TaskContextManager } from '../../session/taskContext.js';
import { PlannerAgent, STAGE1_ABORTED } from '../stage1/planner-agent.js';
import { ShellExecutor } from '../../tools/shellExecutor.js';
import { writeSessionFile } from '../../tools/fileWriter.js';
import { scanProjectDirectory } from '../../tools/fileScanner.js';
import { DetectedStack, TargetStack, MigrationStatus } from '../../types.js';
import { resolveApiKey, resolveModelAlias } from '../../ai/index.js';
import fs from 'fs-extra';
import path from 'path';

export class MigrationOrchestrator {
  private static pausedSessions:  Set<string> = new Set();
  private static stoppedSessions: Set<string> = new Set();

  
  
  
  
  private static activeSessions:  Set<string> = new Set();

  
  static stopSession(sessionId: string) {
    this.stoppedSessions.add(sessionId);
    this.pausedSessions.delete(sessionId);
    // NOTE: do NOT remove from activeSessions here. The pipeline promise is still
    // running until it observes the stop flag at its next checkpoint; removing the
    // guard early would allow a second concurrent run of the same session, and two
    // pipelines writing the same taskContext/graphs corrupts state. The finally()
    // in startMigration clears activeSessions when the pipeline actually exits.
    ShellExecutor.kill(sessionId);
  }

  
  static pauseSession(sessionId: string) {
    this.pausedSessions.add(sessionId);
    ShellExecutor.kill(sessionId);
  }

  
  static async startMigration(
    sessionId: string,
    targetStack: TargetStack,
    apiKey: string,
    apiKeys?: any,
    agentsConfig?: any
  ): Promise<void> {
    
    
    
    if (this.activeSessions.has(sessionId)) {
      console.warn(`[MigrationOrchestrator] Session ${sessionId} is already running. Ignoring duplicate startMigration call.`);
      return;
    }

    
    this.pausedSessions.delete(sessionId);
    this.stoppedSessions.delete(sessionId);

    const session = await SessionManager.getSession(sessionId);
    if (!session) return;

    
    
    
    
    
    const existingCtx = await TaskContextManager.getContext(sessionId);
    const isResume    = !!existingCtx.active_phase && existingCtx.active_phase !== 'complete';
    if (!isResume) {
      
      await TaskContextManager.saveContext(sessionId, { active_phase: 'discovery' });
    } else {
      
      console.log(`[MigrationOrchestrator] Resuming session ${sessionId} from phase "${existingCtx.active_phase}".`);
    }

    
    await SessionManager.updateSession(sessionId, {
      targetStack,
      status: 'planning',
      apiKey, 
      apiKeys,
      agentsConfig,
    });

    
    this.activeSessions.add(sessionId);

    
    this.runPipeline(sessionId).catch(async (err) => {
      console.error(`Pipeline error in session ${sessionId}:`, err);

      await SessionManager.updateSession(sessionId, { status: 'error', error: err.message });
      await SessionManager.addLog(sessionId, `Pipeline failed: ${err.message}`, 'error');

      EventBroadcaster.broadcast(sessionId, 'error', { message: err.message });
    }).finally(() => {
      
      this.activeSessions.delete(sessionId);
    });
  }

  private static async runPipeline(sessionId: string): Promise<void> {
    let session = await SessionManager.getSession(sessionId);
    if (!session || !session.targetStack || !session.detectedStack) {
      throw new Error('Session is missing configuration properties.');
    }

    
    
    const resolvedModel = resolveModelAlias(session.targetStack.model, (session as any).aliasesConfig ?? {});
    const apiKey = resolveApiKey(
      session.targetStack.provider,
      session.apiKey || '',
      session.apiKeys
    );
    if (!apiKey) {
      throw new Error(`API key for provider "${session.targetStack.provider}" could not be resolved.`);
    }
    
    void resolvedModel;

    
    
    
    

    
    
    
    let currentSession: NonNullable<typeof session> = session;

    const resolveAgent = (agentId: string): any | undefined => {
      if (!currentSession.agentsConfig) return undefined;
      if (Array.isArray(currentSession.agentsConfig)) {
        return currentSession.agentsConfig.find((a: any) => a.id === agentId);
      }
      return (currentSession.agentsConfig as Record<string, any>)[agentId];
    };

    const isAgentEnabled = (agentId: string): boolean => {
      const agent = resolveAgent(agentId);
      if (agent === undefined) return true; 
      return agent.enabled !== false;
    };

    let legacyPath = currentSession.projectPath;
    const modernPath = currentSession.modernPath;

    
    
    
    
    
    
    
    
    if (!(await fs.pathExists(legacyPath))) {
      throw new Error(
        `[MigrationOrchestrator] Source project path does not exist: "${legacyPath}". ` +
        'Please re-upload your project from the UI and try again.'
      );
    }

    {
      const { fileList: topFiles } = await scanProjectDirectory(legacyPath);

      if (topFiles.length === 0) {
        
        const children = (await fs.readdir(legacyPath, { withFileTypes: true }))
          .filter(d => d.isDirectory())
          .map(d => path.join(legacyPath, d.name));

        let foundPath: string | null = null;
        for (const child of children) {
          const { fileList: childFiles } = await scanProjectDirectory(child);
          if (childFiles.length > 0) {
            foundPath = child;
            break;
          }
        }

        if (foundPath) {
          
          await SessionManager.updateSession(sessionId, { projectPath: foundPath });
          const refreshed = await SessionManager.getSession(sessionId);
          if (refreshed) currentSession = refreshed;
          legacyPath = foundPath;
          console.log(
            `[MigrationOrchestrator] Auto-corrected projectPath to: "${legacyPath}" ` +
            `(was pointing at parent wrapper folder with no direct files).`
          );
        } else {
          
          const childNames = children.map(c => path.basename(c)).join(', ') || 'none';
          throw new Error(
            `[MigrationOrchestrator] Source project path is empty: "${legacyPath}". ` +
            `Immediate subdirectories found: [${childNames}] — all appear empty too. ` +
            'Possible causes: files were not uploaded correctly, or the project directory ' +
            'contains only binary/excluded files (node_modules, .git, dist, build). ' +
            'Please re-upload your project from the UI and try again.'
          );
        }
      }
    }

    
    
    
    {
      const resolvedLegacy = path.resolve(legacyPath);
      const resolvedModern = path.resolve(modernPath);
      const sep = path.sep;
      const overlap =
        resolvedModern === resolvedLegacy ||
        resolvedModern.startsWith(resolvedLegacy + sep) ||
        resolvedLegacy.startsWith(resolvedModern + sep);

      if (overlap) {
        throw new Error(
          `[MigrationOrchestrator] SAFETY ABORT: modernPath "${resolvedModern}" overlaps with ` +
          `legacyPath "${resolvedLegacy}". The output folder must be completely separate from ` +
          'the source project. Please start a new session and set a different output path.'
        );
      }
    }

    
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

    
    await updatePhase('scan', 'done');

    
    if (isAgentEnabled('planner-agent')) {
      await updatePhase('discovery', 'active');


      const result = await PlannerAgent.run(
        sessionId,
        legacyPath,
        modernPath,
        currentSession.detectedStack!,
        currentSession.targetStack!,
        null,
        async (msg, lvl) => log(msg, lvl ?? 'info', 'stage1'),
        async (percent, currentFile) => {

          await SessionManager.updateSession(sessionId, {
            progress:    percent,
            currentFile: currentFile ?? '',
          });
          EventBroadcaster.broadcast(sessionId, 'progress', { percent, currentFile: currentFile ?? '' });
        },
        updatePhase,
        checkCancellation
      );

      // Stop/Pause was observed at a pipeline checkpoint: session status has
      // already been set by checkCancellation — do not mark the run complete.
      if (result === STAGE1_ABORTED) {
        await log('[Pipeline] Stage 1 halted by user request. Resume to continue from the saved phase.', 'warning', 'stage1');
        return;
      }
    } else {
      await log('Skipping Stage 1: Analysis Agent is disabled in settings.', 'warning', 'stage1');
      await writeSessionFile(modernPath, 'Stage1_Analysis.md', '# Legacy Codebase Analysis\n\nSkipped by user settings.');
      
      for (const id of ['discovery', 'file-analysis', 'graph-resolution', 'section-writing', 'assembly']) {
        await updatePhase(id, 'done');
      }
    }

    
    await log('[Pipeline] Stage 1 Analysis complete. Review Stage1_Analysis.md in the output workspace.', 'success', 'stage1');

    
    await SessionManager.updateSession(sessionId, { status: 'complete', apiKey: undefined, apiKeys: undefined });
    EventBroadcaster.broadcast(sessionId, 'complete', { success: true });
  }
}
