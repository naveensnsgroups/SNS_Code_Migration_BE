

import * as parcelWatcher from '@parcel/watcher';
import { EventBroadcaster } from '../routes/stream.js';

const watchers = new Map<string, parcelWatcher.AsyncSubscription>();

const DEBOUNCE_MS = 300;
const debouncers  = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleRefresh(sessionId: string, events: parcelWatcher.Event[]): void {
  
  const existing = debouncers.get(sessionId);
  if (existing) clearTimeout(existing);

  
  const timer = setTimeout(() => {
    debouncers.delete(sessionId);
    EventBroadcaster.broadcast(sessionId, 'file_tree_changed', {
      changedFiles: events.map(e => ({
        path: e.path,
        type: e.type,   
      })),
    });
  }, DEBOUNCE_MS);

  debouncers.set(sessionId, timer);
}

export class FileWatcherService {

  
  static async startWatching(sessionId: string, modernPath: string): Promise<void> {
    
    await FileWatcherService.stopWatching(sessionId);

    try {
      const subscription = await parcelWatcher.subscribe(
        modernPath,
        (err, events) => {
          if (err) {
            console.error(`[FileWatcher] Error watching session ${sessionId}:`, err);
            return;
          }
          if (!events || events.length === 0) return;

          
          scheduleRefresh(sessionId, events);
        },
        {
          
          ignore: [
            '**/node_modules/**',
            '**/.git/**',
            '**/*.tmp',
            '**/*.lock',
            '**/Thumbs.db',
          ]
        }
      );

      watchers.set(sessionId, subscription);
      console.log(`[FileWatcher] Watching "${modernPath}" for session ${sessionId}`);

    } catch (err) {
      
      
      console.warn(
        `[FileWatcher] Could not start watcher for "${modernPath}" (session ${sessionId}):`,
        err instanceof Error ? err.message : err
      );
    }
  }

  
  static async stopWatching(sessionId: string): Promise<void> {
    
    const pending = debouncers.get(sessionId);
    if (pending) {
      clearTimeout(pending);
      debouncers.delete(sessionId);
    }

    const sub = watchers.get(sessionId);
    if (sub) {
      try {
        await sub.unsubscribe();
      } catch {
        
      }
      watchers.delete(sessionId);
      console.log(`[FileWatcher] Stopped watching session ${sessionId}`);
    }
  }

  
  static async stopAll(): Promise<void> {
    const sessionIds = Array.from(watchers.keys());
    await Promise.all(sessionIds.map(id => FileWatcherService.stopWatching(id)));
    console.log('[FileWatcher] All watchers stopped.');
  }
}
