import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import { writeJsonAtomic, readJsonWithRetry, enqueueKeyedWrite } from './fileUtils.js';

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

  
  // Runs an arbitrary read→transform→save cycle atomically inside the per-session
  // queue. Use this when the decision of WHAT to change depends on the current
  // context (e.g. archiving keys): computing the change from a pre-queue snapshot
  // and then applying it via updateContext can delete data written in between.
  static async transformContext(
    sessionId: string,
    transform: (context: Record<string, any>) => Record<string, any>
  ): Promise<Record<string, any>> {
    return enqueueKeyedWrite(`taskContext:${sessionId}`, async () => {
      const context = await this.getContext(sessionId);
      const updated = transform(context);
      await this.saveContext(sessionId, updated);
      return updated;
    });
  }

  // The whole read→merge→write cycle is serialized per session: two concurrent
  // agents updating different keys must not clobber each other's writes.
  static async updateContext(sessionId: string, updates: Record<string, any>): Promise<Record<string, any>> {
    return enqueueKeyedWrite(`taskContext:${sessionId}`, async () => {
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
    });
  }
}
