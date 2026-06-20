import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import fs from 'fs-extra';
import path from 'path';
import { SessionManager } from '../session/sessionManager.js';
import { ScannerAgent, ScannerAgentConfig } from '../agents/stage1/scanner-agent.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

/**
 * POST /api/scan
 * Receives legacy workspace files, writes them to disk under sessions/<sessionId>/legacy,
 * and scans the stack.
 */
router.post('/', upload.array('files'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const files = req.files as Express.Multer.File[];
    if (!files || files.length === 0) {
      res.status(400).json({ error: 'No files uploaded', code: 'NO_FILES' });
      return;
    }

    // 1. Generate unique session ID and initialize directories
    const sessionId = SessionManager.generateSessionId();
    const session = await SessionManager.createSession(sessionId);
    
    await SessionManager.addLog(sessionId, `Initializing session ${sessionId}...`, 'info');

    // 2. Write uploaded files to sessions/<sessionId>/legacy/ preserving their subfolder structure
    let paths: string[] = [];
    try {
      paths = JSON.parse(req.body.paths || '[]');
    } catch {
      paths = [];
    }

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const relativePath = (paths[i] || '').replace(/\\/g, '/');
      if (!relativePath || relativePath.includes('.git/') || relativePath.includes('node_modules/')) {
        continue;
      }
      const destPath = path.join(session.projectPath, relativePath);

      await fs.ensureDir(path.dirname(destPath));
      await fs.writeFile(destPath, file.buffer);
    }

    // Detect if there is a common parent directory for all files to align project root
    let commonParent = '';
    const cleanPaths = paths
      .map(p => p.replace(/\\/g, '/'))
      .filter(p => p && !p.includes('.git/') && !p.includes('node_modules/'));

    // Log the real count: files that will actually be written (excludes .git, node_modules)
    const rawCount = files.length;
    const writtenCount = cleanPaths.length;
    const skippedCount = rawCount - writtenCount;
    await SessionManager.addLog(
      sessionId,
      skippedCount > 0
        ? `Receiving and unpacking ${writtenCount} source files (${rawCount} total — ${skippedCount} excluded: .git / node_modules)...`
        : `Receiving and unpacking ${writtenCount} files...`,
      'info'
    );

    if (cleanPaths.length > 0) {
      const firstPath = cleanPaths[0];
      const parts = firstPath.split('/');
      if (parts.length > 1) {
        const potentialParent = parts[0];
        const allHaveParent = cleanPaths.every(p => p.startsWith(potentialParent + '/'));
        if (allHaveParent) {
          commonParent = potentialParent;
        }
      }
    }

    if (commonParent) {
      const actualLegacyPath = path.join(session.projectPath, commonParent);
      const actualModernPath = path.join(session.modernPath, commonParent);
      await SessionManager.updateSession(sessionId, {
        projectPath: actualLegacyPath,
        modernPath: actualModernPath,
      });
      session.projectPath = actualLegacyPath;
      session.modernPath = actualModernPath;
      await SessionManager.addLog(sessionId, `Project root detected and set to subfolder: ${commonParent}`, 'info');
    }

    // 3. Build AI config from request body and run codebase scanner agent
    await SessionManager.addLog(sessionId, 'Running codebase scanner agent...', 'info');

    const { provider, model, apiKey } = req.body;
    const maxRetries = req.body.maxRetries ? parseInt(req.body.maxRetries, 10) : undefined;
    const retryDelayRateLimit = req.body.retryDelayRateLimit ? parseInt(req.body.retryDelayRateLimit, 10) : undefined;
    const retryDelayOther = req.body.retryDelayOther ? parseInt(req.body.retryDelayOther, 10) : undefined;
    const timeoutMs = req.body.timeoutMs ? parseInt(req.body.timeoutMs, 10) : undefined;

    const aiConfig: ScannerAgentConfig | undefined =
      (provider && apiKey)
        ? {
            provider,
            model: model || undefined,
            apiKey,
            maxRetries,
            retryDelayRateLimit,
            retryDelayOther,
            timeoutMs
          }
        : undefined;

    if (!aiConfig) {
      await SessionManager.addLog(sessionId, 'No AI provider configured — using static manifest scan.', 'info');
    }

    // Run scanner agent in the background asynchronously
    ScannerAgent.run(
      session.projectPath,
      session.modernPath,    // needed for scan-result.json persistence + idempotency
      aiConfig,
      async (msg, lvl) => {
        const entry = await SessionManager.addLog(sessionId, msg, lvl ?? 'info');
        const { EventBroadcaster } = await import('./stream.js');
        EventBroadcaster.broadcast(sessionId, 'log', entry);
      }
    ).then(async (scanResult) => {
      // Update session settings on completion
      await SessionManager.updateSession(sessionId, {
        detectedStack: scanResult.detectedStack,
        fileTree:      scanResult.fileTree,
        totalFiles:    scanResult.filteredFileCount,
        rawFileCount:  scanResult.rawFileCount,
      });

      // Broadcast scan completion to SSE clients
      const { EventBroadcaster } = await import('./stream.js');
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
      
      const { EventBroadcaster } = await import('./stream.js');
      EventBroadcaster.broadcast(sessionId, 'error', { message: err.message });
    });

    // Return the sessionId immediately to the client
    res.json({
      sessionId,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
