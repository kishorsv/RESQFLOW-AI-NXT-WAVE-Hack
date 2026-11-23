import { initializeApp, getApps, getApp, type FirebaseApp } from 'firebase/app';
import {
  browserLocalPersistence,
  browserPopupRedirectResolver,
  browserSessionPersistence,
  getAuth,
  getRedirectResult,
  GoogleAuthProvider,
  indexedDBLocalPersistence,
  initializeAuth,
  onAuthStateChanged,
  signInWithPopup,
  signInWithRedirect,
  signOut,
  type Auth,
  type User,
} from 'firebase/auth';
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocFromServer,
  getFirestore,
  initializeFirestore,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  where,
  type Firestore,
} from 'firebase/firestore';
import firebaseConfig from '../../firebase-applet-config.json';
import type { UserRole } from '../shared/types';

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string;
    email?: string | null;
    emailVerified?: boolean;
    isAnonymous?: boolean;
    providerInfo: { providerId: string; displayName: string | null; email: string | null }[];
  };
}

export type AuthFailureCategory =
  | 'user_cancelled'
  | 'unauthorized_domain'
  | 'invalid_api_key'
  | 'provider_disabled'
  | 'network_error'
  | 'invalid_credential'
  | 'storage_unavailable'
  | 'redirect_result_missing'
  | 'redirect_processing_failed'
  | 'oauth_callback_config'
  | 'unknown';

export interface ClassifiedAuthError {
  category: AuthFailureCategory;
  code: string;
  message: string;
  retryable: boolean;
}

export interface BrowserStorageCapabilities {
  localStorage: boolean;
  sessionStorage: boolean;
  indexedDB: boolean;
  cookiesEnabled: boolean;
  sameOriginAuthDomain: boolean;
}

export interface FirebaseConfigDiagnostics {
  valid: boolean;
  source: 'environment' | 'firebase-applet-config.json';
  projectIdStatus: 'configured' | 'missing' | 'invalid';
  projectIdLabel: string | null;
  apiKeyStatus: 'present' | 'missing' | 'invalid';
  authDomainStatus: 'configured' | 'missing' | 'invalid';
  sameOriginAuthProxyActive: boolean;
  issues: string[];
}

interface ResolvedFirebaseConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  storageBucket: string;
  messagingSenderId: string;
  appId: string;
  firestoreDatabaseId: string;
  oAuthClientId: string;
}

function sanitizeConfigString(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  let value = raw.trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1).trim();
  }
  return value;
}

function isPlaceholderConfigValue(value: string): boolean {
  if (!value) return true;
  const lower = value.toLowerCase();
  return (
    lower === 'undefined' ||
    lower === 'null' ||
    lower.includes('placeholder') ||
    lower.includes('your_') ||
    lower.includes('your-') ||
    lower.includes('my_firebase') ||
    lower.includes('replace_') ||
    lower.includes('replace-') ||
    lower.includes('change_me') ||
    lower.includes('example') ||
    lower.includes('remixed-project-id') ||
    lower.startsWith('<') ||
    lower.endsWith('>')
  );
}

function isValidFirebaseApiKeyFormat(value: string): boolean {
  if (!value || isPlaceholderConfigValue(value)) return false;
  return /^AIza[0-9A-Za-z_-]{30,50}$/.test(value);
}

function isValidProjectIdFormat(value: string): boolean {
  if (!value || isPlaceholderConfigValue(value)) return false;
  return /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(value);
}

function isValidAuthDomainFormat(value: string): boolean {
  if (!value || isPlaceholderConfigValue(value)) return false;
  return /^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(value) && !value.includes('://') && !value.includes('/');
}

/**
 * Returns the current browser hostname when running on an HTTPS origin where:
 *  1. The app server transparently proxies `/__/auth/*` and serves `/__/firebase/init.json`
 *  2. The Google Cloud OAuth client & Firebase Authorized Domains already authorize
 *     `https://<host>/__/auth/handler` (e.g. AI Studio Cloud Run hosts).
 * Using same-origin authDomain completely eliminates third-party storage partitioning in
 * Chrome, Edge, Safari, and Firefox without weakening browser privacy settings.
 */
function detectVerifiedSameOriginProxyHost(): string | null {
  if (typeof window === 'undefined') return null;
  if (window.location.protocol !== 'https:') return null;
  const host = window.location.hostname.trim().toLowerCase();
  if (/^ais-(dev|pre|mob)-[a-z0-9-]+\.[a-z0-9-]+\.run\.app$/.test(host)) {
    return host;
  }
  return null;
}

const rawCfg = firebaseConfig as typeof firebaseConfig & { firestoreDatabaseId?: string };

function evaluateConfigCandidate(
  candidate: ResolvedFirebaseConfig,
  source: FirebaseConfigDiagnostics['source'],
  sameOriginAuthProxyActive: boolean
): FirebaseConfigDiagnostics {
  const issues: string[] = [];

  let apiKeyStatus: FirebaseConfigDiagnostics['apiKeyStatus'] = 'present';
  if (!candidate.apiKey) {
    apiKeyStatus = 'missing';
    issues.push(
      source === 'environment'
        ? 'VITE_FIREBASE_API_KEY is missing in this deployment environment.'
        : 'Firebase API key is missing from firebase-applet-config.json.'
    );
  } else if (!isValidFirebaseApiKeyFormat(candidate.apiKey)) {
    apiKeyStatus = 'invalid';
    issues.push(
      source === 'environment'
        ? 'VITE_FIREBASE_API_KEY is malformed, truncated, or a placeholder value.'
        : 'Firebase API key in firebase-applet-config.json has an invalid format.'
    );
  }

  let projectIdStatus: FirebaseConfigDiagnostics['projectIdStatus'] = 'configured';
  if (!candidate.projectId) {
    projectIdStatus = 'missing';
    issues.push(
      source === 'environment'
        ? 'VITE_FIREBASE_PROJECT_ID is missing.'
        : 'Firebase projectId is missing from firebase-applet-config.json.'
    );
  } else if (!isValidProjectIdFormat(candidate.projectId)) {
    projectIdStatus = 'invalid';
    issues.push(
      source === 'environment'
        ? 'VITE_FIREBASE_PROJECT_ID is not a valid Firebase project ID.'
        : 'Firebase projectId in firebase-applet-config.json is invalid.'
    );
  }

  let authDomainStatus: FirebaseConfigDiagnostics['authDomainStatus'] = 'configured';
  if (!candidate.authDomain) {
    authDomainStatus = 'missing';
    issues.push('Firebase authDomain is missing.');
  } else if (!isValidAuthDomainFormat(candidate.authDomain)) {
    authDomainStatus = 'invalid';
    issues.push('Firebase authDomain must be a bare hostname without https:// or paths.');
  }

  const valid = apiKeyStatus === 'present' && projectIdStatus === 'configured' && authDomainStatus === 'configured';

  return {
    valid,
    source,
    projectIdStatus,
    projectIdLabel: projectIdStatus === 'configured' ? candidate.projectId : null,
    apiKeyStatus,
    authDomainStatus,
    sameOriginAuthProxyActive,
    issues,
  };
}

function resolveAndValidateFirebaseConfig(): {
  config: ResolvedFirebaseConfig;
  diagnostics: FirebaseConfigDiagnostics;
} {
  const envApiKey = sanitizeConfigString(import.meta.env.VITE_FIREBASE_API_KEY);
  const envAuthDomain = sanitizeConfigString(import.meta.env.VITE_FIREBASE_AUTH_DOMAIN);
  const envProjectId = sanitizeConfigString(import.meta.env.VITE_FIREBASE_PROJECT_ID);
  const envStorageBucket = sanitizeConfigString(import.meta.env.VITE_FIREBASE_STORAGE_BUCKET);
  const envMessagingSenderId = sanitizeConfigString(import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID);
  const envAppId = sanitizeConfigString(import.meta.env.VITE_FIREBASE_APP_ID);
  const envDatabaseId = sanitizeConfigString(import.meta.env.VITE_FIREBASE_DATABASE_ID);

  const anyEnvOverride = Boolean(
    envApiKey ||
      envAuthDomain ||
      envProjectId ||
      envStorageBucket ||
      envMessagingSenderId ||
      envAppId
  );

  const onlyAuthDomainOverride = Boolean(
    envAuthDomain &&
      !envApiKey &&
      !envProjectId &&
      !envStorageBucket &&
      !envMessagingSenderId &&
      !envAppId &&
      !envDatabaseId
  );

  const validEnvAuthDomain = isValidAuthDomainFormat(envAuthDomain) ? envAuthDomain : '';
  const verifiedProxyHost = detectVerifiedSameOriginProxyHost();
  const currentHost = typeof window !== 'undefined' ? window.location.hostname.trim().toLowerCase() : '';

  const bundledAuthDomain =
    onlyAuthDomainOverride && validEnvAuthDomain
      ? validEnvAuthDomain
      : verifiedProxyHost || sanitizeConfigString(rawCfg.authDomain);

  const bundledCandidate: ResolvedFirebaseConfig = {
    apiKey: sanitizeConfigString(rawCfg.apiKey),
    authDomain: bundledAuthDomain,
    projectId: sanitizeConfigString(rawCfg.projectId),
    storageBucket: sanitizeConfigString(rawCfg.storageBucket),
    messagingSenderId: sanitizeConfigString(rawCfg.messagingSenderId),
    appId: sanitizeConfigString(rawCfg.appId),
    firestoreDatabaseId:
      sanitizeConfigString(rawCfg.firestoreDatabaseId) || 'ai-studio-5791098d-6842-4915-9d33-3e53282628e2',
    oAuthClientId: sanitizeConfigString(rawCfg.oAuthClientId),
  };

  const bundledSameOrigin = Boolean(currentHost && bundledAuthDomain.toLowerCase() === currentHost);
  const bundledDiagnostics = evaluateConfigCandidate(
    bundledCandidate,
    'firebase-applet-config.json',
    bundledSameOrigin
  );

  if (anyEnvOverride && !onlyAuthDomainOverride) {
    const envResolvedAuthDomain =
      validEnvAuthDomain || (isValidProjectIdFormat(envProjectId) ? `${envProjectId}.firebaseapp.com` : '');
    const envCandidate: ResolvedFirebaseConfig = {
      apiKey: envApiKey,
      projectId: envProjectId,
      authDomain: envResolvedAuthDomain,
      storageBucket: envStorageBucket || (isValidProjectIdFormat(envProjectId) ? `${envProjectId}.firebasestorage.app` : ''),
      messagingSenderId: envMessagingSenderId,
      appId: envAppId,
      firestoreDatabaseId: envDatabaseId || '(default)',
      oAuthClientId: '',
    };
    const envSameOrigin = Boolean(currentHost && envResolvedAuthDomain.toLowerCase() === currentHost);
    const envDiagnostics = evaluateConfigCandidate(envCandidate, 'environment', envSameOrigin);
    if (envDiagnostics.valid) {
      return { config: envCandidate, diagnostics: envDiagnostics };
    }
    if (bundledDiagnostics.valid) {
      return { config: bundledCandidate, diagnostics: bundledDiagnostics };
    }
    return { config: envCandidate, diagnostics: envDiagnostics };
  }

  return { config: bundledCandidate, diagnostics: bundledDiagnostics };
}

const resolvedFirebase = resolveAndValidateFirebaseConfig();
export const firebaseConfigDiagnostics: FirebaseConfigDiagnostics = resolvedFirebase.diagnostics;

let firebaseApp: FirebaseApp | null = null;
let firebaseAuthInstance: Auth | null = null;
let firestoreInstance: Firestore | null = null;

if (firebaseConfigDiagnostics.valid) {
  try {
    const cfg = resolvedFirebase.config;
    firebaseApp =
      getApps().length > 0
        ? getApp()
        : initializeApp({
            apiKey: cfg.apiKey,
            authDomain: cfg.authDomain,
            projectId: cfg.projectId,
            storageBucket: cfg.storageBucket || undefined,
            messagingSenderId: cfg.messagingSenderId || undefined,
            appId: cfg.appId || undefined,
          });

    // Single shared Auth instance with explicit multi-tier browser persistence + redirect resolver
    try {
      firebaseAuthInstance = initializeAuth(firebaseApp, {
        persistence: [
          indexedDBLocalPersistence,
          browserLocalPersistence,
          browserSessionPersistence,
        ],
        popupRedirectResolver: browserPopupRedirectResolver,
      });
    } catch {
      firebaseAuthInstance = getAuth(firebaseApp);
    }

    try {
      firestoreInstance = initializeFirestore(
        firebaseApp,
        { experimentalAutoDetectLongPolling: true },
        cfg.firestoreDatabaseId
      );
    } catch {
      firestoreInstance = getFirestore(firebaseApp, cfg.firestoreDatabaseId);
    }
  } catch (err) {
    firebaseConfigDiagnostics.valid = false;
    firebaseConfigDiagnostics.issues.push(
      err instanceof Error ? err.message : 'Firebase SDK failed to initialize with the current configuration.'
    );
    firebaseApp = null;
    firebaseAuthInstance = null;
    firestoreInstance = null;
  }
} else {
  // Safe, non-secret diagnostic log (NEVER logs the API key value)
  console.error(
    `[Firebase] Configuration invalid | status=invalid | source=${firebaseConfigDiagnostics.source} | projectId=${firebaseConfigDiagnostics.projectIdStatus} | apiKey=${firebaseConfigDiagnostics.apiKeyStatus}`
  );
}

export const auth: Auth | null = firebaseAuthInstance;
export const db: Firestore | null = firestoreInstance;
export const firebaseProjectId = resolvedFirebase.config.projectId;
export const firebaseAuthDomain = resolvedFirebase.config.authDomain;
export const firebaseOAuthClientId = resolvedFirebase.config.oAuthClientId;

export const WORKSPACE_SCOPES = [
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/presentations',
  'https://www.googleapis.com/auth/tasks',
  'https://www.googleapis.com/auth/chat.spaces.readonly',
  'https://www.googleapis.com/auth/chat.messages.create',
  'https://www.googleapis.com/auth/forms.body',
  'https://www.googleapis.com/auth/forms.responses.readonly',
  'https://www.googleapis.com/auth/meetings.space.created',
  'https://www.googleapis.com/auth/contacts.readonly',
];

// Strictly in-memory OAuth access token cache (NEVER localStorage or sessionStorage)
let inMemoryWorkspaceToken: string | null = null;
const tokenListeners = new Set<(token: string | null) => void>();

export function getWorkspaceAccessToken(): string | null {
  return inMemoryWorkspaceToken;
}

export function setWorkspaceAccessToken(token: string | null) {
  inMemoryWorkspaceToken = token;
  for (const listener of tokenListeners) {
    listener(token);
  }
}

export function subscribeWorkspaceToken(cb: (token: string | null) => void): () => void {
  tokenListeners.add(cb);
  cb(inMemoryWorkspaceToken);
  return () => {
    tokenListeners.delete(cb);
  };
}

if (auth) {
  onAuthStateChanged(auth, (user) => {
    if (!user) {
      setWorkspaceAccessToken(null);
    }
  });
}

// ============================================================================
// BROWSER STORAGE DIAGNOSTICS & SAFE LOGGING (ZERO SECRETS)
// ============================================================================

export function detectBrowserStorageCapabilities(): BrowserStorageCapabilities {
  let localOk = false;
  let sessionOk = false;
  let idbOk = false;
  let cookiesOk = false;

  if (typeof window !== 'undefined') {
    try {
      const probeKey = '__rf_storage_probe__';
      window.localStorage.setItem(probeKey, '1');
      window.localStorage.removeItem(probeKey);
      localOk = true;
    } catch {
      localOk = false;
    }
    try {
      const probeKey = '__rf_session_probe__';
      window.sessionStorage.setItem(probeKey, '1');
      window.sessionStorage.removeItem(probeKey);
      sessionOk = true;
    } catch {
      sessionOk = false;
    }
    try {
      idbOk = typeof window.indexedDB !== 'undefined' && window.indexedDB !== null;
    } catch {
      idbOk = false;
    }
    try {
      cookiesOk = Boolean(navigator.cookieEnabled);
    } catch {
      cookiesOk = false;
    }
  }

  const currentHost = typeof window !== 'undefined' ? window.location.hostname.trim().toLowerCase() : '';
  const sameOriginAuthDomain = Boolean(
    currentHost && firebaseAuthDomain && firebaseAuthDomain.trim().toLowerCase() === currentHost
  );

  return {
    localStorage: localOk,
    sessionStorage: sessionOk,
    indexedDB: idbOk,
    cookiesEnabled: cookiesOk,
    sameOriginAuthDomain,
  };
}

export function logSafeAuthDiagnostic(
  redirectRecoveryStatus: string,
  firebaseErrorCode = 'none'
): void {
  const storage = detectBrowserStorageCapabilities();
  const hostname = typeof window !== 'undefined' ? window.location.hostname : 'server';
  console.info('[RESQFLOW Auth Diagnostic]', {
    firebaseErrorCode,
    authInitialized: Boolean(auth && firebaseConfigDiagnostics.valid),
    redirectRecoveryStatus,
    storageCapabilities: storage,
    hostname,
    authDomain: firebaseAuthDomain || 'unset',
    projectId: firebaseProjectId || 'unset',
  });
}

// ============================================================================
// REDIRECT-BASED GOOGLE AUTH STATE HELPERS (Non-sensitive UI intent only)
// ============================================================================

const REDIRECT_INTENT_KEY = 'resqflow_google_redirect_intent';
const REDIRECT_INTENT_TTL_MS = 10 * 60 * 1000;

export interface GoogleRedirectIntent {
  next: string;
  startedAt: number;
}

export function markGoogleRedirectPending(nextPath: string): void {
  try {
    if (typeof sessionStorage !== 'undefined') {
      const payload: GoogleRedirectIntent = {
        next: nextPath || '/dashboard',
        startedAt: Date.now(),
      };
      sessionStorage.setItem(REDIRECT_INTENT_KEY, JSON.stringify(payload));
    }
  } catch {
    // Ignore restricted storage contexts
  }
}

export function readGoogleRedirectPending(): GoogleRedirectIntent | null {
  try {
    if (typeof sessionStorage === 'undefined') return null;
    const raw = sessionStorage.getItem(REDIRECT_INTENT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<GoogleRedirectIntent>;
    if (!parsed || typeof parsed.startedAt !== 'number') {
      sessionStorage.removeItem(REDIRECT_INTENT_KEY);
      return null;
    }
    if (Date.now() - parsed.startedAt > REDIRECT_INTENT_TTL_MS) {
      sessionStorage.removeItem(REDIRECT_INTENT_KEY);
      return null;
    }
    return {
      next: typeof parsed.next === 'string' ? parsed.next : '/dashboard',
      startedAt: parsed.startedAt,
    };
  } catch {
    return null;
  }
}

export function clearGoogleRedirectPending(): void {
  try {
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.removeItem(REDIRECT_INTENT_KEY);
    }
  } catch {
    // Ignore
  }
}

export function isRunningInIframe(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
}

// ============================================================================
// CLASSIFIED FIREBASE ERROR HANDLING
// ============================================================================

export function classifyFirebaseAuthError(error: unknown): ClassifiedAuthError {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code?: unknown }).code || '')
      : '';
  const rawMessage = error instanceof Error ? error.message : String(error || '');
  const lowerMsg = rawMessage.toLowerCase();
  const hostname = typeof window !== 'undefined' ? window.location.hostname : 'current host';

  if (
    code === 'auth/invalid-api-key' ||
    code === 'auth/api-key-not-valid.-please-pass-a-valid-api-key' ||
    lowerMsg.includes('api-key-not-valid') ||
    lowerMsg.includes('invalid-api-key')
  ) {
    return {
      category: 'invalid_api_key',
      code: code || 'auth/invalid-api-key',
      message: `Firebase rejected the Web API key configured for project "${firebaseProjectId || 'unconfigured'}". Verify VITE_FIREBASE_API_KEY in your deployment environment and trigger a fresh build—or sign in with email & password.`,
      retryable: false,
    };
  }

  if (code === 'auth/unauthorized-domain' || lowerMsg.includes('auth/unauthorized-domain')) {
    return {
      category: 'unauthorized_domain',
      code: 'auth/unauthorized-domain',
      message: `This domain (${hostname}) is not authorized in Firebase project "${firebaseProjectId}". Add it under Firebase Console → Authentication → Settings → Authorized domains, or sign in with email & password.`,
      retryable: false,
    };
  }

  if (
    code === 'auth/redirect-cancelled-by-user' ||
    code === 'auth/popup-closed-by-user'
  ) {
    return {
      category: 'user_cancelled',
      code,
      message: 'Google Sign-In was cancelled before completing authorization. Click below when you are ready to try again.',
      retryable: true,
    };
  }

  if (code === 'auth/operation-not-allowed' || code === 'auth/configuration-not-found') {
    return {
      category: 'provider_disabled',
      code,
      message: `Google Sign-In is not enabled in Firebase project "${firebaseProjectId}". Enable Google under Firebase Console → Authentication → Sign-in method.`,
      retryable: false,
    };
  }

  if (code === 'auth/network-request-failed') {
    return {
      category: 'network_error',
      code,
      message: 'Network error while contacting Google Authentication. Check your connection and retry.',
      retryable: true,
    };
  }

  if (
    code === 'auth/invalid-credential' ||
    code === 'auth/account-exists-with-different-credential' ||
    code === 'auth/user-disabled'
  ) {
    return {
      category: 'invalid_credential',
      code,
      message:
        code === 'auth/user-disabled'
          ? 'This account has been disabled by an administrator.'
          : code === 'auth/account-exists-with-different-credential'
            ? 'An account already exists with this email using a different sign-in method.'
            : 'Google returned an invalid or expired credential. Click below to start a fresh sign-in.',
      retryable: code !== 'auth/user-disabled',
    };
  }

  if (code === 'auth/web-storage-unsupported' || lowerMsg.includes('missing initial state')) {
    return {
      category: 'storage_unavailable',
      code: code || 'auth/web-storage-unsupported',
      message:
        'Browser storage was unavailable or reset during the Google redirect. Ensure browser storage is available for this site, or sign in with email and password.',
      retryable: true,
    };
  }

  if (lowerMsg.includes('redirect_uri_mismatch') || code === 'auth/invalid-continue-uri') {
    return {
      category: 'oauth_callback_config',
      code: code || 'oauth/redirect_uri_mismatch',
      message: `OAuth callback URI mismatch for authDomain "${firebaseAuthDomain}". Verify that https://${firebaseAuthDomain}/__/auth/handler is listed under Authorized redirect URIs in Google Cloud Console.`,
      retryable: false,
    };
  }

  if (code === 'auth/redirect-operation-pending' || code === 'auth/cancelled-popup-request') {
    return {
      category: 'redirect_processing_failed',
      code,
      message: 'A Google Sign-In request is already in progress. Please wait a moment and try again.',
      retryable: true,
    };
  }

  if (code === 'auth/too-many-requests') {
    return {
      category: 'network_error',
      code,
      message: 'Too many sign-in attempts. Please wait a moment before trying again.',
      retryable: true,
    };
  }

  if (code === 'auth/popup-blocked') {
    return {
      category: 'redirect_processing_failed',
      code,
      message: 'The browser blocked the Google Workspace authorization window. Please allow popups for Workspace Hub.',
      retryable: true,
    };
  }

  return {
    category: 'unknown',
    code: code || 'unknown',
    message: rawMessage || 'Google authentication could not be completed. Please try again.',
    retryable: true,
  };
}

export function mapFirebaseAuthError(error: unknown): string {
  return classifyFirebaseAuthError(error).message;
}

export function classifyMissingRedirectResult(): ClassifiedAuthError {
  const storage = detectBrowserStorageCapabilities();
  const hostname = typeof window !== 'undefined' ? window.location.hostname : 'this host';

  if (!storage.indexedDB && !storage.localStorage && !storage.sessionStorage) {
    return {
      category: 'storage_unavailable',
      code: 'storage/unavailable',
      message:
        'Browser storage (IndexedDB, localStorage, and sessionStorage) is unavailable in this browsing context, so the Google Sign-In session could not be restored. Try a standard browser tab or sign in with email and password.',
      retryable: false,
    };
  }

  if (!storage.sameOriginAuthDomain && hostname !== 'localhost' && hostname !== '127.0.0.1') {
    return {
      category: 'oauth_callback_config',
      code: 'auth/cross-origin-redirect-partitioned',
      message: `Google returned to ${hostname}, but Firebase authDomain is set to cross-origin "${firebaseAuthDomain}", where modern browsers isolate redirect storage. Configure same-origin VITE_FIREBASE_AUTH_DOMAIN=${hostname} with https://${hostname}/__/auth/handler authorized in Google Cloud Console, or sign in with email and password.`,
      retryable: true,
    };
  }

  return {
    category: 'redirect_result_missing',
    code: 'auth/redirect-result-missing',
    message:
      'Google Sign-In returned without an active authentication credential. If you closed or backed out of the Google sign-in screen, click Retry Google Sign-In below, or sign in with email and password.',
    retryable: true,
  };
}

export function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth?.currentUser?.uid,
      email: auth?.currentUser?.email,
      emailVerified: auth?.currentUser?.emailVerified,
      isAnonymous: auth?.currentUser?.isAnonymous,
      providerInfo:
        auth?.currentUser?.providerData.map((p) => ({
          providerId: p.providerId,
          displayName: p.displayName,
          email: p.email,
        })) || [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error:', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

export async function testFirestoreConnection(): Promise<{ ok: boolean; message: string }> {
  if (!db || !firebaseConfigDiagnostics.valid) {
    return { ok: false, message: 'Firebase configuration is invalid — Firestore initialization skipped.' };
  }
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
    return { ok: true, message: 'Firestore connection verified.' };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes('the client is offline')) {
      return { ok: false, message: 'Firestore client offline — verify Firebase database configuration.' };
    }
    return { ok: true, message: 'Firestore reachable.' };
  }
}

export async function syncFirestoreUserProfile(
  user: User,
  assignedRole: UserRole = 'field_responder'
): Promise<void> {
  if (!db) return;
  const userRef = doc(db, 'users', user.uid);
  const privateRef = doc(db, 'users', user.uid, 'private', 'profile');
  const displayName = (user.displayName || user.email?.split('@')[0] || 'Responder').trim().slice(0, 120);

  try {
    const existing = await getDoc(userRef);
    if (!existing.exists()) {
      const safeCreateRole: UserRole =
        assignedRole === 'field_responder' || assignedRole === 'citizen_reporter'
          ? assignedRole
          : 'field_responder';
      await setDoc(userRef, {
        uid: user.uid,
        displayName,
        orgId: 'org-central-cmd',
        role: safeCreateRole,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } else {
      await setDoc(
        userRef,
        {
          displayName,
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );
    }

    if (user.email) {
      await setDoc(
        privateRef,
        {
          uid: user.uid,
          email: user.email,
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );
    }
  } catch {
    // Non-fatal if Firestore rules restrict elevated profile fields; server session remains authoritative
  }
}

// ============================================================================
// SINGLE-EXECUTION REDIRECT INITIATION & RECOVERY
// ============================================================================

let redirectInitiationInFlight = false;
let cachedRedirectOutcomePromise: Promise<GoogleRedirectOutcome> | null = null;

/**
 * Initiates a full-page Google OAuth redirect synchronously from the user's button click.
 * Uses the single shared Auth instance + explicit browserPopupRedirectResolver; zero popups.
 */
export async function startGoogleSignInRedirect(nextPath = '/dashboard'): Promise<void> {
  if (redirectInitiationInFlight) {
    return;
  }
  if (!firebaseConfigDiagnostics.valid || !auth) {
    throw new Error(
      firebaseConfigDiagnostics.issues[0] ||
        'Google Sign-In is unavailable because Firebase configuration is incomplete or invalid.'
    );
  }
  const storage = detectBrowserStorageCapabilities();
  if (!storage.indexedDB && !storage.localStorage && !storage.sessionStorage) {
    throw Object.assign(
      new Error('Browser storage is unavailable in this environment.'),
      { code: 'auth/web-storage-unsupported' }
    );
  }

  redirectInitiationInFlight = true;
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  markGoogleRedirectPending(nextPath);
  logSafeAuthDiagnostic('redirect_initiated');

  try {
    await signInWithRedirect(auth, provider, browserPopupRedirectResolver);
  } catch (err) {
    redirectInitiationInFlight = false;
    clearGoogleRedirectPending();
    const classified = classifyFirebaseAuthError(err);
    logSafeAuthDiagnostic(`redirect_initiation_failed:${classified.category}`, classified.code);
    throw err;
  }
}

export type GoogleRedirectOutcome =
  | { status: 'success'; user: User; idToken: string }
  | { status: 'none' }
  | { status: 'error'; error: ClassifiedAuthError };

/**
 * Processes the Firebase OAuth redirect callback strictly ONCE per page load
 * (memoized promise prevents React re-renders or double effects from racing getRedirectResult).
 */
export function resolveGoogleRedirectOnce(): Promise<GoogleRedirectOutcome> {
  if (cachedRedirectOutcomePromise) {
    return cachedRedirectOutcomePromise;
  }

  cachedRedirectOutcomePromise = (async (): Promise<GoogleRedirectOutcome> => {
    if (!firebaseConfigDiagnostics.valid || !auth) {
      clearGoogleRedirectPending();
      return { status: 'none' };
    }
    try {
      const result = await getRedirectResult(auth, browserPopupRedirectResolver);
      if (!result?.user) {
        return { status: 'none' };
      }
      const idToken = await result.user.getIdToken();
      logSafeAuthDiagnostic('redirect_result_recovered');
      return { status: 'success', user: result.user, idToken };
    } catch (err) {
      const classified = classifyFirebaseAuthError(err);
      logSafeAuthDiagnostic(`redirect_result_error:${classified.category}`, classified.code);
      return { status: 'error', error: classified };
    }
  })();

  return cachedRedirectOutcomePromise;
}

/**
 * Coordinates authStateReady() with onAuthStateChanged without racing getRedirectResult.
 * When returning from a Google redirect, waits briefly for IndexedDB/Auth observer hydration
 * if currentUser is not yet populated immediately after authStateReady().
 */
export async function waitForFirebaseAuthUser(settleTimeoutMs = 0): Promise<User | null> {
  if (!auth) return null;
  try {
    await auth.authStateReady();
  } catch {
    // ignore
  }
  if (auth.currentUser) {
    return auth.currentUser;
  }
  if (settleTimeoutMs <= 0) {
    return null;
  }

  return new Promise<User | null>((resolve) => {
    let settled = false;
    let timerId: number | null = null;
    const unsub = onAuthStateChanged(auth!, (u) => {
      if (u && !settled) {
        settled = true;
        if (timerId !== null) window.clearTimeout(timerId);
        unsub();
        resolve(u);
      }
    });
    timerId = window.setTimeout(() => {
      if (!settled) {
        settled = true;
        unsub();
        resolve(auth?.currentUser || null);
      }
    }, settleTimeoutMs);
  });
}

export async function refreshFirebaseIdTokenSilently(): Promise<boolean> {
  if (!auth?.currentUser) return false;
  try {
    await auth.currentUser.getIdToken(true);
    return true;
  } catch {
    return false;
  }
}

/**
 * Opt-in Google Workspace OAuth authorization used exclusively inside WorkspaceHubView
 * to unlock Drive, Sheets, Gmail, Calendar, Docs, Slides, Tasks, Chat, Forms, Meet, Contacts.
 */
export async function signInWithGoogleWorkspace(includeWorkspaceScopes = true): Promise<{
  user: User;
  accessToken: string | null;
  idToken: string;
}> {
  if (!firebaseConfigDiagnostics.valid || !auth) {
    throw new Error(
      firebaseConfigDiagnostics.issues[0] ||
        'Firebase configuration is invalid. Unable to start Google Workspace authorization.'
    );
  }
  const provider = new GoogleAuthProvider();
  if (includeWorkspaceScopes) {
    for (const scope of WORKSPACE_SCOPES) {
      provider.addScope(scope);
    }
  }
  provider.setCustomParameters({ prompt: 'select_account' });
  const result = await signInWithPopup(auth, provider, browserPopupRedirectResolver);
  const credential = GoogleAuthProvider.credentialFromResult(result);
  const accessToken = credential?.accessToken || null;
  if (accessToken) {
    setWorkspaceAccessToken(accessToken);
  }
  const idToken = await result.user.getIdToken();
  await syncFirestoreUserProfile(result.user);
  return { user: result.user, accessToken, idToken };
}

export async function signOutGoogle(): Promise<void> {
  redirectInitiationInFlight = false;
  clearGoogleRedirectPending();
  setWorkspaceAccessToken(null);
  if (!auth) return;
  try {
    await signOut(auth);
  } catch {
    // Ignore if Firebase user was not signed in (e.g. email/password session)
  }
}

// ============================================================================
// FIELD NOTES IN FIRESTORE (Replaces Enterprise-only Google Keep API)
// ============================================================================

export interface FieldNote {
  id: string;
  title: string;
  content: string;
  incidentId?: string;
  ownerId: string;
  createdAt: string;
}

export function subscribeFieldNotes(
  uid: string,
  onUpdate: (notes: FieldNote[]) => void,
  onError?: (err: string) => void
) {
  if (!db) {
    onError?.('Firestore is unavailable because Firebase configuration is invalid.');
    return () => {};
  }
  const path = 'field_notes';
  const q = query(collection(db, path), where('ownerId', '==', uid), orderBy('createdAt', 'desc'));
  return onSnapshot(
    q,
    (snap) => {
      const notes: FieldNote[] = snap.docs.map((d) => {
        const data = d.data();
        return {
          id: d.id,
          title: String(data.title || 'Untitled Field Note'),
          content: String(data.content || ''),
          incidentId: data.incidentId ? String(data.incidentId) : undefined,
          ownerId: String(data.ownerId || uid),
          createdAt: data.createdAt?.toDate
            ? data.createdAt.toDate().toISOString()
            : String(data.createdAt || new Date().toISOString()),
        };
      });
      onUpdate(notes);
    },
    (err) => {
      if (onError) onError(err.message);
    }
  );
}

export async function createFieldNote(uid: string, title: string, content: string, incidentId?: string) {
  if (!db) {
    throw new Error('Firestore is unavailable because Firebase configuration is invalid.');
  }
  const path = 'field_notes';
  try {
    await addDoc(collection(db, path), {
      title: title.trim(),
      content: content.trim(),
      incidentId: incidentId || '',
      ownerId: uid,
      createdAt: serverTimestamp(),
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, path);
  }
}

export async function deleteFieldNote(noteId: string) {
  if (!db) {
    throw new Error('Firestore is unavailable because Firebase configuration is invalid.');
  }
  const path = `field_notes/${noteId}`;
  try {
    await deleteDoc(doc(db, 'field_notes', noteId));
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, path);
  }
}
