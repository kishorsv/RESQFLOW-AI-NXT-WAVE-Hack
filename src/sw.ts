/// <reference lib="webworker" />
import { CacheableResponsePlugin } from 'workbox-cacheable-response';
import { ExpirationPlugin } from 'workbox-expiration';
import { cleanupOutdatedCaches, precacheAndRoute } from 'workbox-precaching';
import { registerRoute } from 'workbox-routing';
import { CacheFirst, NetworkFirst } from 'workbox-strategies';
import {
  buildActionLabel,
  enqueueOfflineAction,
  flushOfflineQueue,
  generateOfflineActionId,
  OFFLINE_SYNC_TAG,
} from './lib/offlineQueue';

declare let self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<{ url: string; revision: string | null } | string>;
};

let swSimulatedOffline = false;

cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST || []);

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// Cache Google Fonts stylesheets & font files
registerRoute(
  ({ url }) => url.origin === 'https://fonts.googleapis.com' || url.origin === 'https://fonts.gstatic.com',
  new CacheFirst({
    cacheName: 'resqflow-google-fonts',
    plugins: [
      new CacheableResponsePlugin({ statuses: [0, 200] }),
      new ExpirationPlugin({ maxEntries: 20, maxAgeSeconds: 60 * 60 * 24 * 365 }),
    ],
  })
);

// Cache GET /api/v1/* operational reads with NetworkFirst fallback (never cache /api/v1/auth/* or /__/auth/*)
registerRoute(
  ({ url, request }) =>
    request.method === 'GET' &&
    url.origin === self.location.origin &&
    url.pathname.startsWith('/api/v1/') &&
    !url.pathname.startsWith('/api/v1/auth/') &&
    !url.pathname.startsWith('/api/v1/analytics/export') &&
    !url.pathname.startsWith('/__/'),
  new NetworkFirst({
    cacheName: 'resqflow-api-reads',
    networkTimeoutSeconds: 4,
    plugins: [
      new CacheableResponsePlugin({ statuses: [0, 200] }),
      new ExpirationPlugin({ maxEntries: 60, maxAgeSeconds: 60 * 60 * 24 }),
    ],
  })
);

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function isQueueableMutation(url: URL, method: string): boolean {
  if (!MUTATING_METHODS.has(method.toUpperCase())) return false;
  if (url.origin !== self.location.origin) return false;
  if (!url.pathname.startsWith('/api/v1/')) return false;
  // Never queue authentication, live AI inference, or sync calls
  if (url.pathname.startsWith('/api/v1/auth/')) return false;
  if (url.pathname.startsWith('/api/v1/ai/')) return false;
  if (url.pathname.startsWith('/api/v1/sync/')) return false;
  return true;
}

async function queueRequestFromFetch(request: Request): Promise<Response> {
  const cloned = request.clone();
  const bodyText = await cloned.text().catch(() => null);
  const headersObj: Record<string, string> = {};
  cloned.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (
      lower === 'content-type' ||
      lower.startsWith('x-resqflow-')
    ) {
      headersObj[key] = value;
    }
  });

  const actionId = headersObj['x-resqflow-offline-action-id'] || generateOfflineActionId();
  headersObj['x-resqflow-offline-action-id'] = actionId;

  let mode: 'demo' | 'operational' = 'demo';
  if (bodyText) {
    try {
      const parsed = JSON.parse(bodyText);
      if (parsed?.mode === 'operational') mode = 'operational';
    } catch {
      // keep default
    }
  }

  const label = buildActionLabel(request.method, request.url, bodyText);
  await enqueueOfflineAction({
    id: actionId,
    url: request.url,
    method: request.method,
    headers: headersObj,
    body: bodyText || null,
    label,
    mode,
  });

  // Register Background Sync on the SW registration directly
  try {
    const syncMgr = (self.registration as unknown as { sync?: { register: (tag: string) => Promise<void> } }).sync;
    if (syncMgr) {
      await syncMgr.register(OFFLINE_SYNC_TAG);
    }
  } catch {
    // Fallback to window online listener
  }

  return new Response(
    JSON.stringify({
      queuedOffline: true,
      offlineActionId: actionId,
      label,
      message: `Action persisted to offline queue (${label}) and will sync automatically once connection is restored.`,
    }),
    {
      status: 202,
      headers: {
        'Content-Type': 'application/json',
        'X-Resqflow-Queued': 'true',
      },
    }
  );
}

// Intercept mutating /api/v1/* requests to catch network failures & Offline Mode seamlessly
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (!isQueueableMutation(url, event.request.method)) {
    return;
  }

  // Never intercept an already-replaying flush request (let network errors propagate cleanly)
  if (event.request.headers.get('x-resqflow-offline-replay') === 'true') {
    return;
  }

  event.respondWith(
    (async () => {
      if (swSimulatedOffline) {
        return queueRequestFromFetch(event.request);
      }
      try {
        return await fetch(event.request.clone());
      } catch {
        return queueRequestFromFetch(event.request);
      }
    })()
  );
});

// Background Sync API listener — automatically flushes persistent IndexedDB queue on reconnect
self.addEventListener('sync', (event: Event) => {
  const syncEvent = event as ExtendableEvent & { tag?: string };
  if (syncEvent.tag === OFFLINE_SYNC_TAG) {
    syncEvent.waitUntil(
      (async () => {
        if (swSimulatedOffline) return;
        const result = await flushOfflineQueue(true);
        const clients = await self.clients.matchAll({ includeUncontrolled: true });
        for (const client of clients) {
          client.postMessage({ type: 'OFFLINE_SYNC_COMPLETE', result });
        }
      })()
    );
  }
});

// Client <-> Service Worker message bridge
self.addEventListener('message', (event) => {
  const msg = event.data;
  if (!msg || typeof msg !== 'object') return;

  if (msg.type === 'SKIP_WAITING') {
    self.skipWaiting();
  } else if (msg.type === 'SET_SIMULATED_OFFLINE') {
    swSimulatedOffline = Boolean(msg.enabled);
  } else if (msg.type === 'FLUSH_OFFLINE_QUEUE') {
    event.waitUntil(
      (async () => {
        if (swSimulatedOffline) return;
        const result = await flushOfflineQueue(true);
        const clients = await self.clients.matchAll({ includeUncontrolled: true });
        for (const client of clients) {
          client.postMessage({ type: 'OFFLINE_SYNC_COMPLETE', result });
        }
      })()
    );
  }
});
