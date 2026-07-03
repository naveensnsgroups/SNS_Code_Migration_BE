import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import { writeJsonAtomic, readJsonWithRetry } from './fileUtils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SESSIONS_DIR = path.join(__dirname, '..', '..', 'sessions');

function mergeFileIndex(existing: any[], incoming: any[]): any[] {
  const map = new Map<string, any>();

  
  for (const entry of existing) {
    if (entry?.path) map.set(entry.path, entry);
  }

  
  for (const entry of incoming) {
    if (!entry?.path) continue;
    const ex = map.get(entry.path);
    if (!ex) {
      map.set(entry.path, entry);                     
    } else if (ex.read_status !== 'DONE') {
      map.set(entry.path, { ...ex, ...entry });        
    }
    
  }

  return Array.from(map.values());
}

export class TaskContextManager {
  private static getContextPath(sessionId: string): string {
    return path.join(SESSIONS_DIR, sessionId, 'taskContext.json');
  }

  
  static async getContext(sessionId: string): Promise<Record<string, any>> {
    const contextPath = this.getContextPath(sessionId);
    if (!(await fs.pathExists(contextPath))) {
      return {};
    }
    try {
      return await readJsonWithRetry<Record<string, any>>(contextPath);
    } catch {
      return {};
    }
  }

  
  static async saveContext(sessionId: string, context: Record<string, any>): Promise<void> {
    const contextPath = this.getContextPath(sessionId);
    await writeJsonAtomic(contextPath, context);
  }

  
  static async updateContext(sessionId: string, updates: Record<string, any>): Promise<Record<string, any>> {
    const context = await this.getContext(sessionId);

    
    const fileIndexKey = (
      context.FILE_INDEX_KEY ?? updates.FILE_INDEX_KEY
    ) as string | undefined;

    
    if (
      fileIndexKey &&
      Array.isArray(updates[fileIndexKey]) &&
      Array.isArray(context[fileIndexKey])
    ) {
      updates = {
        ...updates,
        [fileIndexKey]: mergeFileIndex(
          context[fileIndexKey] as any[],
          updates[fileIndexKey] as any[]
        ),
      };
    }

    const updated = { ...context, ...updates };
    await this.saveContext(sessionId, updated);
    return updated;
  }
}
