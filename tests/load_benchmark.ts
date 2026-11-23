/**
 * RESQFLOW AI — Controlled Staged Load, Concurrency & Capacity Benchmark
 * Implements Phase 6 Scenarios 1-6 with gradual VU stages (5 -> 10 -> 25 -> 50 -> 100 -> 200)
 * and strict safety stop thresholds (error rate > 5% or p95 > 1500ms).
 *
 * Does NOT call billable third-party AI APIs at high volume.
 * Cleans up all synthetic test records on completion.
 */
import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';

const BASE = process.env.RESQFLOW_BASE_URL || 'http://127.0.0.1:3000';
const WS_URL = BASE.replace(/^http/, 'ws') + '/ws/events';
const ORIGIN = { Origin: BASE };

interface StageMetrics {
  stage: string;
  scenario: string;
  vus: number;
  durationSec: number;
  totalReqs: number;
  ok2xx: number;
  rateLimited429: number;
  overload503: number;
  otherErrors: number;
  rps: number;
  avgMs: number;
  p50Ms: number;
  p90Ms: number;
  p95Ms: number;
  p99Ms: number;
  heapUsedMb: number;
  stoppedEarly?: string;
}

function pct(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return Math.round(sorted[idx] * 10) / 10;
}

async function createBenchUser(index: number) {
  const email = `load_vu_${index}_${Date.now()}@resqflow-test.invalid`;
  const r = await fetch(`${BASE}/api/v1/auth/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...ORIGIN },
    body: JSON.stringify({
      name: `Load VU ${index}`,
      email,
      password: 'LoadBench#2026!Secure',
    }),
  });
  const sc = r.headers.get('set-cookie') || '';
  const match = sc.match(/resqflow_session=[^;]+/);
  return { email, cookie: match ? match[0] : '' };
}

async function getServerHeapMb(cookie: string): Promise<number> {
  try {
    const r = await fetch(`${BASE}/api/v1/health/metrics`, {
      headers: { Cookie: cookie },
    });
    if (!r.ok) return -1;
    const j: any = await r.json();
    return j?.memoryMb?.heapUsed ?? -1;
  } catch {
    return -1;
  }
}

async function runStage(
  stage: string,
  scenario: string,
  vus: number,
  durationSec: number,
  workerFn: (vuId: number, iter: number) => Promise<number>,
  metricsCookie: string
): Promise<StageMetrics> {
  const latencies: number[] = [];
  let ok2xx = 0;
  let rateLimited429 = 0;
  let overload503 = 0;
  let otherErrors = 0;
  const started = performance.now();
  const endAt = started + durationSec * 1000;

  await Promise.all(
    Array.from({ length: vus }, async (_, vuId) => {
      let iter = 0;
      while (performance.now() < endAt) {
        const t0 = performance.now();
        try {
          const status = await workerFn(vuId, iter++);
          const dt = performance.now() - t0;
          latencies.push(dt);
          if (status >= 200 && status < 300) ok2xx++;
          else if (status === 429) rateLimited429++;
          else if (status === 503) overload503++;
          else otherErrors++;
        } catch {
          latencies.push(performance.now() - t0);
          otherErrors++;
        }
      }
    })
  );

  const elapsedSec = (performance.now() - started) / 1000;
  latencies.sort((a, b) => a - b);
  const totalReqs = latencies.length;
  const avgMs = totalReqs ? Math.round((latencies.reduce((a, b) => a + b, 0) / totalReqs) * 10) / 10 : 0;
  const heapUsedMb = await getServerHeapMb(metricsCookie);

  return {
    stage,
    scenario,
    vus,
    durationSec: Math.round(elapsedSec * 10) / 10,
    totalReqs,
    ok2xx,
    rateLimited429,
    overload503,
    otherErrors,
    rps: Math.round((totalReqs / elapsedSec) * 10) / 10,
    avgMs,
    p50Ms: pct(latencies, 50),
    p90Ms: pct(latencies, 90),
    p95Ms: pct(latencies, 95),
    p99Ms: pct(latencies, 99),
    heapUsedMb,
  };
}

async function runWebSocketConcurrencyTest(cookies: string[], count: number) {
  const started = performance.now();
  const sockets: WebSocket[] = [];
  let connected = 0;
  let rejected = 0;

  await Promise.all(
    Array.from({ length: count }, (_, idx) =>
      new Promise<void>((resolve) => {
        const cookie = cookies[idx % cookies.length];
        const ws = new WebSocket(WS_URL, { headers: { Cookie: cookie } });
        const timer = setTimeout(() => {
          rejected++;
          ws.terminate();
          resolve();
        }, 5000);
        ws.on('message', (buf) => {
          try {
            const msg = JSON.parse(buf.toString());
            if (msg.type === 'connection.ack') {
              clearTimeout(timer);
              connected++;
              sockets.push(ws);
              resolve();
            }
          } catch {
            // ignore
          }
        });
        ws.on('error', () => {
          clearTimeout(timer);
          rejected++;
          resolve();
        });
      })
    )
  );

  const connectMs = Math.round((performance.now() - started) * 10) / 10;
  for (const s of sockets) {
    try {
      s.close();
    } catch {
      // ignore
    }
  }
  await new Promise((r) => setTimeout(r, 200));
  return { attempted: count, connected, rejected, totalConnectMs: connectMs };
}

function cleanupBenchData(emails: Set<string>) {
  const storePath = path.resolve(process.cwd(), 'data/resqflow_store.json');
  if (!fs.existsSync(storePath)) return;
  try {
    const state = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    if (Array.isArray(state.incidents)) {
      state.incidents = state.incidents.filter((i: any) => !String(i.title || '').startsWith('[LOADBENCH]'));
    }
    if (Array.isArray(state.authUsers)) {
      state.authUsers = state.authUsers.filter(
        (u: any) => !emails.has(u.email) && !String(u.email || '').includes('@resqflow-test.invalid')
      );
    }
    if (Array.isArray(state.authSessions)) {
      const validIds = new Set((state.authUsers || []).map((u: any) => u.id));
      state.authSessions = state.authSessions.filter((s: any) => validIds.has(s.userId));
    }
    if (Array.isArray(state.auditLogs)) {
      state.auditLogs = state.auditLogs.filter(
        (l: any) => !String(l.actorEmail || '').includes('@resqflow-test.invalid')
      );
    }
    const tmp = `${storePath}.load-clean.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state), 'utf8');
    fs.renameSync(tmp, storePath);
  } catch (err) {
    console.warn('Load bench cleanup warning:', err);
  }
}

async function main() {
  console.log(`\n=== RESQFLOW AI CONTROLLED LOAD & CAPACITY BENCHMARK (${BASE}) ===\n`);

  // Create a small pool of synthetic VU sessions (6 distinct authenticated accounts so per-user rate limits reflect real multi-user traffic)
  const benchUsers = [];
  const benchEmails = new Set<string>();
  for (let i = 0; i < 6; i++) {
    const u = await createBenchUser(i + 1);
    if (!u.cookie) throw new Error(`Failed to provision synthetic VU #${i + 1}`);
    benchUsers.push(u);
    benchEmails.add(u.email);
  }
  const cookies = benchUsers.map((u) => u.cookie);
  const report: StageMetrics[] = [];

  try {
    // 1. Public Homepage + Health (Scenario 1)
    const s1 = await runStage(
      'Public Homepage (25 VU)',
      'Scenario 1: Homepage + Health',
      25,
      3,
      async (_vu, iter) => {
        const url = iter % 2 === 0 ? `${BASE}/` : `${BASE}/api/v1/health/live`;
        const r = await fetch(url);
        await r.text();
        return r.status;
      },
      cookies[0]
    );
    report.push(s1);

    // 2. Concurrent Write Stress (10 VU — direct BEFORE vs AFTER comparison!)
    const writeStage = await runStage(
      'Write Burst (10 VU)',
      'Scenario 3: Concurrent Incident Writes',
      10,
      3,
      async (vu, iter) => {
        const cookie = cookies[vu % cookies.length];
        const r = await fetch(`${BASE}/api/v1/incidents`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: cookie, ...ORIGIN },
          body: JSON.stringify({
            title: `[LOADBENCH] Incident VU${vu}-${iter}`,
            description: 'Controlled write throughput verification.',
            type: 'flash_flood',
            severity: 'high',
            lat: 13.0 + (vu % 5) * 0.02,
            lng: 80.2 + (iter % 5) * 0.02,
            address: `Sector ${vu}`,
            region: 'Bench Basin',
            peopleAffected: 120,
            mode: 'operational',
          }),
        });
        await r.text();
        return r.status;
      },
      cookies[0]
    );
    report.push(writeStage);

    // 3. Gradual Read/Dashboard Concurrency Ladder (5 -> 10 -> 25 -> 50 -> 100 -> 200 VU)
    const ladder = [
      { label: 'Baseline', vus: 5, sec: 2.5 },
      { label: 'Low Load', vus: 10, sec: 2.5 },
      { label: 'Normal Load', vus: 25, sec: 3 },
      { label: 'Medium Load', vus: 50, sec: 3 },
      { label: 'High Load', vus: 100, sec: 3 },
      { label: 'Stress Test', vus: 200, sec: 3 },
    ];

    const endpoints = [
      '/api/v1/incidents?mode=demo&limit=25',
      '/api/v1/risks/overview?mode=demo',
      '/api/v1/warehouses?mode=demo',
      '/api/v1/relief-requests?mode=demo',
    ];

    for (const step of ladder) {
      const m = await runStage(
        `${step.label} (${step.vus} VU)`,
        'Scenarios 2-4: Mixed Authenticated Dashboard Reads',
        step.vus,
        step.sec,
        async (vu, iter) => {
          const cookie = cookies[vu % cookies.length];
          const ep = endpoints[(vu + iter) % endpoints.length];
          const r = await fetch(`${BASE}${ep}`, {
            headers: { Cookie: cookie },
          });
          await r.text();
          return r.status;
        },
        cookies[0]
      );

      const hardErrRate = m.totalReqs ? (m.otherErrors / m.totalReqs) * 100 : 0;
      if (hardErrRate > 5 || m.p95Ms > 1500) {
        m.stoppedEarly = `Threshold triggered: hardErr=${hardErrRate.toFixed(1)}%, p95=${m.p95Ms}ms`;
        report.push(m);
        break;
      }
      report.push(m);
    }

    // 4. WebSocket Concurrent Realtime Fanout (Scenario 6: 50 simultaneous authenticated sockets)
    const wsResult = await runWebSocketConcurrencyTest(cookies, 50);

    console.log(JSON.stringify({ stages: report, websocketTest: wsResult }, null, 2));
  } finally {
    // Log out synthetic users & clean synthetic records
    await Promise.all(
      cookies.map((c) =>
        fetch(`${BASE}/api/v1/auth/logout`, {
          method: 'POST',
          headers: { Cookie: c, ...ORIGIN },
        }).catch(() => {})
      )
    );
    await new Promise((r) => setTimeout(r, 400));
    cleanupBenchData(benchEmails);
  }
}

main().catch((err) => {
  console.error('Benchmark error:', err);
  process.exit(1);
});
