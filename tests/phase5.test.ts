import assert from 'node:assert/strict';
import WebSocket from 'ws';

const BASE = 'http://localhost:3000/api/v1';
const WS_URL = 'ws://localhost:3000/ws/events';

type Role =
  | 'super_admin'
  | 'org_admin'
  | 'emergency_commander'
  | 'warehouse_manager'
  | 'logistics_coordinator'
  | 'field_responder'
  | 'analyst'
  | 'citizen_reporter';

async function api(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    role?: Role;
    uid?: string;
    name?: string;
  } = {}
): Promise<{ status: number; data: any }> {
  const res = await fetch(`${BASE}${path}`, {
    method: options.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      'x-resqflow-role': options.role || 'emergency_commander',
      'x-resqflow-uid': options.uid || 'test-cmd-p5',
      'x-resqflow-name': options.name || 'Phase5 Test Commander',
      'x-resqflow-email': 'phase5@resqflow.local',
      'x-resqflow-org': 'org-phase5-ops',
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  let data: any = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  return { status: res.status, data };
}

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  FAIL  ${name}`);
    console.error('       ', err instanceof Error ? err.message : err);
  }
}

async function run() {
  console.log('\n=== PHASE 5 RESQFLOW AI — AUTOMATED LOGISTICS & DISPATCH TEST SUITE ===\n');

  // Connect real WebSocket client to capture live Phase 5 operational events
  const wsEvents: { event_type: string; mode?: string; entity_id?: string }[] = [];
  const ws = new WebSocket(WS_URL);
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => resolve(), 2500);
    ws.on('open', () => {
      clearTimeout(timer);
      resolve();
    });
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        const ev = msg?.type === 'event' ? msg.event : msg;
        if (ev?.event_type) wsEvents.push(ev);
      } catch {
        // ignore non-json frames
      }
    });
    ws.on('error', () => {
      clearTimeout(timer);
      resolve();
    });
  });

  // Shared test fixture IDs created in clean operational mode
  let incidentId = '';
  let depotAId = '';
  let depotBId = '';
  let stockWaterAId = '';
  let stockWaterBId = '';
  let stockMedicalBId = '';
  let heavyTruckId = '';
  let waterTankerId = '';
  let smallVanId = '';
  let driver1Id = '';
  let driver2Id = '';
  let splitReqId = '';
  let splitAllocId = '';
  let mainReqId = '';
  let mainAllocId = '';
  let mainDispatchId = '';
  let mainDeliveryId = '';
  let routeId = '';

  // -------------------------------------------------------------------------
  // 1. OPERATIONAL BASELINE & SEED FIXTURES (NO MOCKS)
  // -------------------------------------------------------------------------
  await test('1.1 Operational mode starts empty & isolated from Demo mode', async () => {
    const opOverview = await api('/logistics/overview?mode=operational');
    assert.equal(opOverview.status, 200);
    assert.equal(opOverview.data.allocationMetrics.totalAllocations, 0);
    assert.equal(opOverview.data.fleetMetrics.totalVehicles, 0);
    assert.equal(opOverview.data.dispatchMetrics.totalDispatches, 0);

    const demoOverview = await api('/logistics/overview?mode=demo');
    assert.equal(demoOverview.status, 200);
    assert.ok(demoOverview.data.fleetMetrics.totalVehicles > 0, 'Demo mode should still have demo fleet');
  });

  await test('1.2 Create & verify Operational Incident + two Warehouses + Inventory Stock', async () => {
    const incRes = await api('/incidents', {
      method: 'POST',
      body: {
        title: 'Velachery Flash Flood Corridor',
        description: 'Severe inundation blocking primary residential access roads.',
        type: 'flood',
        severity: 'critical',
        lat: 12.9784,
        lng: 80.2186,
        address: 'Velachery Main Road, Chennai',
        region: 'Chennai South',
        district: 'Chennai',
        peopleAffected: 1400,
        vulnerablePopulation: 320,
        immediateNeeds: ['drinking_water', 'medical_kits'],
        mode: 'operational',
      },
    });
    assert.equal(incRes.status, 201);
    incidentId = incRes.data.incident.id;

    const verRes = await api(`/incidents/${incidentId}/verify`, { method: 'POST', body: {} });
    assert.equal(verRes.status, 200);

    // Depot A: Closer (~5km away), limited water stock (only 120 units)
    const whA = await api('/warehouses', {
      method: 'POST',
      body: {
        name: 'Guindy Forward Staging Depot',
        warehouseType: 'forward_staging',
        location: 'Guindy Industrial Estate, Chennai',
        region: 'Chennai South',
        district: 'Chennai',
        lat: 13.0067,
        lng: 80.2206,
        managerName: 'R. Karthik',
        contact: '+91-44-2250-1001',
        capacityUnits: 5000,
        status: 'operational',
        accessibility: 'high',
        mode: 'operational',
      },
    });
    assert.equal(whA.status, 201, `Warehouse A failed: ${JSON.stringify(whA.data)}`);
    depotAId = whA.data.warehouse.id;

    // Depot B: Farther (~14km away), abundant water & medical stock
    const whB = await api('/warehouses', {
      method: 'POST',
      body: {
        name: 'Ambattur Central Relief Hub',
        warehouseType: 'central_hub',
        location: 'Ambattur Logistics Park, Chennai',
        region: 'Chennai North',
        district: 'Chennai',
        lat: 13.0982,
        lng: 80.1612,
        managerName: 'M. Priya',
        contact: '+91-44-2625-2002',
        capacityUnits: 25000,
        status: 'operational',
        accessibility: 'high',
        mode: 'operational',
      },
    });
    assert.equal(whB.status, 201, `Warehouse B failed: ${JSON.stringify(whB.data)}`);
    depotBId = whB.data.warehouse.id;

    // Receive stock into Depot A: 120 cases Drinking Water
    const sA = await api('/inventory/receive', {
      method: 'POST',
      body: {
        warehouseId: depotAId,
        sku: 'OP-WAT-001',
        itemName: 'Bottled Drinking Water (20L)',
        category: 'drinking_water',
        unit: 'cases',
        quantity: 120,
        minStock: 20,
        criticalStock: 10,
        reason: 'Phase 5 operational staging intake',
        mode: 'operational',
      },
    });
    assert.equal(sA.status, 201, `Stock A failed: ${JSON.stringify(sA.data)}`);
    stockWaterAId = sA.data.stock.id;

    // Receive stock into Depot B: 500 cases Drinking Water + 200 Medical Kits
    const sB = await api('/inventory/receive', {
      method: 'POST',
      body: {
        warehouseId: depotBId,
        sku: 'OP-WAT-002',
        itemName: 'Bottled Drinking Water (20L)',
        category: 'drinking_water',
        unit: 'cases',
        quantity: 500,
        minStock: 50,
        criticalStock: 20,
        reason: 'Phase 5 central hub intake',
        mode: 'operational',
      },
    });
    assert.equal(sB.status, 201, `Stock B failed: ${JSON.stringify(sB.data)}`);
    stockWaterBId = sB.data.stock.id;

    const sMed = await api('/inventory/receive', {
      method: 'POST',
      body: {
        warehouseId: depotBId,
        sku: 'OP-MED-001',
        itemName: 'Emergency Medical Trauma Kits',
        category: 'medical_kits',
        unit: 'kits',
        quantity: 200,
        minStock: 30,
        criticalStock: 10,
        reason: 'Phase 5 medical supply intake',
        mode: 'operational',
      },
    });
    assert.equal(sMed.status, 201, `Stock Med failed: ${JSON.stringify(sMed.data)}`);
    stockMedicalBId = sMed.data.stock.id;
  });

  // -------------------------------------------------------------------------
  // 2. FLEET VEHICLE & DRIVER MANAGEMENT + RBAC PRIVACY MASKING
  // -------------------------------------------------------------------------
  await test('2.1 Register Fleet Vehicles (heavy_truck, water_tanker, light_van) & RBAC blocks field_responder', async () => {
    const denied = await api('/vehicles', {
      method: 'POST',
      role: 'field_responder',
      body: {
        callsign: 'UNAUTH-01',
        vehicleType: 'heavy_truck',
        warehouseId: depotAId,
        capacityKg: 5000,
        capacityUnits: 400,
        mode: 'operational',
      },
    });
    assert.equal(denied.status, 403, 'field_responder must not register fleet vehicles');

    const v1 = await api('/vehicles', {
      method: 'POST',
      body: {
        registrationNumber: 'TN-01-RQ-501',
        callsign: 'OP-TRUCK-01',
        name: 'Heavy Relief Convoy 01',
        vehicleType: 'heavy_truck',
        warehouseId: depotBId,
        capacityKg: 10000,
        capacityUnits: 800,
        fuelPct: 92,
        equipment: ['GPS Beacon', 'Hydraulic Lift'],
        mode: 'operational',
      },
    });
    assert.equal(v1.status, 201);
    heavyTruckId = v1.data.vehicle.id;

    const v2 = await api('/vehicles', {
      method: 'POST',
      body: {
        registrationNumber: 'TN-01-RQ-502',
        callsign: 'OP-TANKER-02',
        vehicleType: 'water_tanker',
        warehouseId: depotAId,
        capacityKg: 8000,
        capacityUnits: 600,
        fuelPct: 88,
        mode: 'operational',
      },
    });
    assert.equal(v2.status, 201);
    waterTankerId = v2.data.vehicle.id;

    const v3 = await api('/vehicles', {
      method: 'POST',
      body: {
        registrationNumber: 'TN-01-RQ-503',
        callsign: 'OP-VAN-SMALL',
        vehicleType: 'light_van',
        warehouseId: depotBId,
        capacityKg: 500,
        capacityUnits: 25,
        fuelPct: 75,
        mode: 'operational',
      },
    });
    assert.equal(v3.status, 201);
    smallVanId = v3.data.vehicle.id;

    // Update vehicle & verify history
    const patchV = await api(`/vehicles/${heavyTruckId}`, {
      method: 'PATCH',
      body: { fuelPct: 95, maintenanceStatus: 'operational' },
    });
    assert.equal(patchV.status, 200);
    assert.equal(patchV.data.vehicle.fuelPct, 95);

    const histV = await api(`/vehicles/${heavyTruckId}/history`);
    assert.equal(histV.status, 200);
    assert.ok(histV.data.history.length >= 2);
  });

  await test('2.2 Register Drivers, enforce role-based contact masking & prevent double assignment', async () => {
    const d1 = await api('/drivers', {
      method: 'POST',
      body: {
        name: 'Arun Selvam',
        contact: '+91-98400-11223',
        certifications: ['Heavy Commercial', 'Flood Convoy'],
        mode: 'operational',
      },
    });
    assert.equal(d1.status, 201);
    driver1Id = d1.data.driver.id;

    const d2 = await api('/drivers', {
      method: 'POST',
      body: {
        name: 'Deepa Sundar',
        contact: '+91-98400-44556',
        certifications: ['Hazmat', 'Water Tanker'],
        mode: 'operational',
      },
    });
    assert.equal(d2.status, 201);
    driver2Id = d2.data.driver.id;

    // Commander sees full contact
    const cmdView = await api(`/drivers/${driver1Id}`, { role: 'emergency_commander' });
    assert.equal(cmdView.status, 200);
    assert.equal(cmdView.data.driver.contact, '+91-98400-11223');

    // Analyst & Citizen Reporter MUST see masked contact
    const analystView = await api(`/drivers/${driver1Id}`, { role: 'analyst' });
    assert.equal(analystView.status, 200);
    assert.notEqual(analystView.data.driver.contact, '+91-98400-11223');
    assert.ok(analystView.data.driver.contact.includes('*'), 'Analyst should see masked contact');

    const citizenView = await api(`/drivers?mode=operational`, { role: 'citizen_reporter' });
    assert.equal(citizenView.status, 200);
    assert.ok(citizenView.data.drivers[0].contact.includes('*'), 'Citizen must see masked driver contact');

    // Assign driver1 to heavyTruck
    const assign1 = await api(`/vehicles/${heavyTruckId}/assign-driver`, {
      method: 'POST',
      body: { driverId: driver1Id },
    });
    assert.equal(assign1.status, 200);
    assert.equal(assign1.data.vehicle.driverId, driver1Id);

    // Double-assigning same driver to another vehicle must be rejected with 409
    const doubleAssign = await api(`/vehicles/${waterTankerId}/assign-driver`, {
      method: 'POST',
      body: { driverId: driver1Id },
    });
    assert.equal(doubleAssign.status, 409, 'Double-assigning driver to second vehicle must return 409');

    // Assign driver2 to waterTanker
    const assign2 = await api(`/vehicles/${waterTankerId}/assign-driver`, {
      method: 'POST',
      body: { driverId: driver2Id },
    });
    assert.equal(assign2.status, 200);

    // Availability update
    const availRes = await api(`/drivers/${driver2Id}/availability`, {
      method: 'POST',
      body: { status: 'Available' },
    });
    assert.equal(availRes.status, 200);
  });

  // -------------------------------------------------------------------------
  // 3. SMART ALLOCATION ENGINE (PRIORITY, MULTI-WAREHOUSE SPLIT, PARTIAL/SHORTAGE, EDIT, RECALC)
  // -------------------------------------------------------------------------
  await test('3.1 Priority scoring with Fairness/Aging + Multi-Warehouse Split + Partial Shortage Detection', async () => {
    // Request 700 cases of water (Depot A has 120, Depot B has 500 -> total 620 -> split across 2 depots + 80 unmet shortage!)
    const reqRes = await api('/relief-requests', {
      method: 'POST',
      body: {
        incidentId,
        requesterName: 'Velachery Relief Camp Lead',
        contact: '+91-98400-99000',
        locationName: 'Velachery Community Relief Shelter',
        lat: 12.9784,
        lng: 80.2186,
        peopleAffected: 1100,
        familiesAffected: 260,
        vulnerableGroups: ['children', 'elderly'],
        urgency: 'critical',
        items: [
          { category: 'drinking_water', itemName: 'Bottled Drinking Water (20L)', quantity: 700, unit: 'cases' },
        ],
        mode: 'operational',
      },
    });
    assert.equal(reqRes.status, 201);
    splitReqId = reqRes.data.request.id;

    await api(`/relief-requests/${splitReqId}/verify`, { method: 'POST', body: {} });

    // Priority & Fairness check
    const priRes = await api(`/allocations/priority/${splitReqId}`);
    assert.equal(priRes.status, 200);
    assert.ok(typeof priRes.data.priority.score === 'number');
    assert.ok(typeof priRes.data.priority.fairnessAgingBoost === 'number');
    assert.ok(Array.isArray(priRes.data.priority.reasoning) && priRes.data.priority.reasoning.length > 0);

    // Optimize with split allowed
    const optRes = await api('/allocations/optimize', {
      method: 'POST',
      body: { requestId: splitReqId, allowSplit: true },
    });
    assert.equal(optRes.status, 201);
    const alloc = optRes.data.allocation;
    splitAllocId = alloc.id;
    assert.equal(alloc.status, 'proposed');
    assert.equal(alloc.splitAllocation, true, 'Must split across Depot A and Depot B');
    assert.equal(alloc.items.length, 2, 'Must draw from both operational depots');
    const totalAllocated = alloc.items.reduce((s: number, it: any) => s + it.quantity, 0);
    assert.equal(totalAllocated, 620, 'Should allocate 120 + 500 = 620 available cases');
    assert.equal(alloc.unmetItems.length, 1, 'Must explicitly report 80-case shortage');
    assert.equal(alloc.unmetItems[0].quantity, 80);
    assert.ok(Array.isArray(alloc.alternatives) && alloc.alternatives.length >= 2, 'Must include candidate warehouse comparison');

    // Edit proposal quantities inline
    const editRes = await api(`/allocations/${splitAllocId}`, {
      method: 'PATCH',
      body: {
        items: [{ stockId: stockWaterAId, quantity: 100 }],
        note: 'Adjusted down to 100 cases from Guindy forward staging',
      },
    });
    assert.equal(editRes.status, 200);
    assert.equal(editRes.data.allocation.items[0].quantity, 100);

    // Recalculate proposal
    const recalcRes = await api(`/allocations/${splitAllocId}/recalculate`, {
      method: 'POST',
      body: { allowSplit: false },
    });
    assert.equal(recalcRes.status, 201);
    assert.equal(recalcRes.data.allocation.splitAllocation, false, 'allowSplit=false must select single best depot');
    // Depot B has 500 cases vs Depot A 120 cases — nearest depot A should NOT blindly win when Depot B satisfies 500/700!
    assert.equal(
      recalcRes.data.allocation.items[0].warehouseId,
      depotBId,
      'Nearest depot must NOT automatically win over depot with far superior stock fulfillment'
    );

    // Reject the split proposal so inventory remains unencumbered for main scenario
    const rejRes = await api(`/allocations/${splitAllocId}/reject`, {
      method: 'POST',
      body: { reason: 'Superseded by prioritized single-convoy request' },
    });
    assert.equal(rejRes.status, 200);
    assert.equal(rejRes.data.allocation.status, 'rejected');
  });

  // -------------------------------------------------------------------------
  // 4. ROUTE OPTIMIZATION & HONEST ROUTE RISK ASSESSMENT
  // -------------------------------------------------------------------------
  await test('4.1 Route optimization rejects invalid coords & returns UNKNOWN risk when no road safety data exists', async () => {
    const badRoute = await api('/routes/optimize', {
      method: 'POST',
      body: {
        origin: { lat: 999, lng: 80.2, label: 'Invalid' },
        destination: { lat: 12.97, lng: 80.21, label: 'Dest' },
        mode: 'operational',
      },
    });
    assert.equal(badRoute.status, 400, 'Invalid coordinates must return 400');

    const goodRoute = await api('/routes/optimize', {
      method: 'POST',
      body: {
        origin: { lat: 13.1500, lng: 80.1200, label: 'North Logistics Staging' },
        destination: { lat: 13.1950, lng: 80.1750, label: 'Red Hills Relief Outpost' },
        vehicleType: 'heavy_truck',
        mode: 'operational',
      },
    });
    assert.equal(goodRoute.status, 200);
    const route = goodRoute.data.route;
    routeId = route.id;
    assert.ok(route.distanceKm > 0, 'Route distanceKm must be positive');
    assert.ok(route.geometry.length >= 2, 'Route must have geometry points');

    // CRITICAL HONESTY RULE: With NO hazards or intersecting incidents on corridor, risk MUST be UNKNOWN (never LOW)
    const riskRes = await api(`/routes/${routeId}/risk?mode=operational`);
    assert.equal(riskRes.status, 200);
    assert.equal(
      riskRes.data.riskAssessment.riskBand,
      'UNKNOWN',
      'Missing road safety data must produce UNKNOWN, never LOW'
    );
    assert.ok(
      String(riskRes.data.riskAssessment.safetyNotice).includes('Road safety data unavailable'),
      'Must include honest road safety unavailability notice'
    );

    // Route alternatives endpoint
    const altRes = await api('/routes/alternatives', {
      method: 'POST',
      body: {
        origin: { lat: 13.1500, lng: 80.1200, label: 'North Logistics Staging' },
        destination: { lat: 13.1950, lng: 80.1750, label: 'Red Hills Relief Outpost' },
        mode: 'operational',
      },
    });
    assert.equal(altRes.status, 200);
    assert.ok(typeof altRes.data.alternativesAvailable === 'boolean');

    // Route recalculate endpoint
    const recalcRoute = await api(`/routes/${routeId}/recalculate`, {
      method: 'POST',
      body: { mode: 'operational' },
    });
    assert.equal(recalcRoute.status, 200);
    assert.ok(recalcRoute.data.route.id);
  });

  await test('4.2 Reporting a road closure hazard along corridor escalates Route Risk to BLOCKED', async () => {
    // Report a road closure right near the destination along the clean corridor
    const hazRes = await api('/routes/hazards', {
      method: 'POST',
      body: {
        type: 'closure',
        severity: 'critical',
        lat: 13.1945,
        lng: 80.1745,
        radiusKm: 2.0,
        description: 'Submerged bridge on Red Hills bypass — closed to traffic',
        source: 'Traffic Police Field Desk',
        verified: true,
        mode: 'operational',
      },
    });
    assert.equal(hazRes.status, 201);

    const riskAfter = await api(`/routes/${routeId}/risk?mode=operational`);
    assert.equal(riskAfter.status, 200);
    assert.equal(riskAfter.data.riskAssessment.riskBand, 'BLOCKED', 'Closure hazard on route must elevate riskBand to BLOCKED');
    assert.ok(riskAfter.data.riskAssessment.hazards.length >= 1);
  });

  // -------------------------------------------------------------------------
  // 5. VEHICLE MAINTENANCE BLOCKING, CAPACITY VALIDATION, RBAC & CANCELLATION ROLLBACK
  // -------------------------------------------------------------------------
  await test('5.1 Vehicle maintenance blocks assignment, capacity limit rejects overload, and cancellation rolls back stock & fleet', async () => {
    // Create a relief request for 80 cases water + 40 medical kits (total 120 units)
    const req2 = await api('/relief-requests', {
      method: 'POST',
      body: {
        incidentId,
        requesterName: 'Guindy Medical Post',
        contact: '+91-98400-77777',
        locationName: 'Guindy Emergency Triage Tent',
        lat: 13.005,
        lng: 80.219,
        peopleAffected: 450,
        familiesAffected: 110,
        vulnerableGroups: ['injured', 'elderly'],
        urgency: 'high',
        items: [
          { category: 'drinking_water', itemName: 'Bottled Drinking Water (20L)', quantity: 80, unit: 'cases' },
          { category: 'medical_kits', itemName: 'Emergency Medical Trauma Kits', quantity: 40, unit: 'kits' },
        ],
        mode: 'operational',
      },
    });
    assert.equal(req2.status, 201);
    mainReqId = req2.data.request.id;
    await api(`/relief-requests/${mainReqId}/verify`, { method: 'POST', body: {} });

    // Optimize from Depot B (has both water & medical kits)
    const opt2 = await api('/allocations/optimize', {
      method: 'POST',
      body: { requestId: mainReqId, preferredWarehouseIds: [depotBId], allowSplit: false },
    });
    assert.equal(opt2.status, 201);
    mainAllocId = opt2.data.allocation.id;
    await api(`/allocations/${mainAllocId}/approve`, { method: 'POST', body: {} });

    // Dispatch Plan check against smallVan (capacity 25 units < 120 units -> vehicleCapacityOk: false)
    const planOver = await api('/dispatches/plan', {
      method: 'POST',
      body: {
        requestId: mainReqId,
        allocationId: mainAllocId,
        warehouseId: depotBId,
        vehicleId: smallVanId,
      },
    });
    assert.equal(planOver.status, 200);
    assert.equal(planOver.data.plan.vehicleCapacityOk, false, 'Plan must flag vehicle capacity overload');

    // Creating pending dispatch with overloaded smallVan MUST fail with 400
    const overDispatch = await api('/dispatches', {
      method: 'POST',
      body: {
        allocationId: mainAllocId,
        vehicleId: smallVanId,
        warehouseId: depotBId,
        requireApproval: true,
      },
    });
    assert.equal(overDispatch.status, 400, 'Overloaded vehicle must be rejected with 400');

    // Put waterTanker into maintenance -> must block dispatch assignment with 409
    const maintRes = await api(`/vehicles/${waterTankerId}/status`, {
      method: 'POST',
      body: { status: 'maintenance', note: 'Brake hydraulic inspection' },
    });
    assert.equal(maintRes.status, 200);

    const maintDispatch = await api('/dispatches', {
      method: 'POST',
      body: {
        allocationId: mainAllocId,
        vehicleId: waterTankerId,
        warehouseId: depotBId,
        requireApproval: true,
      },
    });
    assert.equal(maintDispatch.status, 409, 'Vehicle in maintenance must be blocked with 409');

    // Restore waterTanker to available
    await api(`/vehicles/${waterTankerId}/status`, { method: 'POST', body: { status: 'available' } });

    // Test Cancellation Rollback on a temporary pending -> approved dispatch using waterTanker
    const invBefore = await api('/inventory?mode=operational');
    const waterBefore = invBefore.data.inventory.find((s: any) => s.id === stockWaterBId);
    const medBefore = invBefore.data.inventory.find((s: any) => s.id === stockMedicalBId);

    const tempDsp = await api('/dispatches', {
      method: 'POST',
      body: {
        allocationId: mainAllocId,
        vehicleId: waterTankerId,
        driverId: driver2Id,
        warehouseId: depotBId,
        requireApproval: true,
      },
    });
    assert.equal(tempDsp.status, 201);
    const tempDspId = tempDsp.data.dispatch.id;
    assert.equal(tempDsp.data.dispatch.status, 'PENDING_APPROVAL');

    // RBAC check: field_responder CANNOT approve dispatch
    const unauthApprove = await api(`/dispatches/${tempDspId}/approve`, {
      method: 'POST',
      role: 'field_responder',
      body: {},
    });
    assert.equal(unauthApprove.status, 403, 'field_responder must receive 403 on dispatch approve');

    // State machine check: CANNOT load before approval
    const loadBeforeApprove = await api(`/dispatches/${tempDspId}/load`, { method: 'POST', body: {} });
    assert.equal(loadBeforeApprove.status, 400, 'Cannot start loading before human approval');

    // Approve temp dispatch (reserves stock + locks vehicle & driver)
    const appTemp = await api(`/dispatches/${tempDspId}/approve`, {
      method: 'POST',
      body: { overrideBlockedRoute: true, note: 'Approved for cancellation rollback test' },
    });
    assert.equal(appTemp.status, 200);
    assert.equal(appTemp.data.dispatch.status, 'APPROVED');

    const invAfterApprove = await api('/inventory?mode=operational');
    const waterLocked = invAfterApprove.data.inventory.find((s: any) => s.id === stockWaterBId);
    assert.equal(waterLocked.availableQty, waterBefore.availableQty - 80, 'Stock must be reserved upon dispatch approval');

    // RBAC check: citizen_reporter CANNOT cancel dispatch
    const unauthCancel = await api(`/dispatches/${tempDspId}/cancel`, {
      method: 'POST',
      role: 'citizen_reporter',
      body: { reason: 'Unauthorized attempt' },
    });
    assert.equal(unauthCancel.status, 403);

    // Commander cancels dispatch -> must roll back reservations & release vehicle/driver
    const cancelRes = await api(`/dispatches/${tempDspId}/cancel`, {
      method: 'POST',
      body: { reason: 'Reassigning to primary heavy truck convoy' },
    });
    assert.equal(cancelRes.status, 200);
    assert.equal(cancelRes.data.dispatch.status, 'CANCELLED');

    const invAfterCancel = await api('/inventory?mode=operational');
    const waterRestored = invAfterCancel.data.inventory.find((s: any) => s.id === stockWaterBId);
    const medRestored = invAfterCancel.data.inventory.find((s: any) => s.id === stockMedicalBId);
    assert.equal(waterRestored.availableQty, waterBefore.availableQty, 'Cancelled dispatch must release reserved water stock');
    assert.equal(medRestored.availableQty, medBefore.availableQty, 'Cancelled dispatch must release reserved medical stock');

    const tankerAfterCancel = await api(`/vehicles/${waterTankerId}`);
    assert.equal(tankerAfterCancel.data.vehicle.status, 'available', 'Cancelled dispatch must release vehicle');

    const drvAfterCancel = await api(`/drivers/${driver2Id}`);
    assert.equal(drvAfterCancel.data.driver.status, 'Available', 'Cancelled dispatch must release driver');

    // Subsequent deliver on cancelled dispatch MUST fail with 400
    const deliverCancelled = await api(`/dispatches/${tempDspId}/deliver`, {
      method: 'POST',
      body: { recipientName: 'Invalid Attempt' },
    });
    assert.equal(deliverCancelled.status, 400, 'Cannot deliver a cancelled dispatch');
  });

  // -------------------------------------------------------------------------
  // 6. FULL 25-STEP END-TO-END LOGISTICS SCENARIO (PLAN -> APPROVE -> LOAD -> DEPART -> GPS -> ARRIVE -> DELIVER -> VERIFY -> ANALYTICS)
  // -------------------------------------------------------------------------
  await test('6.1 Full End-to-End Dispatch Lifecycle, Strict State Machine, Honest GPS, Over-Delivery Rejection & Transactional Inventory Reconciliation', async () => {
    // Re-create clean allocation for mainReqId (since temp cancellation left previous allocation approved/reserved)
    const freshOpt = await api('/allocations/optimize', {
      method: 'POST',
      body: { requestId: mainReqId, preferredWarehouseIds: [depotBId], allowSplit: false },
    });
    assert.equal(freshOpt.status, 201);
    const freshAllocId = freshOpt.data.allocation.id;
    await api(`/allocations/${freshAllocId}/approve`, { method: 'POST', body: {} });

    // Plan dispatch with heavyTruck + driver1
    const planRes = await api('/dispatches/plan', {
      method: 'POST',
      body: {
        requestId: mainReqId,
        allocationId: freshAllocId,
        warehouseId: depotBId,
        vehicleId: heavyTruckId,
        driverId: driver1Id,
      },
    });
    assert.equal(planRes.status, 200);
    assert.equal(planRes.data.plan.vehicleCapacityOk, true);
    assert.ok(planRes.data.plan.route);

    // Submit Pending Dispatch (strict human approval gate)
    const dspCreate = await api('/dispatches', {
      method: 'POST',
      body: {
        allocationId: freshAllocId,
        vehicleId: heavyTruckId,
        driverId: driver1Id,
        warehouseId: depotBId,
        requireApproval: true,
        note: 'Guindy emergency triage resupply',
      },
    });
    assert.equal(dspCreate.status, 201);
    mainDispatchId = dspCreate.data.dispatch.id;
    assert.equal(dspCreate.data.dispatch.status, 'PENDING_APPROVAL');
    assert.equal(dspCreate.data.dispatch.trackingStatus, 'UNAVAILABLE', 'Operational dispatch must not fabricate live GPS');

    // Commander approves dispatch
    const approveDsp = await api(`/dispatches/${mainDispatchId}/approve`, {
      method: 'POST',
      body: { overrideBlockedRoute: true, note: 'Commander verified detour clearance' },
    });
    assert.equal(approveDsp.status, 200);
    assert.equal(approveDsp.data.dispatch.status, 'APPROVED');

    // Invalid state skip: CANNOT depart directly from APPROVED (must load first)
    const skipDepart = await api(`/dispatches/${mainDispatchId}/depart`, { method: 'POST', body: {} });
    assert.equal(skipDepart.status, 400, 'Cannot depart before loading');

    // Warehouse Manager starts loading
    const loadRes = await api(`/dispatches/${mainDispatchId}/load`, {
      method: 'POST',
      role: 'warehouse_manager',
      body: { note: 'Bay 3 pallet loading verified' },
    });
    assert.equal(loadRes.status, 200);
    assert.equal(loadRes.data.dispatch.status, 'LOADING');

    // Depart -> EN_ROUTE
    const departRes = await api(`/dispatches/${mainDispatchId}/depart`, {
      method: 'POST',
      role: 'field_responder',
      body: { note: 'Convoy exited Ambattur hub' },
    });
    assert.equal(departRes.status, 200);
    assert.equal(departRes.data.dispatch.status, 'EN_ROUTE');

    // Honest GPS enforcement:
    // 1) Invalid coordinates rejected (400)
    const badGps = await api(`/dispatches/${mainDispatchId}/location`, {
      method: 'POST',
      body: { lat: 200, lng: 80.2, gpsSource: 'authorized_device' },
    });
    assert.equal(badGps.status, 400, 'Invalid GPS coordinates must be rejected');

    // 2) Simulated GPS rejected in operational mode (400)
    const simGps = await api(`/dispatches/${mainDispatchId}/location`, {
      method: 'POST',
      body: { lat: 13.05, lng: 80.19, gpsSource: 'simulated_demo' },
    });
    assert.equal(simGps.status, 400, 'Simulated GPS must be rejected in Operational mode');

    // 3) Authorized device GPS succeeds -> LIVE_GPS
    const realGps = await api(`/dispatches/${mainDispatchId}/location`, {
      method: 'POST',
      body: { lat: 13.045, lng: 80.195, speedKmh: 42, gpsSource: 'authorized_device' },
    });
    assert.equal(realGps.status, 200);
    assert.equal(realGps.data.dispatch.trackingStatus, 'LIVE_GPS');

    // Check tracking & events endpoints
    const trackRes = await api(`/dispatches/${mainDispatchId}/tracking`);
    assert.equal(trackRes.status, 200);
    assert.equal(trackRes.data.tracking.trackingStatus, 'LIVE_GPS');
    assert.ok(trackRes.data.tracking.remainingDistanceKm !== null);

    const eventsRes = await api(`/dispatches/${mainDispatchId}/events`);
    assert.equal(eventsRes.status, 200);
    assert.ok(eventsRes.data.events.length >= 4);

    // Invalid state skip: CANNOT deliver before arrival
    const earlyDeliver = await api(`/dispatches/${mainDispatchId}/deliver`, {
      method: 'POST',
      body: { recipientName: 'Premature Receiver' },
    });
    assert.equal(earlyDeliver.status, 400, 'Cannot deliver before ARRIVED');

    // Mark ARRIVED
    const arriveRes = await api(`/dispatches/${mainDispatchId}/arrive`, {
      method: 'POST',
      role: 'field_responder',
      body: { note: 'Arrived at Guindy triage gate' },
    });
    assert.equal(arriveRes.status, 200);
    assert.equal(arriveRes.data.dispatch.status, 'ARRIVED');

    // Reject over-delivery (deliveredQty > dispatchedQty without explicit correction workflow)
    const overDeliver = await api(`/dispatches/${mainDispatchId}/deliver`, {
      method: 'POST',
      body: {
        recipientName: 'Dr. Kavitha',
        items: [
          { stockId: stockWaterBId, deliveredQty: 999, damagedQty: 0 },
          { stockId: stockMedicalBId, deliveredQty: 40, damagedQty: 0 },
        ],
      },
    });
    assert.equal(overDeliver.status, 400, 'Over-delivery without correction flag must be rejected with 400');

    // Confirm real delivery: 78 water cases delivered + 2 damaged; 40 medical kits delivered
    const deliverRes = await api(`/dispatches/${mainDispatchId}/deliver`, {
      method: 'POST',
      role: 'field_responder',
      body: {
        recipientName: 'Dr. Kavitha Nair',
        recipientOrg: 'State Medical Relief Unit',
        recipientRole: 'Site Medical Officer',
        proofRef: 'SIGNED-MANIFEST-GMD-0042',
        notes: '2 water cases punctured during unloading; remaining cargo intact.',
        items: [
          { stockId: stockWaterBId, deliveredQty: 78, damagedQty: 2 },
          { stockId: stockMedicalBId, deliveredQty: 40, damagedQty: 0 },
        ],
      },
    });
    assert.equal(deliverRes.status, 200);
    const confirmation = deliverRes.data.delivery;
    mainDeliveryId = confirmation.id;
    const sumDispatched = confirmation.items.reduce((s: number, it: any) => s + it.dispatchedQty, 0);
    const sumDelivered = confirmation.items.reduce((s: number, it: any) => s + it.deliveredQty, 0);
    const sumDamaged = confirmation.items.reduce((s: number, it: any) => s + it.damagedQty, 0);
    assert.equal(sumDispatched, 120);
    assert.equal(sumDelivered, 118);
    assert.equal(sumDamaged, 2);
    assert.equal(confirmation.status, 'PARTIALLY_DELIVERED');
    assert.equal(deliverRes.data.dispatch.status, 'PARTIALLY_DELIVERED');

    // Verify delivery confirmation (command audit sign-off)
    const verifyDel = await api(`/deliveries/${mainDeliveryId}/verify`, {
      method: 'POST',
      role: 'emergency_commander',
      body: { notes: 'Signed manifest verified against warehouse outbound ledger.' },
    });
    assert.equal(verifyDel.status, 200);
    assert.ok(Boolean(verifyDel.data.delivery.verifiedBy), 'Delivery must record verifiedBy');

    // Verify inventory ledger & reservations reconciled:
    // Depot B water started at 500; 80 dispatched (78 delivered + 2 damaged) -> totalQty = 420, reservedQty = 0, availableQty = 420
    const invFinal = await api('/inventory?mode=operational');
    const waterFinal = invFinal.data.inventory.find((s: any) => s.id === stockWaterBId);
    const medFinal = invFinal.data.inventory.find((s: any) => s.id === stockMedicalBId);
    assert.equal(waterFinal.totalQty, 420, 'Water on-hand must reconcile to 420 after 78 delivered + 2 damaged');
    assert.equal(waterFinal.reservedQty, 0, 'Water reservedQty must be 0 after delivery reconciliation');
    assert.equal(waterFinal.availableQty, 420);
    assert.equal(medFinal.totalQty, 160, 'Medical kits on-hand must reconcile to 160 after 40 delivered');
    assert.equal(medFinal.reservedQty, 0);

    // Verify vehicle & driver returned to available
    const truckFinal = await api(`/vehicles/${heavyTruckId}`);
    assert.equal(truckFinal.data.vehicle.status, 'available', 'Heavy truck must return to available after delivery');
    const drv1Final = await api(`/drivers/${driver1Id}`);
    assert.equal(drv1Final.data.driver.status, 'Available', 'Driver must return to Available after delivery');

    // Verify relief request fulfillment updated
    const reqFinal = await api(`/relief-requests/${mainReqId}`);
    assert.equal(reqFinal.status, 200);
    const reqWater = reqFinal.data.request.items.find((i: any) => i.category === 'drinking_water');
    const reqMed = reqFinal.data.request.items.find((i: any) => i.category === 'medical_kits');
    assert.equal(reqWater.fulfilledQuantity, 78);
    assert.equal(reqMed.fulfilledQuantity, 40);
  });

  // -------------------------------------------------------------------------
  // 7. MULTI-INCIDENT OVERVIEW, ANALYTICS & REAL-TIME WEBSOCKET VERIFICATION
  // -------------------------------------------------------------------------
  await test('7.1 Logistics Overview, Fleet/Dispatch/Delivery Analytics & WebSocket Events reflect real persisted data', async () => {
    const overview = await api('/logistics/overview?mode=operational');
    assert.equal(overview.status, 200);
    assert.equal(overview.data.fleetMetrics.totalVehicles, 3);
    assert.equal(overview.data.fleetMetrics.totalDrivers, 2);
    assert.ok(overview.data.dispatchMetrics.totalDispatches >= 2);
    assert.equal(overview.data.dispatchMetrics.completed, 1);
    assert.equal(overview.data.dispatchMetrics.cancelled, 1);

    const allocAnalytics = await api('/logistics/analytics/allocations?mode=operational');
    assert.equal(allocAnalytics.status, 200);
    assert.ok(allocAnalytics.data.metrics.totalAllocations >= 3);

    const fleetAnalytics = await api('/logistics/analytics/fleet?mode=operational');
    assert.equal(fleetAnalytics.status, 200);
    assert.equal(fleetAnalytics.data.metrics.totalVehicles, 3);

    const dispatchAnalytics = await api('/logistics/analytics/dispatches?mode=operational');
    assert.equal(dispatchAnalytics.status, 200);
    assert.ok(dispatchAnalytics.data.metrics.totalDispatches >= 2);

    const perfAnalytics = await api('/logistics/analytics/delivery-performance?mode=operational');
    assert.equal(perfAnalytics.status, 200);
    assert.equal(perfAnalytics.data.totalDeliveries, 1);
    assert.equal(perfAnalytics.data.totalUnitsDelivered, 118);
    assert.equal(perfAnalytics.data.totalUnitsDamaged, 2);
    assert.equal(perfAnalytics.data.verifiedDeliveries, 1);

    const deliveriesList = await api('/deliveries?mode=operational');
    assert.equal(deliveriesList.status, 200);
    assert.equal(deliveriesList.data.deliveries.length, 1);

    // Check real-time WebSocket captured Phase 5 operational events
    const opWsTypes = new Set(wsEvents.filter((e) => e.mode === 'operational').map((e) => e.event_type));
    assert.ok(opWsTypes.has('allocation.recommended'), 'WebSocket must emit allocation.recommended');
    assert.ok(opWsTypes.has('fleet.driver_assigned'), 'WebSocket must emit fleet.driver_assigned');
    assert.ok(opWsTypes.has('dispatch.approved'), 'WebSocket must emit dispatch.approved');
    assert.ok(opWsTypes.has('dispatch.cancelled'), 'WebSocket must emit dispatch.cancelled');
    assert.ok(opWsTypes.has('vehicle.location_updated'), 'WebSocket must emit vehicle.location_updated');
    assert.ok(opWsTypes.has('delivery.completed'), 'WebSocket must emit delivery.completed');
    assert.ok(opWsTypes.has('route.hazard_reported'), 'WebSocket must emit route.hazard_reported');
  });

  try {
    ws.close();
  } catch {
    // ignore
  }

  console.log(`\n=== PHASE 5 SUMMARY: ${passed} passed, ${failed} failed ===\n`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error('Fatal error running Phase 5 tests:', err);
  process.exit(1);
});
