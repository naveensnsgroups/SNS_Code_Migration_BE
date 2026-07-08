import { Router, Request, Response, NextFunction } from 'express';
import { SessionManager } from '../session/sessionManager.js';
import { MigrationOrchestrator } from '../agents/core/migrationOrchestrator.js';
import { MigrationAgent } from '../agents/stage2/migration-agent.js';
import { EventBroadcaster } from './stream.js';
import { MigrateStartRequest, TargetStack } from '../types.js';
import { FileWatcherService } from '../services/fileWatcherService.js';
import fs from 'fs-extra';
import path from 'path';

const planningSessions   = new Set<string>();
const generationSessions = new Set<string>();
const verificationSessions = new Set<string>();

function pathsOverlap(candidate: string, reference: string): boolean {
  const a = path.resolve(candidate).replace(/[\\/]+$/, '').toLowerCase();
  const b = path.resolve(reference).replace(/[\\/]+$/, '').toLowerCase();
  const sep = path.sep.toLowerCase();
  
  return a === b || a.startsWith(b + sep) || b.startsWith(a + sep);
}

const router = Router();

router.post('/start', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const {
      sessionId, targetStack, apiKey, apiKeys, agentsConfig, localOutputPath,
      toolsConfig, aliasesConfig, promptFragments
    } = req.body as MigrateStartRequest;

    if (!sessionId || !targetStack || !apiKey) {
      res.status(400).json({ error: 'Missing required parameters: sessionId, targetStack, and apiKey are required.', code: 'BAD_REQUEST' });
      return;
    }

    const session = await SessionManager.getSession(sessionId);
    if (!session) {
      res.status(404).json({ error: 'Session not found.', code: 'NOT_FOUND' });
      return;
    }

    
    
    
    
    if (localOutputPath && localOutputPath.trim() !== '') {
      const targetModernPath = path.resolve(localOutputPath);
      const sourcePath       = path.resolve(session.projectPath);

      if (pathsOverlap(targetModernPath, sourcePath)) {
        res.status(400).json({
          error:
            `Invalid localOutputPath: "${targetModernPath}" overlaps with the source project path "${sourcePath}". ` +
            'The migration output folder must be completely separate from the source project. ' +
            'Please choose a different output directory (e.g. a sibling folder like "E:\\my-project-modern\\") ' +
            'or leave the field blank to use the default session output folder.',
          code: 'OUTPUT_PATH_OVERLAPS_SOURCE',
        });
        return;
      }

      await SessionManager.updateSession(sessionId, { modernPath: targetModernPath });
      await SessionManager.addLog(
        sessionId,
        `Modern output workspace set to custom local folder: ${targetModernPath}`,
        'info'
      );
    }

    
    
    const {
      googleMaxRetries, googleRetryDelayRateLimit, googleRetryDelayOther,
      mistralMaxRetries, mistralRetryDelayRateLimit, mistralRetryDelayOther,
      modelPricing
    } = req.body as any;

    if (
      toolsConfig || aliasesConfig || promptFragments || modelPricing ||
      googleMaxRetries !== undefined || googleRetryDelayRateLimit !== undefined ||
      googleRetryDelayOther !== undefined ||
      mistralMaxRetries !== undefined || mistralRetryDelayRateLimit !== undefined ||
      mistralRetryDelayOther !== undefined
    ) {
      await SessionManager.updateSession(sessionId, {
        ...(toolsConfig && { toolsConfig }),
        ...(aliasesConfig && { aliasesConfig }),
        ...(promptFragments && { promptFragments }),
        // User-supplied per-model $/1M rates — never a hardcoded table. See
        // agent-cost-estimator.ts. Absent entirely if the user configured none.
        ...(modelPricing && { modelPricing }),
        ...(googleMaxRetries !== undefined && { googleMaxRetries: parseInt(googleMaxRetries, 10) }),
        ...(googleRetryDelayRateLimit !== undefined && { googleRetryDelayRateLimit: parseInt(googleRetryDelayRateLimit, 10) }),
        ...(googleRetryDelayOther !== undefined && { googleRetryDelayOther: parseInt(googleRetryDelayOther, 10) }),
        ...(mistralMaxRetries !== undefined && { mistralMaxRetries: parseInt(mistralMaxRetries, 10) }),
        ...(mistralRetryDelayRateLimit !== undefined && { mistralRetryDelayRateLimit: parseInt(mistralRetryDelayRateLimit, 10) }),
        ...(mistralRetryDelayOther !== undefined && { mistralRetryDelayOther: parseInt(mistralRetryDelayOther, 10) }),
      });
    }

    
    const updatedSession = await SessionManager.getSession(sessionId);
    const resolvedModernPath = updatedSession?.modernPath ?? session.modernPath;

    
    
    await fs.ensureDir(resolvedModernPath);

    
    
    
    FileWatcherService.startWatching(sessionId, resolvedModernPath);

    
    MigrationOrchestrator.startMigration(sessionId, targetStack, apiKey, apiKeys, agentsConfig);

    res.json({ success: true, message: 'Migration pipeline started.' });
  } catch (err) {
    next(err);
  }
});

router.post('/stop', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { sessionId } = req.body;

    if (!sessionId) {
      res.status(400).json({ error: 'Missing sessionId parameter.', code: 'BAD_REQUEST' });
      return;
    }

    MigrationOrchestrator.stopSession(sessionId);

    
    FileWatcherService.stopWatching(sessionId);

    res.json({ success: true, message: 'Migration stopping requested.' });
  } catch (err) {
    next(err);
  }
});

router.post('/pause', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { sessionId } = req.body;

    if (!sessionId) {
      res.status(400).json({ error: 'Missing sessionId parameter.', code: 'BAD_REQUEST' });
      return;
    }

    MigrationOrchestrator.pauseSession(sessionId);
    res.json({ success: true, message: 'Migration pausing requested.' });
  } catch (err) {
    next(err);
  }
});

router.get('/tree', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { sessionId } = req.query;
    if (!sessionId) {
      res.status(400).json({ error: 'Missing sessionId parameter.', code: 'BAD_REQUEST' });
      return;
    }

    const session = await SessionManager.getSession(sessionId as string);
    if (!session) {
      res.status(404).json({ error: 'Session not found.', code: 'NOT_FOUND' });
      return;
    }

    const fs = await import('fs-extra');
    if (!(await fs.pathExists(session.modernPath))) {
      res.json({ fileTree: [], modernPath: session.modernPath });
      return;
    }

    const { scanProjectDirectory } = await import('../tools/fileScanner.js');
    const { fileTree } = await scanProjectDirectory(session.modernPath);
    res.json({ fileTree, modernPath: session.modernPath });
  } catch (err) {
    next(err);
  }
});

router.get('/tokens', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { sessionId } = req.query;
    if (!sessionId) {
      res.status(400).json({ error: 'Missing sessionId parameter.', code: 'BAD_REQUEST' });
      return;
    }

    const session = await SessionManager.getSession(sessionId as string);
    if (!session) {
      res.status(404).json({ error: 'Session not found.', code: 'NOT_FOUND' });
      return;
    }

    
    const history = session.tokenUsageHistory ?? [];
    const modelMap = new Map<string, {
      inputTokens: number;
      outputTokens: number;
      cachedInputTokens: number;
      readCachedInputTokens: number;
      lastUsed: string;
    }>();

    for (const entry of history) {
      const existing = modelMap.get(entry.model);
      if (existing) {
        existing.inputTokens += entry.inputTokens;
        existing.outputTokens += entry.outputTokens;
        existing.cachedInputTokens += (entry.cachedInputTokens ?? 0);
        existing.readCachedInputTokens += (entry.readCachedInputTokens ?? 0);
        if (entry.timestamp > existing.lastUsed) {
          existing.lastUsed = entry.timestamp;
        }
      } else {
        modelMap.set(entry.model, {
          inputTokens: entry.inputTokens,
          outputTokens: entry.outputTokens,
          cachedInputTokens: entry.cachedInputTokens ?? 0,
          readCachedInputTokens: entry.readCachedInputTokens ?? 0,
          lastUsed: entry.timestamp,
        });
      }
    }

    const { estimateCost } = await import('../agents/compactor/agent-cost-estimator.js');

    const modelBreakdown = Array.from(modelMap.entries()).map(([modelId, data]) => {
      const breakdown: any = {
        modelId,
        inputTokens: data.inputTokens,
        outputTokens: data.outputTokens,
        totalTokens: data.inputTokens + data.outputTokens + data.cachedInputTokens,
        lastUsed: data.lastUsed,
        // null when the user hasn't configured a rate for this exact model —
        // rendered as "not available" by the frontend, never a guessed number.
        estimatedCost: estimateCost(
          data.inputTokens, data.outputTokens, modelId, session.modelPricing,
          data.cachedInputTokens, data.readCachedInputTokens
        ),
      };
      if (data.cachedInputTokens > 0) {
        breakdown.cachedInputTokens = data.cachedInputTokens;
      }
      if (data.readCachedInputTokens > 0) {
        breakdown.readCachedInputTokens = data.readCachedInputTokens;
      }
      return breakdown;
    });

    res.json({
      tokenUsage: session.tokenUsage ?? null,
      modelBreakdown,
      sessionId,
    });
  } catch (err) {
    next(err);
  }
});

// Update the user-supplied per-model pricing rates for a session. Applies
// retroactively: /tokens recomputes cost fresh from session.modelPricing on
// every read, so setting a rate here immediately re-prices already-recorded
// token history — no re-run needed. See agent-cost-estimator.ts.
router.post('/pricing', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { sessionId, modelPricing } = req.body as {
      sessionId?: string;
      modelPricing?: Record<string, { inputPerM: number; outputPerM: number; cacheWritePerM?: number; cacheReadPerM?: number }>;
    };
    if (!sessionId || !modelPricing) {
      res.status(400).json({ error: 'Missing sessionId or modelPricing.', code: 'BAD_REQUEST' });
      return;
    }

    const session = await SessionManager.getSession(sessionId);
    if (!session) {
      res.status(404).json({ error: 'Session not found.', code: 'NOT_FOUND' });
      return;
    }

    await SessionManager.updateSession(sessionId, {
      modelPricing: { ...(session.modelPricing ?? {}), ...modelPricing },
    });

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// Full restorable session state for the frontend (e.g. after a page reload).
// Deliberately omits apiKey/apiKeys — those are never sent back to the client.
router.get('/state', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { sessionId } = req.query;
    if (!sessionId) {
      res.status(400).json({ error: 'Missing sessionId parameter.', code: 'BAD_REQUEST' });
      return;
    }

    const session = await SessionManager.getSession(sessionId as string);
    if (!session) {
      res.status(404).json({ error: 'Session not found.', code: 'NOT_FOUND' });
      return;
    }

    res.json({
      sessionId:          session.sessionId,
      status:             session.status,
      fileTree:           session.fileTree,
      detectedStack:      session.detectedStack ?? null,
      targetStack:        session.targetStack ?? null,
      phases:             session.phases,
      progress:           session.progress ?? 0,
      currentFile:        session.currentFile ?? '',
      migrationTaskList:  session.migrationTaskList ?? null,
      ruleCoverageReport: session.ruleCoverageReport ?? null,
    });
  } catch (err) {
    next(err);
  }
});

// Stage 2 — Migration Planning. Requires Stage 1 to have already produced
// graphs for this session (detectedStack must be set). Runs asynchronously,
// same fire-and-forget shape as /start; progress surfaces via SSE + /state.
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
    await SessionManager.updateSession(sessionId, { targetStack, apiKey, apiKeys });

    // Mirrors MigrationOrchestrator.updatePhase's shape: the phase id itself
    // becomes the overall session status while active, and reverts to
    // 'complete' once this sub-stage finishes — Stage 1 remains the last
    // fully-completed stage until Code Generation/Verification/Assembly exist.
    const updatePhase = async (status: 'active' | 'done' | 'error') => {
      const current = await SessionManager.getSession(sessionId);
      if (!current) return;
      const phases = current.phases.map(p => p.id === 'migration-planning' ? { ...p, status } : p);
      const overallStatus = status === 'active' ? 'migration-planning' : 'complete';
      await SessionManager.updateSession(sessionId, { phases, status: overallStatus });
      EventBroadcaster.broadcast(sessionId, 'phase_change', { phase: overallStatus, phaseId: 'migration-planning', status });
    };

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

// Stage 2 — Code Generation. Requires the migration task list from /plan to
// already exist for this session. Same fire-and-forget shape as /plan;
// resumable — tasks already 'generated'/'verified' are skipped on a re-run.
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
    if (generationSessions.has(sessionId)) {
      res.status(409).json({ error: 'Code generation is already running for this session.', code: 'ALREADY_RUNNING' });
      return;
    }

    await SessionManager.updateSession(sessionId, { targetStack, apiKey, apiKeys });

    const updatePhase = async (status: 'active' | 'done' | 'error') => {
      const current = await SessionManager.getSession(sessionId);
      if (!current) return;
      const phases = current.phases.map(p => p.id === 'code-generation' ? { ...p, status } : p);
      const overallStatus = status === 'active' ? 'code-generation' : 'complete';
      await SessionManager.updateSession(sessionId, { phases, status: overallStatus });
      EventBroadcaster.broadcast(sessionId, 'phase_change', { phase: overallStatus, phaseId: 'code-generation', status });
    };

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

// Stage 2 — Verification. Requires at least one 'generated' task from
// /generate. Deterministic cross-file reference check, not a real build —
// see verification.ts for why. Same fire-and-forget shape as /plan and /generate.
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
    if (verificationSessions.has(sessionId)) {
      res.status(409).json({ error: 'Verification is already running for this session.', code: 'ALREADY_RUNNING' });
      return;
    }

    await SessionManager.updateSession(sessionId, { targetStack, apiKey, apiKeys });

    const updatePhase = async (status: 'active' | 'done' | 'error') => {
      const current = await SessionManager.getSession(sessionId);
      if (!current) return;
      const phases = current.phases.map(p => p.id === 'verification' ? { ...p, status } : p);
      const overallStatus = status === 'active' ? 'verification' : 'complete';
      await SessionManager.updateSession(sessionId, { phases, status: overallStatus });
      EventBroadcaster.broadcast(sessionId, 'phase_change', { phase: overallStatus, phaseId: 'verification', status });
    };

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

