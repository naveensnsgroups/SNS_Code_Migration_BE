import { Router, Request, Response } from 'express';
import { SessionManager } from '../session/sessionManager.js';
import { SSEEvent } from '../types.js';

const router = Router();

// Store active SSE connections
const activeClients: Map<string, Response[]> = new Map();

export class EventBroadcaster {
  /**
   * Broadcast an event to all connected SSE clients for a session.
   */
  static broadcast(sessionId: string, type: SSEEvent['type'], data: any) {
    const clients = activeClients.get(sessionId) || [];
    const event: SSEEvent = {
      type,
      data,
      timestamp: new Date().toLocaleTimeString('en-US', { hour12: false }),
    };

    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of clients) {
      try {
        client.write(payload);
      } catch (err) {
        console.error(`Error sending SSE event to client in session ${sessionId}:`, err);
      }
    }
  }
}

/**
 * GET /api/stream/:sessionId
 * Establishes an SSE event stream for monitoring migration logs and progress.
 */
router.get('/:sessionId', async (req: Request, res: Response) => {
  const { sessionId } = req.params;

  const session = await SessionManager.getSession(sessionId);
  if (!session) {
    res.status(404).json({ error: 'Session not found', code: 'NOT_FOUND' });
    return;
  }

  // Set headers for Server-Sent Events (SSE)
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Prevent connection timeouts
  req.setTimeout(0);
  if (res.socket) {
    res.socket.setTimeout(0);
  }

  // Register client connection
  if (!activeClients.has(sessionId)) {
    activeClients.set(sessionId, []);
  }
  activeClients.get(sessionId)!.push(res);

  // Send historical logs to hydrate client on connection/reconnection
  const logs = await SessionManager.getLogs(sessionId);
  for (const log of logs) {
    const sseEvent: SSEEvent = {
      type: 'log',
      data: log,
      timestamp: log.timestamp,
    };
    res.write(`data: ${JSON.stringify(sseEvent)}\n\n`);
  }

  // Keep connection alive with a heartbeat every 25 seconds
  const heartbeatInterval = setInterval(() => {
    const heartbeat: SSEEvent = {
      type: 'heartbeat',
      data: {},
      timestamp: new Date().toLocaleTimeString('en-US', { hour12: false }),
    };
    res.write(`data: ${JSON.stringify(heartbeat)}\n\n`);
  }, 25000);

  // Clean up client on disconnect
  req.on('close', () => {
    clearInterval(heartbeatInterval);
    const clients = activeClients.get(sessionId) || [];
    const index = clients.indexOf(res);
    if (index !== -1) {
      clients.splice(index, 1);
    }
    if (clients.length === 0) {
      activeClients.delete(sessionId);
    }
  });
});

export default router;
