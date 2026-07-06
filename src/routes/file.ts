import { Router, Request, Response, NextFunction } from 'express';
import { SessionManager } from '../session/sessionManager.js';
import { readSessionFile } from '../tools/fileReader.js';
import fs from 'fs-extra';
import path from 'path';

const router = Router();

const MODERN_ONLY_FILES = ['Stage1_Analysis.md', 'migration-plan.md'];

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

    
    
    if (MODERN_ONLY_FILES.includes(fileName)) {
      
      let content = '';
      let found = false;

      const modernFilePath = path.join(session.modernPath, fileName);
      if (await fs.pathExists(modernFilePath)) {
        content = await fs.readFile(modernFilePath, 'utf-8');
        found = true;
      } else {
        
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

    
    
    let legacyContent = '';
    try {
      legacyContent = await readSessionFile(session.projectPath, relativePath as string);
    } catch (err: any) {
      legacyContent = `// Error reading legacy file: ${err.message}`;
    }

    
    let modernContent: string | null = null;
    
    
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

router.get('/download', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { sessionId, file } = req.query;
    if (!sessionId || !file) {
      res.status(400).json({ error: 'Missing sessionId or file', code: 'BAD_REQUEST' });
      return;
    }

    const session = await SessionManager.getSession(sessionId as string);
    if (!session) {
      res.status(404).json({ error: 'Session not found', code: 'NOT_FOUND' });
      return;
    }

    const safeFile     = path.basename(file as string);
    const filePath     = path.join(session.modernPath, safeFile);

    if (!(await fs.pathExists(filePath))) {
      res.status(404).json({ error: `File "${safeFile}" not found. Run Stage 1 first.`, code: 'NOT_FOUND' });
      return;
    }

    res.setHeader('Content-Disposition', `attachment; filename="${safeFile}"`);
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
  } catch (err) {
    next(err);
  }
});

export default router;
