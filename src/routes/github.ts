// GitHub repo import — "Clone from GitHub" in the Explorer, an alternative to
// uploading a local folder. Clones into a fresh session (same disk layout
// SessionManager.createSession already sets up) then runs the same
// ScannerAgent pass /api/scan uses, so the rest of the pipeline can't tell
// the difference between an uploaded project and a cloned one.
import { Router, Request, Response, NextFunction } from 'express';
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs-extra';
import path from 'path';
import { SessionManager } from '../session/sessionManager.js';
import { ScannerAgent, ScannerAgentConfig } from '../agents/stage1/scanner-agent.js';
import { EventBroadcaster } from './stream.js';

const execFileAsync = promisify(execFile);
const CLONE_TIMEOUT_MS = 5 * 60_000;

// Accepts github.com HTTPS URLs, with or without a trailing .git, and
// "owner/repo" shorthand. Anything else is rejected before it ever reaches git.
function parseGithubRepoUrl(input: string): { owner: string; repo: string } | null {
  const trimmed = input.trim();

  const shorthand = trimmed.match(/^([\w.-]+)\/([\w.-]+?)(?:\.git)?$/);
  if (shorthand) return { owner: shorthand[1], repo: shorthand[2] };

  try {
    const url = new URL(trimmed);
    if (url.hostname !== 'github.com') return null;
    const parts = url.pathname.replace(/^\/+|\/+$/g, '').split('/');
    if (parts.length < 2) return null;
    return { owner: parts[0], repo: parts[1].replace(/\.git$/, '') };
  } catch {
    return null;
  }
}

const router = Router();

router.post('/clone', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const {
      repoUrl, accessToken, branch,
      provider, model, apiKey, apiKeys, agentsConfig, aliasesConfig,
      maxRetries, retryDelayRateLimit, retryDelayOther,
    } = req.body as {
      repoUrl?: string; accessToken?: string; branch?: string;
      provider?: string; model?: string; apiKey?: string; apiKeys?: Record<string, string>;
      agentsConfig?: unknown; aliasesConfig?: Record<string, string>;
      maxRetries?: number; retryDelayRateLimit?: number; retryDelayOther?: number;
    };

    if (!repoUrl) {
      res.status(400).json({ error: 'Missing repoUrl.', code: 'BAD_REQUEST' });
      return;
    }
    const parsed = parseGithubRepoUrl(repoUrl);
    if (!parsed) {
      res.status(400).json({
        error: 'repoUrl must be a github.com repository URL (or "owner/repo").',
        code: 'INVALID_REPO_URL',
      });
      return;
    }

    const sessionId = SessionManager.generateSessionId();
    const session = await SessionManager.createSession(sessionId);
    await SessionManager.addLog(sessionId, `Initializing session ${sessionId}...`, 'info');

    const aiConfig: ScannerAgentConfig | undefined =
      (provider && apiKey) ? { provider: provider as ScannerAgentConfig['provider'], model: model || undefined, apiKey } : undefined;

    await SessionManager.updateSession(sessionId, {
      apiKey, apiKeys, agentsConfig, aliasesConfig,
      googleMaxRetries: maxRetries,
      googleRetryDelayRateLimit: retryDelayRateLimit,
      googleRetryDelayOther: retryDelayOther,
    } as any);

    // Background: clone, then scan — mirrors /api/scan's fire-and-forget shape
    // so the frontend can open the SSE stream the moment it has a sessionId.
    (async () => {
      try {
        await SessionManager.addLog(sessionId, `Cloning ${parsed.owner}/${parsed.repo}${branch ? ` (${branch})` : ''}...`, 'info');

        // Token is embedded only in the URL passed to git — never logged or
        // included in any broadcast/error message below.
        const cloneUrl = accessToken
          ? `https://x-access-token:${accessToken}@github.com/${parsed.owner}/${parsed.repo}.git`
          : `https://github.com/${parsed.owner}/${parsed.repo}.git`;

        const args = ['clone', '--depth', '1'];
        if (branch) args.push('--branch', branch);
        args.push(cloneUrl, session.projectPath);

        await execFileAsync('git', args, { timeout: CLONE_TIMEOUT_MS });

        // Drop .git — the rest of the pipeline treats projectPath as a plain
        // source snapshot, same as an uploaded folder (which never has one).
        await fs.remove(path.join(session.projectPath, '.git'));

        await SessionManager.addLog(sessionId, `Cloned ${parsed.owner}/${parsed.repo} successfully.`, 'success');
      } catch (err: any) {
        // git's own error text can include the authenticated URL — strip it
        // rather than risk leaking the token into logs the user can copy/paste.
        const safeMessage = String(err?.message ?? err).replace(/https:\/\/[^\s]+@github\.com\S*/g, 'https://github.com/***');
        await SessionManager.addLog(sessionId, `Clone failed: ${safeMessage}`, 'error');
        EventBroadcaster.broadcast(sessionId, 'error', { message: `Clone failed: ${safeMessage}` });
        return;
      }

      if (!aiConfig) {
        await SessionManager.addLog(sessionId, 'No AI provider configured — using static manifest scan.', 'info');
      }
      await SessionManager.addLog(sessionId, 'Running codebase scanner agent...', 'info');

      ScannerAgent.run(
        sessionId,
        session.projectPath,
        session.modernPath,
        aiConfig,
        async (msg, lvl) => {
          const entry = await SessionManager.addLog(sessionId, msg, lvl ?? 'info');
          EventBroadcaster.broadcast(sessionId, 'log', entry);
        }
      ).then(async (scanResult) => {
        await SessionManager.updateSession(sessionId, {
          detectedStack: scanResult.detectedStack,
          fileTree:      scanResult.fileTree,
          totalFiles:    scanResult.filteredFileCount,
          rawFileCount:  scanResult.rawFileCount,
        });
        EventBroadcaster.broadcast(sessionId, 'complete', {
          success:           true,
          detectedStack:     scanResult.detectedStack,
          fileTree:          scanResult.fileTree,
          filteredFileCount: scanResult.filteredFileCount,
          rawFileCount:      scanResult.rawFileCount,
          manifestsFound:    scanResult.manifestsFound,
          confidence:        scanResult.confidence,
          isScan:            true,
        });
      }).catch(async (err: any) => {
        console.error(`Background scan error for session ${sessionId}:`, err);
        await SessionManager.addLog(sessionId, `Scan failed: ${err.message}`, 'error');
        EventBroadcaster.broadcast(sessionId, 'error', { message: err.message });
      });
    })();

    res.json({ sessionId });
  } catch (err) {
    next(err);
  }
});

export default router;
