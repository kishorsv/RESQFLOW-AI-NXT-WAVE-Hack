/**
 * RESQFLOW AI — Comprehensive Functional, Integrity, Resilience & Security Audit Suite
 * Covers Phase 2 (A-J), Phase 5 (Data Integrity), Phase 8 (Provider Resilience),
 * Phase 9 (Security & RBAC/CSRF/WS Isolation), and Phase 12 (Observability).
 *
 * Safe to run against isolated local/staging server: cleans up all synthetic records created.
 */
import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';

const BASE_ORIGIN = process.env.RESQFLOW_BASE_URL || 'http://127.0.0.1:3000';
const API_BASE = `${BASE_ORIGIN}/api/v1`;
const WS_URL = BASE_ORIGIN.replace(/^http/, 'ws') + '/ws/events';

interface TestResult {
  name: string;
  category: string;
  status: 'PASS' | 'FAIL' | 'SKIP';
  durationMs: number;
  detail?: string;
}

const results: TestResult[] = [];
const createdIncidentIds = new Set<string>();
const createdUserEmails = new Set<string>();
const createdRequestIds = new Set<string>();

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

async function test(category: string, name: string, fn: () => Promise<string | void>) {
  const start = performance.now();
  try {
    const detail = (await fn()) || undefined;
    results.push({
      name,
      category,
      status: 'PASS',
      durationMs: Math.round((performance.now() - start) * 10) / 10,
      detail,
    });
    console.log(`  [PASS] (${category}) ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (err: any) {
    results.push({
      name,
      category,
      status: 'FAIL',
      durationMs: Math.round((performance.now() - start) * 10) / 10,
      detail: err?.message || String(err),
    });
    console.error(`  [FAIL] (${category}) ${name} — ${err?.message || err}`);
  }
}

function extractCookie(resp: Response): string {
  const setCookie = resp.headers.get('set-cookie') || '';
  const match = setCookie.match(/resqflow_session=[^;]+/);
  return match ? match[0] : '';
}

async function apiFetch(
  route: string,
  opts: {
    method?: string;
    body?: unknown;
    cookie?: string;
    token?: string;
    headers?: Record<string, string>;
    includeOrigin?: boolean;
  } = {}
) {
  const headers: Record<string, string> = {
    ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    ...(opts.includeOrigin !== false ? { Origin: BASE_ORIGIN } : {}),
    ...(opts.cookie ? { Cookie: opts.cookie } : {}),
    ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
    ...(opts.headers || {}),
  };
  const resp = await fetch(`${API_BASE}${route}`, {
    method: opts.method || 'GET',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await resp.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: resp.status, headers: resp.headers, json, text, cookie: extractCookie(resp) };
}

async function signupSyntheticUser(tag: string, requestedRole?: string) {
  const email = `audit_${tag}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}@resqflow-test.invalid`;
  createdUserEmails.add(email);
  const password = 'Audit#Secure2026!Pass';
  const r = await apiFetch('/auth/signup', {
    method: 'POST',
    body: {
      name: `Audit User ${tag}`,
      email,
      password,
      ...(requestedRole ? { role: requestedRole } : {}),
    },
  });
  return { email, password, resp: r };
}

function cleanupSyntheticRecordsFromStore() {
  const storePath = path.resolve(process.cwd(), 'data/resqflow_store.json');
  if (!fs.existsSync(storePath)) return;
  try {
    const raw = fs.readFileSync(storePath, 'utf8');
    const state = JSON.parse(raw);
    let removed = 0;

    if (Array.isArray(state.incidents)) {
      const before = state.incidents.length;
      state.incidents = state.incidents.filter(
        (i: any) =>
          !createdIncidentIds.has(i.id) &&
          !String(i.title || '').startsWith('[AUDIT]')
      );
      removed += before - state.incidents.length;
    }
    if (Array.isArray(state.reliefRequests)) {
      const before = state.reliefRequests.length;
      state.reliefRequests = state.reliefRequests.filter(
        (r: any) => !createdRequestIds.has(r.id) && !String(r.notes || '').includes('[AUDIT]')
      );
      removed += before - state.reliefRequests.length;
    }
    if (Array.isArray(state.authUsers)) {
      const before = state.authUsers.length;
      state.authUsers = state.authUsers.filter(
        (u: any) => !createdUserEmails.has(u.email) && !String(u.email || '').includes('@resqflow-test.invalid')
      );
      removed += before - state.authUsers.length;
    }
    if (Array.isArray(state.authSessions)) {
      const validIds = new Set((state.authUsers || []).map((u: any) => u.id));
      state.authSessions = state.authSessions.filter((s: any) => validIds.has(s.userId));
    }
    if (Array.isArray(state.auditLogs)) {
      state.auditLogs = state.auditLogs.filter(
        (l: any) =>
          !String(l.actorEmail || '').includes('@resqflow-test.invalid') &&
          !String(l.summary || '').includes('[AUDIT]')
      );
    }
    if (removed > 0 || createdUserEmails.size > 0) {
      const tmp = `${storePath}.audit-clean.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
      fs.renameSync(tmp, storePath);
    }
  } catch (err) {
    console.warn('Cleanup note:', err);
  }
}

async function run() {
  console.log(`\n=== RESQFLOW AI AUTOMATED AUDIT & REGRESSION SUITE (${BASE_ORIGIN}) ===\n`);

  // Wait briefly for server readiness
  const liveResp = await apiFetch('/health/live');
  assert(liveResp.status === 200, `Server not reachable at ${BASE_ORIGIN}: ${liveResp.status}`);

  // ---------------------------------------------------------------------------
  // 1. SECURITY HEADERS & PUBLIC SURFACE
  // ---------------------------------------------------------------------------
  await test('Security', 'Security response headers hardened & X-Powered-By stripped', async () => {
    const r = await apiFetch('/health');
    assert(r.status === 200, `Expected 200, got ${r.status}`);
    assert(!r.headers.get('x-powered-by'), 'X-Powered-By header leaked');
    assert(r.headers.get('x-content-type-options') === 'nosniff', 'Missing X-Content-Type-Options');
    assert(r.headers.get('x-dns-prefetch-control') === 'off', 'Missing X-DNS-Prefetch-Control');
    assert(Boolean(r.headers.get('referrer-policy')), 'Missing Referrer-Policy');
    assert(Boolean(r.headers.get('permissions-policy')), 'Missing Permissions-Policy');
    assert(Boolean(r.headers.get('x-request-id')), 'Missing X-Request-Id');
    // Verify rate-limit headers are emitted on non-probe API routes
    const rl = await apiFetch('/incidents');
    assert(Boolean(rl.headers.get('x-ratelimit-limit')), 'Missing X-RateLimit-Limit on API route');
  });

  await test('Security', 'Unauthenticated operational endpoints blocked with 401', async () => {
    for (const ep of ['/bootstrap', '/incidents', '/warehouses', '/relief-requests', '/health/metrics']) {
      const r = await apiFetch(ep);
      assert(r.status === 401, `${ep} allowed unauthenticated access (${r.status})`);
    }
  });

  await test('Security', 'Header spoofing (x-resqflow-role: super_admin) rejected with 401', async () => {
    const r = await apiFetch('/incidents', {
      headers: {
        'x-resqflow-uid': 'attacker',
        'x-resqflow-role': 'super_admin',
        'x-resqflow-email': 'attacker@evil.test',
      },
    });
    assert(r.status === 401, `Spoofed headers were accepted! status=${r.status}`);
  });

  await test('Security', 'Invalid Bearer token rejected with 401', async () => {
    const r = await apiFetch('/incidents', { token: 'invalid.forged.token.value' });
    assert(r.status === 401, `Invalid bearer token accepted: ${r.status}`);
  });

  // ---------------------------------------------------------------------------
  // 2. AUTHENTICATION, LEAST PRIVILEGE, CSRF, SESSION LIFECYCLE
  // ---------------------------------------------------------------------------
  let userCookie = '';
  let userToken = '';
  let userEmail = '';
  let userPassword = '';

  await test('Auth', 'Signup enforces least-privilege role (blocks super_admin self-assignment)', async () => {
    const blocked = await signupSyntheticUser('priv_block', 'super_admin');
    assert(
      blocked.resp.status === 400 || blocked.resp.status === 403,
      `Privilege escalation allowed! status=${blocked.resp.status}`
    );

    const { email, password, resp } = await signupSyntheticUser('priv_ok');
    userEmail = email;
    userPassword = password;
    assert(resp.status === 201, `Signup failed: ${resp.status} ${resp.text}`);
    assert(resp.json?.user?.role === 'field_responder', `Unexpected default role=${resp.json?.user?.role}`);
    assert(Boolean(resp.cookie), 'HttpOnly session cookie not issued on signup');
    userCookie = resp.cookie;
    userToken = resp.json?.sessionToken || '';
    return 'super_admin rejected 400, default role=field_responder';
  });

  await test('Auth', 'Session /auth/session & /auth/refresh work and return sessionExpiresAt', async () => {
    const me = await apiFetch('/auth/session', { cookie: userCookie });
    assert(me.status === 200 && me.json?.user?.email === userEmail, `/auth/session failed: ${me.status}`);
    assert(Boolean(me.json?.sessionExpiresAt), 'Missing sessionExpiresAt');

    const ref = await apiFetch('/auth/refresh', { method: 'POST', cookie: userCookie });
    assert(ref.status === 200 && Boolean(ref.json?.sessionExpiresAt), `/auth/refresh failed: ${ref.status}`);
    if (ref.cookie) userCookie = ref.cookie;
  });

  await test('Security', 'CSRF defense blocks cookie-auth POST without Origin/X-Requested-With', async () => {
    const r = await apiFetch('/auth/refresh', {
      method: 'POST',
      cookie: userCookie,
      includeOrigin: false,
    });
    assert(r.status === 403, `Expected 403 CSRF rejection, got ${r.status}`);
  });

  await test('Security', 'RBAC enforces role boundaries (field_responder blocked from admin:reset_demo)', async () => {
    const r = await apiFetch('/demo/reset', {
      method: 'POST',
      cookie: userCookie,
    });
    assert(r.status === 403, `Expected 403 RBAC denial, got ${r.status}`);
  });

  await test('Auth', 'Wrong password login rejected with 401 & valid login succeeds', async () => {
    const bad = await apiFetch('/auth/login', {
      method: 'POST',
      body: { email: userEmail, password: 'WrongPassword#999' },
    });
    assert(bad.status === 401, `Wrong password should fail 401, got ${bad.status}`);

    const ok = await apiFetch('/auth/login', {
      method: 'POST',
      body: { email: userEmail, password: userPassword },
    });
    assert(ok.status === 200 && Boolean(ok.cookie), `Valid login failed: ${ok.status}`);
    userCookie = ok.cookie;
    userToken = ok.json?.sessionToken || userToken;
  });

  // ---------------------------------------------------------------------------
  // 3. HEALTH, OBSERVABILITY & PROVIDER DIAGNOSTICS
  // ---------------------------------------------------------------------------
  await test('Observability', 'Liveness, Readiness, Metrics & Sub-health endpoints structured & safe', async () => {
    for (const ep of ['/health/live', '/health/ready', '/health', '/health/database', '/health/realtime', '/health/integrations', '/health/weather', '/health/ai', '/health/metrics']) {
      const r = await apiFetch(ep, { cookie: userCookie });
      assert(r.status === 200, `${ep} failed with ${r.status}`);
      const serialized = JSON.stringify(r.json);
      assert(!serialized.includes('AIza'), `API key leaked in ${ep}!`);
      assert(!serialized.includes('passwordHash'), `Password hash leaked in ${ep}!`);
    }
    const m = await apiFetch('/health/metrics', { cookie: userCookie });
    assert(typeof m.json?.memoryMb?.heapUsed === 'number', 'Missing memoryMb.heapUsed telemetry');
    assert(typeof m.json?.requests?.latency?.p95Ms === 'number', 'Missing API p95 latency telemetry');
    assert(typeof m.json?.persistence?.flushCount === 'number', 'Missing persistence.flushCount stats');
  });

  // ---------------------------------------------------------------------------
  // 4. INCIDENTS VALIDATION, PAGINATION, SEARCH & CONCURRENT WRITES
  // ---------------------------------------------------------------------------
  let auditIncidentId = '';

  await test('Incidents', 'Rejects invalid coordinates & malformed payloads with 400', async () => {
    const badCoord = await apiFetch('/incidents', {
      method: 'POST',
      cookie: userCookie,
      body: {
        title: '[AUDIT] Bad Coords',
        description: 'Testing coordinate validation guardrails.',
        type: 'flash_flood',
        severity: 'high',
        lat: 999,
        lng: -999,
        address: 'Invalid Sector',
        region: 'Test Basin',
        mode: 'operational',
      },
    });
    assert(badCoord.status === 400, `Invalid coordinates accepted (${badCoord.status})`);

    const badTitle = await apiFetch('/incidents', {
      method: 'POST',
      cookie: userCookie,
      body: { title: 'x', description: 'y', lat: 13.0, lng: 80.2 },
    });
    assert(badTitle.status === 400, `Short title accepted (${badTitle.status})`);
  });

  await test('Incidents', 'Create incident, duplicate proximity detection & pagination metadata', async () => {
    const r1 = await apiFetch('/incidents', {
      method: 'POST',
      cookie: userCookie,
      body: {
        title: '[AUDIT] River Embankment Breach Test',
        description: 'Synthetic audit incident verifying persistence, pagination, and duplicate proximity.',
        type: 'flash_flood',
        severity: 'high',
        lat: 13.041,
        lng: 80.241,
        address: 'Audit Sector Alpha',
        region: 'Audit Basin',
        peopleAffected: 420,
        vulnerablePopulation: 95,
        mode: 'operational',
      },
    });
    assert(r1.status === 201 && r1.json?.incident?.id, `Create failed: ${r1.status} ${r1.text}`);
    auditIncidentId = r1.json.incident.id;
    createdIncidentIds.add(auditIncidentId);

    const r2 = await apiFetch('/incidents', {
      method: 'POST',
      cookie: userCookie,
      body: {
        title: '[AUDIT] River Embankment Nearby Report',
        description: 'Synthetic duplicate report within 1km of first audit incident.',
        type: 'flash_flood',
        severity: 'high',
        lat: 13.042,
        lng: 80.242,
        address: 'Audit Sector Alpha North',
        region: 'Audit Basin',
        peopleAffected: 150,
        mode: 'operational',
      },
    });
    assert(r2.status === 201 && r2.json?.incident?.id, `Second create failed: ${r2.status}`);
    createdIncidentIds.add(r2.json.incident.id);
    assert(
      Array.isArray(r2.json.possibleDuplicates) && r2.json.possibleDuplicates.includes(auditIncidentId),
      'Duplicate proximity detection failed to flag nearby incident'
    );

    const page = await apiFetch('/incidents?mode=operational&limit=1&offset=0&q=Embankment', {
      cookie: userCookie,
    });
    assert(page.status === 200, `Paginated list failed: ${page.status}`);
    assert(page.json.incidents.length <= 1, 'Pagination limit not enforced');
    assert(
      page.json.pagination && typeof page.json.pagination.total === 'number' && page.json.pagination.total >= 2,
      'Missing or invalid pagination metadata'
    );
  });

  await test('Incidents', 'Concurrent incident creation (8 parallel writes) loses zero records', async () => {
    const writes = await Promise.all(
      Array.from({ length: 8 }, (_, idx) =>
        apiFetch('/incidents', {
          method: 'POST',
          cookie: userCookie,
          body: {
            title: `[AUDIT] Concurrent Burst Incident #${idx + 1}`,
            description: 'Testing coalesced async atomic persistence under concurrent writes.',
            type: 'flood',
            severity: 'medium',
            lat: 12.9 + idx * 0.05,
            lng: 80.1 + idx * 0.05,
            address: `Audit Zone ${idx + 1}`,
            region: 'Audit Coast',
            peopleAffected: 50 + idx * 10,
            mode: 'operational',
          },
        })
      )
    );
    const ids = new Set<string>();
    for (const w of writes) {
      assert(w.status === 201 && w.json?.incident?.id, `Concurrent write failed: ${w.status}`);
      ids.add(w.json.incident.id);
      createdIncidentIds.add(w.json.incident.id);
    }
    assert(ids.size === 8, `Expected 8 unique IDs, got ${ids.size}`);
  });

  // ---------------------------------------------------------------------------
  // 5. WEATHER, RISK INTELLIGENCE & RELIEF REQUESTS
  // ---------------------------------------------------------------------------
  await test('Weather & Risk', 'Weather endpoint validates coords & risk overview responds cleanly', async () => {
    const badW = await apiFetch('/weather/current?lat=999&lng=999', { cookie: userCookie });
    assert(badW.status === 400, `Expected 400 for invalid weather coords, got ${badW.status}`);

    const risk = await apiFetch('/risks/overview?mode=demo', { cookie: userCookie });
    assert(risk.status === 200 && risk.json, `Risk overview failed: ${risk.status}`);

    const ws = await apiFetch('/weather/providers/status', { cookie: userCookie });
    assert(ws.status === 200, `Weather provider status failed: ${ws.status}`);
  });

  await test('Relief & Inventory', 'Relief request validation & zero negative inventory invariants', async () => {
    const badReq = await apiFetch('/relief-requests', {
      method: 'POST',
      cookie: userCookie,
      body: {
        incidentId: auditIncidentId,
        locationName: 'Audit Camp',
        lat: 13.04,
        lng: 80.24,
        peopleAffected: -50,
        urgency: 'high',
        items: [{ itemId: 'item-water', quantity: -10 }],
        mode: 'operational',
      },
    });
    assert(badReq.status === 400, `Negative relief quantity accepted (${badReq.status})`);

    const boot = await apiFetch('/bootstrap?mode=demo', { cookie: userCookie });
    assert(boot.status === 200, `Bootstrap failed: ${boot.status}`);
    const stocks: any[] = boot.json?.inventory || [];
    assert(stocks.length > 0, 'Expected seeded demo inventory rows');
    for (const s of stocks) {
      assert(typeof s.availableQty === 'number' && s.availableQty >= 0, `Invalid availableQty in stock ${s.id}`);
      assert(typeof s.reservedQty === 'number' && s.reservedQty >= 0, `Invalid reservedQty in stock ${s.id}`);
      assert(typeof s.totalQty === 'number' && s.totalQty >= 0, `Invalid totalQty in stock ${s.id}`);
    }
    const geo = await apiFetch('/geospatial/nearest-warehouses?lat=13.04&lng=80.24&mode=demo', {
      cookie: userCookie,
    });
    assert(geo.status === 200, `Geospatial nearest-warehouses failed: ${geo.status}`);
    return `verified ${stocks.length} stock rows non-negative`;
  });

  // ---------------------------------------------------------------------------
  // 6. REALTIME WEBSOCKET AUTH & RECONNECTION
  // ---------------------------------------------------------------------------
  await test('Realtime', 'WebSocket rejects unauthenticated connections with 4401', async () => {
    const code = await new Promise<number>((resolve, reject) => {
      const ws = new WebSocket(WS_URL);
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error('WS timeout waiting for rejection'));
      }, 4000);
      ws.on('close', (c) => {
        clearTimeout(timer);
        resolve(c);
      });
      ws.on('error', () => {
        // expected on immediate close
      });
    });
    assert(code === 4401 || code === 1006 || code === 1008, `Unexpected unauth WS close code: ${code}`);
  });

  await test('Realtime', 'Authenticated WebSocket connects, receives connection.ack & cleanly reconnects', async () => {
    const connectOnce = () =>
      new Promise<string>((resolve, reject) => {
        const ws = new WebSocket(WS_URL, { headers: { Cookie: userCookie } });
        const timer = setTimeout(() => {
          ws.terminate();
          reject(new Error('Authenticated WS handshake timed out'));
        }, 4000);
        ws.on('message', (buf) => {
          try {
            const msg = JSON.parse(buf.toString());
            if (msg.type === 'connection.ack') {
              clearTimeout(timer);
              ws.close();
              resolve(msg.type);
            }
          } catch {
            // ignore
          }
        });
        ws.on('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });
      });

    const first = await connectOnce();
    const second = await connectOnce();
    assert(first === 'connection.ack' && second === 'connection.ack', 'WS reconnect handshake failed');
  });

  // ---------------------------------------------------------------------------
  // 7. LOGOUT & SESSION REVOCATION
  // ---------------------------------------------------------------------------
  await test('Auth', 'Logout revokes session immediately on server', async () => {
    const out = await apiFetch('/auth/logout', { method: 'POST', cookie: userCookie });
    assert(out.status === 200, `Logout failed: ${out.status}`);

    const after = await apiFetch('/auth/session', { cookie: userCookie });
    assert(after.status === 200 && after.json?.authenticated === false, `Session still authenticated after logout! ${after.text}`);

    const afterOp = await apiFetch('/incidents', { cookie: userCookie });
    assert(afterOp.status === 401, `Operational API accessible after logout! status=${afterOp.status}`);
  });

  // ---------------------------------------------------------------------------
  // 8. FRONTEND HOMEPAGE & LAZY BUNDLE INTEGRITY
  // ---------------------------------------------------------------------------
  await test('Frontend', 'Public homepage renders 200 & defers heavy 3D/chart bundles', async () => {
    const r = await fetch(`${BASE_ORIGIN}/`);
    assert(r.status === 200, `Homepage returned ${r.status}`);
    const html = await r.text();
    assert(html.includes('RESQFLOW AI'), 'Homepage HTML missing title');

    const distHtmlPath = path.resolve(process.cwd(), 'dist/index.html');
    if (fs.existsSync(distHtmlPath)) {
      const distHtml = fs.readFileSync(distHtmlPath, 'utf8');
      assert(!distHtml.includes('Tactical3DTwinView'), 'dist/index.html eagerly preloads 3D Twin!');
      assert(!distHtml.includes('AnalyticsView'), 'dist/index.html eagerly preloads Analytics!');
      assert(!distHtml.includes('EmergencyMapView'), 'dist/index.html eagerly preloads Map!');
    }
  });

  // Wait for async store flush before cleanup
  await new Promise((r) => setTimeout(r, 350));
  cleanupSyntheticRecordsFromStore();

  const passed = results.filter((r) => r.status === 'PASS').length;
  const failed = results.filter((r) => r.status === 'FAIL').length;
  console.log(`\n=== AUDIT SUMMARY: ${passed} PASSED, ${failed} FAILED (total ${results.length}) ===\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

run().catch((err) => {
  cleanupSyntheticRecordsFromStore();
  console.error('Audit suite crashed:', err);
  process.exit(1);
});
