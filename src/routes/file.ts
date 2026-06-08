import { Router, Request, Response, NextFunction } from 'express';
import { SessionManager } from '../session/sessionManager.js';
import { readSessionFile } from '../tools/fileReader.js';
import fs from 'fs-extra';
import path from 'path';

const router = Router();

// Stage-1 reports that live in modernPath (not legacyPath)
const MODERN_ONLY_FILES = ['Stage1_Analysis.md', 'migration-plan.md'];

/**
 * GET /api/file
 * Query: sessionId, path
 * Returns legacy content and modern content side-by-side.
 *
 * Special case: Stage1_Analysis.md and migration-plan.md are written by the agent
 * to modernPath. When the Explorer clicks them, serve the modernPath content as
 * the primary content (not legacyPath which won't have them).
 */
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { sessionId, path: relativePath } = req.query;

    if (!sessionId || !relativePath) {
      res.status(400).json({ error: 'Missing sessionId or path', code: 'BAD_REQUEST' });
      return;
    }

    const session = await SessionManager.getSession(sessionId as string);
    if (!session) {
      res.status(404).json({ error: 'Session not found', code: 'NOT_FOUND' });
      return;
    }

    const fileName = path.basename(relativePath as string);

    // ── Special Case: Stage-1 report files ──────────────────────────────────
    // These files are written by the agent to modernPath, NOT legacyPath.
    if (MODERN_ONLY_FILES.includes(fileName)) {
      // Try modernPath first (primary), then relativePath as absolute fallback
      let content = '';
      let found = false;

      const modernFilePath = path.join(session.modernPath, fileName);
      if (await fs.pathExists(modernFilePath)) {
        content = await fs.readFile(modernFilePath, 'utf-8');
        found = true;
      } else {
        // Try using the relativePath directly in modernPath
        try {
          content = await readSessionFile(session.modernPath, relativePath as string);
          found = true;
        } catch {
          content = `# ${fileName}\n\nThis file has not been generated yet. Run the migration pipeline to generate it.`;
        }
      }

      res.json({
        content,
        modernContent: null,
        language: 'markdown',
        isModernReport: true,
        found,
      });
      return;
    }

    // ── Normal Case: Legacy source files ────────────────────────────────────
    // Read legacy file content
    let legacyContent = '';
    try {
      legacyContent = await readSessionFile(session.projectPath, relativePath as string);
    } catch (err: any) {
      legacyContent = `// Error reading legacy file: ${err.message}`;
    }

    // Read modern file content if it exists
    let modernContent: string | null = null;
    
    // Find matching pseudocode item to get the target path
    const sessionDir = path.dirname(session.projectPath);
    const pseudocodePath = path.join(session.modernPath, 'pseudocode.json');
    
    let targetRelativePath = relativePath as string;
    if (await fs.pathExists(pseudocodePath)) {
      try {
        const roadmap = await fs.readJson(pseudocodePath);
        const match = roadmap.find((item: any) => item.path === relativePath);
        if (match) {
          targetRelativePath = match.targetPath;
        }
      } catch {}
    }

    try {
      modernContent = await readSessionFile(session.modernPath, targetRelativePath);
    } catch {
      // Modern content not created yet, return null
      modernContent = null;
    }

    res.json({
      content: legacyContent,
      modernContent,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
