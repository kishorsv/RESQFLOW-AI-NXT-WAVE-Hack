import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Clock, Loader2, LogOut, RefreshCw, ShieldCheck, X } from 'lucide-react';

interface SessionTimerIndicatorProps {
  expiresAt: string | null;
  totalDurationMs: number;
  clockOffsetMs: number;
  userEmail: string;
  onRefreshSession: () => Promise<void>;
  onSessionExpired: () => void;
  onSignOut: () => void;
}

const WARNING_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes
const CRITICAL_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

function formatCompactRemaining(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;

  if (hours >= 1) {
    return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  }
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function formatDetailedRemaining(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export const SessionTimerIndicator: React.FC<SessionTimerIndicatorProps> = ({
  expiresAt,
  totalDurationMs,
  clockOffsetMs,
  userEmail,
  onRefreshSession,
  onSessionExpired,
  onSignOut,
}) => {
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const [open, setOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dismissedPromptTier, setDismissedPromptTier] = useState<'none' | 'warning' | 'critical'>('none');

  const containerRef = useRef<HTMLDivElement>(null);
  const expiredNotifiedRef = useRef<boolean>(false);

  const expiresAtMs = useMemo(() => {
    if (!expiresAt) return null;
    const parsed = Date.parse(expiresAt);
    return Number.isFinite(parsed) ? parsed : null;
  }, [expiresAt]);

  // Reset expiration trigger & prompt dismissal whenever session expiry extends
  useEffect(() => {
    expiredNotifiedRef.current = false;
    setDismissedPromptTier('none');
  }, [expiresAt]);

  // Live 1-second tick for accurate countdown display
  useEffect(() => {
    if (!expiresAtMs) return;
    setNowMs(Date.now());
    const id = window.setInterval(() => {
      setNowMs(Date.now());
    }, 1000);
    return () => window.clearInterval(id);
  }, [expiresAtMs]);

  const remainingMs = useMemo(() => {
    if (!expiresAtMs) return null;
    return Math.max(0, expiresAtMs - (nowMs + clockOffsetMs));
  }, [expiresAtMs, nowMs, clockOffsetMs]);

  const severity: 'healthy' | 'warning' | 'critical' | 'expired' = useMemo(() => {
    if (remainingMs === null) return 'healthy';
    if (remainingMs <= 0) return 'expired';
    if (remainingMs <= CRITICAL_THRESHOLD_MS) return 'critical';
    if (remainingMs <= WARNING_THRESHOLD_MS) return 'warning';
    return 'healthy';
  }, [remainingMs]);

  // Automatically surface the refresh prompt popover when entering warning/critical tiers
  useEffect(() => {
    if (severity === 'critical' && dismissedPromptTier !== 'critical') {
      setOpen(true);
    } else if (severity === 'warning' && dismissedPromptTier === 'none') {
      setOpen(true);
    }
  }, [severity, dismissedPromptTier]);

  // Trigger clean session-expired flow once remaining time hits zero
  useEffect(() => {
    if (remainingMs !== null && remainingMs <= 0 && !expiredNotifiedRef.current) {
      expiredNotifiedRef.current = true;
      onSessionExpired();
    }
  }, [remainingMs, onSessionExpired]);

  // Dismiss popover on outside click or Escape key
  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        if (severity === 'warning' || severity === 'critical') {
          setDismissedPromptTier(severity);
        }
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        if (severity === 'warning' || severity === 'critical') {
          setDismissedPromptTier(severity);
        }
      }
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, severity]);

  // Auto-clear success confirmation banner after 3.5 seconds
  useEffect(() => {
    if (!feedback) return;
    const timer = window.setTimeout(() => setFeedback(null), 3500);
    return () => window.clearTimeout(timer);
  }, [feedback]);

  if (!expiresAtMs || remainingMs === null) {
    return null;
  }

  const safeTotalMs = Math.max(60_000, totalDurationMs || 24 * 60 * 60 * 1000);
  const progressRatio = Math.max(0, Math.min(1, remainingMs / safeTotalMs));
  const ringRadius = 6.5;
  const ringCircumference = 2 * Math.PI * ringRadius;
  const ringDashOffset = ringCircumference * (1 - progressRatio);

  const localExpiryLabel = new Date(expiresAtMs).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });

  const handleRefreshClick = async (e?: React.MouseEvent) => {
    e?.stopPropagation();
    if (refreshing) return;
    setError(null);
    setFeedback(null);
    setRefreshing(true);
    try {
      await onRefreshSession();
      setFeedback('Session extended for 24 hours.');
      setDismissedPromptTier('none');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to refresh session. Please try again.');
      setOpen(true);
    } finally {
      setRefreshing(false);
    }
  };

  const handleClosePopover = () => {
    setOpen(false);
    if (severity === 'warning' || severity === 'critical') {
      setDismissedPromptTier(severity);
    }
  };

  const triggerToneClasses =
    severity === 'critical' || severity === 'expired'
      ? 'border-[#E5465D]/60 dark:border-[#FF5C70]/50 bg-[#E5465D]/10 dark:bg-[#FF5C70]/12 text-[#C8233C] dark:text-[#FF8A98]'
      : severity === 'warning'
        ? 'border-[#B97716]/55 dark:border-[#FFB547]/45 bg-[#B97716]/10 dark:bg-[#FFB547]/12 text-[#925C0E] dark:text-[#FFD084]'
        : 'border-[var(--rf-border-default)] bg-[var(--rf-bg-secondary)] text-[var(--rf-text-primary)] hover:border-[var(--rf-border-active)]';

  const ringStrokeColor =
    severity === 'critical' || severity === 'expired'
      ? '#FF5C70'
      : severity === 'warning'
        ? '#FFB547'
        : '#35D6A0';

  const barColorClass =
    severity === 'critical' || severity === 'expired'
      ? 'bg-[#E5465D] dark:bg-[#FF5C70]'
      : severity === 'warning'
        ? 'bg-[#B97716] dark:bg-[#FFB547]'
        : 'bg-[#15966C] dark:bg-[#35D6A0]';

  return (
    <div ref={containerRef} className="relative shrink-0">
      <div
        className={`flex items-center h-9 rounded-[10px] border transition-colors ${triggerToneClasses}`}
      >
        <button
          type="button"
          onClick={() => setOpen((prev) => !prev)}
          aria-expanded={open}
          aria-haspopup="dialog"
          aria-label={`Authentication session remaining: ${formatCompactRemaining(remainingMs)}. Click to view or refresh session.`}
          title={`Session expires at ${localExpiryLabel} — click to refresh`}
          className="h-full px-2.5 inline-flex items-center gap-2 text-xs font-mono tabular-nums whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#5869E8] rounded-l-[9px]"
        >
          {/* Compact circular session-remaining ring */}
          <svg
            className="w-4 h-4 -rotate-90 shrink-0"
            viewBox="0 0 16 16"
            aria-hidden="true"
          >
            <circle
              cx="8"
              cy="8"
              r={ringRadius}
              fill="none"
              stroke="currentColor"
              strokeOpacity="0.2"
              strokeWidth="2"
            />
            <circle
              cx="8"
              cy="8"
              r={ringRadius}
              fill="none"
              stroke={ringStrokeColor}
              strokeWidth="2"
              strokeLinecap="round"
              strokeDasharray={ringCircumference}
              strokeDashoffset={ringDashOffset}
            />
          </svg>

          <span className="font-semibold tracking-tight">{formatCompactRemaining(remainingMs)}</span>

          {severity === 'warning' && (
            <span className="hidden lg:inline font-sans text-[11px] font-medium opacity-90">
              Expiring
            </span>
          )}
          {severity === 'critical' && (
            <span className="hidden lg:inline font-sans text-[11px] font-semibold">
              Renew
            </span>
          )}
        </button>

        {/* Direct one-click inline Refresh button */}
        <button
          type="button"
          onClick={handleRefreshClick}
          disabled={refreshing}
          aria-label="Refresh authentication session"
          title="Refresh session (+24h)"
          className={`h-full px-2 inline-flex items-center justify-center gap-1 border-l transition-colors rounded-r-[9px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#5869E8] disabled:opacity-60 whitespace-nowrap ${
            severity === 'critical' || severity === 'warning'
              ? 'border-current/25 hover:bg-current/10 font-sans text-[11px] font-semibold'
              : 'border-[var(--rf-border-default)] text-[var(--rf-text-muted)] hover:text-[var(--rf-text-primary)] hover:bg-[var(--rf-surface-hover)]'
          }`}
        >
          {refreshing ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <RefreshCw className="w-3.5 h-3.5" />
          )}
          {(severity === 'warning' || severity === 'critical') && (
            <span className="hidden sm:inline">Refresh</span>
          )}
        </button>
      </div>

      {/* Session Details & Refresh Prompt Popover */}
      {open && (
        <div
          role="dialog"
          aria-label="Authentication Session Status"
          className="absolute right-0 mt-2 w-[312px] rounded-xl border border-[var(--rf-border-strong)] bg-[var(--rf-surface-elevated)] shadow-[var(--rf-shadow-elevated)] p-4 z-50 space-y-3.5"
        >
          {/* Header Row */}
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              {severity === 'critical' || severity === 'warning' ? (
                <AlertTriangle
                  className={`w-4 h-4 shrink-0 ${
                    severity === 'critical'
                      ? 'text-[#E5465D] dark:text-[#FF5C70]'
                      : 'text-[#B97716] dark:text-[#FFB547]'
                  }`}
                />
              ) : (
                <ShieldCheck className="w-4 h-4 shrink-0 text-[#15966C] dark:text-[#35D6A0]" />
              )}
              <div className="min-w-0">
                <div className="text-xs font-semibold text-[var(--rf-text-primary)]">
                  {severity === 'critical'
                    ? 'Session Expiring Soon'
                    : severity === 'warning'
                      ? 'Refresh Recommended'
                      : 'Active Command Session'}
                </div>
                <div className="text-[11px] text-[var(--rf-text-muted)] truncate">{userEmail}</div>
              </div>
            </div>
            <button
              type="button"
              onClick={handleClosePopover}
              className="p-1 rounded-md text-[var(--rf-text-muted)] hover:text-[var(--rf-text-primary)] hover:bg-[var(--rf-surface-hover)] transition-colors"
              aria-label="Close session status panel"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>

          {/* Remaining Countdown + Progress Bar */}
          <div className="space-y-2 pt-1">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-[11px] text-[var(--rf-text-muted)] flex items-center gap-1.5">
                <Clock className="w-3 h-3" />
                Time remaining
              </span>
              <span
                className={`font-mono text-sm font-semibold tabular-nums ${
                  severity === 'critical'
                    ? 'text-[#E5465D] dark:text-[#FF5C70]'
                    : severity === 'warning'
                      ? 'text-[#B97716] dark:text-[#FFB547]'
                      : 'text-[var(--rf-text-primary)]'
                }`}
              >
                {formatDetailedRemaining(remainingMs)}
              </span>
            </div>

            <div className="h-1.5 w-full rounded-full bg-[var(--rf-bg-secondary)] overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-300 ${barColorClass}`}
                style={{ width: `${Math.max(2, Math.round(progressRatio * 100))}%` }}
              />
            </div>

            <div className="flex items-center justify-between text-[11px] text-[var(--rf-text-muted)]">
              <span>Expires at {localExpiryLabel}</span>
              <span className="font-mono tabular-nums">{Math.round(progressRatio * 100)}%</span>
            </div>
          </div>

          {/* Contextual Prompt Copy */}
          <p className="text-xs text-[var(--rf-text-secondary)] leading-relaxed">
            {severity === 'critical'
              ? 'Your authentication session is about to expire. Refresh now to keep your active workspace and live streams connected.'
              : severity === 'warning'
                ? 'Your session has less than 30 minutes remaining. Refresh now to extend access by another 24 hours.'
                : 'Refresh your session anytime to extend your authenticated access for a full 24-hour window without signing out.'}
          </p>

          {/* Status Feedback / Error */}
          {feedback && (
            <div
              role="status"
              className="p-2.5 rounded-lg border border-[#15966C]/35 dark:border-[#35D6A0]/35 bg-[#15966C]/10 dark:bg-[#35D6A0]/10 text-[11px] text-[#15966C] dark:text-[#9AEFD2] flex items-center gap-2"
            >
              <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
              <span>{feedback}</span>
            </div>
          )}

          {error && (
            <div
              role="alert"
              className="p-2.5 rounded-lg border border-[#E5465D]/40 bg-[#E5465D]/10 text-[11px] text-[#E5465D] dark:text-[#FF8A98]"
            >
              {error}
            </div>
          )}

          {/* Actions */}
          <div className="flex items-center gap-2 pt-1 border-t border-[var(--rf-border-default)]">
            <button
              type="button"
              disabled={refreshing}
              onClick={handleRefreshClick}
              className="flex-1 h-9 px-3 rounded-[9px] bg-[#5869E8] hover:bg-[#6D7CFF] disabled:opacity-60 text-white text-xs font-semibold inline-flex items-center justify-center gap-1.5 transition-colors whitespace-nowrap"
            >
              {refreshing ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  <span>Refreshing...</span>
                </>
              ) : (
                <>
                  <RefreshCw className="w-3.5 h-3.5" />
                  <span>Refresh Session</span>
                </>
              )}
            </button>

            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onSignOut();
              }}
              className="h-9 px-3 rounded-[9px] border border-[var(--rf-border-default)] bg-[var(--rf-bg-secondary)] hover:bg-[var(--rf-surface-hover)] text-xs font-medium text-[var(--rf-text-secondary)] hover:text-[#E5465D] dark:hover:text-[#FF5C70] inline-flex items-center justify-center gap-1.5 transition-colors whitespace-nowrap"
            >
              <LogOut className="w-3.5 h-3.5" />
              <span>Sign Out</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
