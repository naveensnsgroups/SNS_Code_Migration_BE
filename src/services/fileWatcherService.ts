// =============================================================================
//  fileWatcherService.ts — Live Disk Watcher (SNS IDE Standard)
//
//  SNS IDE equivalent: packages/filesystem/src/node/parcel-watcher/
//    ParcelFileSystemWatcherService — watches workspace directories using
//    @parcel/watcher (OS-native: inotify on Linux, FSEvents on macOS,
//    ReadDirectoryChangesW on Windows).
//
//  Our platform adaptation:
//    - Watches each session's modernPath (output directory)
//    - On any file CREATED / UPDATED / DELETED event, broadcasts
//      'file_tree_changed' via the existing SSE pipe
//    - FE receives event → calls GET /api/migrate/tree → Explorer refreshes
//
//  Lifecycle:
//    startWatching()  called in POST /api/migrate/start (modernPath known)
//    stopWatching()   called in POST /api/migrate/stop
//    stopAll()        called on server SIGTERM / SIGINT
// =============================================================================

import * as parcelWatcher from '@parcel/watcher';
import { EventBroadcaster } from '../routes/stream.js';

// ── One watcher subscription per active session ───────────────────────────────
const watchers = new Map<string, parcelWatcher.AsyncSubscription>();

// ── Debounce: batch rapid writes (agent writes many files back-to-back) ───────
// Emit ONE 'file_tree_changed' per session per debounce window.
// SNS IDE coalesces rapid file events before notifying clients (same principle).
const DEBOUNCE_MS = 300;
const debouncers  = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleRefresh(sessionId: string, events: parcelWatcher.Event[]): void {
  // Clear any pending debounce for this session
  const existing = debouncers.get(sessionId);
  if (existing) clearTimeout(existing);

  // Schedule one broadcast after the debounce window
  const timer = setTimeout(() => {
    debouncers.delete(sessionId);
    EventBroadcaster.broadcast(sessionId, 'file_tree_changed', {
      changedFiles: events.map(e => ({
        path: e.path,
        type: e.type,   // 'create' | 'update' | 'delete'
      })),
    });
  }, DEBOUNCE_MS);

  debouncers.set(sessionId, timer);
}

// ── FileWatcherService ────────────────────────────────────────────────────────

export class FileWatcherService {

  /**
   * Start watching a session's output directory (modernPath).
   *
   * SNS IDE equivalent: ParcelFileSystemWatcherService.watch()
   *
   * @param sessionId  The session to watch for
   * @param modernPath The output directory to watch (e.g. E:\Demo-5)
   */
  static async startWatching(sessionId: string, modernPath: string): Promise<void> {
    // Always stop any existing watcher for this session before starting new one
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

          // Debounce rapid writes → one SSE event per burst
          scheduleRefresh(sessionId, events);
        },
        {
          // SNS IDE ignores the same patterns (node_modules, .git)
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
      // Non-fatal — watcher failure must not break the migration pipeline.
      // The FE will still refresh on SSE phase_change / complete events.
      console.warn(
        `[FileWatcher] Could not start watcher for "${modernPath}" (session ${sessionId}):`,
        err instanceof Error ? err.message : err
      );
    }
  }

  /**
   * Stop watching a session's directory and release OS resources.
   *
   * SNS IDE equivalent: ParcelFileSystemWatcherService.dispose()
   */
  static async stopWatching(sessionId: string): Promise<void> {
    // Cancel any pending debounce
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
        // Ignore cleanup errors — OS watcher may already be gone
      }
      watchers.delete(sessionId);
      console.log(`[FileWatcher] Stopped watching session ${sessionId}`);
    }
  }

  /**
   * Stop all active watchers (call on server shutdown).
   *
   * SNS IDE equivalent: Disposable.dispose() on all watcher subscriptions
   */
  static async stopAll(): Promise<void> {
    const sessionIds = Array.from(watchers.keys());
    await Promise.all(sessionIds.map(id => FileWatcherService.stopWatching(id)));
    console.log('[FileWatcher] All watchers stopped.');
  }
}
