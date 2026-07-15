// Human "report an issue" channel — a real agent investigation, not a
// passive log. See diagnostic-prompt.ts / DIAGNOSTIC_AGENT for why this is
// deliberately read-only (diagnose, never auto-fix) and prompts.MIGRATION.md
// context: this exists specifically because an automatic sanity check
// (migration-planning-runner.ts's checkImportsGraphSanity) can only catch
// failure patterns anticipated in advance — this is the channel for whatever
// a human notices that no check anticipated.
import { Router, Request, Response, NextFunction } from 'express';
import { SessionManager } from '../../session/sessionManager.js';
import { TaskContextManager } from '../../session/taskContext.js';
import { toolRegistry } from '../../core/tool-invocation-registry.js';
import { ToolContext } from '../../types/tool.js';
import { AgentExecutor } from '../../agents/core/agentExecutor.js';
import { resolveStreamingProvider } from '../../ai/index.js';
import { DIAGNOSTIC_AGENT } from '../../agents/core/agent-definitions.js';
import { DIAGNOSTIC_SYSTEM_PROMPT, buildDiagnosticUserPrompt } from '../../prompts/diagnostic-prompt.js';

const router = Router();

router.post('/report-issue', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { sessionId, stage, text } = req.body as {
      sessionId?: string; stage?: string; text?: string;
    };
    if (!sessionId || !text || !text.trim()) {
      res.status(400).json({ error: 'Missing required parameter(s): sessionId, text.', code: 'BAD_REQUEST' });
      return;
    }

    const session = await SessionManager.getSession(sessionId);
    if (!session) {
      res.status(404).json({ error: 'Session not found.', code: 'NOT_FOUND' });
      return;
    }
    if (!session.targetStack) {
      res.status(409).json({
        error: 'No target stack configured for this session yet — nothing to diagnose against.',
        code: 'NOT_READY',
      });
      return;
    }

    const report = { text: text.trim(), stage: stage ?? 'unknown', reportedAt: new Date().toISOString() };
    // Persist the raw report immediately — nothing is lost even if the
    // diagnostic agent call below fails or times out.
    const reportedIssues = [...(session.reportedIssues ?? []), report];
    await SessionManager.updateSession(sessionId, { reportedIssues });

    // Respond right away — the agent investigation can take a while (real
    // tool calls, real graph reads) and the human shouldn't have to wait on
    // an open HTTP request for it.
    res.json({ success: true, message: 'Issue reported — investigating.' });

    // Fire-and-forget the real investigation; errors here must never crash
    // the process, only leave this report's .diagnosis unset.
    (async () => {
      try {
        const { provider, resolvedModel } = await resolveStreamingProvider(
          sessionId, session.targetStack!, DIAGNOSTIC_AGENT
        );
        const context: ToolContext = {
          sessionId,
          legacyPath: session.projectPath,
          modernPath: session.modernPath,
        };
        const tools = toolRegistry.getFunctions(...DIAGNOSTIC_AGENT.functions);

        await AgentExecutor.execute(
          provider,
          DIAGNOSTIC_SYSTEM_PROMPT,
          buildDiagnosticUserPrompt(report.text, report.stage),
          tools, context, resolvedModel, `diagnostic-${sessionId}-${report.reportedAt}`,
          undefined, DIAGNOSTIC_AGENT.recoveryHint
        );

        const ctx = await TaskContextManager.getContext(sessionId);
        const diagnosis = ctx.DIAGNOSIS_RESULT;
        if (diagnosis && typeof diagnosis === 'object') {
          const current = await SessionManager.getSession(sessionId);
          if (!current) return;
          const updated = (current.reportedIssues ?? []).map(r =>
            r.reportedAt === report.reportedAt ? { ...r, diagnosis } : r
          );
          await SessionManager.updateSession(sessionId, { reportedIssues: updated });
        }
      } catch {
        // Diagnosis failed to run — the raw report is already saved; the
        // human can see it has no diagnosis yet rather than losing the report.
      }
    })();
  } catch (err) {
    next(err);
  }
});

export default router;
