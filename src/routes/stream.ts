import { Router, Request, Response } from 'express';
import { SessionManager } from '../session/sessionManager.js';
import { SSEEvent } from '../types.js';

const router = Router();

const activeClients: Map<string, Response[]> = new Map();

export class EventBroadcaster {
  
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

router.get('/:sessionId', async (req: Request, res: Response) => {
  const { sessionId } = req.params;

  const session = await SessionManager.getSession(sessionId);
  if (!session) {
    res.status(404).json({ error: 'Session not found', code: 'NOT_FOUND' });
    return;
  }

  
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  
  req.setTimeout(0);
  if (res.socket) {
    res.socket.setTimeout(0);
  }

  
  if (!activeClients.has(sessionId)) {
    activeClients.set(sessionId, []);
  }
  activeClients.get(sessionId)!.push(res);

  
  const logs = await SessionManager.getLogs(sessionId);
  for (const log of logs) {
    const sseEvent: SSEEvent = {
      type: 'log',
      data: log,
      timestamp: log.timestamp,
    };
    res.write(`data: ${JSON.stringify(sseEvent)}\n\n`);
  }

  
  
  
  
  try {
    const sessionState = await SessionManager.getSession(sessionId);
    if (sessionState) {
      const ts = new Date().toLocaleTimeString('en-US', { hour12: false });

      
      if (sessionState.progress !== undefined) {
        res.write(`data: ${JSON.stringify({
          type: 'progress',
          data: { percent: sessionState.progress, currentFile: sessionState.currentFile ?? '' },
          timestamp: ts,
        })}\n\n`);
      }

      
      for (const phase of sessionState.phases ?? []) {
        if (phase.status !== 'pending') {
          res.write(`data: ${JSON.stringify({
            type: 'phase_change',
            data: { phaseId: phase.id, status: phase.status, phase: phase.id },
            timestamp: ts,
          })}\n\n`);
        }
      }
    }
  } catch (stateErr) {
    
    console.warn(`[SSE] State replay failed for session ${sessionId}:`, stateErr);
  }

  
  const heartbeatInterval = setInterval(() => {
    const heartbeat: SSEEvent = {
      type: 'heartbeat',
      data: {},
      timestamp: new Date().toLocaleTimeString('en-US', { hour12: false }),
    };
    res.write(`data: ${JSON.stringify(heartbeat)}\n\n`);
  }, 25000);

  
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
