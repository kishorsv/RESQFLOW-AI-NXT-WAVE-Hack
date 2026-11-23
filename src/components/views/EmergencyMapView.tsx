import React, { useEffect, useMemo, useState } from 'react';
import {
  AdvancedMarker,
  APIProvider,
  InfoWindow,
  Map as GoogleMap,
  useMap,
} from '@vis.gl/react-google-maps';
import {
  AlertTriangle,
  CloudRain,
  Filter,
  Layers,
  Navigation,
  RefreshCw,
  ShieldAlert,
  Truck,
  Warehouse as WarehouseIcon,
} from 'lucide-react';
import { apiRequest } from '../../lib/api';
import type {
  DataMode,
  Dispatch,
  Incident,
  InventoryStock,
  ReliefRequest,
  RouteHazardReport,
  Vehicle,
  Warehouse,
  WeatherObservation,
} from '../../shared/types';

interface EmergencyMapViewProps {
  mode: DataMode;
  incidents: Incident[];
  warehouses: Warehouse[];
  inventory?: InventoryStock[];
  reliefRequests: ReliefRequest[];
  dispatches: Dispatch[];
  vehicles?: Vehicle[];
  mapsQuotaExceeded: boolean;
  onNavigate?: (view: string) => void;
}

const GOOGLE_MAPS_API_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY || '';

function isValidCoord(lat: unknown, lng: unknown): boolean {
  return (
    typeof lat === 'number' &&
    typeof lng === 'number' &&
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180
  );
}

// Draws primary (risk-coded) and dashed alternative route polylines on the active Google Map instance
const RoutePolylinesOverlay: React.FC<{ dispatches: Dispatch[]; visible: boolean }> = ({
  dispatches,
  visible,
}) => {
  const map = useMap();

  useEffect(() => {
    const g = (window as any).google;
    if (!map || !visible || !g?.maps?.Polyline) return;
    const polylines: { setMap: (m: unknown) => void }[] = [];
    for (const d of dispatches) {
      if (d.route?.alternatives && d.route.alternatives.length > 1) {
        for (let idx = 1; idx < d.route.alternatives.length; idx++) {
          const alt = d.route.alternatives[idx];
          const altPath = (alt.geometry || []).filter((pt) => isValidCoord(pt.lat, pt.lng));
          if (altPath.length < 2) continue;
          const altPoly = new g.maps.Polyline({
            path: altPath,
            geodesic: true,
            strokeColor: '#94a3b8',
            strokeOpacity: 0,
            strokeWeight: 3,
            icons: [
              {
                icon: {
                  path: 'M 0,-1 0,1',
                  strokeOpacity: 0.75,
                  scale: 3,
                  strokeColor: '#94a3b8',
                },
                offset: '0',
                repeat: '14px',
              },
            ],
            map,
          });
          polylines.push(altPoly);
        }
      }

      if (d.route?.geometry && d.route.geometry.length >= 2) {
        const validPath = d.route.geometry.filter((pt) => isValidCoord(pt.lat, pt.lng));
        if (validPath.length < 2) continue;
        const riskBand = d.route.riskAssessment?.riskBand;
        const strokeColor =
          riskBand === 'BLOCKED'
            ? '#ef4444'
            : riskBand === 'HIGH'
            ? '#f97316'
            : riskBand === 'MODERATE'
            ? '#eab308'
            : '#06b6d4';
        const poly = new g.maps.Polyline({
          path: validPath,
          geodesic: true,
          strokeColor,
          strokeOpacity: 0.92,
          strokeWeight: 4,
          map,
        });
        polylines.push(poly);
      }
    }
    return () => {
      for (const p of polylines) p.setMap(null);
    };
  }, [map, dispatches, visible]);

  return null;
};

type SelectedMarker =
  | { kind: 'incident'; item: Incident }
  | { kind: 'warehouse'; item: Warehouse }
  | { kind: 'request'; item: ReliefRequest }
  | { kind: 'dispatch'; item: Dispatch }
  | { kind: 'hazard'; item: RouteHazardReport }
  | { kind: 'vehicle'; item: Vehicle }
  | null;

export const EmergencyMapView: React.FC<EmergencyMapViewProps> = ({
  mode,
  incidents,
  warehouses,
  inventory = [],
  reliefRequests,
  dispatches,
  vehicles = [],
  mapsQuotaExceeded,
  onNavigate,
}) => {
  const [layers, setLayers] = useState({
    incidents: true,
    warehouses: true,
    requests: true,
    dispatches: true,
    routes: true,
    hazards: true,
    vehicles: true,
  });
  const [hazards, setHazards] = useState<RouteHazardReport[]>([]);

  // Phase 3 Multi-Facet Map Filters + Phase 4 Inventory Resource Layer Filter
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [severityFilter, setSeverityFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [verificationFilter, setVerificationFilter] = useState<string>('all');
  const [riskBandFilter, setRiskBandFilter] = useState<string>('all');
  const [dateWindow, setDateWindow] = useState<'all' | '24h' | '7d'>('all');
  const [resourceFilter, setResourceFilter] = useState<string>('all');

  const [selected, setSelected] = useState<SelectedMarker>(null);
  const [weather, setWeather] = useState<WeatherObservation | null>(null);
  const [loadingWeather, setLoadingWeather] = useState(false);

  const incidentTypesPresent = useMemo(
    () => Array.from(new Set(incidents.map((i) => i.type))).sort(),
    [incidents]
  );

  const filteredIncidents = useMemo(() => {
    const nowMs = Date.now();
    return incidents.filter((inc) => {
      if (!isValidCoord(inc.lat, inc.lng)) return false;
      if (typeFilter !== 'all' && inc.type !== typeFilter) return false;
      if (severityFilter !== 'all' && inc.severity !== severityFilter) return false;
      if (statusFilter !== 'all' && inc.status !== statusFilter) return false;
      if (verificationFilter !== 'all' && inc.verificationStatus !== verificationFilter) return false;
      if (riskBandFilter !== 'all') {
        const band = (inc.riskBand || 'Unscored').toLowerCase();
        if (band !== riskBandFilter.toLowerCase()) return false;
      }
      if (dateWindow !== 'all') {
        const reportedMs = new Date(inc.reportedAt).getTime();
        const maxAgeMs = dateWindow === '24h' ? 24 * 3600 * 1000 : 7 * 24 * 3600 * 1000;
        if (!Number.isNaN(reportedMs) && nowMs - reportedMs > maxAgeMs) return false;
      }
      return true;
    });
  }, [incidents, typeFilter, severityFilter, statusFilter, verificationFilter, riskBandFilter, dateWindow]);

  const invalidCoordCount = useMemo(
    () => incidents.filter((i) => !isValidCoord(i.lat, i.lng)).length,
    [incidents]
  );

  const validWarehouses = useMemo(() => {
    return warehouses.filter((w) => {
      if (!isValidCoord(w.lat, w.lng)) return false;
      if (resourceFilter !== 'all') {
        const hasStock = inventory.some(
          (i) => i.warehouseId === w.id && i.category === resourceFilter && i.availableQty > 0
        );
        if (!hasStock) return false;
      }
      return true;
    });
  }, [warehouses, inventory, resourceFilter]);

  const warehouseInventoryMeta = useMemo(() => {
    const map = new Map<string, { items: InventoryStock[]; criticalCount: number; lowCount: number; totalAvailable: number }>();
    for (const w of warehouses) {
      const items = inventory.filter((i) => i.warehouseId === w.id);
      const criticalCount = items.filter((i) => i.stockStatus === 'CRITICAL' || i.stockStatus === 'OUT_OF_STOCK').length;
      const lowCount = items.filter((i) => i.stockStatus === 'LOW').length;
      const totalAvailable = items.reduce((s, i) => s + i.availableQty, 0);
      map.set(w.id, { items, criticalCount, lowCount, totalAvailable });
    }
    return map;
  }, [warehouses, inventory]);

  const validRequests = useMemo(
    () => reliefRequests.filter((r) => isValidCoord(r.lat, r.lng)),
    [reliefRequests]
  );

  const validDispatches = useMemo(
    () => dispatches.filter((d) => isValidCoord(d.currentLat, d.currentLng)),
    [dispatches]
  );

  const validHazards = useMemo(
    () => hazards.filter((h) => h.active && isValidCoord(h.lat, h.lng)),
    [hazards]
  );

  const validVehicles = useMemo(
    () => vehicles.filter((v) => isValidCoord(v.lat, v.lng)),
    [vehicles]
  );

  const defaultCenter = useMemo(() => {
    if (filteredIncidents[0]) return { lat: filteredIncidents[0].lat, lng: filteredIncidents[0].lng };
    if (validWarehouses[0]) return { lat: validWarehouses[0].lat, lng: validWarehouses[0].lng };
    return { lat: 12.9784, lng: 80.2186 };
  }, [filteredIncidents, validWarehouses]);

  const queryWeatherAt = async (lat: number, lng: number, label: string, forceRefresh = false) => {
    if (!isValidCoord(lat, lng)) return;
    setLoadingWeather(true);
    try {
      const res = await apiRequest<{ observation: WeatherObservation }>(
        `/weather/current?lat=${lat}&lng=${lng}&locationName=${encodeURIComponent(label)}&forceRefresh=${forceRefresh}`
      );
      setWeather(res.observation);
    } catch {
      // handled gracefully
    } finally {
      setLoadingWeather(false);
    }
  };

  useEffect(() => {
    queryWeatherAt(defaultCenter.lat, defaultCenter.lng, filteredIncidents[0]?.region || 'Operations Sector');
  }, [mode]);

  useEffect(() => {
    let active = true;
    apiRequest<{ hazards: RouteHazardReport[] }>(`/routes/hazards?mode=${mode}`)
      .then((res) => {
        if (active) setHazards(res.hazards || []);
      })
      .catch(() => {
        if (active) setHazards([]);
      });
    return () => {
      active = false;
    };
  }, [mode, dispatches]);

  const canRenderGoogleMap = Boolean(GOOGLE_MAPS_API_KEY) && !mapsQuotaExceeded;

  return (
    <div className="space-y-4">
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-900 dark:text-white">
            Live Emergency Map &amp; Geospatial Operations
          </h1>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Google Maps Platform tactical view · Phase 5 route risk polylines, road hazards, fleet positions &amp; Open-Meteo telemetry
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {(
            [
              ['incidents', 'Incidents', filteredIncidents.length],
              ['warehouses', 'Warehouses', validWarehouses.length],
              ['requests', 'Relief Requests', validRequests.length],
              ['dispatches', 'Dispatches', validDispatches.length],
              ['vehicles', 'Fleet', validVehicles.length],
              ['hazards', 'Road Hazards', validHazards.length],
              ['routes', 'Route Polylines', dispatches.filter((d) => d.route).length],
            ] as const
          ).map(([key, label, count]) => (
            <button
              key={key}
              type="button"
              onClick={() => setLayers((prev) => ({ ...prev, [key]: !prev[key] }))}
              className={`px-3 py-1.5 rounded-[10px] border text-xs font-medium transition-colors tabular-nums whitespace-nowrap ${
                layers[key]
                  ? 'border-[#5869E8]/50 dark:border-[#6D7CFF]/55 bg-[#5869E8]/10 dark:bg-[#6D7CFF]/16 text-[#5869E8] dark:text-[#A5B0FF]'
                  : 'border-[var(--rf-border-default)] bg-[var(--rf-surface-elevated)] text-[var(--rf-text-muted)] hover:text-[var(--rf-text-primary)]'
              }`}
            >
              {label} ({count})
            </button>
          ))}
        </div>
      </div>

      {/* Phase 3 Geospatial Filter Bar */}
      <div className="rf-card p-3.5 flex flex-wrap items-center gap-2.5 text-xs">
        <div className="flex items-center gap-1.5 text-[var(--rf-text-muted)] font-medium mr-1">
          <Filter className="w-3.5 h-3.5 text-[#5869E8] dark:text-[#35C8F5]" />
          Incident Filters:
        </div>
        <select
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
          className="px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-slate-800 dark:text-slate-200"
        >
          <option value="all">All Hazard Types</option>
          {incidentTypesPresent.map((t) => (
            <option key={t} value={t}>
              {t.replace(/_/g, ' ')}
            </option>
          ))}
        </select>
        <select
          value={severityFilter}
          onChange={(e) => setSeverityFilter(e.target.value)}
          className="px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-slate-800 dark:text-slate-200"
        >
          <option value="all">All Severities</option>
          {['critical', 'high', 'medium', 'low'].map((s) => (
            <option key={s} value={s}>
              Severity: {s.toUpperCase()}
            </option>
          ))}
        </select>
        <select
          value={riskBandFilter}
          onChange={(e) => setRiskBandFilter(e.target.value)}
          className="px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-slate-800 dark:text-slate-200"
        >
          <option value="all">All Risk Bands</option>
          {['Critical', 'High', 'Elevated', 'Guarded', 'Low', 'Unscored'].map((b) => (
            <option key={b} value={b}>
              Risk: {b}
            </option>
          ))}
        </select>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-slate-800 dark:text-slate-200"
        >
          <option value="all">All Statuses</option>
          {['reported', 'under_review', 'verified', 'active', 'escalated', 'contained', 'resolved', 'archived'].map((st) => (
            <option key={st} value={st}>
              {st.replace(/_/g, ' ')}
            </option>
          ))}
        </select>
        <select
          value={verificationFilter}
          onChange={(e) => setVerificationFilter(e.target.value)}
          className="px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-slate-800 dark:text-slate-200"
        >
          <option value="all">All Verification</option>
          {['verified', 'unverified', 'pending', 'rejected'].map((v) => (
            <option key={v} value={v}>
              {v.toUpperCase()}
            </option>
          ))}
        </select>
        <select
          value={dateWindow}
          onChange={(e) => setDateWindow(e.target.value as 'all' | '24h' | '7d')}
          className="px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-slate-800 dark:text-slate-200"
        >
          <option value="all">All Time</option>
          <option value="24h">Last 24 Hours</option>
          <option value="7d">Last 7 Days</option>
        </select>
        <select
          value={resourceFilter}
          onChange={(e) => setResourceFilter(e.target.value)}
          className="px-2.5 py-1.5 rounded-lg border border-emerald-500/40 bg-emerald-500/5 text-slate-800 dark:text-slate-200"
          title="Filter warehouses carrying available stock of this resource"
        >
          <option value="all">Warehouse Resource: All</option>
          <option value="drinking_water">Has Water &amp; Hydration</option>
          <option value="food">Has Food &amp; Nutrition</option>
          <option value="medical_kits">Has Medical Kits</option>
          <option value="shelter">Has Shelter &amp; Tents</option>
          <option value="hygiene_kits">Has Purification &amp; Hygiene</option>
          <option value="power_equipment">Has Power Generators</option>
          <option value="rescue_equipment">Has Rescue Gear</option>
        </select>
        {(typeFilter !== 'all' ||
          severityFilter !== 'all' ||
          statusFilter !== 'all' ||
          verificationFilter !== 'all' ||
          riskBandFilter !== 'all' ||
          dateWindow !== 'all' ||
          resourceFilter !== 'all') && (
          <button
            type="button"
            onClick={() => {
              setTypeFilter('all');
              setSeverityFilter('all');
              setStatusFilter('all');
              setVerificationFilter('all');
              setRiskBandFilter('all');
              setDateWindow('all');
              setResourceFilter('all');
            }}
            className="px-2.5 py-1.5 rounded-lg border border-cyan-500/40 text-cyan-600 dark:text-cyan-400 hover:bg-cyan-500/10"
          >
            Reset Filters
          </button>
        )}
        {invalidCoordCount > 0 && (
          <span className="ml-auto text-amber-600 dark:text-amber-400 font-mono text-[11px] flex items-center gap-1">
            <AlertTriangle className="w-3.5 h-3.5" />
            {invalidCoordCount} incident(s) excluded (invalid coordinates)
          </span>
        )}
      </div>

      <div className="grid lg:grid-cols-4 gap-5">
        {/* Main Map Canvas */}
        <div className="lg:col-span-3 rounded-2xl border border-[var(--rf-border-strong)] overflow-hidden bg-[#080D18] min-h-[560px] relative shadow-[var(--rf-shadow-card)]">
          {canRenderGoogleMap ? (
            <APIProvider apiKey={GOOGLE_MAPS_API_KEY}>
              <GoogleMap
                style={{ width: '100%', height: '540px' }}
                defaultCenter={defaultCenter}
                defaultZoom={10}
                mapId="DEMO_MAP_ID"
                gestureHandling="greedy"
                internalUsageAttributionIds={['gmp_mcp_codeassist_v1_aistudio']}
              >
                <RoutePolylinesOverlay dispatches={dispatches} visible={layers.routes} />

                {layers.incidents &&
                  filteredIncidents.map((inc) => (
                    <AdvancedMarker
                      key={inc.id}
                      position={{ lat: inc.lat, lng: inc.lng }}
                      title={inc.title}
                      onClick={() => {
                        setSelected({ kind: 'incident', item: inc });
                        queryWeatherAt(inc.lat, inc.lng, inc.address);
                      }}
                    >
                      <div
                        className={`w-7 h-7 rounded-full border-2 border-white shadow-lg flex items-center justify-center text-white ${
                          inc.riskBand === 'Critical' || inc.severity === 'critical'
                            ? 'bg-red-600'
                            : inc.riskBand === 'High' || inc.severity === 'high'
                            ? 'bg-orange-500'
                            : inc.riskBand === 'Elevated' || inc.severity === 'medium'
                            ? 'bg-amber-500'
                            : 'bg-cyan-600'
                        }`}
                      >
                        <ShieldAlert className="w-3.5 h-3.5" />
                      </div>
                    </AdvancedMarker>
                  ))}

                {layers.warehouses &&
                  validWarehouses.map((wh) => {
                    const meta = warehouseInventoryMeta.get(wh.id);
                    const markerBg =
                      wh.status === 'closed' || wh.status === 'temporarily_unavailable' || (meta?.criticalCount ?? 0) > 0
                        ? 'bg-red-600'
                        : wh.status === 'limited' || (meta?.lowCount ?? 0) > 0
                        ? 'bg-amber-600'
                        : 'bg-emerald-600';
                    return (
                      <AdvancedMarker
                        key={wh.id}
                        position={{ lat: wh.lat, lng: wh.lng }}
                        title={wh.name}
                        onClick={() => setSelected({ kind: 'warehouse', item: wh })}
                      >
                        <div
                          className={`w-7 h-7 rounded-md border-2 border-white shadow-lg ${markerBg} text-white flex items-center justify-center`}
                        >
                          <WarehouseIcon className="w-3.5 h-3.5" />
                        </div>
                      </AdvancedMarker>
                    );
                  })}

                {layers.requests &&
                  validRequests.map((req) => (
                    <AdvancedMarker
                      key={req.id}
                      position={{ lat: req.lat, lng: req.lng }}
                      title={req.locationName}
                      onClick={() => setSelected({ kind: 'request', item: req })}
                    >
                      <div className="w-6 h-6 rounded-full border-2 border-white shadow-md bg-violet-600 text-white flex items-center justify-center text-[10px] font-bold">
                        R
                      </div>
                    </AdvancedMarker>
                  ))}

                {layers.dispatches &&
                  validDispatches.map((dsp) => (
                    <AdvancedMarker
                      key={dsp.id}
                      position={{ lat: dsp.currentLat!, lng: dsp.currentLng! }}
                      title={dsp.vehicleCallsign}
                      onClick={() => setSelected({ kind: 'dispatch', item: dsp })}
                    >
                      <div className="w-7 h-7 rounded-full border-2 border-white shadow-lg bg-cyan-600 text-white flex items-center justify-center">
                        <Truck className="w-3.5 h-3.5" />
                      </div>
                    </AdvancedMarker>
                  ))}

                {layers.vehicles &&
                  validVehicles.map((veh) => (
                    <AdvancedMarker
                      key={veh.id}
                      position={{ lat: veh.lat!, lng: veh.lng! }}
                      title={`${veh.callsign} (${veh.status})`}
                      onClick={() => setSelected({ kind: 'vehicle', item: veh })}
                    >
                      <div
                        className={`w-6 h-6 rounded-md border-2 border-white shadow-md text-white flex items-center justify-center ${
                          veh.status === 'maintenance' || veh.status === 'unavailable'
                            ? 'bg-slate-600'
                            : veh.status === 'available'
                            ? 'bg-sky-600'
                            : 'bg-indigo-600'
                        }`}
                      >
                        <Truck className="w-3 h-3" />
                      </div>
                    </AdvancedMarker>
                  ))}

                {layers.hazards &&
                  validHazards.map((hz) => (
                    <AdvancedMarker
                      key={hz.id}
                      position={{ lat: hz.lat, lng: hz.lng }}
                      title={`${hz.type.replace(/_/g, ' ')} — ${hz.description}`}
                      onClick={() => setSelected({ kind: 'hazard', item: hz })}
                    >
                      <div
                        className={`w-7 h-7 rounded-full border-2 border-white shadow-lg text-white flex items-center justify-center ${
                          hz.type === 'closure' || hz.severity === 'critical'
                            ? 'bg-red-700'
                            : 'bg-amber-600'
                        }`}
                      >
                        <AlertTriangle className="w-3.5 h-3.5" />
                      </div>
                    </AdvancedMarker>
                  ))}

                {selected && (
                  <InfoWindow
                    position={
                      selected.kind === 'dispatch'
                        ? {
                            lat: selected.item.currentLat ?? selected.item.destinationLat,
                            lng: selected.item.currentLng ?? selected.item.destinationLng,
                          }
                        : selected.kind === 'vehicle'
                        ? {
                            lat: selected.item.lat ?? defaultCenter.lat,
                            lng: selected.item.lng ?? defaultCenter.lng,
                          }
                        : { lat: selected.item.lat, lng: selected.item.lng }
                    }
                    onCloseClick={() => setSelected(null)}
                  >
                    <div className="text-slate-900 max-w-xs space-y-1 p-1">
                      <div className="text-[11px] font-mono uppercase text-cyan-700">
                        {selected.kind === 'hazard'
                          ? 'road hazard'
                          : selected.kind === 'vehicle'
                          ? 'fleet vehicle'
                          : selected.kind}
                      </div>
                      <div className="text-sm font-semibold">
                        {selected.kind === 'incident'
                          ? selected.item.title
                          : selected.kind === 'warehouse'
                          ? selected.item.name
                          : selected.kind === 'request'
                          ? selected.item.locationName
                          : selected.kind === 'hazard'
                          ? `${selected.item.type.replace(/_/g, ' ').toUpperCase()} (${selected.item.severity})`
                          : selected.kind === 'vehicle'
                          ? selected.item.callsign
                          : selected.item.vehicleCallsign}
                      </div>
                      <div className="text-xs text-slate-600 space-y-0.5">
                        {selected.kind === 'incident' && (
                          <>
                            <div>
                              {selected.item.severity.toUpperCase()} (L{selected.item.severityLevel ?? 3}) ·{' '}
                              {selected.item.status.toUpperCase()} · {selected.item.verificationStatus.toUpperCase()}
                            </div>
                            <div>
                              Risk: {selected.item.riskScore !== null ? `${selected.item.riskScore}/100` : 'Unscored'}
                              {selected.item.riskBand ? ` (${selected.item.riskBand})` : ''} ·{' '}
                              {selected.item.peopleAffected.toLocaleString()} affected
                            </div>
                          </>
                        )}
                        {selected.kind === 'warehouse' &&
                          `${selected.item.status.toUpperCase()} · ${selected.item.region}`}
                        {selected.kind === 'request' &&
                          `Priority ${selected.item.priorityScore}/100 (${selected.item.priorityCategory}) · ${selected.item.status}`}
                        {selected.kind === 'dispatch' && (
                          <>
                            <div>
                              {selected.item.status} · Tracking: {selected.item.trackingStatus || selected.item.gpsLabel}
                            </div>
                            {selected.item.route?.riskAssessment && (
                              <div>
                                Route Risk: {selected.item.route.riskAssessment.riskBand} —{' '}
                                {selected.item.route.riskAssessment.safetyNotice}
                              </div>
                            )}
                          </>
                        )}
                        {selected.kind === 'vehicle' && (
                          <>
                            <div>
                              {selected.item.vehicleType.replace(/_/g, ' ')} · Status: {selected.item.status}
                            </div>
                            <div>
                              GPS Source:{' '}
                              {selected.item.gpsSource === 'authorized_device'
                                ? 'Authorized Device Telemetry'
                                : selected.item.gpsSource === 'simulated_demo'
                                ? 'DEMO SIMULATION (Not Live GPS)'
                                : selected.item.gpsSource === 'last_known'
                                ? 'Last Known Position (Not Live)'
                                : 'GPS Unavailable'}
                            </div>
                          </>
                        )}
                        {selected.kind === 'hazard' && (
                          <>
                            <div>{selected.item.description}</div>
                            <div>
                              Radius: {selected.item.radiusKm} km · Source: {selected.item.source} ·{' '}
                              {selected.item.verified ? 'Verified' : 'Unverified'}
                            </div>
                          </>
                        )}
                      </div>
                    </div>
                  </InfoWindow>
                )}
              </GoogleMap>
            </APIProvider>
          ) : (
            <div className="h-[540px] flex flex-col items-center justify-center p-8 text-center space-y-3 text-slate-300">
              <Layers className="w-10 h-10 text-amber-400" />
              <div className="text-base font-semibold text-white">
                {mapsQuotaExceeded
                  ? 'Google Maps Demo Quota Exceeded — Tactical Coordinate View Active'
                  : 'Google Maps API Key Not Active — Coordinate List Mode'}
              </div>
              <p className="text-xs text-slate-400 max-w-md">
                Use the right-hand Tactical Inspector to review filtered coordinates, live Open-Meteo weather telemetry, and route status.
              </p>
            </div>
          )}
        </div>

        {/* Right Side Inspector & Weather Telemetry */}
        <div className="space-y-4">
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/80 p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-white">
                <CloudRain className="w-4 h-4 text-cyan-500" />
                Live Sector Weather
              </div>
              <button
                type="button"
                onClick={() => queryWeatherAt(defaultCenter.lat, defaultCenter.lng, 'Operations Sector', true)}
                disabled={loadingWeather}
                className="text-slate-400 hover:text-cyan-500"
                title="Force refresh Open-Meteo telemetry"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${loadingWeather ? 'animate-spin' : ''}`} />
              </button>
            </div>
            {weather ? (
              <div className="space-y-2 text-xs">
                <div className="font-medium text-slate-800 dark:text-slate-100">{weather.locationName}</div>
                {weather.unavailableNotice && (
                  <div className="p-2 rounded-lg border border-amber-500/40 bg-amber-500/10 text-[11px] text-amber-700 dark:text-amber-300">
                    {weather.unavailableNotice}
                  </div>
                )}
                <div className="grid grid-cols-2 gap-2 tabular-nums">
                  <div className="p-2 rounded-lg bg-slate-50 dark:bg-slate-950/60 border border-slate-200 dark:border-slate-800">
                    <div className="text-slate-500">Temp</div>
                    <div className="text-sm font-semibold text-slate-900 dark:text-white">
                      {weather.temperatureC !== null ? `${weather.temperatureC}°C` : 'N/A'}
                    </div>
                  </div>
                  <div className="p-2 rounded-lg bg-slate-50 dark:bg-slate-950/60 border border-slate-200 dark:border-slate-800">
                    <div className="text-slate-500">Rainfall</div>
                    <div className="text-sm font-semibold text-slate-900 dark:text-white">
                      {weather.rainfallMm !== null ? `${weather.rainfallMm} mm` : 'N/A'}
                    </div>
                  </div>
                  <div className="p-2 rounded-lg bg-slate-50 dark:bg-slate-950/60 border border-slate-200 dark:border-slate-800">
                    <div className="text-slate-500">Wind</div>
                    <div className="text-sm font-semibold text-slate-900 dark:text-white">
                      {weather.windSpeedKmh !== null ? `${weather.windSpeedKmh} km/h` : 'N/A'}
                    </div>
                  </div>
                  <div className="p-2 rounded-lg bg-slate-50 dark:bg-slate-950/60 border border-slate-200 dark:border-slate-800">
                    <div className="text-slate-500">Freshness</div>
                    <div
                      className={`text-sm font-semibold uppercase ${
                        (weather.freshnessCode || 'FRESH') === 'FRESH'
                          ? 'text-emerald-600 dark:text-emerald-400'
                          : 'text-amber-600 dark:text-amber-400'
                      }`}
                    >
                      {weather.freshnessCode || weather.freshnessStatus}
                    </div>
                  </div>
                </div>
                <div className="text-[11px] text-slate-500 dark:text-slate-400">
                  {weather.provider} · {weather.condition}
                  {typeof weather.cacheAgeSeconds === 'number' ? ` · Age ${weather.cacheAgeSeconds}s` : ''}
                </div>
              </div>
            ) : (
              <div className="text-xs text-slate-500">Fetching Open-Meteo telemetry...</div>
            )}
          </div>

          {/* Phase 4 Selected Warehouse Stock & Supply Inspector */}
          {selected?.kind === 'warehouse' && (
            <div className="rounded-xl border border-emerald-500/40 bg-white dark:bg-slate-900/90 p-4 space-y-2.5 text-xs">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="font-mono text-[10px] uppercase text-emerald-600 dark:text-emerald-400">
                    Warehouse Inventory Layer
                  </div>
                  <div className="text-sm font-semibold text-slate-900 dark:text-white">{selected.item.name}</div>
                  <div className="text-[11px] text-slate-500">
                    {selected.item.status.replace(/_/g, ' ').toUpperCase()} · {selected.item.district || selected.item.region}
                  </div>
                </div>
                {onNavigate && (
                  <button
                    type="button"
                    onClick={() => onNavigate('inventory')}
                    className="text-[11px] text-cyan-600 dark:text-cyan-400 hover:underline shrink-0"
                  >
                    Manage Stock
                  </button>
                )}
              </div>
              <div className="space-y-1 max-h-40 overflow-y-auto tabular-nums">
                {(warehouseInventoryMeta.get(selected.item.id)?.items || []).length === 0 ? (
                  <div className="text-slate-500">No inventory stock currently assigned to this warehouse.</div>
                ) : (
                  (warehouseInventoryMeta.get(selected.item.id)?.items || []).map((st) => (
                    <div
                      key={st.id}
                      className="flex items-center justify-between py-1 border-b border-slate-100 dark:border-slate-800"
                    >
                      <span className="truncate pr-2 text-slate-700 dark:text-slate-200">{st.itemName}</span>
                      <span
                        className={`font-mono shrink-0 ${
                          st.stockStatus === 'OUT_OF_STOCK' || st.stockStatus === 'CRITICAL'
                            ? 'text-red-500 font-semibold'
                            : st.stockStatus === 'LOW'
                            ? 'text-amber-500'
                            : 'text-emerald-600 dark:text-emerald-400'
                        }`}
                      >
                        {st.availableQty.toLocaleString()} {st.unit}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}

          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/80 p-4 space-y-2.5 max-h-[310px] overflow-y-auto">
            <div className="text-sm font-semibold text-slate-900 dark:text-white flex items-center gap-2">
              <Navigation className="w-4 h-4 text-cyan-500" />
              Active Geo Entities ({filteredIncidents.length + validWarehouses.length})
            </div>
            {filteredIncidents.map((inc) => (
              <button
                key={inc.id}
                type="button"
                onClick={() => {
                  setSelected({ kind: 'incident', item: inc });
                  queryWeatherAt(inc.lat, inc.lng, inc.address);
                }}
                className="w-full text-left p-2.5 rounded-lg border border-slate-200 dark:border-slate-800 hover:border-cyan-500/60 transition-colors space-y-0.5"
              >
                <div className="flex items-center justify-between text-xs font-medium text-slate-900 dark:text-slate-100">
                  <span className="truncate pr-2">{inc.title}</span>
                  <span className="font-mono text-[10px] uppercase text-red-500 shrink-0">
                    {inc.riskBand || inc.severity}
                  </span>
                </div>
                <div className="flex items-center justify-between text-[11px] font-mono text-slate-500 tabular-nums">
                  <span>
                    {inc.lat.toFixed(4)}, {inc.lng.toFixed(4)}
                  </span>
                  <span>{inc.verificationStatus}</span>
                </div>
              </button>
            ))}
            {validWarehouses.map((wh) => (
              <button
                key={wh.id}
                type="button"
                onClick={() => setSelected({ kind: 'warehouse', item: wh })}
                className="w-full text-left p-2.5 rounded-lg border border-slate-200 dark:border-slate-800 hover:border-emerald-500/60 transition-colors space-y-0.5"
              >
                <div className="flex items-center justify-between text-xs font-medium text-slate-900 dark:text-slate-100">
                  <span className="truncate pr-2">{wh.name}</span>
                  <span className="font-mono text-[10px] uppercase text-emerald-500">DEPOT</span>
                </div>
                <div className="text-[11px] font-mono text-slate-500 tabular-nums">
                  {wh.lat.toFixed(4)}, {wh.lng.toFixed(4)}
                </div>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};
