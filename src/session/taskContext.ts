import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import { writeJsonAtomic, readJsonWithRetry } from './fileUtils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SESSIONS_DIR = path.join(__dirname, '..', '..', 'sessions');

// =============================================================================
//  FILE_INDEX Merge Helper
//
//  Merges two FILE_INDEX arrays by `path` key.
//  NEVER downgrades read_status from 'DONE' to any other value.
//  This is the production equivalent of an idempotent state reducer:
//  once a file is marked DONE, it stays DONE regardless of what the
//  resume pass writes. Prevents analysis regression on restart.
// =============================================================================

function mergeFileIndex(existing: any[], incoming: any[]): any[] {
  const map = new Map<string, any>();

  // Seed the map with existing entries (source of truth for DONE status)
  for (const entry of existing) {
    if (entry?.path) map.set(entry.path, entry);
  }

  // Merge incoming: update only files that are NOT yet DONE
  for (const entry of incoming) {
    if (!entry?.path) continue;
    const ex = map.get(entry.path);
    if (!ex) {
      map.set(entry.path, entry);                     // new file → add it
    } else if (ex.read_status !== 'DONE') {
      map.set(entry.path, { ...ex, ...entry });        // not done → allow update
    }
    // ex.read_status === 'DONE': NEVER overwrite — idempotent protection
  }

  return Array.from(map.values());
}

export class TaskContextManager {
  private static getContextPath(sessionId: string): string {
    return path.join(SESSIONS_DIR, sessionId, 'taskContext.json');
  }

  /**
   * Loads the current task context dictionary
   */
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

  /**
   * Overwrites the complete task context dictionary
   */
  static async saveContext(sessionId: string, context: Record<string, any>): Promise<void> {
    const contextPath = this.getContextPath(sessionId);
    await writeJsonAtomic(contextPath, context);
  }

  /**
   * Merges partial updates into the task context dictionary.
   * Smart merge: if the update contains the FILE_INDEX array (identified by
   * FILE_INDEX_KEY), merge by path instead of replacing — DONE status is
   * never downgraded (idempotent write-once protection).
   */
  static async updateContext(sessionId: string, updates: Record<string, any>): Promise<Record<string, any>> {
    const context = await this.getContext(sessionId);

    // Detect FILE_INDEX_KEY from existing context or from the incoming updates
    const fileIndexKey = (
      context.FILE_INDEX_KEY ?? updates.FILE_INDEX_KEY
    ) as string | undefined;

    // If the update contains the file-index array, merge instead of replace
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
