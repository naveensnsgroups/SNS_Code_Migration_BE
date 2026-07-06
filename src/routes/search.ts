import { Router, Request, Response, NextFunction } from 'express';
import { SessionManager } from '../session/sessionManager.js';
import { scanProjectDirectory } from '../tools/fileScanner.js';
import { readSessionFile } from '../tools/fileReader.js';

const router = Router();

interface SearchMatch {
  filePath: string;
  line: number;
  content: string;
}

router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { sessionId, query } = req.query;

    if (!sessionId || !query) {
      res.status(400).json({ error: 'Missing sessionId or search query', code: 'BAD_REQUEST' });
      return;
    }

    const session = await SessionManager.getSession(sessionId as string);
    if (!session) {
      res.status(404).json({ error: 'Session not found', code: 'NOT_FOUND' });
      return;
    }

    const searchQuery = (query as string).toLowerCase().trim();
    if (!searchQuery) {
      res.json({ matches: [] });
      return;
    }

    
    const { fileList } = await scanProjectDirectory(session.projectPath);
    const matches: SearchMatch[] = [];

    
    for (const filePath of fileList) {
      
      if (!filePath.match(/\.(js|ts|tsx|jsx|json|py|java|php|rb|go|rs|cs|kt|env|yml|yaml|sql|sh|html|css|md|txt)$/i)) {
        continue;
      }

      try {
        const content = await readSessionFile(session.projectPath, filePath);
        const lines = content.split(/\r?\n/);
        
        for (let i = 0; i < lines.length; i++) {
          const lineContent = lines[i];
          if (lineContent.toLowerCase().includes(searchQuery)) {
            matches.push({
              filePath,
              line: i + 1,
              content: lineContent.trim(),
            });

            
            if (matches.length >= 50) {
              break;
            }
          }
        }
      } catch (err) {
        
      }

      if (matches.length >= 50) {
        break;
      }
    }

    res.json({ matches });
  } catch (err) {
    next(err);
  }
});

export default router;
