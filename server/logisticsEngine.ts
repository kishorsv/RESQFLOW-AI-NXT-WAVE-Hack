import { v4 as uuidv4 } from 'uuid';
import type {
  Allocation,
  AllocationAlternative,
  AllocationLineItem,
  AllocationPriorityLevel,
  AllocationPriorityResult,
  DataMode,
  DeliveryConfirmation,
  DeliveryItemRecord,
  DeliveryStatus,
  Dispatch,
  DispatchItemRecord,
  DispatchPlan,
  DispatchStatus,
  Driver,
  DriverStatus,
  EtaStatus,
  ResourceCategory,
  RouteAlternativeSummary,
  RouteHazardReport,
  RouteResult,
  RouteRiskAssessment,
  RouteRiskBand,
  RouteStatus,
  Severity,
  StockMovement,
  StockReservation,
  TrackingStatus,
  UserRole,
  Vehicle,
  VehicleStatus,
  VehicleType,
} from '../src/shared/types.ts';
import { decodePolyline, haversineKm, validateCoordinates } from './engines.ts';
import { eventBus } from './events.ts';
import { store } from './store.ts';

export class LogisticsError extends Error {
  public statusCode: number;
  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = 'LogisticsError';
    this.statusCode = statusCode;
  }
}

export interface LogisticsActor {
  name: string;
  role: UserRole;
  orgId: string;
}

const ROUTE_CACHE_TTL_MS = 5 * 60_000;
const routeCache = new Map<string, { route: RouteResult; expiresAtMs: number }>();

const ACTIVE_DISPATCH_STATUSES = new Set<DispatchStatus>([
  'PENDING_APPROVAL',
  'APPROVED',
  'LOADING',
  'DISPATCHED',
  'EN_ROUTE',
  'ARRIVED',
  'DELIVERING',
  'DELAYED',
  'RETURNING',
  'dispatch_created',
  'vehicle_assigned',
  'loading',
  'departed',
  'in_transit',
  'arrived',
]);

const TERMINAL_DISPATCH_STATUSES = new Set<DispatchStatus>([
  'COMPLETED',
  'DELIVERED',
  'PARTIALLY_DELIVERED',
  'CANCELLED',
  'REJECTED',
  'FAILED',
  'delivered',
  'delivery_failed',
  'cancelled',
]);

export function maskContactPhone(contact: string): string {
  const clean = contact.trim();
  if (clean.length <= 4) return '****';
  return `${clean.slice(0, Math.min(6, clean.length - 2))}***${clean.slice(-2)}`;
}

export function sanitizeDriverForRole(driver: Driver, role: UserRole): Driver {
  const canViewContact = [
    'super_admin',
    'emergency_commander',
    'logistics_manager',
    'warehouse_operator',
    'field_responder',
  ].includes(role);
  if (canViewContact) return driver;
  return {
    ...driver,
    contact: driver.contactMasked,
  };
}

export function sanitizeVehicleForRole(vehicle: Vehicle, role: UserRole): Vehicle {
  const canViewContact = [
    'super_admin',
    'emergency_commander',
    'logistics_manager',
    'warehouse_operator',
    'field_responder',
  ].includes(role);
  if (canViewContact || !vehicle.driverContact) return vehicle;
  return {
    ...vehicle,
    driverContact: maskContactPhone(vehicle.driverContact),
  };
}

// ============================================================================
// 1. ALLOCATION PRIORITY ENGINE + FAIRNESS / AGING POLICY
// ============================================================================

export function computeAllocationPriority(requestId: string): AllocationPriorityResult {
  const req = store.state.reliefRequests.find((r) => r.id === requestId);
  if (!req) throw new LogisticsError('Relief request not found.', 404);

  const incident = store.state.incidents.find((i) => i.id === req.incidentId);
  const missingInformation: string[] = [];
  const reasoning: string[] = [];
  const evidence: string[] = [`request:${req.id}`];
  if (incident) evidence.push(`incident:${incident.id}`);

  // Severity & incident risk component (0-35)
  const severityMap: Record<Severity, number> = { low: 12, medium: 20, high: 28, critical: 35 };
  let baseSeverityScore = severityMap[req.urgency] ?? 20;
  if (incident && incident.riskScore !== null) {
    const incRiskBonus = Math.round((incident.riskScore / 100) * 12);
    baseSeverityScore = Math.min(35, Math.round(baseSeverityScore * 0.7 + incRiskBonus * 1.1));
    reasoning.push(`Incident risk score ${incident.riskScore}/100 (${incident.severity}) contributes ${baseSeverityScore}/35.`);
  } else if (incident) {
    missingInformation.push('Linked incident has no numerical risk score yet; using request urgency.');
  } else {
    missingInformation.push('Linked incident record not found; using request urgency alone.');
  }

  // Human impact & vulnerability component (0-28)
  const peopleScore = Math.min(15, Math.round(Math.log10(Math.max(1, req.peopleAffected) + 1) * 4.5));
  const vulnScore = Math.min(13, req.vulnerableGroups.length * 4);
  const humanScore = peopleScore + vulnScore;
  reasoning.push(
    `${req.peopleAffected} people affected (${req.vulnerableGroups.length} vulnerable group indicators) contributes ${humanScore}/28.`
  );

  // Delivery deadline urgency component (0-22)
  let deadlineScore = 10;
  if (req.deliveryDeadline) {
    const hoursLeft = (new Date(req.deliveryDeadline).getTime() - Date.now()) / 3_600_000;
    if (hoursLeft <= 0) {
      deadlineScore = 22;
      reasoning.push('Delivery deadline already passed — maximum urgency applied (22/22).');
    } else if (hoursLeft <= 4) {
      deadlineScore = 20;
      reasoning.push(`Delivery deadline in ${hoursLeft.toFixed(1)}h — critical deadline pressure (20/22).`);
    } else if (hoursLeft <= 12) {
      deadlineScore = 16;
      reasoning.push(`Delivery deadline in ${hoursLeft.toFixed(1)}h — high deadline pressure (16/22).`);
    } else if (hoursLeft <= 24) {
      deadlineScore = 12;
      reasoning.push(`Delivery deadline in ${hoursLeft.toFixed(1)}h — moderate deadline window (12/22).`);
    } else {
      deadlineScore = 8;
    }
  } else {
    missingInformation.push('No explicit delivery deadline specified; default urgency weight applied.');
  }

  // Unmet demand pressure (0-15)
  const totalRequested = req.items.reduce((s, it) => s + it.quantity, 0);
  const totalFulfilled = req.items.reduce((s, it) => s + it.fulfilledQuantity, 0);
  const unmetRatio = totalRequested > 0 ? Math.max(0, (totalRequested - totalFulfilled) / totalRequested) : 1;
  const unmetScore = Math.round(unmetRatio * 15);
  reasoning.push(`Unmet demand ratio ${Math.round(unmetRatio * 100)}% contributes ${unmetScore}/15.`);

  // Fairness / Aging boost — prevents lower-priority requests from starving indefinitely
  const waitingHours = Math.max(0, (Date.now() - new Date(req.createdAt).getTime()) / 3_600_000);
  const ratePerHour = store.state.settings.fairnessAgingPointsPerHour ?? 1.5;
  const maxBoost = store.state.settings.fairnessMaxBoost ?? 18;
  const fairnessAgingBoost =
    unmetRatio > 0 ? Math.min(maxBoost, Math.round(waitingHours * ratePerHour * 10) / 10) : 0;
  if (fairnessAgingBoost >= 1) {
    reasoning.push(
      `Fairness aging policy added +${fairnessAgingBoost} pts after ${waitingHours.toFixed(1)}h waiting to prevent starvation.`
    );
  }

  const rawScore = Math.min(100, Math.round(baseSeverityScore + humanScore + deadlineScore + unmetScore + fairnessAgingBoost));
  const band: AllocationPriorityLevel =
    rawScore >= 85
      ? 'CRITICAL'
      : rawScore >= 70
      ? 'URGENT'
      : rawScore >= 55
      ? 'HIGH'
      : rawScore >= 35
      ? 'NORMAL'
      : 'LOW';

  return {
    score: rawScore,
    band,
    reasoning,
    evidence,
    missingInformation,
    fairnessAgingBoost,
    waitingHours: Math.round(waitingHours * 10) / 10,
    timestamp: new Date().toISOString(),
    scoreVersion: 'alloc-priority-v2.0',
  };
}

// ============================================================================
// 2. REAL ROUTE OPTIMIZATION ENGINE & SEPARATE ROUTE RISK LAYER
// ============================================================================

function distancePointToPolylineKm(lat: number, lng: number, geometry: { lat: number; lng: number }[]): number {
  if (geometry.length === 0) return Infinity;
  let minKm = Infinity;
  // Sample points densely enough for accurate hazard intersection
  const step = Math.max(1, Math.floor(geometry.length / 80));
  for (let i = 0; i < geometry.length; i += step) {
    const d = haversineKm(lat, lng, geometry[i].lat, geometry[i].lng);
    if (d < minKm) minKm = d;
  }
  const last = geometry[geometry.length - 1];
  const dLast = haversineKm(lat, lng, last.lat, last.lng);
  return Math.min(minKm, dLast);
}

export function evaluateRouteRisk(
  geometry: { lat: number; lng: number }[],
  mode: DataMode,
  destination?: { lat: number; lng: number }
): RouteRiskAssessment {
  const now = new Date().toISOString();
  const activeHazards = store.state.routeHazards.filter((h) => h.mode === mode && h.active);
  const activeIncidents = store.state.incidents.filter(
    (i) => i.mode === mode && ['verified', 'active', 'escalated'].includes(i.status)
  );
  const latestWeather = store.state.weatherObservations.find((w) => {
    if (!destination) return true;
    return haversineKm(w.lat, w.lng, destination.lat, destination.lng) <= 50;
  });

  const matchedHazards: RouteRiskAssessment['hazards'] = [];
  const missingInformation: string[] = [];

  for (const hz of activeHazards) {
    const distKm = distancePointToPolylineKm(hz.lat, hz.lng, geometry);
    if (distKm <= Math.max(hz.radiusKm, 2.5)) {
      matchedHazards.push({
        id: hz.id,
        type: hz.type,
        severity: hz.severity,
        description: hz.description,
        distanceFromRouteKm: Math.round(distKm * 100) / 100,
        source: hz.source,
        verified: hz.verified,
      });
    }
  }

  for (const inc of activeIncidents) {
    if (['flood', 'flash_flood', 'landslide', 'wildfire', 'chemical_incident', 'earthquake'].includes(inc.type)) {
      const distKm = distancePointToPolylineKm(inc.lat, inc.lng, geometry);
      if (distKm <= 3.0) {
        matchedHazards.push({
          id: inc.id,
          type: `incident_${inc.type}`,
          severity: inc.severity,
          description: `Active ${inc.severity} ${inc.type.replace(/_/g, ' ')} incident near corridor: ${inc.title}`,
          distanceFromRouteKm: Math.round(distKm * 100) / 100,
          source: 'RESQFLOW Incident Registry',
          verified: inc.verificationStatus === 'verified',
        });
      }
    }
  }

  if (latestWeather && latestWeather.severeTriggers.length > 0) {
    matchedHazards.push({
      id: latestWeather.id,
      type: 'severe_weather',
      severity: latestWeather.weatherRisk?.level === 'Critical' ? 'critical' : 'high',
      description: `Live weather trigger near destination (${latestWeather.condition}): ${latestWeather.severeTriggers.join('; ')}`,
      distanceFromRouteKm: 0,
      source: latestWeather.provider,
      verified: true,
    });
  } else if (!latestWeather) {
    missingInformation.push('No live meteorological observation linked near route destination.');
  }

  // CRITICAL HONESTY RULE (Section 8):
  // If NO road-condition feed / persisted hazards / verified environmental data exist,
  // we MUST return UNKNOWN — NEVER convert missing data into LOW risk!
  if (matchedHazards.length === 0) {
    missingInformation.push('No live government road-closure or traffic telemetry feed connected.');
    return {
      riskBand: 'UNKNOWN',
      hazards: [],
      source: activeHazards.length > 0 ? 'RESQFLOW Hazard Registry (no intersections on route)' : 'No Road-Condition Feed Connected',
      sourceTimestamp: now,
      confidence: null,
      missingInformation,
      lastVerificationTime: null,
      safetyNotice: 'ROAD CONDITIONS NOT VERIFIED: Road safety data unavailable — route has not been safety verified.',
    };
  }

  // Classify matched hazards into MODERATE / HIGH / BLOCKED
  const hasBlocked = matchedHazards.some(
    (h) => (h.type === 'closure' || h.type === 'bridge_damage') && (h.severity === 'critical' || h.verified)
  );
  const hasHigh = matchedHazards.some(
    (h) => h.severity === 'critical' || h.severity === 'high' || h.type === 'landslide' || h.type === 'flood'
  );
  const riskBand: RouteRiskBand = hasBlocked ? 'BLOCKED' : hasHigh ? 'HIGH' : 'MODERATE';

  missingInformation.push('Live municipal road-closure feed not connected; assessment reflects reported hazards and active incidents only.');

  return {
    riskBand,
    hazards: matchedHazards,
    source: 'RESQFLOW Hazard Reports + Active Incident Proximity + Weather',
    sourceTimestamp: now,
    confidence: matchedHazards.some((h) => h.verified) ? 0.78 : 0.55,
    missingInformation,
    lastVerificationTime: matchedHazards.some((h) => h.verified) ? now : null,
    safetyNotice:
      riskBand === 'BLOCKED'
        ? 'ROAD CONDITIONS NOT VERIFIED (LIVE FEED): ROUTE BLOCKED BY REPORTED HAZARD — Select an alternative corridor or obtain field clearance before dispatch.'
        : riskBand === 'HIGH'
        ? 'ROAD CONDITIONS NOT VERIFIED (LIVE FEED): HIGH ROUTE RISK — Reported hazard or active disaster zone intersects corridor; verify vehicle clearance and alternative routes.'
        : 'ROAD CONDITIONS NOT VERIFIED (LIVE FEED): MODERATE ROUTE CAUTION — Field advisories present along corridor; live road telemetry remains unverified.',
  };
}

export async function optimizeRouteWithAlternatives(params: {
  origin: { lat: number; lng: number; label: string };
  destination: { lat: number; lng: number; label: string };
  waypoints?: { lat: number; lng: number; label: string }[];
  vehicleType?: VehicleType;
  mode?: DataMode;
  bypassCache?: boolean;
}): Promise<RouteResult> {
  const mode: DataMode = params.mode || 'demo';
  const waypoints = params.waypoints || [];

  // Validate coordinates strictly (Section 25 test: invalid coords -> honest failure)
  if (
    !validateCoordinates(params.origin.lat, params.origin.lng) ||
    !validateCoordinates(params.destination.lat, params.destination.lng) ||
    waypoints.some((w) => !validateCoordinates(w.lat, w.lng))
  ) {
    throw new LogisticsError('Invalid route coordinates: latitude must be [-90,90] and longitude [-180,180].', 400);
  }

  const allPoints = [params.origin, ...waypoints, params.destination];
  const cacheKey = `${mode}:${params.vehicleType || 'default'}:${allPoints
    .map((p) => `${p.lat.toFixed(4)},${p.lng.toFixed(4)}`)
    .join('|')}`;

  if (!params.bypassCache) {
    const cached = routeCache.get(cacheKey);
    if (cached && cached.expiresAtMs > Date.now()) {
      const freshRisk = evaluateRouteRisk(cached.route.geometry, mode, params.destination);
      return { ...cached.route, riskAssessment: freshRisk, cacheHit: true };
    }
  }

  const started = Date.now();
  const googleKey = process.env.GOOGLE_MAPS_API_KEY || '';
  const orsKey = process.env.OPENROUTESERVICE_API_KEY;
  let googleQuotaExceeded = false;

  // Attempt 1: Google Routes API v2
  if (googleKey) {
    try {
      const body: Record<string, unknown> = {
        origin: { location: { latLng: { latitude: params.origin.lat, longitude: params.origin.lng } } },
        destination: { location: { latLng: { latitude: params.destination.lat, longitude: params.destination.lng } } },
        travelMode: 'DRIVE',
        routingPreference: 'TRAFFIC_AWARE',
        computeAlternativeRoutes: waypoints.length === 0,
        optimizeWaypointOrder: waypoints.length > 0,
      };
      if (waypoints.length > 0) {
        body.intermediates = waypoints.map((wp) => ({
          location: { latLng: { latitude: wp.lat, longitude: wp.lng } },
        }));
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 7000);
      const resp = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': googleKey,
          'X-Goog-FieldMask':
            'routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline,routes.legs.steps.navigationInstruction,routes.optimizedIntermediateWaypointIndex',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (resp.ok) {
        const data = (await resp.json()) as any;
        const routesList: any[] = Array.isArray(data.routes) ? data.routes : [];
        if (routesList.length > 0) {
          const primary = routesList[0];
          const primaryDistKm = Math.round(((primary.distanceMeters || 0) / 1000) * 100) / 100;
          const primaryDurMin = Math.max(
            1,
            Math.round((parseInt(String(primary.duration || '0s').replace('s', ''), 10) || 0) / 60)
          );
          const primaryGeom = primary.polyline?.encodedPolyline
            ? decodePolyline(primary.polyline.encodedPolyline)
            : allPoints.map((p) => ({ lat: p.lat, lng: p.lng }));
          const primaryRisk = evaluateRouteRisk(primaryGeom, mode, params.destination);

          const instructions: string[] = [];
          for (const leg of primary.legs || []) {
            for (const step of leg.steps || []) {
              if (step.navigationInstruction?.instructions) {
                instructions.push(step.navigationInstruction.instructions);
              }
            }
          }

          const alternatives: RouteAlternativeSummary[] = routesList.map((r, idx) => {
            const dKm = Math.round(((r.distanceMeters || 0) / 1000) * 100) / 100;
            const dMin = Math.max(
              1,
              Math.round((parseInt(String(r.duration || '0s').replace('s', ''), 10) || 0) / 60)
            );
            const geom = r.polyline?.encodedPolyline
              ? decodePolyline(r.polyline.encodedPolyline)
              : primaryGeom;
            const risk = idx === 0 ? primaryRisk : evaluateRouteRisk(geom, mode, params.destination);
            return {
              id: `alt-g-${idx + 1}`,
              label: idx === 0 ? 'Primary Recommended Corridor' : `Alternative Corridor ${idx}`,
              distanceKm: dKm,
              durationMin: dMin,
              deltaDistanceKm: Math.round((dKm - primaryDistKm) * 100) / 100,
              deltaDurationMin: dMin - primaryDurMin,
              geometry: geom,
              riskBand: risk.riskBand,
              hazardsCount: risk.hazards.length,
              selectionReason:
                idx === 0
                  ? 'Fastest traffic-aware road route returned by Google Routes API v2.'
                  : `Alternative corridor (${dKm - primaryDistKm >= 0 ? '+' : ''}${Math.round((dKm - primaryDistKm) * 10) / 10} km, ${dMin - primaryDurMin >= 0 ? '+' : ''}${dMin - primaryDurMin} min vs primary).`,
            };
          });

          const ts = new Date().toISOString();
          const result: RouteResult = {
            id: uuidv4(),
            provider: 'google_routes_v2',
            routeStatus: primaryRisk.riskBand === 'BLOCKED' ? 'ROUTE_REQUIRES_REVIEW' : 'ROUTE_AVAILABLE',
            origin: params.origin,
            destination: params.destination,
            waypoints: waypoints.map((wp, idx) => ({ ...wp, order: idx + 1 })),
            vehicleType: params.vehicleType,
            distanceKm: primaryDistKm,
            durationMin: primaryDurMin,
            geometry: primaryGeom,
            instructions: instructions.slice(0, 14),
            roadConditionsNotice: primaryRisk.safetyNotice,
            alternativesCount: routesList.length,
            alternatives,
            riskAssessment: primaryRisk,
            timestamp: ts,
            expiresAt: new Date(Date.now() + ROUTE_CACHE_TTL_MS).toISOString(),
            cacheHit: false,
            freshnessStatus: 'fresh',
          };

          persistRouteRecord(result, cacheKey, started, 'Google Routes API v2');
          return result;
        }
      } else {
        if (resp.status === 429) {
          googleQuotaExceeded = true;
        } else {
          const errJson = (await resp.json().catch(() => null)) as { error?: { status?: string } } | null;
          if (errJson?.error?.status === 'RESOURCE_EXHAUSTED') {
            googleQuotaExceeded = true;
          }
        }
      }
    } catch {
      // Fall through cleanly to OSRM / OpenRouteService
    }
  }

  // Attempt 2: OSRM Public Driving Router (real road network + real alternatives when available)
  try {
    const coordsStr = allPoints.map((p) => `${p.lng},${p.lat}`).join(';');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 7000);
    const resp = await fetch(
      `https://router.project-osrm.org/route/v1/driving/${coordsStr}?overview=full&geometries=geojson&steps=true&alternatives=true`,
      { signal: controller.signal }
    );
    clearTimeout(timer);
    if (resp.ok) {
      const data = (await resp.json()) as any;
      const routesList: any[] = Array.isArray(data.routes) ? data.routes : [];
      if (routesList.length > 0) {
        const primary = routesList[0];
        const primaryDistKm = Math.round((primary.distance / 1000) * 100) / 100;
        const primaryDurMin = Math.max(1, Math.round(primary.duration / 60));
        const primaryGeom = (primary.geometry?.coordinates || []).map(([lng, lat]: [number, number]) => ({
          lat,
          lng,
        }));
        const primaryRisk = evaluateRouteRisk(primaryGeom, mode, params.destination);

        const instructions: string[] = [];
        for (const leg of primary.legs || []) {
          for (const step of leg.steps || []) {
            if (step.name) {
              instructions.push(`${step.maneuver?.type || 'Proceed'} on ${step.name} (${Math.round(step.distance)}m)`);
            }
          }
        }

        // Only populate alternatives actually returned by OSRM — NEVER fabricate alternatives!
        const alternatives: RouteAlternativeSummary[] = routesList.map((r, idx) => {
          const dKm = Math.round((r.distance / 1000) * 100) / 100;
          const dMin = Math.max(1, Math.round(r.duration / 60));
          const geom = (r.geometry?.coordinates || []).map(([lng, lat]: [number, number]) => ({ lat, lng }));
          const risk = idx === 0 ? primaryRisk : evaluateRouteRisk(geom, mode, params.destination);
          return {
            id: `alt-osrm-${idx + 1}`,
            label: idx === 0 ? 'Primary Road Route' : `Alternative Route ${idx}`,
            distanceKm: dKm,
            durationMin: dMin,
            deltaDistanceKm: Math.round((dKm - primaryDistKm) * 100) / 100,
            deltaDurationMin: dMin - primaryDurMin,
            geometry: geom,
            riskBand: risk.riskBand,
            hazardsCount: risk.hazards.length,
            selectionReason:
              idx === 0
                ? 'Primary driving corridor calculated from OpenStreetMap road topology via OSRM.'
                : `OSRM alternative corridor (${dKm - primaryDistKm >= 0 ? '+' : ''}${Math.round((dKm - primaryDistKm) * 10) / 10} km, ${dMin - primaryDurMin >= 0 ? '+' : ''}${dMin - primaryDurMin} min vs primary).`,
          };
        });

        const ts = new Date().toISOString();
        const result: RouteResult = {
          id: uuidv4(),
          provider: 'osrm',
          routeStatus: primaryRisk.riskBand === 'BLOCKED' ? 'ROUTE_REQUIRES_REVIEW' : 'ROUTE_AVAILABLE',
          origin: params.origin,
          destination: params.destination,
          waypoints: waypoints.map((wp, idx) => ({ ...wp, order: idx + 1 })),
          vehicleType: params.vehicleType,
          distanceKm: primaryDistKm,
          durationMin: primaryDurMin,
          geometry: primaryGeom,
          instructions: instructions.slice(0, 14),
          roadConditionsNotice: primaryRisk.safetyNotice,
          alternativesCount: routesList.length,
          alternatives,
          riskAssessment: primaryRisk,
          timestamp: ts,
          expiresAt: new Date(Date.now() + ROUTE_CACHE_TTL_MS).toISOString(),
          cacheHit: false,
          freshnessStatus: 'fresh',
          ...(googleQuotaExceeded ? { gmpQuotaExceeded: true } : {}),
        };

        persistRouteRecord(result, cacheKey, started, 'OSRM Public Router');
        return result;
      }
    }
  } catch {
    // Fall through to OpenRouteService or honest unavailability
  }

  // Attempt 3: OpenRouteService (only if OPENROUTESERVICE_API_KEY configured)
  if (orsKey) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 7000);
      const resp = await fetch('https://api.openrouteservice.org/v2/directions/driving-car/geojson', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: orsKey,
        },
        body: JSON.stringify({
          coordinates: allPoints.map((p) => [p.lng, p.lat]),
        }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (resp.ok) {
        const data = (await resp.json()) as any;
        const feat = data.features?.[0];
        if (feat) {
          const summary = feat.properties?.summary || {};
          const distKm = Math.round(((summary.distance || 0) / 1000) * 100) / 100;
          const durMin = Math.max(1, Math.round((summary.duration || 0) / 60));
          const geom = (feat.geometry?.coordinates || []).map(([lng, lat]: [number, number]) => ({ lat, lng }));
          const risk = evaluateRouteRisk(geom, mode, params.destination);
          const ts = new Date().toISOString();
          const result: RouteResult = {
            id: uuidv4(),
            provider: 'openrouteservice',
            routeStatus: risk.riskBand === 'BLOCKED' ? 'ROUTE_REQUIRES_REVIEW' : 'ROUTE_AVAILABLE',
            origin: params.origin,
            destination: params.destination,
            waypoints: waypoints.map((wp, idx) => ({ ...wp, order: idx + 1 })),
            vehicleType: params.vehicleType,
            distanceKm: distKm,
            durationMin: durMin,
            geometry: geom,
            instructions: ['Follow OpenRouteService driving corridor to destination.'],
            roadConditionsNotice: risk.safetyNotice,
            alternativesCount: 1,
            alternatives: [
              {
                id: 'alt-ors-1',
                label: 'Primary OpenRouteService Corridor',
                distanceKm: distKm,
                durationMin: durMin,
                deltaDistanceKm: 0,
                deltaDurationMin: 0,
                geometry: geom,
                riskBand: risk.riskBand,
                hazardsCount: risk.hazards.length,
                selectionReason: 'Primary driving route from OpenRouteService.',
              },
            ],
            riskAssessment: risk,
            timestamp: ts,
            expiresAt: new Date(Date.now() + ROUTE_CACHE_TTL_MS).toISOString(),
            cacheHit: false,
            freshnessStatus: 'fresh',
          };
          persistRouteRecord(result, cacheKey, started, 'OpenRouteService');
          return result;
        }
      }
    } catch {
      // Fall through to honest unavailable response
    }
  }

  // Honest Fallback: Report ROUTE_UNAVAILABLE & NEVER fabricate ETA or road geometry!
  let straightKm = 0;
  for (let i = 0; i < allPoints.length - 1; i++) {
    straightKm += haversineKm(allPoints[i].lat, allPoints[i].lng, allPoints[i + 1].lat, allPoints[i + 1].lng);
  }
  const straightGeom = allPoints.map((p) => ({ lat: p.lat, lng: p.lng }));
  const fallbackRisk = evaluateRouteRisk(straightGeom, mode, params.destination);
  const ts = new Date().toISOString();

  store.updateIntegrationHealth('int-routing', {
    status: 'degraded',
    lastError: 'Routing providers unreachable — returned ROUTE_UNAVAILABLE with straight-line reference only.',
  });

  const unavailableRoute: RouteResult = {
    id: uuidv4(),
    provider: 'haversine_fallback',
    routeStatus: 'ROUTE_UNAVAILABLE',
    origin: params.origin,
    destination: params.destination,
    waypoints: waypoints.map((wp, idx) => ({ ...wp, order: idx + 1 })),
    vehicleType: params.vehicleType,
    distanceKm: Math.round(straightKm * 100) / 100,
    durationMin: null,
    geometry: straightGeom,
    instructions: [
      'Routing provider unavailable — straight-line reference distance shown only. Manual dispatcher route review required.',
    ],
    roadConditionsNotice: 'ROUTE_UNAVAILABLE — Road safety data unavailable and live road path could not be calculated.',
    alternativesCount: 0,
    alternatives: [],
    riskAssessment: fallbackRisk,
    timestamp: ts,
    expiresAt: ts,
    cacheHit: false,
    freshnessStatus: 'outage',
  };

  store.state.routeRecords.unshift(unavailableRoute);
  if (store.state.routeRecords.length > 100) store.state.routeRecords.length = 100;
  store.save();
  return unavailableRoute;
}

function persistRouteRecord(result: RouteResult, cacheKey: string, startedMs: number, providerLabel: string) {
  routeCache.set(cacheKey, { route: result, expiresAtMs: Date.now() + ROUTE_CACHE_TTL_MS });
  store.state.routeRecords.unshift(result);
  if (store.state.routeRecords.length > 100) store.state.routeRecords.length = 100;
  store.updateIntegrationHealth('int-routing', {
    status: 'healthy',
    provider: providerLabel,
    lastSuccessAt: result.timestamp,
    lastError: null,
    latencyMs: Date.now() - startedMs,
  });
  store.save();
}

export function reportRouteHazard(input: {
  type: RouteHazardReport['type'];
  severity: Severity;
  lat: number;
  lng: number;
  radiusKm: number;
  description: string;
  source?: string;
  verified?: boolean;
  mode: DataMode;
  actor: LogisticsActor;
}): RouteHazardReport {
  if (!validateCoordinates(input.lat, input.lng)) {
    throw new LogisticsError('Invalid hazard coordinates.', 400);
  }
  const now = new Date().toISOString();
  const hazard: RouteHazardReport = {
    id: uuidv4(),
    type: input.type,
    severity: input.severity,
    lat: input.lat,
    lng: input.lng,
    radiusKm: Math.max(0.2, Math.min(50, input.radiusKm)),
    description: input.description.trim(),
    source: input.source?.trim() || `${input.actor.name} (${input.actor.role})`,
    verified: Boolean(input.verified && ['super_admin', 'emergency_commander'].includes(input.actor.role)),
    reportedBy: input.actor.name,
    active: true,
    mode: input.mode,
    createdAt: now,
    updatedAt: now,
  };
  store.state.routeHazards.unshift(hazard);
  store.save();
  store.addAudit({
    actor: input.actor.name,
    role: input.actor.role,
    orgId: input.actor.orgId,
    action: 'route.hazard_reported',
    entityType: 'route_hazard',
    entityId: hazard.id,
    summary: `Reported ${hazard.severity} ${hazard.type} hazard (${hazard.radiusKm}km radius): ${hazard.description.slice(0, 100)}`,
    mode: hazard.mode,
  });
  eventBus.publish({
    event_type: 'route.hazard_reported',
    organization_id: input.actor.orgId,
    entity_id: hazard.id,
    source: 'route-risk-engine',
    mode: hazard.mode,
    payload: { hazard },
  });
  return hazard;
}

// ============================================================================
// 3. SMART MULTI-WAREHOUSE ALLOCATION OPTIMIZER (13-FACTOR SCORING)
// ============================================================================

export async function optimizeMultiWarehouseAllocation(params: {
  requestId: string;
  allowSplit?: boolean;
  preferredWarehouseIds?: string[];
  maxWarehouses?: number;
  actor?: LogisticsActor;
}): Promise<Allocation> {
  const req = store.state.reliefRequests.find((r) => r.id === params.requestId);
  if (!req) throw new LogisticsError('Relief request not found.', 404);

  const mode = req.mode;
  const allowSplit = params.allowSplit !== false;
  const maxWarehouses = Math.max(1, Math.min(6, params.maxWarehouses ?? 4));
  const weights = store.state.settings.allocationWeights;

  const priorityResult = computeAllocationPriority(req.id);
  const incident = store.state.incidents.find((i) => i.id === req.incidentId);

  // Only operational or limited-operations warehouses are eligible
  const eligibleWarehouses = store.state.warehouses.filter((w) => {
    if (w.mode !== mode) return false;
    if (w.active === false) return false;
    if (w.status !== 'operational' && w.status !== 'limited') return false;
    if (params.preferredWarehouseIds && params.preferredWarehouseIds.length > 0) {
      return params.preferredWarehouseIds.includes(w.id);
    }
    return true;
  });

  const availableVehicles = store.state.vehicles.filter(
    (v) => v.mode === mode && v.status === 'available' && v.maintenanceStatus !== 'in_maintenance' && v.maintenanceStatus !== 'out_of_service'
  );

  // Measure competing unfulfilled demand across other open requests for scarcity awareness
  const openCompetingRequests = store.state.reliefRequests.filter(
    (r) =>
      r.mode === mode &&
      r.id !== req.id &&
      !['delivered', 'closed'].includes(r.status)
  );

  const allocatedLines: AllocationLineItem[] = [];
  const unmetItems: Allocation['unmetItems'] = [];
  const alternativesMap = new Map<string, AllocationAlternative>();
  const warnings: string[] = [];
  const constraints: string[] = [];
  const fairnessNotes: string[] = [];

  if (priorityResult.fairnessAgingBoost >= 2) {
    fairnessNotes.push(
      `Fairness aging boost (+${priorityResult.fairnessAgingBoost} pts after ${priorityResult.waitingHours}h) applied to prevent starvation.`
    );
  }
  if (openCompetingRequests.length > 0) {
    constraints.push(
      `Evaluated alongside ${openCompetingRequests.length} other open relief request(s) to preserve warehouse reserve cushions.`
    );
  }

  let totalRequestedQty = 0;
  let totalAllocatedQty = 0;

  for (const reqItem of req.items) {
    let remaining = Math.max(0, reqItem.quantity - reqItem.fulfilledQuantity);
    if (remaining <= 0) continue;
    totalRequestedQty += remaining;

    const competingQty = openCompetingRequests.reduce((sum, other) => {
      const m = other.items.find((it) => it.category === reqItem.category);
      return sum + (m ? Math.max(0, m.quantity - m.fulfilledQuantity) : 0);
    }, 0);

    const candidates: {
      wh: (typeof eligibleWarehouses)[number];
      stock: (typeof store.state.inventory)[number];
      distanceKm: number;
      estimatedTravelMin: number;
      score: number;
      hasVehicle: boolean;
      expiryNote: string | null;
      reason: string;
    }[] = [];

    for (const wh of eligibleWarehouses) {
      const matchingStocks = store.state.inventory.filter(
        (inv) =>
          inv.mode === mode &&
          inv.warehouseId === wh.id &&
          inv.category === reqItem.category &&
          inv.availableQty > 0
      );
      if (matchingStocks.length === 0) continue;

      // Pick best matching stock record (prefer exact itemName match, else highest available)
      const stock =
        matchingStocks.find((s) => s.itemName.toLowerCase() === reqItem.itemName.toLowerCase()) ||
        matchingStocks.sort((a, b) => b.availableQty - a.availableQty)[0];

      const distanceKm = Math.round(haversineKm(wh.lat, wh.lng, req.lat, req.lng) * 100) / 100;
      const estimatedTravelMin = Math.max(5, Math.round((distanceKm / 42) * 60));

      // Dimension 1: Fulfillment capability
      const fulfillmentRatio = Math.min(1, stock.availableQty / remaining);
      const fulfillmentScore = fulfillmentRatio * 100;

      // Dimension 2 & 3: Distance & estimated travel time
      const distanceScore = Math.max(5, 100 - distanceKm * 0.65);
      const travelTimeScore = Math.max(5, 100 - estimatedTravelMin * 0.45);

      // Dimension 4 & 5: Operational status & accessibility
      const statusScore = wh.status === 'operational' ? 100 : 58;
      const accessScore = wh.accessibility === 'high' ? 100 : wh.accessibility === 'moderate' ? 72 : 35;

      // Dimension 6: Stockout & competing-demand protection
      const takeIfChosen = Math.min(remaining, stock.availableQty);
      const postRemaining = stock.availableQty - takeIfChosen;
      const reserveTarget = Math.max(1, stock.minStock + (competingQty > 0 ? Math.round(stock.minStock * 0.25) : 0));
      const shortageProtectionScore = Math.min(100, Math.round((postRemaining / reserveTarget) * 80) + 20);

      // Dimension 7: Vehicle availability & capacity at warehouse
      const depotVehicles = availableVehicles.filter((v) => v.warehouseId === wh.id);
      const hasVehicle = depotVehicles.length > 0;
      const canLiftCargo = depotVehicles.some((v) => v.capacityUnits >= takeIfChosen);
      const vehicleReadinessScore = canLiftCargo ? 100 : hasVehicle ? 75 : 25;

      // Dimension 8: Stock freshness / FEFO expiry prioritization (prioritize valid near-expiry batches before they spoil, exclude expired)
      const batches = store.state.inventoryBatches.filter(
        (b) => b.mode === mode && b.stockId === stock.id && b.qualityStatus === 'good' && b.quantity > 0
      );
      let freshnessScore = 80;
      let expiryNote: string | null = null;
      const nowMs = Date.now();
      const soonestBatch = batches
        .filter((b) => b.expiryDate)
        .map((b) => ({ batch: b, daysLeft: (new Date(b.expiryDate!).getTime() - nowMs) / 86_400_000 }))
        .sort((a, b) => a.daysLeft - b.daysLeft)[0];

      if (soonestBatch) {
        if (soonestBatch.daysLeft <= 0) {
          freshnessScore = 10;
          expiryNote = `Batch ${soonestBatch.batch.lotNumber} expired — excluded from allocation.`;
        } else if (soonestBatch.daysLeft <= 14) {
          freshnessScore = 100; // FEFO bonus: dispatch fresh usable stock nearing expiry first
          expiryNote = `FEFO priority: Batch ${soonestBatch.batch.lotNumber} expires in ${Math.ceil(soonestBatch.daysLeft)}d.`;
        }
      }

      // Bonus if warehouse supports incident type
      const typeBonus =
        incident && wh.supportedResponseTypes?.includes(incident.type) ? 4 : 0;

      const weightedScore = Math.min(
        100,
        Math.round(
          fulfillmentScore * weights.fulfillment +
            distanceScore * weights.distance +
            travelTimeScore * weights.travelTime +
            statusScore * weights.warehouseStatus +
            accessScore * weights.accessibility +
            shortageProtectionScore * weights.shortageProtection +
            vehicleReadinessScore * weights.vehicleReadiness +
            freshnessScore * weights.freshness +
            typeBonus
        )
      );

      const reason = `Score ${weightedScore}/100 — covers ${Math.round(fulfillmentRatio * 100)}% of ${reqItem.itemName}, ${distanceKm}km away, status ${wh.status}, ${hasVehicle ? `${depotVehicles.length} vehicle(s) ready` : 'no local vehicle ready'}.`;

      candidates.push({
        wh,
        stock,
        distanceKm,
        estimatedTravelMin,
        score: weightedScore,
        hasVehicle,
        expiryNote,
        reason,
      });

      const prevAlt = alternativesMap.get(wh.id);
      if (!prevAlt || weightedScore > prevAlt.score) {
        alternativesMap.set(wh.id, {
          warehouseId: wh.id,
          warehouseName: wh.name,
          warehouseStatus: wh.status,
          fulfillableQty: (prevAlt?.fulfillableQty ?? 0) + Math.min(remaining, stock.availableQty),
          distanceKm,
          estimatedDurationMin: estimatedTravelMin,
          hasAvailableVehicle: hasVehicle,
          score: weightedScore,
          reason,
        });
      } else {
        prevAlt.fulfillableQty += Math.min(remaining, stock.availableQty);
      }
    }

    // Rank strictly by multi-criteria composite score (NOT nearest distance alone!)
    candidates.sort((a, b) => b.score - a.score);

    const usedWarehousesForItem = new Set<string>();
    for (const cand of candidates) {
      if (remaining <= 0) break;
      if (!allowSplit && usedWarehousesForItem.size >= 1) break;
      if (usedWarehousesForItem.size >= maxWarehouses) break;

      const take = Math.min(remaining, cand.stock.availableQty);
      if (take <= 0) continue;

      if (cand.stock.availableQty - take < cand.stock.minStock) {
        warnings.push(
          `Allocating ${take} ${reqItem.unit} of ${cand.stock.itemName} from ${cand.wh.name} brings available stock below minimum threshold (${cand.stock.minStock}).`
        );
      }
      if (cand.wh.status === 'limited') {
        warnings.push(`${cand.wh.name} is operating under LIMITED status — verify loading dock access.`);
      }
      if (!cand.hasVehicle) {
        warnings.push(`${cand.wh.name} currently has no available vehicles on-site; fleet staging needed.`);
      }

      allocatedLines.push({
        warehouseId: cand.wh.id,
        warehouseName: cand.wh.name,
        stockId: cand.stock.id,
        sku: cand.stock.sku,
        itemName: cand.stock.itemName,
        category: reqItem.category,
        quantity: take,
        unit: reqItem.unit,
        distanceKm: cand.distanceKm,
        estimatedEtaMin: null,
        candidateScore: cand.score,
        expiryRiskNote: cand.expiryNote,
      });

      usedWarehousesForItem.add(cand.wh.id);
      remaining -= take;
      totalAllocatedQty += take;
    }

    if (remaining > 0) {
      unmetItems.push({
        category: reqItem.category,
        itemName: reqItem.itemName,
        quantity: remaining,
        unit: reqItem.unit,
      });
      warnings.push(
        `Unmet shortage: ${remaining} ${reqItem.unit} of ${reqItem.itemName} could not be allocated from operational depots.`
      );
    }
  }

  const distinctWarehouses = Array.from(new Set(allocatedLines.map((l) => l.warehouseId)));
  const splitAllocation = distinctWarehouses.length > 1;
  if (splitAllocation) {
    constraints.push(
      `Multi-warehouse split allocation across ${distinctWarehouses.length} depots to maximize fulfillment and protect regional reserves.`
    );
  }

  // Real route calculation from primary warehouse to request destination
  let totalDistanceKm = 0;
  let estimatedDurationMin: number | null = null;
  let routeProvider = 'none';
  let roadConditionsNotice = 'Road safety data unavailable — route has not been safety verified.';

  if (distinctWarehouses.length > 0) {
    const primaryWh = store.state.warehouses.find((w) => w.id === distinctWarehouses[0]);
    if (primaryWh) {
      const route = await optimizeRouteWithAlternatives({
        origin: { lat: primaryWh.lat, lng: primaryWh.lng, label: primaryWh.name },
        destination: { lat: req.lat, lng: req.lng, label: req.locationName },
        mode,
      });
      totalDistanceKm = route.distanceKm;
      estimatedDurationMin = route.durationMin;
      routeProvider = route.provider;
      roadConditionsNotice = route.roadConditionsNotice;
      for (const line of allocatedLines) {
        if (line.warehouseId === primaryWh.id) {
          line.estimatedEtaMin = route.durationMin;
        }
      }
      if (route.riskAssessment && ['HIGH', 'BLOCKED'].includes(route.riskAssessment.riskBand)) {
        warnings.push(`Primary route flagged as ${route.riskAssessment.riskBand} RISK (${route.riskAssessment.hazards.length} hazard(s)).`);
      }
    }
  }

  const totalUnits = allocatedLines.reduce((acc, l) => acc + l.quantity, 0);
  const matchedVehicle =
    availableVehicles.find((v) => v.warehouseId === distinctWarehouses[0] && v.capacityUnits >= totalUnits) ||
    availableVehicles.find((v) => distinctWarehouses.includes(v.warehouseId)) ||
    [...availableVehicles].sort((a, b) => b.capacityUnits - a.capacityUnits)[0] ||
    null;

  if (!matchedVehicle) {
    warnings.push('No available vehicle currently registered in operational fleet — register or free a vehicle before dispatch.');
  } else if (matchedVehicle.capacityUnits < totalUnits) {
    constraints.push(
      `Allocated load (${totalUnits} units) exceeds ${matchedVehicle.callsign} single-trip capacity (${matchedVehicle.capacityUnits} units); split convoy or larger vehicle required.`
    );
  }

  const fulfillmentPct =
    totalRequestedQty > 0 ? Math.round((totalAllocatedQty / totalRequestedQty) * 100) : 0;

  const alternatives = Array.from(alternativesMap.values()).sort((a, b) => b.score - a.score);
  const now = new Date().toISOString();

  const allocation: Allocation = {
    id: uuidv4(),
    requestId: req.id,
    incidentId: req.incidentId,
    status: 'proposed',
    splitAllocation,
    items: allocatedLines,
    unmetItems,
    fulfillmentPct,
    recommendedVehicleId: matchedVehicle?.id || null,
    totalDistanceKm,
    estimatedDurationMin,
    routeProvider,
    roadConditionsNotice,
    explanation:
      allocatedLines.length > 0
        ? `Multi-warehouse optimizer evaluated ${alternatives.length} candidate depot(s) across availability, distance, travel time, operational status, accessibility, stockout protection, vehicle readiness, and freshness. Achieved ${fulfillmentPct}% fulfillment (${splitAllocation ? `split across ${distinctWarehouses.length} depots` : 'single depot'}). Priority: ${priorityResult.band} (${priorityResult.score}/100). Human approval required before stock reservation.`
        : 'No operational warehouse holds available inventory for the requested relief items.',
    constraints,
    warnings,
    alternatives,
    priorityResult,
    reservationIds: [],
    dataFreshness: 'fresh',
    fairnessNotes,
    confidence:
      allocatedLines.length === 0
        ? 0.2
        : unmetItems.length === 0 && routeProvider !== 'haversine_fallback'
        ? 0.92
        : 0.71,
    requiresApproval: true,
    mode,
    createdAt: now,
    updatedAt: now,
  };

  store.state.allocations.unshift(allocation);
  store.save();

  if (params.actor) {
    store.addAudit({
      actor: params.actor.name,
      role: params.actor.role,
      orgId: params.actor.orgId,
      action: 'allocation.optimized',
      entityType: 'allocation',
      entityId: allocation.id,
      summary: `Optimized allocation (${fulfillmentPct}% coverage, ${distinctWarehouses.length} depot(s), priority ${priorityResult.band}) for ${req.locationName}`,
      mode,
    });
    eventBus.publish({
      event_type: 'allocation.recommended',
      organization_id: params.actor.orgId,
      entity_id: allocation.id,
      source: 'allocation-optimizer',
      mode,
      payload: { allocation },
    });
  }

  return allocation;
}

export function editAllocationProposal(params: {
  allocationId: string;
  items?: { stockId: string; quantity: number }[];
  recommendedVehicleId?: string | null;
  note?: string;
  actor: LogisticsActor;
}): Allocation {
  const alloc = store.state.allocations.find((a) => a.id === params.allocationId);
  if (!alloc) throw new LogisticsError('Allocation not found.', 404);
  if (alloc.status !== 'proposed') {
    throw new LogisticsError(`Only 'proposed' allocations can be edited (current status: '${alloc.status}').`, 400);
  }

  const req = store.state.reliefRequests.find((r) => r.id === alloc.requestId);
  const now = new Date().toISOString();

  if (params.items && params.items.length > 0) {
    const updatedLines: AllocationLineItem[] = [];
    for (const edit of params.items) {
      if (edit.quantity <= 0) continue;
      const stock = store.state.inventory.find((s) => s.id === edit.stockId && s.mode === alloc.mode);
      if (!stock) throw new LogisticsError(`Inventory stock ${edit.stockId} not found.`, 404);
      if (stock.availableQty < edit.quantity) {
        throw new LogisticsError(
          `Requested edit quantity (${edit.quantity}) exceeds available stock (${stock.availableQty}) for ${stock.itemName}.`,
          409
        );
      }
      const wh = store.state.warehouses.find((w) => w.id === stock.warehouseId);
      const dist = req && wh ? Math.round(haversineKm(wh.lat, wh.lng, req.lat, req.lng) * 100) / 100 : 0;
      updatedLines.push({
        warehouseId: stock.warehouseId,
        warehouseName: wh?.name || 'Warehouse',
        stockId: stock.id,
        sku: stock.sku,
        itemName: stock.itemName,
        category: stock.category,
        quantity: edit.quantity,
        unit: stock.unit,
        distanceKm: dist,
        estimatedEtaMin: alloc.estimatedDurationMin,
        candidateScore: 80,
      });
    }
    alloc.items = updatedLines;
    alloc.splitAllocation = new Set(updatedLines.map((l) => l.warehouseId)).size > 1;
    if (req) {
      const totalReq = req.items.reduce((s, it) => s + Math.max(0, it.quantity - it.fulfilledQuantity), 0);
      const totalAlloc = updatedLines.reduce((s, l) => s + l.quantity, 0);
      alloc.fulfillmentPct = totalReq > 0 ? Math.min(100, Math.round((totalAlloc / totalReq) * 100)) : 0;
    }
  }

  if (params.recommendedVehicleId !== undefined) {
    if (params.recommendedVehicleId !== null) {
      const veh = store.state.vehicles.find((v) => v.id === params.recommendedVehicleId && v.mode === alloc.mode);
      if (!veh) throw new LogisticsError('Selected vehicle not found.', 404);
    }
    alloc.recommendedVehicleId = params.recommendedVehicleId;
  }

  if (params.note) {
    alloc.constraints = Array.from(new Set([...alloc.constraints, `Operator edit: ${params.note}`]));
  }
  alloc.updatedAt = now;
  store.save();

  store.addAudit({
    actor: params.actor.name,
    role: params.actor.role,
    orgId: params.actor.orgId,
    action: 'allocation.edited',
    entityType: 'allocation',
    entityId: alloc.id,
    summary: `Modified allocation proposal ${alloc.id.slice(0, 8)} (${alloc.items.length} line item(s))`,
    mode: alloc.mode,
  });

  return alloc;
}

// ============================================================================
// 4. FLEET & DRIVER MANAGEMENT SERVICES
// ============================================================================

export function createVehicleRecord(input: {
  registrationNumber?: string;
  callsign: string;
  name?: string;
  vehicleType: VehicleType;
  warehouseId: string;
  capacityKg: number;
  capacityUnits: number;
  capacityUnit?: string;
  driverId?: string | null;
  driverTeam: string;
  driverContact?: string;
  fuelPct?: number | null;
  maintenanceStatus?: Vehicle['maintenanceStatus'];
  equipment?: string[];
  lastServiceDate?: string | null;
  mode: DataMode;
  actor: LogisticsActor;
}): Vehicle {
  const wh = store.state.warehouses.find((w) => w.id === input.warehouseId && w.mode === input.mode);
  if (!wh) throw new LogisticsError('Assigned base warehouse not found in current mode.', 404);

  let driverName = input.driverTeam;
  let driverContact = input.driverContact;
  if (input.driverId) {
    const drv = store.state.drivers.find((d) => d.id === input.driverId && d.mode === input.mode);
    if (!drv) throw new LogisticsError('Selected driver not found.', 404);
    driverName = drv.name;
    driverContact = drv.contact;
  }

  const now = new Date().toISOString();
  const maint = input.maintenanceStatus || 'operational';
  const status: VehicleStatus =
    maint === 'in_maintenance' || maint === 'out_of_service' ? 'maintenance' : 'available';

  const vehicle: Vehicle = {
    id: uuidv4(),
    registrationNumber: input.registrationNumber || `RF-${uuidv4().slice(0, 6).toUpperCase()}`,
    callsign: input.callsign.trim(),
    name: input.name?.trim() || input.callsign.trim(),
    vehicleType: input.vehicleType,
    orgId: input.actor.orgId,
    warehouseId: wh.id,
    capacityKg: input.capacityKg,
    capacityUnits: input.capacityUnits,
    capacityUnit: input.capacityUnit || 'units',
    status,
    driverId: input.driverId || null,
    driverTeam: driverName,
    driverContact,
    fuelPct: input.fuelPct ?? null,
    maintenanceStatus: maint,
    equipment: input.equipment || [],
    lastServiceDate: input.lastServiceDate || null,
    lat: wh.lat,
    lng: wh.lng,
    lastLocationAt: now,
    gpsSource: input.mode === 'demo' ? 'simulated_demo' : 'last_known',
    assignedDispatchId: null,
    history: [
      {
        id: uuidv4(),
        timestamp: now,
        actor: input.actor.name,
        action: 'vehicle.registered',
        newStatus: status,
        note: `Registered at ${wh.name}`,
      },
    ],
    mode: input.mode,
    createdAt: now,
    updatedAt: now,
  };

  if (input.driverId) {
    const drv = store.state.drivers.find((d) => d.id === input.driverId);
    if (drv) {
      drv.assignedVehicleId = vehicle.id;
      drv.updatedAt = now;
    }
  }

  store.state.vehicles.unshift(vehicle);
  store.save();

  store.addAudit({
    actor: input.actor.name,
    role: input.actor.role,
    orgId: input.actor.orgId,
    action: 'vehicle.created',
    entityType: 'vehicle',
    entityId: vehicle.id,
    summary: `Registered ${vehicle.callsign} (${vehicle.vehicleType}, ${vehicle.capacityUnits} units) at ${wh.name}`,
    mode: vehicle.mode,
  });

  eventBus.publish({
    event_type: 'fleet.vehicle_updated',
    organization_id: input.actor.orgId,
    entity_id: vehicle.id,
    source: 'fleet-api',
    mode: vehicle.mode,
    payload: { vehicle },
  });

  return vehicle;
}

export function updateVehicleRecord(
  vehicleId: string,
  patch: Partial<
    Pick<
      Vehicle,
      | 'registrationNumber'
      | 'callsign'
      | 'name'
      | 'vehicleType'
      | 'warehouseId'
      | 'capacityKg'
      | 'capacityUnits'
      | 'capacityUnit'
      | 'driverTeam'
      | 'driverContact'
      | 'fuelPct'
      | 'maintenanceStatus'
      | 'equipment'
      | 'lastServiceDate'
    >
  >,
  actor: LogisticsActor
): Vehicle {
  const vehicle = store.state.vehicles.find((v) => v.id === vehicleId);
  if (!vehicle) throw new LogisticsError('Vehicle not found.', 404);

  const now = new Date().toISOString();
  const prevStatus = vehicle.status;

  if (patch.warehouseId) {
    const wh = store.state.warehouses.find((w) => w.id === patch.warehouseId && w.mode === vehicle.mode);
    if (!wh) throw new LogisticsError('Target base warehouse not found.', 404);
    vehicle.warehouseId = wh.id;
  }
  if (patch.registrationNumber !== undefined) vehicle.registrationNumber = patch.registrationNumber;
  if (patch.callsign !== undefined) vehicle.callsign = patch.callsign;
  if (patch.name !== undefined) vehicle.name = patch.name;
  if (patch.vehicleType !== undefined) vehicle.vehicleType = patch.vehicleType;
  if (patch.capacityKg !== undefined) vehicle.capacityKg = patch.capacityKg;
  if (patch.capacityUnits !== undefined) vehicle.capacityUnits = patch.capacityUnits;
  if (patch.capacityUnit !== undefined) vehicle.capacityUnit = patch.capacityUnit;
  if (patch.driverTeam !== undefined) vehicle.driverTeam = patch.driverTeam;
  if (patch.driverContact !== undefined) vehicle.driverContact = patch.driverContact;
  if (patch.fuelPct !== undefined) vehicle.fuelPct = patch.fuelPct;
  if (patch.equipment !== undefined) vehicle.equipment = patch.equipment;
  if (patch.lastServiceDate !== undefined) vehicle.lastServiceDate = patch.lastServiceDate;

  if (patch.maintenanceStatus !== undefined) {
    vehicle.maintenanceStatus = patch.maintenanceStatus;
    if (patch.maintenanceStatus === 'in_maintenance' || patch.maintenanceStatus === 'out_of_service') {
      if (vehicle.assignedDispatchId) {
        throw new LogisticsError('Cannot move vehicle to maintenance while assigned to an active dispatch.', 409);
      }
      vehicle.status = 'maintenance';
    } else if (vehicle.status === 'maintenance') {
      vehicle.status = 'available';
    }
  }

  vehicle.updatedAt = now;
  vehicle.history = vehicle.history || [];
  vehicle.history.unshift({
    id: uuidv4(),
    timestamp: now,
    actor: actor.name,
    action: 'vehicle.updated',
    previousStatus: prevStatus,
    newStatus: vehicle.status,
    note: 'Updated vehicle profile/maintenance record',
  });
  store.save();

  store.addAudit({
    actor: actor.name,
    role: actor.role,
    orgId: actor.orgId,
    action: 'vehicle.updated',
    entityType: 'vehicle',
    entityId: vehicle.id,
    summary: `Updated vehicle ${vehicle.callsign} (status: ${vehicle.status}, maintenance: ${vehicle.maintenanceStatus || 'operational'})`,
    mode: vehicle.mode,
  });

  eventBus.publish({
    event_type: 'fleet.vehicle_updated',
    organization_id: actor.orgId,
    entity_id: vehicle.id,
    source: 'fleet-api',
    mode: vehicle.mode,
    payload: { vehicle },
  });

  return vehicle;
}

export function updateVehicleStatus(
  vehicleId: string,
  status: VehicleStatus,
  note: string | undefined,
  actor: LogisticsActor
): Vehicle {
  const vehicle = store.state.vehicles.find((v) => v.id === vehicleId);
  if (!vehicle) throw new LogisticsError('Vehicle not found.', 404);

  if ((status === 'maintenance' || status === 'unavailable') && vehicle.assignedDispatchId) {
    const activeDsp = store.state.dispatches.find(
      (d) => d.id === vehicle.assignedDispatchId && ACTIVE_DISPATCH_STATUSES.has(d.status)
    );
    if (activeDsp) {
      throw new LogisticsError(
        `Vehicle ${vehicle.callsign} is assigned to active dispatch ${activeDsp.id.slice(0, 8)} and cannot be marked ${status}.`,
        409
      );
    }
  }

  const now = new Date().toISOString();
  const prevStatus = vehicle.status;
  vehicle.status = status;
  if (status === 'maintenance') {
    vehicle.maintenanceStatus = 'in_maintenance';
  } else if (status === 'available') {
    vehicle.maintenanceStatus = 'operational';
    vehicle.assignedDispatchId = null;
  }
  vehicle.updatedAt = now;
  vehicle.history = vehicle.history || [];
  vehicle.history.unshift({
    id: uuidv4(),
    timestamp: now,
    actor: actor.name,
    action: 'vehicle.status_changed',
    previousStatus: prevStatus,
    newStatus: status,
    note: note || `Status changed from ${prevStatus} to ${status}`,
  });
  store.save();

  store.addAudit({
    actor: actor.name,
    role: actor.role,
    orgId: actor.orgId,
    action: 'vehicle.status_changed',
    entityType: 'vehicle',
    entityId: vehicle.id,
    summary: `${vehicle.callsign}: ${prevStatus} -> ${status}`,
    mode: vehicle.mode,
  });

  eventBus.publish({
    event_type: 'fleet.vehicle_updated',
    organization_id: actor.orgId,
    entity_id: vehicle.id,
    source: 'fleet-api',
    mode: vehicle.mode,
    payload: { vehicle },
  });

  return vehicle;
}

export function assignDriverToVehicle(vehicleId: string, driverId: string, actor: LogisticsActor): { vehicle: Vehicle; driver: Driver } {
  const vehicle = store.state.vehicles.find((v) => v.id === vehicleId);
  if (!vehicle) throw new LogisticsError('Vehicle not found.', 404);
  const driver = store.state.drivers.find((d) => d.id === driverId && d.mode === vehicle.mode);
  if (!driver) throw new LogisticsError('Driver not found in this operational mode.', 404);

  if (driver.status === 'Unavailable' || driver.status === 'Off Duty') {
    throw new LogisticsError(`Driver ${driver.name} is currently '${driver.status}' and cannot be assigned.`, 409);
  }
  if (driver.assignedDispatchId) {
    const activeDsp = store.state.dispatches.find(
      (d) => d.id === driver.assignedDispatchId && ACTIVE_DISPATCH_STATUSES.has(d.status)
    );
    if (activeDsp) {
      throw new LogisticsError(`Driver ${driver.name} is already on active dispatch ${activeDsp.id.slice(0, 8)}.`, 409);
    }
  }

  const now = new Date().toISOString();

  // Detach previous driver from this vehicle if different
  if (vehicle.driverId && vehicle.driverId !== driver.id) {
    const oldDrv = store.state.drivers.find((d) => d.id === vehicle.driverId);
    if (oldDrv && oldDrv.assignedVehicleId === vehicle.id) {
      oldDrv.assignedVehicleId = null;
      oldDrv.updatedAt = now;
    }
  }

  // Prevent double assignment of a driver who is already assigned to another vehicle
  if (driver.assignedVehicleId && driver.assignedVehicleId !== vehicle.id) {
    const oldVeh = store.state.vehicles.find((v) => v.id === driver.assignedVehicleId);
    throw new LogisticsError(
      `Driver ${driver.name} is already assigned to vehicle ${oldVeh?.callsign || driver.assignedVehicleId}. Unassign first before reassigning.`,
      409
    );
  }

  vehicle.driverId = driver.id;
  vehicle.driverTeam = driver.name;
  vehicle.driverContact = driver.contact;
  vehicle.updatedAt = now;
  vehicle.history = vehicle.history || [];
  vehicle.history.unshift({
    id: uuidv4(),
    timestamp: now,
    actor: actor.name,
    action: 'vehicle.driver_assigned',
    note: `Assigned driver ${driver.name}`,
  });

  driver.assignedVehicleId = vehicle.id;
  driver.updatedAt = now;
  driver.assignmentHistory.unshift({
    id: uuidv4(),
    timestamp: now,
    action: `Assigned to vehicle ${vehicle.callsign}`,
    vehicleId: vehicle.id,
    actor: actor.name,
  });

  store.save();

  store.addAudit({
    actor: actor.name,
    role: actor.role,
    orgId: actor.orgId,
    action: 'vehicle.driver_assigned',
    entityType: 'vehicle',
    entityId: vehicle.id,
    summary: `Assigned driver ${driver.name} to ${vehicle.callsign}`,
    mode: vehicle.mode,
  });

  eventBus.publish({
    event_type: 'fleet.driver_assigned',
    organization_id: actor.orgId,
    entity_id: vehicle.id,
    source: 'fleet-api',
    mode: vehicle.mode,
    payload: { vehicle, driver: sanitizeDriverForRole(driver, 'analyst') },
  });

  return { vehicle, driver };
}

export function createDriverRecord(input: {
  name: string;
  contact: string;
  orgId?: string;
  status?: DriverStatus;
  certifications?: string[];
  mode: DataMode;
  actor: LogisticsActor;
}): Driver {
  const now = new Date().toISOString();
  const driver: Driver = {
    id: uuidv4(),
    name: input.name.trim(),
    contact: input.contact.trim(),
    contactMasked: maskContactPhone(input.contact),
    orgId: input.orgId || input.actor.orgId,
    status: input.status || 'Available',
    assignedVehicleId: null,
    assignedDispatchId: null,
    certifications: input.certifications || [],
    lastKnownLat: null,
    lastKnownLng: null,
    lastLocationAt: null,
    assignmentHistory: [
      {
        id: uuidv4(),
        timestamp: now,
        action: 'Driver profile created',
        actor: input.actor.name,
      },
    ],
    mode: input.mode,
    createdAt: now,
    updatedAt: now,
  };
  store.state.drivers.unshift(driver);
  store.save();

  store.addAudit({
    actor: input.actor.name,
    role: input.actor.role,
    orgId: input.actor.orgId,
    action: 'driver.created',
    entityType: 'driver',
    entityId: driver.id,
    summary: `Registered driver/responder ${driver.name} (${driver.status})`,
    mode: driver.mode,
  });

  return driver;
}

export function updateDriverRecord(
  driverId: string,
  patch: Partial<Pick<Driver, 'name' | 'contact' | 'status' | 'certifications'>>,
  actor: LogisticsActor
): Driver {
  const driver = store.state.drivers.find((d) => d.id === driverId);
  if (!driver) throw new LogisticsError('Driver not found.', 404);

  if ((patch.status === 'Unavailable' || patch.status === 'Off Duty') && driver.assignedDispatchId) {
    const activeDsp = store.state.dispatches.find(
      (d) => d.id === driver.assignedDispatchId && ACTIVE_DISPATCH_STATUSES.has(d.status)
    );
    if (activeDsp) {
      throw new LogisticsError(`Driver ${driver.name} is assigned to active dispatch ${activeDsp.id.slice(0, 8)}.`, 409);
    }
  }

  const now = new Date().toISOString();
  if (patch.name !== undefined) driver.name = patch.name.trim();
  if (patch.contact !== undefined) {
    driver.contact = patch.contact.trim();
    driver.contactMasked = maskContactPhone(driver.contact);
  }
  if (patch.status !== undefined) driver.status = patch.status;
  if (patch.certifications !== undefined) driver.certifications = patch.certifications;
  driver.updatedAt = now;
  store.save();

  store.addAudit({
    actor: actor.name,
    role: actor.role,
    orgId: actor.orgId,
    action: 'driver.updated',
    entityType: 'driver',
    entityId: driver.id,
    summary: `Updated driver ${driver.name} (status: ${driver.status})`,
    mode: driver.mode,
  });

  return driver;
}

// ============================================================================
// 5. DISPATCH PLANNING, HUMAN APPROVAL GATE & STRICT STATE MACHINE
// ============================================================================

function computeEtaFeasibility(durationMin: number | null, deadline: string | null | undefined): {
  etaStatus: EtaStatus;
  estimatedArrivalAt: string | null;
} {
  if (durationMin === null) {
    return { etaStatus: 'UNKNOWN', estimatedArrivalAt: null };
  }
  const arrivalMs = Date.now() + durationMin * 60_000;
  const estimatedArrivalAt = new Date(arrivalMs).toISOString();
  if (!deadline) {
    return { etaStatus: 'ON_TIME', estimatedArrivalAt };
  }
  const deadlineMs = new Date(deadline).getTime();
  if (Number.isNaN(deadlineMs)) {
    return { etaStatus: 'UNKNOWN', estimatedArrivalAt };
  }
  if (arrivalMs > deadlineMs) {
    return { etaStatus: 'DELAYED', estimatedArrivalAt };
  }
  if (deadlineMs - arrivalMs <= 45 * 60_000) {
    return { etaStatus: 'AT_RISK', estimatedArrivalAt };
  }
  return { etaStatus: 'ON_TIME', estimatedArrivalAt };
}

export async function planDispatch(params: {
  requestId: string;
  allocationId?: string;
  warehouseId?: string;
  vehicleId?: string;
  driverId?: string;
  actor: LogisticsActor;
}): Promise<DispatchPlan> {
  const req = store.state.reliefRequests.find((r) => r.id === params.requestId);
  if (!req) throw new LogisticsError('Relief request not found.', 404);

  const mode = req.mode;
  const priority = computeAllocationPriority(req.id);
  const warnings: string[] = [];

  if (req.verificationStatus !== 'verified') {
    warnings.push('Relief request is UNVERIFIED — human verification recommended prior to dispatch approval.');
  }

  let alloc = params.allocationId
    ? store.state.allocations.find((a) => a.id === params.allocationId && a.mode === mode)
    : store.state.allocations.find(
        (a) => a.requestId === req.id && a.mode === mode && ['reserved', 'approved', 'proposed'].includes(a.status)
      );

  if (!alloc) {
    alloc = await optimizeMultiWarehouseAllocation({ requestId: req.id, actor: params.actor });
  }

  const targetWhId = params.warehouseId || alloc.items[0]?.warehouseId;
  const warehouse = store.state.warehouses.find((w) => w.id === targetWhId && w.mode === mode);
  if (!warehouse) {
    throw new LogisticsError('No operational source warehouse available for this dispatch plan.', 400);
  }
  if (warehouse.status !== 'operational' && warehouse.status !== 'limited') {
    warnings.push(`Source warehouse ${warehouse.name} is currently '${warehouse.status}'.`);
  }

  const lineItems = alloc.items.filter((it) => it.warehouseId === warehouse.id);
  const items: DispatchItemRecord[] = (lineItems.length > 0 ? lineItems : alloc.items).map((it) => ({
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
  }));

  const totalUnits = items.reduce((s, it) => s + it.quantity, 0);
  const estimatedWeightKg = Math.round(totalUnits * 2.5);

  const vehicle = params.vehicleId
    ? store.state.vehicles.find((v) => v.id === params.vehicleId && v.mode === mode)
    : store.state.vehicles.find(
        (v) =>
          v.mode === mode &&
          v.status === 'available' &&
          v.maintenanceStatus !== 'in_maintenance' &&
          v.maintenanceStatus !== 'out_of_service' &&
          (v.warehouseId === warehouse.id || v.id === alloc?.recommendedVehicleId)
      ) ||
      store.state.vehicles.find(
        (v) =>
          v.mode === mode &&
          v.status === 'available' &&
          v.maintenanceStatus !== 'in_maintenance' &&
          v.maintenanceStatus !== 'out_of_service'
      );

  let vehicleCapacityOk = false;
  let capacityWarning: string | null = null;
  if (!vehicle) {
    capacityWarning = 'No available vehicle found in fleet.';
    warnings.push(capacityWarning);
  } else {
    if (vehicle.status !== 'available' || vehicle.maintenanceStatus === 'in_maintenance' || vehicle.maintenanceStatus === 'out_of_service') {
      warnings.push(`Vehicle ${vehicle.callsign} is not available (status: ${vehicle.status}).`);
    }
    vehicleCapacityOk = vehicle.capacityUnits >= totalUnits && vehicle.capacityKg >= estimatedWeightKg;
    if (!vehicleCapacityOk) {
      capacityWarning = `Cargo (${totalUnits} units / ~${estimatedWeightKg} kg) exceeds ${vehicle.callsign} capacity (${vehicle.capacityUnits} units / ${vehicle.capacityKg} kg).`;
      warnings.push(capacityWarning);
    }
  }

  const driver = params.driverId
    ? store.state.drivers.find((d) => d.id === params.driverId && d.mode === mode)
    : vehicle?.driverId
    ? store.state.drivers.find((d) => d.id === vehicle.driverId && d.mode === mode)
    : store.state.drivers.find((d) => d.mode === mode && d.status === 'Available');

  if (!driver) {
    warnings.push('No available driver assigned; assign an eligible driver before approving dispatch.');
  } else if (driver.status !== 'Available' && driver.status !== 'On Duty' && driver.assignedVehicleId !== vehicle?.id) {
    warnings.push(`Driver ${driver.name} is currently '${driver.status}'.`);
  }

  const route = await optimizeRouteWithAlternatives({
    origin: { lat: warehouse.lat, lng: warehouse.lng, label: warehouse.name },
    destination: { lat: req.lat, lng: req.lng, label: req.locationName },
    vehicleType: vehicle?.vehicleType,
    mode,
  });

  if (route.routeStatus === 'ROUTE_UNAVAILABLE') {
    warnings.push('Live road route unavailable — manual route confirmation required before departure.');
  }
  if (route.riskAssessment?.riskBand === 'BLOCKED') {
    warnings.push('Primary corridor is BLOCKED by reported hazard — choose alternative route.');
  } else if (route.riskAssessment?.riskBand === 'HIGH') {
    warnings.push('Primary corridor carries HIGH route risk.');
  }

  const { etaStatus, estimatedArrivalAt } = computeEtaFeasibility(route.durationMin, req.deliveryDeadline);
  if (etaStatus === 'DELAYED') {
    warnings.push('Estimated arrival exceeds requested delivery deadline.');
  }

  const readyForApproval =
    items.length > 0 &&
    Boolean(vehicle && vehicle.status === 'available' && vehicle.maintenanceStatus !== 'in_maintenance') &&
    vehicleCapacityOk &&
    route.riskAssessment?.riskBand !== 'BLOCKED';

  return {
    id: uuidv4(),
    requestId: req.id,
    incidentId: req.incidentId,
    allocationId: alloc.id,
    priorityLevel: priority.band,
    warehouseId: warehouse.id,
    warehouseName: warehouse.name,
    vehicleId: vehicle?.id || null,
    vehicleCallsign: vehicle?.callsign || null,
    driverId: driver?.id || null,
    driverName: driver?.name || vehicle?.driverTeam || null,
    items,
    totalUnits,
    estimatedWeightKg,
    vehicleCapacityOk,
    capacityWarning,
    route,
    routeRisk: route.riskAssessment || null,
    deliveryDeadline: req.deliveryDeadline || null,
    estimatedArrivalAt,
    etaStatus,
    feasibilityWarnings: warnings,
    readyForApproval,
    mode,
    createdAt: new Date().toISOString(),
  };
}

export async function createPendingDispatch(params: {
  allocationId: string;
  vehicleId: string;
  driverId?: string | null;
  warehouseId?: string;
  deliveryDeadline?: string | null;
  note?: string;
  initialState?: 'PENDING_APPROVAL' | 'DRAFT';
  actor: LogisticsActor;
}): Promise<Dispatch> {
  const alloc = store.state.allocations.find((a) => a.id === params.allocationId);
  if (!alloc) throw new LogisticsError('Allocation not found.', 404);
  if (alloc.status === 'rejected') {
    throw new LogisticsError('Cannot create dispatch from a rejected allocation.', 400);
  }
  if (alloc.items.length === 0) {
    throw new LogisticsError('Allocation has no allocated stock items to dispatch.', 400);
  }

  const vehicle = store.state.vehicles.find((v) => v.id === params.vehicleId && v.mode === alloc.mode);
  if (!vehicle) throw new LogisticsError('Vehicle not found.', 404);
  if (vehicle.maintenanceStatus === 'in_maintenance' || vehicle.maintenanceStatus === 'out_of_service' || vehicle.status === 'maintenance' || vehicle.status === 'unavailable') {
    throw new LogisticsError(`Vehicle ${vehicle.callsign} is unavailable for dispatch (${vehicle.status} / ${vehicle.maintenanceStatus}).`, 409);
  }
  if (vehicle.status !== 'available') {
    throw new LogisticsError(`Vehicle ${vehicle.callsign} is already '${vehicle.status}' and cannot be double-assigned.`, 409);
  }

  const driver = params.driverId
    ? store.state.drivers.find((d) => d.id === params.driverId && d.mode === alloc.mode)
    : vehicle.driverId
    ? store.state.drivers.find((d) => d.id === vehicle.driverId && d.mode === alloc.mode)
    : null;

  if (driver) {
    if (driver.status === 'Unavailable' || driver.status === 'Off Duty') {
      throw new LogisticsError(`Driver ${driver.name} is '${driver.status}' and cannot be assigned.`, 409);
    }
    if (driver.assignedDispatchId) {
      const other = store.state.dispatches.find(
        (d) => d.id === driver.assignedDispatchId && ACTIVE_DISPATCH_STATUSES.has(d.status)
      );
      if (other) {
        throw new LogisticsError(`Driver ${driver.name} is already assigned to active dispatch ${other.id.slice(0, 8)}.`, 409);
      }
    }
  }

  const reliefReq = store.state.reliefRequests.find((r) => r.id === alloc.requestId);
  if (!reliefReq) throw new LogisticsError('Linked relief request not found.', 404);

  const whId = params.warehouseId || alloc.items[0]?.warehouseId || vehicle.warehouseId;
  const wh = store.state.warehouses.find((w) => w.id === whId);
  if (!wh) throw new LogisticsError('Origin warehouse not found.', 404);

  const itemsForWh = alloc.items.filter((i) => i.warehouseId === wh.id);
  const dispatchItems: DispatchItemRecord[] = (itemsForWh.length > 0 ? itemsForWh : alloc.items).map((it) => ({
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
  }));

  const totalUnits = dispatchItems.reduce((s, it) => s + it.quantity, 0);
  if (totalUnits > vehicle.capacityUnits) {
    throw new LogisticsError(
      `Cargo quantity (${totalUnits} units) exceeds ${vehicle.callsign} capacity (${vehicle.capacityUnits} units).`,
      400
    );
  }

  const origin = { lat: wh.lat, lng: wh.lng, label: wh.name };
  const route = await optimizeRouteWithAlternatives({
    origin,
    destination: { lat: reliefReq.lat, lng: reliefReq.lng, label: reliefReq.locationName },
    vehicleType: vehicle.vehicleType,
    mode: alloc.mode,
  });

  const priority = computeAllocationPriority(reliefReq.id);
  const deadline = params.deliveryDeadline ?? reliefReq.deliveryDeadline ?? null;
  const { etaStatus } = computeEtaFeasibility(route.durationMin, deadline);
  const now = new Date().toISOString();
  const initialStatus: DispatchStatus = params.initialState || 'PENDING_APPROVAL';

  const dispatch: Dispatch = {
    id: uuidv4(),
    allocationId: alloc.id,
    requestId: reliefReq.id,
    incidentId: alloc.incidentId,
    warehouseId: wh.id,
    warehouseName: wh.name,
    vehicleId: vehicle.id,
    vehicleCallsign: vehicle.callsign,
    driverId: driver?.id || null,
    driverName: driver?.name || vehicle.driverTeam,
    priorityLevel: priority.band,
    destinationName: reliefReq.locationName,
    destinationLat: reliefReq.lat,
    destinationLng: reliefReq.lng,
    items: dispatchItems,
    reservationIds: [...(alloc.reservationIds || [])],
    status: initialStatus,
    approvalStatus: 'pending_approval',
    approvedBy: null,
    approvedAt: null,
    rejectedBy: null,
    rejectionReason: null,
    deliveryDeadline: deadline,
    initialEtaMin: route.durationMin,
    currentEtaMin: route.durationMin,
    etaStatus,
    etaHistory: [
      {
        timestamp: now,
        etaMin: route.durationMin,
        etaStatus,
        reason: 'Initial dispatch plan route calculation',
      },
    ],
    actualDepartureAt: null,
    actualArrivalAt: null,
    deliveredAt: null,
    route,
    routeRisk: route.riskAssessment || null,
    currentLat: alloc.mode === 'demo' ? origin.lat : null,
    currentLng: alloc.mode === 'demo' ? origin.lng : null,
    lastLocationAt: alloc.mode === 'demo' ? now : null,
    trackingStatus: alloc.mode === 'demo' ? 'SIMULATED_DEMO' : 'UNAVAILABLE',
    gpsLabel:
      alloc.mode === 'demo'
        ? 'SIMULATED DEMO TRACKING'
        : 'LIVE GPS UNAVAILABLE — Awaiting authorized field GPS telemetry',
    locationHistory: [],
    deliveryConfirmationId: null,
    events: [
      {
        id: uuidv4(),
        status: initialStatus,
        note: params.note || 'Dispatch proposal created — awaiting authorized human commander approval.',
        actor: params.actor.name,
        timestamp: now,
      },
    ],
    mode: alloc.mode,
    createdAt: now,
    updatedAt: now,
  };

  store.state.dispatches.unshift(dispatch);
  store.save();

  store.addAudit({
    actor: params.actor.name,
    role: params.actor.role,
    orgId: params.actor.orgId,
    action: 'dispatch.planned',
    entityType: 'dispatch',
    entityId: dispatch.id,
    summary: `Created dispatch ${dispatch.id.slice(0, 8)} (${initialStatus}) for ${vehicle.callsign} -> ${dispatch.destinationName}`,
    mode: dispatch.mode,
  });

  eventBus.publish({
    event_type: 'dispatch.created',
    organization_id: params.actor.orgId,
    entity_id: dispatch.id,
    source: 'dispatch-engine',
    mode: dispatch.mode,
    payload: { dispatch },
  });

  return dispatch;
}

export function approveDispatchWorkflow(params: {
  dispatchId: string;
  note?: string;
  overrideBlockedRoute?: boolean;
  actor: LogisticsActor;
}): { dispatch: Dispatch; reservations: StockReservation[] } {
  const dispatch = store.state.dispatches.find((d) => d.id === params.dispatchId);
  if (!dispatch) throw new LogisticsError('Dispatch not found.', 404);
  if (dispatch.status !== 'PENDING_APPROVAL' && dispatch.status !== 'DRAFT') {
    throw new LogisticsError(
      `Dispatch cannot be approved from state '${dispatch.status}'. Only DRAFT or PENDING_APPROVAL dispatches may be approved.`,
      400
    );
  }

  // 1. Revalidate incident state
  const incident = store.state.incidents.find((i) => i.id === dispatch.incidentId);
  if (incident && ['closed', 'archived', 'resolved'].includes(incident.status)) {
    throw new LogisticsError(`Linked incident is already '${incident.status}' — dispatch approval blocked.`, 409);
  }

  // 2. Revalidate vehicle availability (prevent concurrent double-assignment!)
  const vehicle = store.state.vehicles.find((v) => v.id === dispatch.vehicleId);
  if (!vehicle) throw new LogisticsError('Assigned vehicle not found.', 404);
  if (vehicle.maintenanceStatus === 'in_maintenance' || vehicle.maintenanceStatus === 'out_of_service' || vehicle.status === 'maintenance' || vehicle.status === 'unavailable') {
    throw new LogisticsError(`Approval blocked: vehicle ${vehicle.callsign} is in '${vehicle.status}' / '${vehicle.maintenanceStatus}'.`, 409);
  }
  if (vehicle.status !== 'available' && vehicle.assignedDispatchId !== dispatch.id) {
    throw new LogisticsError(
      `Approval blocked: vehicle ${vehicle.callsign} is already assigned to another active operation (${vehicle.status}).`,
      409
    );
  }

  // 3. Revalidate driver availability
  const driver = dispatch.driverId
    ? store.state.drivers.find((d) => d.id === dispatch.driverId)
    : null;
  if (driver) {
    if (driver.status === 'Unavailable' || driver.status === 'Off Duty') {
      throw new LogisticsError(`Approval blocked: driver ${driver.name} is '${driver.status}'.`, 409);
    }
    if (driver.assignedDispatchId && driver.assignedDispatchId !== dispatch.id) {
      const other = store.state.dispatches.find(
        (d) => d.id === driver.assignedDispatchId && ACTIVE_DISPATCH_STATUSES.has(d.status)
      );
      if (other) {
        throw new LogisticsError(`Approval blocked: driver ${driver.name} is concurrently assigned to dispatch ${other.id.slice(0, 8)}.`, 409);
      }
    }
  }

  // 4. Revalidate route safety (block if BLOCKED unless commander explicitly overrides)
  if (dispatch.routeRisk?.riskBand === 'BLOCKED' && !params.overrideBlockedRoute) {
    throw new LogisticsError(
      'Approval blocked: primary corridor is BLOCKED by a reported hazard. Reroute or pass explicit commander override.',
      409
    );
  }

  // 5. Revalidate inventory & atomically reserve stock if allocation is not already reserved
  const alloc = store.state.allocations.find((a) => a.id === dispatch.allocationId);
  const createdReservations: StockReservation[] = [];
  const items = dispatch.items || [];

  const alreadyReservedViaAllocation = alloc?.status === 'reserved' || alloc?.status === 'dispatched';
  const alreadyHasReservations = (dispatch.reservationIds || []).some((rid) =>
    store.state.stockReservations.some((r) => r.id === rid && ['Reserved', 'Allocated'].includes(r.status))
  );

  if (!alreadyReservedViaAllocation && !alreadyHasReservations) {
    // Pre-check all items atomically so partial failure does not corrupt stock
    for (const item of items) {
      const stock = store.state.inventory.find((s) => s.id === item.stockId);
      if (!stock || stock.availableQty < item.quantity) {
        throw new LogisticsError(
          `Approval blocked: insufficient available stock for ${item.itemName} (need ${item.quantity}, available ${stock?.availableQty ?? 0}).`,
          409
        );
      }
    }
    const resvNow = new Date().toISOString();
    for (const item of items) {
      const stock = store.state.inventory.find((s) => s.id === item.stockId)!;
      const prevAvail = stock.availableQty;
      stock.availableQty -= item.quantity;
      stock.reservedQty += item.quantity;
      stock.version += 1;
      stock.updatedAt = resvNow;

      const mov: StockMovement = {
        id: uuidv4(),
        stockId: stock.id,
        warehouseId: stock.warehouseId,
        itemName: stock.itemName,
        type: 'reservation',
        quantity: item.quantity,
        previousAvailable: prevAvail,
        newAvailable: stock.availableQty,
        reason: `Atomic reservation on approval of dispatch ${dispatch.id.slice(0, 8)}`,
        referenceId: dispatch.id,
        actor: params.actor.name,
        role: params.actor.role,
        orgId: params.actor.orgId,
        mode: dispatch.mode,
        createdAt: resvNow,
      };
      store.state.stockMovements.unshift(mov);

      const resv: StockReservation = {
        id: uuidv4(),
        requestId: dispatch.requestId,
        incidentId: dispatch.incidentId,
        warehouseId: stock.warehouseId,
        warehouseName: item.warehouseName,
        stockId: stock.id,
        sku: stock.sku,
        itemName: stock.itemName,
        category: stock.category,
        unit: stock.unit,
        requestedQty: item.quantity,
        reservedQty: item.quantity,
        status: 'Allocated',
        expiresAt: new Date(Date.now() + 24 * 3_600_000).toISOString(),
        orgId: params.actor.orgId,
        reservedBy: params.actor.name,
        notes: `Atomic reservation on approval of dispatch ${dispatch.id.slice(0, 8)}`,
        auditHistory: [
          {
            timestamp: resvNow,
            actor: params.actor.name,
            action: 'reservation.allocated',
            detail: `Reserved ${item.quantity} ${stock.unit} for dispatch ${dispatch.id.slice(0, 8)}`,
          },
        ],
        mode: dispatch.mode,
        createdAt: resvNow,
        updatedAt: resvNow,
      };
      store.state.stockReservations.unshift(resv);
      createdReservations.push(resv);

      eventBus.publish({
        event_type: 'inventory.stock_reserved',
        organization_id: params.actor.orgId,
        entity_id: stock.id,
        source: 'dispatch-approval',
        mode: dispatch.mode,
        payload: { stockId: stock.id, reservedQty: item.quantity, availableQty: stock.availableQty, dispatchId: dispatch.id },
      });
    }
    dispatch.reservationIds = createdReservations.map((r) => r.id);
    if (alloc) {
      alloc.status = 'reserved';
      alloc.approvedBy = alloc.approvedBy || params.actor.name;
      alloc.approvedAt = alloc.approvedAt || resvNow;
      alloc.reservationIds = [...(alloc.reservationIds || []), ...dispatch.reservationIds];
      alloc.updatedAt = resvNow;
    }
  }

  const now = new Date().toISOString();
  dispatch.status = 'APPROVED';
  dispatch.approvalStatus = 'approved';
  dispatch.approvedBy = params.actor.name;
  dispatch.approvedAt = now;
  dispatch.updatedAt = now;
  dispatch.events.push({
    id: uuidv4(),
    status: 'APPROVED',
    note: params.note || `Approved by ${params.actor.name} (${params.actor.role}) after inventory, vehicle & driver revalidation.`,
    actor: params.actor.name,
    timestamp: now,
  });

  vehicle.status = 'assigned';
  vehicle.assignedDispatchId = dispatch.id;
  vehicle.updatedAt = now;
  vehicle.history = vehicle.history || [];
  vehicle.history.unshift({
    id: uuidv4(),
    timestamp: now,
    actor: params.actor.name,
    action: 'vehicle.assigned_dispatch',
    previousStatus: 'available',
    newStatus: 'assigned',
    dispatchId: dispatch.id,
    note: `Assigned to approved dispatch ${dispatch.id.slice(0, 8)}`,
  });

  if (driver) {
    driver.status = 'Assigned';
    driver.assignedVehicleId = vehicle.id;
    driver.assignedDispatchId = dispatch.id;
    driver.updatedAt = now;
    driver.assignmentHistory.unshift({
      id: uuidv4(),
      timestamp: now,
      action: `Assigned to approved dispatch ${dispatch.id.slice(0, 8)}`,
      vehicleId: vehicle.id,
      dispatchId: dispatch.id,
      actor: params.actor.name,
    });
  }

  const reliefReq = store.state.reliefRequests.find((r) => r.id === dispatch.requestId);
  if (reliefReq && !['dispatched', 'delivered', 'closed'].includes(reliefReq.status)) {
    reliefReq.status = 'approved';
    reliefReq.updatedAt = now;
  }

  store.save();

  store.addAudit({
    actor: params.actor.name,
    role: params.actor.role,
    orgId: params.actor.orgId,
    action: 'dispatch.approved',
    entityType: 'dispatch',
    entityId: dispatch.id,
    summary: `Approved dispatch ${dispatch.id.slice(0, 8)} (${vehicle.callsign} -> ${dispatch.destinationName})`,
    mode: dispatch.mode,
  });

  eventBus.publish({
    event_type: 'dispatch.approved',
    organization_id: params.actor.orgId,
    entity_id: dispatch.id,
    source: 'dispatch-engine',
    mode: dispatch.mode,
    payload: { dispatch, reservations: createdReservations },
  });

  return { dispatch, reservations: createdReservations };
}

export function rejectDispatchWorkflow(params: {
  dispatchId: string;
  reason: string;
  actor: LogisticsActor;
}): Dispatch {
  const dispatch = store.state.dispatches.find((d) => d.id === params.dispatchId);
  if (!dispatch) throw new LogisticsError('Dispatch not found.', 404);
  if (dispatch.status !== 'PENDING_APPROVAL' && dispatch.status !== 'DRAFT') {
    throw new LogisticsError(`Only DRAFT or PENDING_APPROVAL dispatches can be rejected (current: '${dispatch.status}').`, 400);
  }
  const now = new Date().toISOString();
  dispatch.status = 'REJECTED';
  dispatch.approvalStatus = 'rejected';
  dispatch.rejectedBy = params.actor.name;
  dispatch.rejectionReason = params.reason.trim() || 'Rejected by commander';
  dispatch.updatedAt = now;
  dispatch.events.push({
    id: uuidv4(),
    status: 'REJECTED',
    note: `Rejected: ${dispatch.rejectionReason}`,
    actor: params.actor.name,
    timestamp: now,
  });
  store.save();

  store.addAudit({
    actor: params.actor.name,
    role: params.actor.role,
    orgId: params.actor.orgId,
    action: 'dispatch.rejected',
    entityType: 'dispatch',
    entityId: dispatch.id,
    summary: `Rejected dispatch ${dispatch.id.slice(0, 8)}: ${dispatch.rejectionReason}`,
    mode: dispatch.mode,
  });

  eventBus.publish({
    event_type: 'dispatch.status_changed',
    organization_id: params.actor.orgId,
    entity_id: dispatch.id,
    source: 'dispatch-engine',
    mode: dispatch.mode,
    payload: { dispatch },
  });

  return dispatch;
}

export function transitionDispatchStage(params: {
  dispatchId: string;
  action: 'load' | 'depart' | 'arrive' | 'delivering' | 'delay' | 'returning';
  note?: string;
  actor: LogisticsActor;
}): Dispatch {
  const dispatch = store.state.dispatches.find((d) => d.id === params.dispatchId);
  if (!dispatch) throw new LogisticsError('Dispatch not found.', 404);
  if (TERMINAL_DISPATCH_STATUSES.has(dispatch.status)) {
    throw new LogisticsError(`Dispatch is already in terminal state '${dispatch.status}'.`, 400);
  }

  const now = new Date().toISOString();
  const vehicle = store.state.vehicles.find((v) => v.id === dispatch.vehicleId);
  const alloc = store.state.allocations.find((a) => a.id === dispatch.allocationId);
  const reliefReq = store.state.reliefRequests.find((r) => r.id === dispatch.requestId);

  let nextStatus: DispatchStatus;
  let eventType = 'dispatch.status_changed';

  if (params.action === 'load') {
    if (!['APPROVED', 'vehicle_assigned'].includes(dispatch.status)) {
      throw new LogisticsError(
        `Cannot load dispatch in state '${dispatch.status}'. Dispatch must be APPROVED before loading.`,
        400
      );
    }
    // Verify stock is reserved before allowing loading
    const hasReservedStock =
      alloc?.status === 'reserved' ||
      alloc?.status === 'dispatched' ||
      (dispatch.reservationIds || []).some((rid) =>
        store.state.stockReservations.some((r) => r.id === rid && ['Reserved', 'Allocated'].includes(r.status))
      );
    if (!hasReservedStock) {
      throw new LogisticsError('Cannot load unreserved stock — reserve inventory via approval first.', 409);
    }
    nextStatus = 'LOADING';
    if (vehicle) vehicle.status = 'loading';
  } else if (params.action === 'depart') {
    if (!['LOADING', 'loading'].includes(dispatch.status)) {
      throw new LogisticsError(
        `Cannot depart from state '${dispatch.status}'. Vehicle must complete LOADING before departure.`,
        400
      );
    }
    nextStatus = 'EN_ROUTE';
    eventType = 'dispatch.departed';
    dispatch.actualDepartureAt = now;
    if (vehicle) vehicle.status = 'en_route';
    if (alloc) {
      alloc.status = 'dispatched';
      alloc.updatedAt = now;
    }
    if (reliefReq) {
      reliefReq.status = 'dispatched';
      reliefReq.updatedAt = now;
    }
    for (const rid of dispatch.reservationIds || []) {
      const resv = store.state.stockReservations.find((r) => r.id === rid);
      if (resv && ['Reserved', 'Allocated'].includes(resv.status)) {
        resv.status = 'Dispatched';
        resv.updatedAt = now;
        resv.auditHistory.push({
          timestamp: now,
          actor: params.actor.name,
          action: 'reservation.dispatched',
          detail: `Loaded and departed on dispatch ${dispatch.id.slice(0, 8)}`,
        });
      }
    }
  } else if (params.action === 'arrive') {
    if (!['DISPATCHED', 'EN_ROUTE', 'DELAYED', 'departed', 'in_transit'].includes(dispatch.status)) {
      throw new LogisticsError(
        `Cannot mark arrived from state '${dispatch.status}'. Dispatch must be DISPATCHED/EN_ROUTE first.`,
        400
      );
    }
    nextStatus = 'ARRIVED';
    eventType = 'dispatch.arrived';
    dispatch.actualArrivalAt = now;
    dispatch.currentEtaMin = 0;
    if (vehicle) vehicle.status = 'delivering';
  } else if (params.action === 'delivering') {
    if (!['ARRIVED', 'arrived'].includes(dispatch.status)) {
      throw new LogisticsError(`Cannot begin unloading from state '${dispatch.status}'.`, 400);
    }
    nextStatus = 'DELIVERING';
    if (vehicle) vehicle.status = 'delivering';
  } else if (params.action === 'delay') {
    if (!['DISPATCHED', 'EN_ROUTE', 'in_transit', 'departed'].includes(dispatch.status)) {
      throw new LogisticsError(`Cannot flag delay from state '${dispatch.status}'.`, 400);
    }
    nextStatus = 'DELAYED';
    eventType = 'dispatch.delayed';
    dispatch.etaStatus = 'DELAYED';
    if (vehicle) vehicle.status = 'delayed';
  } else {
    nextStatus = 'RETURNING';
    if (vehicle) vehicle.status = 'returning';
  }

  dispatch.status = nextStatus;
  dispatch.updatedAt = now;
  dispatch.events.push({
    id: uuidv4(),
    status: nextStatus,
    note: params.note || `Transitioned to ${nextStatus}`,
    actor: params.actor.name,
    timestamp: now,
  });

  if (vehicle) {
    vehicle.updatedAt = now;
    vehicle.history = vehicle.history || [];
    vehicle.history.unshift({
      id: uuidv4(),
      timestamp: now,
      actor: params.actor.name,
      action: `dispatch.${params.action}`,
      newStatus: vehicle.status,
      dispatchId: dispatch.id,
      note: params.note || `Dispatch ${dispatch.id.slice(0, 8)} -> ${nextStatus}`,
    });
  }

  store.save();

  store.addAudit({
    actor: params.actor.name,
    role: params.actor.role,
    orgId: params.actor.orgId,
    action: `dispatch.${params.action}`,
    entityType: 'dispatch',
    entityId: dispatch.id,
    summary: `Dispatch ${dispatch.id.slice(0, 8)} (${dispatch.vehicleCallsign}) -> ${nextStatus}`,
    mode: dispatch.mode,
  });

  eventBus.publish({
    event_type: eventType,
    organization_id: params.actor.orgId,
    entity_id: dispatch.id,
    source: 'dispatch-engine',
    mode: dispatch.mode,
    payload: { dispatch },
  });

  return dispatch;
}

export function cancelDispatchWorkflow(params: {
  dispatchId: string;
  reason: string;
  actor: LogisticsActor;
}): Dispatch {
  const dispatch = store.state.dispatches.find((d) => d.id === params.dispatchId);
  if (!dispatch) throw new LogisticsError('Dispatch not found.', 404);
  if (['DELIVERED', 'COMPLETED', 'PARTIALLY_DELIVERED', 'delivered'].includes(dispatch.status)) {
    throw new LogisticsError('Cannot cancel a dispatch that has already been delivered or completed.', 400);
  }
  if (dispatch.status === 'CANCELLED' || dispatch.status === 'cancelled') {
    throw new LogisticsError('Dispatch is already cancelled.', 400);
  }

  const now = new Date().toISOString();

  // Release any active stock reservations linked to this dispatch
  for (const rid of dispatch.reservationIds || []) {
    const resv = store.state.stockReservations.find((r) => r.id === rid);
    if (resv && ['Reserved', 'Allocated', 'Dispatched', 'Partially Reserved'].includes(resv.status)) {
      const stock = store.state.inventory.find((s) => s.id === resv.stockId);
      if (stock) {
        const restore = Math.min(stock.reservedQty, resv.reservedQty);
        const prevAvail = stock.availableQty;
        stock.reservedQty -= restore;
        stock.availableQty += restore;
        stock.version += 1;
        stock.updatedAt = now;
        store.state.stockMovements.unshift({
          id: uuidv4(),
          stockId: stock.id,
          warehouseId: stock.warehouseId,
          itemName: stock.itemName,
          type: 'release',
          quantity: restore,
          previousAvailable: prevAvail,
          newAvailable: stock.availableQty,
          reason: `Released on dispatch cancellation: ${params.reason}`,
          referenceId: dispatch.id,
          actor: params.actor.name,
          role: params.actor.role,
          orgId: params.actor.orgId,
          mode: dispatch.mode,
          createdAt: now,
        });
        eventBus.publish({
          event_type: 'inventory.stock_released',
          organization_id: params.actor.orgId,
          entity_id: stock.id,
          source: 'dispatch-cancel',
          mode: dispatch.mode,
          payload: { stockId: stock.id, releasedQty: restore, availableQty: stock.availableQty, dispatchId: dispatch.id },
        });
      }
      resv.status = 'Reservation Released';
      resv.updatedAt = now;
      resv.auditHistory.push({
        timestamp: now,
        actor: params.actor.name,
        action: 'reservation.released',
        detail: `Released ${resv.reservedQty} ${resv.unit} after dispatch cancellation (${params.reason})`,
      });
    }
  }

  // Free vehicle
  const vehicle = store.state.vehicles.find((v) => v.id === dispatch.vehicleId);
  if (vehicle && vehicle.assignedDispatchId === dispatch.id) {
    vehicle.status = 'available';
    vehicle.assignedDispatchId = null;
    vehicle.updatedAt = now;
    vehicle.history = vehicle.history || [];
    vehicle.history.unshift({
      id: uuidv4(),
      timestamp: now,
      actor: params.actor.name,
      action: 'vehicle.released_on_cancel',
      newStatus: 'available',
      dispatchId: dispatch.id,
      note: params.reason,
    });
  }

  // Free driver
  if (dispatch.driverId) {
    const driver = store.state.drivers.find((d) => d.id === dispatch.driverId);
    if (driver && driver.assignedDispatchId === dispatch.id) {
      driver.status = 'Available';
      driver.assignedDispatchId = null;
      driver.updatedAt = now;
    }
  }

  dispatch.status = 'CANCELLED';
  dispatch.updatedAt = now;
  dispatch.events.push({
    id: uuidv4(),
    status: 'CANCELLED',
    note: `Cancelled: ${params.reason}`,
    actor: params.actor.name,
    timestamp: now,
  });

  store.save();

  store.addAudit({
    actor: params.actor.name,
    role: params.actor.role,
    orgId: params.actor.orgId,
    action: 'dispatch.cancelled',
    entityType: 'dispatch',
    entityId: dispatch.id,
    summary: `Cancelled dispatch ${dispatch.id.slice(0, 8)} — reservations released & vehicle freed (${params.reason})`,
    mode: dispatch.mode,
  });

  eventBus.publish({
    event_type: 'dispatch.cancelled',
    organization_id: params.actor.orgId,
    entity_id: dispatch.id,
    source: 'dispatch-engine',
    mode: dispatch.mode,
    payload: { dispatch },
  });

  return dispatch;
}

export function recordDispatchGpsUpdate(params: {
  dispatchId: string;
  lat: number;
  lng: number;
  speedKmh?: number | null;
  gpsSource?: 'authorized_device' | 'simulated_demo';
  actor: LogisticsActor;
}): Dispatch {
  const dispatch = store.state.dispatches.find((d) => d.id === params.dispatchId);
  if (!dispatch) throw new LogisticsError('Dispatch not found.', 404);
  if (!validateCoordinates(params.lat, params.lng)) {
    throw new LogisticsError('Invalid GPS coordinates: latitude [-90,90], longitude [-180,180].', 400);
  }
  if (dispatch.mode === 'operational' && params.gpsSource === 'simulated_demo') {
    throw new LogisticsError('Simulated GPS updates are prohibited in Operational Mode.', 400);
  }

  const now = new Date().toISOString();
  const source = params.gpsSource === 'authorized_device' ? 'authorized_device' : 'simulated_demo';
  dispatch.currentLat = params.lat;
  dispatch.currentLng = params.lng;
  dispatch.lastLocationAt = now;
  dispatch.trackingStatus = source === 'authorized_device' ? 'LIVE_GPS' : 'SIMULATED_DEMO';
  dispatch.gpsLabel = source === 'authorized_device' ? 'AUTHORIZED DEVICE GPS' : 'SIMULATED DEMO TRACKING';
  dispatch.locationHistory = dispatch.locationHistory || [];
  dispatch.locationHistory.push({
    lat: params.lat,
    lng: params.lng,
    timestamp: now,
    source,
    speedKmh: params.speedKmh ?? null,
  });
  if (dispatch.locationHistory.length > 200) {
    dispatch.locationHistory = dispatch.locationHistory.slice(-200);
  }

  // Update remaining ETA honestly based on remaining distance & observed or nominal road speed
  const remainingKm = haversineKm(params.lat, params.lng, dispatch.destinationLat, dispatch.destinationLng);
  if (dispatch.route?.routeStatus !== 'ROUTE_UNAVAILABLE') {
    const speed = params.speedKmh && params.speedKmh > 5 ? params.speedKmh : 38;
    const nextEtaMin = remainingKm < 0.3 ? 0 : Math.max(1, Math.round((remainingKm * 1.2 / speed) * 60));
    const { etaStatus } = computeEtaFeasibility(nextEtaMin, dispatch.deliveryDeadline);
    dispatch.currentEtaMin = nextEtaMin;
    dispatch.etaStatus = etaStatus;
    dispatch.etaHistory = dispatch.etaHistory || [];
    dispatch.etaHistory.push({
      timestamp: now,
      etaMin: nextEtaMin,
      etaStatus,
      reason: `Updated from GPS telemetry (${remainingKm.toFixed(1)} km remaining)`,
    });
  }
  dispatch.updatedAt = now;

  const vehicle = store.state.vehicles.find((v) => v.id === dispatch.vehicleId);
  if (vehicle) {
    vehicle.lat = params.lat;
    vehicle.lng = params.lng;
    vehicle.lastLocationAt = now;
    vehicle.gpsSource = source;
    vehicle.updatedAt = now;
  }

  if (dispatch.driverId) {
    const driver = store.state.drivers.find((d) => d.id === dispatch.driverId);
    if (driver) {
      driver.lastKnownLat = params.lat;
      driver.lastKnownLng = params.lng;
      driver.lastLocationAt = now;
      driver.updatedAt = now;
    }
  }

  store.save();

  eventBus.publish({
    event_type: 'vehicle.location_updated',
    organization_id: params.actor.orgId,
    entity_id: dispatch.id,
    source: 'dispatch-telemetry',
    mode: dispatch.mode,
    payload: {
      dispatchId: dispatch.id,
      vehicleId: dispatch.vehicleId,
      lat: params.lat,
      lng: params.lng,
      trackingStatus: dispatch.trackingStatus,
      gpsLabel: dispatch.gpsLabel,
      currentEtaMin: dispatch.currentEtaMin,
    },
  });

  return dispatch;
}

export function getDispatchTrackingSnapshot(dispatchId: string) {
  const dispatch = store.state.dispatches.find((d) => d.id === dispatchId);
  if (!dispatch) throw new LogisticsError('Dispatch not found.', 404);

  let trackingStatus: TrackingStatus = dispatch.trackingStatus || 'UNAVAILABLE';
  let staleMinutes: number | null = null;

  if (dispatch.lastLocationAt) {
    staleMinutes = Math.round((Date.now() - new Date(dispatch.lastLocationAt).getTime()) / 60_000);
    if (trackingStatus === 'LIVE_GPS' && staleMinutes > 15) {
      trackingStatus = 'STALE';
    }
  } else {
    trackingStatus = 'UNAVAILABLE';
  }

  const remainingDistanceKm =
    dispatch.currentLat !== null && dispatch.currentLng !== null
      ? Math.round(haversineKm(dispatch.currentLat, dispatch.currentLng, dispatch.destinationLat, dispatch.destinationLng) * 100) / 100
      : null;

  return {
    dispatchId: dispatch.id,
    status: dispatch.status,
    vehicleId: dispatch.vehicleId,
    vehicleCallsign: dispatch.vehicleCallsign,
    trackingStatus,
    gpsLabel:
      trackingStatus === 'STALE'
        ? `STALE TELEMETRY (Last update ${staleMinutes}m ago)`
        : trackingStatus === 'UNAVAILABLE'
        ? 'LIVE GPS UNAVAILABLE — Last known coordinates not received'
        : dispatch.gpsLabel,
    currentLat: dispatch.currentLat,
    currentLng: dispatch.currentLng,
    remainingDistanceKm,
    lastLocationAt: dispatch.lastLocationAt || null,
    staleMinutes,
    initialEtaMin: dispatch.initialEtaMin ?? dispatch.route?.durationMin ?? null,
    currentEtaMin: dispatch.currentEtaMin ?? dispatch.route?.durationMin ?? null,
    etaStatus: dispatch.etaStatus || 'UNKNOWN',
    etaHistory: dispatch.etaHistory || [],
    locationHistory: dispatch.locationHistory || [],
  };
}

// ============================================================================
// 6. DELIVERY CONFIRMATION & TRANSACTIONAL INVENTORY RECONCILIATION
// ============================================================================

export function confirmDeliveryWorkflow(params: {
  dispatchId: string;
  recipientName: string;
  recipientOrg?: string;
  recipientRole?: string;
  notes?: string;
  proofRef?: string | null;
  items?: { stockId: string; deliveredQty: number; damagedQty?: number }[];
  allowOverDeliveryCorrection?: boolean;
  actor: LogisticsActor;
}): { delivery: DeliveryConfirmation; dispatch: Dispatch; movements: StockMovement[] } {
  const dispatch = store.state.dispatches.find((d) => d.id === params.dispatchId);
  if (!dispatch) throw new LogisticsError('Dispatch not found.', 404);

  if (dispatch.status === 'CANCELLED' || dispatch.status === 'cancelled' || dispatch.status === 'REJECTED') {
    throw new LogisticsError(`Cannot confirm delivery for a '${dispatch.status}' dispatch.`, 400);
  }
  if (dispatch.status === 'PENDING_APPROVAL' || dispatch.status === 'DRAFT') {
    throw new LogisticsError('Cannot confirm delivery for an unapproved dispatch.', 400);
  }
  if (!['ARRIVED', 'DELIVERING', 'arrived'].includes(dispatch.status)) {
    throw new LogisticsError(
      `Delivery confirmation requires dispatch to be ARRIVED or DELIVERING (current status: '${dispatch.status}').`,
      400
    );
  }

  const dispatchItems = dispatch.items && dispatch.items.length > 0
    ? dispatch.items
    : (store.state.allocations.find((a) => a.id === dispatch.allocationId)?.items || []).map((it) => ({
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
      }));

  // Validate quantities BEFORE any mutation (transactional all-or-nothing)
  const reconciledItems: DeliveryItemRecord[] = [];
  for (const dItem of dispatchItems) {
    const inputLine = params.items?.find((x) => x.stockId === dItem.stockId);
    const deliveredQty = inputLine ? inputLine.deliveredQty : dItem.quantity;
    const damagedQty = inputLine?.damagedQty ?? 0;

    if (deliveredQty < 0 || damagedQty < 0) {
      throw new LogisticsError('Delivered and damaged quantities cannot be negative.', 400);
    }
    if (deliveredQty > dItem.quantity && !params.allowOverDeliveryCorrection) {
      throw new LogisticsError(
        `Delivered quantity (${deliveredQty}) exceeds dispatched quantity (${dItem.quantity}) for ${dItem.itemName}. Submit a formal correction workflow to adjust.`,
        400
      );
    }
    if (deliveredQty + damagedQty > dItem.quantity && !params.allowOverDeliveryCorrection) {
      throw new LogisticsError(
        `Delivered (${deliveredQty}) + damaged (${damagedQty}) exceeds dispatched quantity (${dItem.quantity}) for ${dItem.itemName}.`,
        400
      );
    }

    const remainingQty = Math.max(0, dItem.quantity - deliveredQty - damagedQty);
    reconciledItems.push({
      stockId: dItem.stockId,
      sku: dItem.sku,
      itemName: dItem.itemName,
      category: dItem.category,
      dispatchedQty: dItem.quantity,
      deliveredQty,
      damagedQty,
      remainingQty,
      unit: dItem.unit,
    });
  }

  const totalDispatched = reconciledItems.reduce((s, i) => s + i.dispatchedQty, 0);
  const totalDelivered = reconciledItems.reduce((s, i) => s + i.deliveredQty, 0);
  const totalDamaged = reconciledItems.reduce((s, i) => s + i.damagedQty, 0);

  let deliveryStatus: DeliveryStatus;
  if (totalDelivered === 0 && totalDamaged === 0) {
    deliveryStatus = 'RETURNED';
  } else if (totalDelivered === 0) {
    deliveryStatus = 'FAILED';
  } else if (totalDelivered < totalDispatched) {
    deliveryStatus = 'PARTIALLY_DELIVERED';
  } else {
    deliveryStatus = 'DELIVERED';
  }

  const now = new Date().toISOString();
  const movements: StockMovement[] = [];
  const reliefReq = store.state.reliefRequests.find((r) => r.id === dispatch.requestId);
  const alloc = store.state.allocations.find((a) => a.id === dispatch.allocationId);

  // Transactional inventory ledger & reservation reconciliation
  for (const item of reconciledItems) {
    const stock = store.state.inventory.find((s) => s.id === item.stockId);
    if (stock) {
      const reservedPool = Math.min(stock.reservedQty, item.dispatchedQty);
      const deliveredDeduct = Math.min(reservedPool, item.deliveredQty);
      const damagedDeduct = Math.min(Math.max(0, reservedPool - deliveredDeduct), item.damagedQty);
      const returnQty = Math.max(0, reservedPool - deliveredDeduct - damagedDeduct);

      stock.reservedQty = Math.max(0, stock.reservedQty - reservedPool);
      stock.totalQty = Math.max(0, stock.totalQty - deliveredDeduct - damagedDeduct);
      stock.damagedQty += damagedDeduct;
      const prevAvail = stock.availableQty;
      stock.availableQty = Math.max(0, stock.availableQty + returnQty);
      stock.version += 1;
      stock.updatedAt = now;

      if (deliveredDeduct > 0) {
        const mov: StockMovement = {
          id: uuidv4(),
          stockId: stock.id,
          warehouseId: stock.warehouseId,
          itemName: stock.itemName,
          type: 'outbound',
          quantity: deliveredDeduct,
          previousAvailable: prevAvail,
          newAvailable: stock.availableQty,
          reason: `Confirmed delivery (${deliveryStatus}) for Dispatch ${dispatch.id.slice(0, 8)} to ${params.recipientName}`,
          referenceId: dispatch.id,
          actor: params.actor.name,
          role: params.actor.role,
          orgId: params.actor.orgId,
          mode: dispatch.mode,
          createdAt: now,
        };
        store.state.stockMovements.unshift(mov);
        movements.push(mov);
      }

      if (damagedDeduct > 0) {
        const mov: StockMovement = {
          id: uuidv4(),
          stockId: stock.id,
          warehouseId: stock.warehouseId,
          itemName: stock.itemName,
          type: 'damage',
          quantity: damagedDeduct,
          previousAvailable: stock.availableQty,
          newAvailable: stock.availableQty,
          reason: `Transit damage reported on Dispatch ${dispatch.id.slice(0, 8)}`,
          referenceId: dispatch.id,
          actor: params.actor.name,
          role: params.actor.role,
          orgId: params.actor.orgId,
          mode: dispatch.mode,
          createdAt: now,
        };
        store.state.stockMovements.unshift(mov);
        movements.push(mov);
      }

      if (returnQty > 0) {
        const mov: StockMovement = {
          id: uuidv4(),
          stockId: stock.id,
          warehouseId: stock.warehouseId,
          itemName: stock.itemName,
          type: 'return',
          quantity: returnQty,
          previousAvailable: prevAvail,
          newAvailable: stock.availableQty,
          reason: `Undelivered stock returned to warehouse from Dispatch ${dispatch.id.slice(0, 8)}`,
          referenceId: dispatch.id,
          actor: params.actor.name,
          role: params.actor.role,
          orgId: params.actor.orgId,
          mode: dispatch.mode,
          createdAt: now,
        };
        store.state.stockMovements.unshift(mov);
        movements.push(mov);
      }
    }

    // Update relief request item fulfillment
    if (reliefReq && item.deliveredQty > 0) {
      const reqLine = reliefReq.items.find((ri) => ri.category === item.category);
      if (reqLine) {
        reqLine.fulfilledQuantity = Math.min(reqLine.quantity, reqLine.fulfilledQuantity + item.deliveredQty);
      }
    }

    // Update dispatch item record
    const dLine = dispatch.items?.find((di) => di.stockId === item.stockId);
    if (dLine) {
      dLine.deliveredQty = item.deliveredQty;
      dLine.damagedQty = item.damagedQty;
    }
  }

  // Update reservations
  for (const rid of dispatch.reservationIds || []) {
    const resv = store.state.stockReservations.find((r) => r.id === rid);
    if (resv) {
      resv.status = deliveryStatus === 'RETURNED' ? 'Reservation Released' : 'Delivered';
      resv.updatedAt = now;
      resv.auditHistory.push({
        timestamp: now,
        actor: params.actor.name,
        action: 'delivery.reconciled',
        detail: `Reconciled as ${deliveryStatus} for dispatch ${dispatch.id.slice(0, 8)}`,
      });
    }
  }

  // Update relief request overall fulfillment status
  if (reliefReq) {
    const allFulfilled = reliefReq.items.every((ri) => ri.fulfilledQuantity >= ri.quantity);
    const anyFulfilled = reliefReq.items.some((ri) => ri.fulfilledQuantity > 0);
    reliefReq.fulfillmentStatus = allFulfilled
      ? 'fulfilled'
      : anyFulfilled
      ? 'partially_fulfilled'
      : 'unfulfilled';
    if (allFulfilled) {
      reliefReq.status = 'delivered';
    }
    reliefReq.updatedAt = now;
  }

  // Update allocation
  if (alloc) {
    alloc.status = deliveryStatus === 'DELIVERED' ? 'completed' : alloc.status;
    alloc.updatedAt = now;
  }

  const confirmation: DeliveryConfirmation = {
    id: uuidv4(),
    dispatchId: dispatch.id,
    requestId: dispatch.requestId,
    incidentId: dispatch.incidentId,
    allocationId: dispatch.allocationId,
    warehouseId: dispatch.warehouseId,
    items: reconciledItems,
    status: deliveryStatus,
    recipientName: params.recipientName.trim(),
    recipientOrg: params.recipientOrg?.trim() || 'Field Relief Reception Point',
    recipientRole: params.recipientRole?.trim(),
    notes: params.notes?.trim() || '',
    proofRef: params.proofRef || null,
    confirmedBy: params.actor.name,
    confirmedAt: now,
    verifiedBy: null,
    verifiedAt: null,
    discrepancyNotes:
      deliveryStatus === 'PARTIALLY_DELIVERED' || totalDamaged > 0
        ? `Delivered ${totalDelivered}/${totalDispatched} units (${totalDamaged} damaged, ${Math.max(0, totalDispatched - totalDelivered - totalDamaged)} returned).`
        : null,
    mode: dispatch.mode,
    createdAt: now,
    updatedAt: now,
  };

  store.state.deliveryConfirmations.unshift(confirmation);

  // Update dispatch terminal status
  dispatch.status =
    deliveryStatus === 'DELIVERED'
      ? 'COMPLETED'
      : deliveryStatus === 'PARTIALLY_DELIVERED'
      ? 'PARTIALLY_DELIVERED'
      : 'FAILED';
  dispatch.deliveredAt = now;
  dispatch.deliveryConfirmationId = confirmation.id;
  dispatch.currentLat = dispatch.destinationLat;
  dispatch.currentLng = dispatch.destinationLng;
  dispatch.currentEtaMin = 0;
  dispatch.updatedAt = now;
  dispatch.events.push({
    id: uuidv4(),
    status: dispatch.status,
    note: `Delivery confirmed (${deliveryStatus}) — received by ${confirmation.recipientName} (${totalDelivered}/${totalDispatched} units).`,
    actor: params.actor.name,
    timestamp: now,
  });

  // Free vehicle & driver back to available pool
  const vehicle = store.state.vehicles.find((v) => v.id === dispatch.vehicleId);
  if (vehicle) {
    vehicle.status = 'available';
    vehicle.assignedDispatchId = null;
    vehicle.updatedAt = now;
    vehicle.history = vehicle.history || [];
    vehicle.history.unshift({
      id: uuidv4(),
      timestamp: now,
      actor: params.actor.name,
      action: 'vehicle.completed_dispatch',
      newStatus: 'available',
      dispatchId: dispatch.id,
      note: `Completed delivery confirmation ${confirmation.id.slice(0, 8)}`,
    });
  }

  if (dispatch.driverId) {
    const driver = store.state.drivers.find((d) => d.id === dispatch.driverId);
    if (driver) {
      driver.status = 'Available';
      driver.assignedDispatchId = null;
      driver.updatedAt = now;
      driver.assignmentHistory.unshift({
        id: uuidv4(),
        timestamp: now,
        action: `Completed dispatch ${dispatch.id.slice(0, 8)} (${deliveryStatus})`,
        vehicleId: dispatch.vehicleId,
        dispatchId: dispatch.id,
        actor: params.actor.name,
      });
    }
  }

  store.save();

  store.addAudit({
    actor: params.actor.name,
    role: params.actor.role,
    orgId: params.actor.orgId,
    action: 'delivery.confirmed',
    entityType: 'delivery',
    entityId: confirmation.id,
    summary: `Confirmed ${deliveryStatus} for dispatch ${dispatch.id.slice(0, 8)}: ${totalDelivered}/${totalDispatched} units received by ${confirmation.recipientName}`,
    mode: dispatch.mode,
  });

  eventBus.publish({
    event_type: 'delivery.completed',
    organization_id: params.actor.orgId,
    entity_id: confirmation.id,
    source: 'delivery-engine',
    mode: dispatch.mode,
    payload: { delivery: confirmation, dispatch, movementsCount: movements.length },
  });

  eventBus.publish({
    event_type: 'inventory.updated',
    organization_id: params.actor.orgId,
    entity_id: dispatch.warehouseId,
    source: 'delivery-reconciliation',
    mode: dispatch.mode,
    payload: { warehouseId: dispatch.warehouseId, dispatchId: dispatch.id, movements },
  });

  return { delivery: confirmation, dispatch, movements };
}

export function verifyDeliveryConfirmation(deliveryId: string, notes: string | undefined, actor: LogisticsActor): DeliveryConfirmation {
  const delivery = store.state.deliveryConfirmations.find((c) => c.id === deliveryId);
  if (!delivery) throw new LogisticsError('Delivery confirmation not found.', 404);
  const now = new Date().toISOString();
  delivery.verifiedBy = actor.name;
  delivery.verifiedAt = now;
  if (notes) {
    delivery.notes = delivery.notes ? `${delivery.notes} | Verification: ${notes}` : `Verification: ${notes}`;
  }
  delivery.updatedAt = now;
  store.save();

  store.addAudit({
    actor: actor.name,
    role: actor.role,
    orgId: actor.orgId,
    action: 'delivery.verified',
    entityType: 'delivery',
    entityId: delivery.id,
    summary: `Verified delivery confirmation ${delivery.id.slice(0, 8)} for dispatch ${delivery.dispatchId.slice(0, 8)}`,
    mode: delivery.mode,
  });

  return delivery;
}

// ============================================================================
// 7. MULTI-INCIDENT COORDINATION & LOGISTICS ANALYTICS
// ============================================================================

export function computeLogisticsOverview(mode: DataMode) {
  const allocations = store.state.allocations.filter((a) => a.mode === mode);
  const vehicles = store.state.vehicles.filter((v) => v.mode === mode);
  const drivers = store.state.drivers.filter((d) => d.mode === mode);
  const dispatches = store.state.dispatches.filter((d) => d.mode === mode);
  const deliveries = store.state.deliveryConfirmations.filter((c) => c.mode === mode);
  const requests = store.state.reliefRequests.filter((r) => r.mode === mode);
  const warehouses = store.state.warehouses.filter((w) => w.mode === mode);
  const incidents = store.state.incidents.filter((i) => i.mode === mode);
  const hazards = store.state.routeHazards.filter((h) => h.mode === mode && h.active);

  const activeDispatches = dispatches.filter((d) => ACTIVE_DISPATCH_STATUSES.has(d.status));
  const pendingApprovalDispatches = dispatches.filter((d) => d.status === 'PENDING_APPROVAL' || d.status === 'DRAFT');
  const enRouteDispatches = dispatches.filter((d) => ['DISPATCHED', 'EN_ROUTE', 'departed', 'in_transit'].includes(d.status));
  const delayedDispatches = dispatches.filter((d) => d.status === 'DELAYED' || d.etaStatus === 'DELAYED');
  const completedDispatches = dispatches.filter((d) =>
    ['COMPLETED', 'DELIVERED', 'PARTIALLY_DELIVERED', 'delivered'].includes(d.status)
  );

  const availableVehicles = vehicles.filter((v) => v.status === 'available' && v.maintenanceStatus !== 'in_maintenance');
  const maintenanceVehicles = vehicles.filter((v) => v.status === 'maintenance' || v.maintenanceStatus === 'in_maintenance' || v.maintenanceStatus === 'out_of_service');
  const deployedVehicles = vehicles.filter((v) => !['available', 'maintenance', 'unavailable'].includes(v.status));

  const avgFulfillmentPct =
    allocations.length > 0
      ? Math.round(allocations.reduce((s, a) => s + (a.fulfillmentPct ?? (a.unmetItems.length === 0 ? 100 : 65)), 0) / allocations.length)
      : null;

  // Multi-incident conflict & bottleneck detection
  const competingWarehouses: { warehouseId: string; warehouseName: string; competingAllocations: number }[] = [];
  for (const wh of warehouses) {
    const activeAllocs = allocations.filter(
      (a) => ['proposed', 'approved', 'reserved'].includes(a.status) && a.items.some((i) => i.warehouseId === wh.id)
    );
    if (activeAllocs.length >= 2) {
      competingWarehouses.push({
        warehouseId: wh.id,
        warehouseName: wh.name,
        competingAllocations: activeAllocs.length,
      });
    }
  }

  const underutilizedWarehouses = warehouses
    .filter((w) => w.status === 'operational')
    .filter((w) => !dispatches.some((d) => d.warehouseId === w.id && ACTIVE_DISPATCH_STATUSES.has(d.status)))
    .filter((w) => store.state.inventory.some((inv) => inv.warehouseId === w.id && inv.mode === mode && inv.availableQty > 0))
    .map((w) => ({ warehouseId: w.id, warehouseName: w.name, region: w.region }));

  const unservedHighPriorityIncidents = incidents
    .filter((i) => ['high', 'critical'].includes(i.severity) && !['resolved', 'archived'].includes(i.status))
    .filter((i) => !dispatches.some((d) => d.incidentId === i.id && !['CANCELLED', 'REJECTED', 'cancelled'].includes(d.status)))
    .map((i) => ({ incidentId: i.id, title: i.title, severity: i.severity, riskScore: i.riskScore }));

  const fleetOverloaded = vehicles.length > 0 && availableVehicles.length === 0;

  return {
    mode,
    timestamp: new Date().toISOString(),
    allocationMetrics: {
      totalAllocations: allocations.length,
      proposedCount: allocations.filter((a) => a.status === 'proposed').length,
      approvedOrReservedCount: allocations.filter((a) => ['approved', 'reserved'].includes(a.status)).length,
      multiWarehouseSplitCount: allocations.filter((a) => a.splitAllocation).length,
      unmetDemandCount: allocations.filter((a) => a.unmetItems.length > 0).length,
      avgFulfillmentPct,
    },
    fleetMetrics: {
      totalVehicles: vehicles.length,
      availableVehicles: availableVehicles.length,
      deployedVehicles: deployedVehicles.length,
      maintenanceVehicles: maintenanceVehicles.length,
      utilizationPct: vehicles.length > 0 ? Math.round((deployedVehicles.length / vehicles.length) * 100) : null,
      totalDrivers: drivers.length,
      availableDrivers: drivers.filter((d) => d.status === 'Available').length,
      assignedDrivers: drivers.filter((d) => d.status === 'Assigned').length,
    },
    dispatchMetrics: {
      totalDispatches: dispatches.length,
      activeDispatches: activeDispatches.length,
      pendingApproval: pendingApprovalDispatches.length,
      enRoute: enRouteDispatches.length,
      delayed: delayedDispatches.length,
      completed: completedDispatches.length,
      cancelled: dispatches.filter((d) => d.status === 'CANCELLED' || d.status === 'cancelled').length,
      totalDeliveriesConfirmed: deliveries.length,
      activeRouteHazards: hazards.length,
    },
    coordination: {
      openRequestsCount: requests.filter((r) => !['delivered', 'closed'].includes(r.status)).length,
      competingWarehouses,
      underutilizedWarehouses,
      unservedHighPriorityIncidents,
      fleetOverloaded,
      delayedDispatchIds: delayedDispatches.map((d) => d.id),
    },
  };
}

export function computeDeliveryPerformance(mode: DataMode) {
  const deliveries = store.state.deliveryConfirmations.filter((c) => c.mode === mode);
  const dispatches = store.state.dispatches.filter((d) => d.mode === mode);

  const fullCount = deliveries.filter((c) => c.status === 'DELIVERED').length;
  const partialCount = deliveries.filter((c) => c.status === 'PARTIALLY_DELIVERED').length;
  const failedCount = deliveries.filter((c) => c.status === 'FAILED' || c.status === 'RETURNED').length;
  const verifiedDeliveries = deliveries.filter((c) => Boolean(c.verifiedBy)).length;
  const totalUnitsDelivered = deliveries.reduce(
    (sum, c) => sum + c.items.reduce((s, it) => s + it.deliveredQty, 0),
    0
  );
  const totalUnitsDamaged = deliveries.reduce(
    (sum, c) => sum + c.items.reduce((s, it) => s + it.damagedQty, 0),
    0
  );

  let onTimeCount = 0;
  let deadlineEvaluatedCount = 0;
  const durationsMin: number[] = [];

  for (const d of dispatches) {
    if (d.actualDepartureAt && d.deliveredAt) {
      const mins = Math.max(1, Math.round((new Date(d.deliveredAt).getTime() - new Date(d.actualDepartureAt).getTime()) / 60_000));
      durationsMin.push(mins);
    }
    if (d.deliveredAt && d.deliveryDeadline) {
      deadlineEvaluatedCount += 1;
      if (new Date(d.deliveredAt).getTime() <= new Date(d.deliveryDeadline).getTime()) {
        onTimeCount += 1;
      }
    }
  }

  return {
    mode,
    totalDeliveries: deliveries.length,
    fullDeliveries: fullCount,
    partialDeliveries: partialCount,
    failedOrReturned: failedCount,
    verifiedDeliveries,
    totalUnitsDelivered,
    totalUnitsDamaged,
    completionRatePct: deliveries.length > 0 ? Math.round((fullCount / deliveries.length) * 100) : null,
    onTimeRatePct: deadlineEvaluatedCount > 0 ? Math.round((onTimeCount / deadlineEvaluatedCount) * 100) : null,
    averageTransitDurationMin:
      durationsMin.length > 0 ? Math.round(durationsMin.reduce((a, b) => a + b, 0) / durationsMin.length) : null,
    timestamp: new Date().toISOString(),
  };
}
