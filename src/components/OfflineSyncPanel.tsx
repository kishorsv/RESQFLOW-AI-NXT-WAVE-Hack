import { useEffect, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  CloudOff,
  Database,
  RefreshCw,
  RotateCcw,
  Trash2,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react';
import {
  clearFailedActions,
  removeQueuedAction,
  retryFailedActions,
  setSimulatedOffline,
  type OfflineQueuedAction,
  type OfflineSyncResult,
} from '../lib/offlineQueue';

interface OfflineSyncPanelProps {
  queuedActions: OfflineQueuedAction[];
  isSyncing: boolean;
  isOffline: boolean;
  browserOnline: boolean;
  simulatedOffline: boolean;
  lastSyncResult: OfflineSyncResult | null;
  onSyncNow: () => Promise<unknown>;
  onClearLastResult: () => void;
}

export function OfflineSyncPanel({
  queuedActions,
  isSyncing,
  isOffline,
  browserOnline,
  simulatedOffline,
  lastSyncResult,
  onSyncNow,
  onClearLastResult,
}: OfflineSyncPanelProps) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [swState, setSwState] = useState<'active' | 'registering' | 'dev-disabled' | 'unsupported'>(
    import.meta.env.DEV ? 'dev-disabled' : 'registering'
  );

  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
      setSwState('unsupported');
      return;
    }
    let mounted = true;
    const checkSw = async () => {
      try {
        const reg = await navigator.serviceWorker.getRegistration();
        if (!mounted) return;
        if (reg?.active) {
          setSwState('active');
        } else if (import.meta.env.DEV) {
          setSwState('dev-disabled');
        } else {
          setSwState('registering');
        }
      } catch {
        if (mounted) setSwState('unsupported');
      }
    };
    void checkSw();
    navigator.serviceWorker.addEventListener('controllerchange', checkSw);
    return () => {
      mounted = false;
      navigator.serviceWorker.removeEventListener('controllerchange', checkSw);
    };
  }, []);

  const pendingCount = queuedActions.filter((a) => a.status === 'pending' || a.status === 'syncing').length;
  const failedCount = queuedActions.filter((a) => a.status === 'failed').length;
  const totalCount = queuedActions.length;

  const handleRetryFailed = async () => {
    await retryFailedActions();
    if (!isOffline) {
      await onSyncNow();
    }
  };

  return (
    <>
      {/* Header Trigger Button */}
      <button
        type="button"
        onClick={() => setDrawerOpen(true)}
        className={`relative inline-flex items-center gap-1.5 px-2.5 h-9 rounded-[10px] border text-xs font-medium transition-colors whitespace-nowrap ${
          isOffline
            ? 'border-[#B97716]/50 bg-[#B97716]/12 text-[#925C0E] dark:text-[#FFB547]'
            : failedCount > 0
            ? 'border-[#E5465D]/50 bg-[#E5465D]/10 text-[#C42B42] dark:text-[#FF8A98]'
            : totalCount > 0
            ? 'border-[#5869E8]/50 bg-[#5869E8]/10 text-[#5869E8] dark:text-[#8190FF]'
            : 'border-[var(--rf-border-default)] bg-[var(--rf-surface-elevated)] text-[var(--rf-text-secondary)] hover:border-[var(--rf-border-active)]'
        }`}
        title="Offline Queue & Sync Manager"
      >
        {isSyncing ? (
          <RefreshCw className="w-3.5 h-3.5 animate-spin text-[#5869E8] dark:text-[#35C8F5]" />
        ) : isOffline ? (
          <WifiOff className="w-3.5 h-3.5 text-[#B97716] dark:text-[#FFB547]" />
        ) : (
          <Database className="w-3.5 h-3.5" />
        )}
        <span className="hidden md:inline font-mono">
          {isSyncing
            ? 'Syncing...'
            : isOffline
            ? 'Offline Queue'
            : totalCount > 0
            ? `Queue (${totalCount})`
            : 'Sync Ready'}
        </span>
        {totalCount > 0 && (
          <span
            className={`px-1.5 py-0.2 rounded text-[10px] font-mono font-bold tabular-nums ${
              failedCount > 0 ? 'bg-[#E5465D] text-white' : 'bg-[#B97716] text-white'
            }`}
          >
            {totalCount}
          </span>
        )}
      </button>

      {/* Bottom-Left Offline Indicator & Auto-Sync Toast */}
      {(isOffline || totalCount > 0 || lastSyncResult) && (
        <div className="fixed bottom-4 left-4 z-40 flex flex-col gap-2 max-w-sm">
          {isOffline && (
            <div className="bg-[#B97716] text-white text-xs px-4 py-3 rounded-xl shadow-lg flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <WifiOff className="w-4 h-4 shrink-0" />
                <div>
                  <div className="font-semibold">
                    {simulatedOffline ? 'Simulated Offline Mode Active' : 'Offline — Cached Data Active'}
                  </div>
                  <div className="text-[11px] text-amber-100">
                    {pendingCount > 0
                      ? `${pendingCount} action(s) queued in IndexedDB for auto-sync.`
                      : 'Mutations will queue locally and sync automatically on reconnect.'}
                  </div>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setDrawerOpen(true)}
                className="px-2.5 py-1 rounded-lg bg-white/20 hover:bg-white/30 text-[11px] font-semibold shrink-0"
              >
                Inspect
              </button>
            </div>
          )}

          {!isOffline && pendingCount > 0 && (
            <div className="bg-[#5869E8] text-white text-xs px-4 py-3 rounded-xl shadow-lg flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <RefreshCw className={`w-3.5 h-3.5 ${isSyncing ? 'animate-spin' : ''}`} />
                <span>
                  {isSyncing
                    ? `Syncing ${pendingCount} queued offline action(s)...`
                    : `${pendingCount} offline action(s) awaiting sync`}
                </span>
              </div>
              <button
                type="button"
                onClick={() => void onSyncNow()}
                disabled={isSyncing}
                className="px-2.5 py-1 rounded-lg bg-white/20 hover:bg-white/30 text-[11px] font-semibold disabled:opacity-50"
              >
                Sync Now
              </button>
            </div>
          )}

          {lastSyncResult && !isOffline && (lastSyncResult.syncedCount > 0 || lastSyncResult.failedCount > 0) && (
            <div className="bg-[var(--rf-surface-elevated)] border border-[#15966C]/40 dark:border-[#35D6A0]/40 text-[var(--rf-text-primary)] text-xs px-4 py-3 rounded-xl shadow-[var(--rf-shadow-elevated)] flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                {lastSyncResult.failedCount > 0 ? (
                  <AlertCircle className="w-4 h-4 text-[#FFB547] shrink-0" />
                ) : (
                  <CheckCircle2 className="w-4 h-4 text-[#15966C] dark:text-[#35D6A0] shrink-0" />
                )}
                <span>
                  Synced <strong>{lastSyncResult.syncedCount}</strong> offline action(s)
                  {lastSyncResult.failedCount > 0 ? ` · ${lastSyncResult.failedCount} failed` : ' to backend.'}
                </span>
              </div>
              <button
                type="button"
                onClick={onClearLastResult}
                className="text-[var(--rf-text-muted)] hover:text-[var(--rf-text-primary)]"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
        </div>
      )}

      {/* Offline Action Queue Slide-Over Drawer */}
      {drawerOpen && (
        <div
          className="fixed inset-0 z-50 flex justify-end bg-[#080D18]/70 backdrop-blur-[2px]"
          onClick={() => setDrawerOpen(false)}
        >
          <div
            className="w-full max-w-md bg-[var(--rf-surface-elevated)] border-l border-[var(--rf-border-strong)] h-full flex flex-col shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-6 py-4 border-b border-[var(--rf-border-default)] flex items-center justify-between">
              <div>
                <h2 className="text-sm font-bold text-[var(--rf-text-primary)] flex items-center gap-2">
                  <Database className="w-4 h-4 text-[#5869E8] dark:text-[#35C8F5]" />
                  Persistent Offline Sync Queue
                </h2>
                <p className="text-[11px] font-mono text-[var(--rf-text-muted)]">
                  IndexedDB + Service Worker Background Sync
                </p>
              </div>
              <button
                type="button"
                onClick={() => setDrawerOpen(false)}
                className="p-1.5 rounded-lg text-[var(--rf-text-muted)] hover:text-[var(--rf-text-primary)] hover:bg-[var(--rf-surface-hover)]"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Connection & SW Telemetry Strip */}
            <div className="p-4 border-b border-slate-200 dark:border-slate-800 space-y-3 bg-slate-50 dark:bg-slate-950/60">
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div className="p-2.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
                  <div className="text-[10px] font-mono uppercase text-slate-500">Network Link</div>
                  <div className="mt-1 font-semibold flex items-center gap-1.5">
                    {isOffline ? (
                      <>
                        <WifiOff className="w-3.5 h-3.5 text-amber-500" />
                        <span className="text-amber-600 dark:text-amber-400">
                          {simulatedOffline ? 'Simulated Offline' : 'Browser Offline'}
                        </span>
                      </>
                    ) : (
                      <>
                        <Wifi className="w-3.5 h-3.5 text-emerald-500" />
                        <span className="text-emerald-600 dark:text-emerald-400">Connected</span>
                      </>
                    )}
                  </div>
                </div>
                <div className="p-2.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
                  <div className="text-[10px] font-mono uppercase text-slate-500">Service Worker</div>
                  <div className="mt-1 font-semibold font-mono text-[11px]">
                    {swState === 'active' ? (
                      <span className="text-emerald-600 dark:text-emerald-400">ACTIVE &amp; INTERCEPTING</span>
                    ) : swState === 'dev-disabled' ? (
                      <span className="text-cyan-600 dark:text-cyan-400">IDB SYNC (PROD SW)</span>
                    ) : swState === 'registering' ? (
                      <span className="text-cyan-600 dark:text-cyan-400">INITIALIZING</span>
                    ) : (
                      <span className="text-slate-500">IDB FALLBACK ONLY</span>
                    )}
                  </div>
                </div>
              </div>

              {/* Simulate Offline Mode Switch */}
              <div className="flex items-center justify-between gap-3 p-3 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
                <div>
                  <div className="text-xs font-semibold text-slate-900 dark:text-white flex items-center gap-1.5">
                    <CloudOff className="w-3.5 h-3.5 text-amber-500" />
                    Simulate Offline Mode
                  </div>
                  <div className="text-[11px] text-slate-500">
                    Queue mutations locally, then switch back online to watch automatic FIFO sync.
                  </div>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={simulatedOffline}
                  onClick={() => setSimulatedOffline(!simulatedOffline)}
                  className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${
                    simulatedOffline ? 'bg-amber-500' : 'bg-slate-300 dark:bg-slate-700'
                  }`}
                >
                  <span
                    className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-xs transition-transform ${
                      simulatedOffline ? 'translate-x-5' : 'translate-x-0'
                    }`}
                  />
                </button>
              </div>

              {/* Action Controls */}
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={isSyncing || isOffline || pendingCount === 0}
                  onClick={() => void onSyncNow()}
                  className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 disabled:opacity-40 text-white text-xs font-semibold"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${isSyncing ? 'animate-spin' : ''}`} />
                  Sync Now ({pendingCount})
                </button>
                {failedCount > 0 && (
                  <>
                    <button
                      type="button"
                      onClick={() => void handleRetryFailed()}
                      className="inline-flex items-center gap-1 px-2.5 py-2 rounded-lg border border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300 text-xs font-medium"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                      Retry ({failedCount})
                    </button>
                    <button
                      type="button"
                      onClick={() => void clearFailedActions()}
                      className="inline-flex items-center gap-1 px-2.5 py-2 rounded-lg border border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300 text-xs font-medium"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      Clear Failed
                    </button>
                  </>
                )}
              </div>
              {!browserOnline && (
                <div className="text-[11px] font-mono text-amber-600 dark:text-amber-400">
                  Browser reports navigator.onLine = false. Actions will flush automatically when connectivity returns.
                </div>
              )}
            </div>

            {/* Queued Actions FIFO List */}
            <div className="flex-1 overflow-y-auto p-4 space-y-2.5">
              {queuedActions.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center text-center py-12 px-4">
                  <CheckCircle2 className="w-8 h-8 text-emerald-500/70 mb-2" />
                  <div className="text-sm font-semibold text-slate-800 dark:text-slate-200">
                    All Actions Synchronized
                  </div>
                  <p className="text-xs text-slate-500 mt-1 max-w-xs">
                    No pending mutations in IndexedDB. Actions performed offline (incidents, relief requests, stock movements, dispatches) appear here in FIFO order.
                  </p>
                </div>
              ) : (
                queuedActions.map((item, idx) => (
                  <div
                    key={item.id}
                    className="p-3 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/70 space-y-1.5"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="font-mono text-[10px] text-slate-400">#{idx + 1}</span>
                          <span
                            className={`text-[10px] font-mono uppercase px-1.5 py-0.5 rounded font-semibold ${
                              item.status === 'failed'
                                ? 'bg-red-500/15 text-red-600 dark:text-red-400'
                                : item.status === 'syncing'
                                ? 'bg-cyan-500/15 text-cyan-600 dark:text-cyan-400'
                                : 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
                            }`}
                          >
                            {item.status}
                          </span>
                          <span className="text-[10px] font-mono uppercase text-slate-500">{item.mode}</span>
                        </div>
                        <div className="text-xs font-semibold text-slate-900 dark:text-slate-100 mt-1 break-words">
                          {item.label}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => void removeQueuedAction(item.id)}
                        className="p-1 text-slate-400 hover:text-red-500 shrink-0"
                        title="Discard queued action"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                    <div className="flex items-center justify-between text-[10px] font-mono text-slate-500">
                      <span>ID: {item.id.slice(0, 14)}</span>
                      <span>
                        {new Date(item.createdAt).toLocaleTimeString()} · {item.attempts} attempt(s)
                      </span>
                    </div>
                    {item.lastError && (
                      <div className="text-[11px] text-red-600 dark:text-red-400 bg-red-500/10 border border-red-500/20 rounded px-2 py-1">
                        {item.lastError}
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
