import { Router, Request, Response, NextFunction } from 'express';
import { SessionManager } from '../session/sessionManager.js';
import { MigrationOrchestrator } from '../agents/migrationOrchestrator.js';
import { MigrateStartRequest } from '../types.js';
import path from 'path';
import { fileURLToPath } from 'url';

const router = Router();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * POST /api/migrate/start
 * Starts or resumes the background modernization pipeline.
 */
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

    // Override modernPath if localOutputPath is specified
    if (localOutputPath && localOutputPath.trim() !== '') {
      const targetModernPath = path.resolve(localOutputPath);
      await SessionManager.updateSession(sessionId, { modernPath: targetModernPath });
      await SessionManager.addLog(sessionId, `Modern output workspace set to custom local folder: ${targetModernPath}`, 'info');
    }

    // Save AI config settings to session (used by orchestrator + agents)
    if (toolsConfig || aliasesConfig || promptFragments) {
      await SessionManager.updateSession(sessionId, {
        ...(toolsConfig && { toolsConfig }),
        ...(aliasesConfig && { aliasesConfig }),
        ...(promptFragments && { promptFragments }),
      });
    }

    // Launch background worker without blocking the HTTP response
    MigrationOrchestrator.startMigration(sessionId, targetStack, apiKey, apiKeys, agentsConfig);

    res.json({ success: true, message: 'Migration pipeline started.' });
  } catch (err) {
    next(err);
  }
});


/**
 * POST /api/migrate/stop
 * Terminates the current active migration.
 */
router.post('/stop', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { sessionId } = req.body;

    if (!sessionId) {
      res.status(400).json({ error: 'Missing sessionId parameter.', code: 'BAD_REQUEST' });
      return;
    }

    MigrationOrchestrator.stopSession(sessionId);
    res.json({ success: true, message: 'Migration stopping requested.' });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/migrate/pause
 * Pauses the current active migration.
 */
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

/**
 * GET /api/migrate/tree
 * Returns modernized project file tree
 */
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

/**
 * GET /api/migrate/tokens
 * Returns the persisted token usage from session.json for the given session.
 * Mirrors SNS IDE TokenUsageFrontendService.getTokenUsageData() aggregation pattern.
 *
 * Response includes:
 *   tokenUsage   — cumulative session totals (inputTokens, outputTokens, totalTokens, estimatedCost, model)
 *   modelBreakdown — per-model aggregation of tokenUsageHistory (SNS IDE pattern)
 */
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

    // Aggregate history by model (SNS IDE TokenUsageFrontendService.aggregateTokenUsages pattern)
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

    const modelBreakdown = Array.from(modelMap.entries()).map(([modelId, data]) => {
      const breakdown: any = {
        modelId,
        inputTokens: data.inputTokens,
        outputTokens: data.outputTokens,
        totalTokens: data.inputTokens + data.outputTokens + data.cachedInputTokens,
        lastUsed: data.lastUsed,
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

export default router;

