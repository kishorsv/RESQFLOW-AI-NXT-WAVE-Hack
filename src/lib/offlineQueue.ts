// Shared Persistent IndexedDB Offline Action Queue & Read Cache
// Used identically by the Browser API Handler (src/lib/api.ts) and Service Worker (src/sw.ts).

export const OFFLINE_DB_NAME = 'resqflow-offline-db';
export const OFFLINE_DB_VERSION = 1;
export const ACTION_QUEUE_STORE = 'action_queue';
export const READ_CACHE_STORE = 'api_read_cache';
export const OFFLINE_SYNC_TAG = 'resqflow-offline-sync';
export const OFFLINE_BROADCAST_CHANNEL = 'resqflow-offline-sync-bus';

export type QueuedActionStatus = 'pending' | 'syncing' | 'failed';

export interface OfflineQueuedAction {
  id: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
  label: string;
  mode: 'demo' | 'operational';
  createdAt: string;
  attempts: number;
  lastAttemptAt: string | null;
  lastError: string | null;
  status: QueuedActionStatus;
}

export interface OfflineSyncResult {
  syncedCount: number;
  failedCount: number;
  remainingCount: number;
  skippedOffline: boolean;
  errors: { id: string; label: string; error: string }[];
}

export interface OfflineQueueEvent {
  type: 'QUEUE_UPDATED' | 'SYNC_STARTED' | 'SYNC_COMPLETED';
  queuedCount?: number;
  result?: OfflineSyncResult;
}

let simulatedOfflineFlag = false;
try {
  if (typeof sessionStorage !== 'undefined') {
    simulatedOfflineFlag = sessionStorage.getItem('resqflow_simulated_offline') === 'true';
  }
} catch {
  // Ignore inside Service Worker or restricted context
}

const offlineModeListeners = new Set<(simOffline: boolean) => void>();
const queueListeners = new Set<(actions: OfflineQueuedAction[], lastResult?: OfflineSyncResult) => void>();

export function isSimulatedOffline(): boolean {
  return simulatedOfflineFlag;
}

export function isEffectivelyOffline(): boolean {
  if (simulatedOfflineFlag) return true;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
  return false;
}

export function setSimulatedOffline(next: boolean) {
  simulatedOfflineFlag = next;
  try {
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.setItem('resqflow_simulated_offline', next ? 'true' : 'false');
    }
  } catch {
    // ignore
  }
  // Inform active Service Worker so SW fetch interceptor mirrors simulated offline state
  try {
    if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator && navigator.serviceWorker.controller) {
      navigator.serviceWorker.controller.postMessage({
        type: 'SET_SIMULATED_OFFLINE',
        enabled: next,
      });
    }
  } catch {
    // ignore
  }
  for (const cb of offlineModeListeners) cb(next);
}

export function subscribeSimulatedOffline(cb: (simOffline: boolean) => void): () => void {
  offlineModeListeners.add(cb);
  cb(simulatedOfflineFlag);
  return () => {
    offlineModeListeners.delete(cb);
  };
}

export function generateOfflineActionId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `off-${crypto.randomUUID()}`;
  }
  return `off-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function openOfflineDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(OFFLINE_DB_NAME, OFFLINE_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(ACTION_QUEUE_STORE)) {
        const store = db.createObjectStore(ACTION_QUEUE_STORE, { keyPath: 'id' });
        store.createIndex('createdAt', 'createdAt', { unique: false });
        store.createIndex('status', 'status', { unique: false });
      }
      if (!db.objectStoreNames.contains(READ_CACHE_STORE)) {
        db.createObjectStore(READ_CACHE_STORE, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('Failed to open IndexedDB offline store'));
  });
}

function broadcastEvent(event: OfflineQueueEvent) {
  try {
    if (typeof BroadcastChannel !== 'undefined') {
      const ch = new BroadcastChannel(OFFLINE_BROADCAST_CHANNEL);
      ch.postMessage(event);
      ch.close();
    }
  } catch {
    // BroadcastChannel unavailable in older runtimes
  }
}

async function notifyLocalSubscribers(lastResult?: OfflineSyncResult) {
  if (queueListeners.size === 0) return;
  try {
    const actions = await getQueuedActions();
    for (const cb of queueListeners) {
      cb(actions, lastResult);
    }
  } catch {
    // ignore
  }
}

export function subscribeOfflineQueue(
  cb: (actions: OfflineQueuedAction[], lastResult?: OfflineSyncResult) => void
): () => void {
  queueListeners.add(cb);
  getQueuedActions()
    .then((list) => cb(list))
    .catch(() => {});

  let channel: BroadcastChannel | null = null;
  try {
    if (typeof BroadcastChannel !== 'undefined') {
      channel = new BroadcastChannel(OFFLINE_BROADCAST_CHANNEL);
      channel.onmessage = (evt: MessageEvent<OfflineQueueEvent>) => {
        getQueuedActions()
          .then((list) => cb(list, evt.data?.result))
          .catch(() => {});
      };
    }
  } catch {
    // ignore
  }

  return () => {
    queueListeners.delete(cb);
    try {
      channel?.close();
    } catch {
      // ignore
    }
  };
}

export function buildActionLabel(method: string, url: string, rawBody: string | null): string {
  const cleanPath = url.replace(/^https?:\/\/[^/]+/, '').replace(/^\/api\/v1/, '');
  let detail = '';
  if (rawBody) {
    try {
      const parsed = JSON.parse(rawBody);
      detail =
        parsed.title ||
        parsed.locationName ||
        parsed.name ||
        parsed.callsign ||
        parsed.reason ||
        parsed.text ||
        parsed.status ||
        parsed.type ||
        '';
    } catch {
      // ignore non-json
    }
  }
  const suffix = detail ? ` — ${String(detail).slice(0, 48)}` : '';
  return `${method.toUpperCase()} ${cleanPath}${suffix}`;
}

export async function enqueueOfflineAction(
  action: Omit<OfflineQueuedAction, 'attempts' | 'lastAttemptAt' | 'lastError' | 'status' | 'createdAt'> & {
    createdAt?: string;
  }
): Promise<OfflineQueuedAction> {
  const db = await openOfflineDb();
  const record: OfflineQueuedAction = {
    ...action,
    createdAt: action.createdAt || new Date().toISOString(),
    attempts: 0,
    lastAttemptAt: null,
    lastError: null,
    status: 'pending',
  };

  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(ACTION_QUEUE_STORE, 'readwrite');
    tx.objectStore(ACTION_QUEUE_STORE).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });

  // Register Background Sync API tag when an active Service Worker registration exists
  try {
    if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
      const reg = await navigator.serviceWorker.getRegistration();
      if (reg?.active) {
        const syncMgr = (reg as unknown as { sync?: { register: (tag: string) => Promise<void> } }).sync;
        if (syncMgr) {
          await syncMgr.register(OFFLINE_SYNC_TAG);
        }
      }
    }
  } catch {
    // Background Sync is optional; online event listener handles fallback seamlessly
  }

  const all = await getQueuedActions();
  broadcastEvent({ type: 'QUEUE_UPDATED', queuedCount: all.length });
  await notifyLocalSubscribers();
  return record;
}

export async function getQueuedActions(): Promise<OfflineQueuedAction[]> {
  const db = await openOfflineDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(ACTION_QUEUE_STORE, 'readonly');
    const req = tx.objectStore(ACTION_QUEUE_STORE).getAll();
    req.onsuccess = () => {
      const list = (req.result as OfflineQueuedAction[]) || [];
      list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      resolve(list);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function updateQueuedAction(action: OfflineQueuedAction): Promise<void> {
  const db = await openOfflineDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(ACTION_QUEUE_STORE, 'readwrite');
    tx.objectStore(ACTION_QUEUE_STORE).put(action);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function removeQueuedAction(id: string): Promise<void> {
  const db = await openOfflineDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(ACTION_QUEUE_STORE, 'readwrite');
    tx.objectStore(ACTION_QUEUE_STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  const all = await getQueuedActions();
  broadcastEvent({ type: 'QUEUE_UPDATED', queuedCount: all.length });
  await notifyLocalSubscribers();
}

export async function retryFailedActions(): Promise<void> {
  const actions = await getQueuedActions();
  for (const a of actions) {
    if (a.status === 'failed') {
      await updateQueuedAction({ ...a, status: 'pending', lastError: null });
    }
  }
  await notifyLocalSubscribers();
}

export async function clearFailedActions(): Promise<void> {
  const actions = await getQueuedActions();
  for (const a of actions) {
    if (a.status === 'failed') {
      await removeQueuedAction(a.id);
    }
  }
}

let replayAuthHeaderProvider: (() => Record<string, string>) | null = null;

export function setOfflineReplayAuthHeaderProvider(fn: () => Record<string, string>) {
  replayAuthHeaderProvider = fn;
}

async function executeFlushUnsafe(bypassOfflineCheck = false): Promise<OfflineSyncResult> {
  const actions = await getQueuedActions();
  const pending = actions.filter((a) => a.status === 'pending' || a.status === 'syncing');

  if (pending.length === 0) {
    return { syncedCount: 0, failedCount: 0, remainingCount: actions.length, skippedOffline: false, errors: [] };
  }

  if (!bypassOfflineCheck && isEffectivelyOffline()) {
    return {
      syncedCount: 0,
      failedCount: 0,
      remainingCount: actions.length,
      skippedOffline: true,
      errors: [],
    };
  }

  broadcastEvent({ type: 'SYNC_STARTED', queuedCount: pending.length });

  let syncedCount = 0;
  let failedCount = 0;
  const errors: { id: string; label: string; error: string }[] = [];

  for (const action of pending) {
    const syncingRecord: OfflineQueuedAction = {
      ...action,
      status: 'syncing',
      attempts: action.attempts + 1,
      lastAttemptAt: new Date().toISOString(),
    };
    await updateQueuedAction(syncingRecord);

    try {
      const dynamicAuthHeaders = replayAuthHeaderProvider ? replayAuthHeaderProvider() : {};
      const headers: Record<string, string> = {
        ...action.headers,
        ...dynamicAuthHeaders,
        'X-Requested-With': 'XMLHttpRequest',
        'x-resqflow-offline-action-id': action.id,
        'x-resqflow-offline-replay': 'true',
      };

      const resp = await fetch(action.url, {
        method: action.method,
        headers,
        credentials: 'include',
        body: action.body ?? undefined,
      });

      // If SW intercepted again because network is still down, abort flush cleanly
      if (resp.status === 202 && resp.headers.get('x-resqflow-queued') === 'true') {
        await updateQueuedAction({ ...action, status: 'pending', lastError: 'Network still unreachable' });
        break;
      }

      if (resp.ok) {
        await removeQueuedAction(action.id);
        syncedCount += 1;
        continue;
      }

      // 4xx client/RBAC/validation error -> mark failed so FIFO queue isn't permanently blocked
      if (resp.status >= 400 && resp.status < 500) {
        let errText = `HTTP ${resp.status}`;
        try {
          const j = await resp.json();
          errText = j.error || errText;
        } catch {
          // ignore
        }
        await updateQueuedAction({
          ...syncingRecord,
          status: 'failed',
          lastError: errText,
        });
        failedCount += 1;
        errors.push({ id: action.id, label: action.label, error: errText });
        continue;
      }

      // 5xx server error -> revert to pending and pause flush until next reconnect
      await updateQueuedAction({
        ...syncingRecord,
        status: 'pending',
        lastError: `Server HTTP ${resp.status} — will retry`,
      });
      break;
    } catch (err) {
      // Network failure -> restore to pending and stop flushing remaining FIFO items
      await updateQueuedAction({
        ...syncingRecord,
        status: 'pending',
        lastError: err instanceof Error ? err.message : 'Network unavailable',
      });
      break;
    }
  }

  const remaining = await getQueuedActions();
  const result: OfflineSyncResult = {
    syncedCount,
    failedCount,
    remainingCount: remaining.length,
    skippedOffline: false,
    errors,
  };

  broadcastEvent({ type: 'SYNC_COMPLETED', queuedCount: remaining.length, result });
  await notifyLocalSubscribers(result);
  return result;
}

let inFlightFlush: Promise<OfflineSyncResult> | null = null;

export async function flushOfflineQueue(bypassOfflineCheck = false): Promise<OfflineSyncResult> {
  if (inFlightFlush) return inFlightFlush;

  const run = async () => {
    const navLocks = typeof navigator !== 'undefined' ? (navigator as unknown as { locks?: LockManager }).locks : undefined;
    if (navLocks && typeof navLocks.request === 'function') {
      return navLocks.request('resqflow-offline-queue-flush', async () => executeFlushUnsafe(bypassOfflineCheck));
    }
    return executeFlushUnsafe(bypassOfflineCheck);
  };

  inFlightFlush = run().finally(() => {
    inFlightFlush = null;
  });
  return inFlightFlush;
}

// ============================================================================
// OFFLINE GET SNAPSHOT CACHE (IndexedDB read-through fallback)
// ============================================================================

export async function cacheApiRead(key: string, data: unknown): Promise<void> {
  try {
    const db = await openOfflineDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(READ_CACHE_STORE, 'readwrite');
      tx.objectStore(READ_CACHE_STORE).put({
        key,
        data,
        cachedAt: new Date().toISOString(),
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // Non-fatal
  }
}

export async function getCachedApiRead<T = unknown>(key: string): Promise<{ data: T; cachedAt: string } | null> {
  try {
    const db = await openOfflineDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(READ_CACHE_STORE, 'readonly');
      const req = tx.objectStore(READ_CACHE_STORE).get(key);
      req.onsuccess = () => resolve((req.result as { data: T; cachedAt: string }) || null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}
