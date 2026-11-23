import React, { useEffect, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  Bell,
  Building2,
  CheckCheck,
  CheckCircle2,
  CloudRain,
  Cpu,
  Database,
  RotateCcw,
  Shield,
  Sliders,
} from 'lucide-react';
import { apiRequest, setSessionToken } from '../../lib/api';
import { ConfirmModal } from '../ConfirmModal';
import type {
  AlertRecord,
  AppNotification,
  AuditLog,
  DataMode,
  IntegrationHealth,
  Organization,
  UserRole,
} from '../../shared/types';

export const NotificationsView: React.FC<{
  mode: DataMode;
  notifications: AppNotification[];
  alerts?: AlertRecord[];
  onRefresh: () => void;
}> = ({ mode, notifications, alerts: externalAlerts, onRefresh }) => {
  const [sevFilter, setSevFilter] = useState<string>('all');
  const [alertStatusFilter, setAlertStatusFilter] = useState<string>('all');
  const [alerts, setAlerts] = useState<AlertRecord[]>(externalAlerts || []);
  const [busyAlertId, setBusyAlertId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  useEffect(() => {
    if (externalAlerts) {
      setAlerts(externalAlerts);
    } else {
      apiRequest<{ alerts: AlertRecord[] }>(`/alerts?mode=${mode}`)
        .then((r) => setAlerts(r.alerts))
        .catch(() => {});
    }
  }, [mode, externalAlerts]);

  const reloadAlerts = async () => {
    try {
      const r = await apiRequest<{ alerts: AlertRecord[] }>(`/alerts?mode=${mode}`);
      setAlerts(r.alerts);
    } catch {
      // ignore
    }
  };

  const acknowledgeAlert = async (id: string) => {
    setBusyAlertId(id);
    setFeedback(null);
    try {
      await apiRequest(`/alerts/${id}/acknowledge`, { method: 'POST', body: {} });
      setFeedback({ type: 'ok', text: 'Alert acknowledged and logged to operational audit ledger.' });
      await reloadAlerts();
      onRefresh();
    } catch (err) {
      setFeedback({ type: 'err', text: err instanceof Error ? err.message : 'Failed to acknowledge alert' });
    } finally {
      setBusyAlertId(null);
    }
  };

  const resolveAlert = async (id: string) => {
    setBusyAlertId(id);
    setFeedback(null);
    try {
      await apiRequest(`/alerts/${id}/resolve`, {
        method: 'POST',
        body: { resolutionNote: 'Resolved via Alert Command Console' },
      });
      setFeedback({ type: 'ok', text: 'Alert marked RESOLVED.' });
      await reloadAlerts();
      onRefresh();
    } catch (err) {
      setFeedback({ type: 'err', text: err instanceof Error ? err.message : 'Failed to resolve alert' });
    } finally {
      setBusyAlertId(null);
    }
  };

  const markRead = async (id: string) => {
    await apiRequest(`/notifications/${id}/read`, { method: 'POST' });
    onRefresh();
  };

  const markAllRead = async () => {
    await apiRequest('/notifications/read-all', { method: 'POST', body: { mode } });
    onRefresh();
  };

  const filteredAlerts = alerts.filter((a) => {
    if (sevFilter !== 'all' && a.severity !== sevFilter) return false;
    if (alertStatusFilter !== 'all' && a.status !== alertStatusFilter) return false;
    return true;
  });

  const list = notifications.filter((n) => sevFilter === 'all' || n.severity === sevFilter);
  const activeAlertsCount = alerts.filter((a) => a.status !== 'RESOLVED').length;

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-900 dark:text-white">
            Automated Emergency Alerts &amp; Notification Center
          </h1>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Cooldown-deduplicated Phase 3 intelligence alerts (TRIGGERED → ACTIVE → ACKNOWLEDGED → RESOLVED) &amp; system notifications
          </p>
        </div>
        <button
          type="button"
          onClick={markAllRead}
          className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-slate-300 dark:border-slate-700 text-xs font-medium text-slate-700 dark:text-slate-200 hover:border-cyan-500"
        >
          <CheckCheck className="w-4 h-4 text-cyan-500" />
          Mark All Notifications Read
        </button>
      </div>

      {feedback && (
        <div
          className={`px-4 py-2.5 rounded-lg border text-xs ${
            feedback.type === 'ok'
              ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
              : 'border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300'
          }`}
        >
          {feedback.text}
        </div>
      )}

      {/* Filter Controls */}
      <div className="flex flex-wrap items-center justify-between gap-3 text-xs">
        <div className="flex flex-wrap gap-1.5">
          {['all', 'critical', 'high', 'warning', 'info'].map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setSevFilter(s)}
              className={`px-3 py-1.5 rounded-lg border capitalize font-medium ${
                sevFilter === s
                  ? 'border-[#5869E8]/50 dark:border-[#6D7CFF]/55 bg-[#5869E8]/10 dark:bg-[#6D7CFF]/16 text-[#5869E8] dark:text-[#A5B0FF]'
                  : 'border-slate-200 dark:border-slate-800 text-slate-500'
              }`}
            >
              {s}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {['all', 'ACTIVE', 'ACKNOWLEDGED', 'RESOLVED'].map((st) => (
            <button
              key={st}
              type="button"
              onClick={() => setAlertStatusFilter(st)}
              className={`px-2.5 py-1.5 rounded-lg border font-mono text-[11px] ${
                alertStatusFilter === st
                  ? 'border-amber-500 bg-amber-500/10 text-amber-700 dark:text-amber-300'
                  : 'border-slate-200 dark:border-slate-800 text-slate-500'
              }`}
            >
              {st === 'all' ? 'All Alert States' : st}
            </button>
          ))}
        </div>
      </div>

      {/* Phase 3 Automated Intelligence Alerts */}
      <div className="space-y-2.5">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-white flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-red-500" />
            Automated Intelligence Alerts ({activeAlertsCount} Active / {alerts.length} Total)
          </h2>
        </div>

        {filteredAlerts.map((a) => (
          <div
            key={a.id}
            className={`rounded-xl border p-4 flex flex-col md:flex-row md:items-center justify-between gap-3 ${
              a.status === 'RESOLVED'
                ? 'border-slate-200 dark:border-slate-800 bg-white/50 dark:bg-slate-900/40 opacity-75'
                : a.severity === 'critical'
                ? 'border-red-500/50 bg-red-500/5 dark:bg-red-950/20'
                : 'border-amber-500/40 bg-white dark:bg-slate-900'
            }`}
          >
            <div className="space-y-1">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span
                  className={`font-mono uppercase font-semibold px-1.5 py-0.5 rounded text-[10px] ${
                    a.severity === 'critical'
                      ? 'bg-red-600 text-white'
                      : a.severity === 'high'
                      ? 'bg-orange-500 text-white'
                      : 'bg-amber-500/20 text-amber-700 dark:text-amber-300'
                  }`}
                >
                  {a.severity}
                </span>
                <span className="font-mono text-[10px] px-1.5 py-0.5 rounded border border-slate-300 dark:border-slate-700 text-slate-600 dark:text-slate-300">
                  {a.status}
                </span>
                <span className="font-semibold text-slate-900 dark:text-white">{a.title}</span>
              </div>
              <p className="text-xs text-slate-700 dark:text-slate-300">{a.message}</p>
              <div className="flex flex-wrap items-center gap-3 text-[11px] font-mono text-slate-500 tabular-nums">
                <span>Trigger: {a.triggerFactor}</span>
                {a.previousValue !== undefined && a.currentValue !== undefined && (
                  <span>
                    Change: {String(a.previousValue ?? 'N/A')} → {String(a.currentValue)}
                  </span>
                )}
                <span>Source: {a.source}</span>
                <span>Cooldown: {a.cooldownMinutes}m</span>
                <span>{new Date(a.createdAt).toLocaleString()}</span>
              </div>
              {a.acknowledgedBy && (
                <div className="text-[11px] text-emerald-600 dark:text-emerald-400">
                  Acknowledged by {a.acknowledgedBy} at {a.acknowledgedAt ? new Date(a.acknowledgedAt).toLocaleTimeString() : ''}
                </div>
              )}
              {a.resolvedBy && (
                <div className="text-[11px] text-slate-500">
                  Resolved by {a.resolvedBy} {a.resolutionNote ? `— ${a.resolutionNote}` : ''}
                </div>
              )}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {a.status !== 'ACKNOWLEDGED' && a.status !== 'RESOLVED' && (
                <button
                  type="button"
                  disabled={busyAlertId === a.id}
                  onClick={() => acknowledgeAlert(a.id)}
                  className="px-3 py-1.5 rounded-lg border border-[#5869E8]/50 dark:border-[#6D7CFF]/55 bg-[#5869E8]/10 dark:bg-[#6D7CFF]/16 text-[#5869E8] dark:text-[#A5B0FF] text-xs font-medium hover:bg-cyan-500/20"
                >
                  Acknowledge
                </button>
              )}
              {a.status !== 'RESOLVED' && (
                <button
                  type="button"
                  disabled={busyAlertId === a.id}
                  onClick={() => resolveAlert(a.id)}
                  className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium"
                >
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  Resolve
                </button>
              )}
            </div>
          </div>
        ))}

        {filteredAlerts.length === 0 && (
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 p-6 text-center text-xs text-slate-500">
            No automated intelligence alerts match this filter in {mode.toUpperCase()} mode.
          </div>
        )}
      </div>

      {/* System Notifications Feed */}
      <div className="space-y-2.5">
        <h2 className="text-sm font-semibold text-slate-900 dark:text-white flex items-center gap-2">
          <Bell className="w-4 h-4 text-cyan-500" />
          System Activity Notifications ({list.length})
        </h2>
        {list.map((n) => (
          <div
            key={n.id}
            className={`rounded-xl border p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 ${
              n.read
                ? 'border-slate-200 dark:border-slate-800 bg-white/60 dark:bg-slate-900/40 opacity-75'
                : 'border-cyan-500/40 bg-white dark:bg-slate-900'
            }`}
          >
            <div className="space-y-1">
              <div className="flex items-center gap-2 text-xs font-semibold text-slate-900 dark:text-white">
                {n.severity === 'critical' || n.severity === 'high' ? (
                  <AlertTriangle className="w-4 h-4 text-red-500 shrink-0" />
                ) : (
                  <Bell className="w-4 h-4 text-cyan-500 shrink-0" />
                )}
                <span>{n.title}</span>
                <span className="font-mono text-[10px] uppercase text-slate-500">· {n.eventType}</span>
              </div>
              <p className="text-xs text-slate-600 dark:text-slate-300">{n.message}</p>
              <div className="text-[11px] font-mono text-slate-500 tabular-nums">
                {new Date(n.createdAt).toLocaleString()}
              </div>
            </div>
            {!n.read && (
              <button
                type="button"
                onClick={() => markRead(n.id)}
                className="px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 text-xs font-medium text-slate-700 dark:text-slate-200 shrink-0"
              >
                Mark Read
              </button>
            )}
          </div>
        ))}
        {list.length === 0 && (
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 p-8 text-center text-xs text-slate-500">
            No notifications matching this filter.
          </div>
        )}
      </div>
    </div>
  );
};

interface AdminOrgSettingsViewProps {
  mode: DataMode;
  initialSection?: 'organizations' | 'admin' | 'settings';
  currentRole: UserRole;
  baseRole?: UserRole;
  userProvider?: 'password' | 'google' | 'both';
  onChangeRole: (role: UserRole) => Promise<void> | void;
  onChangeMode: (mode: DataMode) => void;
  theme: 'dark' | 'light';
  onToggleTheme: () => void;
  integrations: IntegrationHealth[];
  onRefresh: () => void;
}

const ROLES: UserRole[] = [
  'super_admin',
  'emergency_commander',
  'logistics_manager',
  'warehouse_operator',
  'field_responder',
  'analyst',
  'citizen_reporter',
];

export const AdminOrgSettingsView: React.FC<AdminOrgSettingsViewProps> = ({
  mode,
  initialSection = 'admin',
  currentRole,
  baseRole = currentRole,
  userProvider = 'password',
  onChangeRole,
  onChangeMode,
  theme,
  onToggleTheme,
  integrations,
  onRefresh,
}) => {
  const [orgs, setOrgs] = useState<Organization[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);
  const [healthSummary, setHealthSummary] = useState<any>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [roleUpdating, setRoleUpdating] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [changingPassword, setChangingPassword] = useState(false);

  useEffect(() => {
    Promise.all([
      apiRequest<{ organizations: Organization[] }>('/organizations'),
      apiRequest<{ logs: AuditLog[] }>(`/audit-logs?mode=${mode}`),
      apiRequest('/health'),
      apiRequest('/health/database'),
      apiRequest('/health/realtime'),
      apiRequest('/health/weather'),
      apiRequest('/health/ai'),
      apiRequest('/health/workers'),
    ])
      .then(([o, a, h, db, rt, weather, ai, workers]) => {
        setOrgs(o.organizations);
        setAuditLogs(a.logs);
        setHealthSummary({ h, db, rt, weather, ai, workers });
      })
      .catch(() => {});
  }, [mode, initialSection]);

  const handleResetDemo = async () => {
    setResetting(true);
    setFeedback(null);
    try {
      const res = await apiRequest<{ message: string }>('/demo/reset', { method: 'POST' });
      setFeedback(res.message);
      onRefresh();
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : 'Demo reset failed');
    } finally {
      setResetting(false);
      setConfirmReset(false);
    }
  };

  const handleRoleSelect = async (nextRole: UserRole) => {
    setRoleUpdating(true);
    setFeedback(null);
    try {
      await onChangeRole(nextRole);
      setFeedback(`Active operational role updated to ${nextRole.replace(/_/g, ' ')}.`);
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : 'Role update failed');
    } finally {
      setRoleUpdating(false);
    }
  };

  const handlePasswordChange = async (e: React.FormEvent) => {
    e.preventDefault();
    setChangingPassword(true);
    setFeedback(null);
    try {
      const res = await apiRequest<{ message?: string; sessionToken?: string }>('/auth/change-password', {
        method: 'POST',
        body: {
          currentPassword: currentPassword || undefined,
          newPassword,
        },
      });
      if (res.sessionToken) {
        setSessionToken(res.sessionToken);
      }
      setCurrentPassword('');
      setNewPassword('');
      setFeedback(res.message || 'Password updated successfully.');
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : 'Unable to update password.');
    } finally {
      setChangingPassword(false);
    }
  };

  const canSwitchRoles = baseRole === 'super_admin';

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-900 dark:text-white">
          Organizations, RBAC Governance, System Health &amp; Settings
        </h1>
        <p className="text-xs text-slate-500 dark:text-slate-400">
          Multi-agency directory, server-enforced Role-Based Access Control, isolated Demo/Operational mode control &amp; immutable audit logs
        </p>
      </div>

      {feedback && (
        <div className="p-3 rounded-lg border border-cyan-500/40 bg-cyan-500/10 text-xs text-cyan-700 dark:text-cyan-300">
          {feedback}
        </div>
      )}

      {/* Controls Strip */}
      <div className="grid md:grid-cols-3 gap-4 text-xs">
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/80 p-4 space-y-2.5">
          <div className="font-semibold text-slate-900 dark:text-white flex items-center gap-2">
            <Shield className="w-4 h-4 text-cyan-500" />
            Active Operational RBAC Role
          </div>
          <select
            value={currentRole}
            disabled={!canSwitchRoles || roleUpdating}
            onChange={(e) => void handleRoleSelect(e.target.value as UserRole)}
            className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-white disabled:opacity-60"
          >
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {r.replace(/_/g, ' ').toUpperCase()}
              </option>
            ))}
          </select>
          <p className="text-[11px] text-slate-500">
            {canSwitchRoles
              ? 'Super Admin verified: server enforces your selected perspective on every /api/v1 endpoint.'
              : `Assigned account role (${baseRole.replace(/_/g, ' ')}). Role changes are restricted to super_admin accounts on the server.`}
          </p>
          <form onSubmit={handlePasswordChange} className="pt-2 border-t border-slate-200 dark:border-slate-800 space-y-2">
            <div className="font-medium text-slate-700 dark:text-slate-200">
              {userProvider === 'google' ? 'Set Account Password' : 'Update Account Password'}
            </div>
            {userProvider !== 'google' && (
              <input
                type="password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                placeholder="Current password"
                autoComplete="current-password"
                className="w-full px-2.5 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-white"
              />
            )}
            <input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="New password (8+ chars, A-z, 0-9)"
              autoComplete="new-password"
              className="w-full px-2.5 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-white"
            />
            <button
              type="submit"
              disabled={changingPassword || newPassword.length < 8}
              className="w-full py-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-500 disabled:opacity-50 text-white font-medium"
            >
              {changingPassword ? 'Updating...' : 'Save Password'}
            </button>
          </form>
        </div>

        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/80 p-4 space-y-2.5">
          <div className="font-semibold text-slate-900 dark:text-white flex items-center gap-2">
            <Database className="w-4 h-4 text-amber-500" />
            Data Isolation Mode
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => onChangeMode('demo')}
              className={`flex-1 py-2 rounded-lg border font-medium ${
                mode === 'demo'
                  ? 'border-amber-500 bg-amber-500/15 text-amber-700 dark:text-amber-300'
                  : 'border-slate-300 dark:border-slate-700 text-slate-500'
              }`}
            >
              Demo Mode
            </button>
            <button
              type="button"
              onClick={() => onChangeMode('operational')}
              className={`flex-1 py-2 rounded-lg border font-medium ${
                mode === 'operational'
                  ? 'border-emerald-500 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                  : 'border-slate-300 dark:border-slate-700 text-slate-500'
              }`}
            >
              Operational
            </button>
          </div>
          <button
            type="button"
            onClick={() => setConfirmReset(true)}
            className="w-full inline-flex items-center justify-center gap-1.5 py-2 rounded-lg border border-red-500/40 text-red-600 dark:text-red-400 hover:bg-red-500/10 font-medium"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            Reset Isolated Demo Dataset
          </button>
        </div>

        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/80 p-4 space-y-2.5">
          <div className="font-semibold text-slate-900 dark:text-white flex items-center gap-2">
            <Sliders className="w-4 h-4 text-cyan-500" />
            Command Console Theme
          </div>
          <button
            type="button"
            onClick={onToggleTheme}
            className="w-full py-2 rounded-lg border border-slate-300 dark:border-slate-700 text-slate-800 dark:text-slate-100 font-medium hover:border-cyan-500"
          >
            Switch to {theme === 'dark' ? 'Light Mode' : 'Dark Command Mode'}
          </button>
          <p className="text-[11px] text-slate-500">
            Dark navy/charcoal command palette optimized for 24/7 operations rooms, with full Light mode parity.
          </p>
        </div>
      </div>

      {/* Organizations + Live Health */}
      <div className="grid lg:grid-cols-2 gap-5">
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/80 p-5 space-y-3">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-white flex items-center gap-2">
            <Building2 className="w-4 h-4 text-cyan-500" />
            Coordinating Organizations ({orgs.length})
          </h2>
          <div className="space-y-2 text-xs">
            {orgs.map((o) => (
              <div
                key={o.id}
                className="p-3 rounded-lg bg-slate-50 dark:bg-slate-950/60 border border-slate-200 dark:border-slate-800 flex items-center justify-between"
              >
                <div>
                  <div className="font-semibold text-slate-900 dark:text-white">{o.name}</div>
                  <div className="text-slate-500">
                    {o.type.replace(/_/g, ' ')} · {o.region} · {o.contactEmail}
                  </div>
                </div>
                <span className="font-mono text-slate-600 dark:text-slate-300 tabular-nums">{o.activeMembers} staff</span>
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/80 p-5 space-y-3">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-white flex items-center gap-2">
            <Activity className="w-4 h-4 text-emerald-500" />
            Live Health &amp; Phase 3 Intelligence Probes
          </h2>
          {healthSummary && (
            <>
              <div className="grid grid-cols-3 gap-2 text-xs tabular-nums">
                <div className="p-2.5 rounded-lg bg-slate-50 dark:bg-slate-950/60 border border-slate-200 dark:border-slate-800">
                  <div className="text-slate-500">Uptime</div>
                  <div className="font-mono font-semibold text-slate-900 dark:text-white">{healthSummary.h.uptimeSec}s</div>
                </div>
                <div className="p-2.5 rounded-lg bg-slate-50 dark:bg-slate-950/60 border border-slate-200 dark:border-slate-800">
                  <div className="text-slate-500">WS Clients</div>
                  <div className="font-mono font-semibold text-emerald-500">{healthSummary.rt.connectedClients}</div>
                </div>
                <div className="p-2.5 rounded-lg bg-slate-50 dark:bg-slate-950/60 border border-slate-200 dark:border-slate-800">
                  <div className="text-slate-500">Auto-Reassessments</div>
                  <div className="font-mono font-semibold text-cyan-500">
                    {healthSummary.workers?.reassessmentCoordinator?.totalCompleted ?? 0}
                  </div>
                </div>
              </div>
              <div className="grid sm:grid-cols-2 gap-2 text-xs">
                <div className="p-2.5 rounded-lg bg-slate-50 dark:bg-slate-950/60 border border-slate-200 dark:border-slate-800 space-y-0.5">
                  <div className="flex items-center gap-1.5 font-medium text-slate-800 dark:text-slate-200">
                    <CloudRain className="w-3.5 h-3.5 text-cyan-500" />
                    Weather Provider (/health/weather)
                  </div>
                  <div className="font-mono text-[11px] text-slate-500">
                    {healthSummary.weather?.provider} ·{' '}
                    <span className="uppercase text-emerald-500">{healthSummary.weather?.status}</span> · Cache:{' '}
                    {healthSummary.weather?.cacheEntries ?? 0}
                  </div>
                </div>
                <div className="p-2.5 rounded-lg bg-slate-50 dark:bg-slate-950/60 border border-slate-200 dark:border-slate-800 space-y-0.5">
                  <div className="flex items-center gap-1.5 font-medium text-slate-800 dark:text-slate-200">
                    <Cpu className="w-3.5 h-3.5 text-violet-500" />
                    AI Risk Agent (/health/ai)
                  </div>
                  <div className="font-mono text-[11px] text-slate-500">
                    {healthSummary.ai?.defaultRiskModel} ·{' '}
                    <span className="uppercase text-emerald-500">{healthSummary.ai?.status}</span> · Briefings:{' '}
                    {healthSummary.ai?.totalBriefingsGenerated ?? 0}
                  </div>
                </div>
              </div>
            </>
          )}
          <div className="space-y-1.5 text-xs">
            {integrations.map((int) => (
              <div key={int.id} className="flex items-center justify-between py-1 border-b border-slate-100 dark:border-slate-800/60">
                <span className="text-slate-700 dark:text-slate-300">{int.name}</span>
                <span className="font-mono uppercase text-[11px] text-emerald-600 dark:text-emerald-400">
                  {int.status} {int.latencyMs !== null ? `(${int.latencyMs}ms)` : ''}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Immutable Audit Log */}
      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/80 p-5 space-y-3">
        <h2 className="text-sm font-semibold text-slate-900 dark:text-white">Immutable Operational Audit Ledger</h2>
        <div className="space-y-1.5 max-h-64 overflow-y-auto text-xs">
          {auditLogs.map((log) => (
            <div
              key={log.id}
              className="flex flex-col sm:flex-row sm:items-center justify-between gap-1 py-2 border-b border-slate-100 dark:border-slate-800/70 last:border-0"
            >
              <div>
                <span className="font-mono text-cyan-600 dark:text-cyan-400">{log.action}</span> ·{' '}
                <span className="text-slate-800 dark:text-slate-200">{log.summary}</span>
                <span className="text-slate-500">
                  {' '}
                  — {log.actor} ({log.role})
                </span>
              </div>
              <span className="font-mono text-[11px] text-slate-500 tabular-nums shrink-0">
                {new Date(log.timestamp).toLocaleString()}
              </span>
            </div>
          ))}
        </div>
      </div>

      <ConfirmModal
        open={confirmReset}
        title="Reset Isolated Demo Dataset?"
        description="This restores the seeded Demo incidents, warehouses, inventory, and dispatches to their clean baseline. Operational Mode records are strictly preserved untouched."
        confirmLabel="Reset Demo Data"
        danger
        loading={resetting}
        onConfirm={handleResetDemo}
        onCancel={() => setConfirmReset(false)}
      />
    </div>
  );
};
