import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  ExternalLink,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  Lock,
  Mail,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react';
import { apiRequest, setSessionToken } from '../../lib/api';
import {
  firebaseConfigDiagnostics,
  isRunningInIframe,
  mapFirebaseAuthError,
  startGoogleSignInRedirect,
} from '../../lib/firebase';
import {
  buildLoginUrl,
  navigateTo,
  sanitizeReturnPath,
  type AppRouteKind,
} from '../../lib/authRoutes';
import type { AuthUserProfile } from '../../shared/types';
import { BrandMark } from '../ui/BrandMark';

export interface SessionTimingMeta {
  sessionExpiresAt?: string | null;
  sessionDurationMs?: number | null;
  serverNow?: string | null;
}

interface AuthViewProps {
  mode: Extract<AppRouteKind, 'login' | 'forgot-password' | 'reset-password' | 'auth-callback'>;
  nextPath: string | null;
  resetToken: string | null;
  sessionNotice: string | null;
  externalError?: string | null;
  externalErrorRetryable?: boolean;
  onClearSessionNotice: () => void;
  onClearExternalError?: () => void;
  onAuthenticated: (
    user: AuthUserProfile,
    sessionToken: string | null,
    destination: string,
    sessionMeta?: SessionTimingMeta
  ) => void;
}

export const AuthView: React.FC<AuthViewProps> = ({
  mode,
  nextPath,
  resetToken,
  sessionNotice,
  externalError = null,
  externalErrorRetryable = true,
  onClearSessionNotice,
  onClearExternalError,
  onAuthenticated,
}) => {
  const destination = useMemo(() => sanitizeReturnPath(nextPath, '/dashboard'), [nextPath]);
  const embeddedInIframe = useMemo(() => isRunningInIframe(), []);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [manualResetToken, setManualResetToken] = useState(resetToken || '');
  const [showPassword, setShowPassword] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [iframeGoogleNotice, setIframeGoogleNotice] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
    setSuccessMessage(null);
    setStatusMessage(null);
    setIframeGoogleNotice(false);
    if (resetToken) {
      setManualResetToken(resetToken);
    }
  }, [mode, resetToken]);

  const activeError = error || externalError;

  const passwordChecks = useMemo(
    () => [
      { label: 'At least 8 characters', ok: password.length >= 8 },
      { label: 'One uppercase letter', ok: /[A-Z]/.test(password) },
      { label: 'One lowercase letter', ok: /[a-z]/.test(password) },
      { label: 'One number', ok: /[0-9]/.test(password) },
    ],
    [password]
  );

  const allPasswordChecksPass = passwordChecks.every((c) => c.ok);

  const firebaseConfigReady = firebaseConfigDiagnostics.valid;

  const handleGoogleRedirectSignIn = () => {
    if (submitting || googleLoading || !firebaseConfigReady) return;
    setError(null);
    setSuccessMessage(null);
    setIframeGoogleNotice(false);
    onClearSessionNotice();
    onClearExternalError?.();

    // Google's OAuth consent page sets X-Frame-Options: DENY, so an embedded iframe cannot redirect to Google directly.
    if (embeddedInIframe) {
      setIframeGoogleNotice(true);
      return;
    }

    setGoogleLoading(true);
    setStatusMessage('Redirecting to Google...');

    // Invoke redirect directly from the user click handler without unrelated async delays
    void startGoogleSignInRedirect(destination).catch((err) => {
      setError(mapFirebaseAuthError(err));
      setStatusMessage(null);
      setGoogleLoading(false);
    });
  };

  const handleLoginSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccessMessage(null);
    onClearSessionNotice();
    onClearExternalError?.();

    const trimmedEmail = email.trim();
    if (!trimmedEmail || !password) {
      setError('Please enter both your email address and password.');
      return;
    }

    setSubmitting(true);
    setStatusMessage('Securely connecting...');
    try {
      const res = await apiRequest<{
        authenticated: boolean;
        user: AuthUserProfile;
        sessionToken?: string;
        sessionExpiresAt?: string;
        sessionDurationMs?: number;
        serverNow?: string;
      }>('/auth/login', {
        method: 'POST',
        body: { email: trimmedEmail, password },
      });
      setStatusMessage('Preparing your command center...');
      setSessionToken(res.sessionToken || null);
      onAuthenticated(res.user, res.sessionToken || null, destination, {
        sessionExpiresAt: res.sessionExpiresAt,
        sessionDurationMs: res.sessionDurationMs,
        serverNow: res.serverNow,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to sign in. Please verify your credentials.');
      setStatusMessage(null);
    } finally {
      setSubmitting(false);
    }
  };

  const handleForgotSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccessMessage(null);
    onClearExternalError?.();

    if (!email.trim()) {
      setError('Please enter your account email address.');
      return;
    }

    setSubmitting(true);
    try {
      const res = await apiRequest<{ ok: boolean; message: string }>('/auth/forgot-password', {
        method: 'POST',
        body: { email: email.trim() },
      });
      setSuccessMessage(res.message);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to process password reset request.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleResetSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccessMessage(null);
    onClearExternalError?.();

    if (!manualResetToken.trim()) {
      setError('Please provide a valid password reset token.');
      return;
    }
    if (!allPasswordChecksPass) {
      setError('Please meet all password strength requirements.');
      return;
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    setSubmitting(true);
    try {
      const res = await apiRequest<{ ok: boolean; message: string }>('/auth/reset-password', {
        method: 'POST',
        body: { token: manualResetToken.trim(), newPassword: password },
      });
      setSuccessMessage(res.message);
      setPassword('');
      setConfirmPassword('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to reset password.');
    } finally {
      setSubmitting(false);
    }
  };

  const busy = submitting || googleLoading;
  const fullTabUrl = typeof window !== 'undefined' ? window.location.href : '/login';

  return (
    <div className="min-h-screen bg-[#070B14] text-[#F7F9FF] flex flex-col relative overflow-hidden">
      {/* Subtle atmospheric lighting matching RESQFLOW AI homepage */}
      <div
        className="pointer-events-none fixed inset-0"
        aria-hidden="true"
        style={{
          background:
            'radial-gradient(60% 45% at 20% 0%, rgba(113,133,255,0.16) 0%, rgba(7,11,20,0) 70%), radial-gradient(45% 40% at 85% 95%, rgba(53,200,245,0.12) 0%, rgba(7,11,20,0) 70%)',
        }}
      />

      {/* Top Navigation Bar */}
      <header className="relative z-10 h-[72px] px-5 sm:px-8 border-b border-white/10 bg-[#070B14]/80 backdrop-blur-xl">
        <div className="max-w-[1280px] h-full mx-auto flex items-center justify-between gap-4">
          <button
            type="button"
            onClick={() => navigateTo('/')}
            className="flex items-center gap-2.5 text-left group"
          >
            <BrandMark size={30} />
            <div>
              <div className="font-[var(--font-display)] text-[16px] font-bold tracking-tight text-[#F7F9FF]">
                RESQFLOW AI
              </div>
              <div className="text-[11px] text-[#A0AEC0]">Command Access Portal</div>
            </div>
          </button>

          <button
            type="button"
            onClick={() => navigateTo('/')}
            className="inline-flex items-center gap-2 px-3.5 h-9 rounded-[10px] border border-white/15 bg-[#111A2A]/70 hover:bg-[#111A2A] text-xs font-medium text-[#CBD5E1] hover:text-white transition-colors"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            <span>Back to Home</span>
          </button>
        </div>
      </header>

      {/* Center Auth Container */}
      <main className="relative z-10 flex-1 flex items-center justify-center px-4 py-10 sm:py-14">
        <div className="w-full max-w-[460px] rounded-2xl border border-white/10 bg-[#0B1220]/95 backdrop-blur-xl shadow-[0_24px_80px_rgba(0,0,0,0.65)] p-6 sm:p-8 space-y-6">
          {/* Header */}
          <div className="space-y-2">
            <div className="inline-flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-[#35C8F5]">
              <ShieldCheck className="w-3.5 h-3.5" />
              <span>Verified Command Authentication</span>
            </div>
            <h1 className="font-[var(--font-display)] text-2xl sm:text-[26px] font-bold tracking-tight text-[#F7F9FF]">
              {mode === 'login' && 'Sign in to RESQFLOW AI'}
              {mode === 'forgot-password' && 'Reset your password'}
              {mode === 'reset-password' && 'Set a new password'}
              {mode === 'auth-callback' && 'Authentication callback'}
            </h1>
            <p className="text-sm text-[#A0AEC0] leading-relaxed">
              {mode === 'login' &&
                'Authenticate to access live emergency operations, inventory intelligence, and AI coordination.'}
              {mode === 'forgot-password' &&
                'Enter your registered email address to request a single-use password reset token.'}
              {mode === 'reset-password' &&
                'Enter your reset token and choose a strong new password.'}
              {mode === 'auth-callback' &&
                'No active authentication callback was detected for this tab. Sign in below to establish your session.'}
            </p>
          </div>

          {/* Session Expired / Protected Route Notice */}
          {sessionNotice && (
            <div
              role="status"
              className="p-3.5 rounded-xl border border-[#FFB547]/35 bg-[#FFB547]/10 text-xs text-[#FFD084] flex items-start gap-2.5"
            >
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-[#FFB547]" />
              <span>{sessionNotice}</span>
            </div>
          )}

          {/* Embedded Preview Iframe Notice (Google blocks iframe OAuth via X-Frame-Options: DENY) */}
          {iframeGoogleNotice && (
            <div
              role="status"
              className="p-3.5 rounded-xl border border-[#35C8F5]/35 bg-[#35C8F5]/10 text-xs text-[#C6F1FF] space-y-2.5 leading-relaxed"
            >
              <div className="flex items-start gap-2.5">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-[#35C8F5]" />
                <span>
                  Google Sign-In redirects cannot open inside an embedded preview frame. Open RESQFLOW AI in a full browser tab to continue with Google, or sign in with email and password below.
                </span>
              </div>
              <a
                href={fullTabUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="w-full h-9 px-3 rounded-[9px] bg-[#35C8F5]/20 hover:bg-[#35C8F5]/30 border border-[#35C8F5]/40 text-white font-medium inline-flex items-center justify-center gap-2 transition-colors"
              >
                <span>Open in Full Browser Tab</span>
                <ExternalLink className="w-3.5 h-3.5" />
              </a>
            </div>
          )}

          {/* Safe Pre-Initialization Firebase Config Diagnostics (never exposes full API keys) */}
          {!firebaseConfigReady && (mode === 'login' || mode === 'auth-callback') && (
            <div
              role="alert"
              className="p-3.5 rounded-xl border border-[#FFB547]/40 bg-[#FFB547]/10 text-xs text-[#FFD084] space-y-2 leading-relaxed"
            >
              <div className="flex items-start gap-2.5">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-[#FFB547]" />
                <div className="space-y-1">
                  <div className="font-semibold text-[#FFE0A3]">
                    Google Sign-In unavailable — Firebase configuration check failed
                  </div>
                  <div className="font-mono text-[11px] text-[#FFD084]/90 space-y-0.5">
                    <div>Firebase configuration status: invalid ({firebaseConfigDiagnostics.source})</div>
                    <div>
                      Firebase project ID: {firebaseConfigDiagnostics.projectIdStatus}
                      {firebaseConfigDiagnostics.projectIdLabel
                        ? ` (${firebaseConfigDiagnostics.projectIdLabel})`
                        : ''}
                    </div>
                    <div>Firebase API key: {firebaseConfigDiagnostics.apiKeyStatus}</div>
                  </div>
                  {firebaseConfigDiagnostics.issues[0] && (
                    <p className="text-[11px] text-[#FFE5B4] pt-0.5">
                      {firebaseConfigDiagnostics.issues[0]} Email &amp; password sign-in remains active below.
                    </p>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Provider / Validation Error Alert with Retry Action (shown only when retryable) */}
          {activeError && (
            <div
              role="alert"
              className="p-3.5 rounded-xl border border-[#FF5C70]/40 bg-[#FF5C70]/12 text-xs text-[#FFB3BD] space-y-2.5 leading-relaxed"
            >
              <div className="flex items-start gap-2.5">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-[#FF5C70]" />
                <span>{activeError}</span>
              </div>
              {mode === 'login' &&
                !embeddedInIframe &&
                firebaseConfigReady &&
                (error ? true : externalErrorRetryable) && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={handleGoogleRedirectSignIn}
                    className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-white hover:text-[#CBD5E1] underline underline-offset-2"
                  >
                    <RefreshCw className="w-3 h-3" />
                    <span>Retry Google Sign-In</span>
                  </button>
                )}
            </div>
          )}

          {/* Success Alert */}
          {successMessage && (
            <div
              role="status"
              className="p-3.5 rounded-xl border border-[#35D6A0]/35 bg-[#35D6A0]/10 text-xs text-[#9AEFD2] flex items-start gap-2.5 leading-relaxed"
            >
              <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5 text-[#35D6A0]" />
              <span>{successMessage}</span>
            </div>
          )}

          {/* In-Progress Status */}
          {statusMessage && (
            <div className="p-3.5 rounded-xl border border-[#7185FF]/35 bg-[#7185FF]/10 text-xs text-[#C7D1FF] flex items-center gap-2.5">
              <Loader2 className="w-4 h-4 animate-spin text-[#7185FF] shrink-0" />
              <span>{statusMessage}</span>
            </div>
          )}

          {/* Auth Callback Fallback Action */}
          {mode === 'auth-callback' && (
            <div className="space-y-3 pt-1">
              <button
                type="button"
                disabled={busy || !firebaseConfigReady}
                onClick={handleGoogleRedirectSignIn}
                className="w-full h-11 px-4 rounded-[10px] border border-white/15 bg-[#111A2A] hover:bg-[#172338] disabled:opacity-60 text-sm font-medium text-[#F7F9FF] inline-flex items-center justify-center gap-2.5 transition-colors"
              >
                <RefreshCw className="w-4 h-4 text-[#7185FF]" />
                <span>Try Google Sign-In Again</span>
              </button>
              <button
                type="button"
                onClick={() => navigateTo(buildLoginUrl(nextPath), { replace: true })}
                className="w-full h-11 rounded-[10px] bg-[#7185FF] hover:bg-[#8294FF] text-white text-sm font-semibold inline-flex items-center justify-center gap-2 transition-colors"
              >
                <span>Return to Sign In</span>
                <ArrowRight className="w-4 h-4" />
              </button>
            </div>
          )}

          {/* Google Redirect Sign-In Button for Login */}
          {mode === 'login' && (
            <div className="space-y-4">
              <button
                type="button"
                disabled={busy || !firebaseConfigReady}
                onClick={handleGoogleRedirectSignIn}
                aria-busy={googleLoading}
                className="w-full h-11 px-4 rounded-[10px] border border-white/15 bg-[#111A2A] hover:bg-[#172338] disabled:opacity-50 text-sm font-medium text-[#F7F9FF] inline-flex items-center justify-center gap-3 transition-colors cursor-pointer disabled:cursor-not-allowed"
              >
                {googleLoading ? (
                  <Loader2 className="w-4 h-4 animate-spin text-[#7185FF]" />
                ) : (
                  <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24" aria-hidden="true">
                    <path
                      fill="#4285F4"
                      d="M23.745 12.27c0-.7-.06-1.4-.19-2.07H12v4.51h6.6c-.29 1.52-1.14 2.82-2.4 3.68v3.05h3.88c2.27-2.09 3.665-5.17 3.665-9.17z"
                    />
                    <path
                      fill="#34A853"
                      d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.88-3.05c-1.08.72-2.45 1.16-4.05 1.16-3.12 0-5.77-2.11-6.72-4.96H1.29v3.14C3.26 21.3 7.31 24 12 24z"
                    />
                    <path
                      fill="#FBBC05"
                      d="M5.28 14.24c-.24-.72-.38-1.49-.38-2.24s.14-1.52.38-2.24V6.62H1.29C.47 8.24 0 10.06 0 12s.47 3.76 1.29 5.38l3.99-3.14z"
                    />
                    <path
                      fill="#EA4335"
                      d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.31 0 3.26 2.7 1.29 6.62l3.99 3.14c.95-2.85 3.6-4.96 6.72-4.96z"
                    />
                  </svg>
                )}
                <span>
                  {!firebaseConfigReady
                    ? 'Google Sign-In Unavailable (Check Firebase Config)'
                    : googleLoading
                      ? 'Redirecting to Google...'
                      : 'Sign in with Google'}
                </span>
              </button>

              <div className="flex items-center gap-3 text-[11px] uppercase tracking-[0.12em] text-[#64748B]">
                <span className="flex-1 h-px bg-white/10" />
                <span>or with email</span>
                <span className="flex-1 h-px bg-white/10" />
              </div>
            </div>
          )}

          {/* LOGIN FORM */}
          {mode === 'login' && (
            <form onSubmit={handleLoginSubmit} className="space-y-4" noValidate>
              <div className="space-y-1.5">
                <label htmlFor="auth-login-email" className="block text-xs font-medium text-[#CBD5E1]">
                  Email address
                </label>
                <div className="relative">
                  <Mail className="w-4 h-4 text-[#64748B] absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                  <input
                    id="auth-login-email"
                    type="email"
                    autoComplete="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="commander@agency.org"
                    className="w-full h-11 pl-10 pr-3.5 rounded-[10px] border border-white/15 bg-[#111A2A] text-sm text-[#F7F9FF] placeholder:text-[#64748B] focus:border-[#7185FF] focus:outline-none transition-colors"
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <label htmlFor="auth-login-password" className="block text-xs font-medium text-[#CBD5E1]">
                    Password
                  </label>
                  <button
                    type="button"
                    onClick={() => navigateTo('/forgot-password')}
                    className="text-xs text-[#7185FF] hover:text-[#98A7FF] transition-colors"
                  >
                    Forgot password?
                  </button>
                </div>
                <div className="relative">
                  <Lock className="w-4 h-4 text-[#64748B] absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                  <input
                    id="auth-login-password"
                    type={showPassword ? 'text' : 'password'}
                    autoComplete="current-password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Enter your password"
                    className="w-full h-11 pl-10 pr-10 rounded-[10px] border border-white/15 bg-[#111A2A] text-sm text-[#F7F9FF] placeholder:text-[#64748B] focus:border-[#7185FF] focus:outline-none transition-colors"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((s) => !s)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-[#64748B] hover:text-[#CBD5E1]"
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                  >
                    {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              <button
                type="submit"
                disabled={busy}
                className="w-full h-11 rounded-[10px] bg-[#7185FF] hover:bg-[#8294FF] disabled:opacity-60 text-white text-sm font-semibold inline-flex items-center justify-center gap-2 shadow-[0_0_24px_rgba(113,133,255,0.28)] transition-all"
              >
                {submitting ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    <span>Signing in...</span>
                  </>
                ) : (
                  <>
                    <span>Sign In to Command Center</span>
                    <ArrowRight className="w-4 h-4" />
                  </>
                )}
              </button>
            </form>
          )}

          {/* FORGOT PASSWORD FORM */}
          {mode === 'forgot-password' && (
            <form onSubmit={handleForgotSubmit} className="space-y-4" noValidate>
              <div className="space-y-1.5">
                <label htmlFor="auth-forgot-email" className="block text-xs font-medium text-[#CBD5E1]">
                  Account email address
                </label>
                <div className="relative">
                  <Mail className="w-4 h-4 text-[#64748B] absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                  <input
                    id="auth-forgot-email"
                    type="email"
                    autoComplete="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="commander@agency.org"
                    className="w-full h-11 pl-10 pr-3.5 rounded-[10px] border border-white/15 bg-[#111A2A] text-sm text-[#F7F9FF] placeholder:text-[#64748B] focus:border-[#7185FF] focus:outline-none transition-colors"
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={busy}
                className="w-full h-11 rounded-[10px] bg-[#7185FF] hover:bg-[#8294FF] disabled:opacity-60 text-white text-sm font-semibold inline-flex items-center justify-center gap-2 transition-colors"
              >
                {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <KeyRound className="w-4 h-4" />}
                <span>Request Password Reset</span>
              </button>

              <button
                type="button"
                onClick={() => navigateTo('/reset-password')}
                className="w-full text-center text-xs text-[#35C8F5] hover:underline"
              >
                Already have a reset token? Enter it here
              </button>
            </form>
          )}

          {/* RESET PASSWORD FORM */}
          {mode === 'reset-password' && (
            <form onSubmit={handleResetSubmit} className="space-y-4" noValidate>
              <div className="space-y-1.5">
                <label htmlFor="auth-reset-token" className="block text-xs font-medium text-[#CBD5E1]">
                  Reset token
                </label>
                <div className="relative">
                  <KeyRound className="w-4 h-4 text-[#64748B] absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                  <input
                    id="auth-reset-token"
                    type="text"
                    required
                    value={manualResetToken}
                    onChange={(e) => setManualResetToken(e.target.value)}
                    placeholder="Paste your single-use reset token"
                    className="w-full h-11 pl-10 pr-3.5 rounded-[10px] border border-white/15 bg-[#111A2A] text-sm text-[#F7F9FF] placeholder:text-[#64748B] focus:border-[#7185FF] focus:outline-none transition-colors"
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <label htmlFor="auth-reset-password" className="block text-xs font-medium text-[#CBD5E1]">
                  New password
                </label>
                <div className="relative">
                  <Lock className="w-4 h-4 text-[#64748B] absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                  <input
                    id="auth-reset-password"
                    type={showPassword ? 'text' : 'password'}
                    autoComplete="new-password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Choose a strong new password"
                    className="w-full h-11 pl-10 pr-10 rounded-[10px] border border-white/15 bg-[#111A2A] text-sm text-[#F7F9FF] placeholder:text-[#64748B] focus:border-[#7185FF] focus:outline-none transition-colors"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((s) => !s)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-[#64748B] hover:text-[#CBD5E1]"
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                  >
                    {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
                <div className="grid grid-cols-2 gap-1.5 pt-1">
                  {passwordChecks.map((check) => (
                    <div
                      key={check.label}
                      className={`text-[11px] flex items-center gap-1.5 ${
                        check.ok ? 'text-[#35D6A0]' : 'text-[#64748B]'
                      }`}
                    >
                      <Check className={`w-3 h-3 ${check.ok ? 'opacity-100' : 'opacity-40'}`} />
                      <span>{check.label}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="space-y-1.5">
                <label htmlFor="auth-reset-confirm" className="block text-xs font-medium text-[#CBD5E1]">
                  Confirm new password
                </label>
                <input
                  id="auth-reset-confirm"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="new-password"
                  required
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="Re-enter your new password"
                  className="w-full h-11 px-3.5 rounded-[10px] border border-white/15 bg-[#111A2A] text-sm text-[#F7F9FF] placeholder:text-[#64748B] focus:border-[#7185FF] focus:outline-none transition-colors"
                />
              </div>

              <button
                type="submit"
                disabled={busy}
                className="w-full h-11 rounded-[10px] bg-[#7185FF] hover:bg-[#8294FF] disabled:opacity-60 text-white text-sm font-semibold inline-flex items-center justify-center gap-2 transition-colors"
              >
                {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <ShieldCheck className="w-4 h-4" />}
                <span>Update Password</span>
              </button>
            </form>
          )}

          {/* Footer Navigation Switcher */}
          {(mode === 'forgot-password' || mode === 'reset-password') && (
            <div className="pt-4 border-t border-white/10 text-center text-xs text-[#A0AEC0]">
              Remembered your password?{' '}
              <button
                type="button"
                onClick={() => navigateTo(buildLoginUrl(nextPath))}
                className="font-semibold text-[#7185FF] hover:text-[#98A7FF] transition-colors"
              >
                Back to sign in
              </button>
            </div>
          )}
        </div>
      </main>
    </div>
  );
};
