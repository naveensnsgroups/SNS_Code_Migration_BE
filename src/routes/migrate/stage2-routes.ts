// Stage 2 — Migration Planning, Code Generation, Verification. Each endpoint
// runs its sub-stage asynchronously (fire-and-forget), progress surfaces via
// SSE + /state, same shape across all three.
import { Router, Request, Response, NextFunction } from 'express';
import { SessionManager } from '../../session/sessionManager.js';
import { MigrationAgent } from '../../agents/stage2/migration-agent.js';
import { EventBroadcaster } from '../stream.js';
import { TargetStack, MigrationStatus } from '../../types.js';
import { targetStackEquals } from '../../common/sessionGuards.js';

const planningSessions     = new Set<string>();
const generationSessions   = new Set<string>();
const verificationSessions = new Set<string>();

type Stage2PhaseId = 'migration-planning' | 'code-generation' | 'verification';

// Mirrors MigrationOrchestrator.updatePhase's shape: the phase id itself
// becomes the overall session status while active, and reverts to 'complete'
// once the sub-stage finishes — Stage 1 remains the last fully-completed
// stage until a later phase exists. Shared by /plan, /generate, /verify,
// which previously each redefined this identically inline.
function createPhaseUpdater(sessionId: string, phaseId: Stage2PhaseId) {
  return async (status: 'active' | 'done' | 'error') => {
    const current = await SessionManager.getSession(sessionId);
    if (!current) return;
    const phases = current.phases.map(p => p.id === phaseId ? { ...p, status } : p);
    const overallStatus: MigrationStatus = status === 'active' ? phaseId : 'complete';
    await SessionManager.updateSession(sessionId, { phases, status: overallStatus });
    EventBroadcaster.broadcast(sessionId, 'phase_change', { phase: overallStatus, phaseId, status });
  };
}

const router = Router();

// Requires Stage 1 to have already produced graphs for this session
// (detectedStack must be set).
router.post('/plan', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { sessionId, targetStack, apiKey, apiKeys } = req.body as {
      sessionId?: string; targetStack?: TargetStack;
      apiKey?: string; apiKeys?: Record<string, string>;
    };

    if (!sessionId || !targetStack) {
      res.status(400).json({ error: 'Missing required parameters: sessionId and targetStack are required.', code: 'BAD_REQUEST' });
      return;
    }

    const session = await SessionManager.getSession(sessionId);
    if (!session) {
      res.status(404).json({ error: 'Session not found.', code: 'NOT_FOUND' });
      return;
    }
    if (!session.detectedStack) {
      res.status(400).json({
        error: 'Stage 1 analysis has not completed for this session yet — run /start first.',
        code: 'STAGE1_INCOMPLETE',
      });
      return;
    }
    if (planningSessions.has(sessionId)) {
      res.status(409).json({ error: 'Migration planning is already running for this session.', code: 'ALREADY_RUNNING' });
      return;
    }

    // Stage 1 wipes session.apiKey/apiKeys on completion (MigrationOrchestrator,
    // end of runPipeline) — the same security discipline is followed here: the
    // key is stored only for the duration of this run, then cleared again below.
    // targetStack IS meant to be overwritten here — /plan is the one endpoint
    // that legitimately changes it (a deliberate re-plan after Target
    // Configuration was edited); /generate and /verify instead require it to
    // match what's already stored.
    await SessionManager.updateSession(sessionId, { targetStack, apiKey, apiKeys });

    const updatePhase = createPhaseUpdater(sessionId, 'migration-planning');

    planningSessions.add(sessionId);
    await updatePhase('active');

    MigrationAgent.runPlanning(
      sessionId,
      session.projectPath,
      session.modernPath,
      session.detectedStack,
      targetStack,
      async (msg, lvl) => {
        const entry = await SessionManager.addLog(sessionId, msg, lvl ?? 'info', 'migration-planning');
        EventBroadcaster.broadcast(sessionId, 'log', entry);
      },
      (percent) => EventBroadcaster.broadcast(sessionId, 'progress', { percent, currentFile: '' }),
    )
      .then(() => updatePhase('done'))
      .catch(async (err) => {
        console.error(`[migrate/plan] session ${sessionId} failed:`, err);
        await updatePhase('error');
        EventBroadcaster.broadcast(sessionId, 'error', { message: err.message });
      })
      .finally(async () => {
        planningSessions.delete(sessionId);
        await SessionManager.updateSession(sessionId, { apiKey: undefined, apiKeys: undefined });
      });

    res.json({ success: true, message: 'Migration planning started.' });
  } catch (err) {
    next(err);
  }
});

// Requires the migration task list from /plan to already exist for this
// session. Resumable — tasks already 'generated'/'verified' are skipped on a
// re-run.
router.post('/generate', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { sessionId, targetStack, apiKey, apiKeys } = req.body as {
      sessionId?: string; targetStack?: TargetStack;
      apiKey?: string; apiKeys?: Record<string, string>;
    };

    if (!sessionId || !targetStack) {
      res.status(400).json({ error: 'Missing required parameters: sessionId and targetStack are required.', code: 'BAD_REQUEST' });
      return;
    }

    const session = await SessionManager.getSession(sessionId);
    if (!session) {
      res.status(404).json({ error: 'Session not found.', code: 'NOT_FOUND' });
      return;
    }
    if (!session.detectedStack) {
      res.status(400).json({
        error: 'Stage 1 analysis has not completed for this session yet — run /start first.',
        code: 'STAGE1_INCOMPLETE',
      });
      return;
    }
    if (!session.migrationTaskList || session.migrationTaskList.length === 0) {
      res.status(400).json({
        error: 'No migration task list found for this session — run /plan first.',
        code: 'PLANNING_INCOMPLETE',
      });
      return;
    }
    // The task list was planned against session.targetStack — generating code
    // with a DIFFERENT stack would silently desync the two. The frontend only
    // ever gets here with a matching stack (Target Configuration is locked
    // until Edit + Re-plan), but this endpoint must not just trust that.
    if (session.targetStack && !targetStackEquals(session.targetStack, targetStack)) {
      res.status(409).json({
        error: 'The target stack has changed since this migration plan was created. Re-run /plan with the new target stack before generating code.',
        code: 'TARGET_STACK_MISMATCH',
      });
      return;
    }
    if (generationSessions.has(sessionId)) {
      res.status(409).json({ error: 'Code generation is already running for this session.', code: 'ALREADY_RUNNING' });
      return;
    }

    await SessionManager.updateSession(sessionId, { apiKey, apiKeys });

    const updatePhase = createPhaseUpdater(sessionId, 'code-generation');

    generationSessions.add(sessionId);
    await updatePhase('active');

    MigrationAgent.runCodeGeneration(
      sessionId,
      session.projectPath,
      session.modernPath,
      session.detectedStack,
      targetStack,
      async (msg, lvl) => {
        const entry = await SessionManager.addLog(sessionId, msg, lvl ?? 'info', 'code-generation');
        EventBroadcaster.broadcast(sessionId, 'log', entry);
      },
      (percent) => EventBroadcaster.broadcast(sessionId, 'progress', { percent, currentFile: '' }),
      (targetFile) => EventBroadcaster.broadcast(sessionId, 'file_migrated', { file: targetFile }),
    )
      .then(() => updatePhase('done'))
      .catch(async (err) => {
        console.error(`[migrate/generate] session ${sessionId} failed:`, err);
        await updatePhase('error');
        EventBroadcaster.broadcast(sessionId, 'error', { message: err.message });
      })
      .finally(async () => {
        generationSessions.delete(sessionId);
        await SessionManager.updateSession(sessionId, { apiKey: undefined, apiKeys: undefined });
      });

    res.json({ success: true, message: 'Code generation started.' });
  } catch (err) {
    next(err);
  }
});

// Requires at least one 'generated' task from /generate. Deterministic
// cross-file reference check, not a real build — see verification.ts for why.
router.post('/verify', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { sessionId, targetStack, apiKey, apiKeys } = req.body as {
      sessionId?: string; targetStack?: TargetStack;
      apiKey?: string; apiKeys?: Record<string, string>;
    };

    if (!sessionId || !targetStack) {
      res.status(400).json({ error: 'Missing required parameters: sessionId and targetStack are required.', code: 'BAD_REQUEST' });
      return;
    }

    const session = await SessionManager.getSession(sessionId);
    if (!session) {
      res.status(404).json({ error: 'Session not found.', code: 'NOT_FOUND' });
      return;
    }
    if (!session.migrationTaskList || !session.migrationTaskList.some(t => t.status !== 'pending')) {
      res.status(400).json({
        error: 'No generated files found for this session — run /generate first.',
        code: 'GENERATION_INCOMPLETE',
      });
      return;
    }
    // Same invariant as /generate — the generated files on disk were produced
    // against session.targetStack. Verifying against a different stack would
    // check the wrong thing without any error surfaced to the user.
    if (session.targetStack && !targetStackEquals(session.targetStack, targetStack)) {
      res.status(409).json({
        error: 'The target stack has changed since these files were generated. Re-run /plan and /generate with the new target stack before verifying.',
        code: 'TARGET_STACK_MISMATCH',
      });
      return;
    }
    if (verificationSessions.has(sessionId)) {
      res.status(409).json({ error: 'Verification is already running for this session.', code: 'ALREADY_RUNNING' });
      return;
    }

    await SessionManager.updateSession(sessionId, { apiKey, apiKeys });

    const updatePhase = createPhaseUpdater(sessionId, 'verification');

    verificationSessions.add(sessionId);
    await updatePhase('active');

    MigrationAgent.runVerification(
      sessionId,
      session.projectPath,
      session.modernPath,
      session.detectedStack!,
      targetStack,
      async (msg, lvl) => {
        const entry = await SessionManager.addLog(sessionId, msg, lvl ?? 'info', 'verification');
        EventBroadcaster.broadcast(sessionId, 'log', entry);
      },
      (percent) => EventBroadcaster.broadcast(sessionId, 'progress', { percent, currentFile: '' }),
    )
      .then(() => updatePhase('done'))
      .catch(async (err) => {
        console.error(`[migrate/verify] session ${sessionId} failed:`, err);
        await updatePhase('error');
        EventBroadcaster.broadcast(sessionId, 'error', { message: err.message });
      })
      .finally(async () => {
        verificationSessions.delete(sessionId);
        await SessionManager.updateSession(sessionId, { apiKey: undefined, apiKeys: undefined });
      });

    res.json({ success: true, message: 'Verification started.' });
  } catch (err) {
    next(err);
  }
});

export default router;
