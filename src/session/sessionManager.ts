import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import { MigrationSession, LogEntry, TokenUsageEntry } from './types.js';
import { FileNode } from '../types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Store sessions inside the backend root folder under "sessions/"
const SESSIONS_DIR = path.join(__dirname, '..', '..', 'sessions');

export class SessionManager {
  /**
   * Generates a unique session ID
   */
  static generateSessionId(): string {
    return Math.random().toString(36).substring(2, 10);
  }

  /**
   * Initializes paths and directory structure for a new session
   */
  static async createSession(sessionId: string): Promise<MigrationSession> {
    const sessionDir = path.join(SESSIONS_DIR, sessionId);
    const legacyPath = path.join(sessionDir, 'legacy');
    const modernPath = path.join(sessionDir, 'modern');

    await fs.ensureDir(sessionDir);
    await fs.ensureDir(legacyPath);
    await fs.ensureDir(modernPath);

    const session: MigrationSession = {
      sessionId,
      status: 'idle',
      projectPath: legacyPath,
      modernPath,
      totalFiles: 0,
      completedFiles: 0,
      fileTree: [],
      phases: [
        { id: 'scan',       label: 'Scan Codebase',         status: 'pending' },
        { id: 'plan',       label: 'Generate Plan',          status: 'pending' },
        { id: 'pseudocode', label: 'Write Pseudocode',       status: 'pending' },
        { id: 'migrate',    label: 'Migrate Files',          status: 'pending' },
        { id: 'install',    label: 'Install Dependencies',   status: 'pending' },
        { id: 'build',      label: 'Build Project',          status: 'pending' },
        { id: 'validate',   label: 'Validate & Fix',         status: 'pending' },
        { id: 'test',       label: 'Run Tests',              status: 'pending' },
        { id: 'report',     label: 'Final Report',           status: 'pending' },
      ],
    };

    await this.saveSession(session);
    await this.saveLogs(sessionId, []); // Initialize empty logs file
    return session;
  }

  /**
   * Saves the session state to session.json
   */
  static async saveSession(session: MigrationSession): Promise<void> {
    const sessionPath = path.join(SESSIONS_DIR, session.sessionId, 'session.json');
    await fs.ensureDir(path.dirname(sessionPath));
    await fs.writeJson(sessionPath, session, { spaces: 2 });
  }

  /**
   * Gets the session by ID
   */
  static async getSession(sessionId: string): Promise<MigrationSession | null> {
    const sessionPath = path.join(SESSIONS_DIR, sessionId, 'session.json');
    if (!(await fs.pathExists(sessionPath))) {
      return null;
    }
    return fs.readJson(sessionPath);
  }

  /**
   * Updates session data
   */
  static async updateSession(sessionId: string, updates: Partial<MigrationSession>): Promise<MigrationSession> {
    const session = await this.getSession(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    const updatedSession = { ...session, ...updates };
    await this.saveSession(updatedSession);
    return updatedSession;
  }

  /**
   * Adds a log entry to the session
   */
  static async addLog(
    sessionId: string,
    message: string,
    level: LogEntry['level'] = 'info',
    phase?: string
  ): Promise<LogEntry> {
    const log: LogEntry = {
      id: Math.random().toString(36).substring(2, 10),
      timestamp: new Date().toLocaleTimeString('en-US', { hour12: false }),
      level,
      message,
      phase,
    };

    const logs = await this.getLogs(sessionId);
    logs.push(log);
    await this.saveLogs(sessionId, logs);
    return log;
  }

  /**
   * Retrieves all logs for a session
   */
  static async getLogs(sessionId: string): Promise<LogEntry[]> {
    const logsPath = path.join(SESSIONS_DIR, sessionId, 'logs.json');
    if (!(await fs.pathExists(logsPath))) {
      return [];
    }
    try {
      return await fs.readJson(logsPath);
    } catch {
      return [];
    }
  }

  /**
   * Saves logs array to logs.json
   */
  private static async saveLogs(sessionId: string, logs: LogEntry[]): Promise<void> {
    const logsPath = path.join(SESSIONS_DIR, sessionId, 'logs.json');
    await fs.ensureDir(path.dirname(logsPath));
    await fs.writeJson(logsPath, logs, { spaces: 2 });
  }

  /**
   * Lists all sessions in the sessions directory.
   * Returns an array of MigrationSession objects for all sessions found.
   */
  static async listSessions(): Promise<MigrationSession[]> {
    try {
      if (!(await fs.pathExists(SESSIONS_DIR))) return [];
      const dirs = await fs.readdir(SESSIONS_DIR);
      const sessions: MigrationSession[] = [];
      for (const dir of dirs) {
        const sessionPath = path.join(SESSIONS_DIR, dir, 'session.json');
        if (await fs.pathExists(sessionPath)) {
          try {
            const session = await fs.readJson(sessionPath);
            sessions.push(session);
          } catch { /* skip corrupted sessions */ }
        }
      }
      return sessions;
    } catch {
      return [];
    }
  }

  /**
   * Records and aggregates token usage for the session, writes to session.json, and broadcasts the new total.
   */
  static async recordTokenUsage(
    sessionId: string,
    inputTokens: number,
    outputTokens: number,
    modelName: string,
    agentId: string,
    cachedInputTokens?: number,
    readCachedInputTokens?: number
  ): Promise<void> {
    try {
      const session = await this.getSession(sessionId);
      if (session) {
        const { estimateCost } = await import('../agents/agentExecutor.js');
        const estimatedCost = estimateCost(inputTokens, outputTokens, modelName);

        const ex = session.tokenUsage;
        const accumulatedInput = (ex?.inputTokens ?? 0) + inputTokens;
        const accumulatedOutput = (ex?.outputTokens ?? 0) + outputTokens;
        const accumulatedCached = (ex?.cachedInputTokens ?? 0) + (cachedInputTokens ?? 0);
        const accumulatedReadCached = (ex?.readCachedInputTokens ?? 0) + (readCachedInputTokens ?? 0);
        const accumulatedTotal = accumulatedInput + accumulatedOutput + accumulatedCached;

        const newTotals = {
          inputTokens: accumulatedInput,
          outputTokens: accumulatedOutput,
          cachedInputTokens: accumulatedCached > 0 ? accumulatedCached : undefined,
          readCachedInputTokens: accumulatedReadCached > 0 ? accumulatedReadCached : undefined,
          totalTokens: accumulatedTotal,
          estimatedCost: (ex?.estimatedCost ?? 0) + estimatedCost,
          model: modelName,
        };

        const entry: TokenUsageEntry = {
          agentId,
          model: modelName,
          requestId: `${sessionId}_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
          inputTokens,
          outputTokens,
          cachedInputTokens: cachedInputTokens && cachedInputTokens > 0 ? cachedInputTokens : undefined,
          readCachedInputTokens: readCachedInputTokens && readCachedInputTokens > 0 ? readCachedInputTokens : undefined,
          timestamp: new Date().toISOString(),
        };

        const existingHistory = session.tokenUsageHistory ?? [];
        await this.updateSession(sessionId, {
          tokenUsage: newTotals,
          tokenUsageHistory: [...existingHistory, entry],
        });

        const { EventBroadcaster } = await import('../routes/stream.js');
        EventBroadcaster.broadcast(sessionId, 'token_usage', newTotals);
      }
    } catch (err) {
      console.error('Failed to record token usage:', err);
    }
  }
}

