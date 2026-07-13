// Session lifecycle (start/stop/pause) and read-only session state endpoints
// (tree/tokens/pricing/state). Split out of migrate.ts, which mixed these with
// HITL checkpoint actions and the Stage-2 sub-stage endpoints.
import { Router, Request, Response, NextFunction } from 'express';
import { SessionManager } from '../../session/sessionManager.js';
import { MigrationOrchestrator } from '../../agents/core/migrationOrchestrator.js';
import { MigrateStartRequest } from '../../types.js';
import { FileWatcherService } from '../../services/fileWatcherService.js';
import { STAGE1_RUNNING_STATUSES } from '../../common/sessionGuards.js';
import fs from 'fs-extra';
import path from 'path';

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

    const session = await SessionManager.getSession(sessionId);
    if (!session) {
      res.status(404).json({ error: 'Session not found.', code: 'NOT_FOUND' });
      return;
    }
    if (!STAGE1_RUNNING_STATUSES.has(session.status)) {
      res.status(409).json({
        error: `Nothing to stop — session status is "${session.status}", not a running Stage-1 phase.`,
        code: 'NOT_RUNNING',
      });
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

    const session = await SessionManager.getSession(sessionId);
    if (!session) {
      res.status(404).json({ error: 'Session not found.', code: 'NOT_FOUND' });
      return;
    }
    if (!STAGE1_RUNNING_STATUSES.has(session.status)) {
      res.status(409).json({
        error: `Nothing to pause — session status is "${session.status}", not a running Stage-1 phase.`,
        code: 'NOT_RUNNING',
      });
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

    const { scanProjectDirectory } = await import('../../tools/fileScanner.js');
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

    const { estimateCost } = await import('../../agents/compactor/agent-cost-estimator.js');

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
      graphResolutionSummary: session.graphResolutionSummary ?? null,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
