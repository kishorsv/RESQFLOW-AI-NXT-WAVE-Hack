import 'dotenv/config';
import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { WebSocketServer } from 'ws';
import { z } from 'zod';
import type {
  AISimulationType,
  CoordinationAgentId,
  DataMode,
  Dispatch,
  DispatchStatus,
  IncomingSupplyOrder,
  Incident,
  IncidentReportRecord,
  IncidentStatus,
  InventoryBatch,
  InventoryCatalogItem,
  InventoryStock,
  ReliefRequest,
  StockMovement,
  Vehicle,
  Warehouse,
} from './src/shared/types.ts';
import {
  acknowledgeTriggerEvent,
  addSessionMemoryEntry,
  assertOrgAccess,
  canAccessOrg,
  cancelCoordinationSession,
  compareSimulations,
  computeAICoordinationAnalytics,
  createSimulationSession,
  decidePlanApproval,
  ensureAgentRegistrySeeded,
  executeApprovedPlan,
  getAgentRegistry,
  getAgentStatusSummary,
  getSessionMemoryEntries,
  initProactiveTriggerEngine,
  modifyPlanActions,
  rerunSingleAgentTask,
  resolveConflictByHuman,
  runIsolatedSimulation,
  startCoordinationSession,
  validatePlanNow,
} from './server/coordinationEngine.ts';
import {
  analyzeCoordinates,
  calculateIncidentWeatherRisk,
  calculatePriority,
  computeFreshness,
  computeOperationalPredictions,
  detectDetailedDuplicates,
  fetchLiveWeather,
  findNearestWarehouses,
  generateAllocationRecommendation,
  geocodeAddressServer,
  getWeatherProviderStatus,
  haversineKm,
  isValidIncidentTransition,
  levelToSeverity,
  optimizeRoute,
  reverseGeocodeServer,
  severityToLevel,
  validateCoordinates,
} from './server/engines.ts';
import { eventBus } from './server/events.ts';
import {
  analyzeMedia,
  attachLiveVoiceBridge,
  generateLogisticsAdvisory,
  generateMusic,
  generateOrAnimateVideo,
  generateOrEditImage,
  generateRiskExplanation,
  generateSpeech,
  runCommandChat,
  runStructuredAgent,
  transcribeAudio,
} from './server/gemini.ts';
import {
  getReassessmentStats,
  reassessIncidentNow,
  scheduleAutomaticReassessment,
} from './server/intelligence.ts';
import {
  classifyStockLevel,
  commitAtomicStockMovement,
  computeDemandSupplyIntelligence,
  computeInventoryAnalyticsOverview,
  computeInventoryMovementAnalytics,
  computeInventoryWarehouseAnalytics,
  computeShortagesAndReplenishment,
  confirmStockReservation,
  createStockReservation,
  evaluateInventoryExpiry,
  evaluateStockAlerts,
  executeWarehouseTransfer,
  expireStaleReservations,
  getCriticalThreshold,
  InventoryEngineError,
  mapCategoryToGroup,
  matchWarehousesForRequest,
  receiveIncomingSupply,
  releaseStockReservation,
  syncWarehouseOccupancy,
  verifyIncomingSupply,
  withStockLock,
} from './server/inventoryEngine.ts';
import {
  approveDispatchWorkflow,
  assignDriverToVehicle,
  cancelDispatchWorkflow,
  computeAllocationPriority,
  computeDeliveryPerformance,
  computeLogisticsOverview,
  confirmDeliveryWorkflow,
  createDriverRecord,
  createPendingDispatch,
  createVehicleRecord,
  editAllocationProposal,
  evaluateRouteRisk,
  getDispatchTrackingSnapshot,
  LogisticsError,
  optimizeMultiWarehouseAllocation,
  optimizeRouteWithAlternatives,
  planDispatch,
  recordDispatchGpsUpdate,
  rejectDispatchWorkflow,
  reportRouteHazard,
  sanitizeDriverForRole,
  sanitizeVehicleForRole,
  transitionDispatchStage,
  updateDriverRecord,
  updateVehicleRecord,
  updateVehicleStatus,
  verifyDeliveryConfirmation,
} from './server/logisticsEngine.ts';
import {
  createAuthRouter,
  getFirebaseProjectId,
  getPublicFirebaseWebConfig,
  resolveSessionFromRawUpgrade,
  verifyCsrfForCookieAuth,
} from './server/auth.ts';
import {
  attachActor,
  AuthedRequest,
  getOverloadStats,
  overloadGuard,
  rateLimit,
  requireAuth,
  requirePermission,
} from './server/rbac.ts';
import { store } from './server/store.ts';

const PORT = Number(process.env.PORT || 3000);
const isProduction = process.env.NODE_ENV === 'production';
const bootTime = Date.now();

function parseMode(raw: unknown): DataMode {
  return raw === 'operational' ? 'operational' : 'demo';
}

function getParam(val: string | string[] | undefined): string {
  return Array.isArray(val) ? val[0] : val || '';
}

function csvEscape(val: unknown): string {
  const s = String(val ?? '');
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

// Lightweight sliding-window API telemetry (bounded ring buffer, zero external overhead)
const LATENCY_RING_SIZE = 300;
const apiLatenciesMs: number[] = [];
let totalApiRequests = 0;
let totalApi5xx = 0;
let totalApi4xx = 0;
let isShuttingDown = false;

function recordApiTelemetry(durationMs: number, statusCode: number) {
  totalApiRequests += 1;
  if (statusCode >= 500) totalApi5xx += 1;
  else if (statusCode >= 400) totalApi4xx += 1;
  apiLatenciesMs.push(durationMs);
  if (apiLatenciesMs.length > LATENCY_RING_SIZE) {
    apiLatenciesMs.shift();
  }
}

function computeApiLatencyPercentiles() {
  if (apiLatenciesMs.length === 0) return { p50Ms: 0, p95Ms: 0, p99Ms: 0, samples: 0 };
  const sorted = [...apiLatenciesMs].sort((a, b) => a - b);
  const at = (p: number) => Math.round(sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] * 10) / 10;
  return { p50Ms: at(50), p95Ms: at(95), p99Ms: at(99), samples: sorted.length };
}

// Defensive HTTP security headers (iframe-compatible for AI Studio preview; never sets X-Frame-Options: DENY)
app.use((req, res, next) => {
  const reqId = String(req.header('x-request-id') || '').slice(0, 64) || uuidv4();
  res.setHeader('X-Request-Id', reqId);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(self), geolocation=(self)');
  res.setHeader('X-DNS-Prefetch-Control', 'off');
  if (req.secure || req.header('x-forwarded-proto') === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

// Same-origin Firebase Auth redirect handler proxy (Firebase Redirect Best Practices Option 3)
// Transparently forwards ONLY /__/auth/* to this project's firebaseapp.com host and serves /__/firebase/init.json directly.
function readRawRequestBody(req: express.Request): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const MAX_BYTES = 1024 * 1024; // 1MB cap for OAuth callback payloads
    req.on('data', (chunk: Buffer | string) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.length;
      if (total > MAX_BYTES) {
        reject(new Error('Payload too large'));
        return;
      }
      chunks.push(buf);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const firebaseAuthProxyHandler: express.RequestHandler = async (req, res) => {
  const projectId = getFirebaseProjectId();
  if (!projectId || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId)) {
    return res.status(503).send('Firebase project ID is not configured.');
  }
  const targetHost = `${projectId}.firebaseapp.com`;
  const targetUrl = `https://${targetHost}${req.originalUrl}`;
  const method = req.method.toUpperCase();

  try {
    const forwardHeaders: Record<string, string> = {
      accept: String(req.header('accept') || '*/*'),
      'user-agent': String(req.header('user-agent') || 'resqflow-auth-proxy'),
    };
    const acceptLang = req.header('accept-language');
    if (acceptLang) forwardHeaders['accept-language'] = String(acceptLang);
    const cookieHdr = req.header('cookie');
    if (cookieHdr) forwardHeaders.cookie = String(cookieHdr);
    const contentType = req.header('content-type');
    if (contentType) forwardHeaders['content-type'] = String(contentType);

    let body: ArrayBuffer | undefined;
    if (method !== 'GET' && method !== 'HEAD') {
      const rawBuf = await readRawRequestBody(req);
      if (rawBuf.length > 0) {
        body = rawBuf.buffer.slice(rawBuf.byteOffset, rawBuf.byteOffset + rawBuf.byteLength) as ArrayBuffer;
      }
    }

    const upstream = await fetch(targetUrl, {
      method,
      redirect: 'manual',
      headers: forwardHeaders,
      body,
    });

    res.status(upstream.status);
    const setCookies =
      typeof (upstream.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie === 'function'
        ? (upstream.headers as Headers & { getSetCookie: () => string[] }).getSetCookie()
        : [];
    if (setCookies.length > 0) {
      res.setHeader('Set-Cookie', setCookies);
    }

    upstream.headers.forEach((value, key) => {
      const lower = key.toLowerCase();
      if (
        lower === 'content-encoding' ||
        lower === 'transfer-encoding' ||
        lower === 'content-length' ||
        lower === 'connection' ||
        lower === 'set-cookie'
      ) {
        return;
      }
      res.setHeader(key, value);
    });

    const buf = Buffer.from(await upstream.arrayBuffer());
    return res.send(buf);
  } catch {
    return res.status(502).send('Unable to reach Firebase authentication handler.');
  }
};

app.all('/__/auth/*', firebaseAuthProxyHandler);

app.get(['/__/firebase/init.json', '/api/firebase-init'], (req, res) => {
  const fwdHost = String(req.header('x-forwarded-host') || req.header('host') || '')
    .split(',')[0]
    .trim();
  const cfg = getPublicFirebaseWebConfig(fwdHost);
  if (!cfg) {
    return res.status(503).json({ error: 'Firebase configuration is unavailable.' });
  }
  res.setHeader('Cache-Control', 'public, max-age=300');
  return res.status(200).json(cfg);
});

// Scoped JSON body size limits: 50MB only for AI media/audio/video/image routes; 2MB everywhere else
const largeMediaJsonParser = express.json({ limit: '50mb' });
const standardJsonParser = express.json({ limit: '2mb' });
app.use((req, res, next) => {
  if (
    req.path.startsWith('/api/v1/ai/media') ||
    req.path.startsWith('/api/v1/ai/audio') ||
    req.path.startsWith('/api/v1/ai/video') ||
    req.path.startsWith('/api/v1/ai/image')
  ) {
    return largeMediaJsonParser(req, res, next);
  }
  return standardJsonParser(req, res, next);
});

const api = express.Router();

// API telemetry, actor attachment, priority overload protection, and bounded rate limiting
// Mounted strictly on /api/v1 so static frontend assets and homepage chunks are never throttled
api.use((req, res, next) => {
  const started = performance.now();
  res.on('finish', () => {
    const durationMs = Math.round((performance.now() - started) * 10) / 10;
    recordApiTelemetry(durationMs, res.statusCode);
    if (res.statusCode >= 500 || durationMs > 1000) {
      console.warn(
        JSON.stringify({
          ts: new Date().toISOString(),
          level: res.statusCode >= 500 ? 'error' : 'warn',
          service: 'resqflow-api',
          requestId: res.getHeader('X-Request-Id'),
          method: req.method,
          route: req.path,
          status: res.statusCode,
          durationMs,
        })
      );
    }
  });
  next();
});
api.use(attachActor);
api.use(overloadGuard);
api.use(rateLimit(600));

// ============================================================================
// 0A. PUBLIC AUTHENTICATION & LIVENESS/READINESS ROUTES
// ============================================================================

api.use('/auth', createAuthRouter());

function computeOverallHealthState(): 'HEALTHY' | 'DEGRADED' | 'UNAVAILABLE' {
  if (isShuttingDown) return 'UNAVAILABLE';
  const persist = store.getPersistenceStats();
  if (persist.flushErrors > 3) return 'DEGRADED';
  const degradedIntegrations = store.state.integrations.filter((i) => i.status === 'degraded');
  if (degradedIntegrations.length > 0) return 'DEGRADED';
  return 'HEALTHY';
}

api.get('/health/live', (_req, res) => {
  res.status(isShuttingDown ? 503 : 200).json({
    status: isShuttingDown ? 'UNAVAILABLE' : 'HEALTHY',
    uptimeSec: Math.round((Date.now() - bootTime) / 1000),
    timestamp: new Date().toISOString(),
  });
});

api.get('/health/ready', (_req, res) => {
  const healthState = computeOverallHealthState();
  const ready = healthState !== 'UNAVAILABLE';
  res.status(ready ? 200 : 503).json({
    ready,
    healthState,
    uptimeSec: Math.round((Date.now() - bootTime) / 1000),
    timestamp: new Date().toISOString(),
  });
});

api.get('/health', (_req, res) => {
  const healthState = computeOverallHealthState();
  res.status(healthState === 'UNAVAILABLE' ? 503 : 200).json({
    status: healthState === 'UNAVAILABLE' ? 'unavailable' : 'ok',
    healthState,
    service: 'resqflow-ai',
    uptimeSec: Math.round((Date.now() - bootTime) / 1000),
    timestamp: new Date().toISOString(),
    databaseBackend: 'Firebase Firestore + Server Persistent Store',
    geminiConfigured: Boolean(process.env.GEMINI_API_KEY),
    googleMapsConfigured: Boolean(process.env.GOOGLE_MAPS_API_KEY || process.env.VITE_GOOGLE_MAPS_API_KEY),
    googleMapsServerKeyConfigured: Boolean(process.env.GOOGLE_MAPS_API_KEY),
    googleMapsBrowserKeyConfigured: Boolean(process.env.VITE_GOOGLE_MAPS_API_KEY),
  });
});

// Require verified session + CSRF check for all operational API routes below
api.use(requireAuth);
api.use(verifyCsrfForCookieAuth);

// ============================================================================
// 0. OFFLINE QUEUE IDEMPOTENCY & REPLAY MIDDLEWARE
// ============================================================================

const IDEMPOTENT_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

api.use((req: AuthedRequest, res, next) => {
  if (!IDEMPOTENT_METHODS.has(req.method.toUpperCase())) {
    return next();
  }
  if (req.path.startsWith('/ai/') || req.path.startsWith('/sync/')) {
    return next();
  }

  const actionIdRaw = req.header('x-resqflow-offline-action-id');
  const actionId = actionIdRaw ? actionIdRaw.trim() : '';
  if (!actionId) {
    return next();
  }

  const existing = store.getOfflineIdempotency(actionId);
  if (existing) {
    res.setHeader('X-Resqflow-Idempotent-Replay', 'true');
    return res.status(existing.status).json(existing.body);
  }

  const isOfflineReplay = req.header('x-resqflow-offline-replay') === 'true';
  const origJson = res.json.bind(res);

  res.json = ((body: unknown) => {
    const statusCode = res.statusCode || 200;
    if (statusCode >= 200 && statusCode < 300) {
      store.recordOfflineIdempotency({
        actionId,
        method: req.method.toUpperCase(),
        path: req.path,
        status: statusCode,
        body,
        processedAt: new Date().toISOString(),
        replayedFromOffline: isOfflineReplay,
      });

      if (isOfflineReplay && req.actor) {
        const mode: DataMode = req.body?.mode === 'operational' ? 'operational' : 'demo';
        store.addAudit({
          actor: req.actor.name,
          role: req.actor.role,
          orgId: req.actor.orgId,
          action: 'offline.action_synced',
          entityType: 'offline_sync',
          entityId: actionId,
          summary: `Synced queued offline action ${req.method.toUpperCase()} ${req.path}`,
          mode,
        });
      }
    }
    return origJson(body);
  }) as typeof res.json;

  return next();
});

api.get('/sync/status', (_req, res) => {
  const records = Object.values(store.state.offlineIdempotency).sort((a, b) =>
    b.processedAt.localeCompare(a.processedAt)
  );
  res.json({
    status: 'ready',
    totalIdempotentActions: records.length,
    offlineReplayedCount: records.filter((r) => r.replayedFromOffline).length,
    recentActions: records.slice(0, 20).map((r) => ({
      actionId: r.actionId,
      method: r.method,
      path: r.path,
      status: r.status,
      processedAt: r.processedAt,
      replayedFromOffline: r.replayedFromOffline,
    })),
    timestamp: new Date().toISOString(),
  });
});

// ============================================================================
// 1. OBSERVABILITY ENDPOINTS (Authenticated; /health mounted publicly above)
// ============================================================================

api.get('/health/database', (_req, res) => {
  res.json({
    status: 'healthy',
    engine: 'Firebase Firestore (Enterprise) + Server Persistent Store',
    counts: {
      organizations: store.state.organizations.length,
      incidents: store.state.incidents.length,
      reliefRequests: store.state.reliefRequests.length,
      warehouses: store.state.warehouses.length,
      inventory: store.state.inventory.length,
      allocations: store.state.allocations.length,
      dispatches: store.state.dispatches.length,
      auditLogs: store.state.auditLogs.length,
    },
    timestamp: new Date().toISOString(),
  });
});

api.get('/health/realtime', (_req, res) => {
  res.json({
    ...eventBus.getStats(),
    timestamp: new Date().toISOString(),
  });
});

api.get('/health/integrations', (_req, res) => {
  res.json({
    integrations: store.state.integrations,
    timestamp: new Date().toISOString(),
  });
});

api.get('/health/workers', (_req, res) => {
  res.json({
    status: 'active',
    workers: [
      { name: 'weather-freshness-evaluator', status: 'running', intervalSec: 300 },
      { name: 'shortage-alert-deduplicator', status: 'running', intervalSec: 60 },
      { name: 'event-outbox-dispatcher', status: 'running', mode: 'post-persistence' },
      { name: 'automatic-risk-reassessment-coordinator', status: 'running', mode: 'event-driven-debounced' },
    ],
    reassessmentCoordinator: getReassessmentStats(),
    timestamp: new Date().toISOString(),
  });
});

api.get('/health/weather', (_req, res) => {
  res.json({
    ...getWeatherProviderStatus(),
    timestamp: new Date().toISOString(),
  });
});

api.get('/health/ai', (_req, res) => {
  const health = store.state.integrations.find((i) => i.id === 'int-gemini');
  res.json({
    configured: Boolean(process.env.GEMINI_API_KEY),
    status: health?.status || (process.env.GEMINI_API_KEY ? 'healthy' : 'unconfigured'),
    defaultRiskModel: 'gemini-4-hydrogen',
    totalBriefingsGenerated: store.state.aiRiskAnalyses.length,
    totalAgentTasks: store.state.aiTasks.length,
    lastSuccessAt: health?.lastSuccessAt || null,
    lastError: health?.lastError || null,
    latencyMs: health?.latencyMs || null,
    humanReviewRequired: true,
    timestamp: new Date().toISOString(),
  });
});

api.get('/health/metrics', (_req, res) => {
  const mem = process.memoryUsage();
  res.json({
    healthState: computeOverallHealthState(),
    uptimeSec: Math.round((Date.now() - bootTime) / 1000),
    requests: {
      total: totalApiRequests,
      errors4xx: totalApi4xx,
      errors5xx: totalApi5xx,
      errorRatePct: totalApiRequests > 0 ? Math.round((totalApi5xx / totalApiRequests) * 10000) / 100 : 0,
      latency: computeApiLatencyPercentiles(),
    },
    memoryMb: {
      rss: Math.round((mem.rss / (1024 * 1024)) * 10) / 10,
      heapUsed: Math.round((mem.heapUsed / (1024 * 1024)) * 10) / 10,
      heapTotal: Math.round((mem.heapTotal / (1024 * 1024)) * 10) / 10,
    },
    overload: getOverloadStats(),
    persistence: store.getPersistenceStats(),
    realtime: eventBus.getStats(),
    timestamp: new Date().toISOString(),
  });
});

// Consolidated authenticated dashboard bootstrap endpoint (replaces 12 parallel HTTP requests on initial load/refresh)
api.get('/bootstrap', (req: AuthedRequest, res) => {
  const mode = parseMode(req.query.mode);
  const actorRole = req.actor?.role || 'field_responder';
  const incidents = store.state.incidents.filter((i) => i.mode === mode);
  const requests = store.state.reliefRequests.filter((r) => r.mode === mode);
  const warehouses = store.state.warehouses.filter((w) => w.mode === mode);
  const inventory = store.state.inventory.filter((i) => i.mode === mode);
  const movements = store.state.stockMovements.filter((m) => {
    const stock = store.state.inventory.find((s) => s.id === m.stockId);
    return !stock || stock.mode === mode;
  }).slice(0, 120);
  const allocations = store.state.allocations.filter((a) => a.mode === mode);
  const vehicles = store.state.vehicles
    .filter((v) => v.mode === mode)
    .map((v) => sanitizeVehicleForRole(v, actorRole));
  const dispatches = store.state.dispatches.filter((d) => d.mode === mode);
  const notifications = store.state.notifications.filter((n) => n.mode === mode).slice(0, 80);
  const alerts = store.state.alerts.filter((a) => a.mode === mode).slice(0, 120);
  const tasks = store.state.aiTasks.filter((t) => t.mode === mode).slice(0, 60);

  const activeIncidents = incidents.filter((i) => i.status !== 'resolved' && i.status !== 'archived').length;
  const criticalIncidents = incidents.filter(
    (i) => (i.severity === 'critical' || i.severity === 'high') && i.status !== 'resolved' && i.status !== 'archived'
  ).length;
  const pendingRequests = requests.filter((r) => r.status !== 'closed' && r.status !== 'delivered').length;
  const lowStockItems = inventory.filter((i) => i.availableQty <= i.minStock).length;
  const activeDispatches = dispatches.filter((d) => d.status !== 'delivered' && d.status !== 'cancelled').length;
  const totalPeopleAffected = incidents.reduce((sum, i) => sum + (i.peopleAffected || 0), 0);

  res.setHeader('Cache-Control', 'private, no-store');
  res.json({
    mode,
    incidents,
    requests,
    warehouses,
    inventory,
    movements,
    allocations,
    vehicles,
    dispatches,
    notifications,
    alerts,
    tasks,
    analytics: {
      mode,
      kpis: {
        activeIncidents,
        criticalIncidents,
        pendingRequests,
        lowStockItems,
        activeDispatches,
        totalPeopleAffected,
        totalWarehouses: warehouses.length,
        availableVehicles: vehicles.filter((v) => v.status === 'available').length,
      },
      generatedAt: new Date().toISOString(),
    },
    integrations: store.state.integrations,
    serverTime: new Date().toISOString(),
  });
});

// ============================================================================
// 2. INCIDENTS CRUD + LIFECYCLE WORKFLOWS
// ============================================================================

const INCIDENT_TYPE_ENUM = z.enum([
  'flood',
  'flash_flood',
  'landslide',
  'cyclone',
  'severe_storm',
  'heatwave',
  'wildfire',
  'earthquake',
  'infrastructure_failure',
  'water_shortage',
  'power_failure',
  'chemical_incident',
  'other',
]);

const IncidentCreateSchema = z.object({
  title: z.string().min(3).max(200),
  description: z.string().min(5).max(3000),
  type: INCIDENT_TYPE_ENUM,
  severity: z.enum(['low', 'medium', 'high', 'critical']).optional(),
  severityLevel: z.number().int().min(1).max(5).optional(),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  address: z.string().min(2).max(250),
  region: z.string().min(2).max(120),
  district: z.string().max(120).optional(),
  state: z.string().max(120).optional(),
  country: z.string().max(120).optional(),
  incidentStartTime: z.string().optional(),
  source: z.string().default('Command Desk'),
  sourceType: z.enum(['citizen', 'field_responder', 'agency', 'sensor', 'command_desk']).default('command_desk'),
  peopleAffected: z.number().int().min(0).default(0),
  familiesAffected: z.number().int().min(0).optional(),
  vulnerablePopulation: z.number().int().min(0).default(0),
  estimatedImpactAreaKm2: z.number().min(0).default(1),
  infrastructureAffected: z.array(z.string()).default([]),
  immediateNeeds: z.array(z.string()).default([]),
  evidenceUrls: z.array(z.string()).default([]),
  assignedTeam: z.string().default('Unassigned'),
  mode: z.enum(['operational', 'demo']).default('demo'),
});

const IncidentPatchSchema = z.object({
  title: z.string().min(3).max(200).optional(),
  description: z.string().min(5).max(3000).optional(),
  type: INCIDENT_TYPE_ENUM.optional(),
  severity: z.enum(['low', 'medium', 'high', 'critical']).optional(),
  severityLevel: z.number().int().min(1).max(5).optional(),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
  address: z.string().min(2).max(250).optional(),
  region: z.string().min(2).max(120).optional(),
  district: z.string().max(120).optional(),
  state: z.string().max(120).optional(),
  country: z.string().max(120).optional(),
  peopleAffected: z.number().int().min(0).optional(),
  familiesAffected: z.number().int().min(0).optional(),
  vulnerablePopulation: z.number().int().min(0).optional(),
  estimatedImpactAreaKm2: z.number().min(0).optional(),
  infrastructureAffected: z.array(z.string()).optional(),
  immediateNeeds: z.array(z.string()).optional(),
  assignedTeam: z.string().max(120).optional(),
  note: z.string().max(500).optional(),
});

api.get('/incidents', (req, res) => {
  const mode = parseMode(req.query.mode);
  const type = req.query.type ? String(req.query.type) : null;
  const severity = req.query.severity ? String(req.query.severity) : null;
  const status = req.query.status ? String(req.query.status) : null;
  const verificationStatus = req.query.verificationStatus ? String(req.query.verificationStatus) : null;
  const riskBand = req.query.riskBand ? String(req.query.riskBand) : null;
  const fromDate = req.query.fromDate ? String(req.query.fromDate) : null;
  const toDate = req.query.toDate ? String(req.query.toDate) : null;
  const search = req.query.q ? String(req.query.q).toLowerCase() : null;

  let list = store.state.incidents.filter((i) => i.mode === mode);
  if (type && type !== 'all') list = list.filter((i) => i.type === type);
  if (severity && severity !== 'all') list = list.filter((i) => i.severity === severity);
  if (status && status !== 'all') list = list.filter((i) => i.status === status);
  if (verificationStatus && verificationStatus !== 'all') {
    list = list.filter((i) => i.verificationStatus === verificationStatus);
  }
  if (riskBand && riskBand !== 'all') {
    list = list.filter((i) => {
      const latest = store.state.riskAssessments.find((r) => r.incidentId === i.id);
      const band = i.riskBand || (latest && latest.band !== 'Insufficient Data' ? latest.band : null);
      return band?.toLowerCase() === riskBand.toLowerCase();
    });
  }
  if (fromDate) {
    const fromMs = new Date(fromDate).getTime();
    if (!Number.isNaN(fromMs)) {
      list = list.filter((i) => new Date(i.reportedAt).getTime() >= fromMs);
    }
  }
  if (toDate) {
    const toMs = new Date(toDate).getTime();
    if (!Number.isNaN(toMs)) {
      list = list.filter((i) => new Date(i.reportedAt).getTime() <= toMs);
    }
  }
  if (search) {
    list = list.filter(
      (i) =>
        i.title.toLowerCase().includes(search) ||
        i.region.toLowerCase().includes(search) ||
        i.address.toLowerCase().includes(search) ||
        i.type.toLowerCase().includes(search)
    );
  }
  const sortBy = req.query.sort ? String(req.query.sort) : '';
  if (sortBy === 'severity') {
    const rank: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 };
    list = [...list].sort((a, b) => (rank[b.severity] || 0) - (rank[a.severity] || 0));
  } else if (sortBy === 'peopleAffected') {
    list = [...list].sort((a, b) => (b.peopleAffected || 0) - (a.peopleAffected || 0));
  } else if (sortBy === 'oldest') {
    list = [...list].sort((a, b) => a.reportedAt.localeCompare(b.reportedAt));
  }

  const total = list.length;
  const rawLimit = req.query.limit !== undefined ? Number(req.query.limit) : null;
  const rawOffset = req.query.offset !== undefined ? Number(req.query.offset) : 0;
  const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 0;
  if (rawLimit !== null && Number.isFinite(rawLimit) && rawLimit > 0) {
    const limit = Math.min(200, Math.max(1, Math.floor(rawLimit)));
    const paged = list.slice(offset, offset + limit);
    return res.json({
      incidents: paged,
      pagination: { total, limit, offset, hasMore: offset + limit < total },
    });
  }
  res.json({
    incidents: list,
    pagination: { total, limit: total, offset: 0, hasMore: false },
  });
});

api.get('/incidents/:id', (req, res) => {
  const id = getParam(req.params.id);
  const inc = store.state.incidents.find((i) => i.id === id);
  if (!inc) return res.status(404).json({ error: 'Incident not found' });

  const riskHistory = store.state.riskAssessments.filter((r) => r.incidentId === inc.id);
  const latestRisk = riskHistory[0] || null;
  const reports = store.state.incidentReports.filter((r) => r.incidentId === inc.id);
  const alerts = store.state.alerts.filter((a) => a.incidentId === inc.id);
  const aiBriefings = store.state.aiRiskAnalyses.filter((b) => b.incident_id === inc.id);
  const duplicateMatches = detectDetailedDuplicates(
    {
      id: inc.id,
      type: inc.type,
      lat: inc.lat,
      lng: inc.lng,
      title: inc.title,
      reportedAt: inc.reportedAt,
      mode: inc.mode,
    },
    store.state.incidents
  );
  const latestWeather =
    (latestRisk?.weatherObservationId
      ? store.state.weatherObservations.find((w) => w.id === latestRisk.weatherObservationId)
      : null) ||
    store.state.weatherObservations.find((w) => haversineKm(w.lat, w.lng, inc.lat, inc.lng) < 10) ||
    null;

  res.json({
    incident: inc,
    latestRisk,
    riskHistory,
    latestWeather,
    reports,
    alerts,
    aiBriefings,
    duplicateMatches,
  });
});

api.post('/incidents', requirePermission('incident:create'), (req: AuthedRequest, res) => {
  const parsed = IncidentCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid incident payload', details: parsed.error.flatten() });
  }
  const data = parsed.data;
  const coordAnalysis = analyzeCoordinates(data.lat, data.lng, data.region);
  if (!coordAnalysis.valid) {
    return res.status(400).json({ error: coordAnalysis.warnings[0] || 'Coordinates out of valid bounds.' });
  }
  if (data.vulnerablePopulation > data.peopleAffected && data.peopleAffected > 0) {
    return res.status(400).json({
      error: 'Vulnerable population cannot exceed total people affected.',
    });
  }

  const resolvedSeverity = data.severity || (data.severityLevel ? levelToSeverity(data.severityLevel) : 'medium');
  const resolvedLevel = (data.severityLevel || severityToLevel(resolvedSeverity)) as 1 | 2 | 3 | 4 | 5;

  const actor = req.actor!;
  const now = new Date().toISOString();
  const duplicateMatches = detectDetailedDuplicates(
    { type: data.type, lat: data.lat, lng: data.lng, title: data.title, reportedAt: now, mode: data.mode },
    store.state.incidents
  );
  const possibleDuplicateOf = duplicateMatches.map((m) => m.duplicateIncidentId);

  const incident: Incident = {
    id: uuidv4(),
    title: data.title,
    description: data.description,
    type: data.type,
    severity: resolvedSeverity,
    severityLevel: resolvedLevel,
    status: 'reported',
    lat: data.lat,
    lng: data.lng,
    address: data.address,
    region: data.region,
    district: data.district,
    state: data.state,
    country: data.country,
    reportedAt: now,
    incidentStartTime: data.incidentStartTime || now,
    source: data.source,
    sourceType: data.sourceType,
    reporter: actor.name,
    peopleAffected: data.peopleAffected,
    familiesAffected: data.familiesAffected,
    vulnerablePopulation: data.vulnerablePopulation,
    estimatedImpactAreaKm2: data.estimatedImpactAreaKm2,
    infrastructureAffected: data.infrastructureAffected,
    immediateNeeds: data.immediateNeeds,
    evidenceUrls: data.evidenceUrls,
    verificationStatus: 'unverified',
    riskScore: null,
    riskBand: null,
    priorityScore: null,
    assignedOrgId: actor.orgId,
    assignedTeam: data.assignedTeam,
    mode: data.mode,
    ownerId: actor.uid,
    possibleDuplicateOf: possibleDuplicateOf.length > 0 ? possibleDuplicateOf : undefined,
    duplicateMatches: duplicateMatches.length > 0 ? duplicateMatches : undefined,
    coordinateWarnings: coordAnalysis.warnings.length > 0 ? coordAnalysis.warnings : undefined,
    notes: [],
    history: [
      {
        id: uuidv4(),
        timestamp: now,
        actor: actor.name,
        role: actor.role,
        action: 'Incident reported',
        newStatus: 'reported',
      },
    ],
    createdAt: now,
    updatedAt: now,
  };

  store.state.incidents.unshift(incident);
  store.save();

  store.addAudit({
    actor: actor.name,
    role: actor.role,
    orgId: actor.orgId,
    action: 'incident.created',
    entityType: 'incident',
    entityId: incident.id,
    summary: `Reported ${incident.severity} (L${resolvedLevel}) ${incident.type} incident: ${incident.title}`,
    mode: incident.mode,
  });

  if (incident.severity === 'critical' || incident.severity === 'high') {
    store.addNotification({
      dedupKey: `${incident.mode}:inc:new:${incident.id}`,
      userId: 'all',
      orgId: actor.orgId,
      eventType: 'incident.created',
      severity: incident.severity === 'critical' ? 'critical' : 'high',
      title: `New ${incident.severity.toUpperCase()} Incident: ${incident.title}`,
      message: `${incident.peopleAffected} affected in ${incident.region}. Verification and risk assessment required.`,
      entityType: 'incident',
      entityId: incident.id,
      channel: 'in_app',
      mode: incident.mode,
    });
  }

  eventBus.publish({
    event_type: 'incident.created',
    organization_id: actor.orgId,
    entity_id: incident.id,
    source: 'incidents-api',
    mode: incident.mode,
    payload: { incident, duplicateMatches },
  });

  // Trigger automatic event-driven risk reassessment in background
  const reassessmentJob = scheduleAutomaticReassessment({
    incidentId: incident.id,
    reason: 'incident_created',
    assessmentSource: 'incident_creation',
    actorName: actor.name,
    actorRole: actor.role,
    orgId: actor.orgId,
  });

  res.status(201).json({
    incident,
    possibleDuplicates: possibleDuplicateOf,
    duplicateMatches,
    coordinateWarnings: coordAnalysis.warnings,
    reassessmentJob,
  });
});

api.patch('/incidents/:id', requirePermission('incident:manage'), (req: AuthedRequest, res) => {
  const id = getParam(req.params.id);
  const inc = store.state.incidents.find((i) => i.id === id);
  if (!inc) return res.status(404).json({ error: 'Incident not found' });

  const parsed = IncidentPatchSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid incident update payload', details: parsed.error.flatten() });
  }

  const data = parsed.data;
  const nextLat = data.lat ?? inc.lat;
  const nextLng = data.lng ?? inc.lng;
  const coordAnalysis = analyzeCoordinates(nextLat, nextLng, data.region ?? inc.region);
  if (!coordAnalysis.valid) {
    return res.status(400).json({ error: coordAnalysis.warnings[0] || 'Invalid coordinates' });
  }

  const nextPeople = data.peopleAffected ?? inc.peopleAffected;
  const nextVuln = data.vulnerablePopulation ?? inc.vulnerablePopulation;
  if (nextVuln > nextPeople && nextPeople > 0) {
    return res.status(400).json({ error: 'Vulnerable population cannot exceed total people affected.' });
  }

  const actor = req.actor!;
  const prevSeverity = inc.severity;
  const changedFields: string[] = [];

  if (data.title !== undefined && data.title !== inc.title) {
    inc.title = data.title;
    changedFields.push('title');
  }
  if (data.description !== undefined && data.description !== inc.description) {
    inc.description = data.description;
    changedFields.push('description');
  }
  if (data.type !== undefined && data.type !== inc.type) {
    inc.type = data.type;
    changedFields.push('type');
  }
  if (data.severity !== undefined || data.severityLevel !== undefined) {
    const nextSev = data.severity || (data.severityLevel ? levelToSeverity(data.severityLevel) : inc.severity);
    const nextLvl = (data.severityLevel || severityToLevel(nextSev)) as 1 | 2 | 3 | 4 | 5;
    if (nextSev !== inc.severity || nextLvl !== inc.severityLevel) {
      inc.severity = nextSev;
      inc.severityLevel = nextLvl;
      changedFields.push(`severity(${prevSeverity}->${nextSev})`);
    }
  }
  if (data.lat !== undefined || data.lng !== undefined) {
    inc.lat = nextLat;
    inc.lng = nextLng;
    inc.coordinateWarnings = coordAnalysis.warnings.length > 0 ? coordAnalysis.warnings : undefined;
    changedFields.push('location');
  }
  if (data.address !== undefined) {
    inc.address = data.address;
    changedFields.push('address');
  }
  if (data.region !== undefined) {
    inc.region = data.region;
    changedFields.push('region');
  }
  if (data.district !== undefined) inc.district = data.district;
  if (data.state !== undefined) inc.state = data.state;
  if (data.country !== undefined) inc.country = data.country;
  if (data.peopleAffected !== undefined && data.peopleAffected !== inc.peopleAffected) {
    inc.peopleAffected = data.peopleAffected;
    changedFields.push(`peopleAffected(${data.peopleAffected})`);
  }
  if (data.familiesAffected !== undefined) inc.familiesAffected = data.familiesAffected;
  if (data.vulnerablePopulation !== undefined && data.vulnerablePopulation !== inc.vulnerablePopulation) {
    inc.vulnerablePopulation = data.vulnerablePopulation;
    changedFields.push(`vulnerablePopulation(${data.vulnerablePopulation})`);
  }
  if (data.estimatedImpactAreaKm2 !== undefined) {
    inc.estimatedImpactAreaKm2 = data.estimatedImpactAreaKm2;
    changedFields.push('impactArea');
  }
  if (data.infrastructureAffected !== undefined) {
    inc.infrastructureAffected = data.infrastructureAffected;
    changedFields.push('infrastructure');
  }
  if (data.immediateNeeds !== undefined) inc.immediateNeeds = data.immediateNeeds;
  if (data.assignedTeam !== undefined) inc.assignedTeam = data.assignedTeam;

  const now = new Date().toISOString();
  inc.updatedAt = now;
  inc.history.push({
    id: uuidv4(),
    timestamp: now,
    actor: actor.name,
    role: actor.role,
    action: `Incident updated (${changedFields.join(', ') || 'metadata'})`,
    note: data.note,
  });

  // Alert on severity increase
  const sevOrder = { low: 1, medium: 2, high: 3, critical: 4 };
  if (sevOrder[inc.severity] > sevOrder[prevSeverity]) {
    store.triggerAlert({
      dedupKey: `${inc.mode}:sev_increase:${inc.id}:${inc.severity}`,
      incidentId: inc.id,
      incidentTitle: inc.title,
      alertType: 'incident_severity_increased',
      severity: inc.severity === 'critical' ? 'critical' : 'high',
      title: `Incident Severity Increased (${prevSeverity.toUpperCase()} → ${inc.severity.toUpperCase()}): ${inc.title}`,
      message: data.note || `Operator updated incident severity from ${prevSeverity} to ${inc.severity}.`,
      triggerFactor: 'incident_severity_upgraded',
      previousValue: prevSeverity,
      currentValue: inc.severity,
      source: 'incident-lifecycle-engine',
      mode: inc.mode,
    });
  }

  store.save();
  store.addAudit({
    actor: actor.name,
    role: actor.role,
    orgId: actor.orgId,
    action: 'incident.updated',
    entityType: 'incident',
    entityId: inc.id,
    summary: `Updated ${inc.title}: ${changedFields.join(', ') || 'metadata'}`,
    mode: inc.mode,
  });

  eventBus.publish({
    event_type: 'incident.updated',
    organization_id: actor.orgId,
    entity_id: inc.id,
    source: 'incidents-api',
    mode: inc.mode,
    payload: { incident: inc, changedFields },
  });

  const reassessmentJob = scheduleAutomaticReassessment({
    incidentId: inc.id,
    reason: `incident_patched:${changedFields.join(',') || 'update'}`,
    assessmentSource: 'auto_reassessment',
    actorName: actor.name,
    actorRole: actor.role,
    orgId: actor.orgId,
  });

  res.json({ incident: inc, changedFields, reassessmentJob });
});

api.post('/incidents/:id/verify', requirePermission('incident:verify'), (req: AuthedRequest, res) => {
  const id = getParam(req.params.id);
  const inc = store.state.incidents.find((i) => i.id === id);
  if (!inc) return res.status(404).json({ error: 'Incident not found' });

  const actor = req.actor!;
  const prev = inc.status;
  inc.verificationStatus = 'verified';
  if (inc.status === 'reported' || inc.status === 'under_review') {
    inc.status = 'verified';
  }
  inc.updatedAt = new Date().toISOString();
  inc.history.push({
    id: uuidv4(),
    timestamp: inc.updatedAt,
    actor: actor.name,
    role: actor.role,
    action: 'Incident verified',
    note: req.body?.note,
    previousStatus: prev,
    newStatus: inc.status,
  });

  // Resolve any open manual-verification-required alert for this incident
  for (const al of store.state.alerts) {
    if (al.incidentId === inc.id && al.alertType === 'manual_verification_required' && al.status !== 'RESOLVED') {
      al.status = 'RESOLVED';
      al.resolvedBy = actor.name;
      al.resolvedAt = inc.updatedAt;
      al.resolutionNote = 'Incident verified by commander';
      al.updatedAt = inc.updatedAt;
    }
  }
  store.save();

  store.addAudit({
    actor: actor.name,
    role: actor.role,
    orgId: actor.orgId,
    action: 'incident.verified',
    entityType: 'incident',
    entityId: inc.id,
    summary: `Verified incident ${inc.title}`,
    mode: inc.mode,
  });

  eventBus.publish({
    event_type: 'incident.verified',
    organization_id: actor.orgId,
    entity_id: inc.id,
    source: 'incidents-api',
    mode: inc.mode,
    payload: { incident: inc },
  });

  const reassessmentJob = scheduleAutomaticReassessment({
    incidentId: inc.id,
    reason: 'incident_verified',
    assessmentSource: 'auto_reassessment',
    actorName: actor.name,
    actorRole: actor.role,
    orgId: actor.orgId,
  });

  res.json({ incident: inc, reassessmentJob });
});

api.post('/incidents/:id/reject', requirePermission('incident:reject'), (req: AuthedRequest, res) => {
  const id = getParam(req.params.id);
  const inc = store.state.incidents.find((i) => i.id === id);
  if (!inc) return res.status(404).json({ error: 'Incident not found' });

  const reason = String(req.body?.reason || '').trim();
  if (reason.length < 3) {
    return res.status(400).json({ error: 'Rejection reason (>= 3 characters) is required.' });
  }

  const actor = req.actor!;
  const prev = inc.status;
  inc.verificationStatus = 'rejected';
  inc.rejectedReason = reason;
  inc.status = 'archived';
  inc.updatedAt = new Date().toISOString();
  inc.history.push({
    id: uuidv4(),
    timestamp: inc.updatedAt,
    actor: actor.name,
    role: actor.role,
    action: 'Incident rejected & archived',
    note: reason,
    previousStatus: prev,
    newStatus: 'archived',
  });
  store.save();

  store.addAudit({
    actor: actor.name,
    role: actor.role,
    orgId: actor.orgId,
    action: 'incident.rejected',
    entityType: 'incident',
    entityId: inc.id,
    summary: `Rejected incident ${inc.title}: ${reason}`,
    mode: inc.mode,
  });

  eventBus.publish({
    event_type: 'incident.updated',
    organization_id: actor.orgId,
    entity_id: inc.id,
    source: 'incidents-api',
    mode: inc.mode,
    payload: { incident: inc },
  });

  res.json({ incident: inc });
});

api.post('/incidents/:id/assess', requirePermission('risk:assess'), async (req: AuthedRequest, res) => {
  const id = getParam(req.params.id);
  const inc = store.state.incidents.find((i) => i.id === id);
  if (!inc) return res.status(404).json({ error: 'Incident not found' });

  const actor = req.actor!;
  const result = await reassessIncidentNow({
    incidentId: inc.id,
    reason: String(req.body?.reason || 'manual_incident_assessment'),
    assessmentSource: 'manual',
    actorName: actor.name,
    actorRole: actor.role,
    orgId: actor.orgId,
    forceWeatherRefresh: Boolean(req.body?.forceWeatherRefresh),
    simulateWeatherOutage: Boolean(req.body?.simulateWeatherOutage),
  });

  res.json({
    incident: inc,
    assessment: result.assessment,
    weather: result.weather,
    alertsTriggered: result.alertsTriggered,
  });
});

api.post('/incidents/:id/escalate', requirePermission('incident:escalate'), (req: AuthedRequest, res) => {
  const id = getParam(req.params.id);
  const inc = store.state.incidents.find((i) => i.id === id);
  if (!inc) return res.status(404).json({ error: 'Incident not found' });

  const actor = req.actor!;
  const prev = inc.status;
  const prevSeverity = inc.severity;
  inc.status = 'escalated';
  inc.severity = 'critical';
  inc.severityLevel = 5;
  inc.updatedAt = new Date().toISOString();
  inc.history.push({
    id: uuidv4(),
    timestamp: inc.updatedAt,
    actor: actor.name,
    role: actor.role,
    action: 'Incident escalated to CRITICAL',
    note: req.body?.reason || 'Escalated by commander',
    previousStatus: prev,
    newStatus: 'escalated',
  });
  store.save();

  store.triggerAlert({
    dedupKey: `${inc.mode}:inc_escalated:${inc.id}`,
    incidentId: inc.id,
    incidentTitle: inc.title,
    alertType: 'incident_severity_increased',
    severity: 'critical',
    title: `Escalated to CRITICAL: ${inc.title}`,
    message: req.body?.reason || 'Commander escalated incident status to CRITICAL.',
    triggerFactor: 'commander_escalation',
    previousValue: prevSeverity,
    currentValue: 'critical',
    source: 'incident-lifecycle-engine',
    mode: inc.mode,
  });

  store.addAudit({
    actor: actor.name,
    role: actor.role,
    orgId: actor.orgId,
    action: 'incident.escalated',
    entityType: 'incident',
    entityId: inc.id,
    summary: `Escalated ${inc.title} to critical`,
    mode: inc.mode,
  });

  eventBus.publish({
    event_type: 'incident.severity_changed',
    organization_id: actor.orgId,
    entity_id: inc.id,
    source: 'incidents-api',
    mode: inc.mode,
    payload: { incident: inc },
  });

  const reassessmentJob = scheduleAutomaticReassessment({
    incidentId: inc.id,
    reason: 'incident_escalated',
    assessmentSource: 'auto_reassessment',
    actorName: actor.name,
    actorRole: actor.role,
    orgId: actor.orgId,
  });

  res.json({ incident: inc, reassessmentJob });
});

api.post('/incidents/:id/resolve', requirePermission('incident:close'), (req: AuthedRequest, res) => {
  const id = getParam(req.params.id);
  const inc = store.state.incidents.find((i) => i.id === id);
  if (!inc) return res.status(404).json({ error: 'Incident not found' });
  if (!isValidIncidentTransition(inc.status, 'resolved')) {
    return res.status(400).json({ error: `Cannot transition incident from '${inc.status}' to 'resolved'.` });
  }

  const actor = req.actor!;
  const prev = inc.status;
  inc.status = 'resolved';
  inc.updatedAt = new Date().toISOString();
  inc.history.push({
    id: uuidv4(),
    timestamp: inc.updatedAt,
    actor: actor.name,
    role: actor.role,
    action: 'Incident resolved',
    note: req.body?.note || 'Marked resolved by commander',
    previousStatus: prev,
    newStatus: 'resolved',
  });
  store.save();

  store.addAudit({
    actor: actor.name,
    role: actor.role,
    orgId: actor.orgId,
    action: 'incident.resolved',
    entityType: 'incident',
    entityId: inc.id,
    summary: `Resolved incident ${inc.title}`,
    mode: inc.mode,
  });

  eventBus.publish({
    event_type: 'incident.updated',
    organization_id: actor.orgId,
    entity_id: inc.id,
    source: 'incidents-api',
    mode: inc.mode,
    payload: { incident: inc },
  });

  res.json({ incident: inc });
});

api.post('/incidents/:id/reopen', requirePermission('incident:manage'), (req: AuthedRequest, res) => {
  const id = getParam(req.params.id);
  const inc = store.state.incidents.find((i) => i.id === id);
  if (!inc) return res.status(404).json({ error: 'Incident not found' });
  if (!isValidIncidentTransition(inc.status, 'active')) {
    return res.status(400).json({ error: `Cannot reopen incident from '${inc.status}' state.` });
  }

  const actor = req.actor!;
  const prev = inc.status;
  inc.status = 'active';
  inc.updatedAt = new Date().toISOString();
  inc.history.push({
    id: uuidv4(),
    timestamp: inc.updatedAt,
    actor: actor.name,
    role: actor.role,
    action: 'Incident reopened',
    note: req.body?.reason || 'Reopened for continued emergency response',
    previousStatus: prev,
    newStatus: 'active',
  });
  store.save();

  store.addAudit({
    actor: actor.name,
    role: actor.role,
    orgId: actor.orgId,
    action: 'incident.reopened',
    entityType: 'incident',
    entityId: inc.id,
    summary: `Reopened incident ${inc.title}`,
    mode: inc.mode,
  });

  eventBus.publish({
    event_type: 'incident.updated',
    organization_id: actor.orgId,
    entity_id: inc.id,
    source: 'incidents-api',
    mode: inc.mode,
    payload: { incident: inc },
  });

  const reassessmentJob = scheduleAutomaticReassessment({
    incidentId: inc.id,
    reason: 'incident_reopened',
    assessmentSource: 'auto_reassessment',
    actorName: actor.name,
    actorRole: actor.role,
    orgId: actor.orgId,
  });

  res.json({ incident: inc, reassessmentJob });
});

api.post('/incidents/:id/archive', requirePermission('incident:archive'), (req: AuthedRequest, res) => {
  const id = getParam(req.params.id);
  const inc = store.state.incidents.find((i) => i.id === id);
  if (!inc) return res.status(404).json({ error: 'Incident not found' });

  const actor = req.actor!;
  const prev = inc.status;
  inc.status = 'archived';
  inc.updatedAt = new Date().toISOString();
  inc.history.push({
    id: uuidv4(),
    timestamp: inc.updatedAt,
    actor: actor.name,
    role: actor.role,
    action: 'Incident archived',
    note: req.body?.note,
    previousStatus: prev,
    newStatus: 'archived',
  });
  store.save();

  store.addAudit({
    actor: actor.name,
    role: actor.role,
    orgId: actor.orgId,
    action: 'incident.archived',
    entityType: 'incident',
    entityId: inc.id,
    summary: `Archived incident ${inc.title}`,
    mode: inc.mode,
  });

  res.json({ incident: inc });
});

api.post('/incidents/:id/status', requirePermission('incident:manage'), (req: AuthedRequest, res) => {
  const id = getParam(req.params.id);
  const inc = store.state.incidents.find((i) => i.id === id);
  if (!inc) return res.status(404).json({ error: 'Incident not found' });

  const nextStatus = String(req.body?.status || '') as IncidentStatus;
  const validStatuses: IncidentStatus[] = [
    'reported',
    'under_review',
    'verified',
    'active',
    'escalated',
    'contained',
    'resolved',
    'archived',
  ];
  if (!validStatuses.includes(nextStatus)) {
    return res.status(400).json({ error: 'Invalid incident status' });
  }
  if (!isValidIncidentTransition(inc.status, nextStatus)) {
    return res.status(400).json({
      error: `Invalid status transition: '${inc.status}' -> '${nextStatus}' is not permitted.`,
    });
  }

  const actor = req.actor!;
  const prev = inc.status;
  inc.status = nextStatus;
  inc.updatedAt = new Date().toISOString();
  inc.history.push({
    id: uuidv4(),
    timestamp: inc.updatedAt,
    actor: actor.name,
    role: actor.role,
    action: `Status changed to ${nextStatus}`,
    note: req.body?.note,
    previousStatus: prev,
    newStatus: nextStatus,
  });
  store.save();

  eventBus.publish({
    event_type: 'incident.updated',
    organization_id: actor.orgId,
    entity_id: inc.id,
    source: 'incidents-api',
    mode: inc.mode,
    payload: { incident: inc },
  });

  res.json({ incident: inc });
});

api.get('/incidents/:id/history', (req, res) => {
  const id = getParam(req.params.id);
  const inc = store.state.incidents.find((i) => i.id === id);
  if (!inc) return res.status(404).json({ error: 'Incident not found' });
  const audits = store.state.auditLogs.filter((l) => l.entityId === inc.id);
  res.json({ incidentId: inc.id, history: inc.history, auditLogs: audits });
});

api.get('/incidents/:id/duplicates', (req, res) => {
  const id = getParam(req.params.id);
  const inc = store.state.incidents.find((i) => i.id === id);
  if (!inc) return res.status(404).json({ error: 'Incident not found' });
  const matches = detectDetailedDuplicates(
    {
      id: inc.id,
      type: inc.type,
      lat: inc.lat,
      lng: inc.lng,
      title: inc.title,
      reportedAt: inc.reportedAt,
      mode: inc.mode,
    },
    store.state.incidents
  );
  res.json({ incidentId: inc.id, duplicates: matches });
});

api.post('/incidents/:id/reports', requirePermission('incident:create'), (req: AuthedRequest, res) => {
  const id = getParam(req.params.id);
  const inc = store.state.incidents.find((i) => i.id === id);
  if (!inc) return res.status(404).json({ error: 'Incident not found' });

  const schema = z.object({
    summary: z.string().min(4).max(2000),
    sourceType: z.enum(['citizen', 'field_responder', 'agency', 'sensor', 'command_desk']).default('field_responder'),
    peopleAffectedUpdate: z.number().int().min(0).optional(),
    vulnerablePopulationUpdate: z.number().int().min(0).optional(),
    severitySuggestion: z.enum(['low', 'medium', 'high', 'critical']).optional(),
    evidenceUrls: z.array(z.string()).default([]),
    lat: z.number().min(-90).max(90).optional(),
    lng: z.number().min(-180).max(180).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid field report payload', details: parsed.error.flatten() });
  }

  const actor = req.actor!;
  const now = new Date().toISOString();
  const report: IncidentReportRecord = {
    id: uuidv4(),
    incidentId: inc.id,
    reporterName: actor.name,
    reporterRole: actor.role,
    sourceType: parsed.data.sourceType,
    summary: parsed.data.summary,
    peopleAffectedUpdate: parsed.data.peopleAffectedUpdate,
    vulnerablePopulationUpdate: parsed.data.vulnerablePopulationUpdate,
    severitySuggestion: parsed.data.severitySuggestion,
    evidenceUrls: parsed.data.evidenceUrls,
    lat: parsed.data.lat,
    lng: parsed.data.lng,
    mode: inc.mode,
    createdAt: now,
  };

  store.state.incidentReports.unshift(report);
  if (parsed.data.peopleAffectedUpdate !== undefined && parsed.data.peopleAffectedUpdate > inc.peopleAffected) {
    inc.peopleAffected = parsed.data.peopleAffectedUpdate;
  }
  if (
    parsed.data.vulnerablePopulationUpdate !== undefined &&
    parsed.data.vulnerablePopulationUpdate > inc.vulnerablePopulation &&
    parsed.data.vulnerablePopulationUpdate <= inc.peopleAffected
  ) {
    inc.vulnerablePopulation = parsed.data.vulnerablePopulationUpdate;
  }
  if (parsed.data.evidenceUrls.length > 0) {
    inc.evidenceUrls = Array.from(new Set([...inc.evidenceUrls, ...parsed.data.evidenceUrls]));
  }
  inc.updatedAt = now;
  inc.history.push({
    id: uuidv4(),
    timestamp: now,
    actor: actor.name,
    role: actor.role,
    action: 'Field report attached',
    note: parsed.data.summary.slice(0, 160),
  });
  store.save();

  store.addAudit({
    actor: actor.name,
    role: actor.role,
    orgId: actor.orgId,
    action: 'incident.report_attached',
    entityType: 'incident',
    entityId: inc.id,
    summary: `Attached ${report.sourceType} report to ${inc.title}`,
    mode: inc.mode,
  });

  const reassessmentJob = scheduleAutomaticReassessment({
    incidentId: inc.id,
    reason: 'field_report_attached',
    assessmentSource: 'report_update',
    actorName: actor.name,
    actorRole: actor.role,
    orgId: actor.orgId,
  });

  res.status(201).json({ report, incident: inc, reassessmentJob });
});

api.post('/incidents/:id/evidence', requirePermission('incident:manage'), (req: AuthedRequest, res) => {
  const id = getParam(req.params.id);
  const inc = store.state.incidents.find((i) => i.id === id);
  if (!inc) return res.status(404).json({ error: 'Incident not found' });

  const url = String(req.body?.url || '').trim();
  if (!url) return res.status(400).json({ error: 'Evidence URL or local asset path is required' });

  const actor = req.actor!;
  const now = new Date().toISOString();
  if (!inc.evidenceUrls.includes(url)) {
    inc.evidenceUrls.push(url);
  }
  inc.updatedAt = now;
  inc.history.push({
    id: uuidv4(),
    timestamp: now,
    actor: actor.name,
    role: actor.role,
    action: 'Evidence attached',
    note: req.body?.caption ? `${req.body.caption} (${url})` : url,
  });
  store.save();

  res.status(201).json({ incident: inc, evidenceUrl: url });
});

api.post('/incidents/:id/notes', requirePermission('incident:manage'), (req: AuthedRequest, res) => {
  const id = getParam(req.params.id);
  const inc = store.state.incidents.find((i) => i.id === id);
  if (!inc) return res.status(404).json({ error: 'Incident not found' });
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Note text is required' });

  const actor = req.actor!;
  const note = { id: uuidv4(), text, author: actor.name, createdAt: new Date().toISOString() };
  inc.notes.unshift(note);
  inc.updatedAt = note.createdAt;
  store.save();

  eventBus.publish({
    event_type: 'incident.updated',
    organization_id: actor.orgId,
    entity_id: inc.id,
    source: 'incidents-api',
    mode: inc.mode,
    payload: { incidentId: inc.id, note },
  });

  res.status(201).json({ incident: inc, note });
});

// ============================================================================
// 3. LIVE WEATHER, RISK INTELLIGENCE, AI EXPLANATION & AUTOMATED ALERTS
// ============================================================================

api.get('/weather', async (req, res) => {
  const lat = Number(req.query.lat ?? 13.0827);
  const lng = Number(req.query.lng ?? 80.2707);
  const locationName = String(req.query.locationName || 'Command Sector');
  const forceRefresh = req.query.forceRefresh === 'true';
  if (!validateCoordinates(lat, lng)) {
    return res.status(400).json({ error: 'Invalid latitude or longitude.' });
  }
  const observation = await fetchLiveWeather(lat, lng, locationName, { forceRefresh });
  res.json({ observation });
});

api.get('/weather/current', async (req, res) => {
  const lat = Number(req.query.lat ?? 13.0827);
  const lng = Number(req.query.lng ?? 80.2707);
  const locationName = String(req.query.locationName || 'Command Sector');
  const forceRefresh = req.query.forceRefresh === 'true';
  if (!validateCoordinates(lat, lng)) {
    return res.status(400).json({ error: 'Invalid latitude or longitude.' });
  }
  const observation = await fetchLiveWeather(lat, lng, locationName, { forceRefresh });
  res.json({ observation, providerStatus: getWeatherProviderStatus() });
});

api.get('/weather/forecast', async (req, res) => {
  const lat = Number(req.query.lat ?? 13.0827);
  const lng = Number(req.query.lng ?? 80.2707);
  const locationName = String(req.query.locationName || 'Command Sector');
  if (!validateCoordinates(lat, lng)) {
    return res.status(400).json({ error: 'Invalid latitude or longitude.' });
  }
  const observation = await fetchLiveWeather(lat, lng, locationName);
  res.json({
    locationName: observation.locationName,
    lat: observation.lat,
    lng: observation.lng,
    provider: observation.provider,
    freshnessCode: observation.freshnessCode,
    hourly: observation.forecastSummary,
    daily: observation.dailyForecast || [],
    weatherRisk: observation.weatherRisk,
    fetchTimestamp: observation.fetchTimestamp,
  });
});

api.get('/weather/providers/status', (_req, res) => {
  res.json({ providers: [getWeatherProviderStatus()], timestamp: new Date().toISOString() });
});

api.get('/incidents/:id/weather', async (req, res) => {
  const id = getParam(req.params.id);
  const inc = store.state.incidents.find((i) => i.id === id);
  if (!inc) return res.status(404).json({ error: 'Incident not found' });

  const observation = await fetchLiveWeather(inc.lat, inc.lng, inc.address);
  const incidentWeatherRisk = calculateIncidentWeatherRisk(inc.type, observation);
  res.json({ incidentId: inc.id, observation, incidentWeatherRisk });
});

api.post('/weather/refresh/:id', requirePermission('risk:assess'), async (req: AuthedRequest, res) => {
  const id = getParam(req.params.id);
  const inc = store.state.incidents.find((i) => i.id === id);
  if (!inc) return res.status(404).json({ error: 'Incident not found' });

  const actor = req.actor!;
  const result = await reassessIncidentNow({
    incidentId: inc.id,
    reason: 'weather_force_refreshed',
    assessmentSource: 'weather_update',
    actorName: actor.name,
    actorRole: actor.role,
    orgId: actor.orgId,
    forceWeatherRefresh: true,
    simulateWeatherOutage: Boolean(req.body?.simulateOutage),
  });

  eventBus.publish({
    event_type: 'weather.updated',
    organization_id: actor.orgId,
    entity_id: inc.id,
    source: 'weather-engine',
    mode: inc.mode,
    payload: { incidentId: inc.id, observation: result.weather },
  });

  res.json({
    incidentId: inc.id,
    observation: result.weather,
    incidentWeatherRisk: calculateIncidentWeatherRisk(inc.type, result.weather),
    assessment: result.assessment,
    alertsTriggered: result.alertsTriggered,
  });
});

api.get('/risks', (req, res) => {
  const mode = parseMode(req.query.mode);
  const assessments = store.state.riskAssessments.filter((r) => r.mode === mode);
  const predictions = computeOperationalPredictions(mode);
  const aiBriefings = store.state.aiRiskAnalyses.filter((b) => b.mode === mode);
  res.json({ assessments, predictions, aiBriefings });
});

api.get('/risks/overview', (req, res) => {
  const mode = parseMode(req.query.mode);
  const incidents = store.state.incidents.filter((i) => i.mode === mode && i.status !== 'archived');
  const assessments = store.state.riskAssessments.filter((r) => r.mode === mode);
  const latestByIncident = new Map<string, typeof assessments[number]>();
  for (const a of assessments) {
    if (!latestByIncident.has(a.incidentId)) {
      latestByIncident.set(a.incidentId, a);
    }
  }
  const latestList = Array.from(latestByIncident.values());
  const scored = latestList.filter((a) => a.overallScore !== null);
  const avgScore =
    scored.length > 0
      ? Math.round(scored.reduce((sum, a) => sum + (a.overallScore ?? 0), 0) / scored.length)
      : null;

  const bandCounts = {
    Critical: latestList.filter((a) => a.band === 'Critical').length,
    High: latestList.filter((a) => a.band === 'High').length,
    Elevated: latestList.filter((a) => a.band === 'Elevated').length,
    Guarded: latestList.filter((a) => a.band === 'Guarded').length,
    Low: latestList.filter((a) => a.band === 'Low').length,
    'Insufficient Data': latestList.filter((a) => a.band === 'Insufficient Data').length,
  };

  const recentChanges = assessments
    .filter((a) => a.riskChange && a.riskChange.previousAssessmentId !== null)
    .slice(0, 12)
    .map((a) => ({
      assessmentId: a.id,
      incidentId: a.incidentId,
      incidentTitle: a.incidentTitle,
      createdAt: a.createdAt,
      ...a.riskChange,
    }));

  res.json({
    mode,
    totalActiveIncidents: incidents.length,
    assessedIncidents: latestList.length,
    averageRiskScore: avgScore,
    bandCounts,
    incompleteAssessments: latestList.filter((a) => a.incompleteDataWarning).length,
    insufficientDataCount: latestList.filter((a) => a.assessmentStatus === 'INSUFFICIENT_DATA').length,
    activeAlertsCount: store.state.alerts.filter((al) => al.mode === mode && al.status !== 'RESOLVED').length,
    recentChanges,
    reassessmentStats: getReassessmentStats(),
  });
});

api.post('/risks/assess', requirePermission('risk:assess'), async (req: AuthedRequest, res) => {
  const incidentId = String(req.body?.incidentId || '');
  const incident = store.state.incidents.find((i) => i.id === incidentId);
  if (!incident) return res.status(404).json({ error: 'Incident not found' });

  const actor = req.actor!;
  const result = await reassessIncidentNow({
    incidentId: incident.id,
    reason: String(req.body?.reason || 'manual_risk_assessment'),
    assessmentSource: 'manual',
    actorName: actor.name,
    actorRole: actor.role,
    orgId: actor.orgId,
    forceWeatherRefresh: Boolean(req.body?.forceWeatherRefresh),
    simulateWeatherOutage: Boolean(req.body?.simulateWeatherOutage),
  });

  res.json({
    assessment: result.assessment,
    weather: result.weather,
    alertsTriggered: result.alertsTriggered,
  });
});

api.get('/risks/:assessment_id', (req, res) => {
  const assessmentId = getParam(req.params.assessment_id);
  const assessment = store.state.riskAssessments.find((r) => r.id === assessmentId);
  if (!assessment) return res.status(404).json({ error: 'Risk assessment not found' });
  const briefing = store.state.aiRiskAnalyses.find((b) => b.assessment_id === assessment.id) || null;
  res.json({ assessment, briefing });
});

api.get('/incidents/:id/risk-history', (req, res) => {
  const id = getParam(req.params.id);
  const inc = store.state.incidents.find((i) => i.id === id);
  if (!inc) return res.status(404).json({ error: 'Incident not found' });

  const history = store.state.riskAssessments.filter((r) => r.incidentId === inc.id);
  const briefings = store.state.aiRiskAnalyses.filter((b) => b.incident_id === inc.id);
  res.json({ incidentId: inc.id, assessments: history, aiBriefings: briefings });
});

api.post('/incidents/:id/risk-explanation', requirePermission('ai:run'), async (req: AuthedRequest, res) => {
  const id = getParam(req.params.id);
  const inc = store.state.incidents.find((i) => i.id === id);
  if (!inc) return res.status(404).json({ error: 'Incident not found' });

  const actor = req.actor!;
  let history = store.state.riskAssessments.filter((r) => r.incidentId === inc.id);
  let latestWeather: ReturnType<typeof store.state.weatherObservations.find> = undefined;

  if (history.length === 0) {
    const assessed = await reassessIncidentNow({
      incidentId: inc.id,
      reason: 'pre_explanation_baseline',
      assessmentSource: 'manual',
      actorName: actor.name,
      actorRole: actor.role,
      orgId: actor.orgId,
    });
    history = [assessed.assessment];
    latestWeather = assessed.weather;
  }

  const latestAssessment = history[0];
  const previousAssessment = history[1] || null;
  if (!latestWeather && latestAssessment.weatherObservationId) {
    latestWeather = store.state.weatherObservations.find((w) => w.id === latestAssessment.weatherObservationId);
  }
  const reports = store.state.incidentReports.filter((r) => r.incidentId === inc.id);

  try {
    const briefing = await generateRiskExplanation({
      incident: inc,
      assessment: latestAssessment,
      previousAssessment,
      weather: latestWeather || null,
      reports,
      model: typeof req.body?.model === 'string' ? req.body.model : undefined,
    });

    store.addAudit({
      actor: actor.name,
      role: actor.role,
      orgId: actor.orgId,
      action: 'ai.risk_explanation_generated',
      entityType: 'incident',
      entityId: inc.id,
      summary: `Generated AI Risk Interpretation Briefing (${briefing.model}) for ${inc.title}`,
      mode: inc.mode,
    });

    res.json({ briefing, assessment: latestAssessment });
  } catch (err) {
    res.status(502).json({
      error: err instanceof Error ? err.message : 'AI Risk Interpretation failed',
      requiresHumanReview: true,
    });
  }
});

// ============================================================================
// 3B. AUTOMATED EMERGENCY ALERT ENGINE ROUTES
// ============================================================================

api.get('/alerts', (req, res) => {
  const mode = parseMode(req.query.mode);
  const status = req.query.status ? String(req.query.status) : null;
  const severity = req.query.severity ? String(req.query.severity) : null;
  const incidentId = req.query.incidentId ? String(req.query.incidentId) : null;

  let list = store.state.alerts.filter((a) => a.mode === mode);
  if (status && status !== 'all') list = list.filter((a) => a.status === status);
  if (severity && severity !== 'all') list = list.filter((a) => a.severity === severity);
  if (incidentId) list = list.filter((a) => a.incidentId === incidentId);

  res.json({
    alerts: list,
    activeCount: store.state.alerts.filter((a) => a.mode === mode && a.status !== 'RESOLVED').length,
    criticalActiveCount: store.state.alerts.filter(
      (a) => a.mode === mode && a.status !== 'RESOLVED' && a.severity === 'critical'
    ).length,
  });
});

api.get('/alerts/:alert_id', (req, res) => {
  const alertId = getParam(req.params.alert_id);
  const alert = store.state.alerts.find((a) => a.id === alertId);
  if (!alert) return res.status(404).json({ error: 'Alert not found' });
  res.json({ alert });
});

api.post('/alerts/:alert_id/acknowledge', requirePermission('alert:manage'), (req: AuthedRequest, res) => {
  const alertId = getParam(req.params.alert_id);
  const actor = req.actor!;
  const alert = store.acknowledgeAlert(alertId, actor.name);
  if (!alert) return res.status(404).json({ error: 'Alert not found' });

  store.addAudit({
    actor: actor.name,
    role: actor.role,
    orgId: actor.orgId,
    action: 'alert.acknowledged',
    entityType: 'alert',
    entityId: alert.id,
    summary: `Acknowledged alert: ${alert.title}`,
    mode: alert.mode,
  });

  eventBus.publish({
    event_type: 'alert.updated',
    organization_id: actor.orgId,
    entity_id: alert.id,
    source: 'alert-engine',
    mode: alert.mode,
    payload: { alert },
  });

  res.json({ alert });
});

api.post('/alerts/:alert_id/resolve', requirePermission('alert:manage'), (req: AuthedRequest, res) => {
  const alertId = getParam(req.params.alert_id);
  const actor = req.actor!;
  const note = typeof req.body?.note === 'string' ? req.body.note : undefined;
  const alert = store.resolveAlert(alertId, actor.name, note);
  if (!alert) return res.status(404).json({ error: 'Alert not found' });

  store.addAudit({
    actor: actor.name,
    role: actor.role,
    orgId: actor.orgId,
    action: 'alert.resolved',
    entityType: 'alert',
    entityId: alert.id,
    summary: `Resolved alert: ${alert.title}`,
    mode: alert.mode,
  });

  eventBus.publish({
    event_type: 'alert.updated',
    organization_id: actor.orgId,
    entity_id: alert.id,
    source: 'alert-engine',
    mode: alert.mode,
    payload: { alert },
  });

  res.json({ alert });
});

// ============================================================================
// 4. GEOSPATIAL QUERIES
// ============================================================================

api.get('/geospatial/nearest-warehouses', (req, res) => {
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  const mode = parseMode(req.query.mode);
  const limit = Math.min(20, Math.max(1, Number(req.query.limit || 5)));
  if (!validateCoordinates(lat, lng)) {
    return res.status(400).json({ error: 'Valid lat & lng query parameters required.' });
  }
  res.json({ results: findNearestWarehouses(lat, lng, mode, limit) });
});

api.get('/geospatial/radius-search', (req, res) => {
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  const radiusKm = Math.max(1, Number(req.query.radiusKm || 50));
  const mode = parseMode(req.query.mode);
  if (!validateCoordinates(lat, lng)) {
    return res.status(400).json({ error: 'Valid lat & lng required.' });
  }
  const incidents = store.state.incidents
    .filter((i) => i.mode === mode && haversineKm(lat, lng, i.lat, i.lng) <= radiusKm)
    .map((i) => ({ ...i, distanceKm: haversineKm(lat, lng, i.lat, i.lng) }));
  const warehouses = store.state.warehouses
    .filter((w) => w.mode === mode && haversineKm(lat, lng, w.lat, w.lng) <= radiusKm)
    .map((w) => ({ ...w, distanceKm: haversineKm(lat, lng, w.lat, w.lng) }));
  res.json({ radiusKm, incidents, warehouses });
});

api.get('/geo/geocode', async (req, res) => {
  const address = String(req.query.address || '').trim();
  if (address.length < 2 || address.length > 250) {
    return res.status(400).json({ error: 'Please provide an address or place query (2-250 characters).' });
  }
  const result = await geocodeAddressServer(address);
  return res.json(result);
});

api.get('/geo/reverse', async (req, res) => {
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  if (!validateCoordinates(lat, lng)) {
    return res.status(400).json({ error: 'Valid lat & lng query parameters required.' });
  }
  const result = await reverseGeocodeServer(lat, lng);
  return res.json(result);
});

// ============================================================================
// 5. RELIEF REQUESTS & TRANSPARENT PRIORITY ENGINE
// ============================================================================

const ReliefCreateSchema = z.object({
  incidentId: z.string().min(1),
  requesterName: z.string().min(2).max(120),
  contact: z.string().max(80).default('Not Provided'),
  locationName: z.string().min(2).max(200),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  peopleAffected: z.number().int().min(1),
  familiesAffected: z.number().int().min(0).default(0),
  vulnerableGroups: z.array(z.string()).default([]),
  urgency: z.enum(['low', 'medium', 'high', 'critical']),
  items: z
    .array(
      z.object({
        category: z.enum([
          'drinking_water',
          'food',
          'medical_kits',
          'medicines',
          'shelter',
          'blankets',
          'clothing',
          'hygiene_kits',
          'rescue_equipment',
          'fuel',
          'power_equipment',
          'communication_equipment',
          'transportation',
          'other',
        ]),
        itemName: z.string().min(2),
        quantity: z.number().int().positive(),
        unit: z.string().default('units'),
      })
    )
    .min(1),
  notes: z.string().max(1500).default(''),
  deliveryDeadline: z.string().nullable().optional(),
  requestingOrg: z.string().max(160).optional(),
  mode: z.enum(['operational', 'demo']).default('demo'),
});

api.get('/relief-requests', (req, res) => {
  const mode = parseMode(req.query.mode);
  const list = store.state.reliefRequests
    .filter((r) => r.mode === mode)
    .sort((a, b) => b.priorityScore - a.priorityScore);
  res.json({ requests: list });
});

api.get('/relief-requests/demand-summary', (req, res) => {
  const mode = parseMode(req.query.mode);
  res.json(computeDemandSupplyIntelligence(mode));
});

api.get('/relief-requests/:id', (req, res) => {
  const id = getParam(req.params.id);
  const target = store.state.reliefRequests.find((r) => r.id === id);
  if (!target) return res.status(404).json({ error: 'Relief request not found' });
  const warehouseMatches = matchWarehousesForRequest(target);
  const reservations = store.state.stockReservations.filter((r) => r.requestId === id);
  res.json({ request: target, warehouseMatches, reservations });
});

api.patch('/relief-requests/:id', requirePermission('relief:prioritize'), (req: AuthedRequest, res) => {
  const id = getParam(req.params.id);
  const target = store.state.reliefRequests.find((r) => r.id === id);
  if (!target) return res.status(404).json({ error: 'Relief request not found' });

  const schema = z.object({
    urgency: z.enum(['low', 'medium', 'high', 'critical']).optional(),
    notes: z.string().max(1500).optional(),
    deliveryDeadline: z.string().nullable().optional(),
    status: z.enum(['submitted', 'verified', 'prioritized', 'allocated', 'approved', 'dispatched', 'delivered', 'closed']).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid relief request update', details: parsed.error.flatten() });
  }
  Object.assign(target, parsed.data, { updatedAt: new Date().toISOString() });
  store.save();
  res.json({ request: target });
});

api.post('/relief-requests/:id/verify', requirePermission('relief:verify'), (req: AuthedRequest, res) => {
  const id = getParam(req.params.id);
  const target = store.state.reliefRequests.find((r) => r.id === id);
  if (!target) return res.status(404).json({ error: 'Relief request not found' });

  const actor = req.actor!;
  target.verificationStatus = 'verified';
  if (target.status === 'submitted') target.status = 'verified';
  target.updatedAt = new Date().toISOString();
  store.save();

  store.addAudit({
    actor: actor.name,
    role: actor.role,
    orgId: actor.orgId,
    action: 'relief_request.verified',
    entityType: 'relief_request',
    entityId: target.id,
    summary: `Verified relief request for ${target.locationName}`,
    mode: target.mode,
  });

  eventBus.publish({
    event_type: 'relief_request.verified',
    organization_id: actor.orgId,
    entity_id: target.id,
    source: 'relief-api',
    mode: target.mode,
    payload: { request: target },
  });

  res.json({ request: target });
});

api.post('/relief-requests/:id/allocate', requirePermission('allocation:recommend'), async (req: AuthedRequest, res) => {
  const id = getParam(req.params.id);
  const target = store.state.reliefRequests.find((r) => r.id === id);
  if (!target) return res.status(404).json({ error: 'Relief request not found' });

  const warehouseMatches = matchWarehousesForRequest(target);
  const allocation = await generateAllocationRecommendation(target);

  if (allocation.unmetItems.length > 0) {
    store.triggerAlert({
      dedupKey: `unfulfilled_demand:${target.id}`,
      incidentId: target.incidentId,
      alertType: 'unfulfilled_demand',
      severity: target.urgency === 'critical' ? 'critical' : 'high',
      title: `Unfulfilled Demand: ${target.locationName}`,
      message: `${allocation.unmetItems.length} resource line(s) have remaining shortage after matching available operational warehouses.`,
      triggerFactor: allocation.unmetItems.map((u) => `${u.itemName}: -${u.quantity} ${u.unit}`).join(', '),
      source: 'warehouse_matching_engine',
      mode: target.mode,
    });
  }

  res.status(201).json({ allocation, warehouseMatches });
});

api.post('/relief-requests', requirePermission('relief:create'), (req: AuthedRequest, res) => {
  const parsed = ReliefCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid relief request payload', details: parsed.error.flatten() });
  }
  const data = parsed.data;
  const actor = req.actor!;
  const now = new Date().toISOString();

  // Mask raw phone/contact minimally for operational privacy
  const contactMasked =
    data.contact.length > 5
      ? `${data.contact.slice(0, 3)}***${data.contact.slice(-2)}`
      : data.contact;

  const items = data.items.map((it) => ({ ...it, fulfilledQuantity: 0 }));
  const prio = calculatePriority({
    incidentId: data.incidentId,
    peopleAffected: data.peopleAffected,
    vulnerableGroups: data.vulnerableGroups,
    urgency: data.urgency,
    items,
    lat: data.lat,
    lng: data.lng,
    mode: data.mode,
  });

  const request: ReliefRequest = {
    id: uuidv4(),
    incidentId: data.incidentId,
    orgId: actor.orgId,
    requestingOrg: data.requestingOrg || actor.orgId,
    requesterRole: actor.role,
    requesterName: data.requesterName,
    contactMasked,
    locationName: data.locationName,
    lat: data.lat,
    lng: data.lng,
    peopleAffected: data.peopleAffected,
    familiesAffected: data.familiesAffected,
    vulnerableGroups: data.vulnerableGroups,
    urgency: data.urgency,
    deliveryDeadline: data.deliveryDeadline ?? null,
    items,
    notes: data.notes,
    status: 'prioritized',
    verificationStatus: actor.role === 'citizen_reporter' ? 'unverified' : 'verified',
    fulfillmentStatus: 'unfulfilled',
    priorityScore: prio.score,
    priorityCategory: prio.category,
    priorityBreakdown: prio.breakdown,
    mode: data.mode,
    ownerId: actor.uid,
    createdAt: now,
    updatedAt: now,
  };

  store.state.reliefRequests.unshift(request);
  store.save();

  store.triggerAlert({
    dedupKey: `new_relief_request:${request.id}`,
    incidentId: request.incidentId,
    alertType: 'new_relief_request',
    severity: request.urgency === 'critical' ? 'critical' : request.urgency === 'high' ? 'high' : 'info',
    title: `New Relief Request: ${request.locationName}`,
    message: `${request.requesterName} requested ${request.items.map((i) => `${i.quantity} ${i.unit} ${i.itemName}`).join(', ')} (${request.peopleAffected} affected).`,
    triggerFactor: `urgency=${request.urgency}, priority=${request.priorityScore}`,
    source: 'relief_request_api',
    mode: request.mode,
  });

  store.addAudit({
    actor: actor.name,
    role: actor.role,
    orgId: actor.orgId,
    action: 'relief_request.created',
    entityType: 'relief_request',
    entityId: request.id,
    summary: `Submitted ${request.priorityCategory} relief request (${request.priorityScore}/100) for ${request.locationName}`,
    mode: request.mode,
  });

  eventBus.publish({
    event_type: 'relief_request.created',
    organization_id: actor.orgId,
    entity_id: request.id,
    source: 'relief-api',
    mode: request.mode,
    payload: { request },
  });

  res.status(201).json({ request });
});

api.post('/relief-requests/:id/prioritize', requirePermission('relief:prioritize'), (req: AuthedRequest, res) => {
  const id = getParam(req.params.id);
  const target = store.state.reliefRequests.find((r) => r.id === id);
  if (!target) return res.status(404).json({ error: 'Relief request not found' });

  const prio = calculatePriority(target, target.priorityBreakdown.override);
  target.priorityScore = prio.score;
  target.priorityCategory = prio.category;
  target.priorityBreakdown = prio.breakdown;
  if (target.status === 'submitted' || target.status === 'verified') {
    target.status = 'prioritized';
  }
  target.updatedAt = new Date().toISOString();
  store.save();

  eventBus.publish({
    event_type: 'relief_request.prioritized',
    organization_id: req.actor!.orgId,
    entity_id: target.id,
    source: 'priority-engine',
    mode: target.mode,
    payload: { request: target },
  });

  res.json({ request: target });
});

api.post('/relief-requests/:id/override-priority', requirePermission('relief:override'), (req: AuthedRequest, res) => {
  const id = getParam(req.params.id);
  const target = store.state.reliefRequests.find((r) => r.id === id);
  if (!target) return res.status(404).json({ error: 'Relief request not found' });

  const newCategory = req.body?.newCategory;
  const reason = String(req.body?.reason || '').trim();
  if (!['low', 'medium', 'high', 'critical'].includes(newCategory) || reason.length < 5) {
    return res.status(400).json({ error: 'Valid newCategory and mandatory override reason (>=5 chars) required.' });
  }

  const actor = req.actor!;
  const now = new Date().toISOString();
  const previousCategory = target.priorityCategory;
  target.priorityCategory = newCategory;
  target.priorityBreakdown.override = {
    previousCategory,
    newCategory,
    reason,
    userId: actor.name,
    timestamp: now,
  };
  target.updatedAt = now;
  store.save();

  store.addAudit({
    actor: actor.name,
    role: actor.role,
    orgId: actor.orgId,
    action: 'relief_request.priority_overridden',
    entityType: 'relief_request',
    entityId: target.id,
    summary: `Overrode priority ${previousCategory} -> ${newCategory} (${reason})`,
    mode: target.mode,
  });

  eventBus.publish({
    event_type: 'relief_request.priority_overridden',
    organization_id: actor.orgId,
    entity_id: target.id,
    source: 'priority-engine',
    mode: target.mode,
    payload: { request: target },
  });

  res.json({ request: target });
});

// ============================================================================
// 6. WAREHOUSES, REAL INVENTORY CATALOG, ATOMIC LEDGER, RESERVATIONS & SUPPLIES
// ============================================================================

const ResourceCategoryEnum = z.enum([
  'drinking_water',
  'food',
  'medical_kits',
  'medicines',
  'shelter',
  'blankets',
  'clothing',
  'hygiene_kits',
  'rescue_equipment',
  'fuel',
  'power_equipment',
  'communication_equipment',
  'transportation',
  'other',
]);

const WarehouseStatusEnum = z.enum([
  'operational',
  'limited',
  'temporarily_closed',
  'temporarily_unavailable',
  'closed',
  'under_maintenance',
  'unknown',
]);

const WarehouseTypeEnum = z.enum([
  'central_hub',
  'regional_depot',
  'medical_cold_chain',
  'forward_staging',
  'mobile_unit',
  'ngo_partner',
]);

function handleInventoryError(res: express.Response, err: unknown) {
  if (err instanceof InventoryEngineError) {
    return res.status(err.statusCode).json({ error: err.message, code: err.code, details: err.details });
  }
  const msg = err instanceof Error ? err.message : 'Inventory operation failed';
  return res.status(500).json({ error: msg });
}

api.get('/warehouses', (req, res) => {
  const mode = parseMode(req.query.mode);
  const search = String(req.query.search || '').trim().toLowerCase();
  const district = String(req.query.district || '').trim().toLowerCase();
  const status = String(req.query.status || '').trim();
  const warehouseType = String(req.query.type || '').trim();
  const minCapacity = req.query.minCapacity ? Number(req.query.minCapacity) : 0;
  const activeOnly = req.query.activeOnly === 'true';
  const page = Math.max(1, Number(req.query.page || 1));
  const limit = Math.min(200, Math.max(1, Number(req.query.limit || 100)));

  let list = store.state.warehouses.filter((w) => w.mode === mode);
  if (search) {
    list = list.filter(
      (w) =>
        w.name.toLowerCase().includes(search) ||
        w.location.toLowerCase().includes(search) ||
        (w.district || w.region).toLowerCase().includes(search) ||
        (w.managerName || '').toLowerCase().includes(search)
    );
  }
  if (district && district !== 'all') {
    list = list.filter((w) => (w.district || w.region).toLowerCase().includes(district));
  }
  if (status && status !== 'all') {
    list = list.filter((w) => w.status === status);
  }
  if (warehouseType && warehouseType !== 'all') {
    list = list.filter((w) => w.warehouseType === warehouseType);
  }
  if (minCapacity > 0 && Number.isFinite(minCapacity)) {
    list = list.filter((w) => w.capacityUnits >= minCapacity);
  }
  if (activeOnly) {
    list = list.filter((w) => w.active !== false);
  }

  const total = list.length;
  const paged = list.slice((page - 1) * limit, page * limit);
  res.json({ warehouses: paged, total, page, limit });
});

api.post('/warehouses', requirePermission('warehouse:manage'), (req: AuthedRequest, res) => {
  const schema = z.object({
    name: z.string().min(2).max(150),
    warehouseType: WarehouseTypeEnum.optional().default('regional_depot'),
    location: z.string().min(2).max(200),
    region: z.string().min(2).max(120),
    district: z.string().max(120).optional(),
    state: z.string().max(120).optional(),
    country: z.string().max(120).optional(),
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    managerName: z.string().max(120).optional(),
    capacityUnits: z.number().int().positive(),
    status: WarehouseStatusEnum.default('operational'),
    contact: z.string().default('Command Liaison'),
    operatingHours: z.string().default('24/7'),
    accessibility: z.enum(['high', 'moderate', 'restricted']).default('high'),
    supportedResponseTypes: z.array(z.string()).optional(),
    active: z.boolean().optional().default(true),
    mode: z.enum(['operational', 'demo']).default('demo'),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid warehouse payload', details: parsed.error.flatten() });
  }
  const now = new Date().toISOString();
  const wh: Warehouse = {
    id: uuidv4(),
    ...parsed.data,
    district: parsed.data.district || parsed.data.region,
    state: parsed.data.state || '',
    country: parsed.data.country || '',
    supportedResponseTypes: (parsed.data.supportedResponseTypes || []) as Warehouse['supportedResponseTypes'],
    orgId: req.actor!.orgId,
    usedUnits: 0,
    lastVerified: now,
    createdAt: now,
    updatedAt: now,
  };
  store.state.warehouses.unshift(wh);
  store.save();

  store.addAudit({
    actor: req.actor!.name,
    role: req.actor!.role,
    orgId: req.actor!.orgId,
    action: 'warehouse.created',
    entityType: 'warehouse',
    entityId: wh.id,
    summary: `Registered warehouse ${wh.name} (${wh.status})`,
    mode: wh.mode,
  });

  eventBus.publish({
    event_type: 'warehouse.status_changed',
    organization_id: req.actor!.orgId,
    entity_id: wh.id,
    source: 'warehouse-api',
    mode: wh.mode,
    payload: { warehouse: wh, action: 'created' },
  });

  res.status(201).json({ warehouse: wh });
});

api.get('/warehouses/:id', (req, res) => {
  const id = getParam(req.params.id);
  const wh = store.state.warehouses.find((w) => w.id === id);
  if (!wh) return res.status(404).json({ error: 'Warehouse not found' });
  const vehicles = store.state.vehicles.filter((v) => v.warehouseId === id);
  res.json({ warehouse: wh, availableVehicles: vehicles });
});

api.patch('/warehouses/:id', requirePermission('warehouse:manage'), (req: AuthedRequest, res) => {
  const id = getParam(req.params.id);
  const wh = store.state.warehouses.find((w) => w.id === id);
  if (!wh) return res.status(404).json({ error: 'Warehouse not found' });

  const schema = z.object({
    name: z.string().min(2).max(150).optional(),
    warehouseType: WarehouseTypeEnum.optional(),
    location: z.string().min(2).max(200).optional(),
    region: z.string().min(2).max(120).optional(),
    district: z.string().max(120).optional(),
    state: z.string().max(120).optional(),
    country: z.string().max(120).optional(),
    lat: z.number().min(-90).max(90).optional(),
    lng: z.number().min(-180).max(180).optional(),
    managerName: z.string().max(120).optional(),
    capacityUnits: z.number().int().positive().optional(),
    status: WarehouseStatusEnum.optional(),
    contact: z.string().optional(),
    operatingHours: z.string().optional(),
    accessibility: z.enum(['high', 'moderate', 'restricted']).optional(),
    supportedResponseTypes: z.array(z.string()).optional(),
    active: z.boolean().optional(),
    verifyNow: z.boolean().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid warehouse update payload', details: parsed.error.flatten() });
  }

  const prevStatus = wh.status;
  const prevActive = wh.active;
  const { verifyNow, supportedResponseTypes, ...rest } = parsed.data;
  const now = new Date().toISOString();

  Object.assign(wh, rest, { updatedAt: now });
  if (supportedResponseTypes !== undefined) {
    wh.supportedResponseTypes = supportedResponseTypes as Warehouse['supportedResponseTypes'];
  }
  if (verifyNow) wh.lastVerified = now;
  store.save();

  const statusChanged = wh.status !== prevStatus || wh.active !== prevActive;
  if (statusChanged) {
    if (
      wh.active === false ||
      wh.status === 'closed' ||
      wh.status === 'temporarily_unavailable' ||
      wh.status === 'temporarily_closed' ||
      wh.status === 'under_maintenance'
    ) {
      store.triggerAlert({
        dedupKey: `warehouse_unavailable:${wh.id}:${wh.status}:${wh.active}`,
        warehouseId: wh.id,
        warehouseName: wh.name,
        alertType: 'warehouse_unavailable',
        severity: 'high',
        title: `Warehouse Unavailable: ${wh.name}`,
        message: `Warehouse operational status changed from ${prevStatus} to ${wh.status}${wh.active === false ? ' (Deactivated)' : ''}. Active dispatches should reroute.`,
        triggerFactor: `status=${wh.status}, active=${wh.active !== false}`,
        previousValue: prevStatus,
        currentValue: wh.status,
        source: `warehouse_api:${req.actor!.name}`,
        mode: wh.mode,
      });
    }

    eventBus.publish({
      event_type: 'warehouse.status_changed',
      organization_id: req.actor!.orgId,
      entity_id: wh.id,
      source: 'warehouse-api',
      mode: wh.mode,
      payload: { warehouseId: wh.id, warehouseName: wh.name, previousStatus: prevStatus, status: wh.status, active: wh.active },
    });
  }

  store.addAudit({
    actor: req.actor!.name,
    role: req.actor!.role,
    orgId: req.actor!.orgId,
    action: 'warehouse.updated',
    entityType: 'warehouse',
    entityId: wh.id,
    summary: `Updated warehouse ${wh.name} (status: ${wh.status}, active: ${wh.active !== false})`,
    mode: wh.mode,
  });

  res.json({ warehouse: wh });
});

api.get('/warehouses/:id/inventory', (req, res) => {
  const id = getParam(req.params.id);
  const wh = store.state.warehouses.find((w) => w.id === id);
  if (!wh) return res.status(404).json({ error: 'Warehouse not found' });
  const items = store.state.inventory
    .filter((i) => i.warehouseId === id)
    .map((i) => ({
      ...i,
      stockStatus: classifyStockLevel(i),
      criticalStock: getCriticalThreshold(i),
      freshnessStatus: computeFreshness(i.updatedAt, store.state.settings.inventoryFreshnessSeconds),
    }));
  res.json({ warehouse: wh, inventory: items });
});

api.get('/warehouses/:id/movements', (req, res) => {
  const id = getParam(req.params.id);
  const wh = store.state.warehouses.find((w) => w.id === id);
  if (!wh) return res.status(404).json({ error: 'Warehouse not found' });
  const limit = Math.min(200, Math.max(1, Number(req.query.limit || 50)));
  const movements = store.state.stockMovements.filter((m) => m.warehouseId === id).slice(0, limit);
  res.json({ warehouse: wh, movements });
});

api.get('/warehouses/:id/summary', (req, res) => {
  const id = getParam(req.params.id);
  const wh = store.state.warehouses.find((w) => w.id === id);
  if (!wh) return res.status(404).json({ error: 'Warehouse not found' });

  const inventory = store.state.inventory
    .filter((i) => i.warehouseId === id)
    .map((i) => ({ ...i, stockStatus: classifyStockLevel(i), criticalStock: getCriticalThreshold(i) }));
  const movements = store.state.stockMovements.filter((m) => m.warehouseId === id).slice(0, 30);
  const pendingOutgoingDispatches = store.state.dispatches.filter(
    (d) => d.warehouseId === id && d.status !== 'delivered' && d.status !== 'cancelled'
  );
  const activeReservations = store.state.stockReservations.filter(
    (r) => r.warehouseId === id && (r.status === 'Reserved' || r.status === 'Partially Reserved' || r.status === 'Allocated')
  );
  const incomingSupplies = store.state.incomingSupplies.filter(
    (s) => s.warehouseId === id && s.status !== 'Verified' && s.status !== 'Cancelled'
  );
  const vehicles = store.state.vehicles.filter((v) => v.warehouseId === id);

  res.json({
    warehouse: wh,
    stats: {
      skuCount: inventory.length,
      totalOnHand: inventory.reduce((s, i) => s + i.totalQty, 0),
      totalAvailable: inventory.reduce((s, i) => s + i.availableQty, 0),
      totalReserved: inventory.reduce((s, i) => s + i.reservedQty, 0),
      lowOrCriticalCount: inventory.filter((i) => i.stockStatus !== 'NORMAL').length,
      utilizationPct: wh.capacityUnits > 0 ? Math.min(100, Math.round((wh.usedUnits / wh.capacityUnits) * 100)) : 0,
    },
    inventory,
    movements,
    pendingOutgoingDispatches,
    activeReservations,
    incomingSupplies,
    vehicles,
  });
});

// --- Inventory Catalog (/api/v1/inventory/items) ---

api.get('/inventory/items', (req, res) => {
  const mode = parseMode(req.query.mode);
  const search = String(req.query.search || '').trim().toLowerCase();
  const category = String(req.query.category || '').trim();
  const activeOnly = req.query.activeOnly === 'true';

  let items = store.state.inventoryCatalog.filter((c) => c.mode === mode);
  if (search) {
    items = items.filter(
      (c) =>
        c.name.toLowerCase().includes(search) ||
        c.sku.toLowerCase().includes(search) ||
        c.categoryGroup.toLowerCase().includes(search) ||
        c.supplier.toLowerCase().includes(search)
    );
  }
  if (category && category !== 'all') {
    items = items.filter((c) => c.category === category || c.categoryGroup === category);
  }
  if (activeOnly) {
    items = items.filter((c) => c.active);
  }
  res.json({ items, total: items.length });
});

api.post('/inventory/items', requirePermission('inventory:catalog'), (req: AuthedRequest, res) => {
  const schema = z.object({
    sku: z.string().min(2).max(60),
    name: z.string().min(2).max(160),
    category: ResourceCategoryEnum,
    description: z.string().max(600).default(''),
    unit: z.string().min(1).max(40).default('units'),
    minStock: z.number().int().min(0).default(100),
    criticalStock: z.number().int().min(0).optional(),
    reorderQty: z.number().int().min(0).default(150),
    storageRequirements: z.string().max(250).default('Standard dry storage'),
    expiryTracking: z.boolean().default(false),
    supplier: z.string().max(160).default('Verified Relief Supplier'),
    active: z.boolean().default(true),
    mode: z.enum(['operational', 'demo']).default('demo'),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid catalog item payload', details: parsed.error.flatten() });
  }
  const data = parsed.data;
  const dup = store.state.inventoryCatalog.find(
    (c) => c.mode === data.mode && c.sku.toLowerCase() === data.sku.toLowerCase()
  );
  if (dup) {
    return res.status(409).json({ error: `SKU "${data.sku}" already exists in catalog` });
  }

  const now = new Date().toISOString();
  const item: InventoryCatalogItem = {
    id: uuidv4(),
    sku: data.sku.trim(),
    name: data.name.trim(),
    category: data.category,
    categoryGroup: mapCategoryToGroup(data.category),
    description: data.description,
    unit: data.unit,
    minStock: data.minStock,
    criticalStock: data.criticalStock ?? Math.max(1, Math.floor(data.minStock * 0.5)),
    reorderQty: data.reorderQty,
    storageRequirements: data.storageRequirements,
    expiryTracking: data.expiryTracking,
    supplier: data.supplier,
    active: data.active,
    mode: data.mode,
    createdAt: now,
    updatedAt: now,
  };

  store.state.inventoryCatalog.unshift(item);
  store.save();

  store.addAudit({
    actor: req.actor!.name,
    role: req.actor!.role,
    orgId: req.actor!.orgId,
    action: 'inventory_catalog.created',
    entityType: 'inventory_catalog',
    entityId: item.id,
    summary: `Added catalog item ${item.name} (${item.sku})`,
    mode: item.mode,
  });

  res.status(201).json({ item });
});

api.get('/inventory/items/:id', (req, res) => {
  const id = getParam(req.params.id);
  const item = store.state.inventoryCatalog.find((c) => c.id === id);
  if (!item) return res.status(404).json({ error: 'Catalog item not found' });
  const stockRecords = store.state.inventory.filter((s) => s.itemId === id || s.sku === item.sku);
  res.json({ item, stockRecords });
});

api.patch('/inventory/items/:id', requirePermission('inventory:catalog'), (req: AuthedRequest, res) => {
  const id = getParam(req.params.id);
  const item = store.state.inventoryCatalog.find((c) => c.id === id);
  if (!item) return res.status(404).json({ error: 'Catalog item not found' });

  const schema = z.object({
    name: z.string().min(2).max(160).optional(),
    category: ResourceCategoryEnum.optional(),
    description: z.string().max(600).optional(),
    unit: z.string().min(1).max(40).optional(),
    minStock: z.number().int().min(0).optional(),
    criticalStock: z.number().int().min(0).optional(),
    reorderQty: z.number().int().min(0).optional(),
    storageRequirements: z.string().max(250).optional(),
    expiryTracking: z.boolean().optional(),
    supplier: z.string().max(160).optional(),
    active: z.boolean().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid catalog item update', details: parsed.error.flatten() });
  }
  Object.assign(item, parsed.data, { updatedAt: new Date().toISOString() });
  if (parsed.data.category) item.categoryGroup = mapCategoryToGroup(parsed.data.category);
  store.save();
  res.json({ item });
});

// --- Inventory Stock, Ledger Operations, Alerts, Shortages, Expiry & Analytics ---

api.get('/inventory/stock', (req, res) => {
  const mode = parseMode(req.query.mode);
  const warehouseId = req.query.warehouseId ? String(req.query.warehouseId) : '';
  const category = req.query.category ? String(req.query.category) : '';
  const status = req.query.status ? String(req.query.status) : '';
  const search = String(req.query.search || '').trim().toLowerCase();
  const page = Math.max(1, Number(req.query.page || 1));
  const limit = Math.min(200, Math.max(1, Number(req.query.limit || 100)));

  let list = store.state.inventory
    .filter((i) => i.mode === mode)
    .map((i) => ({
      ...i,
      stockStatus: classifyStockLevel(i),
      criticalStock: getCriticalThreshold(i),
      freshnessStatus: computeFreshness(i.updatedAt, store.state.settings.inventoryFreshnessSeconds),
    }));

  if (warehouseId && warehouseId !== 'all') list = list.filter((i) => i.warehouseId === warehouseId);
  if (category && category !== 'all') list = list.filter((i) => i.category === category);
  if (status && status !== 'all') list = list.filter((i) => i.stockStatus === status);
  if (search) {
    list = list.filter((i) => i.itemName.toLowerCase().includes(search) || i.sku.toLowerCase().includes(search));
  }

  const total = list.length;
  const paged = list.slice((page - 1) * limit, page * limit);
  res.json({ stock: paged, inventory: paged, total, page, limit });
});

api.get('/inventory/stock/:id', (req, res) => {
  const id = getParam(req.params.id);
  const stock = store.state.inventory.find((i) => i.id === id);
  if (!stock) return res.status(404).json({ error: 'Stock record not found' });
  const movements = store.state.stockMovements.filter((m) => m.stockId === id).slice(0, 50);
  const batches = store.state.inventoryBatches.filter((b) => b.stockId === id);
  const reservations = store.state.stockReservations.filter((r) => r.stockId === id);
  res.json({
    stock: { ...stock, stockStatus: classifyStockLevel(stock), criticalStock: getCriticalThreshold(stock) },
    movements,
    batches,
    reservations,
  });
});

api.post('/inventory/receive', requirePermission('inventory:move'), async (req: AuthedRequest, res) => {
  const schema = z.object({
    stockId: z.string().optional(),
    warehouseId: z.string().optional(),
    itemId: z.string().optional(),
    sku: z.string().optional(),
    itemName: z.string().optional(),
    category: ResourceCategoryEnum.optional(),
    unit: z.string().optional(),
    quantity: z.number().int().positive(),
    reason: z.string().min(3).max(400).default('Inbound stock receipt'),
    referenceId: z.string().optional(),
    idempotencyKey: z.string().optional(),
    lotNumber: z.string().optional(),
    expiryDate: z.string().nullable().optional(),
    batchLocation: z.string().optional(),
    mode: z.enum(['operational', 'demo']).default('demo'),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid receive stock payload', details: parsed.error.flatten() });
  }
  const d = parsed.data;
  try {
    let stockId = d.stockId;
    if (!stockId) {
      if (!d.warehouseId) {
        return res.status(400).json({ error: 'Either stockId or warehouseId + sku/itemId is required' });
      }
      const wh = store.state.warehouses.find((w) => w.id === d.warehouseId);
      if (!wh) return res.status(404).json({ error: 'Warehouse not found' });

      const catalogItem = d.itemId
        ? store.state.inventoryCatalog.find((c) => c.id === d.itemId)
        : d.sku
          ? store.state.inventoryCatalog.find((c) => c.sku === d.sku && c.mode === wh.mode)
          : undefined;

      const resolvedSku = d.sku || catalogItem?.sku;
      const resolvedName = d.itemName || catalogItem?.name;
      if (!resolvedSku || !resolvedName) {
        return res.status(400).json({ error: 'SKU and itemName (or valid itemId) are required to create stock record' });
      }

      let existing = store.state.inventory.find(
        (s) => s.warehouseId === wh.id && s.sku === resolvedSku && s.mode === wh.mode
      );
      if (!existing) {
        const now = new Date().toISOString();
        existing = {
          id: uuidv4(),
          itemId: catalogItem?.id || d.itemId,
          warehouseId: wh.id,
          sku: resolvedSku,
          itemName: resolvedName,
          category: d.category || catalogItem?.category || 'other',
          unit: d.unit || catalogItem?.unit || 'units',
          totalQty: 0,
          availableQty: 0,
          reservedQty: 0,
          inTransitQty: 0,
          damagedQty: 0,
          expiredQty: 0,
          minStock: catalogItem?.minStock ?? 100,
          criticalStock: catalogItem?.criticalStock ?? 50,
          reorderThreshold: catalogItem?.reorderQty ?? 150,
          stockStatus: 'OUT_OF_STOCK',
          version: 1,
          mode: wh.mode,
          updatedAt: now,
        };
        store.state.inventory.unshift(existing);
      }
      stockId = existing.id;
    }

    const result = await withStockLock([stockId], () =>
      commitAtomicStockMovement({
        stockId: stockId!,
        type: 'inbound',
        quantity: d.quantity,
        reason: d.reason,
        referenceId: d.referenceId,
        idempotencyKey: d.idempotencyKey,
        actor: { name: req.actor!.name, role: req.actor!.role, orgId: req.actor!.orgId },
      })
    );

    let batch: InventoryBatch | null = null;
    if (d.lotNumber || d.expiryDate !== undefined) {
      const now = new Date().toISOString();
      batch = {
        id: uuidv4(),
        stockId: result.stock.id,
        warehouseId: result.stock.warehouseId,
        itemId: result.stock.itemId,
        sku: result.stock.sku,
        itemName: result.stock.itemName,
        lotNumber: d.lotNumber || `LOT-${Date.now().toString(36).toUpperCase()}`,
        quantity: d.quantity,
        receivedDate: now,
        expiryDate: d.expiryDate ?? null,
        qualityStatus: 'good',
        storageRequirements: 'Standard warehouse storage',
        batchLocation: d.batchLocation || 'Receiving Bay',
        mode: result.stock.mode,
        createdAt: now,
        updatedAt: now,
      };
      store.state.inventoryBatches.unshift(batch);
      store.save();
    }

    res.status(result.idempotentReplay ? 200 : 201).json({
      stock: result.stock,
      item: result.stock,
      movement: result.movement,
      batch,
      idempotentReplay: result.idempotentReplay,
    });
  } catch (err) {
    return handleInventoryError(res, err);
  }
});

api.post('/inventory/dispatch', requirePermission('inventory:move'), async (req: AuthedRequest, res) => {
  const schema = z.object({
    stockId: z.string().min(1),
    quantity: z.number().int().positive(),
    reason: z.string().min(3).max(400).default('Emergency field dispatch'),
    referenceId: z.string().optional(),
    idempotencyKey: z.string().optional(),
    expectedVersion: z.number().int().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid dispatch stock payload', details: parsed.error.flatten() });
  }
  try {
    const result = await withStockLock([parsed.data.stockId], () =>
      commitAtomicStockMovement({
        ...parsed.data,
        type: 'outbound',
        actor: { name: req.actor!.name, role: req.actor!.role, orgId: req.actor!.orgId },
      })
    );
    res.status(result.idempotentReplay ? 200 : 201).json({
      stock: result.stock,
      item: result.stock,
      movement: result.movement,
      alert: result.alert,
      idempotentReplay: result.idempotentReplay,
    });
  } catch (err) {
    return handleInventoryError(res, err);
  }
});

api.post('/inventory/adjust', requirePermission('inventory:adjust'), async (req: AuthedRequest, res) => {
  const schema = z.object({
    stockId: z.string().min(1),
    type: z.enum(['adjustment', 'damage', 'expiry', 'return', 'reconciliation']).default('adjustment'),
    quantity: z.number().int().refine((n) => n !== 0, 'Quantity cannot be zero'),
    reason: z.string().min(3).max(400),
    referenceId: z.string().optional(),
    expectedVersion: z.number().int().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid stock adjustment payload', details: parsed.error.flatten() });
  }
  try {
    const result = await withStockLock([parsed.data.stockId], () =>
      commitAtomicStockMovement({
        ...parsed.data,
        actor: { name: req.actor!.name, role: req.actor!.role, orgId: req.actor!.orgId },
      })
    );
    res.status(201).json({
      stock: result.stock,
      item: result.stock,
      movement: result.movement,
      alert: result.alert,
    });
  } catch (err) {
    return handleInventoryError(res, err);
  }
});

api.post('/inventory/transfer', requirePermission('inventory:transfer'), async (req: AuthedRequest, res) => {
  const schema = z.object({
    sourceStockId: z.string().min(1),
    destinationWarehouseId: z.string().min(1),
    quantity: z.number().int().positive(),
    reason: z.string().min(3).max(400).default('Inter-warehouse stock rebalancing'),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid warehouse transfer payload', details: parsed.error.flatten() });
  }
  try {
    const result = await executeWarehouseTransfer({
      ...parsed.data,
      actor: { name: req.actor!.name, role: req.actor!.role, orgId: req.actor!.orgId },
    });
    res.status(201).json(result);
  } catch (err) {
    return handleInventoryError(res, err);
  }
});

api.get('/inventory/movements', (req, res) => {
  const mode = parseMode(req.query.mode);
  const warehouseId = req.query.warehouseId ? String(req.query.warehouseId) : '';
  const stockId = req.query.stockId ? String(req.query.stockId) : '';
  const type = req.query.type ? String(req.query.type) : '';
  const page = Math.max(1, Number(req.query.page || 1));
  const limit = Math.min(200, Math.max(1, Number(req.query.limit || 60)));

  let list = store.state.stockMovements.filter((m) => m.mode === mode);
  if (warehouseId && warehouseId !== 'all') list = list.filter((m) => m.warehouseId === warehouseId);
  if (stockId) list = list.filter((m) => m.stockId === stockId);
  if (type && type !== 'all') list = list.filter((m) => m.type === type);

  const total = list.length;
  const paged = list.slice((page - 1) * limit, page * limit);
  res.json({ movements: paged, total, page, limit });
});

api.get('/inventory/alerts', (req, res) => {
  const mode = parseMode(req.query.mode);
  const status = req.query.status ? String(req.query.status) : '';
  const invAlertTypes = new Set([
    'inventory_low_stock',
    'inventory_critical_stock',
    'inventory_out_of_stock',
    'new_relief_request',
    'unfulfilled_demand',
    'reservation_conflict',
    'inventory_expiring_supply',
    'inventory_expired_supply',
    'incoming_supply_delayed',
    'warehouse_unavailable',
    'stock_discrepancy',
  ]);
  let alerts = store.state.alerts.filter((a) => a.mode === mode && invAlertTypes.has(a.alertType));
  if (status && status !== 'all') alerts = alerts.filter((a) => a.status === status);
  res.json({ alerts, total: alerts.length });
});

api.get('/inventory/shortages', (req, res) => {
  const mode = parseMode(req.query.mode);
  res.json(computeShortagesAndReplenishment(mode));
});

api.get('/inventory/expiry', (req, res) => {
  const mode = parseMode(req.query.mode);
  res.json(evaluateInventoryExpiry(mode));
});

api.post('/inventory/batches', requirePermission('inventory:move'), (req: AuthedRequest, res) => {
  const schema = z.object({
    stockId: z.string().min(1),
    lotNumber: z.string().min(2).max(80),
    quantity: z.number().int().positive(),
    receivedDate: z.string().optional(),
    expiryDate: z.string().nullable().optional(),
    storageRequirements: z.string().max(250).default('Standard dry storage'),
    batchLocation: z.string().max(120).default('Main Racking'),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid batch payload', details: parsed.error.flatten() });
  }
  const stock = store.state.inventory.find((s) => s.id === parsed.data.stockId);
  if (!stock) return res.status(404).json({ error: 'Stock record not found' });

  const now = new Date().toISOString();
  const batch: InventoryBatch = {
    id: uuidv4(),
    stockId: stock.id,
    warehouseId: stock.warehouseId,
    itemId: stock.itemId,
    sku: stock.sku,
    itemName: stock.itemName,
    lotNumber: parsed.data.lotNumber,
    quantity: parsed.data.quantity,
    receivedDate: parsed.data.receivedDate || now,
    expiryDate: parsed.data.expiryDate ?? null,
    qualityStatus: 'good',
    storageRequirements: parsed.data.storageRequirements,
    batchLocation: parsed.data.batchLocation,
    mode: stock.mode,
    createdAt: now,
    updatedAt: now,
  };
  store.state.inventoryBatches.unshift(batch);
  store.save();

  // Immediately evaluate expiry so past-dated batches are quarantined accurately
  const expiryReport = evaluateInventoryExpiry(stock.mode, req.actor!.name);
  const latestBatch = store.state.inventoryBatches.find((b) => b.id === batch.id) || batch;

  res.status(201).json({ batch: latestBatch, expirySummary: expiryReport.summary });
});

api.get('/inventory/analytics/overview', (req, res) => {
  const mode = parseMode(req.query.mode);
  res.json(
    computeInventoryAnalyticsOverview(mode, {
      warehouseId: req.query.warehouseId ? String(req.query.warehouseId) : undefined,
      category: req.query.category ? String(req.query.category) : undefined,
      status: req.query.status ? String(req.query.status) : undefined,
    })
  );
});

api.get('/inventory/analytics/demand', (req, res) => {
  const mode = parseMode(req.query.mode);
  res.json(computeDemandSupplyIntelligence(mode));
});

api.get('/inventory/analytics/warehouse', (req, res) => {
  const mode = parseMode(req.query.mode);
  res.json({ warehouses: computeInventoryWarehouseAnalytics(mode) });
});

api.get('/inventory/analytics/movements', (req, res) => {
  const mode = parseMode(req.query.mode);
  res.json(computeInventoryMovementAnalytics(mode));
});

// --- Backwards-compatible Phase 1-3 Inventory Routes ---

api.get('/inventory', (req, res) => {
  const mode = parseMode(req.query.mode);
  const warehouseId = req.query.warehouseId ? String(req.query.warehouseId) : null;
  let items = store.state.inventory.filter((i) => i.mode === mode);
  if (warehouseId && warehouseId !== 'all') items = items.filter((i) => i.warehouseId === warehouseId);
  const movements = store.state.stockMovements.filter((m) => m.mode === mode).slice(0, 60);
  const shortages = items.filter((i) => i.availableQty < i.minStock);
  res.json({
    inventory: items.map((i) => ({
      ...i,
      stockStatus: classifyStockLevel(i),
      criticalStock: getCriticalThreshold(i),
      freshnessStatus: computeFreshness(i.updatedAt, store.state.settings.inventoryFreshnessSeconds),
    })),
    shortages,
    movements,
  });
});

api.post('/inventory', requirePermission('inventory:move'), (req: AuthedRequest, res) => {
  const schema = z.object({
    warehouseId: z.string().min(1),
    itemId: z.string().optional(),
    sku: z.string().min(2),
    itemName: z.string().min(2),
    category: ResourceCategoryEnum,
    unit: z.string().default('units'),
    availableQty: z.number().int().min(0),
    minStock: z.number().int().min(0).default(100),
    criticalStock: z.number().int().min(0).optional(),
    reorderThreshold: z.number().int().min(0).default(150),
    mode: z.enum(['operational', 'demo']).default('demo'),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid inventory item', details: parsed.error.flatten() });

  const now = new Date().toISOString();
  const item: InventoryStock = {
    id: uuidv4(),
    ...parsed.data,
    criticalStock: parsed.data.criticalStock ?? Math.max(1, Math.floor(parsed.data.minStock * 0.5)),
    totalQty: parsed.data.availableQty,
    reservedQty: 0,
    inTransitQty: 0,
    damagedQty: 0,
    expiredQty: 0,
    version: 1,
    updatedAt: now,
  };
  item.stockStatus = classifyStockLevel(item);
  store.state.inventory.unshift(item);
  syncWarehouseOccupancy(item.warehouseId);

  // Record opening balance ledger movement so every quantity has ledger traceability
  if (item.availableQty > 0) {
    store.state.stockMovements.unshift({
      id: uuidv4(),
      stockId: item.id,
      itemId: item.itemId,
      warehouseId: item.warehouseId,
      itemName: item.itemName,
      type: 'inbound',
      quantity: item.availableQty,
      previousAvailable: 0,
      newAvailable: item.availableQty,
      reason: 'Initial stock balance registered',
      actor: req.actor!.name,
      role: req.actor!.role,
      orgId: req.actor!.orgId,
      mode: item.mode,
      createdAt: now,
    });
  }

  store.save();
  evaluateStockAlerts(item, { name: req.actor!.name, role: req.actor!.role, orgId: req.actor!.orgId });

  eventBus.publish({
    event_type: 'inventory.updated',
    organization_id: req.actor!.orgId,
    entity_id: item.id,
    source: 'inventory-api',
    mode: item.mode,
    payload: { item },
  });

  res.status(201).json({ item });
});

api.post('/inventory/movements', requirePermission('inventory:move'), async (req: AuthedRequest, res) => {
  const schema = z.object({
    stockId: z.string().min(1),
    type: z.enum(['inbound', 'outbound', 'transfer', 'reservation', 'release', 'adjustment', 'damage', 'expiry', 'return', 'reconciliation']),
    quantity: z.number().int().refine((n) => n !== 0, 'Quantity cannot be zero'),
    reason: z.string().min(3).max(400),
    idempotencyKey: z.string().optional(),
    expectedVersion: z.number().int().optional(),
    referenceId: z.string().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid stock movement', details: parsed.error.flatten() });

  try {
    const result = await withStockLock([parsed.data.stockId], () =>
      commitAtomicStockMovement({
        ...parsed.data,
        actor: { name: req.actor!.name, role: req.actor!.role, orgId: req.actor!.orgId },
      })
    );
    if (result.idempotentReplay) {
      return res.status(200).json({ movement: result.movement, item: result.stock, idempotentReplay: true });
    }
    return res.status(201).json({ movement: result.movement, item: result.stock, alert: result.alert });
  } catch (err) {
    if (err instanceof InventoryEngineError) {
      // Preserve 400 status for insufficient stock on legacy /inventory/movements endpoint while keeping 409 for version conflict
      const status = err.code === 'VERSION_CONFLICT' ? 409 : err.code === 'STOCK_NOT_FOUND' ? 404 : 400;
      return res.status(status).json({ error: err.message, code: err.code });
    }
    return handleInventoryError(res, err);
  }
});

// --- Stock Reservations (/api/v1/reservations) ---

api.get('/reservations', (req, res) => {
  const mode = parseMode(req.query.mode);
  expireStaleReservations(mode);
  const warehouseId = req.query.warehouseId ? String(req.query.warehouseId) : '';
  const requestId = req.query.requestId ? String(req.query.requestId) : '';
  const status = req.query.status ? String(req.query.status) : '';

  let list = store.state.stockReservations.filter((r) => r.mode === mode);
  if (warehouseId && warehouseId !== 'all') list = list.filter((r) => r.warehouseId === warehouseId);
  if (requestId) list = list.filter((r) => r.requestId === requestId);
  if (status && status !== 'all') list = list.filter((r) => r.status === status);

  res.json({ reservations: list, total: list.length });
});

api.post('/reservations', requirePermission('reservation:manage'), async (req: AuthedRequest, res) => {
  const schema = z.object({
    stockId: z.string().min(1),
    requestedQty: z.number().int().positive(),
    allowPartial: z.boolean().optional().default(false),
    requestId: z.string().nullable().optional(),
    incidentId: z.string().nullable().optional(),
    expiresInHours: z.number().positive().max(720).optional().default(24),
    notes: z.string().max(400).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid reservation payload', details: parsed.error.flatten() });
  }
  try {
    const result = await createStockReservation({
      ...parsed.data,
      actor: { name: req.actor!.name, role: req.actor!.role, orgId: req.actor!.orgId },
    });
    res.status(201).json(result);
  } catch (err) {
    return handleInventoryError(res, err);
  }
});

api.get('/reservations/:id', (req, res) => {
  expireStaleReservations();
  const id = getParam(req.params.id);
  const reservation = store.state.stockReservations.find((r) => r.id === id);
  if (!reservation) return res.status(404).json({ error: 'Reservation not found' });
  res.json({ reservation });
});

api.post('/reservations/:id/release', requirePermission('reservation:manage'), async (req: AuthedRequest, res) => {
  const id = getParam(req.params.id);
  const reason = String(req.body?.reason || 'Released by logistics operator');
  try {
    const result = await releaseStockReservation(
      id,
      { name: req.actor!.name, role: req.actor!.role, orgId: req.actor!.orgId },
      reason
    );
    res.json(result);
  } catch (err) {
    return handleInventoryError(res, err);
  }
});

api.post('/reservations/:id/confirm', requirePermission('reservation:manage'), async (req: AuthedRequest, res) => {
  const id = getParam(req.params.id);
  const schema = z.object({
    status: z.enum(['Allocated', 'Dispatched', 'Delivered']).default('Allocated'),
    note: z.string().max(400).optional(),
  });
  const parsed = schema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid reservation confirmation payload', details: parsed.error.flatten() });
  }
  try {
    const result = await confirmStockReservation(
      id,
      { name: req.actor!.name, role: req.actor!.role, orgId: req.actor!.orgId },
      parsed.data.status,
      parsed.data.note
    );
    res.json(result);
  } catch (err) {
    return handleInventoryError(res, err);
  }
});

// --- Incoming Supplies & Procurement (/api/v1/supplies/incoming) ---

api.get('/supplies/incoming', (req, res) => {
  const mode = parseMode(req.query.mode);
  const warehouseId = req.query.warehouseId ? String(req.query.warehouseId) : '';
  const status = req.query.status ? String(req.query.status) : '';

  let list = store.state.incomingSupplies.filter((s) => s.mode === mode);
  if (warehouseId && warehouseId !== 'all') list = list.filter((s) => s.warehouseId === warehouseId);
  if (status && status !== 'all') list = list.filter((s) => s.status === status);

  // Flag overdue in-transit supplies cleanly
  const nowMs = Date.now();
  for (const sup of list) {
    if ((sup.status === 'In Transit' || sup.status === 'Approved') && new Date(sup.expectedArrival).getTime() < nowMs) {
      sup.status = 'Delayed';
      store.triggerAlert({
        dedupKey: `incoming_supply_delayed:${sup.id}`,
        warehouseId: sup.warehouseId,
        warehouseName: sup.warehouseName,
        alertType: 'incoming_supply_delayed',
        severity: 'warning',
        title: `Incoming Supply Delayed: ${sup.trackingReference}`,
        message: `Shipment from ${sup.supplier} to ${sup.warehouseName} passed expected arrival (${sup.expectedArrival}).`,
        triggerFactor: `expectedArrival=${sup.expectedArrival}`,
        source: 'supply_monitor',
        mode: sup.mode,
      });
    }
  }

  res.json({ supplies: list, total: list.length });
});

api.post('/supplies/incoming', requirePermission('supply:manage'), (req: AuthedRequest, res) => {
  const schema = z.object({
    supplier: z.string().min(2).max(160),
    warehouseId: z.string().min(1),
    trackingReference: z.string().min(2).max(80).optional(),
    expectedArrival: z.string().min(4),
    status: z.enum(['Pending', 'Approved', 'In Transit']).default('In Transit'),
    items: z
      .array(
        z.object({
          itemId: z.string().optional(),
          sku: z.string().min(2),
          itemName: z.string().min(2),
          category: ResourceCategoryEnum,
          unit: z.string().default('units'),
          orderedQty: z.number().int().positive(),
          lotNumber: z.string().optional(),
          expiryDate: z.string().nullable().optional(),
        })
      )
      .min(1),
    mode: z.enum(['operational', 'demo']).default('demo'),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid incoming supply payload', details: parsed.error.flatten() });
  }
  const d = parsed.data;
  const wh = store.state.warehouses.find((w) => w.id === d.warehouseId);
  if (!wh) return res.status(404).json({ error: 'Destination warehouse not found' });

  const now = new Date().toISOString();
  const order: IncomingSupplyOrder = {
    id: uuidv4(),
    supplier: d.supplier,
    warehouseId: wh.id,
    warehouseName: wh.name,
    trackingReference: d.trackingReference || `TRK-${uuidv4().slice(0, 8).toUpperCase()}`,
    expectedArrival: d.expectedArrival,
    actualArrival: null,
    status: d.status,
    verificationStatus: 'unverified',
    items: d.items.map((it) => ({ ...it, receivedQty: 0, damagedQty: 0 })),
    orgId: req.actor!.orgId,
    createdBy: req.actor!.name,
    verifiedBy: null,
    mode: wh.mode,
    createdAt: now,
    updatedAt: now,
  };

  store.state.incomingSupplies.unshift(order);

  // Reflect ordered qty in inTransitQty WITHOUT increasing availableQty until verified
  for (const it of order.items) {
    const stock = store.state.inventory.find(
      (s) => s.warehouseId === wh.id && s.sku === it.sku && s.mode === wh.mode
    );
    if (stock) {
      stock.inTransitQty += it.orderedQty;
      stock.updatedAt = now;
    }
  }

  store.save();
  store.addAudit({
    actor: req.actor!.name,
    role: req.actor!.role,
    orgId: req.actor!.orgId,
    action: 'supply.created',
    entityType: 'incoming_supply',
    entityId: order.id,
    summary: `Registered incoming supply ${order.trackingReference} from ${order.supplier} (${order.items.length} line(s))`,
    mode: order.mode,
  });

  res.status(201).json({ supply: order });
});

api.get('/supplies/incoming/:id', (req, res) => {
  const id = getParam(req.params.id);
  const supply = store.state.incomingSupplies.find((s) => s.id === id);
  if (!supply) return res.status(404).json({ error: 'Incoming supply order not found' });
  res.json({ supply });
});

api.post('/supplies/incoming/:id/receive', requirePermission('supply:manage'), (req: AuthedRequest, res) => {
  const id = getParam(req.params.id);
  const schema = z.object({
    items: z
      .array(
        z.object({
          sku: z.string().min(1),
          receivedQty: z.number().int().min(0),
          damagedQty: z.number().int().min(0).optional().default(0),
          lotNumber: z.string().optional(),
          expiryDate: z.string().nullable().optional(),
        })
      )
      .min(1),
    discrepancyNotes: z.string().max(600).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid receive supply payload', details: parsed.error.flatten() });
  }
  try {
    const supply = receiveIncomingSupply({
      supplyId: id,
      receivedItems: parsed.data.items,
      discrepancyNotes: parsed.data.discrepancyNotes,
      actor: { name: req.actor!.name, role: req.actor!.role, orgId: req.actor!.orgId },
    });
    res.json({ supply });
  } catch (err) {
    return handleInventoryError(res, err);
  }
});

api.post('/supplies/incoming/:id/verify', requirePermission('supply:manage'), (req: AuthedRequest, res) => {
  const id = getParam(req.params.id);
  const notes = req.body?.notes ? String(req.body.notes) : undefined;
  try {
    const result = verifyIncomingSupply({
      supplyId: id,
      notes,
      actor: { name: req.actor!.name, role: req.actor!.role, orgId: req.actor!.orgId },
    });
    res.json({ supply: result.order, movements: result.movements, createdBatches: result.createdBatches });
  } catch (err) {
    return handleInventoryError(res, err);
  }
});

// ============================================================================
// 7. PHASE 5 ALLOCATIONS (SMART MULTI-WAREHOUSE + PRIORITY + FAIRNESS + RESERVE)
// ============================================================================

function handleLogisticsError(res: express.Response, err: unknown) {
  if (err instanceof LogisticsError) {
    return res.status(err.statusCode).json({ error: err.message });
  }
  if (err instanceof InventoryEngineError) {
    return res.status(err.statusCode).json({ error: err.message });
  }
  return res.status(500).json({ error: err instanceof Error ? err.message : 'Logistics engine error' });
}

const VehicleTypeEnum = z.enum([
  'heavy_truck',
  'light_van',
  'ambulance',
  'relief_truck',
  'cargo_truck',
  'pickup',
  'rescue_vehicle',
  'water_tanker',
  'bus',
  'utility_vehicle',
  'motorcycle',
  'boat',
  'rescue_boat',
  'helicopter',
  '4x4_utility',
  'other',
]);

const VehicleStatusEnum = z.enum([
  'available',
  'assigned',
  'loading',
  'dispatched',
  'in_transit',
  'en_route',
  'delivering',
  'returning',
  'delayed',
  'completed',
  'maintenance',
  'unavailable',
]);

const DriverStatusEnum = z.enum(['Available', 'Assigned', 'On Duty', 'Off Duty', 'Unavailable']);

api.get('/allocations', (req, res) => {
  const mode = parseMode(req.query.mode);
  const statusFilter = req.query.status ? String(req.query.status) : null;
  const requestId = req.query.requestId ? String(req.query.requestId) : null;
  const incidentId = req.query.incidentId ? String(req.query.incidentId) : null;
  const list = store.state.allocations.filter((a) => {
    if (a.mode !== mode) return false;
    if (statusFilter && a.status !== statusFilter) return false;
    if (requestId && a.requestId !== requestId) return false;
    if (incidentId && a.incidentId !== incidentId) return false;
    return true;
  });
  res.json({ allocations: list });
});

api.get('/allocations/priority/:requestId', (req, res) => {
  try {
    const priority = computeAllocationPriority(getParam(req.params.requestId));
    res.json({ priority });
  } catch (err) {
    return handleLogisticsError(res, err);
  }
});

api.post('/allocations/optimize', requirePermission('allocation:recommend'), async (req: AuthedRequest, res) => {
  const schema = z.object({
    requestId: z.string().min(1),
    allowSplit: z.boolean().optional(),
    preferredWarehouseIds: z.array(z.string()).optional(),
    maxWarehouses: z.number().int().min(1).max(6).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid allocation optimize payload', details: parsed.error.flatten() });
  }
  try {
    const allocation = await optimizeMultiWarehouseAllocation({
      ...parsed.data,
      actor: { name: req.actor!.name, role: req.actor!.role, orgId: req.actor!.orgId },
    });
    res.status(201).json({ allocation });
  } catch (err) {
    return handleLogisticsError(res, err);
  }
});

api.post('/allocations/recommend', requirePermission('allocation:recommend'), async (req: AuthedRequest, res) => {
  const requestId = String(req.body?.requestId || '');
  const reliefReq = store.state.reliefRequests.find((r) => r.id === requestId);
  if (!reliefReq) return res.status(404).json({ error: 'Relief request not found' });

  try {
    const allocation = await optimizeMultiWarehouseAllocation({
      requestId: reliefReq.id,
      actor: { name: req.actor!.name, role: req.actor!.role, orgId: req.actor!.orgId },
    });
    res.status(201).json({ allocation });
  } catch (err) {
    // Fallback cleanly to legacy generator if unexpected
    const allocation = await generateAllocationRecommendation(reliefReq);
    res.status(201).json({ allocation });
  }
});

api.post('/allocations', requirePermission('allocation:recommend'), async (req: AuthedRequest, res) => {
  const schema = z.object({
    requestId: z.string().min(1),
    items: z
      .array(
        z.object({
          stockId: z.string().min(1),
          quantity: z.number().int().positive(),
        })
      )
      .min(1),
    recommendedVehicleId: z.string().nullable().optional(),
    note: z.string().max(400).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid manual allocation payload', details: parsed.error.flatten() });
  }
  try {
    const base = await optimizeMultiWarehouseAllocation({
      requestId: parsed.data.requestId,
      actor: { name: req.actor!.name, role: req.actor!.role, orgId: req.actor!.orgId },
    });
    const edited = editAllocationProposal({
      allocationId: base.id,
      items: parsed.data.items,
      recommendedVehicleId: parsed.data.recommendedVehicleId,
      note: parsed.data.note || 'Manual operator allocation specification',
      actor: { name: req.actor!.name, role: req.actor!.role, orgId: req.actor!.orgId },
    });
    res.status(201).json({ allocation: edited });
  } catch (err) {
    return handleLogisticsError(res, err);
  }
});

api.get('/allocations/:id', (req, res) => {
  const id = getParam(req.params.id);
  const allocation = store.state.allocations.find((a) => a.id === id);
  if (!allocation) return res.status(404).json({ error: 'Allocation not found' });
  res.json({ allocation });
});

api.patch('/allocations/:id', requirePermission('allocation:reallocate'), (req: AuthedRequest, res) => {
  const id = getParam(req.params.id);
  const schema = z.object({
    items: z.array(z.object({ stockId: z.string().min(1), quantity: z.number().int().positive() })).optional(),
    recommendedVehicleId: z.string().nullable().optional(),
    note: z.string().max(400).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid allocation patch payload', details: parsed.error.flatten() });
  }
  try {
    const allocation = editAllocationProposal({
      allocationId: id,
      ...parsed.data,
      actor: { name: req.actor!.name, role: req.actor!.role, orgId: req.actor!.orgId },
    });
    res.json({ allocation });
  } catch (err) {
    return handleLogisticsError(res, err);
  }
});

api.post('/allocations/:id/recalculate', requirePermission('allocation:reallocate'), async (req: AuthedRequest, res) => {
  const id = getParam(req.params.id);
  const existing = store.state.allocations.find((a) => a.id === id);
  if (!existing) return res.status(404).json({ error: 'Allocation not found' });
  try {
    const allocation = await optimizeMultiWarehouseAllocation({
      requestId: existing.requestId,
      allowSplit: req.body?.allowSplit,
      preferredWarehouseIds: req.body?.preferredWarehouseIds,
      actor: { name: req.actor!.name, role: req.actor!.role, orgId: req.actor!.orgId },
    });
    res.status(201).json({ allocation, previousAllocationId: existing.id });
  } catch (err) {
    return handleLogisticsError(res, err);
  }
});

api.post('/allocations/:id/approve', requirePermission('allocation:approve'), (req: AuthedRequest, res) => {
  const id = getParam(req.params.id);
  const alloc = store.state.allocations.find((a) => a.id === id);
  if (!alloc) return res.status(404).json({ error: 'Allocation not found' });
  if (alloc.status !== 'proposed') {
    return res.status(400).json({ error: `Allocation is already '${alloc.status}'.` });
  }

  const actor = req.actor!;
  const now = new Date().toISOString();
  alloc.status = 'approved';
  alloc.approvedBy = actor.name;
  alloc.approvedAt = now;
  alloc.updatedAt = now;

  const reliefReq = store.state.reliefRequests.find((r) => r.id === alloc.requestId);
  if (reliefReq) {
    reliefReq.status = 'approved';
    reliefReq.updatedAt = now;
  }
  store.save();

  store.addAudit({
    actor: actor.name,
    role: actor.role,
    orgId: actor.orgId,
    action: 'allocation.approved',
    entityType: 'allocation',
    entityId: alloc.id,
    summary: `Approved allocation ${alloc.id.slice(0, 8)} for request ${alloc.requestId.slice(0, 8)}`,
    mode: alloc.mode,
  });

  eventBus.publish({
    event_type: 'allocation.approved',
    organization_id: actor.orgId,
    entity_id: alloc.id,
    source: 'allocation-api',
    mode: alloc.mode,
    payload: { allocation: alloc },
  });

  res.json({ allocation: alloc });
});

api.post('/allocations/:id/reject', requirePermission('allocation:approve'), (req: AuthedRequest, res) => {
  const id = getParam(req.params.id);
  const alloc = store.state.allocations.find((a) => a.id === id);
  if (!alloc) return res.status(404).json({ error: 'Allocation not found' });
  if (alloc.status !== 'proposed' && alloc.status !== 'approved') {
    return res.status(400).json({ error: `Cannot reject allocation in '${alloc.status}' state.` });
  }

  const actor = req.actor!;
  alloc.status = 'rejected';
  alloc.rejectionReason = String(req.body?.reason || 'Rejected by commander');
  alloc.updatedAt = new Date().toISOString();
  store.save();

  store.addAudit({
    actor: actor.name,
    role: actor.role,
    orgId: actor.orgId,
    action: 'allocation.rejected',
    entityType: 'allocation',
    entityId: alloc.id,
    summary: `Rejected allocation ${alloc.id.slice(0, 8)}: ${alloc.rejectionReason}`,
    mode: alloc.mode,
  });

  res.json({ allocation: alloc });
});

api.post('/allocations/:id/reserve', requirePermission('allocation:approve'), (req: AuthedRequest, res) => {
  const id = getParam(req.params.id);
  const alloc = store.state.allocations.find((a) => a.id === id);
  if (!alloc) return res.status(404).json({ error: 'Allocation not found' });
  if (alloc.status !== 'approved') {
    return res.status(400).json({ error: 'Allocation must be human-approved before atomic stock reservation.' });
  }

  // Atomic pre-check across all line items (all-or-nothing!)
  for (const line of alloc.items) {
    const stock = store.state.inventory.find((i) => i.id === line.stockId);
    if (!stock || stock.availableQty < line.quantity) {
      return res.status(409).json({
        error: `Atomic reservation aborted: insufficient stock for ${line.itemName} at ${line.warehouseName} (need ${line.quantity}, have ${stock?.availableQty ?? 0}).`,
      });
    }
  }

  const actor = req.actor!;
  const now = new Date().toISOString();
  const movements: StockMovement[] = [];
  const reservationIds: string[] = [];

  for (const line of alloc.items) {
    const stock = store.state.inventory.find((i) => i.id === line.stockId)!;
    const prev = stock.availableQty;
    stock.availableQty -= line.quantity;
    stock.reservedQty += line.quantity;
    stock.version += 1;
    stock.updatedAt = now;

    const mov: StockMovement = {
      id: uuidv4(),
      stockId: stock.id,
      warehouseId: stock.warehouseId,
      itemName: stock.itemName,
      type: 'reservation',
      quantity: line.quantity,
      previousAvailable: prev,
      newAvailable: stock.availableQty,
      reason: `Atomic reservation for Allocation ${alloc.id.slice(0, 8)}`,
      referenceId: alloc.id,
      actor: actor.name,
      role: actor.role,
      mode: alloc.mode,
      createdAt: now,
    };
    store.state.stockMovements.unshift(mov);
    movements.push(mov);

    const resvId = uuidv4();
    reservationIds.push(resvId);
    store.state.stockReservations.unshift({
      id: resvId,
      requestId: alloc.requestId,
      incidentId: alloc.incidentId,
      warehouseId: stock.warehouseId,
      warehouseName: line.warehouseName,
      stockId: stock.id,
      sku: stock.sku,
      itemName: stock.itemName,
      category: stock.category,
      unit: stock.unit,
      requestedQty: line.quantity,
      reservedQty: line.quantity,
      status: 'Allocated',
      expiresAt: new Date(Date.now() + 24 * 3_600_000).toISOString(),
      orgId: actor.orgId,
      reservedBy: actor.name,
      notes: `Atomic reservation linked to Allocation ${alloc.id.slice(0, 8)}`,
      auditHistory: [
        {
          timestamp: now,
          actor: actor.name,
          action: 'reservation.allocated',
          detail: `Reserved ${line.quantity} ${stock.unit} for allocation ${alloc.id.slice(0, 8)}`,
        },
      ],
      mode: alloc.mode,
      createdAt: now,
      updatedAt: now,
    });

    if (stock.availableQty < stock.minStock) {
      store.addNotification({
        dedupKey: `${stock.mode}:inv:shortage:${stock.id}`,
        userId: 'all',
        orgId: actor.orgId,
        eventType: 'inventory.critical_shortage',
        severity: 'high',
        title: `Post-Reservation Shortage: ${stock.itemName}`,
        message: `${stock.itemName} dropped to ${stock.availableQty} ${stock.unit} (below min ${stock.minStock}).`,
        entityType: 'inventory',
        entityId: stock.id,
        channel: 'in_app',
        mode: stock.mode,
      });
    }
  }

  alloc.status = 'reserved';
  alloc.reservationIds = reservationIds;
  alloc.updatedAt = now;
  const reliefReq = store.state.reliefRequests.find((r) => r.id === alloc.requestId);
  if (reliefReq) {
    reliefReq.status = 'allocated';
    reliefReq.updatedAt = now;
  }
  store.save();

  store.addAudit({
    actor: actor.name,
    role: actor.role,
    orgId: actor.orgId,
    action: 'inventory.reserved',
    entityType: 'allocation',
    entityId: alloc.id,
    summary: `Atomically reserved ${alloc.items.length} inventory line(s) for allocation ${alloc.id.slice(0, 8)}`,
    mode: alloc.mode,
  });

  eventBus.publish({
    event_type: 'inventory.reserved',
    organization_id: actor.orgId,
    entity_id: alloc.id,
    source: 'allocation-api',
    mode: alloc.mode,
    payload: { allocation: alloc, movements },
  });

  res.json({ allocation: alloc, movements });
});

// ============================================================================
// 8. PHASE 5 FLEET, DRIVERS, ROUTES, ROUTE RISK, DISPATCHES & DELIVERIES
// ============================================================================

// --- Routes & Route Risk ---
api.post('/routes/optimize', async (req, res) => {
  const schema = z.object({
    origin: z.object({ lat: z.number(), lng: z.number(), label: z.string().default('Origin') }),
    destination: z.object({ lat: z.number(), lng: z.number(), label: z.string().default('Destination') }),
    waypoints: z.array(z.object({ lat: z.number(), lng: z.number(), label: z.string().default('Stop') })).optional(),
    vehicleType: VehicleTypeEnum.optional(),
    mode: z.enum(['operational', 'demo']).optional(),
    bypassCache: z.boolean().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid route parameters', details: parsed.error.flatten() });

  try {
    const route = await optimizeRouteWithAlternatives(parsed.data);
    res.json({ route });
  } catch (err) {
    return handleLogisticsError(res, err);
  }
});

api.post('/routes/alternatives', async (req, res) => {
  const schema = z.object({
    origin: z.object({ lat: z.number(), lng: z.number(), label: z.string().default('Origin') }),
    destination: z.object({ lat: z.number(), lng: z.number(), label: z.string().default('Destination') }),
    vehicleType: VehicleTypeEnum.optional(),
    mode: z.enum(['operational', 'demo']).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid route alternatives parameters' });
  try {
    const route = await optimizeRouteWithAlternatives({ ...parsed.data, bypassCache: true });
    res.json({
      route,
      alternatives: route.alternatives || [],
      alternativesAvailable: (route.alternatives?.length || 0) > 1,
      notice:
        (route.alternatives?.length || 0) <= 1
          ? 'Routing provider returned a single corridor; no fabricated alternatives generated.'
          : `${route.alternatives?.length} road corridors returned by ${route.provider}.`,
    });
  } catch (err) {
    return handleLogisticsError(res, err);
  }
});

api.get('/routes/hazards', (req, res) => {
  const mode = parseMode(req.query.mode);
  const activeOnly = req.query.active !== 'false';
  const hazards = store.state.routeHazards.filter((h) => h.mode === mode && (!activeOnly || h.active));
  res.json({ hazards });
});

api.post('/routes/hazards', requirePermission('route:hazard_report'), (req: AuthedRequest, res) => {
  const schema = z.object({
    type: z.enum(['closure', 'flood', 'landslide', 'bridge_damage', 'severe_weather', 'debris', 'other']),
    severity: z.enum(['low', 'medium', 'high', 'critical']),
    lat: z.number(),
    lng: z.number(),
    radiusKm: z.number().positive().max(50).default(1.5),
    description: z.string().min(4).max(500),
    source: z.string().max(150).optional(),
    verified: z.boolean().optional(),
    mode: z.enum(['operational', 'demo']).default('demo'),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid route hazard payload', details: parsed.error.flatten() });
  }
  try {
    const hazard = reportRouteHazard({
      ...parsed.data,
      actor: { name: req.actor!.name, role: req.actor!.role, orgId: req.actor!.orgId },
    });
    res.status(201).json({ hazard });
  } catch (err) {
    return handleLogisticsError(res, err);
  }
});

api.get('/routes/:id', (req, res) => {
  const id = getParam(req.params.id);
  const route =
    store.state.routeRecords.find((r) => r.id === id) ||
    store.state.dispatches.find((d) => d.route?.id === id)?.route;
  if (!route) return res.status(404).json({ error: 'Route record not found' });
  res.json({ route });
});

api.get('/routes/:id/risk', (req, res) => {
  const id = getParam(req.params.id);
  const mode = parseMode(req.query.mode);
  const route =
    store.state.routeRecords.find((r) => r.id === id) ||
    store.state.dispatches.find((d) => d.route?.id === id)?.route;
  if (!route) return res.status(404).json({ error: 'Route record not found' });
  const riskAssessment = evaluateRouteRisk(route.geometry, mode, route.destination);
  res.json({ routeId: route.id, riskAssessment });
});

api.post('/routes/:id/recalculate', async (req, res) => {
  const id = getParam(req.params.id);
  const mode = parseMode(req.body?.mode || req.query.mode);
  const existing =
    store.state.routeRecords.find((r) => r.id === id) ||
    store.state.dispatches.find((d) => d.route?.id === id)?.route;
  if (!existing) return res.status(404).json({ error: 'Route record not found' });
  try {
    const route = await optimizeRouteWithAlternatives({
      origin: existing.origin,
      destination: existing.destination,
      waypoints: existing.waypoints.map((w) => ({ lat: w.lat, lng: w.lng, label: w.label })),
      vehicleType: existing.vehicleType,
      mode,
      bypassCache: true,
    });
    res.json({ route, previousRouteId: existing.id });
  } catch (err) {
    return handleLogisticsError(res, err);
  }
});

// --- Fleet & Vehicles ---
api.get('/fleet/overview', (req, res) => {
  const mode = parseMode(req.query.mode);
  const overview = computeLogisticsOverview(mode);
  res.json({
    mode,
    fleet: overview.fleetMetrics,
    fleetOverloaded: overview.coordination.fleetOverloaded,
    timestamp: overview.timestamp,
  });
});

api.get('/vehicles', (req: AuthedRequest, res) => {
  const mode = parseMode(req.query.mode);
  const role = req.actor?.role || 'analyst';
  const status = req.query.status ? String(req.query.status) : null;
  const vehicleType = req.query.vehicleType ? String(req.query.vehicleType) : null;
  const warehouseId = req.query.warehouseId ? String(req.query.warehouseId) : null;
  const search = req.query.search ? String(req.query.search).toLowerCase() : null;

  const vehicles = store.state.vehicles
    .filter((v) => {
      if (v.mode !== mode) return false;
      if (status && v.status !== status) return false;
      if (vehicleType && v.vehicleType !== vehicleType) return false;
      if (warehouseId && v.warehouseId !== warehouseId) return false;
      if (search && !`${v.callsign} ${v.name || ''} ${v.registrationNumber || ''} ${v.driverTeam}`.toLowerCase().includes(search)) {
        return false;
      }
      return true;
    })
    .map((v) => sanitizeVehicleForRole(v, role));

  res.json({ vehicles });
});

api.post('/vehicles', requirePermission('fleet:manage'), (req: AuthedRequest, res) => {
  const schema = z.object({
    registrationNumber: z.string().max(60).optional(),
    callsign: z.string().min(2).max(120),
    name: z.string().max(120).optional(),
    vehicleType: VehicleTypeEnum,
    warehouseId: z.string().min(1),
    capacityKg: z.number().positive(),
    capacityUnits: z.number().int().positive(),
    capacityUnit: z.string().max(40).optional(),
    driverId: z.string().nullable().optional(),
    driverTeam: z.string().min(2).default('Unassigned Crew'),
    driverContact: z.string().max(60).optional(),
    fuelPct: z.number().min(0).max(100).nullable().optional(),
    maintenanceStatus: z.enum(['operational', 'due_soon', 'in_maintenance', 'out_of_service']).optional(),
    equipment: z.array(z.string()).optional(),
    lastServiceDate: z.string().nullable().optional(),
    mode: z.enum(['operational', 'demo']).default('demo'),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid vehicle payload', details: parsed.error.flatten() });

  try {
    const vehicle = createVehicleRecord({
      ...parsed.data,
      actor: { name: req.actor!.name, role: req.actor!.role, orgId: req.actor!.orgId },
    });
    res.status(201).json({ vehicle });
  } catch (err) {
    return handleLogisticsError(res, err);
  }
});

api.get('/vehicles/:id', (req: AuthedRequest, res) => {
  const id = getParam(req.params.id);
  const vehicle = store.state.vehicles.find((v) => v.id === id);
  if (!vehicle) return res.status(404).json({ error: 'Vehicle not found' });
  res.json({ vehicle: sanitizeVehicleForRole(vehicle, req.actor?.role || 'analyst') });
});

api.patch('/vehicles/:id', requirePermission('fleet:manage'), (req: AuthedRequest, res) => {
  const id = getParam(req.params.id);
  const schema = z.object({
    registrationNumber: z.string().max(60).optional(),
    callsign: z.string().min(2).max(120).optional(),
    name: z.string().max(120).optional(),
    vehicleType: VehicleTypeEnum.optional(),
    warehouseId: z.string().min(1).optional(),
    capacityKg: z.number().positive().optional(),
    capacityUnits: z.number().int().positive().optional(),
    capacityUnit: z.string().max(40).optional(),
    driverTeam: z.string().min(2).optional(),
    driverContact: z.string().max(60).optional(),
    fuelPct: z.number().min(0).max(100).nullable().optional(),
    maintenanceStatus: z.enum(['operational', 'due_soon', 'in_maintenance', 'out_of_service']).optional(),
    equipment: z.array(z.string()).optional(),
    lastServiceDate: z.string().nullable().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid vehicle update payload', details: parsed.error.flatten() });

  try {
    const vehicle = updateVehicleRecord(id, parsed.data, {
      name: req.actor!.name,
      role: req.actor!.role,
      orgId: req.actor!.orgId,
    });
    res.json({ vehicle });
  } catch (err) {
    return handleLogisticsError(res, err);
  }
});

api.get('/vehicles/:id/history', (req, res) => {
  const id = getParam(req.params.id);
  const vehicle = store.state.vehicles.find((v) => v.id === id);
  if (!vehicle) return res.status(404).json({ error: 'Vehicle not found' });
  const dispatches = store.state.dispatches
    .filter((d) => d.vehicleId === id)
    .map((d) => ({
      dispatchId: d.id,
      status: d.status,
      destinationName: d.destinationName,
      createdAt: d.createdAt,
      deliveredAt: d.deliveredAt || null,
    }));
  res.json({ vehicleId: id, history: vehicle.history || [], dispatches });
});

api.post('/vehicles/:id/assign-driver', requirePermission('fleet:manage'), (req: AuthedRequest, res) => {
  const id = getParam(req.params.id);
  const driverId = String(req.body?.driverId || '');
  if (!driverId) return res.status(400).json({ error: 'driverId is required.' });
  try {
    const result = assignDriverToVehicle(id, driverId, {
      name: req.actor!.name,
      role: req.actor!.role,
      orgId: req.actor!.orgId,
    });
    res.json({
      vehicle: sanitizeVehicleForRole(result.vehicle, req.actor!.role),
      driver: sanitizeDriverForRole(result.driver, req.actor!.role),
    });
  } catch (err) {
    return handleLogisticsError(res, err);
  }
});

api.post('/vehicles/:id/status', requirePermission('fleet:manage'), (req: AuthedRequest, res) => {
  const id = getParam(req.params.id);
  const parsed = z
    .object({ status: VehicleStatusEnum, note: z.string().max(300).optional() })
    .safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid vehicle status payload' });
  try {
    const vehicle = updateVehicleStatus(id, parsed.data.status, parsed.data.note, {
      name: req.actor!.name,
      role: req.actor!.role,
      orgId: req.actor!.orgId,
    });
    res.json({ vehicle });
  } catch (err) {
    return handleLogisticsError(res, err);
  }
});

// --- Drivers & Responders ---
api.get('/drivers', (req: AuthedRequest, res) => {
  const mode = parseMode(req.query.mode);
  const role = req.actor?.role || 'analyst';
  const status = req.query.status ? String(req.query.status) : null;
  const drivers = store.state.drivers
    .filter((d) => d.mode === mode && (!status || d.status === status))
    .map((d) => sanitizeDriverForRole(d, role));
  res.json({ drivers });
});

api.post('/drivers', requirePermission('driver:manage'), (req: AuthedRequest, res) => {
  const schema = z.object({
    name: z.string().min(2).max(120),
    contact: z.string().min(4).max(60),
    orgId: z.string().optional(),
    status: DriverStatusEnum.optional(),
    certifications: z.array(z.string()).optional(),
    mode: z.enum(['operational', 'demo']).default('demo'),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid driver payload', details: parsed.error.flatten() });
  try {
    const driver = createDriverRecord({
      ...parsed.data,
      actor: { name: req.actor!.name, role: req.actor!.role, orgId: req.actor!.orgId },
    });
    res.status(201).json({ driver: sanitizeDriverForRole(driver, req.actor!.role) });
  } catch (err) {
    return handleLogisticsError(res, err);
  }
});

api.get('/drivers/:id', (req: AuthedRequest, res) => {
  const id = getParam(req.params.id);
  const driver = store.state.drivers.find((d) => d.id === id);
  if (!driver) return res.status(404).json({ error: 'Driver not found' });
  res.json({ driver: sanitizeDriverForRole(driver, req.actor?.role || 'analyst') });
});

api.patch('/drivers/:id', requirePermission('driver:manage'), (req: AuthedRequest, res) => {
  const id = getParam(req.params.id);
  const schema = z.object({
    name: z.string().min(2).max(120).optional(),
    contact: z.string().min(4).max(60).optional(),
    status: DriverStatusEnum.optional(),
    certifications: z.array(z.string()).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid driver update payload' });
  try {
    const driver = updateDriverRecord(id, parsed.data, {
      name: req.actor!.name,
      role: req.actor!.role,
      orgId: req.actor!.orgId,
    });
    res.json({ driver: sanitizeDriverForRole(driver, req.actor!.role) });
  } catch (err) {
    return handleLogisticsError(res, err);
  }
});

api.post('/drivers/:id/availability', requirePermission('driver:manage'), (req: AuthedRequest, res) => {
  const id = getParam(req.params.id);
  const parsed = z.object({ status: DriverStatusEnum }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid driver status' });
  try {
    const driver = updateDriverRecord(
      id,
      { status: parsed.data.status },
      { name: req.actor!.name, role: req.actor!.role, orgId: req.actor!.orgId }
    );
    res.json({ driver: sanitizeDriverForRole(driver, req.actor!.role) });
  } catch (err) {
    return handleLogisticsError(res, err);
  }
});

// --- Dispatches (Planning, Strict Human Approval Gate & State Machine) ---
api.get('/dispatches', (req, res) => {
  const mode = parseMode(req.query.mode);
  const status = req.query.status ? String(req.query.status) : null;
  const incidentId = req.query.incidentId ? String(req.query.incidentId) : null;
  const warehouseId = req.query.warehouseId ? String(req.query.warehouseId) : null;
  const vehicleId = req.query.vehicleId ? String(req.query.vehicleId) : null;
  const priority = req.query.priority ? String(req.query.priority) : null;
  const routeRisk = req.query.routeRisk ? String(req.query.routeRisk) : null;
  const page = Math.max(1, Number(req.query.page || 1));
  const limit = Math.min(200, Math.max(1, Number(req.query.limit || 100)));

  const filtered = store.state.dispatches.filter((d) => {
    if (d.mode !== mode) return false;
    if (status && d.status !== status) return false;
    if (incidentId && d.incidentId !== incidentId) return false;
    if (warehouseId && d.warehouseId !== warehouseId) return false;
    if (vehicleId && d.vehicleId !== vehicleId) return false;
    if (priority && d.priorityLevel !== priority) return false;
    if (routeRisk && (d.routeRisk?.riskBand || 'UNKNOWN') !== routeRisk) return false;
    return true;
  });

  const start = (page - 1) * limit;
  const dispatches = filtered.slice(start, start + limit);
  res.json({ dispatches, total: filtered.length, page, limit });
});

api.post('/dispatches/plan', requirePermission('dispatch:create'), async (req: AuthedRequest, res) => {
  const schema = z.object({
    requestId: z.string().min(1),
    allocationId: z.string().optional(),
    warehouseId: z.string().optional(),
    vehicleId: z.string().optional(),
    driverId: z.string().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'requestId is required to plan dispatch.' });
  try {
    const plan = await planDispatch({
      ...parsed.data,
      actor: { name: req.actor!.name, role: req.actor!.role, orgId: req.actor!.orgId },
    });
    res.json({ plan });
  } catch (err) {
    return handleLogisticsError(res, err);
  }
});

api.post('/dispatches', requirePermission('dispatch:create'), async (req: AuthedRequest, res) => {
  const schema = z.object({
    allocationId: z.string().min(1),
    vehicleId: z.string().min(1),
    driverId: z.string().nullable().optional(),
    warehouseId: z.string().optional(),
    deliveryDeadline: z.string().nullable().optional(),
    note: z.string().optional(),
    requireApproval: z.boolean().optional(),
    initialState: z.enum(['PENDING_APPROVAL', 'DRAFT']).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'allocationId and vehicleId are required.' });

  const alloc = store.state.allocations.find((a) => a.id === parsed.data.allocationId);
  if (!alloc) return res.status(404).json({ error: 'Allocation not found' });

  // Phase 5 Strict Human Approval Gate mode (used when requireApproval is true, initialState is specified, or allocation not yet reserved)
  if (parsed.data.requireApproval === true || parsed.data.initialState || alloc.status === 'proposed') {
    try {
      const dispatch = await createPendingDispatch({
        allocationId: parsed.data.allocationId,
        vehicleId: parsed.data.vehicleId,
        driverId: parsed.data.driverId,
        warehouseId: parsed.data.warehouseId,
        deliveryDeadline: parsed.data.deliveryDeadline,
        note: parsed.data.note,
        initialState: parsed.data.initialState || 'PENDING_APPROVAL',
        actor: { name: req.actor!.name, role: req.actor!.role, orgId: req.actor!.orgId },
      });
      return res.status(201).json({ dispatch });
    } catch (err) {
      return handleLogisticsError(res, err);
    }
  }

  // Phase 1-4 Backwards-Compatible flow (when allocation is already human-approved & atomically reserved)
  if (alloc.status !== 'reserved' && alloc.status !== 'approved') {
    return res.status(400).json({ error: 'Allocation must be reserved or approved before creating dispatch.' });
  }

  const vehicle = store.state.vehicles.find((v) => v.id === parsed.data.vehicleId);
  if (!vehicle) return res.status(404).json({ error: 'Vehicle not found' });
  if (vehicle.status !== 'available' || vehicle.maintenanceStatus === 'in_maintenance' || vehicle.maintenanceStatus === 'out_of_service') {
    return res.status(409).json({ error: `Vehicle ${vehicle.callsign} is currently '${vehicle.status}'.` });
  }

  const reliefReq = store.state.reliefRequests.find((r) => r.id === alloc.requestId);
  if (!reliefReq) return res.status(404).json({ error: 'Linked relief request not found' });

  const whId = parsed.data.warehouseId || alloc.items[0]?.warehouseId || vehicle.warehouseId;
  const wh = store.state.warehouses.find((w) => w.id === whId);
  const origin = { lat: wh?.lat ?? reliefReq.lat, lng: wh?.lng ?? reliefReq.lng, label: wh?.name || 'Origin Depot' };
  const route = await optimizeRouteWithAlternatives({
    origin,
    destination: { lat: reliefReq.lat, lng: reliefReq.lng, label: reliefReq.locationName },
    vehicleType: vehicle.vehicleType,
    mode: alloc.mode,
  });

  const actor = req.actor!;
  const now = new Date().toISOString();
  const priority = computeAllocationPriority(reliefReq.id);
  const dispatch: Dispatch = {
    id: uuidv4(),
    allocationId: alloc.id,
    requestId: reliefReq.id,
    incidentId: alloc.incidentId,
    warehouseId: whId,
    warehouseName: wh?.name || 'Origin Depot',
    vehicleId: vehicle.id,
    vehicleCallsign: vehicle.callsign,
    driverId: parsed.data.driverId || vehicle.driverId || null,
    driverName: vehicle.driverTeam,
    priorityLevel: priority.band,
    destinationName: reliefReq.locationName,
    destinationLat: reliefReq.lat,
    destinationLng: reliefReq.lng,
    items: alloc.items.map((it) => ({
      stockId: it.stockId,
      sku: it.sku,
      itemName: it.itemName,
      category: it.category,
      quantity: it.quantity,
      deliveredQty: 0,
      damagedQty: 0,
      unit: it.unit,
      warehouseId: it.warehouseId,
      warehouseName: it.warehouseName,
    })),
    reservationIds: [...(alloc.reservationIds || [])],
    status: 'vehicle_assigned',
    approvalStatus: 'approved',
    approvedBy: alloc.approvedBy || actor.name,
    approvedAt: alloc.approvedAt || now,
    deliveryDeadline: parsed.data.deliveryDeadline ?? reliefReq.deliveryDeadline ?? null,
    initialEtaMin: route.durationMin,
    currentEtaMin: route.durationMin,
    etaStatus: route.durationMin !== null ? 'ON_TIME' : 'UNKNOWN',
    etaHistory: [
      { timestamp: now, etaMin: route.durationMin, etaStatus: route.durationMin !== null ? 'ON_TIME' : 'UNKNOWN', reason: 'Dispatch created' },
    ],
    route,
    routeRisk: route.riskAssessment || null,
    currentLat: alloc.mode === 'demo' ? origin.lat : null,
    currentLng: alloc.mode === 'demo' ? origin.lng : null,
    lastLocationAt: alloc.mode === 'demo' ? now : null,
    trackingStatus: alloc.mode === 'demo' ? 'SIMULATED_DEMO' : 'UNAVAILABLE',
    gpsLabel: alloc.mode === 'demo' ? 'SIMULATED DEMO TRACKING' : 'LIVE GPS UNAVAILABLE (LAST KNOWN ORIGIN)',
    locationHistory: [],
    events: [
      {
        id: uuidv4(),
        status: 'dispatch_created',
        note: parsed.data.note || 'Dispatch created from human-approved allocation',
        actor: actor.name,
        timestamp: now,
      },
      {
        id: uuidv4(),
        status: 'vehicle_assigned',
        note: `Assigned ${vehicle.callsign} (${vehicle.driverTeam})`,
        actor: actor.name,
        timestamp: now,
      },
    ],
    mode: alloc.mode,
    createdAt: now,
    updatedAt: now,
  };

  vehicle.status = 'assigned';
  vehicle.assignedDispatchId = dispatch.id;
  vehicle.updatedAt = now;
  alloc.status = 'dispatched';
  alloc.updatedAt = now;
  reliefReq.status = 'dispatched';
  reliefReq.updatedAt = now;

  store.state.dispatches.unshift(dispatch);
  store.save();

  store.addAudit({
    actor: actor.name,
    role: actor.role,
    orgId: actor.orgId,
    action: 'dispatch.created',
    entityType: 'dispatch',
    entityId: dispatch.id,
    summary: `Dispatched ${vehicle.callsign} from ${dispatch.warehouseName} to ${dispatch.destinationName}`,
    mode: dispatch.mode,
  });

  eventBus.publish({
    event_type: 'dispatch.created',
    organization_id: actor.orgId,
    entity_id: dispatch.id,
    source: 'dispatch-api',
    mode: dispatch.mode,
    payload: { dispatch },
  });

  res.status(201).json({ dispatch });
});

api.get('/dispatches/:id', (req, res) => {
  const id = getParam(req.params.id);
  const dispatch = store.state.dispatches.find((d) => d.id === id);
  if (!dispatch) return res.status(404).json({ error: 'Dispatch not found' });
  const delivery = dispatch.deliveryConfirmationId
    ? store.state.deliveryConfirmations.find((c) => c.id === dispatch.deliveryConfirmationId) || null
    : null;
  res.json({ dispatch, delivery });
});

api.patch('/dispatches/:id', requirePermission('dispatch:create'), (req: AuthedRequest, res) => {
  const id = getParam(req.params.id);
  const dispatch = store.state.dispatches.find((d) => d.id === id);
  if (!dispatch) return res.status(404).json({ error: 'Dispatch not found' });
  if (!['DRAFT', 'PENDING_APPROVAL'].includes(dispatch.status)) {
    return res.status(400).json({ error: `Dispatch cannot be edited once in '${dispatch.status}' state.` });
  }
  const schema = z.object({
    vehicleId: z.string().optional(),
    driverId: z.string().nullable().optional(),
    deliveryDeadline: z.string().nullable().optional(),
    note: z.string().max(300).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid dispatch update payload' });

  const now = new Date().toISOString();
  if (parsed.data.vehicleId) {
    const veh = store.state.vehicles.find((v) => v.id === parsed.data.vehicleId && v.mode === dispatch.mode);
    if (!veh) return res.status(404).json({ error: 'Vehicle not found' });
    if (veh.status !== 'available') return res.status(409).json({ error: `Vehicle ${veh.callsign} is not available.` });
    dispatch.vehicleId = veh.id;
    dispatch.vehicleCallsign = veh.callsign;
  }
  if (parsed.data.driverId !== undefined) {
    if (parsed.data.driverId) {
      const drv = store.state.drivers.find((d) => d.id === parsed.data.driverId && d.mode === dispatch.mode);
      if (!drv) return res.status(404).json({ error: 'Driver not found' });
      dispatch.driverId = drv.id;
      dispatch.driverName = drv.name;
    } else {
      dispatch.driverId = null;
    }
  }
  if (parsed.data.deliveryDeadline !== undefined) {
    dispatch.deliveryDeadline = parsed.data.deliveryDeadline;
  }
  dispatch.updatedAt = now;
  dispatch.events.push({
    id: uuidv4(),
    status: dispatch.status,
    note: parsed.data.note || 'Dispatch proposal updated prior to approval',
    actor: req.actor!.name,
    timestamp: now,
  });
  store.save();
  res.json({ dispatch });
});

api.post('/dispatches/:id/approve', requirePermission('dispatch:approve'), (req: AuthedRequest, res) => {
  const id = getParam(req.params.id);
  try {
    const result = approveDispatchWorkflow({
      dispatchId: id,
      note: req.body?.note ? String(req.body.note) : undefined,
      overrideBlockedRoute: Boolean(req.body?.overrideBlockedRoute),
      actor: { name: req.actor!.name, role: req.actor!.role, orgId: req.actor!.orgId },
    });
    res.json(result);
  } catch (err) {
    return handleLogisticsError(res, err);
  }
});

api.post('/dispatches/:id/reject', requirePermission('dispatch:approve'), (req: AuthedRequest, res) => {
  const id = getParam(req.params.id);
  try {
    const dispatch = rejectDispatchWorkflow({
      dispatchId: id,
      reason: String(req.body?.reason || 'Rejected by command'),
      actor: { name: req.actor!.name, role: req.actor!.role, orgId: req.actor!.orgId },
    });
    res.json({ dispatch });
  } catch (err) {
    return handleLogisticsError(res, err);
  }
});

api.post('/dispatches/:id/load', requirePermission('dispatch:load'), (req: AuthedRequest, res) => {
  const id = getParam(req.params.id);
  try {
    const dispatch = transitionDispatchStage({
      dispatchId: id,
      action: 'load',
      note: req.body?.note ? String(req.body.note) : undefined,
      actor: { name: req.actor!.name, role: req.actor!.role, orgId: req.actor!.orgId },
    });
    res.json({ dispatch });
  } catch (err) {
    return handleLogisticsError(res, err);
  }
});

api.post('/dispatches/:id/depart', requirePermission('dispatch:update'), (req: AuthedRequest, res) => {
  const id = getParam(req.params.id);
  try {
    const dispatch = transitionDispatchStage({
      dispatchId: id,
      action: 'depart',
      note: req.body?.note ? String(req.body.note) : undefined,
      actor: { name: req.actor!.name, role: req.actor!.role, orgId: req.actor!.orgId },
    });
    res.json({ dispatch });
  } catch (err) {
    return handleLogisticsError(res, err);
  }
});

api.post('/dispatches/:id/arrive', requirePermission('dispatch:update'), (req: AuthedRequest, res) => {
  const id = getParam(req.params.id);
  try {
    const dispatch = transitionDispatchStage({
      dispatchId: id,
      action: 'arrive',
      note: req.body?.note ? String(req.body.note) : undefined,
      actor: { name: req.actor!.name, role: req.actor!.role, orgId: req.actor!.orgId },
    });
    res.json({ dispatch });
  } catch (err) {
    return handleLogisticsError(res, err);
  }
});

api.post('/dispatches/:id/deliver', requirePermission('delivery:confirm'), (req: AuthedRequest, res) => {
  const id = getParam(req.params.id);
  const schema = z.object({
    recipientName: z.string().min(2).max(120).default('Site Relief Coordinator'),
    recipientOrg: z.string().max(120).optional(),
    recipientRole: z.string().max(80).optional(),
    notes: z.string().max(600).optional(),
    proofRef: z.string().max(300).nullable().optional(),
    items: z
      .array(
        z.object({
          stockId: z.string().min(1),
          deliveredQty: z.number().int().min(0),
          damagedQty: z.number().int().min(0).optional(),
        })
      )
      .optional(),
    allowOverDeliveryCorrection: z.boolean().optional(),
  });
  const parsed = schema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid delivery confirmation payload', details: parsed.error.flatten() });
  }
  try {
    const result = confirmDeliveryWorkflow({
      dispatchId: id,
      ...parsed.data,
      actor: { name: req.actor!.name, role: req.actor!.role, orgId: req.actor!.orgId },
    });
    res.json(result);
  } catch (err) {
    return handleLogisticsError(res, err);
  }
});

api.post('/dispatches/:id/cancel', requirePermission('dispatch:cancel'), (req: AuthedRequest, res) => {
  const id = getParam(req.params.id);
  try {
    const dispatch = cancelDispatchWorkflow({
      dispatchId: id,
      reason: String(req.body?.reason || 'Cancelled by operations command'),
      actor: { name: req.actor!.name, role: req.actor!.role, orgId: req.actor!.orgId },
    });
    res.json({ dispatch });
  } catch (err) {
    return handleLogisticsError(res, err);
  }
});

api.get('/dispatches/:id/events', (req, res) => {
  const id = getParam(req.params.id);
  const dispatch = store.state.dispatches.find((d) => d.id === id);
  if (!dispatch) return res.status(404).json({ error: 'Dispatch not found' });
  res.json({ dispatchId: id, events: dispatch.events });
});

api.get('/dispatches/:id/tracking', (req, res) => {
  const id = getParam(req.params.id);
  try {
    const tracking = getDispatchTrackingSnapshot(id);
    res.json({ tracking });
  } catch (err) {
    return handleLogisticsError(res, err);
  }
});

// Backwards-compatible status endpoint (used by Phase 1-3 E2E tests)
api.post('/dispatches/:id/status', requirePermission('dispatch:update'), (req: AuthedRequest, res) => {
  const id = getParam(req.params.id);
  const dispatch = store.state.dispatches.find((d) => d.id === id);
  if (!dispatch) return res.status(404).json({ error: 'Dispatch not found' });

  const status = String(req.body?.status || '') as DispatchStatus;
  const valid: DispatchStatus[] = [
    'dispatch_created',
    'vehicle_assigned',
    'loading',
    'departed',
    'in_transit',
    'arrived',
    'delivered',
    'delivery_failed',
    'cancelled',
    'DELAYED',
    'RETURNING',
  ];
  if (!valid.includes(status)) return res.status(400).json({ error: 'Invalid dispatch status' });
  if (dispatch.status === 'PENDING_APPROVAL' || dispatch.status === 'DRAFT') {
    return res.status(400).json({ error: 'Cannot advance an unapproved dispatch — commander approval is required first.' });
  }
  if (dispatch.status === 'CANCELLED' || dispatch.status === 'cancelled' || dispatch.status === 'REJECTED') {
    return res.status(400).json({ error: `Cannot update a '${dispatch.status}' dispatch.` });
  }

  const actor = req.actor!;
  const now = new Date().toISOString();
  dispatch.status = status;
  dispatch.updatedAt = now;
  dispatch.events.push({
    id: uuidv4(),
    status,
    note: String(req.body?.note || `Updated to ${status}`),
    actor: actor.name,
    timestamp: now,
  });

  const vehicle = store.state.vehicles.find((v) => v.id === dispatch.vehicleId);
  if (vehicle) {
    if (status === 'loading') vehicle.status = 'loading';
    else if (status === 'departed') vehicle.status = 'dispatched';
    else if (status === 'in_transit') vehicle.status = 'in_transit';
    else if (status === 'DELAYED') vehicle.status = 'delayed';
    else if (status === 'delivered' || status === 'cancelled') {
      vehicle.status = 'available';
      vehicle.assignedDispatchId = null;
    }
    vehicle.updatedAt = now;
  }

  if (status === 'delivered') {
    dispatch.currentLat = dispatch.destinationLat;
    dispatch.currentLng = dispatch.destinationLng;
    dispatch.deliveredAt = now;
    const alloc = store.state.allocations.find((a) => a.id === dispatch.allocationId);
    const reliefReq = store.state.reliefRequests.find((r) => r.id === dispatch.requestId);
    if (alloc) {
      alloc.status = 'completed';
      alloc.updatedAt = now;
      for (const line of alloc.items) {
        const stock = store.state.inventory.find((i) => i.id === line.stockId);
        if (stock) {
          const deduct = Math.min(stock.reservedQty, line.quantity);
          stock.reservedQty -= deduct;
          stock.totalQty = Math.max(0, stock.totalQty - deduct);
          stock.version += 1;
          stock.updatedAt = now;
          store.state.stockMovements.unshift({
            id: uuidv4(),
            stockId: stock.id,
            warehouseId: stock.warehouseId,
            itemName: stock.itemName,
            type: 'outbound',
            quantity: deduct,
            previousAvailable: stock.availableQty,
            newAvailable: stock.availableQty,
            reason: `Delivered via Dispatch ${dispatch.id.slice(0, 8)} to ${dispatch.destinationName}`,
            referenceId: dispatch.id,
            actor: actor.name,
            role: actor.role,
            mode: dispatch.mode,
            createdAt: now,
          });
        }
        if (reliefReq) {
          const reqItem = reliefReq.items.find((it) => it.category === line.category);
          if (reqItem) {
            reqItem.fulfilledQuantity = Math.min(reqItem.quantity, reqItem.fulfilledQuantity + line.quantity);
          }
        }
      }
    }
    if (reliefReq) {
      reliefReq.status = 'delivered';
      reliefReq.fulfillmentStatus = 'fulfilled';
      reliefReq.updatedAt = now;
    }
  }

  store.save();

  store.addAudit({
    actor: actor.name,
    role: actor.role,
    orgId: actor.orgId,
    action: `dispatch.${status}`,
    entityType: 'dispatch',
    entityId: dispatch.id,
    summary: `Dispatch ${dispatch.vehicleCallsign} -> ${status}`,
    mode: dispatch.mode,
  });

  eventBus.publish({
    event_type: status === 'delivered' ? 'dispatch.completed' : 'dispatch.status_updated',
    organization_id: actor.orgId,
    entity_id: dispatch.id,
    source: 'dispatch-api',
    mode: dispatch.mode,
    payload: { dispatch },
  });

  res.json({ dispatch });
});

api.post('/dispatches/:id/location', requirePermission('dispatch:update'), (req: AuthedRequest, res) => {
  const id = getParam(req.params.id);
  const lat = Number(req.body?.lat);
  const lng = Number(req.body?.lng);
  const speedKmh = req.body?.speedKmh !== undefined ? Number(req.body.speedKmh) : null;
  const gpsSource = req.body?.gpsSource === 'authorized_device' ? 'authorized_device' : 'simulated_demo';
  try {
    const dispatch = recordDispatchGpsUpdate({
      dispatchId: id,
      lat,
      lng,
      speedKmh: Number.isFinite(speedKmh) ? speedKmh : null,
      gpsSource,
      actor: { name: req.actor!.name, role: req.actor!.role, orgId: req.actor!.orgId },
    });
    res.json({ dispatch });
  } catch (err) {
    return handleLogisticsError(res, err);
  }
});

// --- Delivery Confirmations ---
api.post('/deliveries/confirm', requirePermission('delivery:confirm'), (req: AuthedRequest, res) => {
  const schema = z.object({
    dispatchId: z.string().min(1),
    recipientName: z.string().min(2).max(120),
    recipientOrg: z.string().max(120).optional(),
    recipientRole: z.string().max(80).optional(),
    notes: z.string().max(600).optional(),
    proofRef: z.string().max(300).nullable().optional(),
    items: z
      .array(
        z.object({
          stockId: z.string().min(1),
          deliveredQty: z.number().int().min(0),
          damagedQty: z.number().int().min(0).optional(),
        })
      )
      .optional(),
    allowOverDeliveryCorrection: z.boolean().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid delivery confirmation payload', details: parsed.error.flatten() });
  }
  try {
    const result = confirmDeliveryWorkflow({
      ...parsed.data,
      actor: { name: req.actor!.name, role: req.actor!.role, orgId: req.actor!.orgId },
    });
    res.status(201).json(result);
  } catch (err) {
    return handleLogisticsError(res, err);
  }
});

api.get('/deliveries', (req, res) => {
  const mode = parseMode(req.query.mode);
  const dispatchId = req.query.dispatchId ? String(req.query.dispatchId) : null;
  const deliveries = store.state.deliveryConfirmations.filter(
    (c) => c.mode === mode && (!dispatchId || c.dispatchId === dispatchId)
  );
  res.json({ deliveries });
});

api.get('/deliveries/:id', (req, res) => {
  const id = getParam(req.params.id);
  const delivery = store.state.deliveryConfirmations.find((c) => c.id === id);
  if (!delivery) return res.status(404).json({ error: 'Delivery confirmation not found' });
  res.json({ delivery });
});

api.post('/deliveries/:id/verify', requirePermission('delivery:verify'), (req: AuthedRequest, res) => {
  const id = getParam(req.params.id);
  try {
    const delivery = verifyDeliveryConfirmation(
      id,
      req.body?.notes ? String(req.body.notes) : undefined,
      { name: req.actor!.name, role: req.actor!.role, orgId: req.actor!.orgId }
    );
    res.json({ delivery });
  } catch (err) {
    return handleLogisticsError(res, err);
  }
});

// --- Multi-Incident Coordination, Logistics Analytics & AI Logistics Assistant ---
api.get('/logistics/overview', (req, res) => {
  const mode = parseMode(req.query.mode);
  res.json(computeLogisticsOverview(mode));
});

api.get('/logistics/analytics/allocations', (req, res) => {
  const mode = parseMode(req.query.mode);
  const overview = computeLogisticsOverview(mode);
  const allocations = store.state.allocations.filter((a) => a.mode === mode);
  const byStatus: Record<string, number> = {};
  for (const a of allocations) {
    byStatus[a.status] = (byStatus[a.status] || 0) + 1;
  }
  res.json({
    mode,
    metrics: overview.allocationMetrics,
    byStatus,
    competingWarehouses: overview.coordination.competingWarehouses,
    timestamp: overview.timestamp,
  });
});

api.get('/logistics/analytics/fleet', (req, res) => {
  const mode = parseMode(req.query.mode);
  const overview = computeLogisticsOverview(mode);
  const vehicles = store.state.vehicles.filter((v) => v.mode === mode);
  const byType: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  for (const v of vehicles) {
    byType[v.vehicleType] = (byType[v.vehicleType] || 0) + 1;
    byStatus[v.status] = (byStatus[v.status] || 0) + 1;
  }
  res.json({
    mode,
    metrics: overview.fleetMetrics,
    byType,
    byStatus,
    fleetOverloaded: overview.coordination.fleetOverloaded,
    timestamp: overview.timestamp,
  });
});

api.get('/logistics/analytics/dispatches', (req, res) => {
  const mode = parseMode(req.query.mode);
  const overview = computeLogisticsOverview(mode);
  const dispatches = store.state.dispatches.filter((d) => d.mode === mode);
  const byStatus: Record<string, number> = {};
  for (const d of dispatches) {
    byStatus[d.status] = (byStatus[d.status] || 0) + 1;
  }
  res.json({
    mode,
    metrics: overview.dispatchMetrics,
    byStatus,
    delayedDispatchIds: overview.coordination.delayedDispatchIds,
    unservedHighPriorityIncidents: overview.coordination.unservedHighPriorityIncidents,
    timestamp: overview.timestamp,
  });
});

api.get('/logistics/analytics/delivery-performance', (req, res) => {
  const mode = parseMode(req.query.mode);
  res.json(computeDeliveryPerformance(mode));
});

api.get('/logistics/ai/advisories', (req, res) => {
  const mode = parseMode(req.query.mode);
  res.json({ advisories: store.state.logisticsAdvisories.filter((a) => a.mode === mode) });
});

api.post('/logistics/ai/assist', requirePermission('ai:run'), async (req: AuthedRequest, res) => {
  const schema = z.object({
    mode: z.enum(['operational', 'demo']).default('demo'),
    question: z.string().max(1200).optional(),
    requestId: z.string().optional(),
    allocationId: z.string().optional(),
    dispatchId: z.string().optional(),
    model: z.string().optional(),
  });
  const parsed = schema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid AI logistics assist payload' });
  }
  try {
    const advisory = await generateLogisticsAdvisory(parsed.data);
    store.addAudit({
      actor: req.actor!.name,
      role: req.actor!.role,
      orgId: req.actor!.orgId,
      action: 'ai.logistics_advisory',
      entityType: 'logistics_ai',
      entityId: advisory.id,
      summary: `Generated advisory logistics briefing (${advisory.model_used})`,
      mode: advisory.mode,
    });
    res.status(201).json({ advisory });
  } catch (err) {
    res.status(503).json({
      error: err instanceof Error ? err.message : 'AI Logistics Assistant unavailable.',
    });
  }
});

// ============================================================================
// 9. GEMINI AI SUITE & PHASE 6 MULTI-AGENT COORDINATION ROUTES
// ============================================================================

function handlePhase6Error(res: express.Response, err: unknown, fallbackMsg: string) {
  const code = typeof (err as any)?.statusCode === 'number' ? (err as any).statusCode : 400;
  res.status(code).json({ error: err instanceof Error ? err.message : fallbackMsg });
}

// --- Coordination Sessions ---

api.post('/ai/coordination/start', requirePermission('ai:coordinate'), async (req: AuthedRequest, res) => {
  try {
    const schema = z.object({
      incidentId: z.string().nullable().optional(),
      incident_id: z.string().nullable().optional(),
      objective: z.string().max(1000).optional(),
      mode: z.enum(['operational', 'demo']).default('demo'),
      triggerSource: z
        .enum(['manual_operator', 'incident_panel', 'proactive_trigger', 'reanalysis', 'api'])
        .optional(),
      waitForCompletion: z.boolean().optional(),
      skipLiveAI: z.boolean().optional(),
      timeoutMs: z.number().int().min(1000).max(30000).optional(),
      simulateAgentFailureId: z
        .enum([
          'agent-emergency-intel',
          'agent-environmental-intel',
          'agent-resource-intel',
          'agent-logistics-intel',
          'agent-human-impact',
          'agent-response-planner',
          'agent-response-monitor',
          'agent-safety-verifier',
        ])
        .optional(),
    });
    const parsed = schema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid coordination start payload', details: parsed.error.flatten() });
    }
    const out = await startCoordinationSession({
      incidentId: parsed.data.incidentId ?? parsed.data.incident_id ?? null,
      objective: parsed.data.objective,
      mode: parsed.data.mode,
      actor: req.actor!,
      triggerSource: parsed.data.triggerSource || 'manual_operator',
      waitForCompletion: parsed.data.waitForCompletion !== false,
      skipLiveAI: parsed.data.skipLiveAI,
      timeoutMs: parsed.data.timeoutMs,
      simulateAgentFailureId: parsed.data.simulateAgentFailureId,
    });
    res.status(201).json(out);
  } catch (err) {
    handlePhase6Error(res, err, 'Failed to start AI coordination session');
  }
});

api.get('/ai/coordination/sessions', (req: AuthedRequest, res) => {
  const mode = parseMode(req.query.mode);
  const incidentId = typeof req.query.incidentId === 'string' ? req.query.incidentId : null;
  const status = typeof req.query.status === 'string' ? req.query.status : null;
  const sessions = store.state.aiCoordinationSessions.filter(
    (s) =>
      s.mode === mode &&
      canAccessOrg(req.actor!, s.org_id) &&
      (!incidentId || s.incident_id === incidentId) &&
      (!status || s.status === status)
  );
  res.json({ sessions, total: sessions.length });
});

api.get('/ai/coordination/sessions/:session_id', (req: AuthedRequest, res) => {
  try {
    const session = store.state.aiCoordinationSessions.find((s) => s.session_id === req.params.session_id);
    if (!session) return res.status(404).json({ error: 'Coordination session not found' });
    assertOrgAccess(req.actor!, session.org_id, 'coordination session');

    const tasks = store.state.aiAgentTasks.filter((t) => t.session_id === session.session_id);
    const results = store.state.aiAgentResults.filter((r) => r.session_id === session.session_id);
    const plan = store.state.aiResponsePlans.find((p) => p.plan_id === session.plan_id) || null;
    const actions = plan ? store.state.aiPlanActions.filter((a) => a.plan_id === plan.plan_id) : [];
    const approval = store.state.aiApprovalRequests.find((a) => a.session_id === session.session_id) || null;
    const conflicts = store.state.aiConflicts.filter((c) => c.session_id === session.session_id);
    const evidence = store.state.aiEvidenceRecords.filter((e) => e.session_id === session.session_id);
    const memory = getSessionMemoryEntries(session.session_id, req.actor!);
    const events = store.state.aiCoordinationEvents.filter((e) => e.session_id === session.session_id);

    res.json({ session, tasks, results, plan, actions, approval, conflicts, evidence, memory, events });
  } catch (err) {
    handlePhase6Error(res, err, 'Failed to fetch coordination session');
  }
});

api.get('/ai/coordination/sessions/:session_id/events', (req: AuthedRequest, res) => {
  try {
    const session = store.state.aiCoordinationSessions.find((s) => s.session_id === req.params.session_id);
    if (!session) return res.status(404).json({ error: 'Coordination session not found' });
    assertOrgAccess(req.actor!, session.org_id, 'coordination session');
    const events = store.state.aiCoordinationEvents.filter((e) => e.session_id === session.session_id);
    res.json({ session_id: session.session_id, events, total: events.length });
  } catch (err) {
    handlePhase6Error(res, err, 'Failed to fetch coordination events');
  }
});

api.post('/ai/coordination/sessions/:session_id/cancel', requirePermission('ai:coordinate'), (req: AuthedRequest, res) => {
  try {
    const session = cancelCoordinationSession(req.params.session_id, req.actor!);
    res.json({ session });
  } catch (err) {
    handlePhase6Error(res, err, 'Failed to cancel coordination session');
  }
});

api.post('/ai/coordination/sessions/:session_id/reanalyze', requirePermission('ai:coordinate'), async (req: AuthedRequest, res) => {
  try {
    const prior = store.state.aiCoordinationSessions.find((s) => s.session_id === req.params.session_id);
    if (!prior) return res.status(404).json({ error: 'Coordination session not found' });
    assertOrgAccess(req.actor!, prior.org_id, 'coordination session');

    const out = await startCoordinationSession({
      incidentId: prior.incident_id,
      objective: typeof req.body?.objective === 'string' && req.body.objective.trim() ? req.body.objective : prior.objective,
      mode: prior.mode,
      actor: req.actor!,
      triggerSource: 'reanalysis',
      waitForCompletion: req.body?.waitForCompletion !== false,
      skipLiveAI: Boolean(req.body?.skipLiveAI),
    });
    res.status(201).json({ ...out, reanalyzed_from: prior.session_id });
  } catch (err) {
    handlePhase6Error(res, err, 'Failed to reanalyze coordination session');
  }
});

// --- Agent Registry & Tasks ---

api.get('/ai/agents', (_req, res) => {
  const agents = getAgentRegistry();
  res.json({ agents, versions: store.state.aiAgentVersions });
});

api.get('/ai/agents/status', (_req, res) => {
  res.json(getAgentStatusSummary());
});

api.get('/ai/agents/:agent_id', (req, res) => {
  const agents = getAgentRegistry();
  const agent = agents.find((a) => a.agent_id === req.params.agent_id);
  if (!agent) return res.status(404).json({ error: 'Agent not found in registry' });
  const versions = store.state.aiAgentVersions.filter((v) => v.agent_id === agent.agent_id);
  res.json({ agent, versions });
});

api.get('/ai/agents/:agent_id/history', (req: AuthedRequest, res) => {
  const mode = parseMode(req.query.mode);
  const agentId = req.params.agent_id as CoordinationAgentId;
  const tasks = store.state.aiAgentTasks.filter(
    (t) => t.agent_id === agentId && t.mode === mode && canAccessOrg(req.actor!, t.org_id)
  );
  const results = store.state.aiAgentResults.filter(
    (r) => r.agent_id === agentId && r.mode === mode && canAccessOrg(req.actor!, r.org_id)
  );
  res.json({ agent_id: agentId, tasks, results });
});

api.post('/ai/agents/:agent_id/rerun', requirePermission('ai:coordinate'), async (req: AuthedRequest, res) => {
  try {
    const sessionId = String(req.body?.sessionId || req.body?.session_id || '');
    if (!sessionId) return res.status(400).json({ error: 'sessionId is required to rerun an agent' });
    const out = await rerunSingleAgentTask({
      sessionId,
      agentId: req.params.agent_id as CoordinationAgentId,
      actor: req.actor!,
    });
    res.json(out);
  } catch (err) {
    handlePhase6Error(res, err, 'Failed to rerun agent');
  }
});

// Preserves backwards compatibility ({ tasks }) while exposing Phase 6 multi-agent tasks ({ agentTasks })
api.get('/ai/tasks', (req: AuthedRequest, res) => {
  const mode = parseMode(req.query.mode);
  const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : null;
  const agentTasks = store.state.aiAgentTasks.filter(
    (t) => t.mode === mode && canAccessOrg(req.actor!, t.org_id) && (!sessionId || t.session_id === sessionId)
  );
  res.json({
    tasks: store.state.aiTasks.filter((t) => t.mode === mode),
    agentTasks,
  });
});

api.get('/ai/tasks/:task_id', (req: AuthedRequest, res) => {
  try {
    const task = store.state.aiAgentTasks.find((t) => t.task_id === req.params.task_id);
    if (!task) return res.status(404).json({ error: 'Agent task not found' });
    assertOrgAccess(req.actor!, task.org_id, 'agent task');
    const result = store.state.aiAgentResults.find((r) => r.task_id === task.task_id) || null;
    res.json({ task, result });
  } catch (err) {
    handlePhase6Error(res, err, 'Failed to fetch agent task');
  }
});

// --- Plans & Human Approvals ---

api.get('/ai/plans', (req: AuthedRequest, res) => {
  const mode = parseMode(req.query.mode);
  const status = typeof req.query.status === 'string' ? req.query.status : null;
  const incidentId = typeof req.query.incidentId === 'string' ? req.query.incidentId : null;
  const plans = store.state.aiResponsePlans.filter(
    (p) =>
      p.mode === mode &&
      canAccessOrg(req.actor!, p.org_id) &&
      (!status || p.status === status) &&
      (!incidentId || p.incident_id === incidentId)
  );
  res.json({ plans, total: plans.length });
});

api.get('/ai/plans/:plan_id', (req: AuthedRequest, res) => {
  try {
    const plan = store.state.aiResponsePlans.find((p) => p.plan_id === req.params.plan_id);
    if (!plan) return res.status(404).json({ error: 'Response plan not found' });
    assertOrgAccess(req.actor!, plan.org_id, 'response plan');
    const actions = store.state.aiPlanActions.filter((a) => a.plan_id === plan.plan_id);
    const approval = store.state.aiApprovalRequests.find((a) => a.plan_id === plan.plan_id) || null;
    const approvalEvents = store.state.aiApprovalEvents.filter((e) => e.plan_id === plan.plan_id);
    const conflicts = store.state.aiConflicts.filter((c) => c.plan_id === plan.plan_id);
    res.json({ plan, actions, approval, approvalEvents, conflicts });
  } catch (err) {
    handlePhase6Error(res, err, 'Failed to fetch response plan');
  }
});

api.post('/ai/plans/:plan_id/validate', requirePermission('ai:coordinate'), (req: AuthedRequest, res) => {
  try {
    const out = validatePlanNow(req.params.plan_id, req.actor!);
    res.json(out);
  } catch (err) {
    handlePhase6Error(res, err, 'Failed to validate response plan');
  }
});

api.post('/ai/plans/:plan_id/approve', requirePermission('ai:plan_approve'), (req: AuthedRequest, res) => {
  try {
    const out = decidePlanApproval({
      planId: req.params.plan_id,
      decision: 'APPROVE',
      note: typeof req.body?.note === 'string' ? req.body.note : undefined,
      actionIds: Array.isArray(req.body?.actionIds) ? req.body.actionIds : undefined,
      actor: req.actor!,
    });
    res.json(out);
  } catch (err) {
    handlePhase6Error(res, err, 'Failed to approve response plan');
  }
});

api.post('/ai/plans/:plan_id/reject', requirePermission('ai:plan_approve'), (req: AuthedRequest, res) => {
  try {
    const out = decidePlanApproval({
      planId: req.params.plan_id,
      decision: 'REJECT',
      note: typeof req.body?.reason === 'string' ? req.body.reason : typeof req.body?.note === 'string' ? req.body.note : undefined,
      actor: req.actor!,
    });
    res.json(out);
  } catch (err) {
    handlePhase6Error(res, err, 'Failed to reject response plan');
  }
});

api.post('/ai/plans/:plan_id/defer', requirePermission('ai:plan_approve'), (req: AuthedRequest, res) => {
  try {
    const out = decidePlanApproval({
      planId: req.params.plan_id,
      decision: 'DEFER',
      note: typeof req.body?.note === 'string' ? req.body.note : undefined,
      actor: req.actor!,
    });
    res.json(out);
  } catch (err) {
    handlePhase6Error(res, err, 'Failed to defer response plan');
  }
});

api.post('/ai/plans/:plan_id/modify', requirePermission('ai:plan_approve'), (req: AuthedRequest, res) => {
  try {
    const schema = z.object({
      modificationNotes: z.string().min(2).max(800),
      actionUpdates: z
        .array(
          z.object({
            action_id: z.string().min(1),
            status: z.enum(['APPROVED', 'MODIFIED', 'REJECTED', 'DEFERRED']).optional(),
            modified_parameters: z.record(z.string(), z.unknown()).optional(),
          })
        )
        .default([]),
    });
    const parsed = schema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: 'Invalid plan modification payload' });
    const out = modifyPlanActions({
      planId: req.params.plan_id,
      actor: req.actor!,
      modificationNotes: parsed.data.modificationNotes,
      actionUpdates: parsed.data.actionUpdates,
    });
    res.json(out);
  } catch (err) {
    handlePhase6Error(res, err, 'Failed to modify response plan');
  }
});

api.post('/ai/plans/:plan_id/execute', requirePermission('ai:plan_execute'), async (req: AuthedRequest, res) => {
  try {
    const out = await executeApprovedPlan({
      planId: req.params.plan_id,
      actor: req.actor!,
    });
    res.json(out);
  } catch (err) {
    handlePhase6Error(res, err, 'Failed to execute approved plan');
  }
});

api.get('/ai/approvals', (req: AuthedRequest, res) => {
  const mode = parseMode(req.query.mode);
  const status = typeof req.query.status === 'string' ? req.query.status : null;
  const approvals = store.state.aiApprovalRequests.filter(
    (a) => a.mode === mode && canAccessOrg(req.actor!, a.org_id) && (!status || a.status === status)
  );
  const events = store.state.aiApprovalEvents
    .filter((e) => e.mode === mode && canAccessOrg(req.actor!, e.org_id))
    .slice(0, 60);
  res.json({ approvals, events });
});

// --- Evidence Explorer ---

api.get('/ai/evidence', (req: AuthedRequest, res) => {
  const mode = parseMode(req.query.mode);
  const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : null;
  const classification = typeof req.query.classification === 'string' ? req.query.classification : null;
  const sourceType = typeof req.query.sourceType === 'string' ? req.query.sourceType : null;
  const evidence = store.state.aiEvidenceRecords.filter(
    (e) =>
      e.mode === mode &&
      canAccessOrg(req.actor!, e.org_id) &&
      (!sessionId || e.session_id === sessionId) &&
      (!classification || e.claim_classification === classification) &&
      (!sourceType || e.source_type === sourceType)
  );
  res.json({ evidence: evidence.slice(0, 200), total: evidence.length });
});

api.get('/ai/evidence/:evidence_id', (req: AuthedRequest, res) => {
  try {
    const ev = store.state.aiEvidenceRecords.find((e) => e.evidence_id === req.params.evidence_id);
    if (!ev) return res.status(404).json({ error: 'Evidence record not found' });
    assertOrgAccess(req.actor!, ev.org_id, 'evidence record');
    res.json({ evidence: ev });
  } catch (err) {
    handlePhase6Error(res, err, 'Failed to fetch evidence record');
  }
});

// --- Conflicts ---

api.get('/ai/conflicts', (req: AuthedRequest, res) => {
  const mode = parseMode(req.query.mode);
  const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : null;
  const status = typeof req.query.status === 'string' ? req.query.status : null;
  const conflicts = store.state.aiConflicts.filter(
    (c) =>
      c.mode === mode &&
      canAccessOrg(req.actor!, c.org_id) &&
      (!sessionId || c.session_id === sessionId) &&
      (!status || c.resolution_status === status)
  );
  res.json({ conflicts, total: conflicts.length });
});

api.post('/ai/conflicts/:conflict_id/resolve', requirePermission('ai:conflict_resolve'), (req: AuthedRequest, res) => {
  try {
    const schema = z.object({
      resolutionNote: z.string().min(3).max(800),
      resolutionStrategy: z.string().max(500).optional(),
    });
    const parsed = schema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: 'resolutionNote (min 3 chars) is required' });
    const conflict = resolveConflictByHuman({
      conflictId: req.params.conflict_id,
      resolutionNote: parsed.data.resolutionNote,
      resolutionStrategy: parsed.data.resolutionStrategy,
      actor: req.actor!,
    });
    res.json({ conflict });
  } catch (err) {
    handlePhase6Error(res, err, 'Failed to resolve conflict');
  }
});

// --- Session Coordination Memory ---

api.get('/ai/sessions/:session_id/memory', (req: AuthedRequest, res) => {
  try {
    const memory = getSessionMemoryEntries(req.params.session_id, req.actor!);
    res.json({ session_id: req.params.session_id, memory, total: memory.length });
  } catch (err) {
    handlePhase6Error(res, err, 'Failed to read session memory');
  }
});

api.post('/ai/sessions/:session_id/memory', requirePermission('ai:memory_write'), (req: AuthedRequest, res) => {
  try {
    const session = store.state.aiCoordinationSessions.find((s) => s.session_id === req.params.session_id);
    if (!session) return res.status(404).json({ error: 'Coordination session not found' });
    assertOrgAccess(req.actor!, session.org_id, 'coordination session');

    const schema = z.object({
      memoryType: z.enum(['session_context', 'verified_incident_history', 'human_decision', 'ai_conclusion']),
      title: z.string().min(2).max(200),
      content: z.string().min(2).max(2000),
      sourceRefs: z.array(z.string()).optional(),
      ttlHours: z.number().min(1).max(720).optional(),
    });
    const parsed = schema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: 'Invalid memory entry payload' });

    const entry = addSessionMemoryEntry({
      sessionId: session.session_id,
      incidentId: session.incident_id,
      orgId: session.org_id,
      memoryType: parsed.data.memoryType,
      title: parsed.data.title,
      content: parsed.data.content,
      sourceRefs: parsed.data.sourceRefs,
      createdBy: req.actor!.name,
      ttlHours: parsed.data.ttlHours,
      mode: session.mode,
    });
    res.status(201).json({ memory: entry });
  } catch (err) {
    handlePhase6Error(res, err, 'Failed to create memory entry');
  }
});

// --- Isolated Scenario Simulation Engine ---

const SIMULATION_TYPES: [AISimulationType, ...AISimulationType[]] = [
  'flood_escalation',
  'rainfall_increase',
  'warehouse_closure',
  'resource_shortage',
  'vehicle_breakdown',
  'route_disruption',
  'new_emergency_request',
  'population_increase',
  'delivery_delay',
  'power_outage',
  'multi_incident',
];

api.post('/ai/simulations', requirePermission('ai:simulate'), (req: AuthedRequest, res) => {
  try {
    const schema = z.object({
      title: z.string().min(3).max(180),
      scenarioType: z.enum(SIMULATION_TYPES),
      incidentId: z.string().nullable().optional(),
      parameters: z.record(z.string(), z.unknown()).optional(),
      mode: z.enum(['operational', 'demo']).default('demo'),
    });
    const parsed = schema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: 'Invalid simulation payload', details: parsed.error.flatten() });

    const simulation = createSimulationSession({
      title: parsed.data.title,
      scenarioType: parsed.data.scenarioType,
      incidentId: parsed.data.incidentId ?? null,
      parameters: parsed.data.parameters,
      mode: parsed.data.mode,
      actor: req.actor!,
    });
    res.status(201).json({ simulation });
  } catch (err) {
    handlePhase6Error(res, err, 'Failed to create simulation');
  }
});

api.get('/ai/simulations', (req: AuthedRequest, res) => {
  const mode = parseMode(req.query.mode);
  const simulations = store.state.aiSimulationSessions.filter(
    (s) => s.mode === mode && canAccessOrg(req.actor!, s.org_id)
  );
  const results = store.state.aiSimulationResults.filter(
    (r) => r.mode === mode && canAccessOrg(req.actor!, r.org_id)
  );
  res.json({ label: 'SIMULATION — NOT A LIVE EMERGENCY', simulations, results });
});

api.post('/ai/simulations/compare', requirePermission('ai:simulate'), (req: AuthedRequest, res) => {
  try {
    const schema = z.object({
      simulationIds: z.array(z.string().min(1)).min(1).max(10),
    });
    const parsed = schema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: 'simulationIds array (1–10) required' });
    const comparison = compareSimulations(parsed.data.simulationIds, req.actor!);
    res.json(comparison);
  } catch (err) {
    handlePhase6Error(res, err, 'Failed to compare simulations');
  }
});

api.get('/ai/simulations/:simulation_id', (req: AuthedRequest, res) => {
  try {
    const simulation = store.state.aiSimulationSessions.find((s) => s.simulation_id === req.params.simulation_id);
    if (!simulation) return res.status(404).json({ error: 'Simulation not found' });
    assertOrgAccess(req.actor!, simulation.org_id, 'simulation');
    const result = store.state.aiSimulationResults.find((r) => r.simulation_id === simulation.simulation_id) || null;
    res.json({ simulation, result });
  } catch (err) {
    handlePhase6Error(res, err, 'Failed to fetch simulation');
  }
});

api.post('/ai/simulations/:simulation_id/run', requirePermission('ai:simulate'), (req: AuthedRequest, res) => {
  try {
    const out = runIsolatedSimulation(req.params.simulation_id, req.actor!);
    res.json(out);
  } catch (err) {
    handlePhase6Error(res, err, 'Failed to run simulation');
  }
});

// --- Proactive Monitoring Triggers ---

api.get('/ai/monitoring/triggers', (req: AuthedRequest, res) => {
  const mode = parseMode(req.query.mode);
  const status = typeof req.query.status === 'string' ? req.query.status : null;
  const triggers = store.state.aiTriggerEvents.filter(
    (t) => t.mode === mode && canAccessOrg(req.actor!, t.org_id) && (!status || t.status === status)
  );
  res.json({ triggers, total: triggers.length });
});

api.post('/ai/monitoring/triggers/:trigger_id/acknowledge', requirePermission('ai:monitoring_manage'), (req: AuthedRequest, res) => {
  try {
    const trigger = acknowledgeTriggerEvent(req.params.trigger_id, req.actor!);
    res.json({ trigger });
  } catch (err) {
    handlePhase6Error(res, err, 'Failed to acknowledge trigger');
  }
});

// --- AI Coordination Analytics ---

api.get('/ai/analytics', (req: AuthedRequest, res) => {
  const mode = parseMode(req.query.mode);
  res.json(computeAICoordinationAnalytics(mode, req.actor!));
});

api.post('/ai/agent', requirePermission('ai:run'), async (req: AuthedRequest, res) => {
  try {
    const schema = z.object({
      agentType: z.enum([
        'risk_intelligence',
        'priority',
        'resource',
        'allocation',
        'route',
        'demand_forecast',
        'situation_report',
        'coordination',
      ]),
      mode: z.enum(['operational', 'demo']).default('demo'),
      prompt: z.string().optional(),
      entityId: z.string().optional(),
      model: z.string().optional(),
      highThinking: z.boolean().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid AI agent request' });

    const output = await runStructuredAgent(parsed.data);
    store.addAudit({
      actor: req.actor!.name,
      role: req.actor!.role,
      orgId: req.actor!.orgId,
      action: `ai.agent.${output.agent_type}`,
      entityType: 'ai_task',
      entityId: output.task_id,
      summary: `Executed ${output.agent_type} agent (${output.model_used})`,
      mode: output.mode,
    });
    eventBus.publish({
      event_type: 'ai.recommendation_generated',
      organization_id: req.actor!.orgId,
      entity_id: output.task_id,
      source: 'gemini-agents',
      mode: output.mode,
      payload: { task: output },
    });
    res.json({ task: output });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : 'AI agent failed' });
  }
});

api.post('/ai/chat', requirePermission('ai:run'), async (req, res) => {
  try {
    const schema = z.object({
      messages: z.array(z.object({ role: z.enum(['user', 'model']), text: z.string().min(1) })).min(1),
      mode: z.enum(['operational', 'demo']).default('demo'),
      model: z.string().optional(),
      highThinking: z.boolean().optional(),
      useGoogleSearch: z.boolean().optional(),
      useGoogleMaps: z.boolean().optional(),
      lat: z.number().optional(),
      lng: z.number().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid chat payload' });

    const reply = await runCommandChat(parsed.data);
    res.json(reply);
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : 'Chat request failed' });
  }
});

api.post('/ai/analyze-media', requirePermission('ai:run'), async (req, res) => {
  try {
    const { base64Data, mimeType, prompt, model } = req.body || {};
    if (!base64Data || !mimeType) return res.status(400).json({ error: 'base64Data and mimeType required' });
    const result = await analyzeMedia({ base64Data, mimeType, prompt: String(prompt || ''), model });
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : 'Media analysis failed' });
  }
});

api.post('/ai/transcribe', requirePermission('ai:run'), async (req, res) => {
  try {
    const { base64Data, mimeType, prompt } = req.body || {};
    if (!base64Data || !mimeType) return res.status(400).json({ error: 'Audio base64Data and mimeType required' });
    const result = await transcribeAudio({ base64Data, mimeType, prompt });
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : 'Audio transcription failed' });
  }
});

api.post('/ai/tts', requirePermission('ai:run'), async (req, res) => {
  try {
    const { text, voiceName, model } = req.body || {};
    if (!text || String(text).trim().length < 2) return res.status(400).json({ error: 'Broadcast text required' });
    const result = await generateSpeech({ text: String(text), voiceName, model });
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : 'TTS generation failed' });
  }
});

api.post('/ai/image', requirePermission('ai:run'), async (req, res) => {
  try {
    const { prompt, model, aspectRatio, imageSize, sourceImageBase64, sourceMimeType } = req.body || {};
    if (!prompt) return res.status(400).json({ error: 'Prompt required' });
    const result = await generateOrEditImage({
      prompt: String(prompt),
      model,
      aspectRatio,
      imageSize,
      sourceImageBase64,
      sourceMimeType,
    });
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : 'Image generation failed' });
  }
});

api.post('/ai/video', requirePermission('ai:run'), async (req, res) => {
  try {
    const { prompt, aspectRatio, duration, resolution, sourceImageBase64, sourceMimeType } = req.body || {};
    if (!prompt) return res.status(400).json({ error: 'Prompt required' });
    const result = await generateOrAnimateVideo({
      prompt: String(prompt),
      aspectRatio,
      duration,
      resolution,
      sourceImageBase64,
      sourceMimeType,
    });
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : 'Video generation failed' });
  }
});

api.post('/ai/music', requirePermission('ai:run'), async (req, res) => {
  try {
    const { prompt, model } = req.body || {};
    if (!prompt) return res.status(400).json({ error: 'Music prompt required' });
    const result = await generateMusic({ prompt: String(prompt), model });
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : 'Music generation failed' });
  }
});

// ============================================================================
// 10. ANALYTICS, CSV EXPORT, NOTIFICATIONS, EVENTS, AUDIT, SETTINGS & DEMO RESET
// ============================================================================

api.get('/analytics/overview', (req, res) => {
  const mode = parseMode(req.query.mode);
  const incidents = store.state.incidents.filter((i) => i.mode === mode);
  const requests = store.state.reliefRequests.filter((r) => r.mode === mode);
  const inventory = store.state.inventory.filter((i) => i.mode === mode);
  const dispatches = store.state.dispatches.filter((d) => d.mode === mode);
  const allocations = store.state.allocations.filter((a) => a.mode === mode);

  const bySeverity = ['critical', 'high', 'medium', 'low'].map((sev) => ({
    severity: sev,
    incidents: incidents.filter((i) => i.severity === sev).length,
    requests: requests.filter((r) => r.priorityCategory === sev).length,
  }));

  const categories = Array.from(new Set(inventory.map((i) => i.category)));
  const supplyVsDemand = categories.map((cat) => {
    const available = inventory.filter((i) => i.category === cat).reduce((s, i) => s + i.availableQty, 0);
    const reserved = inventory.filter((i) => i.category === cat).reduce((s, i) => s + i.reservedQty, 0);
    const demand = requests.reduce(
      (s, r) => s + r.items.filter((it) => it.category === cat).reduce((x, it) => x + Math.max(0, it.quantity - it.fulfilledQuantity), 0),
      0
    );
    return { category: cat.replace(/_/g, ' '), available, reserved, demand };
  });

  const warehouseUtilization = store.state.warehouses
    .filter((w) => w.mode === mode)
    .map((w) => {
      const items = inventory.filter((i) => i.warehouseId === w.id);
      const availableUnits = items.reduce((s, i) => s + i.availableQty, 0);
      const reservedUnits = items.reduce((s, i) => s + i.reservedQty, 0);
      return { name: w.name.replace(' (DEMO)', ''), availableUnits, reservedUnits, capacityUnits: w.capacityUnits };
    });

  const totalRequestedQty = requests.reduce((s, r) => s + r.items.reduce((x, it) => x + it.quantity, 0), 0);
  const totalFulfilledQty = requests.reduce((s, r) => s + r.items.reduce((x, it) => x + it.fulfilledQuantity, 0), 0);
  const fulfillmentRatePct = totalRequestedQty > 0 ? Math.round((totalFulfilledQty / totalRequestedQty) * 100) : 0;

  res.json({
    mode,
    kpis: {
      activeIncidents: incidents.filter((i) => i.status !== 'resolved' && i.status !== 'archived').length,
      criticalIncidents: incidents.filter((i) => i.severity === 'critical' && i.status !== 'resolved').length,
      totalPeopleAffected: incidents.reduce((s, i) => s + i.peopleAffected, 0),
      openReliefRequests: requests.filter((r) => r.status !== 'closed' && r.status !== 'delivered').length,
      shortageSkus: inventory.filter((i) => i.availableQty < i.minStock).length,
      activeDispatches: dispatches.filter((d) => d.status !== 'delivered' && d.status !== 'cancelled').length,
      completedDeliveries: dispatches.filter((d) => d.status === 'delivered').length,
      pendingApprovals: allocations.filter((a) => a.status === 'proposed').length,
      fulfillmentRatePct,
    },
    bySeverity,
    supplyVsDemand,
    warehouseUtilization,
  });
});

api.get('/analytics/export', (req, res) => {
  const mode = parseMode(req.query.mode);
  const dataset = String(req.query.dataset || 'incidents');
  let csv = '';

  if (dataset === 'inventory') {
    const rows = store.state.inventory.filter((i) => i.mode === mode);
    csv =
      'id,warehouseId,sku,itemName,category,availableQty,reservedQty,minStock,mode,updatedAt\n' +
      rows
        .map((r) =>
          [r.id, r.warehouseId, r.sku, r.itemName, r.category, r.availableQty, r.reservedQty, r.minStock, r.mode, r.updatedAt]
            .map(csvEscape)
            .join(',')
        )
        .join('\n');
  } else if (dataset === 'requests') {
    const rows = store.state.reliefRequests.filter((r) => r.mode === mode);
    csv =
      'id,incidentId,locationName,urgency,priorityScore,priorityCategory,status,peopleAffected,mode,createdAt\n' +
      rows
        .map((r) =>
          [r.id, r.incidentId, r.locationName, r.urgency, r.priorityScore, r.priorityCategory, r.status, r.peopleAffected, r.mode, r.createdAt]
            .map(csvEscape)
            .join(',')
        )
        .join('\n');
  } else {
    const rows = store.state.incidents.filter((i) => i.mode === mode);
    csv =
      'id,title,type,severity,status,region,peopleAffected,vulnerablePopulation,riskScore,mode,reportedAt\n' +
      rows
        .map((r) =>
          [r.id, r.title, r.type, r.severity, r.status, r.region, r.peopleAffected, r.vulnerablePopulation, r.riskScore ?? '', r.mode, r.reportedAt]
            .map(csvEscape)
            .join(',')
        )
        .join('\n');
  }

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="resqflow-${mode}-${dataset}.csv"`);
  res.send(csv);
});

api.get('/notifications', (req, res) => {
  const mode = parseMode(req.query.mode);
  const list = store.state.notifications.filter((n) => n.mode === mode);
  res.json({ notifications: list, unreadCount: list.filter((n) => !n.read).length });
});

api.post('/notifications/:id/read', (req, res) => {
  const id = getParam(req.params.id);
  const notif = store.state.notifications.find((n) => n.id === id);
  if (notif) {
    notif.read = true;
    store.save();
  }
  res.json({ ok: true });
});

api.post('/notifications/read-all', (req, res) => {
  const mode = parseMode(req.body?.mode);
  for (const n of store.state.notifications) {
    if (n.mode === mode) n.read = true;
  }
  store.save();
  res.json({ ok: true });
});

api.get('/events', (req, res) => {
  const mode = parseMode(req.query.mode);
  const sinceEventId = req.query.sinceEventId ? String(req.query.sinceEventId) : null;
  const list = sinceEventId
    ? eventBus.getEventsSince(sinceEventId).filter((e) => e.mode === mode)
    : store.state.events.filter((e) => e.mode === mode).slice(0, 40);
  res.json({ events: list });
});

api.get('/audit-logs', (req, res) => {
  const mode = parseMode(req.query.mode);
  res.json({ logs: store.state.auditLogs.filter((l) => l.mode === mode).slice(0, 120) });
});

api.get('/organizations', (_req, res) => {
  res.json({ organizations: store.state.organizations });
});

api.get('/settings', (_req, res) => {
  res.json({ settings: store.state.settings });
});

api.put('/settings', requirePermission('admin:reset_demo'), (req: AuthedRequest, res) => {
  const { priorityWeights, weatherFreshnessSeconds, inventoryFreshnessSeconds } = req.body || {};
  if (priorityWeights) {
    const sum =
      Number(priorityWeights.S) +
      Number(priorityWeights.N) +
      Number(priorityWeights.V) +
      Number(priorityWeights.U) +
      Number(priorityWeights.A);
    if (Math.abs(sum - 1) > 0.02) {
      return res.status(400).json({ error: 'Priority weights S+N+V+U+A must sum to 1.00.' });
    }
    store.state.settings.priorityWeights = priorityWeights;
  }
  if (typeof weatherFreshnessSeconds === 'number' && weatherFreshnessSeconds >= 60) {
    store.state.settings.weatherFreshnessSeconds = weatherFreshnessSeconds;
  }
  if (typeof inventoryFreshnessSeconds === 'number' && inventoryFreshnessSeconds >= 60) {
    store.state.settings.inventoryFreshnessSeconds = inventoryFreshnessSeconds;
  }
  store.save();
  res.json({ settings: store.state.settings });
});

api.post('/demo/reset', requirePermission('admin:reset_demo'), (req: AuthedRequest, res) => {
  store.resetDemoData();
  store.addAudit({
    actor: req.actor!.name,
    role: req.actor!.role,
    orgId: req.actor!.orgId,
    action: 'demo.reset',
    entityType: 'system',
    entityId: 'demo-dataset',
    summary: 'Reset isolated Demo Mode dataset without altering Operational Mode records.',
    mode: 'demo',
  });
  eventBus.publish({
    event_type: 'demo.reset',
    organization_id: req.actor!.orgId,
    entity_id: 'demo-dataset',
    source: 'admin-api',
    mode: 'demo',
    payload: { resetAt: new Date().toISOString() },
  });
  res.json({ ok: true, message: 'Demo dataset reset cleanly. Operational records untouched.' });
});

app.use('/api/v1', api);

// Ensure unknown /api/* requests always receive JSON 404 rather than falling through to SPA index.html
app.all(['/api', '/api/*'], (_req, res) => {
  res.status(404).json({ error: 'API endpoint not found.', code: 'API_NOT_FOUND' });
});

// Global JSON error handler — handles malformed JSON (400/413) and unexpected server errors safely without leaking stack traces
app.use((err: any, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (res.headersSent) return next(err);
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Request payload exceeds maximum allowed size.', code: 'PAYLOAD_TOO_LARGE' });
  }
  if (err?.type === 'entity.parse.failed' || err instanceof SyntaxError) {
    return res.status(400).json({ error: 'Malformed JSON request body.', code: 'INVALID_JSON' });
  }
  console.error(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: 'error',
      service: 'resqflow-api',
      code: 'UNHANDLED_ERROR',
      message: err instanceof Error ? err.message : 'Unexpected server error',
    })
  );
  return res.status(500).json({ error: 'Internal server error. Please retry shortly.', code: 'INTERNAL_ERROR' });
});

ensureAgentRegistrySeeded();

export { app };
export default app;

// ============================================================================
// SERVER BOOTSTRAP + DUAL WEBSOCKET UPGRADE + VITE MIDDLEWARE + GRACEFUL SHUTDOWN
// ============================================================================

async function startServer() {
  initProactiveTriggerEngine();

  const server = http.createServer(app);
  // Hardened HTTP server timeouts to protect against slowloris and hung sockets
  server.headersTimeout = 30_000;
  server.keepAliveTimeout = 65_000;
  server.requestTimeout = 90_000;

  const eventsWss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
  const liveVoiceWss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });

  eventBus.attach(eventsWss);
  attachLiveVoiceBridge(liveVoiceWss);

  server.on('upgrade', (request, socket, head) => {
    const pathname = new URL(request.url || '/', 'http://localhost').pathname;
    if (pathname === '/ws/events' || pathname === '/ws/live-voice') {
      if (isShuttingDown) {
        socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\nServer shutting down.');
        socket.destroy();
        return;
      }
      const resolved = resolveSessionFromRawUpgrade(request.headers.cookie, request.url);
      if (!resolved) {
        socket.write(
          'HTTP/1.1 401 Unauthorized\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nAuthentication required.'
        );
        socket.destroy();
        return;
      }

      if (pathname === '/ws/events') {
        if (!eventBus.canAcceptConnection()) {
          socket.write(
            'HTTP/1.1 503 Service Unavailable\r\nRetry-After: 5\r\nConnection: close\r\n\r\nRealtime capacity reached.'
          );
          socket.destroy();
          return;
        }
        (request as http.IncomingMessage & { resqflowActor?: { uid: string; orgId: string; role: string } }).resqflowActor = {
          uid: resolved.user.uid,
          orgId: resolved.user.orgId,
          role: resolved.user.role,
        };
        eventsWss.handleUpgrade(request, socket, head, (ws) => {
          eventsWss.emit('connection', ws, request);
        });
      } else {
        liveVoiceWss.handleUpgrade(request, socket, head, (ws) => {
          liveVoiceWss.emit('connection', ws, request);
        });
      }
    }
    // Let Vite handle any other upgrade requests if HMR is active
  });

  if (!isProduction) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        ws: {
          server,
          path: '/__vite_hmr',
        },
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(process.cwd(), 'dist');
    app.use(
      express.static(distPath, {
        maxAge: '7d',
        setHeaders: (res, filePath) => {
          if (filePath.endsWith('.html') || filePath.endsWith('sw.js')) {
            res.setHeader('Cache-Control', 'no-cache');
          } else if (filePath.includes(`${path.sep}assets${path.sep}`)) {
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          }
        },
      })
    );
    const indexPath = path.join(distPath, 'index.html');
    app.get('*', (_req, res) => {
      if (!fs.existsSync(indexPath)) {
        return res.status(503).send('Production bundle not built yet. Run npm run build first.');
      }
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      return res.sendFile(indexPath);
    });
  }

  const gracefulShutdown = (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`[RESQFLOW] Received ${signal}. Draining connections and flushing persistent store...`);
    eventBus.shutdown();
    store.flushSync();
    server.close(() => {
      store.flushSync();
      process.exit(0);
    });
    const forceTimer = setTimeout(() => {
      store.flushSync();
      process.exit(0);
    }, 8000);
    if (typeof forceTimer.unref === 'function') {
      forceTimer.unref();
    }
  };

  process.once('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.once('SIGINT', () => gracefulShutdown('SIGINT'));

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`RESQFLOW AI Command Server listening on http://0.0.0.0:${PORT}`);
  });
}

if (!process.env.VERCEL) {
  startServer().catch((err) => {
    console.error('Failed to start RESQFLOW AI server:', err);
    process.exit(1);
  });
}
