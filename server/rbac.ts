import type { NextFunction, Request, Response } from 'express';
import type { UserRole } from '../src/shared/types.ts';
import { resolveSessionFromRequest } from './auth.ts';

export interface RequestActor {
  uid: string;
  userId?: string;
  name: string;
  email: string;
  role: UserRole;
  baseRole?: UserRole;
  orgId: string;
}

export interface AuthedRequest extends Request {
  actor?: RequestActor;
}

export const PERMISSIONS: Record<string, UserRole[]> = {
  'incident:create': ['super_admin', 'emergency_commander', 'logistics_manager', 'field_responder', 'citizen_reporter'],
  'incident:manage': ['super_admin', 'emergency_commander', 'logistics_manager', 'field_responder'],
  'incident:verify': ['super_admin', 'emergency_commander'],
  'incident:reject': ['super_admin', 'emergency_commander'],
  'incident:escalate': ['super_admin', 'emergency_commander'],
  'incident:close': ['super_admin', 'emergency_commander'],
  'incident:archive': ['super_admin', 'emergency_commander'],
  'risk:assess': ['super_admin', 'emergency_commander', 'logistics_manager', 'analyst'],
  'alert:manage': ['super_admin', 'emergency_commander', 'logistics_manager', 'analyst', 'field_responder'],
  'relief:create': ['super_admin', 'emergency_commander', 'logistics_manager', 'field_responder', 'citizen_reporter'],
  'relief:verify': ['super_admin', 'emergency_commander', 'logistics_manager'],
  'relief:prioritize': ['super_admin', 'emergency_commander', 'logistics_manager'],
  'relief:override': ['super_admin', 'emergency_commander'],
  'warehouse:manage': ['super_admin', 'emergency_commander', 'logistics_manager'],
  'inventory:catalog': ['super_admin', 'emergency_commander', 'logistics_manager'],
  'inventory:move': ['super_admin', 'emergency_commander', 'logistics_manager', 'warehouse_operator'],
  'inventory:adjust': ['super_admin', 'emergency_commander', 'logistics_manager'],
  'inventory:transfer': ['super_admin', 'emergency_commander', 'logistics_manager'],
  'reservation:manage': ['super_admin', 'emergency_commander', 'logistics_manager', 'warehouse_operator'],
  'supply:manage': ['super_admin', 'emergency_commander', 'logistics_manager', 'warehouse_operator'],
  'allocation:recommend': ['super_admin', 'emergency_commander', 'logistics_manager'],
  'allocation:approve': ['super_admin', 'emergency_commander'],
  'allocation:reallocate': ['super_admin', 'emergency_commander', 'logistics_manager'],
  'fleet:manage': ['super_admin', 'emergency_commander', 'logistics_manager'],
  'driver:manage': ['super_admin', 'emergency_commander', 'logistics_manager'],
  'driver:view_contact': ['super_admin', 'emergency_commander', 'logistics_manager', 'warehouse_operator', 'field_responder'],
  'route:hazard_report': ['super_admin', 'emergency_commander', 'logistics_manager', 'field_responder'],
  'dispatch:create': ['super_admin', 'emergency_commander', 'logistics_manager'],
  'dispatch:approve': ['super_admin', 'emergency_commander'],
  'dispatch:cancel': ['super_admin', 'emergency_commander', 'logistics_manager'],
  'dispatch:load': ['super_admin', 'emergency_commander', 'logistics_manager', 'warehouse_operator'],
  'dispatch:update': ['super_admin', 'emergency_commander', 'logistics_manager', 'warehouse_operator', 'field_responder'],
  'delivery:confirm': ['super_admin', 'emergency_commander', 'logistics_manager', 'field_responder', 'warehouse_operator'],
  'delivery:verify': ['super_admin', 'emergency_commander', 'logistics_manager'],
  'ai:run': ['super_admin', 'emergency_commander', 'logistics_manager', 'analyst', 'field_responder'],
  'ai:coordinate': ['super_admin', 'emergency_commander', 'logistics_manager', 'analyst'],
  'ai:plan_approve': ['super_admin', 'emergency_commander'],
  'ai:plan_execute': ['super_admin', 'emergency_commander'],
  'ai:conflict_resolve': ['super_admin', 'emergency_commander', 'logistics_manager'],
  'ai:memory_write': ['super_admin', 'emergency_commander', 'logistics_manager', 'analyst'],
  'ai:simulate': ['super_admin', 'emergency_commander', 'logistics_manager', 'analyst'],
  'ai:monitoring_manage': ['super_admin', 'emergency_commander', 'logistics_manager', 'analyst'],
  'admin:reset_demo': ['super_admin', 'emergency_commander'],
};

/**
 * Populates req.actor strictly from a cryptographically verified server session
 * (HttpOnly session cookie or Bearer session token). Client-supplied x-resqflow-*
 * identity/role headers are never trusted.
 */
export function attachActor(req: AuthedRequest, _res: Response, next: NextFunction) {
  const resolved = resolveSessionFromRequest(req);
  if (resolved) {
    req.actor = {
      uid: resolved.user.uid,
      userId: resolved.user.id,
      name: resolved.user.name,
      email: resolved.user.email,
      role: resolved.user.role,
      baseRole: resolved.user.baseRole,
      orgId: resolved.user.orgId,
    };
  } else {
    req.actor = undefined;
  }
  next();
}

export function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  if (!req.actor) {
    return res.status(401).json({
      error: 'Authentication required. Please sign in to access RESQFLOW AI.',
      code: 'AUTH_REQUIRED',
    });
  }
  return next();
}

export function requirePermission(permission: keyof typeof PERMISSIONS) {
  return (req: AuthedRequest, res: Response, next: NextFunction) => {
    const actor = req.actor;
    if (!actor) {
      return res.status(401).json({
        error: 'Authentication required. Please sign in to continue.',
        code: 'AUTH_REQUIRED',
      });
    }
    const allowed = PERMISSIONS[permission] || [];
    if (!allowed.includes(actor.role)) {
      return res.status(403).json({
        error: `Forbidden: Role '${actor.role}' is not authorized for '${permission}'.`,
        code: 'FORBIDDEN',
        requiredRoles: allowed,
      });
    }
    next();
  };
}

// Memory-bounded sliding-window rate limiter for API protection (prevents unbounded Map growth)
const MAX_RATE_KEYS = 5000;
const rateHits = new Map<string, { count: number; resetAt: number }>();

function pruneRateHits(now: number) {
  if (rateHits.size < 500) return;
  for (const [k, v] of rateHits) {
    if (now > v.resetAt) {
      rateHits.delete(k);
    }
  }
  if (rateHits.size > MAX_RATE_KEYS) {
    const excess = rateHits.size - MAX_RATE_KEYS;
    let removed = 0;
    for (const k of rateHits.keys()) {
      rateHits.delete(k);
      removed += 1;
      if (removed >= excess) break;
    }
  }
}

export function rateLimit(maxPerMinute = 360) {
  return (req: Request, res: Response, next: NextFunction) => {
    // Never throttle health/readiness probes
    if (req.path === '/health' || req.path === '/health/live' || req.path === '/health/ready') {
      return next();
    }
    const actorKey = (req as AuthedRequest).actor?.uid;
    const key = actorKey ? `uid:${actorKey}` : `ip:${req.ip || 'local'}`;
    const now = Date.now();
    if (rateHits.size > 500 && Math.random() < 0.05) {
      pruneRateHits(now);
    }

    let entry = rateHits.get(key);
    if (!entry || now > entry.resetAt) {
      entry = { count: 1, resetAt: now + 60_000 };
      rateHits.set(key, entry);
    } else {
      entry.count += 1;
    }

    const remaining = Math.max(0, maxPerMinute - entry.count);
    const resetSec = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
    res.setHeader('X-RateLimit-Limit', String(maxPerMinute));
    res.setHeader('X-RateLimit-Remaining', String(remaining));
    res.setHeader('X-RateLimit-Reset', String(resetSec));

    if (entry.count > maxPerMinute) {
      res.setHeader('Retry-After', String(resetSec));
      return res.status(429).json({
        error: 'Rate limit exceeded. Please retry shortly.',
        code: 'RATE_LIMITED',
        retryAfterSec: resetSec,
      });
    }
    return next();
  };
}

// Priority-aware in-flight concurrency & memory overload protection
// Sheds non-essential AI/analytics traffic first so emergency incident/relief intake stays available
const MAX_IN_FLIGHT_TOTAL = 250;
const SOFT_IN_FLIGHT_NON_ESSENTIAL = 140;
const SOFT_HEAP_LIMIT_MB = 1200;
const HARD_HEAP_LIMIT_MB = 1800;

let inFlightRequests = 0;
let peakInFlightRequests = 0;
let sheddedRequests = 0;

function isCriticalEmergencyPath(reqPath: string): boolean {
  return (
    reqPath.startsWith('/health') ||
    reqPath.startsWith('/auth') ||
    reqPath.startsWith('/incidents') ||
    reqPath.startsWith('/relief-requests') ||
    reqPath.startsWith('/alerts') ||
    reqPath.startsWith('/dispatches')
  );
}

function isNonEssentialHeavyPath(reqPath: string): boolean {
  return (
    reqPath.startsWith('/ai/') ||
    reqPath.startsWith('/analytics') ||
    reqPath.startsWith('/predictions')
  );
}

export function overloadGuard(req: Request, res: Response, next: NextFunction) {
  if (req.path === '/health' || req.path === '/health/live' || req.path === '/health/ready') {
    return next();
  }

  const heapUsedMb = process.memoryUsage().heapUsed / (1024 * 1024);
  const nonEssential = isNonEssentialHeavyPath(req.path);
  const critical = isCriticalEmergencyPath(req.path);

  if (
    (nonEssential && (inFlightRequests >= SOFT_IN_FLIGHT_NON_ESSENTIAL || heapUsedMb >= SOFT_HEAP_LIMIT_MB)) ||
    (!critical && inFlightRequests >= MAX_IN_FLIGHT_TOTAL) ||
    heapUsedMb >= HARD_HEAP_LIMIT_MB
  ) {
    sheddedRequests += 1;
    res.setHeader('Retry-After', '5');
    return res.status(503).json({
      error: nonEssential
        ? 'Command server is prioritizing emergency operations under high load. Please retry AI/analytics shortly.'
        : 'Server is experiencing peak emergency load. Please retry in a few seconds.',
      code: 'SERVER_OVERLOADED',
      retryAfterSec: 5,
    });
  }

  inFlightRequests += 1;
  if (inFlightRequests > peakInFlightRequests) {
    peakInFlightRequests = inFlightRequests;
  }
  let decremented = false;
  const release = () => {
    if (decremented) return;
    decremented = true;
    inFlightRequests = Math.max(0, inFlightRequests - 1);
  };
  res.on('finish', release);
  res.on('close', release);
  return next();
}

export function getOverloadStats() {
  return {
    inFlightRequests,
    peakInFlightRequests,
    sheddedRequests,
    rateLimiterBuckets: rateHits.size,
    maxInFlightTotal: MAX_IN_FLIGHT_TOTAL,
    softNonEssentialThreshold: SOFT_IN_FLIGHT_NON_ESSENTIAL,
  };
}

