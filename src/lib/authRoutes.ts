export type AppRouteKind = 'landing' | 'dashboard';

export interface ParsedAppRoute {
  kind: AppRouteKind;
  view: string;
  rawPath: string;
}

export const VALID_DASHBOARD_VIEWS = new Set<string>([
  'overview',
  'map',
  'tactical-3d',
  'incidents',
  'risk',
  'relief',
  'warehouses',
  'inventory',
  'allocations',
  'routes',
  'vehicles',
  'dispatches',
  'ai-command',
  'ai-copilot',
  'agents',
  'workspace',
  'analytics',
  'notifications',
  'organizations',
  'admin',
  'settings',
]);

export function buildDashboardPath(view?: string): string {
  if (!view || view === 'overview' || !VALID_DASHBOARD_VIEWS.has(view)) {
    return '/dashboard';
  }
  return `/dashboard/${view}`;
}

export function parseAppRoute(
  pathnameInput?: string,
  _searchInput?: string,
  hashInput?: string
): ParsedAppRoute {
  const pathname =
    pathnameInput ?? (typeof window !== 'undefined' ? window.location.pathname : '/');
  const hash = hashInput ?? (typeof window !== 'undefined' ? window.location.hash : '');

  const cleanPath = pathname.replace(/\/+$/, '') || '/';

  if (
    cleanPath === '/dashboard' ||
    cleanPath === '/command' ||
    cleanPath === '/login' ||
    cleanPath === '/forgot-password' ||
    cleanPath === '/reset-password' ||
    cleanPath === '/auth/callback'
  ) {
    return { kind: 'dashboard', view: 'overview', rawPath: '/dashboard' };
  }
  if (cleanPath.startsWith('/dashboard/')) {
    const view = cleanPath.slice('/dashboard/'.length);
    const safeView = VALID_DASHBOARD_VIEWS.has(view) ? view : 'overview';
    return {
      kind: 'dashboard',
      view: safeView,
      rawPath: buildDashboardPath(safeView),
    };
  }
  // Support legacy #command deep link cleanly
  if (cleanPath === '/' && hash === '#command') {
    return { kind: 'dashboard', view: 'overview', rawPath: '/dashboard' };
  }

  return { kind: 'landing', view: 'overview', rawPath: '/' };
}

export function navigateTo(targetUrl: string, options: { replace?: boolean } = {}): void {
  if (typeof window === 'undefined') return;
  const current = `${window.location.pathname}${window.location.search}`;
  if (current === targetUrl && !window.location.hash) return;
  if (options.replace) {
    window.history.replaceState({}, '', targetUrl);
  } else {
    window.history.pushState({}, '', targetUrl);
  }
  window.dispatchEvent(new Event('resqflow-route-change'));
}
