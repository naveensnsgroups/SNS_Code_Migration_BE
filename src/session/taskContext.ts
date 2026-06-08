import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SESSIONS_DIR = path.join(__dirname, '..', '..', 'sessions');

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
      return await fs.readJson(contextPath);
    } catch {
      return {};
    }
  }

  /**
   * Overwrites the complete task context dictionary
   */
  static async saveContext(sessionId: string, context: Record<string, any>): Promise<void> {
    const contextPath = this.getContextPath(sessionId);
    await fs.ensureDir(path.dirname(contextPath));
    await fs.writeJson(contextPath, context, { spaces: 2 });
  }

  /**
   * Merges partial updates into the task context dictionary
   */
  static async updateContext(sessionId: string, updates: Record<string, any>): Promise<Record<string, any>> {
    const context = await this.getContext(sessionId);
    const updated = { ...context, ...updates };
    await this.saveContext(sessionId, updated);
    return updated;
  }
}
