export type AppRouteKind =
  | 'landing'
  | 'login'
  | 'forgot-password'
  | 'reset-password'
  | 'auth-callback'
  | 'dashboard';

export interface ParsedAppRoute {
  kind: AppRouteKind;
  view: string;
  next: string | null;
  resetToken: string | null;
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

const AUTH_PATHS = new Set([
  '/login',
  '/forgot-password',
  '/reset-password',
  '/auth/callback',
]);

/**
 * Validates and normalizes a return-to path to prevent open redirects,
 * nonexistent routes, and login redirect loops.
 */
export function sanitizeReturnPath(raw: string | null | undefined, fallback = '/dashboard'): string {
  if (!raw || typeof raw !== 'string') return fallback;
  const trimmed = raw.trim();
  if (!trimmed.startsWith('/') || trimmed.startsWith('//') || trimmed.includes('\\')) {
    return fallback;
  }
  if (/^\/(https?:|javascript:|data:)/i.test(trimmed)) {
    return fallback;
  }

  let pathname = trimmed;
  try {
    const u = new URL(trimmed, 'http://resqflow.local');
    if (u.origin !== 'http://resqflow.local') return fallback;
    pathname = u.pathname;
  } catch {
    return fallback;
  }

  const normalized = pathname.replace(/\/+$/, '') || '/';
  if (AUTH_PATHS.has(normalized) || normalized === '/') {
    return fallback;
  }

  if (normalized === '/dashboard' || normalized === '/command') {
    return '/dashboard';
  }

  if (normalized.startsWith('/dashboard/')) {
    const view = normalized.slice('/dashboard/'.length);
    if (VALID_DASHBOARD_VIEWS.has(view)) {
      return `/dashboard/${view}`;
    }
    return '/dashboard';
  }

  return fallback;
}

export function buildDashboardPath(view?: string): string {
  if (!view || view === 'overview' || !VALID_DASHBOARD_VIEWS.has(view)) {
    return '/dashboard';
  }
  return `/dashboard/${view}`;
}

export function buildLoginUrl(nextPath?: string | null): string {
  if (!nextPath) return '/login';
  const safeNext = sanitizeReturnPath(nextPath, '/dashboard');
  if (safeNext === '/dashboard') {
    return '/login?next=%2Fdashboard';
  }
  return `/login?next=${encodeURIComponent(safeNext)}`;
}

export function parseAppRoute(
  pathnameInput?: string,
  searchInput?: string,
  hashInput?: string
): ParsedAppRoute {
  const pathname =
    pathnameInput ?? (typeof window !== 'undefined' ? window.location.pathname : '/');
  const search = searchInput ?? (typeof window !== 'undefined' ? window.location.search : '');
  const hash = hashInput ?? (typeof window !== 'undefined' ? window.location.hash : '');

  const cleanPath = pathname.replace(/\/+$/, '') || '/';
  const params = new URLSearchParams(search);
  const next = params.get('next');
  const resetToken = params.get('token');

  if (cleanPath === '/login') {
    return { kind: 'login', view: 'overview', next, resetToken: null, rawPath: cleanPath };
  }
  if (cleanPath === '/forgot-password') {
    return { kind: 'forgot-password', view: 'overview', next, resetToken: null, rawPath: cleanPath };
  }
  if (cleanPath === '/reset-password') {
    return { kind: 'reset-password', view: 'overview', next, resetToken, rawPath: cleanPath };
  }
  if (cleanPath === '/auth/callback') {
    return { kind: 'auth-callback', view: 'overview', next, resetToken: null, rawPath: cleanPath };
  }
  if (cleanPath === '/dashboard' || cleanPath === '/command') {
    return { kind: 'dashboard', view: 'overview', next: null, resetToken: null, rawPath: '/dashboard' };
  }
  if (cleanPath.startsWith('/dashboard/')) {
    const view = cleanPath.slice('/dashboard/'.length);
    const safeView = VALID_DASHBOARD_VIEWS.has(view) ? view : 'overview';
    return {
      kind: 'dashboard',
      view: safeView,
      next: null,
      resetToken: null,
      rawPath: buildDashboardPath(safeView),
    };
  }
  // Support legacy #command deep link cleanly
  if (cleanPath === '/' && hash === '#command') {
    return { kind: 'dashboard', view: 'overview', next: null, resetToken: null, rawPath: '/dashboard' };
  }

  return { kind: 'landing', view: 'overview', next: null, resetToken: null, rawPath: '/' };
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
