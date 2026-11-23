// End-to-End Automated Verification Suite for RESQFLOW AI
// Executes against the live Express server on http://127.0.0.1:3000

const BASE = 'http://127.0.0.1:3000/api/v1';

async function req(
  path: string,
  options: { method?: string; body?: unknown; role?: string; headers?: Record<string, string> } = {}
): Promise<{ status: number; data: any; text: string; headers: Headers }> {
  const resp = await fetch(`${BASE}${path}`, {
    method: options.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      'x-resqflow-uid': 'e2e-runner',
      'x-resqflow-name': 'E2E Commander',
      'x-resqflow-email': 'e2e@resqflow.local',
      'x-resqflow-role': options.role || 'emergency_commander',
      'x-resqflow-org': 'org-central-cmd',
      ...(options.headers || {}),
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const text = await resp.text();
  let data: any = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: resp.status, data, text, headers: resp.headers };
}

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}

async function runSuite() {
  let passed = 0;
  const step = async (name: string, fn: () => Promise<void>) => {
    await fn();
    passed += 1;
    console.log(`PASS [${passed}]: ${name}`);
  };

  await step('Health endpoints (/health, /health/database, /health/realtime, /health/integrations, /health/workers)', async () => {
    for (const p of ['/health', '/health/database', '/health/realtime', '/health/integrations', '/health/workers']) {
      const r = await req(p);
      assert(r.status === 200, `${p} returned ${r.status}`);
    }
  });

  await step('RBAC Server Enforcement (citizen_reporter blocked with 403 on admin:reset_demo)', async () => {
    const r = await req('/demo/reset', { method: 'POST', role: 'citizen_reporter' });
    assert(r.status === 403, `Expected 403, got ${r.status}`);
  });

  let opIncidentId = '';
  await step('Create Operational Incident + Verify + Duplicate Proximity Detection', async () => {
    const r1 = await req('/incidents', {
      method: 'POST',
      body: {
        title: 'E2E Operational River Surge Test',
        description: 'Automated test incident in isolated operational mode.',
        type: 'flash_flood',
        severity: 'high',
        lat: 13.021,
        lng: 80.221,
        address: 'E2E Test Embankment',
        region: 'Test Basin',
        peopleAffected: 900,
        vulnerablePopulation: 210,
        estimatedImpactAreaKm2: 6.5,
        mode: 'operational',
      },
    });
    assert(r1.status === 201 && r1.data.incident?.id, `Create failed: ${r1.text}`);
    opIncidentId = r1.data.incident.id;

    // Duplicate proximity check
    const rDup = await req('/incidents', {
      method: 'POST',
      body: {
        title: 'E2E Operational River Surge Test Followup',
        description: 'Nearby duplicate report within 1km.',
        type: 'flash_flood',
        severity: 'high',
        lat: 13.022,
        lng: 80.222,
        address: 'E2E Test Embankment North',
        region: 'Test Basin',
        peopleAffected: 300,
        vulnerablePopulation: 50,
        mode: 'operational',
      },
    });
    assert(rDup.status === 201 && rDup.data.possibleDuplicates.includes(opIncidentId), 'Duplicate proximity alert did not fire');

    const rVer = await req(`/incidents/${opIncidentId}/verify`, { method: 'POST', body: {} });
    assert(rVer.status === 200 && rVer.data.incident.verificationStatus === 'verified', 'Verify failed');
  });

  await step('Live Open-Meteo Weather + Deterministic Risk Assessment', async () => {
    const r = await req('/risks/assess', {
      method: 'POST',
      body: { incidentId: opIncidentId },
    });
    assert(r.status === 200 && typeof r.data.assessment?.overallScore === 'number', `Risk assess failed: ${r.text}`);
    assert(Boolean(r.data.weather?.provider), 'Weather provider missing');
  });

  let opWhId = '';
  let opStockId = '';
  let opVehId = '';
  await step('Operational Warehouse + Inventory + Negative Stock Guard + Idempotency + Version Conflict', async () => {
    const w = await req('/warehouses', {
      method: 'POST',
      body: {
        name: 'E2E Operational Hub',
        location: 'Test Port Sector',
        region: 'Test Basin',
        lat: 13.0827,
        lng: 80.2707,
        capacityUnits: 10000,
        mode: 'operational',
      },
    });
    assert(w.status === 201, 'Warehouse creation failed');
    opWhId = w.data.warehouse.id;

    const inv = await req('/inventory', {
      method: 'POST',
      body: {
        warehouseId: opWhId,
        sku: 'E2E-WTR-1',
        itemName: 'E2E Water Packs',
        category: 'drinking_water',
        unit: 'packs',
        availableQty: 500,
        minStock: 100,
        reorderThreshold: 150,
        mode: 'operational',
      },
    });
    assert(inv.status === 201, 'Inventory creation failed');
    opStockId = inv.data.item.id;

    // Negative stock rejection
    const neg = await req('/inventory/movements', {
      method: 'POST',
      body: {
        stockId: opStockId,
        type: 'outbound',
        quantity: 9999,
        reason: 'Must reject negative stock',
      },
    });
    assert(neg.status === 400, `Expected 400 negative stock guard, got ${neg.status}`);

    // Idempotent inbound movement
    const key = `e2e-idem-${Date.now()}`;
    const m1 = await req('/inventory/movements', {
      method: 'POST',
      body: { stockId: opStockId, type: 'inbound', quantity: 100, reason: 'Restock', idempotencyKey: key },
    });
    assert(m1.status === 201 && m1.data.item.availableQty === 600, 'Inbound failed');
    const m2 = await req('/inventory/movements', {
      method: 'POST',
      body: { stockId: opStockId, type: 'inbound', quantity: 100, reason: 'Restock', idempotencyKey: key },
    });
    assert(m2.status === 200 && m2.data.idempotentReplay === true && m2.data.item.availableQty === 600, 'Idempotency failed');

    // Optimistic version conflict
    const stale = await req('/inventory/movements', {
      method: 'POST',
      body: { stockId: opStockId, type: 'inbound', quantity: 10, reason: 'Stale v1', expectedVersion: 1 },
    });
    assert(stale.status === 409, `Expected 409 conflict, got ${stale.status}`);

    const veh = await req('/vehicles', {
      method: 'POST',
      body: {
        callsign: 'E2E-TRK-01',
        vehicleType: 'heavy_truck',
        warehouseId: opWhId,
        capacityKg: 6000,
        capacityUnits: 1200,
        driverTeam: 'E2E Convoy',
        mode: 'operational',
      },
    });
    assert(veh.status === 201, 'Vehicle registration failed');
    opVehId = veh.data.vehicle.id;
  });

  let opReqId = '';
  let opAllocId = '';
  await step('Relief Request + Transparent Priority + Commander Override + Allocation + Approval + Atomic Reserve', async () => {
    const rr = await req('/relief-requests', {
      method: 'POST',
      body: {
        incidentId: opIncidentId,
        requesterName: 'E2E Camp Lead',
        contact: '+91-98400-12345',
        locationName: 'E2E Relief Shelter',
        lat: 13.021,
        lng: 80.221,
        peopleAffected: 450,
        familiesAffected: 110,
        vulnerableGroups: ['elderly', 'infants'],
        urgency: 'critical',
        items: [{ category: 'drinking_water', itemName: 'E2E Water Packs', quantity: 200, unit: 'packs' }],
        mode: 'operational',
      },
    });
    assert(rr.status === 201 && rr.data.request.priorityScore > 0, 'Relief request failed');
    opReqId = rr.data.request.id;

    const ov = await req(`/relief-requests/${opReqId}/override-priority`, {
      method: 'POST',
      body: { newCategory: 'critical', reason: 'Verified medical cold-chain dependency' },
    });
    assert(ov.status === 200 && ov.data.request.priorityBreakdown.override?.reason, 'Override failed');

    const alloc = await req('/allocations/recommend', { method: 'POST', body: { requestId: opReqId } });
    assert(alloc.status === 201 && alloc.data.allocation.requiresApproval === true, 'Allocation recommend failed');
    opAllocId = alloc.data.allocation.id;

    // Must fail reserve before approval
    const preRes = await req(`/allocations/${opAllocId}/reserve`, { method: 'POST', body: {} });
    assert(preRes.status === 400, 'Reserve should require human approval first');

    const app = await req(`/allocations/${opAllocId}/approve`, { method: 'POST', body: {} });
    assert(app.status === 200 && app.data.allocation.status === 'approved', 'Approve failed');

    const resv = await req(`/allocations/${opAllocId}/reserve`, { method: 'POST', body: {} });
    assert(resv.status === 200 && resv.data.allocation.status === 'reserved', 'Atomic reserve failed');
  });

  await step('Route Optimize + Dispatch Creation + Delivery Reconciliation', async () => {
    const rt = await req('/routes/optimize', {
      method: 'POST',
      body: {
        origin: { lat: 13.0827, lng: 80.2707, label: 'E2E Hub' },
        destination: { lat: 13.021, lng: 80.221, label: 'E2E Shelter' },
      },
    });
    assert(rt.status === 200 && rt.data.route.roadConditionsNotice.includes('ROAD CONDITIONS NOT VERIFIED'), 'Route optimize failed');

    const dsp = await req('/dispatches', {
      method: 'POST',
      body: { allocationId: opAllocId, vehicleId: opVehId },
    });
    assert(dsp.status === 201, `Dispatch creation failed: ${dsp.text}`);
    const dspId = dsp.data.dispatch.id;

    const deliv = await req(`/dispatches/${dspId}/status`, {
      method: 'POST',
      body: { status: 'delivered', note: 'Confirmed handover at E2E Shelter' },
    });
    assert(deliv.status === 200 && deliv.data.dispatch.status === 'delivered', 'Delivery status failed');

    // Verify stock reconciliation (600 -> 200 reserved -> 0 reserved, 400 available)
    const invCheck = await req('/inventory?mode=operational');
    const stock = invCheck.data.inventory.find((i: any) => i.id === opStockId);
    assert(stock && stock.availableQty === 400 && stock.reservedQty === 0, `Reconciliation mismatch: ${JSON.stringify(stock)}`);
  });

  await step('Analytics + CSV Export + Demo Reset Isolation (Operational Data Untouched)', async () => {
    const an = await req('/analytics/overview?mode=operational');
    assert(an.status === 200 && an.data.kpis.completedDeliveries >= 1, 'Analytics failed');

    const csv = await req('/analytics/export?mode=operational&dataset=incidents');
    assert(csv.status === 200 && csv.text.includes('E2E Operational River Surge Test'), 'CSV export failed');

    const reset = await req('/demo/reset', { method: 'POST' });
    assert(reset.status === 200, 'Demo reset failed');

    // Confirm operational incident is still intact after Demo reset!
    const opList = await req('/incidents?mode=operational');
    assert(
      opList.data.incidents.some((i: any) => i.id === opIncidentId),
      'Demo reset corrupted Operational Mode data!'
    );
  });

  await step('Offline Queue Replay Idempotency + /sync/status + PWA Manifest & Icons', async () => {
    const offlineActionId = `off-e2e-${Date.now()}`;
    const payload = {
      title: 'Offline Queued Coastal Bridge Washout',
      description: 'Submitted during network outage and replayed on reconnect.',
      type: 'infrastructure_failure',
      severity: 'high',
      lat: 12.912,
      lng: 80.184,
      address: 'OMR Bridge Km 14',
      region: 'Test Basin',
      peopleAffected: 320,
      vulnerablePopulation: 60,
      mode: 'operational',
    };

    const firstSync = await req('/incidents', {
      method: 'POST',
      body: payload,
      headers: {
        'x-resqflow-offline-action-id': offlineActionId,
        'x-resqflow-offline-replay': 'true',
      },
    });
    assert(firstSync.status === 201 && firstSync.data.incident?.id, `First offline replay failed: ${firstSync.text}`);

    // Duplicate replay (e.g. SW Background Sync + window online race) must return exact cached record without creating a duplicate
    const secondSync = await req('/incidents', {
      method: 'POST',
      body: payload,
      headers: {
        'x-resqflow-offline-action-id': offlineActionId,
        'x-resqflow-offline-replay': 'true',
      },
    });
    assert(
      secondSync.status === 201 &&
        secondSync.headers.get('x-resqflow-idempotent-replay') === 'true' &&
        secondSync.data.incident?.id === firstSync.data.incident.id,
      `Idempotent replay failed: status=${secondSync.status} header=${secondSync.headers.get('x-resqflow-idempotent-replay')}`
    );

    const syncStatus = await req('/sync/status');
    assert(
      syncStatus.status === 200 &&
        syncStatus.data.offlineReplayedCount >= 1 &&
        syncStatus.data.recentActions.some((a: any) => a.actionId === offlineActionId),
      `Sync status check failed: ${syncStatus.text}`
    );

    // Verify PWA Manifest & PNG icons are served cleanly
    const manifestResp = await fetch('http://127.0.0.1:3000/manifest.webmanifest');
    assert(manifestResp.status === 200, `Manifest returned ${manifestResp.status}`);
    const manifest = await manifestResp.json();
    assert(manifest.short_name === 'RESQFLOW' && manifest.display === 'standalone', 'Invalid manifest fields');

    for (const iconPath of ['/pwa-192x192.png', '/pwa-512x512.png', '/pwa-maskable-512x512.png', '/apple-touch-icon.png']) {
      const iconResp = await fetch(`http://127.0.0.1:3000${iconPath}`);
      assert(iconResp.status === 200, `${iconPath} returned ${iconResp.status}`);
    }
  });

  console.log(`\nALL ${passed} END-TO-END TESTS PASSED SUCCESSFULLY.`);
}

runSuite().catch((err) => {
  console.error('\nE2E SUITE FAILED:', err);
  process.exit(1);
});
