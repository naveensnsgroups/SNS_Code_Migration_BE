import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';                    
import { MigrationSession, LogEntry, TokenUsageEntry } from './types.js';
import { FileNode } from '../types.js';
import { writeJsonAtomic, readJsonWithRetry } from './fileUtils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SESSIONS_DIR = path.join(__dirname, '..', '..', 'sessions');

export class SessionManager {
  
  
  
  
  
  private static readonly writeQueues = new Map<string, Promise<void>>();

  private static enqueueWrite<T>(
    sessionId: string,
    fn: () => Promise<T>
  ): Promise<T> {
    const tail   = this.writeQueues.get(sessionId) ?? Promise.resolve();
    const result = tail.then(() => fn());
    
    this.writeQueues.set(sessionId, result.then(() => {}, () => {}));
    return result;
  }

  
  static generateSessionId(): string {
    return randomUUID().replace(/-/g, '').substring(0, 12);
  }

  
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
        { id: 'scan',               label: 'Stack Detection',    status: 'pending' },
        { id: 'discovery',          label: 'Discovery',          status: 'pending' },
        { id: 'file-analysis',      label: 'File Analysis',      status: 'pending' },
        { id: 'graph-resolution',   label: 'Graph Resolution',   status: 'pending' },
        { id: 'section-writing',    label: 'Section Writing',    status: 'pending' },
        { id: 'assembly',           label: 'Assembly',           status: 'pending' },
        // Stage 2 — code migration (added after Stage 1 stabilization).
        { id: 'migration-planning', label: 'Migration Planning', status: 'pending' },
        { id: 'code-generation',    label: 'Code Generation',    status: 'pending' },
        { id: 'verification',      label: 'Verification',       status: 'pending' },
        { id: 'migration-assembly', label: 'Migration Report',   status: 'pending' },
      ],
    };

    await this.saveSession(session);
    await this.saveLogs(sessionId, []); 
    return session;
  }

  
  static async saveSession(session: MigrationSession): Promise<void> {
    const sessionPath = path.join(SESSIONS_DIR, session.sessionId, 'session.json');
    await writeJsonAtomic(sessionPath, session);
  }

  
  static async getSession(sessionId: string): Promise<MigrationSession | null> {
    const sessionPath = path.join(SESSIONS_DIR, sessionId, 'session.json');
    if (!(await fs.pathExists(sessionPath))) {
      return null;
    }
    try {
      return await readJsonWithRetry<MigrationSession>(sessionPath);
    } catch {
      return null;
    }
  }

  
  static async updateSession(sessionId: string, updates: Partial<MigrationSession>): Promise<MigrationSession> {
    return this.enqueueWrite(sessionId, async () => {
      const session = await this.getSession(sessionId);
      if (!session) {
        throw new Error(`Session ${sessionId} not found`);
      }
      const updatedSession = { ...session, ...updates };
      await this.saveSession(updatedSession);
      return updatedSession;
    });
  }

  
  static async addLog(
    sessionId: string,
    message: string,
    level: LogEntry['level'] = 'info',
    phase?: string
  ): Promise<LogEntry> {
    return this.enqueueWrite(sessionId, async () => {
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
    });
  }

  
  static async getLogs(sessionId: string): Promise<LogEntry[]> {
    const logsPath = path.join(SESSIONS_DIR, sessionId, 'logs.json');
    if (!(await fs.pathExists(logsPath))) {
      return [];
    }
    try {
      return await readJsonWithRetry<LogEntry[]>(logsPath);
    } catch {
      return [];
    }
  }

  
  private static async saveLogs(sessionId: string, logs: LogEntry[]): Promise<void> {
    const logsPath = path.join(SESSIONS_DIR, sessionId, 'logs.json');
    await writeJsonAtomic(logsPath, logs);
  }

  
  static async listSessions(): Promise<MigrationSession[]> {
    try {
      if (!(await fs.pathExists(SESSIONS_DIR))) return [];
      const dirs = await fs.readdir(SESSIONS_DIR);
      const sessions: MigrationSession[] = [];
      for (const dir of dirs) {
        const sessionPath = path.join(SESSIONS_DIR, dir, 'session.json');
        if (await fs.pathExists(sessionPath)) {
          try {
            const session = await readJsonWithRetry<MigrationSession>(sessionPath);
            sessions.push(session);
          } catch {  }
        }
      }
      return sessions;
    } catch {
      return [];
    }
  }

  
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
      const { estimateCost } = await import('../agents/compactor/agent-cost-estimator.js');

      // The read-of-current-totals and the accumulate+write must happen inside the
      // SAME queued slot. Computing totals before enqueueing lets two concurrent
      // completions read the same snapshot and the second write drop the first's
      // tokens (silent undercount). Do not call updateSession here — a nested
      // enqueueWrite on the same session would deadlock the queue.
      const newTotals = await this.enqueueWrite(sessionId, async () => {
        const session = await this.getSession(sessionId);
        if (!session) return null;

        // Cost uses the user-configured rate for THIS model, read fresh from the
        // session inside the queue — never a hardcoded table (see agent-cost-estimator.ts).
        const thisCallCost = estimateCost(
          inputTokens, outputTokens, modelName, session.modelPricing,
          cachedInputTokens ?? 0, readCachedInputTokens ?? 0
        );

        const ex = session.tokenUsage;
        const accumulatedInput = (ex?.inputTokens ?? 0) + inputTokens;
        const accumulatedOutput = (ex?.outputTokens ?? 0) + outputTokens;
        const accumulatedCached = (ex?.cachedInputTokens ?? 0) + (cachedInputTokens ?? 0);
        const accumulatedReadCached = (ex?.readCachedInputTokens ?? 0) + (readCachedInputTokens ?? 0);
        const accumulatedTotal = accumulatedInput + accumulatedOutput + accumulatedCached;

        // If this call's cost is unknown (no rate configured) AND nothing has been
        // priced so far, the running total stays null (honest "unavailable") rather
        // than silently treating the unknown call as $0.
        const priorCost = ex?.estimatedCost ?? null;
        const accumulatedCost =
          thisCallCost === null && priorCost === null ? null
          : (priorCost ?? 0) + (thisCallCost ?? 0);
        // Distinct from "fully unavailable": some calls WERE priced, but at least
        // one model used in this session has no configured rate, so the total is
        // a real but INCOMPLETE lower bound — the UI must say so, not present it
        // as the full cost.
        const costIncomplete = thisCallCost === null || (ex as any)?.costIncomplete === true;

        const totals = {
          inputTokens: accumulatedInput,
          outputTokens: accumulatedOutput,
          cachedInputTokens: accumulatedCached > 0 ? accumulatedCached : undefined,
          readCachedInputTokens: accumulatedReadCached > 0 ? accumulatedReadCached : undefined,
          totalTokens: accumulatedTotal,
          estimatedCost: accumulatedCost,
          costIncomplete: accumulatedCost !== null ? costIncomplete : undefined,
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

        const updatedSession = {
          ...session,
          tokenUsage: totals,
          tokenUsageHistory: [...(session.tokenUsageHistory ?? []), entry],
        };
        await this.saveSession(updatedSession);
        return totals;
      });

      if (newTotals) {
        const { EventBroadcaster } = await import('../routes/stream.js');
        EventBroadcaster.broadcast(sessionId, 'token_usage', newTotals);
      }
    } catch (err) {
      console.error('Failed to record token usage:', err);
    }
  }
}

