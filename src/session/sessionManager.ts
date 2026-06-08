import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import { MigrationSession, LogEntry } from './types.js';
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
}

