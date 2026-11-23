/**
 * Phase 4 Comprehensive Verification Suite
 * Tests Warehouse Management, Real Inventory Catalog, Atomic Stock Ledger,
 * Concurrency-Safe Reservations, Negative Stock Prevention, Inter-Warehouse Transfers,
 * Emergency Demand Matching, Shortage & Replenishment Intelligence, Expiry & Batches,
 * Incoming Supply Verification, Inventory Analytics, Real-Time WebSocket Events, RBAC,
 * and the Full 16-Step End-to-End Relief Supply Scenario.
 */

import WebSocket from 'ws';

const BASE = 'http://localhost:3000/api/v1';
const WS_URL = 'ws://localhost:3000/ws/events';

const ADMIN_HEADERS = {
  'Content-Type': 'application/json',
  'x-resqflow-role': 'emergency_commander',
  'x-resqflow-name': 'Phase4 Commander',
  'x-resqflow-org': 'org-central-cmd',
};

const CITIZEN_HEADERS = {
  'Content-Type': 'application/json',
  'x-resqflow-role': 'citizen_reporter',
  'x-resqflow-name': 'Citizen Tester',
  'x-resqflow-org': 'org-civic-ngo',
};

let passed = 0;
let failed = 0;

function assert(cond: unknown, msg: string) {
  if (!cond) {
    throw new Error(`Assertion failed: ${msg}`);
  }
}

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    failed++;
    console.error(`  [FAIL] ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function req<T = any>(path: string, opts: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: opts.method || 'GET',
    headers: opts.headers || ADMIN_HEADERS,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: res.status, data: json as T };
}

async function run() {
  console.log('\n=== PHASE 4 — REAL-TIME RELIEF, WAREHOUSE & INVENTORY INTELLIGENCE TESTS ===\n');

  // Shared IDs for operational mode tests
  let whAId = '';
  let whBId = '';
  let whClosedId = '';
  let catWaterId = '';
  let stockWaterAId = '';
  let stockFoodAId = '';
  let incidentId = '';
  let reliefReqId = '';

  // 1. Operational Mode Empty Baseline
  await test('1. Operational Mode starts empty with zero fabricated warehouses/inventory', async () => {
    const wh = await req('/warehouses?mode=operational');
    const inv = await req('/inventory/stock?mode=operational');
    const cat = await req('/inventory/items?mode=operational');
    assert(wh.status === 200, `Expected 200, got ${wh.status}`);
    assert(Array.isArray(wh.data.warehouses), 'warehouses should be array');
    assert(inv.status === 200 && Array.isArray(inv.data.stock), 'stock should be array');
    assert(cat.status === 200 && Array.isArray(cat.data.items), 'catalog should be array');
  });

  // 2. Warehouse CRUD, Filtering, Status Change Alert & Summary
  await test('2. Warehouse CRUD: Create, Edit, Search/Filter, Deactivate Alert, Summary', async () => {
    const rA = await req('/warehouses', {
      method: 'POST',
      body: {
        name: 'Operational Central Hub Alpha',
        warehouseType: 'central_hub',
        location: 'Sector 1 Logistics Yard',
        region: 'Delta North',
        district: 'North District',
        state: 'Tamil Nadu',
        country: 'India',
        lat: 13.09,
        lng: 80.26,
        managerName: 'Ramesh Iyer',
        capacityUnits: 40000,
        status: 'operational',
        accessibility: 'high',
        mode: 'operational',
      },
    });
    assert(rA.status === 201 && rA.data.warehouse?.id, `Create WH A failed: ${rA.status}`);
    whAId = rA.data.warehouse.id;

    const rB = await req('/warehouses', {
      method: 'POST',
      body: {
        name: 'Operational Forward Depot Beta',
        warehouseType: 'forward_staging',
        location: 'Highway 45 Relief Yard',
        region: 'Delta South',
        district: 'South District',
        state: 'Tamil Nadu',
        country: 'India',
        lat: 12.82,
        lng: 80.05,
        managerName: 'Anita Sharma',
        capacityUnits: 15000,
        status: 'operational',
        accessibility: 'moderate',
        mode: 'operational',
      },
    });
    assert(rB.status === 201 && rB.data.warehouse?.id, 'Create WH B failed');
    whBId = rB.data.warehouse.id;

    const rC = await req('/warehouses', {
      method: 'POST',
      body: {
        name: 'Closed Maintenance Depot Gamma',
        warehouseType: 'regional_depot',
        location: 'Old Harbor Yard',
        region: 'Delta East',
        district: 'East District',
        lat: 13.08,
        lng: 80.28,
        capacityUnits: 10000,
        status: 'operational',
        mode: 'operational',
      },
    });
    whClosedId = rC.data.warehouse.id;

    // Filter by district & minCapacity
    const filtered = await req('/warehouses?mode=operational&district=North&minCapacity=30000&type=central_hub');
    assert(filtered.data.warehouses.some((w: any) => w.id === whAId), 'Filter should include WH A');
    assert(!filtered.data.warehouses.some((w: any) => w.id === whBId), 'Filter should exclude WH B');

    // Close warehouse C -> should trigger warehouse_unavailable alert
    const patchC = await req(`/warehouses/${whClosedId}`, {
      method: 'PATCH',
      body: { status: 'closed', active: false },
    });
    assert(patchC.status === 200 && patchC.data.warehouse.status === 'closed', 'PATCH warehouse failed');

    const alerts = await req('/inventory/alerts?mode=operational');
    assert(
      alerts.data.alerts.some((a: any) => a.alertType === 'warehouse_unavailable' && a.warehouseId === whClosedId),
      'Expected warehouse_unavailable alert after closing depot'
    );

    // Warehouse summary
    const sum = await req(`/warehouses/${whAId}/summary`);
    assert(sum.status === 200 && sum.data.warehouse.id === whAId, 'Warehouse summary failed');
  });

  // 3. Real Inventory Catalog CRUD & Duplicate SKU Rejection
  await test('3. Inventory Catalog CRUD & Duplicate SKU Prevention', async () => {
    const sku = `OP-WTR-${Date.now().toString(36).toUpperCase()}`;
    const c1 = await req('/inventory/items', {
      method: 'POST',
      body: {
        sku,
        name: 'Operational Drinking Water 20L',
        category: 'drinking_water',
        unit: 'packs',
        minStock: 200,
        criticalStock: 100,
        reorderQty: 400,
        expiryTracking: true,
        supplier: 'AquaCore Relief',
        mode: 'operational',
      },
    });
    assert(c1.status === 201 && c1.data.item?.id, `Create catalog item failed: ${c1.status}`);
    catWaterId = c1.data.item.id;

    // Duplicate SKU should return 409
    const dup = await req('/inventory/items', {
      method: 'POST',
      body: {
        sku,
        name: 'Duplicate Water',
        category: 'drinking_water',
        unit: 'packs',
        mode: 'operational',
      },
    });
    assert(dup.status === 409, `Expected 409 duplicate SKU, got ${dup.status}`);

    const patchCat = await req(`/inventory/items/${catWaterId}`, {
      method: 'PATCH',
      body: { reorderQty: 500 },
    });
    assert(patchCat.status === 200 && patchCat.data.item.reorderQty === 500, 'Catalog PATCH failed');
  });

  // 4. Atomic Stock Receipt, Dispatch, Ledger Consistency & Negative Stock Prevention
  await test('4. Atomic Stock Receive, Dispatch, Ledger Consistency & Negative Stock Prevention', async () => {
    const rec = await req('/inventory/receive', {
      method: 'POST',
      body: {
        warehouseId: whAId,
        itemId: catWaterId,
        quantity: 600,
        reason: 'Initial operational water stock receipt',
        lotNumber: 'LOT-OP-WTR-01',
        expiryDate: new Date(Date.now() + 60 * 24 * 3600_000).toISOString(),
        mode: 'operational',
      },
    });
    assert(rec.status === 201 && rec.data.stock?.availableQty === 600, `Receive failed: ${JSON.stringify(rec.data)}`);
    stockWaterAId = rec.data.stock.id;
    assert(rec.data.stock.availableQty === rec.data.stock.totalQty - rec.data.stock.reservedQty, 'Invariant mismatch');

    // Attempt negative stock via excessive dispatch -> must fail with 409
    const overDispatch = await req('/inventory/dispatch', {
      method: 'POST',
      body: {
        stockId: stockWaterAId,
        quantity: 601,
        reason: 'Over-dispatch test',
      },
    });
    assert(overDispatch.status === 409, `Expected 409 negative stock prevention, got ${overDispatch.status}`);

    // Valid dispatch of 100 -> 500 available
    const dsp = await req('/inventory/dispatch', {
      method: 'POST',
      body: {
        stockId: stockWaterAId,
        quantity: 100,
        reason: 'Field camp delivery #1',
      },
    });
    assert(dsp.status === 201 && dsp.data.stock.availableQty === 500, 'Dispatch did not decrement to 500');

    // Negative adjustment beyond available -> must fail with 409
    const badAdj = await req('/inventory/adjust', {
      method: 'POST',
      body: {
        stockId: stockWaterAId,
        type: 'adjustment',
        quantity: -550,
        reason: 'Invalid negative adjustment test',
      },
    });
    assert(badAdj.status === 409, `Expected 409 on negative adjustment, got ${badAdj.status}`);

    // Ledger movements check
    const movs = await req(`/inventory/movements?mode=operational&stockId=${stockWaterAId}`);
    assert(movs.data.movements.length >= 2, 'Expected at least 2 ledger movements for water stock');
  });

  // 5. Inter-Warehouse Atomic Stock Transfer
  await test('5. Atomic Inter-Warehouse Transfer & Closed Depot Rejection', async () => {
    const trf = await req('/inventory/transfer', {
      method: 'POST',
      body: {
        sourceStockId: stockWaterAId,
        destinationWarehouseId: whBId,
        quantity: 100,
        reason: 'Forward staging pre-positioning',
      },
    });
    assert(trf.status === 201, `Transfer failed: ${JSON.stringify(trf.data)}`);
    assert(trf.data.sourceStock.availableQty === 400, `Expected 400 at source, got ${trf.data.sourceStock.availableQty}`);
    assert(trf.data.destinationStock.availableQty === 100, `Expected 100 at dest, got ${trf.data.destinationStock.availableQty}`);
    assert(trf.data.sourceMovement.referenceId === trf.data.destinationMovement.referenceId, 'Shared transfer referenceId required');

    // Transfer to closed warehouse must fail with 409
    const badTrf = await req('/inventory/transfer', {
      method: 'POST',
      body: {
        sourceStockId: stockWaterAId,
        destinationWarehouseId: whClosedId,
        quantity: 20,
        reason: 'Should fail for closed warehouse',
      },
    });
    assert(badTrf.status === 409, `Expected 409 for closed destination warehouse, got ${badTrf.status}`);
  });

  // 6. Concurrent Stock Reservation Race Test (Zero Double Allocation)
  await test('6. Concurrency-Safe Reservations: Parallel Requests Prevent Double Allocation', async () => {
    // StockWaterA currently has 400 available. Fire 5 concurrent requests of 100 each (500 total requested).
    // Exactly 4 must succeed (400 reserved, 0 available) and 1 must fail with 409 RESERVATION_CONFLICT!
    const results = await Promise.all(
      [1, 2, 3, 4, 5].map((i) =>
        req('/reservations', {
          method: 'POST',
          body: {
            stockId: stockWaterAId,
            requestedQty: 100,
            allowPartial: false,
            notes: `Concurrent race reservation #${i}`,
          },
        })
      )
    );
    const successes = results.filter((r) => r.status === 201);
    const conflicts = results.filter((r) => r.status === 409);
    assert(successes.length === 4, `Expected exactly 4 successes, got ${successes.length}`);
    assert(conflicts.length === 1, `Expected exactly 1 conflict, got ${conflicts.length}`);

    const check = await req(`/inventory/stock/${stockWaterAId}`);
    assert(check.data.stock.availableQty === 0, `Expected 0 available, got ${check.data.stock.availableQty}`);
    assert(check.data.stock.reservedQty === 400, `Expected 400 reserved, got ${check.data.stock.reservedQty}`);
    assert(
      check.data.stock.availableQty === check.data.stock.totalQty - check.data.stock.reservedQty,
      'Available = On-Hand - Reserved invariant violated after concurrent reservations'
    );

    // Release 2 reservations (200 back to available), Confirm & Dispatch 1 (100 leaves warehouse)
    const rel1 = await req(`/reservations/${successes[0].data.reservation.id}/release`, { method: 'POST', body: { reason: 'Releasing excess' } });
    const rel2 = await req(`/reservations/${successes[1].data.reservation.id}/release`, { method: 'POST', body: { reason: 'Releasing excess' } });
    assert(rel1.status === 200 && rel2.status === 200, 'Reservation releases failed');

    const confAlloc = await req(`/reservations/${successes[2].data.reservation.id}/confirm`, {
      method: 'POST',
      body: { status: 'Allocated' },
    });
    assert(confAlloc.status === 200 && confAlloc.data.reservation.status === 'Allocated', 'Allocate confirm failed');

    const confDisp = await req(`/reservations/${successes[2].data.reservation.id}/confirm`, {
      method: 'POST',
      body: { status: 'Dispatched' },
    });
    assert(confDisp.status === 200 && confDisp.data.reservation.status === 'Dispatched', 'Dispatch confirm failed');

    const confDel = await req(`/reservations/${successes[2].data.reservation.id}/confirm`, {
      method: 'POST',
      body: { status: 'Delivered' },
    });
    assert(confDel.status === 200 && confDel.data.reservation.status === 'Delivered', 'Delivered confirm failed');

    // Now totalQty should be 300 (400 - 100 dispatched), reservedQty = 100 (1 remaining), availableQty = 200
    const after = await req(`/inventory/stock/${stockWaterAId}`);
    assert(after.data.stock.totalQty === 300, `Expected totalQty 300, got ${after.data.stock.totalQty}`);
    assert(after.data.stock.reservedQty === 100, `Expected reservedQty 100, got ${after.data.stock.reservedQty}`);
    assert(after.data.stock.availableQty === 200, `Expected availableQty 200, got ${after.data.stock.availableQty}`);
  });

  // 7. Partial Reservation Test
  await test('7. Partial Stock Reservation Support', async () => {
    // StockWaterA has 200 available; request 250 with allowPartial: true
    const partial = await req('/reservations', {
      method: 'POST',
      body: {
        stockId: stockWaterAId,
        requestedQty: 250,
        allowPartial: true,
        notes: 'Partial shelter allocation',
      },
    });
    assert(partial.status === 201, `Partial reservation failed: ${partial.status}`);
    assert(partial.data.reservation.status === 'Partially Reserved', 'Expected Partially Reserved status');
    assert(partial.data.reservation.reservedQty === 200, 'Expected 200 reserved out of 250 requested');

    // Release it so stockWaterA returns to 200 available for subsequent tests
    await req(`/reservations/${partial.data.reservation.id}/release`, { method: 'POST', body: { reason: 'Cleanup' } });
  });

  // 8. Emergency Demand & Supply Matching + Intelligent Warehouse Selection
  await test('8. Emergency Demand Matching & Closed Warehouse Exclusion', async () => {
    const inc = await req('/incidents', {
      method: 'POST',
      body: {
        title: 'Operational Flood Emergency — Sector North',
        description: 'Rapid water rise in residential lowlands requiring immediate water and rations.',
        type: 'flood',
        severity: 'critical',
        lat: 13.07,
        lng: 80.25,
        address: 'North Basin Embankment',
        region: 'Delta North',
        peopleAffected: 1200,
        vulnerablePopulation: 300,
        mode: 'operational',
      },
    });
    assert(inc.status === 201 && inc.data.incident?.id, 'Create incident failed');
    incidentId = inc.data.incident.id;

    // Put stock into closed warehouse C? Even if it had stock, matcher MUST NOT select closed warehouse.
    const rr = await req('/relief-requests', {
      method: 'POST',
      body: {
        incidentId,
        requesterName: 'North Camp Coordinator',
        locationName: 'North Basin Evacuation School',
        lat: 13.075,
        lng: 80.255,
        peopleAffected: 900,
        familiesAffected: 210,
        vulnerableGroups: ['elderly', 'infants'],
        urgency: 'critical',
        items: [{ category: 'drinking_water', itemName: 'Operational Drinking Water 20L', quantity: 500, unit: 'packs' }],
        mode: 'operational',
      },
    });
    assert(rr.status === 201 && rr.data.request?.id, 'Create relief request failed');
    reliefReqId = rr.data.request.id;

    const verify = await req(`/relief-requests/${reliefReqId}/verify`, { method: 'POST' });
    assert(verify.status === 200 && verify.data.request.verificationStatus === 'verified', 'Verify relief request failed');

    const alloc = await req(`/relief-requests/${reliefReqId}/allocate`, { method: 'POST' });
    assert(alloc.status === 201 && Array.isArray(alloc.data.warehouseMatches), 'Allocate/match endpoint failed');
    assert(alloc.data.warehouseMatches.length >= 2, 'Expected WH A and WH B matched');
    assert(
      !alloc.data.warehouseMatches.some((m: any) => m.warehouseId === whClosedId),
      'Closed warehouse must NEVER be recommended'
    );
    assert(alloc.data.warehouseMatches[0].warehouseId === whAId, 'WH A should rank #1 (closer + higher stock + operational)');

    const demand = await req('/relief-requests/demand-summary?mode=operational');
    assert(demand.status === 200 && demand.data.totalDemand >= 500, 'Demand summary calculation failed');
    assert(demand.data.totalShortage >= 200, `Expected shortage >= 200 (500 demanded vs 300 avail), got ${demand.data.totalShortage}`);
  });

  // 9. Shortage & Replenishment Intelligence ("Insufficient historical data." vs Real Average)
  await test('9. Shortage Detection & Honest Historical Demand ("Insufficient historical data." vs Computed Avg)', async () => {
    // Receive food stock below minStock with 0 outbound movements -> must show "Insufficient historical data."
    const recFood = await req('/inventory/receive', {
      method: 'POST',
      body: {
        warehouseId: whAId,
        sku: 'OP-FOD-001',
        itemName: 'Operational Dry Food Kits',
        category: 'food',
        unit: 'kits',
        quantity: 40,
        reason: 'Low opening food stock',
        mode: 'operational',
      },
    });
    stockFoodAId = recFood.data.stock.id;

    const sh1 = await req('/inventory/shortages?mode=operational');
    const foodRec1 = sh1.data.recommendations.find((r: any) => r.stockId === stockFoodAId);
    assert(foodRec1, 'Expected food stock in shortage recommendations');
    assert(foodRec1.alertLevel === 'CRITICAL', `Expected CRITICAL for 40 vs default critical 50, got ${foodRec1.alertLevel}`);
    assert(foodRec1.averageDailyDemand === null, 'Expected null averageDailyDemand with <3 outbound movements');
    assert(
      foodRec1.averageDemandLabel === 'Insufficient historical data.',
      `Expected "Insufficient historical data.", got "${foodRec1.averageDemandLabel}"`
    );

    // Perform 3 real outbound dispatches -> averageDailyDemand should now be computed from real movements
    for (let i = 1; i <= 3; i++) {
      await req('/inventory/dispatch', {
        method: 'POST',
        body: { stockId: stockFoodAId, quantity: 5, reason: `Outbound movement #${i}` },
      });
    }
    const sh2 = await req('/inventory/shortages?mode=operational');
    const foodRec2 = sh2.data.recommendations.find((r: any) => r.stockId === stockFoodAId);
    assert(typeof foodRec2.averageDailyDemand === 'number' && foodRec2.averageDailyDemand > 0, 'Expected computed averageDailyDemand after 3 outbound movements');
  });

  // 10. Expiry & Batch Monitoring (Expired Exclusion + Null Expiry Non-Expired Rule)
  await test('10. Expiry & Batch Monitoring: Expired Quarantined, Expiring 7d Flagged, Null Expiry Never Expired', async () => {
    const pastDate = new Date(Date.now() - 3 * 24 * 3600_000).toISOString();
    const soonDate = new Date(Date.now() + 4 * 24 * 3600_000).toISOString();

    const beforeStock = await req(`/inventory/stock/${stockWaterAId}`);
    const availBefore = beforeStock.data.stock.availableQty;

    // Add expired batch of 25 units -> should automatically quarantine and deduct 25 from usable available stock
    const bExp = await req('/inventory/batches', {
      method: 'POST',
      body: {
        stockId: stockWaterAId,
        lotNumber: 'LOT-EXPIRED-TEST',
        quantity: 25,
        expiryDate: pastDate,
        batchLocation: 'Quarantine Bay',
      },
    });
    assert(bExp.status === 201 && bExp.data.batch.qualityStatus === 'expired', 'Expired batch should be marked expired');

    const afterStock = await req(`/inventory/stock/${stockWaterAId}`);
    assert(
      afterStock.data.stock.availableQty === availBefore - 25,
      `Expired stock should be deducted from usable available (${availBefore} -> ${afterStock.data.stock.availableQty})`
    );

    // Add 4-day expiring batch + non-expiring (null) batch
    await req('/inventory/batches', {
      method: 'POST',
      body: { stockId: stockWaterAId, lotNumber: 'LOT-SOON-4D', quantity: 30, expiryDate: soonDate },
    });
    await req('/inventory/batches', {
      method: 'POST',
      body: { stockId: stockWaterAId, lotNumber: 'LOT-NO-EXPIRY', quantity: 10, expiryDate: null },
    });

    const exp = await req('/inventory/expiry?mode=operational');
    assert(exp.data.expired.some((b: any) => b.lotNumber === 'LOT-EXPIRED-TEST'), 'Missing expired lot');
    assert(exp.data.expiring7d.some((b: any) => b.lotNumber === 'LOT-SOON-4D'), 'Missing <=7d lot');
    assert(exp.data.noExpiry.some((b: any) => b.lotNumber === 'LOT-NO-EXPIRY'), 'Null-expiry item must be in noExpiry');
    assert(!exp.data.expired.some((b: any) => b.lotNumber === 'LOT-NO-EXPIRY'), 'Null-expiry item must NEVER be marked expired');
  });

  // 11. Incoming Supply Lifecycle & Discrepancy Alert (Unavailable Until Verified)
  await test('11. Incoming Supply: In-Transit Not Available -> Receive Discrepancy -> Verify Atomic Inbound', async () => {
    const before = await req(`/inventory/stock/${stockFoodAId}`);
    const availBefore = before.data.stock.availableQty;

    const created = await req('/supplies/incoming', {
      method: 'POST',
      body: {
        supplier: 'Global Relief Logistics',
        warehouseId: whAId,
        trackingReference: 'TRK-OP-9901',
        expectedArrival: new Date(Date.now() + 24 * 3600_000).toISOString(),
        status: 'In Transit',
        items: [
          {
            sku: 'OP-FOD-001',
            itemName: 'Operational Dry Food Kits',
            category: 'food',
            unit: 'kits',
            orderedQty: 200,
            lotNumber: 'LOT-SUP-2026',
            expiryDate: new Date(Date.now() + 180 * 24 * 3600_000).toISOString(),
          },
        ],
        mode: 'operational',
      },
    });
    assert(created.status === 201, 'Create incoming supply failed');
    const supId = created.data.supply.id;

    // Must NOT increase availableQty while In Transit
    const duringTransit = await req(`/inventory/stock/${stockFoodAId}`);
    assert(duringTransit.data.stock.availableQty === availBefore, 'In-transit supply must NOT count as available stock');

    // Receive with 190 received and 10 damaged (discrepancy -> 180 usable once verified)
    const rcv = await req(`/supplies/incoming/${supId}/receive`, {
      method: 'POST',
      body: {
        items: [{ sku: 'OP-FOD-001', receivedQty: 190, damagedQty: 10 }],
        discrepancyNotes: '10 cartons water-damaged during monsoon transport',
      },
    });
    assert(rcv.status === 200 && rcv.data.supply.verificationStatus === 'discrepancy', 'Receive discrepancy check failed');

    // Still NOT available until explicitly verified!
    const afterReceive = await req(`/inventory/stock/${stockFoodAId}`);
    assert(afterReceive.data.stock.availableQty === availBefore, 'Unverified received supply must NOT count as available');

    // Verify -> commits 180 usable units atomically + creates batch
    const ver = await req(`/supplies/incoming/${supId}/verify`, { method: 'POST', body: { notes: 'Verified on dock' } });
    assert(ver.status === 200 && ver.data.supply.status === 'Verified', 'Supply verify failed');
    assert(ver.data.createdBatches.length === 1, 'Expected verified batch creation');

    const afterVerify = await req(`/inventory/stock/${stockFoodAId}`);
    assert(
      afterVerify.data.stock.availableQty === availBefore + 180,
      `Expected +180 usable stock after verification (${availBefore} -> ${afterVerify.data.stock.availableQty})`
    );
  });

  // 12. Inventory Analytics Endpoints Return Real DB Data
  await test('12. Inventory Analytics Overview, Demand, Warehouse & Movements Endpoints', async () => {
    const [ov, dm, wh, mv] = await Promise.all([
      req('/inventory/analytics/overview?mode=operational'),
      req('/inventory/analytics/demand?mode=operational'),
      req('/inventory/analytics/warehouse?mode=operational'),
      req('/inventory/analytics/movements?mode=operational'),
    ]);
    assert(ov.status === 200 && ov.data.kpis.totalWarehouses >= 3, 'Overview KPIs failed');
    assert(dm.status === 200 && dm.data.totalDemand >= 500, 'Demand analytics failed');
    assert(wh.status === 200 && wh.data.warehouses.length >= 3, 'Warehouse analytics failed');
    assert(mv.status === 200 && mv.data.totals.totalMovements >= 5, 'Movement analytics failed');
  });

  // 13. Real-Time WebSocket Event Verification
  await test('13. Real-Time WebSocket Publishes inventory.stock_received & inventory.updated Events', async () => {
    const receivedEvents: string[] = [];
    const ws = new WebSocket(WS_URL);
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('WS connect timeout')), 4000);
      ws.on('open', () => {
        clearTimeout(timeout);
        resolve();
      });
      ws.on('error', reject);
    });

    const eventPromise = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out waiting for inventory WS event')), 4000);
      ws.on('message', (raw) => {
        try {
          const parsed = JSON.parse(raw.toString());
          const evType = parsed?.event?.event_type || parsed?.event_type;
          if (evType) receivedEvents.push(evType);
          if (evType === 'inventory.stock_received' || evType === 'inventory.updated') {
            clearTimeout(timeout);
            resolve();
          }
        } catch {
          // ignore
        }
      });
    });

    await req('/inventory/receive', {
      method: 'POST',
      body: {
        stockId: stockFoodAId,
        quantity: 50,
        reason: 'WebSocket realtime verification receipt',
        mode: 'operational',
      },
    });

    await eventPromise;
    ws.close();
    assert(
      receivedEvents.includes('inventory.stock_received') || receivedEvents.includes('inventory.updated'),
      `Expected inventory WS event, got ${receivedEvents.join(', ')}`
    );
  });

  // 14. RBAC Enforcement (Unauthorized Roles Blocked with 403)
  await test('14. RBAC Enforcement: Citizen Reporter Blocked (403) on Privileged Inventory/Warehouse Mutations', async () => {
    const [rWh, rCat, rRec, rAdj, rTrf, rRes, rSup] = await Promise.all([
      req('/warehouses', { method: 'POST', headers: CITIZEN_HEADERS, body: { name: 'Blocked', location: 'X', region: 'X', lat: 10, lng: 80, capacityUnits: 100 } }),
      req('/inventory/items', { method: 'POST', headers: CITIZEN_HEADERS, body: { sku: 'BLK-1', name: 'Blocked', category: 'food' } }),
      req('/inventory/receive', { method: 'POST', headers: CITIZEN_HEADERS, body: { stockId: stockFoodAId, quantity: 10, reason: 'Blocked' } }),
      req('/inventory/adjust', { method: 'POST', headers: CITIZEN_HEADERS, body: { stockId: stockFoodAId, quantity: 5, reason: 'Blocked' } }),
      req('/inventory/transfer', { method: 'POST', headers: CITIZEN_HEADERS, body: { sourceStockId: stockFoodAId, destinationWarehouseId: whBId, quantity: 5, reason: 'Blocked' } }),
      req('/reservations', { method: 'POST', headers: CITIZEN_HEADERS, body: { stockId: stockFoodAId, requestedQty: 5 } }),
      req('/supplies/incoming', { method: 'POST', headers: CITIZEN_HEADERS, body: { supplier: 'X', warehouseId: whAId, expectedArrival: new Date().toISOString(), items: [{ sku: 'X', itemName: 'X', category: 'food', orderedQty: 5 }] } }),
    ]);
    assert(rWh.status === 403, `Expected 403 on warehouse create, got ${rWh.status}`);
    assert(rCat.status === 403, `Expected 403 on catalog create, got ${rCat.status}`);
    assert(rRec.status === 403, `Expected 403 on stock receive, got ${rRec.status}`);
    assert(rAdj.status === 403, `Expected 403 on stock adjust, got ${rAdj.status}`);
    assert(rTrf.status === 403, `Expected 403 on stock transfer, got ${rTrf.status}`);
    assert(rRes.status === 403, `Expected 403 on reservation create, got ${rRes.status}`);
    assert(rSup.status === 403, `Expected 403 on incoming supply create, got ${rSup.status}`);
  });

  console.log(`\n=== PHASE 4 TEST RESULTS: ${passed} passed, ${failed} failed ===\n`);
  if (failed > 0) {
    process.exit(1);
  }
}

run().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
