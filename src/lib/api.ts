import { useCallback, useEffect, useRef, useState } from 'react';
import type { RealtimeConnectionState, SystemEvent, UserRole } from '../shared/types';
import {
  buildActionLabel,
  cacheApiRead,
  enqueueOfflineAction,
  flushOfflineQueue,
  generateOfflineActionId,
  getCachedApiRead,
  isEffectivelyOffline,
  isSimulatedOffline,
  setOfflineReplayAuthHeaderProvider,
  subscribeOfflineQueue,
  subscribeSimulatedOffline,
  type OfflineQueuedAction,
  type OfflineSyncResult,
} from './offlineQueue';

export interface ActorContext {
  uid: string;
  name: string;
  email: string;
  role: UserRole;
  orgId: string;
}

let currentActor: ActorContext | null = null;
// Strictly in-memory session token (NEVER persisted to localStorage or sessionStorage)
let inMemorySessionToken: string | null = null;

export function setApiActor(actor: ActorContext | null) {
  currentActor = actor;
}

export function getApiActor(): ActorContext | null {
  return currentActor;
}

export function setSessionToken(token: string | null) {
  inMemorySessionToken = token;
}

export function getSessionToken(): string | null {
  return inMemorySessionToken;
}

setOfflineReplayAuthHeaderProvider(() => {
  const hdrs: Record<string, string> = { 'X-Requested-With': 'XMLHttpRequest' };
  if (inMemorySessionToken) {
    hdrs.Authorization = `Bearer ${inMemorySessionToken}`;
  }
  return hdrs;
});

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function isAuthApiPath(path: string): boolean {
  return path.startsWith('/auth/') || path === '/auth';
}

function isQueueableApiPath(path: string, method: string): boolean {
  if (!MUTATING_METHODS.has(method.toUpperCase())) return false;
  if (
    isAuthApiPath(path) ||
    path.startsWith('/ai/') ||
    path.startsWith('/sync/') ||
    path.endsWith('/risk-explanation')
  ) {
    return false;
  }
  return true;
}

function buildOfflineOptimisticPayload(
  path: string,
  body: unknown,
  actionId: string,
  label: string
): Record<string, unknown> {
  const now = new Date().toISOString();
  const input = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const mode = input.mode === 'operational' ? 'operational' : 'demo';
  const actorName = currentActor?.name || 'Operator';
  const actorOrg = currentActor?.orgId || 'org-central-cmd';
  const actorUid = currentActor?.uid || 'pending-user';

  const base: Record<string, unknown> = {
    queuedOffline: true,
    offlineActionId: actionId,
    label,
    ok: true,
    message: `Queued offline (${label}). Will sync automatically once connection is restored.`,
  };

  if (path.startsWith('/incidents')) {
    base.incident = {
      id: actionId,
      title: String(input.title || 'Offline Queued Incident'),
      description: String(input.description || ''),
      type: String(input.type || 'other'),
      severity: String(input.severity || 'medium'),
      status: String(input.status || 'reported'),
      lat: Number(input.lat ?? 13.0827),
      lng: Number(input.lng ?? 80.2707),
      address: String(input.address || 'Pending sync'),
      region: String(input.region || 'Pending sync'),
      reportedAt: now,
      source: String(input.source || 'Offline Field Queue'),
      reporter: actorName,
      peopleAffected: Number(input.peopleAffected ?? 0),
      vulnerablePopulation: Number(input.vulnerablePopulation ?? 0),
      estimatedImpactAreaKm2: Number(input.estimatedImpactAreaKm2 ?? 1),
      immediateNeeds: Array.isArray(input.immediateNeeds) ? input.immediateNeeds : [],
      evidenceUrls: [],
      verificationStatus: 'unverified',
      riskScore: null,
      priorityScore: null,
      assignedOrgId: actorOrg,
      assignedTeam: String(input.assignedTeam || 'Pending Sync'),
      mode,
      ownerId: actorUid,
      notes: [],
      history: [],
      createdAt: now,
      updatedAt: now,
    };
    base.possibleDuplicates = [];
  } else if (path.startsWith('/relief-requests')) {
    base.request = {
      id: actionId,
      ...input,
      status: 'submitted',
      priorityScore: 0,
      priorityCategory: String(input.urgency || 'medium'),
      mode,
      createdAt: now,
      updatedAt: now,
    };
  } else if (path.startsWith('/warehouses')) {
    base.warehouse = {
      id: actionId,
      ...input,
      orgId: actorOrg,
      usedUnits: 0,
      mode,
      lastVerified: now,
      updatedAt: now,
    };
  } else if (path.startsWith('/inventory/movements')) {
    base.movement = { id: actionId, ...input, createdAt: now };
    base.item = { id: String(input.stockId || actionId), updatedAt: now };
  } else if (path.startsWith('/inventory')) {
    base.item = { id: actionId, ...input, version: 1, mode, updatedAt: now };
  } else if (path.startsWith('/allocations')) {
    base.allocation = {
      id: actionId,
      ...input,
      status: 'proposed',
      items: [],
      requiresApproval: true,
      mode,
      createdAt: now,
      updatedAt: now,
    };
  } else if (path.startsWith('/vehicles')) {
    base.vehicle = { id: actionId, ...input, status: 'available', mode, updatedAt: now };
  } else if (path.startsWith('/dispatches')) {
    base.dispatch = { id: actionId, ...input, status: 'dispatch_created', mode, createdAt: now, updatedAt: now };
  }

  return base;
}

export class ApiError extends Error {
  status: number;
  code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

function notifySessionExpired(path: string, status: number) {
  if (status === 401 && !isAuthApiPath(path) && typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('resqflow-session-expired', { detail: { path } }));
  }
}

export async function apiRequest<T = any>(
  path: string,
  options: { method?: string; body?: unknown } = {}
): Promise<T> {
  const method = (options.method || 'GET').toUpperCase();
  const fullUrl = `/api/v1${path}`;
  const serializedBody = options.body !== undefined ? JSON.stringify(options.body) : null;
  const authPath = isAuthApiPath(path);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Requested-With': 'XMLHttpRequest',
  };
  if (inMemorySessionToken) {
    headers.Authorization = `Bearer ${inMemorySessionToken}`;
  }

  // 1. GET requests: IndexedDB read-through cache when offline or unreachable (never cache /auth/*)
  if (method === 'GET') {
    if (!authPath && isEffectivelyOffline()) {
      const cached = await getCachedApiRead<T>(fullUrl);
      if (cached) return cached.data;
      throw new ApiError('Offline Mode: no cached snapshot available for this view yet.', 0, 'OFFLINE');
    }

    const timeoutMs = path.startsWith('/ai/') ? 45_000 : 15_000;
    const controller = new AbortController();
    const timer = typeof window !== 'undefined' ? window.setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
      const resp = await fetch(fullUrl, {
        method,
        headers,
        credentials: 'include',
        signal: controller.signal,
      });
      if (timer) window.clearTimeout(timer);
      const contentType = resp.headers.get('content-type') || '';
      if (!resp.ok) {
        let errMsg = `HTTP ${resp.status}`;
        let errCode: string | undefined;
        try {
          if (contentType.includes('application/json')) {
            const json = await resp.json();
            errMsg = json.error || errMsg;
            errCode = json.code;
          } else {
            errMsg = (await resp.text()) || errMsg;
          }
        } catch {
          // keep default errMsg
        }
        notifySessionExpired(path, resp.status);
        throw new ApiError(errMsg, resp.status, errCode);
      }

      if (contentType.includes('application/json')) {
        const data = (await resp.json()) as T & { gmpQuotaExceeded?: boolean };
        if (typeof window !== 'undefined' && data?.gmpQuotaExceeded === true) {
          window.__gmpQuotaExceeded = true;
          window.dispatchEvent(new CustomEvent('gmp-quota-exceeded'));
        }
        if (!authPath) {
          void cacheApiRead(fullUrl, data);
        }
        return data;
      }
      const textBody = await resp.text();
      if (contentType.includes('text/html') || /^\s*<!doctype\s+html/i.test(textBody) || /^\s*<html/i.test(textBody)) {
        throw new ApiError(
          'API returned HTML instead of JSON. Check that the backend server and /api routes are running.',
          502,
          'INVALID_API_RESPONSE'
        );
      }
      return textBody as unknown as T;
    } catch (err) {
      if (timer) window.clearTimeout(timer);
      if (err instanceof ApiError) throw err;
      if (!authPath) {
        const cached = await getCachedApiRead<T>(fullUrl);
        if (cached) return cached.data;
      }
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw new ApiError('Request timed out. The server took too long to respond.', 504, 'TIMEOUT');
      }
      throw err;
    }
  }

  // 2. Mutating requests: Persistent Offline Queue + Idempotency ID (never queue /auth/*)
  const queueable = isQueueableApiPath(path, method);
  let actionId = '';
  if (queueable) {
    actionId = generateOfflineActionId();
    headers['x-resqflow-offline-action-id'] = actionId;
  }

  const queueMutationLocally = async (): Promise<T> => {
    const label = buildActionLabel(method, fullUrl, serializedBody);
    const bodyObj = (options.body && typeof options.body === 'object' ? options.body : {}) as Record<string, unknown>;
    const mode = bodyObj.mode === 'operational' ? 'operational' : 'demo';

    // Strip Authorization token before saving to IndexedDB so secrets are never persisted at rest
    const safeStoredHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
      'x-resqflow-offline-action-id': actionId || generateOfflineActionId(),
    };

    await enqueueOfflineAction({
      id: safeStoredHeaders['x-resqflow-offline-action-id'],
      url: fullUrl,
      method,
      headers: safeStoredHeaders,
      body: serializedBody,
      label,
      mode,
    });

    return buildOfflineOptimisticPayload(path, options.body, safeStoredHeaders['x-resqflow-offline-action-id'], label) as T;
  };

  if (queueable && isEffectivelyOffline()) {
    return queueMutationLocally();
  }

  if (!queueable && isEffectivelyOffline()) {
    throw new ApiError(
      authPath
        ? 'An active internet connection is required to sign in or manage your account.'
        : 'This live AI action requires an active network connection.',
      0,
      'OFFLINE'
    );
  }

  const mutTimeoutMs = path.startsWith('/ai/') ? 60_000 : 20_000;
  const mutController = new AbortController();
  const mutTimer = typeof window !== 'undefined' ? window.setTimeout(() => mutController.abort(), mutTimeoutMs) : null;
  try {
    const resp = await fetch(fullUrl, {
      method,
      headers,
      credentials: 'include',
      body: serializedBody ?? undefined,
      signal: mutController.signal,
    });
    if (mutTimer) window.clearTimeout(mutTimer);

    // If intercepted and persisted by Service Worker while offline
    if (queueable && resp.status === 202 && resp.headers.get('x-resqflow-queued') === 'true') {
      const swJson = await resp.json().catch(() => ({}));
      const label = swJson.label || buildActionLabel(method, fullUrl, serializedBody);
      return buildOfflineOptimisticPayload(path, options.body, swJson.offlineActionId || actionId, label) as T;
    }

    const contentType = resp.headers.get('content-type') || '';
    if (!resp.ok) {
      let errMsg = `HTTP ${resp.status}`;
      let errCode: string | undefined;
      try {
        if (contentType.includes('application/json')) {
          const json = await resp.json();
          errMsg = json.error || errMsg;
          errCode = json.code;
        } else {
          errMsg = (await resp.text()) || errMsg;
        }
      } catch {
        // keep default errMsg
      }
      notifySessionExpired(path, resp.status);
      throw new ApiError(errMsg, resp.status, errCode);
    }

    if (contentType.includes('application/json')) {
      const json = (await resp.json()) as any;
      if (
        typeof window !== 'undefined' &&
        (json?.gmpQuotaExceeded === true || json?.route?.gmpQuotaExceeded === true)
      ) {
        window.__gmpQuotaExceeded = true;
        window.dispatchEvent(new CustomEvent('gmp-quota-exceeded'));
      }
      return json as T;
    }
    const textBody = await resp.text();
    if (contentType.includes('text/html') || /^\s*<!doctype\s+html/i.test(textBody) || /^\s*<html/i.test(textBody)) {
      throw new ApiError(
        'API returned HTML instead of JSON. Check that the backend server and /api routes are running.',
        502,
        'INVALID_API_RESPONSE'
      );
    }
    return textBody as unknown as T;
  } catch (err) {
    if (mutTimer) window.clearTimeout(mutTimer);
    if (err instanceof ApiError) throw err;
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new ApiError('Operation timed out. Please check your connection and try again.', 504, 'TIMEOUT');
    }
    // Only fall back to persistent offline queue on transport/network failure (TypeError)
    if (queueable && err instanceof TypeError) {
      return queueMutationLocally();
    }
    throw err;
  }
}

export function useOfflineSync(
  onSynced?: (result: OfflineSyncResult) => void,
  connectionState?: RealtimeConnectionState,
  enabled = true
) {
  const [queuedActions, setQueuedActions] = useState<OfflineQueuedAction[]>([]);
  const [isSyncing, setIsSyncing] = useState(false);
  const [lastSyncResult, setLastSyncResult] = useState<OfflineSyncResult | null>(null);
  const [browserOnline, setBrowserOnline] = useState<boolean>(
    typeof navigator !== 'undefined' ? navigator.onLine : true
  );
  const [simulatedOffline, setSimOffline] = useState<boolean>(() => isSimulatedOffline());

  const onSyncedRef = useRef(onSynced);
  onSyncedRef.current = onSynced;
  const prevSimOfflineRef = useRef<boolean>(simulatedOffline);

  const triggerSync = useCallback(async (force = false) => {
    if (!enabled) return null;
    if (!force && isEffectivelyOffline()) return null;
    setIsSyncing(true);
    try {
      const result = await flushOfflineQueue(force);
      if (result.syncedCount > 0 || result.failedCount > 0) {
        setLastSyncResult(result);
        onSyncedRef.current?.(result);
      }
      return result;
    } finally {
      setIsSyncing(false);
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;

    const unsubQueue = subscribeOfflineQueue((actions, result) => {
      setQueuedActions(actions);
      if (result && (result.syncedCount > 0 || result.failedCount > 0)) {
        setLastSyncResult(result);
      }
    });

    const unsubSim = subscribeSimulatedOffline((sim) => {
      const wasOffline = prevSimOfflineRef.current;
      prevSimOfflineRef.current = sim;
      setSimOffline(sim);
      if (wasOffline && !sim && navigator.onLine) {
        void triggerSync();
      }
    });

    const handleOnline = () => {
      setBrowserOnline(true);
      if (!isSimulatedOffline()) {
        try {
          navigator.serviceWorker?.controller?.postMessage({ type: 'FLUSH_OFFLINE_QUEUE' });
        } catch {
          // ignore
        }
        void triggerSync();
      }
    };

    const handleOffline = () => {
      setBrowserOnline(false);
    };

    const handleSwMessage = (event: MessageEvent) => {
      if (event.data?.type === 'OFFLINE_SYNC_COMPLETE' && event.data?.result) {
        const res = event.data.result as OfflineSyncResult;
        if (res.syncedCount > 0 || res.failedCount > 0) {
          setLastSyncResult(res);
          onSyncedRef.current?.(res);
        }
      }
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    navigator.serviceWorker?.addEventListener('message', handleSwMessage);

    if (!isEffectivelyOffline()) {
      void triggerSync();
    }

    return () => {
      unsubQueue();
      unsubSim();
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      navigator.serviceWorker?.removeEventListener('message', handleSwMessage);
    };
  }, [enabled, triggerSync]);

  useEffect(() => {
    if (
      enabled &&
      connectionState === 'LIVE' &&
      !isEffectivelyOffline() &&
      queuedActions.some((a) => a.status === 'pending')
    ) {
      void triggerSync();
    }
  }, [enabled, connectionState, queuedActions, triggerSync]);

  return {
    queuedActions,
    isSyncing,
    lastSyncResult,
    browserOnline,
    simulatedOffline,
    isOffline: !browserOnline || simulatedOffline,
    triggerSync,
    clearLastSyncResult: () => setLastSyncResult(null),
  };
}

export function useRealtimeEvents(onEvent: (event: SystemEvent) => void, enabled = true) {
  const [connectionState, setConnectionState] = useState<RealtimeConnectionState>(
    enabled ? 'CONNECTING' : 'OFFLINE'
  );
  const [connectedClients, setConnectedClients] = useState<number>(1);
  const [recentEvents, setRecentEvents] = useState<SystemEvent[]>([]);
  const lastEventIdRef = useRef<string | null>(null);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  useEffect(() => {
    if (!enabled) {
      setConnectionState('OFFLINE');
      return;
    }

    let active = true;
    let ws: WebSocket | null = null;
    let reconnectAttempt = 0;
    let reconnectTimer: number | null = null;
    let pingTimer: number | null = null;

    const cleanupSocket = () => {
      if (reconnectTimer) {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (pingTimer) {
        window.clearInterval(pingTimer);
        pingTimer = null;
      }
      if (ws) {
        try {
          ws.onclose = null;
          ws.onerror = null;
          ws.close();
        } catch {
          // ignore
        }
        ws = null;
      }
    };

    const connect = () => {
      if (!active) return;
      if (isEffectivelyOffline()) {
        cleanupSocket();
        setConnectionState('OFFLINE');
        return;
      }
      setConnectionState(reconnectAttempt > 0 ? 'RECONNECTING' : 'CONNECTING');

      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const params = new URLSearchParams();
      if (lastEventIdRef.current) {
        params.set('sinceEventId', lastEventIdRef.current);
      }
      if (inMemorySessionToken) {
        params.set('sessionToken', inMemorySessionToken);
      }
      const queryStr = params.toString() ? `?${params.toString()}` : '';
      const url = `${proto}//${window.location.host}/ws/events${queryStr}`;

      try {
        ws = new WebSocket(url);
      } catch {
        setConnectionState('DEGRADED');
        return;
      }

      ws.onopen = () => {
        if (!active) return;
        reconnectAttempt = 0;
        setConnectionState('LIVE');
        pingTimer = window.setInterval(() => {
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'ping' }));
          }
        }, 25000);
      };

      ws.onmessage = (evt) => {
        if (!active) return;
        try {
          const msg = JSON.parse(evt.data);
          if (msg.type === 'connection.ack') {
            setConnectionState('LIVE');
            if (typeof msg.connectedClients === 'number') setConnectedClients(msg.connectedClients);
            if (Array.isArray(msg.reconciledEvents) && msg.reconciledEvents.length > 0) {
              const incoming: SystemEvent[] = msg.reconciledEvents;
              lastEventIdRef.current = incoming[0].event_id;
              setRecentEvents((prev) => {
                const seen = new Set(prev.map((e) => e.event_id));
                const merged = [...incoming.filter((e) => !seen.has(e.event_id)), ...prev];
                return merged.slice(0, 50);
              });
            }
          } else if (msg.type === 'event' && msg.event) {
            const ev: SystemEvent = msg.event;
            lastEventIdRef.current = ev.event_id;
            setRecentEvents((prev) => [ev, ...prev.filter((p) => p.event_id !== ev.event_id)].slice(0, 50));
            onEventRef.current(ev);
          }
        } catch {
          // ignore malformed frames
        }
      };

      ws.onclose = () => {
        if (pingTimer) window.clearInterval(pingTimer);
        if (!active) return;
        if (isEffectivelyOffline()) {
          setConnectionState('OFFLINE');
          return;
        }
        reconnectAttempt += 1;
        setConnectionState(reconnectAttempt > 4 ? 'DEGRADED' : 'RECONNECTING');
        const baseDelay = Math.min(15000, 1000 * Math.pow(1.8, Math.min(reconnectAttempt, 5)));
        const jitter = Math.floor(Math.random() * 600);
        reconnectTimer = window.setTimeout(connect, baseDelay + jitter);
      };

      ws.onerror = () => {
        if (!active) return;
        if (!isEffectivelyOffline()) {
          setConnectionState('DEGRADED');
        }
      };
    };

    const handleOnline = () => {
      if (!isSimulatedOffline()) {
        reconnectAttempt = 0;
        connect();
      }
    };
    const handleOffline = () => {
      cleanupSocket();
      setConnectionState('OFFLINE');
    };

    const unsubSim = subscribeSimulatedOffline((sim) => {
      if (sim) {
        cleanupSocket();
        setConnectionState('OFFLINE');
      } else if (navigator.onLine) {
        reconnectAttempt = 0;
        connect();
      }
    });

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    connect();

    return () => {
      active = false;
      unsubSim();
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      cleanupSocket();
    };
  }, [enabled]);

  return { connectionState, connectedClients, recentEvents };
}
