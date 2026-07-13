// HITL graph-review checkpoint — reached after graph-resolution, where the
// pipeline halts (status 'awaiting-graph-review') for the user to review the
// resolved graphs and choose to continue to the analysis report or skip
// straight to code migration (Stage 2).
import { Router, Request, Response, NextFunction } from 'express';
import { SessionManager } from '../../session/sessionManager.js';
import { MigrationOrchestrator } from '../../agents/core/migrationOrchestrator.js';

const router = Router();

// The per-graph result the user reviews after graph-resolution. Returned
// separately from /state so the review UI can fetch it directly.
router.get('/graph-summary', async (req: Request, res: Response, next: NextFunction) => {
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
    res.json({ graphResolutionSummary: session.graphResolutionSummary ?? null });
  } catch (err) {
    next(err);
  }
});

// Continue: resume Stage 1 into section-writing from the checkpoint.
// apiKey/apiKeys are re-sent (the checkpoint wiped them), same as Stage 2 routes.
router.post('/continue-analysis', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { sessionId, apiKey, apiKeys } = req.body as {
      sessionId?: string; apiKey?: string; apiKeys?: Record<string, string>;
    };
    if (!sessionId) {
      res.status(400).json({ error: 'Missing required parameter: sessionId.', code: 'BAD_REQUEST' });
      return;
    }
    const session = await SessionManager.getSession(sessionId);
    if (!session) {
      res.status(404).json({ error: 'Session not found.', code: 'NOT_FOUND' });
      return;
    }
    if (session.status !== 'awaiting-graph-review') {
      res.status(409).json({
        error: `Session is not at the graph-review checkpoint (status: ${session.status}).`,
        code: 'NOT_AT_CHECKPOINT',
      });
      return;
    }
    if (session.graphResolutionSummary?.primaryGraphsEmpty) {
      res.status(400).json({
        error: 'Primary graphs (symbol/entity/api) are empty — writing the report would produce no real content. Re-run Stage 1 analysis instead.',
        code: 'GRAPHS_EMPTY',
      });
      return;
    }

    MigrationOrchestrator.continueAnalysis(sessionId, apiKey ?? '', apiKeys);
    res.json({ success: true, message: 'Resuming analysis — writing report.' });
  } catch (err) {
    next(err);
  }
});

// Skip: forfeit the analysis report and mark Stage 1 complete so Stage 2
// becomes available. The graphs (all Stage 2 needs) are already on disk.
router.post('/skip-to-stage2', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { sessionId } = req.body as { sessionId?: string };
    if (!sessionId) {
      res.status(400).json({ error: 'Missing required parameter: sessionId.', code: 'BAD_REQUEST' });
      return;
    }
    const session = await SessionManager.getSession(sessionId);
    if (!session) {
      res.status(404).json({ error: 'Session not found.', code: 'NOT_FOUND' });
      return;
    }
    if (session.status !== 'awaiting-graph-review') {
      res.status(409).json({
        error: `Session is not at the graph-review checkpoint (status: ${session.status}).`,
        code: 'NOT_AT_CHECKPOINT',
      });
      return;
    }
    if (session.graphResolutionSummary?.primaryGraphsEmpty) {
      res.status(400).json({
        error: 'Primary graphs (symbol/entity/api) are empty — code migration would have nothing to plan from. Re-run Stage 1 analysis instead.',
        code: 'GRAPHS_EMPTY',
      });
      return;
    }

    await MigrationOrchestrator.skipToStage2(sessionId);
    res.json({ success: true, message: 'Skipped analysis report — code migration ready.' });
  } catch (err) {
    next(err);
  }
});

export default router;
