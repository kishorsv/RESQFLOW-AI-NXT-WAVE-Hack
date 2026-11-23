import React, { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { onAuthStateChanged, type User } from 'firebase/auth';
import {
  Activity,
  AlertTriangle,
  BarChart3,
  Bell,
  Bot,
  Box,
  Building2,
  ChevronLeft,
  ChevronRight,
  Compass,
  Cpu,
  Flame,
  FolderKanban,
  Gauge,
  Globe,
  LayoutDashboard,
  Loader2,
  Map as MapIcon,
  Menu,
  Moon,
  Radio,
  Route as RouteIcon,
  Search,
  Settings,
  Shield,
  ShieldAlert,
  Sparkles,
  Sun,
  Truck,
  Warehouse as WarehouseIcon,
  X,
} from 'lucide-react';
import {
  apiRequest,
  setApiActor,
  setSessionToken,
  useOfflineSync,
  useRealtimeEvents,
} from './lib/api';
import {
  buildDashboardPath,
  navigateTo,
  parseAppRoute,
  type ParsedAppRoute,
} from './lib/authRoutes';
import { ErrorBoundary } from './components/ErrorBoundary';
import { OfflineSyncPanel } from './components/OfflineSyncPanel';
import { PWAInstallButton } from './components/PWAInstallButton';
import { SessionTimerIndicator } from './components/SessionTimerIndicator';
import { BrandMark } from './components/ui/BrandMark';
import { DashboardSkeleton } from './components/ui/DesignPrimitives';
import {
  auth,
  mapFirebaseAuthError,
  refreshFirebaseIdTokenSilently,
  signInWithGoogleWorkspace,
  subscribeWorkspaceToken,
  syncFirestoreUserProfile,
  testFirestoreConnection,
} from './lib/firebase';
import type {
  AlertRecord,
  Allocation,
  AppNotification,
  AuthUserProfile,
  DataMode,
  Dispatch,
  Incident,
  IntegrationHealth,
  InventoryStock,
  ReliefRequest,
  StockMovement,
  StructuredAIAgentOutput,
  UserRole,
  Vehicle,
  Warehouse,
} from './shared/types';
// Keep public homepage eager for instant first paint
import { LandingView } from './components/views/LandingView';

interface SessionTimingMeta {
  sessionExpiresAt?: string | null;
  sessionDurationMs?: number | null;
  serverNow?: string | null;
}

// Lazy-load heavy authenticated Command Center views so public visitors never download Three.js, Recharts, Maps, or dashboard bundles
const AICommandCenterView = lazy(() =>
  import('./components/views/AICommandCenterView').then((m) => ({ default: m.AICommandCenterView }))
);
const AIIntelligenceView = lazy(() =>
  import('./components/views/AIIntelligenceView').then((m) => ({ default: m.AIIntelligenceView }))
);
const AgentCenterView = lazy(() =>
  import('./components/views/AgentCenterView').then((m) => ({ default: m.AgentCenterView }))
);
const AllocationView = lazy(() =>
  import('./components/views/AllocationView').then((m) => ({ default: m.AllocationView }))
);
const AnalyticsView = lazy(() =>
  import('./components/views/AnalyticsView').then((m) => ({ default: m.AnalyticsView }))
);
const EmergencyMapView = lazy(() =>
  import('./components/views/EmergencyMapView').then((m) => ({ default: m.EmergencyMapView }))
);
const IncidentsView = lazy(() =>
  import('./components/views/IncidentsView').then((m) => ({ default: m.IncidentsView }))
);
const LogisticsDispatchView = lazy(() =>
  import('./components/views/LogisticsDispatchView').then((m) => ({ default: m.LogisticsDispatchView }))
);
const NotificationsView = lazy(() =>
  import('./components/views/NotificationsAdminView').then((m) => ({ default: m.NotificationsView }))
);
const AdminOrgSettingsView = lazy(() =>
  import('./components/views/NotificationsAdminView').then((m) => ({ default: m.AdminOrgSettingsView }))
);
const OverviewView = lazy(() =>
  import('./components/views/OverviewView').then((m) => ({ default: m.OverviewView }))
);
const ReliefRequestsView = lazy(() =>
  import('./components/views/ReliefRequestsView').then((m) => ({ default: m.ReliefRequestsView }))
);
const RiskIntelligenceView = lazy(() =>
  import('./components/views/RiskIntelligenceView').then((m) => ({ default: m.RiskIntelligenceView }))
);
const Tactical3DTwinView = lazy(() =>
  import('./components/views/Tactical3DTwinView').then((m) => ({ default: m.Tactical3DTwinView }))
);
const WarehousesInventoryView = lazy(() =>
  import('./components/views/WarehousesInventoryView').then((m) => ({ default: m.WarehousesInventoryView }))
);
const WorkspaceHubView = lazy(() =>
  import('./components/views/WorkspaceHubView').then((m) => ({ default: m.WorkspaceHubView }))
);

interface NavItem {
  id: string;
  label: string;
  group: 'Command' | 'Operations' | 'Intelligence' | 'Management';
  icon: React.FC<{ className?: string }>;
}

const NAV_ITEMS: NavItem[] = [
  { id: 'overview', label: 'Overview', group: 'Command', icon: LayoutDashboard },
  { id: 'map', label: 'Live Emergency Map', group: 'Command', icon: MapIcon },
  { id: 'tactical-3d', label: '3D Tactical Twin', group: 'Command', icon: Compass },
  { id: 'incidents', label: 'Incidents', group: 'Command', icon: ShieldAlert },
  { id: 'risk', label: 'Risk & Weather Intel', group: 'Command', icon: Gauge },
  { id: 'relief', label: 'Relief Requests', group: 'Operations', icon: Flame },
  { id: 'warehouses', label: 'Warehouses', group: 'Operations', icon: WarehouseIcon },
  { id: 'inventory', label: 'Inventory Ledger', group: 'Operations', icon: Box },
  { id: 'allocations', label: 'Resource Allocation', group: 'Operations', icon: Sparkles },
  { id: 'routes', label: 'Route Optimization', group: 'Operations', icon: RouteIcon },
  { id: 'vehicles', label: 'Fleet Vehicles', group: 'Operations', icon: Truck },
  { id: 'dispatches', label: 'Active Dispatches', group: 'Operations', icon: Activity },
  { id: 'ai-command', label: 'AI Command Center', group: 'Intelligence', icon: Shield },
  { id: 'ai-copilot', label: 'AI Copilot & Voice', group: 'Intelligence', icon: Bot },
  { id: 'agents', label: 'Agent & Media Studio', group: 'Intelligence', icon: Cpu },
  { id: 'workspace', label: 'Google Workspace Hub', group: 'Management', icon: FolderKanban },
  { id: 'analytics', label: 'Analytics & CSV', group: 'Management', icon: BarChart3 },
  { id: 'notifications', label: 'Alerts & Notifications', group: 'Management', icon: Bell },
  { id: 'organizations', label: 'Organizations', group: 'Management', icon: Building2 },
  { id: 'admin', label: 'Admin & Health', group: 'Management', icon: Shield },
  { id: 'settings', label: 'System Settings', group: 'Management', icon: Settings },
];

const AUTH_BROADCAST_CHANNEL = 'resqflow-auth-bus';
const DEFAULT_SESSION_DURATION_MS = 24 * 60 * 60 * 1000;

function broadcastAuthChange(type: 'SIGNED_IN' | 'SIGNED_OUT' | 'ROLE_UPDATED' | 'SESSION_REFRESHED') {
  try {
    if (typeof BroadcastChannel !== 'undefined') {
      const ch = new BroadcastChannel(AUTH_BROADCAST_CHANNEL);
      ch.postMessage({ type, at: Date.now() });
      ch.close();
    }
  } catch {
    // BroadcastChannel unavailable in older runtimes
  }
}

export default function App() {
  const [route, setRoute] = useState<ParsedAppRoute>(() => parseAppRoute());
  const [selectedAISessionId, setSelectedAISessionId] = useState<string | null>(null);
  const [mode, setMode] = useState<DataMode>('demo');
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    if (typeof window === 'undefined') return 'dark';
    try {
      return localStorage.getItem('resqflow_theme') === 'light' ? 'light' : 'dark';
    } catch {
      return 'dark';
    }
  });
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);

  // Direct Workspace Session State Machine: INITIALIZING | AUTHENTICATED | UNAUTHENTICATED
  const [authUser, setAuthUser] = useState<AuthUserProfile | null>(null);
  const [sessionExpiresAt, setSessionExpiresAt] = useState<string | null>(null);
  const [sessionDurationMs, setSessionDurationMs] = useState<number>(DEFAULT_SESSION_DURATION_MS);
  const [serverClockOffsetMs, setServerClockOffsetMs] = useState<number>(0);
  const [authState, setAuthState] = useState<'INITIALIZING' | 'AUTHENTICATED' | 'UNAUTHENTICATED'>('INITIALIZING');
  const [authError, setAuthError] = useState<string | null>(null);
  const [directAccessError, setDirectAccessError] = useState<string | null>(null);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const bootstrapStartedRef = useRef<boolean>(false);
  const directAccessPromiseRef = useRef<Promise<void> | null>(null);
  const recoveryWindowRef = useRef<{ windowStart: number; attempts: number }>({
    windowStart: 0,
    attempts: 0,
  });

  const authLoading = authState === 'INITIALIZING';

  // Firebase User & Workspace OAuth Token State
  const [fbUser, setFbUser] = useState<User | null>(null);
  const [hasWorkspaceToken, setHasWorkspaceToken] = useState(false);

  // Quick-jump search state
  const [searchQuery, setSearchQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const searchRef = useRef<HTMLDivElement>(null);

  // Tier 2 GMP Demo Key Quota Exceeded Banner
  const [mapsQuotaExceeded, setMapsQuotaExceeded] = useState<boolean>(() =>
    Boolean(window.__gmpQuotaExceeded)
  );

  // Operational Store Snapshots
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [requests, setRequests] = useState<ReliefRequest[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [inventory, setInventory] = useState<InventoryStock[]>([]);
  const [movements, setMovements] = useState<StockMovement[]>([]);
  const [allocations, setAllocations] = useState<Allocation[]>([]);
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [dispatches, setDispatches] = useState<Dispatch[]>([]);
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [alerts, setAlerts] = useState<AlertRecord[]>([]);
  const [aiTasks, setAiTasks] = useState<StructuredAIAgentOutput[]>([]);
  const [analytics, setAnalytics] = useState<any>(null);
  const [integrations, setIntegrations] = useState<IntegrationHealth[]>([]);

  const isAuthenticated = Boolean(authUser);
  const activeView = route.kind === 'dashboard' ? route.view : 'overview';
  const role: UserRole = authUser?.role || 'field_responder';

  const clearOperationalSnapshots = useCallback(() => {
    setIncidents([]);
    setRequests([]);
    setWarehouses([]);
    setInventory([]);
    setMovements([]);
    setAllocations([]);
    setVehicles([]);
    setDispatches([]);
    setNotifications([]);
    setAlerts([]);
    setAiTasks([]);
    setAnalytics(null);
    setIntegrations([]);
    setInitialLoading(true);
  }, []);

  // Listen to History API, hashchange, and custom route change events
  useEffect(() => {
    const syncRoute = () => {
      setRoute(parseAppRoute());
    };
    window.addEventListener('popstate', syncRoute);
    window.addEventListener('hashchange', syncRoute);
    window.addEventListener('resqflow-route-change', syncRoute);
    return () => {
      window.removeEventListener('popstate', syncRoute);
      window.removeEventListener('hashchange', syncRoute);
      window.removeEventListener('resqflow-route-change', syncRoute);
    };
  }, []);

  // Apply & persist Dark/Light theme class to html root
  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'dark') {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
    try {
      localStorage.setItem('resqflow_theme', theme);
    } catch {
      // ignore storage quota errors
    }
  }, [theme]);

  // Close search popover on outside click or Escape
  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) {
        setSearchOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setSearchOpen(false);
        setMobileMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, []);

  // Listen for Tier 1 GMP quota events
  useEffect(() => {
    const handler = () => setMapsQuotaExceeded(true);
    window.addEventListener('gmp-quota-exceeded', handler);
    return () => window.removeEventListener('gmp-quota-exceeded', handler);
  }, []);

  const applySessionTiming = useCallback((meta?: SessionTimingMeta | null) => {
    if (!meta) return;
    if (typeof meta.sessionExpiresAt === 'string' && meta.sessionExpiresAt) {
      setSessionExpiresAt(meta.sessionExpiresAt);
    }
    if (typeof meta.sessionDurationMs === 'number' && meta.sessionDurationMs > 0) {
      setSessionDurationMs(meta.sessionDurationMs);
    }
    if (typeof meta.serverNow === 'string' && meta.serverNow) {
      const parsedServerNow = Date.parse(meta.serverNow);
      if (Number.isFinite(parsedServerNow)) {
        setServerClockOffsetMs(parsedServerNow - Date.now());
      }
    }
  }, []);

  // Restore server session cleanly on mount and whenever another tab changes auth state
  const verifyServerSession = useCallback(async (): Promise<AuthUserProfile | null> => {
    try {
      const res = await apiRequest<{
        authenticated: boolean;
        user: AuthUserProfile | null;
        sessionExpiresAt?: string;
        sessionDurationMs?: number;
        serverNow?: string;
      }>('/auth/session');
      if (res.authenticated && res.user) {
        setAuthUser(res.user);
        setAuthState('AUTHENTICATED');
        applySessionTiming({
          sessionExpiresAt: res.sessionExpiresAt,
          sessionDurationMs: res.sessionDurationMs,
          serverNow: res.serverNow,
        });
        return res.user;
      }
      setAuthUser(null);
      setSessionExpiresAt(null);
      return null;
    } catch {
      setAuthUser(null);
      setSessionExpiresAt(null);
      return null;
    }
  }, [applySessionTiming]);

  const establishDirectAccess = useCallback(async (isManualRetry = false) => {
    if (isManualRetry) {
      recoveryWindowRef.current = { windowStart: Date.now(), attempts: 0 };
    }
    if (directAccessPromiseRef.current) {
      return directAccessPromiseRef.current;
    }
    const task = (async () => {
      setDirectAccessError(null);
      try {
        const res = await apiRequest<{
          authenticated: boolean;
          user: AuthUserProfile;
          sessionToken?: string;
          sessionExpiresAt?: string;
          sessionDurationMs?: number;
          serverNow?: string;
        }>('/auth/direct-access', { method: 'POST' });
        if (!res || typeof res !== 'object' || !res.authenticated || !res.user) {
          throw new Error('Unable to initialize direct workspace access. Unexpected server response.');
        }
        if (res.sessionToken) {
          setSessionToken(res.sessionToken);
        }
        setAuthUser(res.user);
        setAuthState('AUTHENTICATED');
        applySessionTiming({
          sessionExpiresAt: res.sessionExpiresAt,
          sessionDurationMs: res.sessionDurationMs,
          serverNow: res.serverNow,
        });
        setAuthError(null);
      } catch (err) {
        setAuthState('UNAUTHENTICATED');
        setDirectAccessError(
          err instanceof Error ? err.message : 'Unable to launch RESQFLOW AI workspace.'
        );
      } finally {
        directAccessPromiseRef.current = null;
      }
    })();
    directAccessPromiseRef.current = task;
    return task;
  }, [applySessionTiming]);

  const handleSessionExpired = useCallback(() => {
    const now = Date.now();
    if (now - recoveryWindowRef.current.windowStart > 15_000) {
      recoveryWindowRef.current = { windowStart: now, attempts: 0 };
    }
    recoveryWindowRef.current.attempts += 1;

    setSessionToken(null);
    setAuthUser(null);
    setSessionExpiresAt(null);
    setAuthState('UNAUTHENTICATED');

    if (parseAppRoute().kind === 'dashboard') {
      if (recoveryWindowRef.current.attempts > 2) {
        setDirectAccessError(
          'Your command session could not be maintained across requests. Click "Retry Launch Platform" to establish a fresh session.'
        );
        return;
      }
      void establishDirectAccess(false);
    } else {
      clearOperationalSnapshots();
    }
  }, [clearOperationalSnapshots, establishDirectAccess]);

  useEffect(() => {
    if (fbUser) {
      testFirestoreConnection().catch(() => {});
    }
  }, [fbUser]);

  useEffect(() => {
    let active = true;

    const bootstrapSession = async () => {
      if (bootstrapStartedRef.current) return;
      bootstrapStartedRef.current = true;
      setAuthState('INITIALIZING');

      try {
        const restored = await verifyServerSession();
        if (!active) return;
        if (restored) {
          setAuthState('AUTHENTICATED');
          return;
        }
        setAuthState('UNAUTHENTICATED');
      } catch {
        if (active) {
          setAuthState('UNAUTHENTICATED');
        }
      }
    };

    void bootstrapSession();

    const unsubAuth = auth
      ? onAuthStateChanged(auth, (u) => {
          setFbUser(u);
        })
      : () => {};
    const unsubToken = subscribeWorkspaceToken((tok) => {
      setHasWorkspaceToken(Boolean(tok));
    });

    // Multi-tab session synchronization
    let channel: BroadcastChannel | null = null;
    try {
      if (typeof BroadcastChannel !== 'undefined') {
        channel = new BroadcastChannel(AUTH_BROADCAST_CHANNEL);
        channel.onmessage = (evt: MessageEvent<{ type?: string }>) => {
          if (
            evt.data?.type === 'SIGNED_IN' ||
            evt.data?.type === 'ROLE_UPDATED' ||
            evt.data?.type === 'SESSION_REFRESHED'
          ) {
            void verifyServerSession();
          }
        };
      }
    } catch {
      // ignore
    }

    window.addEventListener('resqflow-session-expired', handleSessionExpired);

    return () => {
      active = false;
      unsubAuth();
      unsubToken();
      window.removeEventListener('resqflow-session-expired', handleSessionExpired);
      try {
        channel?.close();
      } catch {
        // ignore
      }
    };
  }, [verifyServerSession, handleSessionExpired]);

  // Keep client actor context mirrored strictly for offline optimistic UI metadata
  useEffect(() => {
    if (authUser) {
      setApiActor({
        uid: authUser.uid,
        name: authUser.name,
        email: authUser.email,
        role: authUser.role,
        orgId: authUser.orgId,
      });
    } else {
      setApiActor(null);
    }
  }, [authUser]);

  // Direct platform access for /dashboard routes
  useEffect(() => {
    if (authLoading) return;

    if (route.kind === 'dashboard' && !isAuthenticated && !directAccessError) {
      void establishDirectAccess(false);
    }
  }, [authLoading, isAuthenticated, route.kind, directAccessError, establishDirectAccess]);

  // Safety watchdog so neither initial session check nor direct-access launch can ever hang indefinitely
  useEffect(() => {
    if (route.kind !== 'dashboard') return;
    if (isAuthenticated || directAccessError) return;

    const watchdog = window.setTimeout(() => {
      if (authState === 'INITIALIZING') {
        setAuthState('UNAUTHENTICATED');
      }
      setDirectAccessError((prev) =>
        prev ||
        'Platform startup took longer than expected. Check network connectivity or backend status and click Retry Launch Platform.'
      );
    }, 12_000);

    return () => window.clearTimeout(watchdog);
  }, [route.kind, authState, isAuthenticated, directAccessError]);

  const setActiveView = useCallback((nextView: string) => {
    const targetPath = buildDashboardPath(nextView);
    navigateTo(targetPath);
    if (typeof window !== 'undefined') {
      window.scrollTo({ top: 0 });
    }
  }, []);

  const fetchInFlightRef = useRef<Promise<void> | null>(null);
  const wsDebounceTimerRef = useRef<number | null>(null);
  const wsPendingScopeRef = useRef<'none' | 'inventory' | 'logistics' | 'all'>('none');

  const fetchAllData = useCallback(async () => {
    if (!isAuthenticated) return;
    if (fetchInFlightRef.current) {
      return fetchInFlightRef.current;
    }
    const task = (async () => {
      try {
        const boot = await apiRequest<{
          incidents: Incident[];
          requests: ReliefRequest[];
          warehouses: Warehouse[];
          inventory: InventoryStock[];
          movements: StockMovement[];
          allocations: Allocation[];
          vehicles: Vehicle[];
          dispatches: Dispatch[];
          notifications: AppNotification[];
          alerts: AlertRecord[];
          tasks: StructuredAIAgentOutput[];
          analytics: any;
          integrations: IntegrationHealth[];
        }>(`/bootstrap?mode=${mode}`);
        setIncidents(boot.incidents);
        setRequests(boot.requests);
        setWarehouses(boot.warehouses);
        setInventory(boot.inventory);
        setMovements(boot.movements);
        setAllocations(boot.allocations);
        setVehicles(boot.vehicles);
        setDispatches(boot.dispatches);
        setNotifications(boot.notifications);
        setAlerts(boot.alerts);
        setAiTasks(boot.tasks);
        setAnalytics(boot.analytics);
        setIntegrations(boot.integrations);
        setBootstrapError(null);
      } catch (err) {
        console.error('Failed to refresh operational state:', err);
        setBootstrapError(
          err instanceof Error ? err.message : 'Unable to load live command center data from server.'
        );
      } finally {
        setInitialLoading(false);
        fetchInFlightRef.current = null;
      }
    })();
    fetchInFlightRef.current = task;
    return task;
  }, [isAuthenticated, mode]);

  const refreshInventorySlice = useCallback(async () => {
    if (!isAuthenticated) return;
    try {
      const [wh, inv, req, alrt, notif] = await Promise.all([
        apiRequest<{ warehouses: Warehouse[] }>(`/warehouses?mode=${mode}`),
        apiRequest<{ inventory: InventoryStock[]; movements: StockMovement[] }>(`/inventory?mode=${mode}`),
        apiRequest<{ requests: ReliefRequest[] }>(`/relief-requests?mode=${mode}`),
        apiRequest<{ alerts: AlertRecord[] }>(`/alerts?mode=${mode}`),
        apiRequest<{ notifications: AppNotification[] }>(`/notifications?mode=${mode}`),
      ]);
      setWarehouses(wh.warehouses);
      setInventory(inv.inventory);
      setMovements(inv.movements);
      setRequests(req.requests);
      setAlerts(alrt.alerts);
      setNotifications(notif.notifications);
    } catch (err) {
      console.error('Failed to refresh inventory real-time slice:', err);
    }
  }, [isAuthenticated, mode]);

  const refreshLogisticsSlice = useCallback(async () => {
    if (!isAuthenticated) return;
    try {
      const [alloc, veh, dsp, req, inv, alrt, notif] = await Promise.all([
        apiRequest<{ allocations: Allocation[] }>(`/allocations?mode=${mode}`),
        apiRequest<{ vehicles: Vehicle[] }>(`/vehicles?mode=${mode}`),
        apiRequest<{ dispatches: Dispatch[] }>(`/dispatches?mode=${mode}`),
        apiRequest<{ requests: ReliefRequest[] }>(`/relief-requests?mode=${mode}`),
        apiRequest<{ inventory: InventoryStock[]; movements: StockMovement[] }>(`/inventory?mode=${mode}`),
        apiRequest<{ alerts: AlertRecord[] }>(`/alerts?mode=${mode}`),
        apiRequest<{ notifications: AppNotification[] }>(`/notifications?mode=${mode}`),
      ]);
      setAllocations(alloc.allocations);
      setVehicles(veh.vehicles);
      setDispatches(dsp.dispatches);
      setRequests(req.requests);
      setInventory(inv.inventory);
      setMovements(inv.movements);
      setAlerts(alrt.alerts);
      setNotifications(notif.notifications);
    } catch (err) {
      console.error('Failed to refresh logistics real-time slice:', err);
    }
  }, [isAuthenticated, mode]);

  useEffect(() => {
    if (isAuthenticated) {
      void fetchAllData();
    }
  }, [isAuthenticated, fetchAllData]);

  // Coalesced & debounced realtime refresh (prevents API amplification storms during rapid event bursts)
  const scheduleRealtimeRefresh = useCallback(
    (scope: 'inventory' | 'logistics' | 'all') => {
      const current = wsPendingScopeRef.current;
      if (current === 'none') {
        wsPendingScopeRef.current = scope;
      } else if (current !== scope) {
        wsPendingScopeRef.current = 'all';
      }
      if (wsDebounceTimerRef.current !== null) return;
      wsDebounceTimerRef.current = window.setTimeout(() => {
        wsDebounceTimerRef.current = null;
        const nextScope = wsPendingScopeRef.current;
        wsPendingScopeRef.current = 'none';
        if (nextScope === 'inventory') {
          void refreshInventorySlice();
        } else if (nextScope === 'logistics') {
          void refreshLogisticsSlice();
        } else if (nextScope === 'all') {
          void fetchAllData();
        }
      }, 350);
    },
    [fetchAllData, refreshInventorySlice, refreshLogisticsSlice]
  );

  useEffect(() => {
    return () => {
      if (wsDebounceTimerRef.current !== null) {
        window.clearTimeout(wsDebounceTimerRef.current);
        wsDebounceTimerRef.current = null;
      }
    };
  }, []);

  // Real-time WebSocket event pipeline (strictly gated on active authentication)
  const { connectionState, recentEvents } = useRealtimeEvents((ev) => {
    if (ev.mode !== mode) return;
    if (ev.event_type.startsWith('inventory.') || ev.event_type.startsWith('warehouse.')) {
      scheduleRealtimeRefresh('inventory');
    } else if (
      ev.event_type.startsWith('dispatch.') ||
      ev.event_type.startsWith('allocation.') ||
      ev.event_type.startsWith('delivery.') ||
      ev.event_type.startsWith('fleet.') ||
      ev.event_type.startsWith('route.') ||
      ev.event_type.startsWith('vehicle.')
    ) {
      scheduleRealtimeRefresh('logistics');
    } else {
      scheduleRealtimeRefresh('all');
    }
  }, isAuthenticated);

  // Graceful polling fallback when WebSocket is DEGRADED so command center stays current even if WS is blocked
  useEffect(() => {
    if (!isAuthenticated || connectionState !== 'DEGRADED') return;
    const pollId = window.setInterval(() => {
      if (typeof document === 'undefined' || !document.hidden) {
        void fetchAllData();
      }
    }, 30_000);
    return () => window.clearInterval(pollId);
  }, [isAuthenticated, connectionState, fetchAllData]);

  // Persistent Offline Action Queue auto-sync lifecycle (strictly gated on authentication)
  const offlineSync = useOfflineSync(
    (result) => {
      if (result.syncedCount > 0) {
        void fetchAllData();
      }
    },
    connectionState,
    isAuthenticated
  );

  // Explicitly extend active server session (+24h) and refresh Firebase token if linked
  const handleRefreshSession = useCallback(async () => {
    await refreshFirebaseIdTokenSilently();
    const res = await apiRequest<{
      ok: boolean;
      authenticated: boolean;
      user: AuthUserProfile;
      sessionExpiresAt?: string;
      sessionDurationMs?: number;
      serverNow?: string;
    }>('/auth/refresh', {
      method: 'POST',
    });
    if (res.user) {
      setAuthUser(res.user);
    }
    applySessionTiming({
      sessionExpiresAt: res.sessionExpiresAt,
      sessionDurationMs: res.sessionDurationMs,
      serverNow: res.serverNow,
    });
    broadcastAuthChange('SESSION_REFRESHED');
  }, [applySessionTiming]);

  // Opt-in Google Workspace scope authorization inside WorkspaceHubView
  const handleConnectGoogleWorkspace = useCallback(async () => {
    setAuthError(null);
    try {
      const { user, idToken } = await signInWithGoogleWorkspace(true);
      if (!authUser) {
        const res = await apiRequest<{
          authenticated: boolean;
          user: AuthUserProfile;
          sessionToken?: string;
          sessionExpiresAt?: string;
          sessionDurationMs?: number;
          serverNow?: string;
        }>('/auth/firebase-exchange', {
          method: 'POST',
          body: { idToken },
        });
        await syncFirestoreUserProfile(user, res.user.role);
        setSessionToken(res.sessionToken || null);
        setAuthUser(res.user);
        setAuthState('AUTHENTICATED');
        applySessionTiming({
          sessionExpiresAt: res.sessionExpiresAt,
          sessionDurationMs: res.sessionDurationMs,
          serverNow: res.serverNow,
        });
        broadcastAuthChange('SIGNED_IN');
      }
    } catch (err) {
      setAuthError(mapFirebaseAuthError(err));
    }
  }, [authUser, applySessionTiming]);

  // Server-enforced role perspective switching (Super Admin only)
  const handleChangeRole = useCallback(async (nextRole: UserRole) => {
    const res = await apiRequest<{ ok: boolean; user: AuthUserProfile }>('/auth/role', {
      method: 'PATCH',
      body: { role: nextRole },
    });
    setAuthUser(res.user);
    broadcastAuthChange('ROLE_UPDATED');
  }, []);

  const handleEnterCommand = useCallback(
    (targetView?: string) => {
      const targetPath = buildDashboardPath(targetView);
      recoveryWindowRef.current = { windowStart: Date.now(), attempts: 0 };
      setDirectAccessError(null);
      navigateTo(targetPath);
      if (!isAuthenticated && !authLoading) {
        void establishDirectAccess(true);
      }
      if (typeof window !== 'undefined') {
        window.scrollTo({ top: 0 });
      }
    },
    [isAuthenticated, authLoading, establishDirectAccess]
  );

  const handleReturnLanding = useCallback(() => {
    navigateTo('/');
    if (typeof window !== 'undefined') {
      window.scrollTo({ top: 0 });
    }
  }, []);

  // Quick-jump filtered results (modules + real incidents + real warehouses)
  const searchResults = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return [];
    const navMatches = NAV_ITEMS.filter(
      (n) => n.label.toLowerCase().includes(q) || n.group.toLowerCase().includes(q)
    )
      .slice(0, 4)
      .map((n) => ({
        id: `nav-${n.id}`,
        title: n.label,
        subtitle: `Module · ${n.group}`,
        targetView: n.id,
      }));
    const incMatches = incidents
      .filter((i) => i.title.toLowerCase().includes(q) || i.region.toLowerCase().includes(q))
      .slice(0, 3)
      .map((i) => ({
        id: `inc-${i.id}`,
        title: i.title,
        subtitle: `Incident · ${i.severity} · ${i.region}`,
        targetView: 'incidents',
      }));
    const whMatches = warehouses
      .filter((w) => w.name.toLowerCase().includes(q) || w.location.toLowerCase().includes(q))
      .slice(0, 3)
      .map((w) => ({
        id: `wh-${w.id}`,
        title: w.name,
        subtitle: `Warehouse · ${w.status}`,
        targetView: 'warehouses',
      }));
    return [...navMatches, ...incMatches, ...whMatches].slice(0, 8);
  }, [searchQuery, incidents, warehouses]);

  // 1. Public Cinematic Homepage (loads immediately without waiting for protected data)
  if (route.kind === 'landing') {
    return (
      <LandingView
        theme={theme}
        onToggleTheme={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
        onEnterApp={handleEnterCommand}
        mode={mode}
        connectionState={connectionState}
        liveCounts={{
          incidents: incidents.length,
          warehouses: warehouses.length,
          requests: requests.length,
          dispatches: dispatches.length,
        }}
      />
    );
  }

  // 2. Session Loading Guard
  if (authLoading) {
    return (
      <div className="min-h-screen bg-[#070B14] text-[#F7F9FF] flex flex-col items-center justify-center p-6">
        <div className="flex flex-col items-center gap-4 max-w-xs text-center">
          <BrandMark size={40} />
          <div className="flex items-center gap-2.5 text-sm font-medium text-[#CBD5E1]">
            <Loader2 className="w-4 h-4 animate-spin text-[#7185FF]" />
            <span>Initializing RESQFLOW AI Command Center...</span>
          </div>
          <button
            type="button"
            onClick={() => {
              setAuthState('UNAUTHENTICATED');
              void establishDirectAccess(true);
            }}
            className="text-xs text-[#94A3B8] hover:text-white underline underline-offset-4 transition-colors"
          >
            Taking too long? Launch Workspace Now
          </button>
        </div>
      </div>
    );
  }

  // 3. Direct Dashboard Initialization Screen (opens directly without sign-in requirement)
  if (!isAuthenticated || !authUser) {
    return (
      <div className="min-h-screen bg-[#070B14] text-[#F7F9FF] flex flex-col items-center justify-center p-6">
        <div className="flex flex-col items-center gap-4 text-center max-w-md rounded-2xl border border-[#1E293B] bg-[#0B1221] p-6 shadow-xl">
          <BrandMark size={36} />
          {directAccessError ? (
            <>
              <div className="space-y-1.5">
                <div className="text-sm font-semibold text-[#FFB3BD]">Command Center Launch Failed</div>
                <p className="text-xs text-[#CBD5E1] leading-relaxed">{directAccessError}</p>
              </div>
              <div className="flex flex-wrap items-center justify-center gap-2.5">
                <button
                  type="button"
                  onClick={() => void establishDirectAccess(true)}
                  className="px-4 h-10 rounded-[10px] bg-[#7185FF] hover:bg-[#8294FF] text-white text-sm font-semibold transition-colors"
                >
                  Retry Launch Platform
                </button>
                <button
                  type="button"
                  onClick={handleReturnLanding}
                  className="px-4 h-10 rounded-[10px] border border-[#334155] hover:border-[#475569] text-[#CBD5E1] hover:text-white text-sm font-medium transition-colors"
                >
                  Back to Home
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="flex items-center gap-2.5 text-sm font-medium text-[#CBD5E1]">
                <Loader2 className="w-4 h-4 animate-spin text-[#7185FF]" />
                <span>Launching RESQFLOW AI Command Center...</span>
              </div>
              <p className="text-xs text-[#94A3B8]">
                Establishing secure command session and synchronizing live sector telemetry.
              </p>
            </>
          )}
        </div>
      </div>
    );
  }

  const activeAlertCount = alerts.filter((a) => a.status !== 'RESOLVED').length;
  const unreadAlerts = Math.max(activeAlertCount, notifications.filter((n) => !n.read).length);
  const groups: NavItem['group'][] = ['Command', 'Operations', 'Intelligence', 'Management'];
  const currentNav = NAV_ITEMS.find((n) => n.id === activeView) || NAV_ITEMS[0];

  const renderSidebarContent = (compact: boolean) => (
    <div className="flex flex-col h-full bg-[var(--rf-bg-sidebar)]">
      {/* Brand Lockup */}
      <div className="h-[64px] px-4 border-b border-[var(--rf-border-default)] flex items-center justify-between gap-2 shrink-0">
        <button
          type="button"
          onClick={() => {
            setActiveView('overview');
            setMobileMenuOpen(false);
          }}
          className="flex items-center gap-2.5 min-w-0 text-left"
          title="RESQFLOW AI Command Overview"
        >
          <BrandMark size={28} />
          {!compact && (
            <div className="min-w-0">
              <div className="font-[var(--font-display)] text-[15px] font-bold tracking-tight text-[var(--rf-text-primary)] truncate">
                RESQFLOW AI
              </div>
              <div className="text-[11px] text-[var(--rf-text-muted)] truncate">
                Midnight Command
              </div>
            </div>
          )}
        </button>

        <button
          type="button"
          onClick={() => setSidebarCollapsed((c) => !c)}
          className="hidden lg:inline-flex items-center justify-center w-7 h-7 rounded-lg text-[var(--rf-text-muted)] hover:text-[var(--rf-text-primary)] hover:bg-[var(--rf-surface-hover)] transition-colors shrink-0"
          title={compact ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-label={compact ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {compact ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
        </button>

        <button
          type="button"
          onClick={() => setMobileMenuOpen(false)}
          className="lg:hidden p-1.5 rounded-lg text-[var(--rf-text-muted)] hover:text-[var(--rf-text-primary)]"
          aria-label="Close navigation menu"
        >
          <X className="w-5 h-5" />
        </button>
      </div>

      {/* Navigation Groups */}
      <nav aria-label="Command Center Navigation" className="flex-1 overflow-y-auto px-3 py-4 space-y-5">
        {groups.map((grp) => (
          <div key={grp} className="space-y-1">
            {!compact && (
              <div className="px-3 pb-1 text-[11px] font-semibold tracking-[0.08em] uppercase text-[var(--rf-text-muted)]">
                {grp}
              </div>
            )}
            {NAV_ITEMS.filter((n) => n.group === grp).map((item) => {
              const Icon = item.icon;
              const isActive = activeView === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => {
                    setActiveView(item.id);
                    setMobileMenuOpen(false);
                  }}
                  title={compact ? item.label : undefined}
                  className={`relative w-full flex items-center ${
                    compact ? 'justify-center px-2' : 'justify-between px-3'
                  } h-[38px] rounded-[10px] text-[13.5px] font-medium transition-all duration-150 ${
                    isActive
                      ? 'bg-[#5869E8]/12 dark:bg-[#6D7CFF]/16 text-[#5869E8] dark:text-white'
                      : 'text-[var(--rf-text-secondary)] hover:bg-[var(--rf-surface-hover)] hover:text-[var(--rf-text-primary)]'
                  }`}
                >
                  {isActive && (
                    <span
                      className="absolute left-0 top-2 bottom-2 w-[3px] rounded-r-full bg-[#5869E8] dark:bg-[#6D7CFF]"
                      aria-hidden="true"
                    />
                  )}
                  <span className="flex items-center gap-2.5 min-w-0">
                    <Icon
                      className={`w-4 h-4 shrink-0 ${
                        isActive ? 'text-[#5869E8] dark:text-[#8190FF]' : 'text-[var(--rf-text-muted)]'
                      }`}
                    />
                    {!compact && <span className="truncate">{item.label}</span>}
                  </span>
                  {!compact && item.id === 'notifications' && unreadAlerts > 0 && (
                    <span className="font-mono text-[11px] font-semibold text-[#E5465D] dark:text-[#FF5C70] tabular-nums shrink-0">
                      {unreadAlerts}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        ))}
      </nav>

      {/* Sidebar Bottom Utility & Operator Identity */}
      <div className="p-3 border-t border-[var(--rf-border-default)] space-y-2.5 shrink-0">
        <button
          type="button"
          onClick={handleReturnLanding}
          title="Return to RESQFLOW AI Landing Page"
          className={`w-full flex items-center ${
            compact ? 'justify-center px-2' : 'justify-between px-3'
          } h-9 rounded-[10px] text-xs font-medium text-[var(--rf-text-muted)] hover:text-[var(--rf-text-primary)] hover:bg-[var(--rf-surface-hover)] border border-[var(--rf-border-default)] transition-colors`}
        >
          <span className="flex items-center gap-2 truncate">
            <Globe className="w-3.5 h-3.5 shrink-0 text-[#5869E8] dark:text-[#35C8F5]" />
            {!compact && <span className="truncate">Platform Showcase</span>}
          </span>
          {!compact && <ChevronRight className="w-3.5 h-3.5 shrink-0" />}
        </button>

        {!compact && (
          <div className="px-3 py-2.5 rounded-[12px] bg-[var(--rf-bg-secondary)] border border-[var(--rf-border-default)] space-y-1 text-[11.5px]">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[var(--rf-text-muted)]">Active Role</span>
              <span className="font-medium text-[var(--rf-text-primary)] capitalize truncate">
                {role.replace(/_/g, ' ')}
              </span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-[var(--rf-text-muted)]">Workspace</span>
              <span
                className={
                  hasWorkspaceToken
                    ? 'text-[#15966C] dark:text-[#35D6A0] font-medium'
                    : 'text-[var(--rf-text-muted)]'
                }
              >
                {hasWorkspaceToken ? 'Connected' : 'Optional'}
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );

  return (
    <div className="rf-workspace min-h-screen bg-[var(--rf-bg-page)] text-[var(--rf-text-primary)] flex flex-col">
      {/* Tier 2 Google Maps Demo Key Quota Exceeded Banner */}
      {mapsQuotaExceeded && (
        <div className="bg-amber-50 border-b border-amber-200 text-amber-900 px-4 py-2.5 text-xs md:text-sm text-center sticky top-0 z-50 shadow-sm flex flex-wrap items-center justify-center gap-3">
          <span className="inline-flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0 text-amber-700" />
            <span>
              Google Maps Platform quota reached. If you are the app owner, visit{' '}
              <a
                href="https://developers.google.com/maps/ai/ai-studio?utm_campaign=gmp_mcp_codeassist_v1_aistudio#quota_exceeded_errors"
                target="_blank"
                rel="noopener noreferrer"
                className="underline font-semibold text-amber-950 hover:text-amber-800"
              >
                maps developer site
              </a>{' '}
              for instructions to update your account.
            </span>
          </span>
          <button
            type="button"
            onClick={() => setMapsQuotaExceeded(false)}
            className="underline font-medium text-amber-900 hover:text-amber-950"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Honest Demo Mode Isolation Strip */}
      {mode === 'demo' && (
        <div className="bg-[#B97716]/12 dark:bg-[#FFB547]/10 border-b border-[#B97716]/25 dark:border-[#FFB547]/20 px-4 sm:px-6 py-1.5 text-xs text-[#925C0E] dark:text-[#FFB547] flex flex-wrap items-center justify-between gap-2">
          <span className="font-medium">
            Demo Sandbox Mode — Isolated training dataset active (not live operational data)
          </span>
          <button
            type="button"
            onClick={() => setMode('operational')}
            className="font-semibold underline hover:opacity-80 whitespace-nowrap"
          >
            Switch to Operational Mode
          </button>
        </div>
      )}

      <div className="flex flex-1 min-h-0">
        {/* Desktop Sidebar */}
        <aside
          className={`hidden lg:block shrink-0 border-r border-[var(--rf-border-default)] transition-[width] duration-200 ${
            sidebarCollapsed ? 'w-[76px]' : 'w-[256px]'
          }`}
        >
          <div className="sticky top-0 h-screen">{renderSidebarContent(sidebarCollapsed)}</div>
        </aside>

        {/* Mobile Slide-Over Drawer */}
        {mobileMenuOpen && (
          <div className="fixed inset-0 z-50 lg:hidden flex">
            <div className="w-[264px] border-r border-[var(--rf-border-default)] h-full shadow-2xl">
              {renderSidebarContent(false)}
            </div>
            <div
              className="flex-1 bg-[#080D18]/70 backdrop-blur-[2px]"
              onClick={() => setMobileMenuOpen(false)}
            />
          </div>
        )}

        {/* Main Workspace Column */}
        <div className="flex-1 flex flex-col min-w-0">
          {/* Refined Top Command Bar (64px) */}
          <header className="h-[64px] border-b border-[var(--rf-border-default)] bg-[var(--rf-bg-topbar)] backdrop-blur-md px-4 sm:px-6 flex items-center justify-between gap-3 sticky top-0 z-30">
            {/* Left: Menu + Contextual Breadcrumb + Quick Jump Search */}
            <div className="flex items-center gap-3 min-w-0">
              <button
                type="button"
                onClick={() => setMobileMenuOpen(true)}
                className="lg:hidden p-2 rounded-[10px] border border-[var(--rf-border-default)] text-[var(--rf-text-secondary)] hover:bg-[var(--rf-surface-hover)]"
                aria-label="Open navigation menu"
              >
                <Menu className="w-4 h-4" />
              </button>

              <div className="hidden md:flex items-center gap-2 text-[13px] whitespace-nowrap shrink-0">
                <span className="text-[var(--rf-text-muted)]">{currentNav.group}</span>
                <span className="text-[var(--rf-text-muted)]/60">/</span>
                <span className="font-semibold text-[var(--rf-text-primary)]">{currentNav.label}</span>
              </div>

              {/* Functional Quick-Jump Search */}
              <div ref={searchRef} className="relative hidden xl:block ml-3 w-64">
                <Search className="w-3.5 h-3.5 text-[var(--rf-text-muted)] absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  type="search"
                  value={searchQuery}
                  onFocus={() => setSearchOpen(true)}
                  onChange={(e) => {
                    setSearchQuery(e.target.value);
                    setSearchOpen(true);
                  }}
                  placeholder="Jump to module, incident, depot..."
                  aria-label="Search modules, incidents, and warehouses"
                  className="w-full h-9 pl-8 pr-3 rounded-[10px] border border-[var(--rf-border-default)] bg-[var(--rf-bg-secondary)] text-xs text-[var(--rf-text-primary)] placeholder:text-[var(--rf-text-muted)] focus:border-[var(--rf-border-focus)] focus:outline-none transition-colors"
                />
                {searchOpen && searchQuery.trim().length > 0 && (
                  <div className="absolute left-0 right-0 mt-1.5 rounded-xl border border-[var(--rf-border-strong)] bg-[var(--rf-surface-elevated)] shadow-[var(--rf-shadow-elevated)] overflow-hidden z-50">
                    {searchResults.length === 0 ? (
                      <div className="px-3.5 py-3 text-xs text-[var(--rf-text-muted)]">
                        No matching modules or records found.
                      </div>
                    ) : (
                      searchResults.map((res) => (
                        <button
                          key={res.id}
                          type="button"
                          onClick={() => {
                            setActiveView(res.targetView);
                            setSearchQuery('');
                            setSearchOpen(false);
                          }}
                          className="w-full text-left px-3.5 py-2.5 hover:bg-[var(--rf-surface-hover)] border-b border-[var(--rf-border-default)] last:border-0 transition-colors"
                        >
                          <div className="text-xs font-medium text-[var(--rf-text-primary)] truncate">
                            {res.title}
                          </div>
                          <div className="text-[11px] text-[var(--rf-text-muted)] truncate">
                            {res.subtitle}
                          </div>
                        </button>
                      ))
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* Right: Real-Time Status, Mode Switch, Offline Queue, Theme, Alerts, Profile */}
            <div className="flex items-center gap-2 shrink-0">
              {/* Real WebSocket Connection State */}
              <div
                className="hidden sm:flex items-center gap-1.5 px-2.5 h-9 rounded-[10px] border border-[var(--rf-border-default)] bg-[var(--rf-bg-secondary)] text-xs font-mono"
                title="Live WebSocket connection state"
              >
                <Radio
                  className={`w-3.5 h-3.5 ${
                    connectionState === 'LIVE'
                      ? 'text-[#15966C] dark:text-[#35D6A0]'
                      : connectionState === 'OFFLINE'
                      ? 'text-[#E5465D] dark:text-[#FF5C70]'
                      : 'text-[#B97716] dark:text-[#FFB547]'
                  }`}
                />
                <span
                  className={`font-semibold ${
                    connectionState === 'LIVE'
                      ? 'text-[#15966C] dark:text-[#35D6A0]'
                      : connectionState === 'OFFLINE'
                      ? 'text-[#E5465D] dark:text-[#FF5C70]'
                      : 'text-[#B97716] dark:text-[#FFB547]'
                  }`}
                >
                  {connectionState}
                </span>
              </div>

              {/* Demo / Operational Segmented Control */}
              <div className="hidden sm:flex items-center rounded-[10px] border border-[var(--rf-border-default)] bg-[var(--rf-bg-secondary)] p-0.5 text-xs font-medium">
                <button
                  type="button"
                  onClick={() => setMode('demo')}
                  className={`px-2.5 h-8 rounded-[8px] transition-colors whitespace-nowrap ${
                    mode === 'demo'
                      ? 'bg-[var(--rf-surface-elevated)] text-[#B97716] dark:text-[#FFB547] shadow-xs'
                      : 'text-[var(--rf-text-muted)] hover:text-[var(--rf-text-primary)]'
                  }`}
                >
                  Demo
                </button>
                <button
                  type="button"
                  onClick={() => setMode('operational')}
                  className={`px-2.5 h-8 rounded-[8px] transition-colors whitespace-nowrap ${
                    mode === 'operational'
                      ? 'bg-[var(--rf-surface-elevated)] text-[#15966C] dark:text-[#35D6A0] shadow-xs'
                      : 'text-[var(--rf-text-muted)] hover:text-[var(--rf-text-primary)]'
                  }`}
                >
                  Operational
                </button>
              </div>

              <OfflineSyncPanel
                queuedActions={offlineSync.queuedActions}
                isSyncing={offlineSync.isSyncing}
                isOffline={offlineSync.isOffline}
                browserOnline={offlineSync.browserOnline}
                simulatedOffline={offlineSync.simulatedOffline}
                lastSyncResult={offlineSync.lastSyncResult}
                onSyncNow={() => offlineSync.triggerSync(false)}
                onClearLastResult={offlineSync.clearLastSyncResult}
              />

              <PWAInstallButton />

              <button
                type="button"
                onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
                className="w-9 h-9 inline-flex items-center justify-center rounded-[10px] border border-[var(--rf-border-default)] bg-[var(--rf-surface-elevated)] text-[var(--rf-text-secondary)] hover:border-[var(--rf-border-active)] hover:text-[var(--rf-text-primary)] transition-colors"
                title="Toggle Light / Dark theme"
                aria-label="Toggle Light and Dark theme"
              >
                {theme === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
              </button>

              <button
                type="button"
                onClick={() => setActiveView('notifications')}
                className="relative w-9 h-9 inline-flex items-center justify-center rounded-[10px] border border-[var(--rf-border-default)] bg-[var(--rf-surface-elevated)] text-[var(--rf-text-secondary)] hover:border-[var(--rf-border-active)] hover:text-[var(--rf-text-primary)] transition-colors"
                title="Operational alerts"
                aria-label="Operational alerts"
              >
                <Bell className="w-4 h-4" />
                {unreadAlerts > 0 && (
                  <span className="absolute -top-1 -right-1 min-w-[16px] h-4 px-1 rounded-full bg-[#E5465D] dark:bg-[#FF465A] text-[10px] font-mono font-semibold text-white flex items-center justify-center tabular-nums">
                    {unreadAlerts}
                  </span>
                )}
              </button>

              <SessionTimerIndicator
                expiresAt={sessionExpiresAt}
                totalDurationMs={sessionDurationMs}
                clockOffsetMs={serverClockOffsetMs}
                userEmail={authUser.email}
                onRefreshSession={handleRefreshSession}
                onSessionExpired={handleSessionExpired}
              />

              <div className="flex items-center gap-2 pl-2 border-l border-[var(--rf-border-default)]">
                <div className="hidden md:block text-right">
                  <div className="text-xs font-semibold text-[var(--rf-text-primary)] leading-tight">
                    {authUser.name}
                  </div>
                  <div className="text-[11px] text-[var(--rf-text-muted)] truncate max-w-[150px]">
                    {authUser.email}
                  </div>
                </div>
              </div>
            </div>
          </header>

          {authError && (
            <div className="mx-4 sm:mx-7 mt-4 p-3.5 rounded-xl border border-[#E5465D]/40 bg-[#E5465D]/10 text-xs text-[#E5465D] dark:text-[#FF8A98] flex items-center justify-between gap-3">
              <span>{authError}</span>
              <button
                type="button"
                onClick={() => setAuthError(null)}
                aria-label="Dismiss authentication message"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          )}

          {bootstrapError && (
            <div className="mx-4 sm:mx-7 mt-4 p-3.5 rounded-xl border border-amber-500/40 bg-amber-500/10 text-xs text-amber-800 dark:text-amber-200 flex flex-wrap items-center justify-between gap-3">
              <span className="flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 shrink-0 text-amber-500" />
                <span>Operational data sync issue: {bootstrapError}</span>
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setBootstrapError(null);
                    void fetchAllData();
                  }}
                  className="px-3 py-1 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 font-semibold transition-colors"
                >
                  Retry Sync
                </button>
                <button
                  type="button"
                  onClick={() => setBootstrapError(null)}
                  aria-label="Dismiss sync warning"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>
          )}

          {/* Active Command View — Isolated ErrorBoundary + Suspense per lazy-loaded module */}
          <main className="flex-1 p-4 sm:p-6 lg:p-8 max-w-[1560px] w-full mx-auto rf-animate-in">
            <ErrorBoundary inline resetKey={activeView}>
              <Suspense fallback={<DashboardSkeleton />}>
                {activeView === 'overview' &&
                  (initialLoading && !analytics ? (
                    <DashboardSkeleton />
                  ) : (
                    <OverviewView
                      mode={mode}
                      analytics={analytics}
                      incidents={incidents}
                      warehouses={warehouses}
                      notifications={notifications}
                      recentEvents={recentEvents}
                      integrations={integrations}
                      connectionState={connectionState}
                      onNavigate={setActiveView}
                      onRefresh={fetchAllData}
                    />
                  ))}
                {activeView === 'map' && (
                  <EmergencyMapView
                    mode={mode}
                    incidents={incidents}
                    warehouses={warehouses}
                    inventory={inventory}
                    reliefRequests={requests}
                    dispatches={dispatches}
                    vehicles={vehicles}
                    mapsQuotaExceeded={mapsQuotaExceeded}
                    onNavigate={setActiveView}
                  />
                )}
                {activeView === 'tactical-3d' && (
                  <Tactical3DTwinView
                    mode={mode}
                    incidents={incidents}
                    warehouses={warehouses}
                    dispatches={dispatches}
                    onOpenIncidents={() => setActiveView('incidents')}
                  />
                )}
                {activeView === 'incidents' && (
                  <IncidentsView
                    mode={mode}
                    incidents={incidents}
                    onRefresh={fetchAllData}
                    onOpenAICommand={(sessionId) => {
                      setSelectedAISessionId(sessionId || null);
                      setActiveView('ai-command');
                    }}
                  />
                )}
                {activeView === 'risk' && (
                  <RiskIntelligenceView mode={mode} incidents={incidents} onRefresh={fetchAllData} />
                )}
                {activeView === 'relief' && (
                  <ReliefRequestsView
                    mode={mode}
                    requests={requests}
                    incidents={incidents}
                    onRefresh={fetchAllData}
                    onNavigate={setActiveView}
                  />
                )}
                {(activeView === 'warehouses' || activeView === 'inventory') && (
                  <WarehousesInventoryView
                    key={activeView}
                    mode={mode}
                    initialTab={activeView === 'warehouses' ? 'warehouses' : 'inventory'}
                    warehouses={warehouses}
                    inventory={inventory}
                    movements={movements}
                    onRefresh={fetchAllData}
                    onNavigate={setActiveView}
                  />
                )}
                {activeView === 'allocations' && (
                  <AllocationView
                    mode={mode}
                    allocations={allocations}
                    requests={requests}
                    vehicles={vehicles}
                    warehouses={warehouses}
                    onRefresh={fetchAllData}
                    onNavigate={setActiveView}
                  />
                )}
                {(activeView === 'routes' || activeView === 'vehicles' || activeView === 'dispatches') && (
                  <LogisticsDispatchView
                    key={activeView}
                    mode={mode}
                    initialTab={activeView}
                    warehouses={warehouses}
                    incidents={incidents}
                    requests={requests}
                    allocations={allocations}
                    vehicles={vehicles}
                    dispatches={dispatches}
                    onRefresh={fetchAllData}
                  />
                )}
                {activeView === 'ai-command' && (
                  <AICommandCenterView
                    mode={mode}
                    incidents={incidents}
                    initialSessionId={selectedAISessionId}
                    onRefresh={fetchAllData}
                  />
                )}
                {activeView === 'ai-copilot' && <AIIntelligenceView mode={mode} incidents={incidents} />}
                {activeView === 'agents' && (
                  <AgentCenterView mode={mode} tasks={aiTasks} onRefresh={fetchAllData} />
                )}
                {activeView === 'workspace' && (
                  <WorkspaceHubView
                    firebaseUid={fbUser?.uid || authUser.firebaseUid || null}
                    hasWorkspaceToken={hasWorkspaceToken}
                    onSignInGoogle={handleConnectGoogleWorkspace}
                    incidents={incidents}
                    requests={requests}
                    inventory={inventory}
                  />
                )}
                {activeView === 'analytics' && (
                  <AnalyticsView
                    mode={mode}
                    analytics={analytics}
                    warehouses={warehouses}
                    onNavigate={setActiveView}
                  />
                )}
                {activeView === 'notifications' && (
                  <NotificationsView
                    mode={mode}
                    notifications={notifications}
                    alerts={alerts}
                    onRefresh={fetchAllData}
                  />
                )}
                {(activeView === 'organizations' || activeView === 'admin' || activeView === 'settings') && (
                  <AdminOrgSettingsView
                    mode={mode}
                    initialSection={activeView}
                    currentRole={role}
                    baseRole={authUser.baseRole}
                    userProvider={authUser.provider}
                    onChangeRole={handleChangeRole}
                    onChangeMode={setMode}
                    theme={theme}
                    onToggleTheme={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
                    integrations={integrations}
                    onRefresh={fetchAllData}
                  />
                )}
              </Suspense>
            </ErrorBoundary>
          </main>
        </div>
      </div>
    </div>
  );
}
