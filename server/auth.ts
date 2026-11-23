import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import type { AuthUserProfile, UserRole } from '../src/shared/types.ts';
import { store, type AuthSessionRecord, type AuthUserRecord } from './store.ts';

export const SESSION_COOKIE_NAME = 'resqflow_session';
export const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours authenticated session
const RESET_TOKEN_TTL_MS = 15 * 60 * 1000; // 15 minutes single-use token
const INITIAL_ADMIN_EMAIL = 'kishukishorsv123@gmail.com';
const DEFAULT_ORG_ID = 'org-central-cmd';
const SIGNED_TOKEN_PREFIX = 'rf1';
const RUNTIME_EPHEMERAL_SECRET = crypto.randomBytes(32).toString('hex');
const MAX_REVOKED_TOKENS = 2000;
const revokedTokenHashes = new Set<string>();

function markTokenHashRevoked(tokenHash: string): void {
  if (!tokenHash) return;
  revokedTokenHashes.add(tokenHash);
  if (revokedTokenHashes.size > MAX_REVOKED_TOKENS) {
    const first = revokedTokenHashes.values().next().value;
    if (first) revokedTokenHashes.delete(first);
  }
}

function getSessionSigningSecret(): string {
  const configured = sanitizeEnvValue(process.env.SESSION_SECRET || process.env.AUTH_SECRET);
  if (configured) return configured;
  const serverApiKey = sanitizeEnvValue(process.env.GEMINI_API_KEY);
  if (serverApiKey) {
    return crypto
      .createHmac('sha256', 'resqflow-session-key-derivation-v1')
      .update(serverApiKey)
      .digest('hex');
  }
  return RUNTIME_EPHEMERAL_SECRET;
}

const SIGNUP_ALLOWED_ROLES: UserRole[] = ['field_responder', 'analyst', 'citizen_reporter'];
const ALL_VALID_ROLES: UserRole[] = [
  'super_admin',
  'emergency_commander',
  'logistics_manager',
  'warehouse_operator',
  'field_responder',
  'analyst',
  'citizen_reporter',
];

function sanitizeEnvValue(raw: string | undefined): string {
  if (!raw) return '';
  let val = raw.trim();
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
    val = val.slice(1, -1).trim();
  }
  return val;
}

function isValidFirebaseProjectId(value: string): boolean {
  if (!value || /^(your|my|replace|placeholder|example|test|remixed-project-id)/i.test(value)) {
    return false;
  }
  // GCP/Firebase project IDs must be 6-30 chars, start with a lowercase letter, and contain only lowercase letters, digits, or hyphens
  return /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(value);
}

function isValidFirebaseApiKey(value: string): boolean {
  return /^AIza[0-9A-Za-z_-]{30,50}$/.test(value);
}

// Load provisioned Firebase projectId for strict RS256 ID token aud/iss verification
function loadFirebaseProjectId(): string {
  const envProjectId = sanitizeEnvValue(process.env.FIREBASE_PROJECT_ID || process.env.VITE_FIREBASE_PROJECT_ID);
  const envApiKey = sanitizeEnvValue(process.env.VITE_FIREBASE_API_KEY);
  const envApiKeyOk = !envApiKey || isValidFirebaseApiKey(envApiKey);

  if (envProjectId && isValidFirebaseProjectId(envProjectId) && envApiKeyOk) {
    return envProjectId;
  }
  try {
    const cfgPath = path.resolve(process.cwd(), 'firebase-applet-config.json');
    if (fs.existsSync(cfgPath)) {
      const parsed = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as { projectId?: string };
      const cfgId = sanitizeEnvValue(parsed.projectId);
      if (cfgId && isValidFirebaseProjectId(cfgId)) return cfgId;
    }
  } catch {
    // Fallback empty
  }
  return '';
}

const FIREBASE_PROJECT_ID = loadFirebaseProjectId();

export function getFirebaseProjectId(): string {
  return FIREBASE_PROJECT_ID;
}

export interface PublicFirebaseWebConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  storageBucket: string;
  messagingSenderId: string;
  appId: string;
}

export function getPublicFirebaseWebConfig(requestHost?: string): PublicFirebaseWebConfig | null {
  const envApiKey = sanitizeEnvValue(process.env.VITE_FIREBASE_API_KEY);
  const envProjectId = sanitizeEnvValue(process.env.FIREBASE_PROJECT_ID || process.env.VITE_FIREBASE_PROJECT_ID);
  const envAuthDomain = sanitizeEnvValue(process.env.VITE_FIREBASE_AUTH_DOMAIN);
  const envStorageBucket = sanitizeEnvValue(process.env.VITE_FIREBASE_STORAGE_BUCKET);
  const envMessagingSenderId = sanitizeEnvValue(process.env.VITE_FIREBASE_MESSAGING_SENDER_ID);
  const envAppId = sanitizeEnvValue(process.env.VITE_FIREBASE_APP_ID);

  const safeRequestHost = sanitizeEnvValue(requestHost);
  const hostIsValidDomain =
    Boolean(safeRequestHost) &&
    /^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(safeRequestHost) &&
    !safeRequestHost.includes(':');

  if (envApiKey && isValidFirebaseApiKey(envApiKey) && envProjectId && isValidFirebaseProjectId(envProjectId)) {
    return {
      apiKey: envApiKey,
      authDomain:
        (hostIsValidDomain ? safeRequestHost : '') ||
        envAuthDomain ||
        `${envProjectId}.firebaseapp.com`,
      projectId: envProjectId,
      storageBucket: envStorageBucket || `${envProjectId}.firebasestorage.app`,
      messagingSenderId: envMessagingSenderId,
      appId: envAppId,
    };
  }

  try {
    const cfgPath = path.resolve(process.cwd(), 'firebase-applet-config.json');
    if (fs.existsSync(cfgPath)) {
      const parsed = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as Partial<PublicFirebaseWebConfig>;
      const apiKey = sanitizeEnvValue(parsed.apiKey);
      const projectId = sanitizeEnvValue(parsed.projectId);
      if (apiKey && isValidFirebaseApiKey(apiKey) && projectId && isValidFirebaseProjectId(projectId)) {
        return {
          apiKey,
          authDomain:
            (hostIsValidDomain ? safeRequestHost : '') ||
            sanitizeEnvValue(parsed.authDomain) ||
            `${projectId}.firebaseapp.com`,
          projectId,
          storageBucket: sanitizeEnvValue(parsed.storageBucket) || `${projectId}.firebasestorage.app`,
          messagingSenderId: sanitizeEnvValue(parsed.messagingSenderId),
          appId: sanitizeEnvValue(parsed.appId),
        };
      }
    }
  } catch {
    // ignore
  }

  return null;
}

const GOOGLE_CERTS_URL =
  'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';

let cachedCerts: Record<string, string> = {};
let cachedCertsExpiresAt = 0;

async function getGoogleSecureTokenCerts(forceRefresh = false): Promise<Record<string, string>> {
  const now = Date.now();
  if (!forceRefresh && Object.keys(cachedCerts).length > 0 && now < cachedCertsExpiresAt) {
    return cachedCerts;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const resp = await fetch(GOOGLE_CERTS_URL, { signal: controller.signal });
    if (!resp.ok) {
      throw new Error(`Unable to fetch Google verification certificates (HTTP ${resp.status}).`);
    }

    const certs = (await resp.json()) as Record<string, string>;
    const cacheControl = resp.headers.get('cache-control') || '';
    const maxAgeMatch = cacheControl.match(/max-age=(\d+)/i);
    const maxAgeSec = maxAgeMatch ? Math.max(60, Number(maxAgeMatch[1])) : 3600;

    cachedCerts = certs;
    cachedCertsExpiresAt = now + maxAgeSec * 1000;
    return cachedCerts;
  } finally {
    clearTimeout(timer);
  }
}

function decodeBase64Url(segment: string): Buffer {
  const normalized = segment.replace(/-/g, '+').replace(/_/g, '/');
  const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
  return Buffer.from(normalized + padding, 'base64');
}

export interface VerifiedFirebaseToken {
  uid: string;
  email: string;
  emailVerified: boolean;
  name: string;
  picture?: string;
}

export async function verifyFirebaseIdToken(idToken: string): Promise<VerifiedFirebaseToken> {
  if (!FIREBASE_PROJECT_ID) {
    throw new Error('Firebase project configuration is missing on the server.');
  }
  const trimmed = idToken.trim();
  const parts = trimmed.split('.');
  if (parts.length !== 3) {
    throw new Error('Malformed Firebase authentication token.');
  }

  let header: { alg?: string; kid?: string };
  let payload: {
    aud?: string;
    iss?: string;
    sub?: string;
    exp?: number;
    iat?: number;
    auth_time?: number;
    email?: string;
    email_verified?: boolean;
    name?: string;
    picture?: string;
  };

  try {
    header = JSON.parse(decodeBase64Url(parts[0]).toString('utf8'));
    payload = JSON.parse(decodeBase64Url(parts[1]).toString('utf8'));
  } catch {
    throw new Error('Invalid Firebase authentication token encoding.');
  }

  if (header.alg !== 'RS256' || !header.kid) {
    throw new Error('Unsupported Firebase token signature algorithm.');
  }

  let certs = await getGoogleSecureTokenCerts(false);
  let certPem = certs[header.kid];
  if (!certPem) {
    certs = await getGoogleSecureTokenCerts(true);
    certPem = certs[header.kid];
  }
  if (!certPem) {
    throw new Error('Firebase signing key was not recognized.');
  }

  const signingInput = `${parts[0]}.${parts[1]}`;
  const signature = decodeBase64Url(parts[2]);
  const verifier = crypto.createVerify('RSA-SHA256');
  verifier.update(signingInput);
  verifier.end();
  const isValidSig = verifier.verify(certPem, signature);
  if (!isValidSig) {
    throw new Error('Firebase authentication token signature verification failed.');
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const expectedIssuer = `https://securetoken.google.com/${FIREBASE_PROJECT_ID}`;
  if (payload.aud !== FIREBASE_PROJECT_ID) {
    throw new Error('Firebase token audience does not match this RESQFLOW AI project.');
  }
  if (payload.iss !== expectedIssuer) {
    throw new Error('Firebase token issuer mismatch.');
  }
  if (!payload.sub || typeof payload.sub !== 'string' || payload.sub.length > 128) {
    throw new Error('Firebase token is missing a valid user subject.');
  }
  if (typeof payload.exp !== 'number' || payload.exp <= nowSec) {
    throw new Error('Firebase authentication token has expired. Please sign in again.');
  }
  if (typeof payload.iat !== 'number' || payload.iat > nowSec + 300) {
    throw new Error('Firebase authentication token issue time is invalid.');
  }
  if (typeof payload.auth_time === 'number' && payload.auth_time > nowSec + 300) {
    throw new Error('Firebase authentication timestamp is invalid.');
  }
  if (!payload.email || typeof payload.email !== 'string') {
    throw new Error('Google account did not provide a valid email address.');
  }

  return {
    uid: payload.sub,
    email: normalizeEmail(payload.email),
    emailVerified: Boolean(payload.email_verified),
    name: (payload.name || payload.email.split('@')[0] || 'Responder').trim().slice(0, 120),
    picture: payload.picture,
  };
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function validatePasswordStrength(password: string): string | null {
  if (password.length < 8) {
    return 'Password must be at least 8 characters long.';
  }
  if (password.length > 128) {
    return 'Password must be 128 characters or fewer.';
  }
  if (!/[a-z]/.test(password)) {
    return 'Password must include at least one lowercase letter.';
  }
  if (!/[A-Z]/.test(password)) {
    return 'Password must include at least one uppercase letter.';
  }
  if (!/[0-9]/.test(password)) {
    return 'Password must include at least one number.';
  }
  return null;
}

export function hashPassword(password: string): { hash: string; salt: string } {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { hash, salt };
}

export async function hashPasswordAsync(password: string): Promise<{ hash: string; salt: string }> {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = await new Promise<Buffer>((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (err, key) => (err ? reject(err) : resolve(key)));
  });
  return { hash: derived.toString('hex'), salt };
}

export function verifyPassword(password: string, storedHash: string | null, storedSalt: string | null): boolean {
  if (!storedHash || !storedSalt) return false;
  try {
    const derived = crypto.scryptSync(password, storedSalt, 64);
    const expected = Buffer.from(storedHash, 'hex');
    if (derived.length !== expected.length) return false;
    return crypto.timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

export async function verifyPasswordAsync(
  password: string,
  storedHash: string | null,
  storedSalt: string | null
): Promise<boolean> {
  if (!storedHash || !storedSalt) return false;
  try {
    const derived = await new Promise<Buffer>((resolve, reject) => {
      crypto.scrypt(password, storedSalt, 64, (err, key) => (err ? reject(err) : resolve(key)));
    });
    const expected = Buffer.from(storedHash, 'hex');
    if (derived.length !== expected.length) return false;
    return crypto.timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

export function hashToken(rawToken: string): string {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

export function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!cookieHeader) return out;
  for (const part of cookieHeader.split(';')) {
    const eqIdx = part.indexOf('=');
    if (eqIdx <= 0) continue;
    const key = part.slice(0, eqIdx).trim();
    const val = part.slice(eqIdx + 1).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(val);
    } catch {
      out[key] = val;
    }
  }
  return out;
}

function isHttpsRequest(req: Request): boolean {
  if (req.secure) return true;
  const fwdProto = String(req.header('x-forwarded-proto') || '').split(',')[0].trim().toLowerCase();
  return fwdProto === 'https';
}

export function setSessionCookie(req: Request, res: Response, rawToken: string): void {
  const maxAgeSec = Math.floor(SESSION_TTL_MS / 1000);
  const https = isHttpsRequest(req);
  const parts = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(rawToken)}`,
    'Path=/',
    'HttpOnly',
    `Max-Age=${maxAgeSec}`,
  ];
  if (https) {
    parts.push('Secure', 'SameSite=None', 'Partitioned');
  } else {
    parts.push('SameSite=Lax');
  }
  res.setHeader('Set-Cookie', parts.join('; '));
}

export function clearSessionCookie(req: Request, res: Response): void {
  const https = isHttpsRequest(req);
  const parts = [
    `${SESSION_COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    'Max-Age=0',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
  ];
  if (https) {
    parts.push('Secure', 'SameSite=None', 'Partitioned');
  } else {
    parts.push('SameSite=Lax');
  }
  res.setHeader('Set-Cookie', parts.join('; '));
}

export function toPublicUserProfile(user: AuthUserRecord): AuthUserProfile {
  return {
    id: user.id,
    uid: user.uid,
    email: user.email,
    name: user.name,
    role: user.role,
    baseRole: user.baseRole,
    orgId: user.orgId,
    provider: user.provider,
    emailVerified: user.emailVerified,
    firebaseUid: user.firebaseUid,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    lastLoginAt: user.lastLoginAt,
  };
}

function pruneExpiredSessions(): boolean {
  const now = Date.now();
  const prevLen = store.state.authSessions.length;
  store.state.authSessions = store.state.authSessions.filter((s) => new Date(s.expiresAt).getTime() > now);
  return store.state.authSessions.length !== prevLen;
}

interface SignedSessionClaims {
  sid: string;
  uid: string;
  userId: string;
  email: string;
  name: string;
  role: UserRole;
  baseRole: UserRole;
  orgId: string;
  provider: AuthUserRecord['provider'];
  exp: number;
  iat: number;
}

function signSessionClaims(claims: SignedSessionClaims): string {
  const payloadB64 = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  const sigB64 = crypto
    .createHmac('sha256', getSessionSigningSecret())
    .update(`${SIGNED_TOKEN_PREFIX}.${payloadB64}`)
    .digest('base64url');
  return `${SIGNED_TOKEN_PREFIX}.${payloadB64}.${sigB64}`;
}

function verifySignedSessionToken(rawToken: string): SignedSessionClaims | null {
  const parts = rawToken.split('.');
  if (parts.length !== 3 || parts[0] !== SIGNED_TOKEN_PREFIX) {
    return null;
  }
  const [, payloadB64, sigB64] = parts;
  if (!payloadB64 || !sigB64) return null;

  try {
    const expectedSig = crypto
      .createHmac('sha256', getSessionSigningSecret())
      .update(`${SIGNED_TOKEN_PREFIX}.${payloadB64}`)
      .digest('base64url');
    const actualBuf = Buffer.from(sigB64, 'utf8');
    const expectedBuf = Buffer.from(expectedSig, 'utf8');
    if (actualBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(actualBuf, expectedBuf)) {
      return null;
    }
    const claims = JSON.parse(decodeBase64Url(payloadB64).toString('utf8')) as SignedSessionClaims;
    if (
      !claims ||
      typeof claims.sid !== 'string' ||
      typeof claims.uid !== 'string' ||
      typeof claims.userId !== 'string' ||
      typeof claims.exp !== 'number' ||
      claims.exp <= Date.now()
    ) {
      return null;
    }
    if (!ALL_VALID_ROLES.includes(claims.role) || !ALL_VALID_ROLES.includes(claims.baseRole)) {
      return null;
    }
    return claims;
  } catch {
    return null;
  }
}

export function createSession(user: AuthUserRecord, userAgent = ''): {
  rawToken: string;
  session: AuthSessionRecord;
} {
  pruneExpiredSessions();
  const sessionId = uuidv4();
  const nowMs = Date.now();
  const now = new Date(nowMs);
  const expiresMs = nowMs + SESSION_TTL_MS;
  const expires = new Date(expiresMs);
  const rawToken = signSessionClaims({
    sid: sessionId,
    uid: user.uid,
    userId: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    baseRole: user.baseRole,
    orgId: user.orgId,
    provider: user.provider,
    iat: nowMs,
    exp: expiresMs,
  });
  const session: AuthSessionRecord = {
    id: sessionId,
    tokenHash: hashToken(rawToken),
    userId: user.id,
    createdAt: now.toISOString(),
    expiresAt: expires.toISOString(),
    lastSeenAt: now.toISOString(),
    userAgent: userAgent.slice(0, 200),
  };
  store.state.authSessions.unshift(session);
  // Keep at most 200 active sessions in the persistent file
  if (store.state.authSessions.length > 200) {
    store.state.authSessions.length = 200;
  }
  store.save();
  return { rawToken, session };
}

export function revokeSessionByToken(rawToken: string | null): boolean {
  if (!rawToken) return false;
  const targetHash = hashToken(rawToken);
  markTokenHashRevoked(targetHash);
  const before = store.state.authSessions.length;
  store.state.authSessions = store.state.authSessions.filter((s) => s.tokenHash !== targetHash);
  if (store.state.authSessions.length !== before) {
    store.save();
    return true;
  }
  return false;
}

export function revokeAllUserSessions(userId: string, exceptSessionId?: string): void {
  for (const s of store.state.authSessions) {
    if (s.userId === userId && (!exceptSessionId || s.id !== exceptSessionId)) {
      markTokenHashRevoked(s.tokenHash);
    }
  }
  store.state.authSessions = store.state.authSessions.filter(
    (s) => s.userId !== userId || (exceptSessionId && s.id === exceptSessionId)
  );
  store.save();
}

export function extractRawSessionToken(req: Request): { token: string | null; viaCookie: boolean } {
  const authHeader = req.header('authorization') || '';
  if (authHeader.toLowerCase().startsWith('bearer ')) {
    const bearer = authHeader.slice(7).trim();
    if (bearer) return { token: bearer, viaCookie: false };
  }
  const cookies = parseCookies(req.header('cookie'));
  if (cookies[SESSION_COOKIE_NAME]) {
    return { token: cookies[SESSION_COOKIE_NAME], viaCookie: true };
  }
  return { token: null, viaCookie: false };
}

export interface ResolvedSession {
  user: AuthUserRecord;
  session: AuthSessionRecord;
  viaCookie: boolean;
}

export function resolveSessionByRawToken(rawToken: string | null, viaCookie = false): ResolvedSession | null {
  if (!rawToken) return null;
  const tokenHash = hashToken(rawToken);
  if (revokedTokenHashes.has(tokenHash)) return null;
  const now = Date.now();
  const session = store.state.authSessions.find((s) => s.tokenHash === tokenHash);

  if (session) {
    if (new Date(session.expiresAt).getTime() <= now) {
      store.state.authSessions = store.state.authSessions.filter((s) => s.id !== session.id);
      store.save();
      return null;
    }

    const user = store.state.authUsers.find((u) => u.id === session.userId);
    if (!user) {
      store.state.authSessions = store.state.authSessions.filter((s) => s.id !== session.id);
      store.save();
      return null;
    }

    // Track recent activity without silently shifting explicit session expiry
    if (now - new Date(session.lastSeenAt).getTime() > 5 * 60 * 1000) {
      session.lastSeenAt = new Date(now).toISOString();
      store.save();
    }

    return { user, session, viaCookie };
  }

  // Stateless HMAC-signed token fallback (supports serverless cold starts / warm instance swaps when SESSION_SECRET is set)
  const claims = verifySignedSessionToken(rawToken);
  if (!claims) return null;

  let user =
    store.state.authUsers.find((u) => u.id === claims.userId) ||
    store.state.authUsers.find((u) => u.uid === claims.uid);

  if (!user) {
    const nowIso = new Date(now).toISOString();
    user = {
      id: claims.userId,
      uid: claims.uid,
      email: claims.email,
      name: claims.name,
      role: claims.role,
      baseRole: claims.baseRole,
      orgId: claims.orgId || DEFAULT_ORG_ID,
      provider: claims.provider || 'password',
      emailVerified: true,
      firebaseUid: null,
      passwordHash: null,
      passwordSalt: null,
      createdAt: new Date(claims.iat || now).toISOString(),
      updatedAt: nowIso,
      lastLoginAt: nowIso,
    };
    store.state.authUsers.push(user);
  }

  const hydratedSession: AuthSessionRecord = {
    id: claims.sid,
    tokenHash,
    userId: user.id,
    createdAt: new Date(claims.iat || now).toISOString(),
    expiresAt: new Date(claims.exp).toISOString(),
    lastSeenAt: new Date(now).toISOString(),
    userAgent: '',
  };
  store.state.authSessions.unshift(hydratedSession);
  if (store.state.authSessions.length > 200) {
    store.state.authSessions.length = 200;
  }
  store.save();

  return { user, session: hydratedSession, viaCookie };
}

export function resolveSessionFromRequest(req: Request): ResolvedSession | null {
  const { token, viaCookie } = extractRawSessionToken(req);
  return resolveSessionByRawToken(token, viaCookie);
}

export function resolveSessionFromRawUpgrade(
  cookieHeader: string | undefined,
  urlString: string | undefined
): ResolvedSession | null {
  try {
    const parsedUrl = new URL(urlString || '/', 'http://localhost');
    const queryToken = parsedUrl.searchParams.get('sessionToken');
    if (queryToken) {
      const byQuery = resolveSessionByRawToken(queryToken, false);
      if (byQuery) return byQuery;
    }
  } catch {
    // ignore malformed URL
  }
  const cookies = parseCookies(cookieHeader);
  const cookieToken = cookies[SESSION_COOKIE_NAME] || null;
  return resolveSessionByRawToken(cookieToken, true);
}

// Protect cookie-authenticated state-changing requests against cross-site request forgery
export function verifyCsrfForCookieAuth(req: Request, res: Response, next: NextFunction) {
  const method = req.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
    return next();
  }
  const { viaCookie } = extractRawSessionToken(req);
  if (!viaCookie) {
    return next();
  }

  // Allow requests with custom AJAX header OR same-origin Origin header
  const xrw = req.header('x-requested-with');
  if (xrw === 'XMLHttpRequest' || xrw === 'ResqflowClient') {
    return next();
  }

  const origin = req.header('origin');
  const host = req.header('x-forwarded-host') || req.header('host');
  if (origin && host) {
    try {
      const originHost = new URL(origin).host;
      if (originHost === host) {
        return next();
      }
    } catch {
      // fall through to 403
    }
  }

  return res.status(403).json({
    error: 'Cross-site state-changing request blocked. Include a valid session header or reload the page.',
    code: 'CSRF_CHECK_FAILED',
  });
}

function findOrCreateGoogleUser(
  verified: VerifiedFirebaseToken,
  requestedRole?: UserRole
): {
  user: AuthUserRecord;
  created: boolean;
} {
  const now = new Date().toISOString();
  const normalizedEmail = normalizeEmail(verified.email);

  // 1. Match existing user by firebaseUid first, then normalized email (idempotent — zero duplicates)
  let existing =
    store.state.authUsers.find((u) => u.firebaseUid && u.firebaseUid === verified.uid) ||
    store.state.authUsers.find((u) => normalizeEmail(u.email) === normalizedEmail);

  if (existing) {
    existing.firebaseUid = verified.uid;
    existing.emailVerified = existing.emailVerified || verified.emailVerified;
    if (existing.provider === 'password') {
      existing.provider = 'both';
    }
    if (!existing.name && verified.name) {
      existing.name = verified.name;
    }
    // Elevate initial project owner only if email is verified by Google
    if (normalizedEmail === INITIAL_ADMIN_EMAIL && verified.emailVerified && existing.baseRole !== 'super_admin') {
      existing.baseRole = 'super_admin';
      existing.role = 'super_admin';
    }
    existing.lastLoginAt = now;
    existing.updatedAt = now;
    store.save();
    return { user: existing, created: false };
  }

  const initialRole: UserRole =
    normalizedEmail === INITIAL_ADMIN_EMAIL && verified.emailVerified
      ? 'super_admin'
      : requestedRole && SIGNUP_ALLOWED_ROLES.includes(requestedRole)
        ? requestedRole
        : 'field_responder';

  const createdUser: AuthUserRecord = {
    id: uuidv4(),
    uid: verified.uid,
    email: normalizedEmail,
    name: verified.name || normalizedEmail.split('@')[0] || 'Responder',
    role: initialRole,
    baseRole: initialRole,
    orgId: DEFAULT_ORG_ID,
    provider: 'google',
    emailVerified: verified.emailVerified,
    firebaseUid: verified.uid,
    passwordHash: null,
    passwordSalt: null,
    createdAt: now,
    updatedAt: now,
    lastLoginAt: now,
  };

  store.state.authUsers.push(createdUser);
  store.save();
  return { user: createdUser, created: true };
}

// Per-IP tighter rate limiter specifically for auth endpoints (memory-bounded)
const MAX_AUTH_RATE_KEYS = 3000;
const authRateHits = new Map<string, { count: number; resetAt: number }>();

function pruneAuthRateHits(now: number) {
  for (const [k, v] of authRateHits) {
    if (now > v.resetAt) authRateHits.delete(k);
  }
  if (authRateHits.size > MAX_AUTH_RATE_KEYS) {
    const excess = authRateHits.size - MAX_AUTH_RATE_KEYS;
    let removed = 0;
    for (const k of authRateHits.keys()) {
      authRateHits.delete(k);
      removed += 1;
      if (removed >= excess) break;
    }
  }
}

function authRateLimit(maxPerMinute = 45) {
  return (req: Request, res: Response, next: NextFunction) => {
    const key = `auth:${req.path}:${req.ip || 'local'}`;
    const now = Date.now();
    if (authRateHits.size > 300 && Math.random() < 0.05) {
      pruneAuthRateHits(now);
    }
    let entry = authRateHits.get(key);
    if (!entry || now > entry.resetAt) {
      entry = { count: 1, resetAt: now + 60_000 };
      authRateHits.set(key, entry);
    } else {
      entry.count += 1;
    }
    const resetSec = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
    res.setHeader('X-RateLimit-Limit', String(maxPerMinute));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, maxPerMinute - entry.count)));
    res.setHeader('X-RateLimit-Reset', String(resetSec));
    if (entry.count > maxPerMinute) {
      res.setHeader('Retry-After', String(resetSec));
      return res.status(429).json({
        error: 'Too many authentication attempts. Please wait a minute and try again.',
        code: 'RATE_LIMITED',
        retryAfterSec: resetSec,
      });
    }
    return next();
  };
}

const LoginSchema = z.object({
  email: z.string().trim().email('Please enter a valid email address.').max(254),
  password: z.string().min(1, 'Password is required.').max(128),
});

const FirebaseExchangeSchema = z.object({
  idToken: z.string().min(20, 'Valid Google/Firebase ID token is required.'),
  role: z.enum(['field_responder', 'analyst', 'citizen_reporter']).optional(),
});

const ForgotPasswordSchema = z.object({
  email: z.string().trim().email('Please enter a valid email address.').max(254),
});

const ResetPasswordSchema = z.object({
  token: z.string().trim().min(16, 'Reset token is invalid or missing.').max(256),
  newPassword: z.string().min(8, 'New password must be at least 8 characters.').max(128),
});

const ChangePasswordSchema = z.object({
  currentPassword: z.string().max(128).optional(),
  newPassword: z.string().min(8, 'New password must be at least 8 characters.').max(128),
});

const SwitchRoleSchema = z.object({
  role: z.enum([
    'super_admin',
    'emergency_commander',
    'logistics_manager',
    'warehouse_operator',
    'field_responder',
    'analyst',
    'citizen_reporter',
  ]),
});

export function createAuthRouter(): express.Router {
  const router = express.Router();

  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('Pragma', 'no-cache');
    next();
  });

  // GET /api/v1/auth/session — Verify and restore current session
  router.get('/session', (req, res) => {
    const resolved = resolveSessionFromRequest(req);
    const serverNow = new Date().toISOString();
    if (!resolved) {
      return res.status(200).json({
        authenticated: false,
        user: null,
        serverNow,
      });
    }
    return res.status(200).json({
      authenticated: true,
      user: toPublicUserProfile(resolved.user),
      sessionExpiresAt: resolved.session.expiresAt,
      sessionDurationMs: SESSION_TTL_MS,
      serverNow,
    });
  });

  // POST /api/v1/auth/refresh — Explicitly extend active session lifetime and refresh cookie TTL
  router.post('/refresh', authRateLimit(30), verifyCsrfForCookieAuth, (req, res) => {
    const { token, viaCookie } = extractRawSessionToken(req);
    const resolved = resolveSessionByRawToken(token, viaCookie);
    if (!resolved || !token) {
      return res.status(401).json({
        error: 'Your session has expired. Please sign in again.',
        code: 'AUTH_REQUIRED',
      });
    }

    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const newExpiresIso = new Date(nowMs + SESSION_TTL_MS).toISOString();
    resolved.session.lastSeenAt = nowIso;
    resolved.session.expiresAt = newExpiresIso;
    store.save();

    // Refresh HttpOnly cookie Max-Age so browser persistence matches extended server expiry
    setSessionCookie(req, res, token);

    store.addAudit({
      actor: resolved.user.name,
      role: resolved.user.role,
      orgId: resolved.user.orgId,
      action: 'auth.session_refreshed',
      entityType: 'user',
      entityId: resolved.user.id,
      summary: 'Refreshed active authentication session (+24h).',
      mode: 'operational',
    });

    return res.status(200).json({
      ok: true,
      authenticated: true,
      user: toPublicUserProfile(resolved.user),
      sessionExpiresAt: newExpiresIso,
      sessionDurationMs: SESSION_TTL_MS,
      serverNow: nowIso,
    });
  });

  // GET /api/v1/auth/firebase-status — Non-sensitive server-side Firebase project diagnostic
  router.get('/firebase-status', (_req, res) => {
    return res.status(200).json({
      configured: Boolean(FIREBASE_PROJECT_ID),
      projectId: FIREBASE_PROJECT_ID || null,
      authProxyPath: '/__/auth/handler',
    });
  });

  // POST /api/v1/auth/direct-access — Direct Command Center session without account registration
  router.post('/direct-access', authRateLimit(30), (req, res) => {
    const directUid = 'direct-command-operator';
    const directEmail = 'operator@resqflow.local';
    const now = new Date().toISOString();

    let operator = store.state.authUsers.find(
      (u) => u.uid === directUid || normalizeEmail(u.email) === directEmail
    );

    if (!operator) {
      operator = {
        id: uuidv4(),
        uid: directUid,
        email: directEmail,
        name: 'Command Operator',
        role: 'emergency_commander',
        baseRole: 'emergency_commander',
        orgId: DEFAULT_ORG_ID,
        provider: 'password',
        emailVerified: true,
        firebaseUid: null,
        passwordHash: null,
        passwordSalt: null,
        createdAt: now,
        updatedAt: now,
        lastLoginAt: now,
      };
      store.state.authUsers.push(operator);
    } else {
      operator.lastLoginAt = now;
      operator.updatedAt = now;
    }
    store.save();

    const { rawToken, session } = createSession(operator, String(req.header('user-agent') || ''));
    setSessionCookie(req, res, rawToken);

    store.addAudit({
      actor: operator.name,
      role: operator.role,
      orgId: operator.orgId,
      action: 'auth.direct_access',
      entityType: 'user',
      entityId: operator.id,
      summary: 'Entered RESQFLOW AI platform via direct command access.',
      mode: 'operational',
    });

    return res.status(200).json({
      authenticated: true,
      user: toPublicUserProfile(operator),
      sessionToken: rawToken,
      sessionExpiresAt: session.expiresAt,
      sessionDurationMs: SESSION_TTL_MS,
      serverNow: now,
    });
  });

  // POST /api/v1/auth/login — Real email/password login
  router.post('/login', authRateLimit(35), async (req, res) => {
    const parsed = LoginSchema.safeParse(req.body);
    if (!parsed.success) {
      const firstErr = parsed.error.issues[0]?.message || 'Please enter a valid email and password.';
      return res.status(400).json({ error: firstErr, code: 'VALIDATION_ERROR' });
    }

    const email = normalizeEmail(parsed.data.email);
    const user = store.state.authUsers.find((u) => normalizeEmail(u.email) === email);

    if (!user) {
      return res.status(401).json({
        error: 'Invalid email or password.',
        code: 'INVALID_CREDENTIALS',
      });
    }

    if (!user.passwordHash || !user.passwordSalt) {
      return res.status(401).json({
        error: 'This account uses Google Sign-In. Please continue with Google to sign in.',
        code: 'GOOGLE_ACCOUNT_ONLY',
      });
    }

    const valid = await verifyPasswordAsync(parsed.data.password, user.passwordHash, user.passwordSalt);
    if (!valid) {
      return res.status(401).json({
        error: 'Invalid email or password.',
        code: 'INVALID_CREDENTIALS',
      });
    }

    const now = new Date().toISOString();
    user.lastLoginAt = now;
    user.updatedAt = now;
    store.save();

    const { rawToken, session } = createSession(user, String(req.header('user-agent') || ''));
    setSessionCookie(req, res, rawToken);

    store.addAudit({
      actor: user.name,
      role: user.role,
      orgId: user.orgId,
      action: 'auth.login',
      entityType: 'user',
      entityId: user.id,
      summary: 'Signed in via email/password.',
      mode: 'operational',
    });

    return res.status(200).json({
      authenticated: true,
      user: toPublicUserProfile(user),
      sessionToken: rawToken,
      sessionExpiresAt: session.expiresAt,
      sessionDurationMs: SESSION_TTL_MS,
      serverNow: now,
    });
  });

  // POST /api/v1/auth/firebase-exchange — Cryptographically verify Firebase Google ID token & issue session
  router.post('/firebase-exchange', authRateLimit(35), async (req, res) => {
    const parsed = FirebaseExchangeSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Missing Google authentication token.', code: 'VALIDATION_ERROR' });
    }

    try {
      const verified = await verifyFirebaseIdToken(parsed.data.idToken);
      const { user, created } = findOrCreateGoogleUser(verified, parsed.data.role);
      const { rawToken, session } = createSession(user, String(req.header('user-agent') || ''));
      setSessionCookie(req, res, rawToken);

      store.addAudit({
        actor: user.name,
        role: user.role,
        orgId: user.orgId,
        action: created ? 'auth.google_signup' : 'auth.google_login',
        entityType: 'user',
        entityId: user.id,
        summary: created
          ? `Initialized Google profile (${user.role}).`
          : `Signed in with Google (${user.role}).`,
        mode: 'operational',
      });

      return res.status(created ? 201 : 200).json({
        authenticated: true,
        created,
        user: toPublicUserProfile(user),
        sessionToken: rawToken,
        sessionExpiresAt: session.expiresAt,
        sessionDurationMs: SESSION_TTL_MS,
        serverNow: new Date().toISOString(),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Google authentication token could not be verified.';
      return res.status(401).json({ error: msg, code: 'INVALID_FIREBASE_TOKEN' });
    }
  });

  // POST /api/v1/auth/logout — Revoke server session & clear HttpOnly cookie
  router.post('/logout', verifyCsrfForCookieAuth, (req, res) => {
    const { token } = extractRawSessionToken(req);
    const resolved = resolveSessionByRawToken(token);
    revokeSessionByToken(token);
    clearSessionCookie(req, res);

    if (resolved) {
      store.addAudit({
        actor: resolved.user.name,
        role: resolved.user.role,
        orgId: resolved.user.orgId,
        action: 'auth.logout',
        entityType: 'user',
        entityId: resolved.user.id,
        summary: 'Signed out and revoked server session.',
        mode: 'operational',
      });
    }

    return res.status(200).json({ ok: true, authenticated: false });
  });

  // POST /api/v1/auth/forgot-password — Create single-use 15m hashed reset token without account enumeration
  router.post('/forgot-password', authRateLimit(15), (req, res) => {
    const parsed = ForgotPasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Please enter a valid email address.', code: 'VALIDATION_ERROR' });
    }

    const email = normalizeEmail(parsed.data.email);
    const user = store.state.authUsers.find((u) => normalizeEmail(u.email) === email);

    // Clean expired tokens
    const nowMs = Date.now();
    store.state.passwordResets = store.state.passwordResets.filter(
      (r) => !r.usedAt && new Date(r.expiresAt).getTime() > nowMs
    );

    if (user) {
      // Invalidate previous active reset tokens for this user
      store.state.passwordResets = store.state.passwordResets.filter((r) => r.userId !== user.id);
      const rawResetToken = crypto.randomBytes(32).toString('base64url');
      store.state.passwordResets.push({
        id: uuidv4(),
        userId: user.id,
        tokenHash: hashToken(rawResetToken),
        createdAt: new Date(nowMs).toISOString(),
        expiresAt: new Date(nowMs + RESET_TOKEN_TTL_MS).toISOString(),
        usedAt: null,
      });
      store.save();

      store.addAudit({
        actor: user.name,
        role: user.role,
        orgId: user.orgId,
        action: 'auth.password_reset_requested',
        entityType: 'user',
        entityId: user.id,
        summary: 'Password reset token generated (15-minute expiry).',
        mode: 'operational',
      });
    }

    const smtpConfigured = Boolean(process.env.SMTP_HOST && process.env.SMTP_USER);
    return res.status(200).json({
      ok: true,
      smtpConfigured,
      message: smtpConfigured
        ? 'If an account matches that email, a password reset link has been sent.'
        : 'Password reset request recorded. Outbound email delivery (SMTP) is not configured in this environment — contact your organization administrator or sign in with Google if your account is linked.',
    });
  });

  // POST /api/v1/auth/reset-password — Redeem single-use token, update hash, revoke prior sessions
  router.post('/reset-password', authRateLimit(20), (req, res) => {
    const parsed = ResetPasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      const firstErr = parsed.error.issues[0]?.message || 'Invalid password reset request.';
      return res.status(400).json({ error: firstErr, code: 'VALIDATION_ERROR' });
    }

    const strengthErr = validatePasswordStrength(parsed.data.newPassword);
    if (strengthErr) {
      return res.status(400).json({ error: strengthErr, code: 'WEAK_PASSWORD' });
    }

    const tokenHash = hashToken(parsed.data.token);
    const nowMs = Date.now();
    const record = store.state.passwordResets.find((r) => r.tokenHash === tokenHash);

    if (!record || record.usedAt || new Date(record.expiresAt).getTime() <= nowMs) {
      return res.status(400).json({
        error: 'This password reset link is invalid or has expired. Please request a new one.',
        code: 'INVALID_RESET_TOKEN',
      });
    }

    const user = store.state.authUsers.find((u) => u.id === record.userId);
    if (!user) {
      return res.status(400).json({ error: 'Account associated with this reset token was not found.' });
    }

    const { hash, salt } = hashPassword(parsed.data.newPassword);
    const nowIso = new Date(nowMs).toISOString();
    user.passwordHash = hash;
    user.passwordSalt = salt;
    if (user.provider === 'google') {
      user.provider = 'both';
    }
    user.updatedAt = nowIso;
    record.usedAt = nowIso;
    store.save();

    // Revoke all existing sessions for security after password reset
    revokeAllUserSessions(user.id);
    clearSessionCookie(req, res);

    store.addAudit({
      actor: user.name,
      role: user.role,
      orgId: user.orgId,
      action: 'auth.password_reset_completed',
      entityType: 'user',
      entityId: user.id,
      summary: 'Password updated via reset token and all prior sessions revoked.',
      mode: 'operational',
    });

    return res.status(200).json({
      ok: true,
      message: 'Your password has been updated. Please sign in with your new password.',
    });
  });

  // POST /api/v1/auth/change-password — Authenticated password update
  router.post('/change-password', verifyCsrfForCookieAuth, (req, res) => {
    const resolved = resolveSessionFromRequest(req);
    if (!resolved) {
      return res.status(401).json({ error: 'Authentication required.', code: 'AUTH_REQUIRED' });
    }

    const parsed = ChangePasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      const firstErr = parsed.error.issues[0]?.message || 'Invalid password update payload.';
      return res.status(400).json({ error: firstErr, code: 'VALIDATION_ERROR' });
    }

    const strengthErr = validatePasswordStrength(parsed.data.newPassword);
    if (strengthErr) {
      return res.status(400).json({ error: strengthErr, code: 'WEAK_PASSWORD' });
    }

    const { user } = resolved;
    if (user.uid === 'direct-command-operator') {
      return res.status(403).json({
        error: 'Password updates are unavailable for direct-access sessions. Sign in with an account to manage passwords.',
        code: 'FORBIDDEN',
      });
    }
    if (user.passwordHash && user.passwordSalt) {
      if (!parsed.data.currentPassword || !verifyPassword(parsed.data.currentPassword, user.passwordHash, user.passwordSalt)) {
        return res.status(401).json({
          error: 'Current password is incorrect.',
          code: 'INVALID_CURRENT_PASSWORD',
        });
      }
    }

    const { hash, salt } = hashPassword(parsed.data.newPassword);
    user.passwordHash = hash;
    user.passwordSalt = salt;
    if (user.provider === 'google') {
      user.provider = 'both';
    }
    user.updatedAt = new Date().toISOString();
    store.save();

    // Rotate session and revoke all older sessions
    revokeAllUserSessions(user.id);
    const { rawToken, session } = createSession(user, String(req.header('user-agent') || ''));
    setSessionCookie(req, res, rawToken);

    store.addAudit({
      actor: user.name,
      role: user.role,
      orgId: user.orgId,
      action: 'auth.password_changed',
      entityType: 'user',
      entityId: user.id,
      summary: 'Updated account password and rotated active session.',
      mode: 'operational',
    });

    return res.status(200).json({
      ok: true,
      user: toPublicUserProfile(user),
      sessionToken: rawToken,
      sessionExpiresAt: session.expiresAt,
      sessionDurationMs: SESSION_TTL_MS,
      serverNow: new Date().toISOString(),
      message: 'Password updated successfully.',
    });
  });

  // PATCH /api/v1/auth/role — Server-enforced RBAC role perspective switch (Super Admin only)
  router.patch('/role', verifyCsrfForCookieAuth, (req, res) => {
    const resolved = resolveSessionFromRequest(req);
    if (!resolved) {
      return res.status(401).json({ error: 'Authentication required.', code: 'AUTH_REQUIRED' });
    }

    const parsed = SwitchRoleSchema.safeParse(req.body);
    if (!parsed.success || !ALL_VALID_ROLES.includes(parsed.data.role)) {
      return res.status(400).json({ error: 'Invalid role selected.', code: 'VALIDATION_ERROR' });
    }

    const { user } = resolved;
    const requestedRole = parsed.data.role;

    if (user.baseRole !== 'super_admin' && requestedRole !== user.baseRole) {
      return res.status(403).json({
        error: `Forbidden: Your assigned account role is '${user.baseRole}'. Only super_admin accounts can switch operational role perspectives.`,
        code: 'FORBIDDEN_ROLE_CHANGE',
      });
    }

    user.role = requestedRole;
    user.updatedAt = new Date().toISOString();
    store.save();

    store.addAudit({
      actor: user.name,
      role: user.role,
      orgId: user.orgId,
      action: 'auth.role_switched',
      entityType: 'user',
      entityId: user.id,
      summary: `Switched active operational role to '${requestedRole}'.`,
      mode: 'operational',
    });

    return res.status(200).json({
      ok: true,
      user: toPublicUserProfile(user),
    });
  });

  return router;
}
