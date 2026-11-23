/// <reference types="google.maps" />
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AdvancedMarker,
  APILoadingStatus,
  APIProvider,
  InfoWindow,
  Map as GoogleMap,
  useApiLoadingStatus,
  useMap,
  useMapsLibrary,
} from '@vis.gl/react-google-maps';
import {
  AlertTriangle,
  CloudRain,
  Compass,
  Crosshair,
  Filter,
  Layers,
  Loader2,
  MapPin,
  Maximize2,
  Minus,
  Navigation,
  Plus,
  RefreshCw,
  Route as RouteIcon,
  Satellite,
  Search,
  ShieldAlert,
  Truck,
  Warehouse as WarehouseIcon,
  X,
} from 'lucide-react';
import { apiRequest } from '../../lib/api';
import type {
  DataMode,
  Dispatch,
  Incident,
  InventoryStock,
  ReliefRequest,
  RouteHazardReport,
  RouteResult,
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

type MapLayerType = 'roadmap' | 'satellite' | 'hybrid' | 'terrain';

interface GeoPoint {
  lat: number;
  lng: number;
  label: string;
}

interface SearchSuggestion {
  id: string;
  label: string;
  secondary?: string;
  placePrediction?: google.maps.places.PlacePrediction;
  lat?: number;
  lng?: number;
}

interface SearchedPlaceMarker {
  lat: number;
  lng: number;
  title: string;
  address: string;
  provider: string;
}

interface ActiveTeamRoute {
  origin: GeoPoint;
  destination: GeoPoint;
  distanceKm: number;
  durationMin: number | null;
  provider: string;
  riskBand?: string;
  safetyNotice: string;
  instructions: string[];
  geometry: { lat: number; lng: number }[];
}

const GOOGLE_MAPS_API_KEY = (import.meta.env.VITE_GOOGLE_MAPS_API_KEY || '').trim();

function isValidCoord(lat: unknown, lng: unknown): lat is number {
  return (
    typeof lat === 'number' &&
    typeof lng === 'number' &&
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180 &&
    !(lat === 0 && lng === 0)
  );
}

function dedupeById<T extends { id: string }>(items: T[]): T[] {
  const seen: Record<string, true> = {};
  const result: T[] = [];
  for (const item of items) {
    if (!item?.id || seen[item.id]) continue;
    seen[item.id] = true;
    result.push(item);
  }
  return result;
}

function haversineKmLocal(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Draws dispatch routes AND interactive emergency team planned route polylines cleanly with full unmount cleanup
const RoutePolylinesOverlay: React.FC<{
  dispatches: Dispatch[];
  visible: boolean;
  plannedRoute: ActiveTeamRoute | null;
}> = ({ dispatches, visible, plannedRoute }) => {
  const map = useMap();

  useEffect(() => {
    const g = (window as any).google;
    if (!map || !g?.maps?.Polyline) return;

    const polylines: { setMap: (m: unknown) => void }[] = [];

    if (visible) {
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
            strokeOpacity: 0.85,
            strokeWeight: 4,
            map,
          });
          polylines.push(poly);
        }
      }
    }

    if (plannedRoute && plannedRoute.geometry.length >= 2) {
      const validPlanned = plannedRoute.geometry.filter((pt) => isValidCoord(pt.lat, pt.lng));
      if (validPlanned.length >= 2) {
        const plannedPoly = new g.maps.Polyline({
          path: validPlanned,
          geodesic: true,
          strokeColor: '#6366f1',
          strokeOpacity: 0.98,
          strokeWeight: 6,
          zIndex: 50,
          map,
        });
        polylines.push(plannedPoly);

        if (g.maps.LatLngBounds) {
          const bounds = new g.maps.LatLngBounds();
          for (const pt of validPlanned) {
            bounds.extend(pt);
          }
          map.fitBounds(bounds, 56);
        }
      }
    }

    return () => {
      for (const p of polylines) {
        p.setMap(null);
      }
    };
  }, [map, dispatches, visible, plannedRoute]);

  return null;
};

// Synchronizes mapTypeId, camera pan targets, zoom +/- actions, and fit-all bounds with the active Google Map instance
const MapController: React.FC<{
  mapType: MapLayerType;
  focusTarget: { lat: number; lng: number; zoom?: number; seq: number } | null;
  zoomCommand: { delta: number; seq: number } | null;
  fitAllSeq: number;
  allPoints: { lat: number; lng: number }[];
  onSdkRouteReady: (routesLib: google.maps.RoutesLibrary | null) => void;
}> = ({ mapType, focusTarget, zoomCommand, fitAllSeq, allPoints, onSdkRouteReady }) => {
  const map = useMap();
  const routesLib = useMapsLibrary('routes');

  useEffect(() => {
    onSdkRouteReady(routesLib ?? null);
  }, [routesLib, onSdkRouteReady]);

  useEffect(() => {
    if (!map) return;
    map.setMapTypeId(mapType);
  }, [map, mapType]);

  useEffect(() => {
    if (!map || !focusTarget) return;
    map.panTo({ lat: focusTarget.lat, lng: focusTarget.lng });
    if (typeof focusTarget.zoom === 'number') {
      map.setZoom(focusTarget.zoom);
    }
  }, [map, focusTarget]);

  useEffect(() => {
    if (!map || !zoomCommand) return;
    const current = map.getZoom() ?? 10;
    const next = Math.min(20, Math.max(2, current + zoomCommand.delta));
    map.setZoom(next);
  }, [map, zoomCommand]);

  useEffect(() => {
    if (!map || fitAllSeq === 0 || allPoints.length === 0) return;
    const g = (window as any).google;
    if (!g?.maps?.LatLngBounds) return;
    if (allPoints.length === 1) {
      map.panTo(allPoints[0]);
      map.setZoom(12);
      return;
    }
    const bounds = new g.maps.LatLngBounds();
    for (const pt of allPoints) {
      bounds.extend(pt);
    }
    map.fitBounds(bounds, 48);
  }, [map, fitAllSeq, allPoints]);

  return null;
};

// Monitors live Maps JavaScript API script status so invalid/restricted keys never silently show a broken canvas
const MapsApiStatusMonitor: React.FC<{
  onStatusChange: (status: APILoadingStatus) => void;
}> = ({ onStatusChange }) => {
  const status = useApiLoadingStatus();
  useEffect(() => {
    onStatusChange(status);
  }, [status, onStatusChange]);
  return null;
};

// Places API (New) Autocomplete Search input embedded inside APIProvider context
const PlacesNewSearchControl: React.FC<{
  searchQuery: string;
  onQueryChange: (q: string) => void;
  onSelectPlace: (place: SearchedPlaceMarker) => void;
  onServerGeocodeSearch: (q: string) => Promise<void>;
  searching: boolean;
}> = ({ searchQuery, onQueryChange, onSelectPlace, onServerGeocodeSearch, searching }) => {
  const placesLib = useMapsLibrary('places');
  const [suggestions, setSuggestions] = useState<SearchSuggestion[]>([]);
  const [loadingSuggestions, setLoadingSuggestions] = useState(false);
  const [openDropdown, setOpenDropdown] = useState(false);
  const sessionTokenRef = useRef<google.maps.places.AutocompleteSessionToken | null>(null);

  useEffect(() => {
    const trimmed = searchQuery.trim();
    if (!placesLib || trimmed.length < 3) {
      setSuggestions([]);
      return;
    }

    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        setLoadingSuggestions(true);
        const { AutocompleteSessionToken, AutocompleteSuggestion } = placesLib;
        if (!sessionTokenRef.current) {
          sessionTokenRef.current = new AutocompleteSessionToken();
        }
        const res = await AutocompleteSuggestion.fetchAutocompleteSuggestions({
          input: trimmed,
          sessionToken: sessionTokenRef.current,
        });
        if (cancelled) return;
        const mapped: SearchSuggestion[] = (res.suggestions || [])
          .filter((s: google.maps.places.AutocompleteSuggestion) => Boolean(s.placePrediction))
          .slice(0, 5)
          .map((s: google.maps.places.AutocompleteSuggestion, idx: number) => ({
            id: s.placePrediction?.placeId || `pred-${idx}`,
            label: s.placePrediction?.mainText?.text || s.placePrediction?.text?.text || trimmed,
            secondary: s.placePrediction?.secondaryText?.text || '',
            placePrediction: s.placePrediction || undefined,
          }));
        setSuggestions(mapped);
        setOpenDropdown(mapped.length > 0);
      } catch {
        if (!cancelled) {
          setSuggestions([]);
        }
      } finally {
        if (!cancelled) setLoadingSuggestions(false);
      }
    }, 260);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [placesLib, searchQuery]);

  const handlePickSuggestion = async (item: SearchSuggestion) => {
    setOpenDropdown(false);
    if (item.placePrediction) {
      try {
        const place = item.placePrediction.toPlace();
        await place.fetchFields({
          fields: ['displayName', 'formattedAddress', 'location', 'viewport'],
        });
        const loc = place.location;
        if (loc) {
          const lat = typeof loc.lat === 'function' ? loc.lat() : Number((loc as any).lat);
          const lng = typeof loc.lng === 'function' ? loc.lng() : Number((loc as any).lng);
          if (isValidCoord(lat, lng)) {
            const label = place.displayName || item.label;
            const address = place.formattedAddress || item.label;
            onQueryChange(address);
            onSelectPlace({
              lat,
              lng,
              title: String(label),
              address: String(address),
              provider: 'Google Places API (New)',
            });
          }
        }
      } catch {
        await onServerGeocodeSearch(item.label);
      } finally {
        sessionTokenRef.current = null;
        setSuggestions([]);
      }
      return;
    }

    if (typeof item.lat === 'number' && typeof item.lng === 'number' && isValidCoord(item.lat, item.lng)) {
      onSelectPlace({
        lat: item.lat,
        lng: item.lng,
        title: item.label,
        address: item.secondary || item.label,
        provider: 'Geocoding API',
      });
    }
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        setOpenDropdown(false);
        if (searchQuery.trim().length >= 2) {
          void onServerGeocodeSearch(searchQuery);
        }
      }}
      className="relative flex-1 min-w-[220px]"
    >
      <div className="relative flex items-center">
        <Search className="w-4 h-4 text-slate-400 absolute left-3 pointer-events-none" />
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => {
            onQueryChange(e.target.value);
            if (e.target.value.trim().length >= 3) setOpenDropdown(true);
          }}
          onFocus={() => {
            if (suggestions.length > 0) setOpenDropdown(true);
          }}
          placeholder="Search address, hospital, depot, or city..."
          aria-label="Search locations and addresses"
          className="w-full h-9 pl-9 pr-20 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-xs text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-[#6D7CFF]/40"
        />
        {searchQuery && (
          <button
            type="button"
            onClick={() => {
              onQueryChange('');
              setSuggestions([]);
              setOpenDropdown(false);
            }}
            className="absolute right-14 text-slate-400 hover:text-slate-200 p-1"
            aria-label="Clear location search"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
        <button
          type="submit"
          disabled={searching || searchQuery.trim().length < 2}
          className="absolute right-1 h-7 px-2.5 rounded-md bg-[#5869E8] hover:bg-[#4959D6] disabled:opacity-50 text-white text-[11px] font-semibold transition-colors"
        >
          {searching || loadingSuggestions ? '...' : 'Find'}
        </button>
      </div>

      {openDropdown && suggestions.length > 0 && (
        <ul className="absolute z-40 left-0 right-0 mt-1.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-xl overflow-hidden divide-y divide-slate-100 dark:divide-slate-800">
          {suggestions.map((s) => (
            <li key={s.id}>
              <button
                type="button"
                onClick={() => void handlePickSuggestion(s)}
                className="w-full text-left px-3 py-2 hover:bg-slate-100 dark:hover:bg-slate-800 flex items-start gap-2 transition-colors"
              >
                <MapPin className="w-3.5 h-3.5 text-[#5869E8] mt-0.5 shrink-0" />
                <div className="min-w-0">
                  <div className="text-xs font-medium text-slate-900 dark:text-slate-100 truncate">{s.label}</div>
                  {s.secondary && (
                    <div className="text-[11px] text-slate-500 dark:text-slate-400 truncate">{s.secondary}</div>
                  )}
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </form>
  );
};

type SelectedMarker =
  | { kind: 'incident'; item: Incident }
  | { kind: 'warehouse'; item: Warehouse }
  | { kind: 'request'; item: ReliefRequest }
  | { kind: 'dispatch'; item: Dispatch }
  | { kind: 'hazard'; item: RouteHazardReport }
  | { kind: 'vehicle'; item: Vehicle }
  | { kind: 'searched'; item: SearchedPlaceMarker }
  | { kind: 'user_location'; item: GeoPoint }
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

  // Map appearance & interactive controls state
  const [mapType, setMapType] = useState<MapLayerType>('roadmap');
  const [apiStatus, setApiStatus] = useState<APILoadingStatus>(
    GOOGLE_MAPS_API_KEY ? APILoadingStatus.LOADING : APILoadingStatus.NOT_LOADED
  );
  const [mapRetryKey, setMapRetryKey] = useState(0);
  const [focusTarget, setFocusTarget] = useState<{ lat: number; lng: number; zoom?: number; seq: number } | null>(null);
  const [zoomCommand, setZoomCommand] = useState<{ delta: number; seq: number } | null>(null);
  const [fitAllSeq, setFitAllSeq] = useState(0);

  // Location Search & Server Geocoding fallback state
  const [searchQuery, setSearchQuery] = useState('');
  const [searchingLocation, setSearchingLocation] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searchedPlace, setSearchedPlace] = useState<SearchedPlaceMarker | null>(null);

  // User Current Location (Geolocation API) state
  const [userLocation, setUserLocation] = useState<GeoPoint | null>(null);
  const [locatingUser, setLocatingUser] = useState(false);
  const [locationError, setLocationError] = useState<string | null>(null);

  // Interactive Team Route Planner state
  const sdkRoutesLibRef = useRef<google.maps.RoutesLibrary | null>(null);
  const [plannedRoute, setPlannedRoute] = useState<ActiveTeamRoute | null>(null);
  const [planningRoute, setPlanningRoute] = useState(false);
  const [routeError, setRouteError] = useState<string | null>(null);

  // Multi-Facet Map Filters + Inventory Resource Layer Filter
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
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const dedupedIncidents = useMemo(() => dedupeById(incidents), [incidents]);
  const dedupedWarehouses = useMemo(() => dedupeById(warehouses), [warehouses]);
  const dedupedRequests = useMemo(() => dedupeById(reliefRequests), [reliefRequests]);
  const dedupedDispatches = useMemo(() => dedupeById(dispatches), [dispatches]);
  const dedupedVehicles = useMemo(() => dedupeById(vehicles), [vehicles]);
  const dedupedHazards = useMemo(() => dedupeById(hazards), [hazards]);

  const incidentTypesPresent = useMemo(
    () => Array.from(new Set(dedupedIncidents.map((i) => i.type))).sort(),
    [dedupedIncidents]
  );

  const filteredIncidents = useMemo(() => {
    const nowMs = Date.now();
    return dedupedIncidents.filter((inc) => {
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
  }, [dedupedIncidents, typeFilter, severityFilter, statusFilter, verificationFilter, riskBandFilter, dateWindow]);

  const invalidCoordCount = useMemo(
    () => dedupedIncidents.filter((i) => !isValidCoord(i.lat, i.lng)).length,
    [dedupedIncidents]
  );

  const validWarehouses = useMemo(() => {
    return dedupedWarehouses.filter((w) => {
      if (!isValidCoord(w.lat, w.lng)) return false;
      if (resourceFilter !== 'all') {
        const hasStock = inventory.some(
          (i) => i.warehouseId === w.id && i.category === resourceFilter && i.availableQty > 0
        );
        if (!hasStock) return false;
      }
      return true;
    });
  }, [dedupedWarehouses, inventory, resourceFilter]);

  const warehouseInventoryMeta = useMemo(() => {
    const record: Record<
      string,
      { items: InventoryStock[]; criticalCount: number; lowCount: number; totalAvailable: number }
    > = {};
    for (const w of dedupedWarehouses) {
      const items = inventory.filter((i) => i.warehouseId === w.id);
      const criticalCount = items.filter(
        (i) => i.stockStatus === 'CRITICAL' || i.stockStatus === 'OUT_OF_STOCK'
      ).length;
      const lowCount = items.filter((i) => i.stockStatus === 'LOW').length;
      const totalAvailable = items.reduce((s, i) => s + i.availableQty, 0);
      record[w.id] = { items, criticalCount, lowCount, totalAvailable };
    }
    return record;
  }, [dedupedWarehouses, inventory]);

  const validRequests = useMemo(
    () => dedupedRequests.filter((r) => isValidCoord(r.lat, r.lng)),
    [dedupedRequests]
  );

  const validDispatches = useMemo(
    () => dedupedDispatches.filter((d) => isValidCoord(d.currentLat, d.currentLng)),
    [dedupedDispatches]
  );

  const validHazards = useMemo(
    () => dedupedHazards.filter((h) => h.active && isValidCoord(h.lat, h.lng)),
    [dedupedHazards]
  );

  const validVehicles = useMemo(
    () => dedupedVehicles.filter((v) => isValidCoord(v.lat, v.lng)),
    [dedupedVehicles]
  );

  const defaultCenter = useMemo(() => {
    if (filteredIncidents[0]) return { lat: filteredIncidents[0].lat, lng: filteredIncidents[0].lng };
    if (validWarehouses[0]) return { lat: validWarehouses[0].lat, lng: validWarehouses[0].lng };
    return { lat: 12.9784, lng: 80.2186 };
  }, [filteredIncidents, validWarehouses]);

  const allVisibleCoordinates = useMemo(() => {
    const pts: { lat: number; lng: number }[] = [];
    if (layers.incidents) filteredIncidents.forEach((i) => pts.push({ lat: i.lat, lng: i.lng }));
    if (layers.warehouses) validWarehouses.forEach((w) => pts.push({ lat: w.lat, lng: w.lng }));
    if (layers.requests) validRequests.forEach((r) => pts.push({ lat: r.lat, lng: r.lng }));
    if (layers.dispatches) {
      validDispatches.forEach((d) => {
        if (typeof d.currentLat === 'number' && typeof d.currentLng === 'number' && isValidCoord(d.currentLat, d.currentLng)) {
          pts.push({ lat: d.currentLat, lng: d.currentLng });
        }
      });
    }
    if (layers.vehicles) {
      validVehicles.forEach((v) => {
        if (typeof v.lat === 'number' && typeof v.lng === 'number' && isValidCoord(v.lat, v.lng)) {
          pts.push({ lat: v.lat, lng: v.lng });
        }
      });
    }
    if (userLocation) pts.push({ lat: userLocation.lat, lng: userLocation.lng });
    if (searchedPlace) pts.push({ lat: searchedPlace.lat, lng: searchedPlace.lng });
    return pts;
  }, [layers, filteredIncidents, validWarehouses, validRequests, validDispatches, validVehicles, userLocation, searchedPlace]);

  const queryWeatherAt = useCallback(async (lat: number, lng: number, label: string, forceRefresh = false) => {
    if (!isValidCoord(lat, lng)) return;
    setLoadingWeather(true);
    try {
      const res = await apiRequest<{ observation: WeatherObservation }>(
        `/weather/current?lat=${lat}&lng=${lng}&locationName=${encodeURIComponent(label)}&forceRefresh=${forceRefresh}`
      );
      if (mountedRef.current) {
        setWeather(res.observation);
      }
    } catch {
      // handled gracefully
    } finally {
      if (mountedRef.current) {
        setLoadingWeather(false);
      }
    }
  }, []);

  useEffect(() => {
    void queryWeatherAt(defaultCenter.lat, defaultCenter.lng, filteredIncidents[0]?.region || 'Operations Sector');
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
  }, [mode, dedupedDispatches]);

  const panToPoint = useCallback((lat: number, lng: number, zoom?: number) => {
    if (!isValidCoord(lat, lng)) return;
    setFocusTarget({ lat, lng, zoom, seq: Date.now() + Math.random() });
  }, []);

  const handleLocateUser = useCallback(() => {
    setLocationError(null);
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setLocationError('Geolocation is not supported by this browser.');
      return;
    }
    setLocatingUser(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        if (!mountedRef.current) return;
        const { latitude, longitude } = pos.coords;
        if (!isValidCoord(latitude, longitude)) {
          setLocationError('Device returned invalid GPS coordinates.');
          setLocatingUser(false);
          return;
        }
        const pt: GeoPoint = {
          lat: latitude,
          lng: longitude,
          label: 'Your Current Location',
        };
        setUserLocation(pt);
        setSelected({ kind: 'user_location', item: pt });
        panToPoint(latitude, longitude, 13);
        void queryWeatherAt(latitude, longitude, 'Operator Location');
        setLocatingUser(false);
      },
      (err) => {
        if (!mountedRef.current) return;
        const msg =
          err.code === 1
            ? 'Location permission denied. Enable location access in your browser settings to center on your position.'
            : err.code === 3
            ? 'Location request timed out. Ensure GPS/network location is available and retry.'
            : 'Unable to determine your current location.';
        setLocationError(msg);
        setLocatingUser(false);
      },
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 60_000 }
    );
  }, [panToPoint, queryWeatherAt]);

  const handleServerGeocodeSearch = useCallback(
    async (rawQuery: string) => {
      const q = rawQuery.trim();
      if (q.length < 2) return;
      setSearchError(null);
      setSearchingLocation(true);
      try {
        const res = await apiRequest<{
          provider: string;
          googleConfigured: boolean;
          notice?: string;
          results: Array<{ placeId: string | null; formattedAddress: string; lat: number; lng: number }>;
        }>(`/geo/geocode?address=${encodeURIComponent(q)}`);

        const hit = res.results?.[0];
        if (!hit || !isValidCoord(hit.lat, hit.lng)) {
          setSearchError(res.notice || `No geographic match found for "${q}".`);
          return;
        }
        const marker: SearchedPlaceMarker = {
          lat: hit.lat,
          lng: hit.lng,
          title: q,
          address: hit.formattedAddress,
          provider:
            res.provider === 'google_geocoding_v4'
              ? 'Google Geocoding API'
              : 'OpenStreetMap Geocoding Fallback',
        };
        if (!mountedRef.current) return;
        setSearchedPlace(marker);
        setSelected({ kind: 'searched', item: marker });
        panToPoint(hit.lat, hit.lng, 13);
        void queryWeatherAt(hit.lat, hit.lng, hit.formattedAddress);
      } catch (err) {
        if (mountedRef.current) {
          setSearchError(err instanceof Error ? err.message : 'Location search failed.');
        }
      } finally {
        if (mountedRef.current) setSearchingLocation(false);
      }
    },
    [panToPoint, queryWeatherAt]
  );

  const handleSelectPlaceFromAutocomplete = useCallback(
    (place: SearchedPlaceMarker) => {
      setSearchError(null);
      setSearchedPlace(place);
      setSelected({ kind: 'searched', item: place });
      panToPoint(place.lat, place.lng, 14);
      void queryWeatherAt(place.lat, place.lng, place.address);
    },
    [panToPoint, queryWeatherAt]
  );

  const findBestOriginForDestination = useCallback(
    (destLat: number, destLng: number, preferUserLocation = false): GeoPoint | null => {
      if (preferUserLocation && userLocation && isValidCoord(userLocation.lat, userLocation.lng)) {
        return userLocation;
      }
      const operationalWarehouses = validWarehouses.filter((w) => w.status !== 'closed');
      const pool = operationalWarehouses.length > 0 ? operationalWarehouses : validWarehouses;
      if (pool.length > 0) {
        const sorted = [...pool].sort(
          (a, b) => haversineKmLocal(a.lat, a.lng, destLat, destLng) - haversineKmLocal(b.lat, b.lng, destLat, destLng)
        );
        const best = sorted[0];
        return { lat: best.lat, lng: best.lng, label: best.name };
      }
      if (userLocation) return userLocation;
      return null;
    },
    [validWarehouses, userLocation]
  );

  const handlePlanTeamRoute = useCallback(
    async (destination: GeoPoint, preferUserLocation = false) => {
      if (!isValidCoord(destination.lat, destination.lng)) return;
      const origin = findBestOriginForDestination(destination.lat, destination.lng, preferUserLocation);
      if (!origin) {
        setRouteError('No valid origin warehouse or current location available to compute a route.');
        return;
      }

      setRouteError(null);
      setPlanningRoute(true);
      try {
        // Compute RESQFLOW hazard-aware route via backend (uses Google Routes API v2 or OSRM + hazard check)
        const res = await apiRequest<{ route: RouteResult }>('/routes/optimize', {
          method: 'POST',
          body: {
            origin,
            destination,
            mode,
            bypassCache: true,
          },
        });
        const r = res.route;
        let geometry = (r.geometry || []).filter((pt) => isValidCoord(pt.lat, pt.lng));
        let distanceKm = r.distanceKm;
        let durationMin = r.durationMin;
        let providerLabel =
          r.provider === 'google_routes_v2'
            ? 'Google Routes API v2'
            : r.provider === 'osrm'
            ? 'OSRM Road Network'
            : 'Distance Fallback';

        // If client-side Google Maps SDK Routes library is loaded and backend fell back to non-Google routing, enhance with SDK Route.computeRoutes
        if (sdkRoutesLibRef.current && r.provider !== 'google_routes_v2') {
          try {
            const sdkResponse = await (sdkRoutesLibRef.current.Route as any).computeRoutes({
              origin: { lat: origin.lat, lng: origin.lng },
              destination: { lat: destination.lat, lng: destination.lng },
              travelMode: 'DRIVING',
              fields: ['path', 'distanceMeters', 'durationMillis', 'viewport'],
            });
            const primary = sdkResponse?.routes?.[0];
            if (primary?.path && Array.isArray(primary.path) && primary.path.length >= 2) {
              geometry = primary.path.map((pt: any) => ({
                lat: typeof pt.lat === 'function' ? pt.lat() : Number(pt.lat),
                lng: typeof pt.lng === 'function' ? pt.lng() : Number(pt.lng),
              }));
              if (typeof primary.distanceMeters === 'number') {
                distanceKm = Math.round((primary.distanceMeters / 1000) * 100) / 100;
              }
              if (typeof primary.durationMillis === 'number') {
                durationMin = Math.max(1, Math.round(primary.durationMillis / 60000));
              }
              providerLabel = 'Google Maps Routes SDK';
            }
          } catch {
            // keep backend OSRM route cleanly
          }
        }

        if (!mountedRef.current) return;
        setPlannedRoute({
          origin,
          destination,
          distanceKm,
          durationMin,
          provider: providerLabel,
          riskBand: r.riskAssessment?.riskBand,
          safetyNotice: r.roadConditionsNotice,
          instructions: r.instructions || [],
          geometry,
        });
      } catch (err) {
        if (mountedRef.current) {
          setRouteError(err instanceof Error ? err.message : 'Unable to calculate response route.');
        }
      } finally {
        if (mountedRef.current) setPlanningRoute(false);
      }
    },
    [findBestOriginForDestination, mode]
  );

  const handleSdkRouteReady = useCallback((lib: google.maps.RoutesLibrary | null) => {
    sdkRoutesLibRef.current = lib;
  }, []);

  const canRenderGoogleMap = Boolean(GOOGLE_MAPS_API_KEY) && !mapsQuotaExceeded;
  const mapHasAuthOrLoadError =
    apiStatus === APILoadingStatus.FAILED || apiStatus === APILoadingStatus.AUTH_FAILURE;

  const renderInfoWindowContent = () => {
    if (!selected) return null;

    let heading = '';
    let categoryLabel: string = selected.kind;
    let bodyNodes: React.ReactNode = null;
    let routeDest: GeoPoint | null = null;

    if (selected.kind === 'incident') {
      categoryLabel = `incident · ${selected.item.type.replace(/_/g, ' ')}`;
      heading = selected.item.title;
      routeDest = { lat: selected.item.lat, lng: selected.item.lng, label: selected.item.title };
      bodyNodes = (
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
          <div className="font-mono text-[10px] text-slate-500">
            {selected.item.lat.toFixed(4)}, {selected.item.lng.toFixed(4)}
          </div>
        </>
      );
    } else if (selected.kind === 'warehouse') {
      categoryLabel = 'warehouse depot';
      heading = selected.item.name;
      routeDest = { lat: selected.item.lat, lng: selected.item.lng, label: selected.item.name };
      const meta = warehouseInventoryMeta[selected.item.id];
      bodyNodes = (
        <>
          <div>
            {selected.item.status.replace(/_/g, ' ').toUpperCase()} · {selected.item.region}
          </div>
          <div>Available Units: {(meta?.totalAvailable ?? 0).toLocaleString()}</div>
        </>
      );
    } else if (selected.kind === 'request') {
      categoryLabel = 'relief request';
      heading = selected.item.locationName;
      routeDest = { lat: selected.item.lat, lng: selected.item.lng, label: selected.item.locationName };
      bodyNodes = (
        <div>
          Priority {selected.item.priorityScore}/100 ({selected.item.priorityCategory}) · {selected.item.status}
        </div>
      );
    } else if (selected.kind === 'dispatch') {
      categoryLabel = 'active dispatch';
      heading = selected.item.vehicleCallsign;
      bodyNodes = (
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
      );
    } else if (selected.kind === 'vehicle') {
      categoryLabel = 'fleet vehicle';
      heading = selected.item.callsign;
      bodyNodes = (
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
      );
    } else if (selected.kind === 'hazard') {
      categoryLabel = 'road hazard';
      heading = `${selected.item.type.replace(/_/g, ' ').toUpperCase()} (${selected.item.severity})`;
      bodyNodes = (
        <>
          <div>{selected.item.description}</div>
          <div>
            Radius: {selected.item.radiusKm} km · Source: {selected.item.source} ·{' '}
            {selected.item.verified ? 'Verified' : 'Unverified'}
          </div>
        </>
      );
    } else if (selected.kind === 'searched') {
      categoryLabel = selected.item.provider;
      heading = selected.item.title;
      routeDest = { lat: selected.item.lat, lng: selected.item.lng, label: selected.item.address };
      bodyNodes = (
        <>
          <div>{selected.item.address}</div>
          <div className="font-mono text-[10px] text-slate-500">
            {selected.item.lat.toFixed(5)}, {selected.item.lng.toFixed(5)}
          </div>
        </>
      );
    } else if (selected.kind === 'user_location') {
      categoryLabel = 'current operator gps';
      heading = selected.item.label;
      bodyNodes = (
        <div className="font-mono text-[11px] text-slate-500">
          {selected.item.lat.toFixed(5)}, {selected.item.lng.toFixed(5)}
        </div>
      );
    }

    return (
      <div className="text-slate-900 max-w-xs space-y-1.5 p-1">
        <div className="text-[10px] font-mono uppercase text-cyan-700 font-semibold">{categoryLabel}</div>
        <div className="text-sm font-semibold leading-snug">{heading}</div>
        <div className="text-xs text-slate-600 space-y-0.5">{bodyNodes}</div>
        {routeDest && (
          <div className="pt-1.5 flex flex-wrap gap-1.5">
            <button
              type="button"
              disabled={planningRoute}
              onClick={() => void handlePlanTeamRoute(routeDest!, false)}
              className="px-2.5 py-1 rounded-md bg-indigo-600 hover:bg-indigo-500 text-white text-[11px] font-semibold transition-colors"
            >
              {planningRoute ? 'Routing...' : 'Route from Nearest Depot'}
            </button>
            {userLocation && (
              <button
                type="button"
                disabled={planningRoute}
                onClick={() => void handlePlanTeamRoute(routeDest!, true)}
                className="px-2.5 py-1 rounded-md border border-indigo-600 text-indigo-700 hover:bg-indigo-50 text-[11px] font-semibold transition-colors"
              >
                Route from Me
              </button>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-900 dark:text-white">
            Live Emergency Map &amp; Geospatial Operations
          </h1>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Google Maps Platform tactical command view · Live markers, address search, team routing &amp; Open-Meteo telemetry
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
              ['routes', 'Route Polylines', dedupedDispatches.filter((d) => d.route).length],
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

      {/* Geospatial Filter Bar */}
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

      {/* Interactive Search, Current Location, Map Type & Route Error Bar */}
      {(searchError || locationError || routeError) && (
        <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-3.5 py-2.5 text-xs text-amber-800 dark:text-amber-200 flex items-center justify-between gap-2">
          <span className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0 text-amber-500" />
            <span>{searchError || locationError || routeError}</span>
          </span>
          <button
            type="button"
            onClick={() => {
              setSearchError(null);
              setLocationError(null);
              setRouteError(null);
            }}
            aria-label="Dismiss map alert"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-5">
        {/* Main Map Canvas */}
        <div className="lg:col-span-3 flex flex-col gap-3">
          {canRenderGoogleMap ? (
            <APIProvider
              key={mapRetryKey}
              apiKey={GOOGLE_MAPS_API_KEY}
              libraries={['places', 'routes', 'marker']}
              language="en"
            >
              <MapsApiStatusMonitor onStatusChange={setApiStatus} />

              {/* Map Controls Toolbar (Places New Autocomplete Search, Locate Me, Map View Mode) */}
              <div className="rf-card p-3 flex flex-wrap items-center justify-between gap-2.5">
                <PlacesNewSearchControl
                  searchQuery={searchQuery}
                  onQueryChange={setSearchQuery}
                  onSelectPlace={handleSelectPlaceFromAutocomplete}
                  onServerGeocodeSearch={handleServerGeocodeSearch}
                  searching={searchingLocation}
                />

                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={handleLocateUser}
                    disabled={locatingUser}
                    className="h-9 px-3 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 hover:border-cyan-500/60 text-xs font-medium text-slate-800 dark:text-slate-100 inline-flex items-center gap-1.5 transition-colors"
                    title="Center map on your current GPS location"
                  >
                    {locatingUser ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin text-cyan-500" />
                    ) : (
                      <Crosshair className="w-3.5 h-3.5 text-cyan-500" />
                    )}
                    <span>{locatingUser ? 'Locating...' : 'My Location'}</span>
                  </button>

                  <div
                    className="inline-flex items-center rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 p-0.5 text-[11px] font-medium"
                    role="group"
                    aria-label="Map layer view mode"
                  >
                    {(
                      [
                        ['roadmap', 'Roadmap'],
                        ['satellite', 'Satellite'],
                        ['hybrid', 'Hybrid'],
                        ['terrain', 'Terrain'],
                      ] as const
                    ).map(([typeId, label]) => (
                      <button
                        key={typeId}
                        type="button"
                        onClick={() => setMapType(typeId)}
                        className={`px-2.5 h-7 rounded-md transition-colors ${
                          mapType === typeId
                            ? 'bg-[#5869E8] text-white shadow-xs'
                            : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {/* Google Map Surface */}
              <div className="rounded-2xl border border-[var(--rf-border-strong)] overflow-hidden bg-[#080D18] h-[380px] sm:h-[480px] lg:h-[580px] relative shadow-[var(--rf-shadow-card)]">
                {mapHasAuthOrLoadError ? (
                  <div className="w-full h-full flex flex-col items-center justify-center p-6 sm:p-8 text-center space-y-3 text-slate-300">
                    <AlertTriangle className="w-10 h-10 text-amber-400" />
                    <div className="text-base font-semibold text-white">
                      {apiStatus === APILoadingStatus.AUTH_FAILURE
                        ? 'Google Maps Authorization Failed'
                        : 'Google Maps Script Failed to Load'}
                    </div>
                    <p className="text-xs text-slate-400 max-w-lg leading-relaxed">
                      Verify that <code className="font-mono text-cyan-300">VITE_GOOGLE_MAPS_API_KEY</code> is valid,
                      Maps JavaScript API, Places API (New), and Routes API are enabled in Google Cloud Console, and
                      this deployment domain is included in the key&apos;s HTTP referrer allowlist.
                    </p>
                    <button
                      type="button"
                      onClick={() => {
                        setApiStatus(APILoadingStatus.LOADING);
                        setMapRetryKey((k) => k + 1);
                      }}
                      className="px-4 h-9 rounded-lg bg-[#5869E8] hover:bg-[#4959D6] text-white text-xs font-semibold inline-flex items-center gap-1.5 transition-colors"
                    >
                      <RefreshCw className="w-3.5 h-3.5" />
                      Retry Map Connection
                    </button>
                  </div>
                ) : (
                  <>
                    <GoogleMap
                      style={{ width: '100%', height: '100%' }}
                      defaultCenter={defaultCenter}
                      defaultZoom={10}
                      mapId="DEMO_MAP_ID"
                      mapTypeId={mapType}
                      gestureHandling="greedy"
                      zoomControl={false}
                      mapTypeControl={false}
                      streetViewControl={false}
                      fullscreenControl={true}
                      internalUsageAttributionIds={['gmp_mcp_codeassist_v1_aistudio', 'gmp_git_agentskills_v1']}
                    >
                      <MapController
                        mapType={mapType}
                        focusTarget={focusTarget}
                        zoomCommand={zoomCommand}
                        fitAllSeq={fitAllSeq}
                        allPoints={allVisibleCoordinates}
                        onSdkRouteReady={handleSdkRouteReady}
                      />

                      <RoutePolylinesOverlay
                        dispatches={dedupedDispatches}
                        visible={layers.routes}
                        plannedRoute={plannedRoute}
                      />

                      {layers.incidents &&
                        filteredIncidents.map((inc) => (
                          <AdvancedMarker
                            key={`inc-${inc.id}`}
                            position={{ lat: inc.lat, lng: inc.lng }}
                            title={inc.title}
                            onClick={() => {
                              setSelected({ kind: 'incident', item: inc });
                              void queryWeatherAt(inc.lat, inc.lng, inc.address);
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
                          const meta = warehouseInventoryMeta[wh.id];
                          const markerBg =
                            wh.status === 'closed' ||
                            wh.status === 'temporarily_unavailable' ||
                            (meta?.criticalCount ?? 0) > 0
                              ? 'bg-red-600'
                              : wh.status === 'limited' || (meta?.lowCount ?? 0) > 0
                              ? 'bg-amber-600'
                              : 'bg-emerald-600';
                          return (
                            <AdvancedMarker
                              key={`wh-${wh.id}`}
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
                            key={`req-${req.id}`}
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
                            key={`dsp-${dsp.id}`}
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
                            key={`veh-${veh.id}`}
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
                            key={`hz-${hz.id}`}
                            position={{ lat: hz.lat, lng: hz.lng }}
                            title={`${hz.type.replace(/_/g, ' ')} — ${hz.description}`}
                            onClick={() => setSelected({ kind: 'hazard', item: hz })}
                          >
                            <div
                              className={`w-7 h-7 rounded-full border-2 border-white shadow-lg text-white flex items-center justify-center ${
                                hz.type === 'closure' || hz.severity === 'critical' ? 'bg-red-700' : 'bg-amber-600'
                              }`}
                            >
                              <AlertTriangle className="w-3.5 h-3.5" />
                            </div>
                          </AdvancedMarker>
                        ))}

                      {userLocation && (
                        <AdvancedMarker
                          key="operator-location"
                          position={{ lat: userLocation.lat, lng: userLocation.lng }}
                          title="Your Current Location"
                          onClick={() => setSelected({ kind: 'user_location', item: userLocation })}
                        >
                          <div className="w-7 h-7 rounded-full border-2 border-white shadow-lg bg-blue-600 text-white flex items-center justify-center ring-4 ring-blue-500/35">
                            <Compass className="w-3.5 h-3.5" />
                          </div>
                        </AdvancedMarker>
                      )}

                      {searchedPlace && (
                        <AdvancedMarker
                          key="searched-place"
                          position={{ lat: searchedPlace.lat, lng: searchedPlace.lng }}
                          title={searchedPlace.address}
                          onClick={() => setSelected({ kind: 'searched', item: searchedPlace })}
                        >
                          <div className="w-7 h-7 rounded-full border-2 border-white shadow-lg bg-fuchsia-600 text-white flex items-center justify-center">
                            <MapPin className="w-3.5 h-3.5" />
                          </div>
                        </AdvancedMarker>
                      )}

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
                          {renderInfoWindowContent()}
                        </InfoWindow>
                      )}
                    </GoogleMap>

                    {/* Floating Zoom & Bounds Controls */}
                    <div className="absolute bottom-5 right-3 z-20 flex flex-col gap-1.5">
                      <button
                        type="button"
                        onClick={() => setZoomCommand({ delta: 1, seq: Date.now() + Math.random() })}
                        className="w-9 h-9 rounded-lg bg-slate-900/90 hover:bg-slate-800 border border-slate-700 text-white flex items-center justify-center shadow-lg transition-colors"
                        title="Zoom In"
                        aria-label="Zoom In"
                      >
                        <Plus className="w-4 h-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => setZoomCommand({ delta: -1, seq: Date.now() + Math.random() })}
                        className="w-9 h-9 rounded-lg bg-slate-900/90 hover:bg-slate-800 border border-slate-700 text-white flex items-center justify-center shadow-lg transition-colors"
                        title="Zoom Out"
                        aria-label="Zoom Out"
                      >
                        <Minus className="w-4 h-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => setFitAllSeq((s) => s + 1)}
                        className="w-9 h-9 rounded-lg bg-slate-900/90 hover:bg-slate-800 border border-slate-700 text-cyan-300 flex items-center justify-center shadow-lg transition-colors"
                        title="Fit all active markers"
                        aria-label="Fit all active markers"
                      >
                        <Maximize2 className="w-4 h-4" />
                      </button>
                    </div>

                    {/* Floating Category Color Legend */}
                    <div className="hidden sm:flex absolute bottom-5 left-3 z-20 flex-wrap items-center gap-2.5 px-3 py-1.5 rounded-lg bg-slate-950/85 backdrop-blur border border-slate-800 text-[11px] text-slate-200">
                      <span className="inline-flex items-center gap-1">
                        <span className="w-2.5 h-2.5 rounded-full bg-red-600" /> Critical
                      </span>
                      <span className="inline-flex items-center gap-1">
                        <span className="w-2.5 h-2.5 rounded-full bg-orange-500" /> High
                      </span>
                      <span className="inline-flex items-center gap-1">
                        <span className="w-2.5 h-2.5 rounded-sm bg-emerald-600" /> Depot
                      </span>
                      <span className="inline-flex items-center gap-1">
                        <span className="w-2.5 h-2.5 rounded-full bg-violet-600" /> Request
                      </span>
                      <span className="inline-flex items-center gap-1">
                        <span className="w-2.5 h-2.5 rounded-full bg-cyan-500" /> Dispatch
                      </span>
                      <span className="inline-flex items-center gap-1">
                        <span className="w-2.5 h-2.5 rounded-full bg-blue-600" /> GPS
                      </span>
                    </div>
                  </>
                )}
              </div>
            </APIProvider>
          ) : (
            <div className="space-y-3">
              {/* Even without browser Maps JS key, allow server geocoding search & geolocation */}
              <div className="rf-card p-3 flex flex-wrap items-center justify-between gap-2.5">
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (searchQuery.trim().length >= 2) void handleServerGeocodeSearch(searchQuery);
                  }}
                  className="flex-1 min-w-[220px] relative flex items-center"
                >
                  <Search className="w-4 h-4 text-slate-400 absolute left-3 pointer-events-none" />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Search address or coordinates via server geocoder..."
                    className="w-full h-9 pl-9 pr-16 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-xs text-slate-900 dark:text-slate-100"
                  />
                  <button
                    type="submit"
                    disabled={searchingLocation || searchQuery.trim().length < 2}
                    className="absolute right-1 h-7 px-2.5 rounded-md bg-[#5869E8] hover:bg-[#4959D6] disabled:opacity-50 text-white text-[11px] font-semibold"
                  >
                    {searchingLocation ? '...' : 'Find'}
                  </button>
                </form>
                <button
                  type="button"
                  onClick={handleLocateUser}
                  disabled={locatingUser}
                  className="h-9 px-3 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-xs font-medium text-slate-800 dark:text-slate-100 inline-flex items-center gap-1.5"
                >
                  <Crosshair className="w-3.5 h-3.5 text-cyan-500" />
                  <span>{locatingUser ? 'Locating...' : 'My Location'}</span>
                </button>
              </div>

              <div className="rounded-2xl border border-[var(--rf-border-strong)] bg-[#080D18] min-h-[420px] flex flex-col items-center justify-center p-6 sm:p-8 text-center space-y-3 text-slate-300">
                {mapsQuotaExceeded ? (
                  <Layers className="w-10 h-10 text-amber-400" />
                ) : (
                  <Satellite className="w-10 h-10 text-cyan-400" />
                )}
                <div className="text-base font-semibold text-white">
                  {mapsQuotaExceeded
                    ? 'Google Maps Quota Reached — Coordinate List & Backend Routing Active'
                    : 'Google Maps Browser API Key Not Configured'}
                </div>
                <p className="text-xs text-slate-400 max-w-lg leading-relaxed">
                  {mapsQuotaExceeded
                    ? 'Interactive map tiles paused due to API quota limits. Tactical coordinate inspection, Open-Meteo telemetry, and OSRM team routing remain active.'
                    : 'Set VITE_GOOGLE_MAPS_API_KEY in your environment variables (with HTTP referrer restrictions) and rebuild/redeploy to enable live Roadmap & Satellite tiles, Places (New) autocomplete, and visual route overlays.'}
                </p>
                {searchedPlace && (
                  <div className="mt-2 px-3 py-2 rounded-lg bg-slate-900 border border-slate-700 text-xs text-slate-200">
                    Found: <span className="font-semibold text-white">{searchedPlace.address}</span> ({searchedPlace.lat.toFixed(4)}, {searchedPlace.lng.toFixed(4)})
                  </div>
                )}
                {userLocation && (
                  <div className="px-3 py-2 rounded-lg bg-slate-900 border border-slate-700 text-xs text-cyan-300 font-mono">
                    Current GPS: {userLocation.lat.toFixed(5)}, {userLocation.lng.toFixed(5)}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Active Planned Emergency Team Route Card */}
          {plannedRoute && (
            <div className="rf-card p-4 space-y-2.5 text-xs">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 font-semibold text-slate-900 dark:text-white">
                  <RouteIcon className="w-4 h-4 text-[#5869E8]" />
                  <span>
                    Team Route: {plannedRoute.origin.label} → {plannedRoute.destination.label}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="px-2 py-0.5 rounded-md bg-indigo-500/15 text-indigo-600 dark:text-indigo-300 font-mono tabular-nums">
                    {plannedRoute.distanceKm} km ·{' '}
                    {plannedRoute.durationMin !== null ? `${plannedRoute.durationMin} min ETA` : 'ETA unavailable'}
                  </span>
                  {plannedRoute.riskBand && (
                    <span
                      className={`px-2 py-0.5 rounded-md font-mono uppercase text-[10px] font-semibold ${
                        plannedRoute.riskBand === 'BLOCKED'
                          ? 'bg-red-500/15 text-red-500'
                          : plannedRoute.riskBand === 'HIGH'
                          ? 'bg-orange-500/15 text-orange-500'
                          : 'bg-emerald-500/15 text-emerald-500'
                      }`}
                    >
                      Risk: {plannedRoute.riskBand}
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => setPlannedRoute(null)}
                    className="text-slate-400 hover:text-slate-200"
                    aria-label="Clear planned route"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              </div>
              <div className="text-[11px] text-slate-500 dark:text-slate-400">
                Provider: {plannedRoute.provider} · {plannedRoute.safetyNotice}
              </div>
              {plannedRoute.instructions.length > 0 && (
                <ol className="grid sm:grid-cols-2 gap-1.5 pt-1 text-[11px] text-slate-700 dark:text-slate-300 list-decimal list-inside">
                  {plannedRoute.instructions.slice(0, 6).map((step, idx) => (
                    <li key={idx} className="truncate">
                      {step}
                    </li>
                  ))}
                </ol>
              )}
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
                onClick={() => void queryWeatherAt(defaultCenter.lat, defaultCenter.lng, 'Operations Sector', true)}
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

          {/* Selected Warehouse Stock & Supply Inspector */}
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
                {(warehouseInventoryMeta[selected.item.id]?.items || []).length === 0 ? (
                  <div className="text-slate-500">No inventory stock currently assigned to this warehouse.</div>
                ) : (
                  (warehouseInventoryMeta[selected.item.id]?.items || []).map((st) => (
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

          {/* Active Geo Entities List */}
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/80 p-4 space-y-2.5 max-h-[360px] overflow-y-auto">
            <div className="text-sm font-semibold text-slate-900 dark:text-white flex items-center gap-2">
              <Navigation className="w-4 h-4 text-cyan-500" />
              Active Geo Entities ({filteredIncidents.length + validWarehouses.length})
            </div>
            {filteredIncidents.map((inc) => (
              <div
                key={`list-inc-${inc.id}`}
                className="p-2.5 rounded-lg border border-slate-200 dark:border-slate-800 hover:border-cyan-500/60 transition-colors space-y-1.5"
              >
                <button
                  type="button"
                  onClick={() => {
                    setSelected({ kind: 'incident', item: inc });
                    panToPoint(inc.lat, inc.lng, 13);
                    void queryWeatherAt(inc.lat, inc.lng, inc.address);
                  }}
                  className="w-full text-left space-y-0.5"
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
                <div className="flex items-center justify-end gap-2">
                  <button
                    type="button"
                    disabled={planningRoute}
                    onClick={() => {
                      panToPoint(inc.lat, inc.lng);
                      void handlePlanTeamRoute({ lat: inc.lat, lng: inc.lng, label: inc.title }, false);
                    }}
                    className="text-[11px] font-medium text-[#5869E8] dark:text-[#8190FF] hover:underline"
                  >
                    Route Team →
                  </button>
                </div>
              </div>
            ))}
            {validWarehouses.map((wh) => (
              <button
                key={`list-wh-${wh.id}`}
                type="button"
                onClick={() => {
                  setSelected({ kind: 'warehouse', item: wh });
                  panToPoint(wh.lat, wh.lng, 13);
                }}
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
