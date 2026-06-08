import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import fs from 'fs-extra';
import path from 'path';
import { SessionManager } from '../session/sessionManager.js';
import { ScannerAgent, ScannerAgentConfig } from '../agents/scanner-agent.js';

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
    await SessionManager.addLog(sessionId, `Receiving and unpacking ${files.length} files...`, 'info');

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

    // 3. Build AI config from request body and run scanner agent
    await SessionManager.addLog(sessionId, 'Running codebase scanner agent...', 'info');

    const { provider, model, apiKey } = req.body;
    const aiConfig: ScannerAgentConfig | undefined =
      (provider && apiKey)
        ? { provider, model: model || undefined, apiKey }
        : undefined;

    if (!aiConfig) {
      await SessionManager.addLog(sessionId, 'No AI provider configured — using static manifest scan.', 'info');
    }

    const scanResult = await ScannerAgent.run(
      session.projectPath,
      aiConfig,
      async (msg, lvl) => { await SessionManager.addLog(sessionId, msg, lvl ?? 'info'); }
    );

    // 4. Update session settings
    const updatedSession = await SessionManager.updateSession(sessionId, {
      detectedStack: scanResult.detectedStack,
      fileTree: scanResult.fileTree,
      totalFiles: scanResult.fileList.length,
    });

    res.json({
      sessionId,
      fileTree: scanResult.fileTree,
      detectedStack: scanResult.detectedStack,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
