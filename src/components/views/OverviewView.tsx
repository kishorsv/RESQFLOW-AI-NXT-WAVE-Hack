import React, { useState } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Bot,
  Box,
  CheckCircle2,
  ClipboardCheck,
  MapPin,
  Radio,
  RefreshCw,
  Shield,
  ShieldAlert,
  Truck,
  Users,
  Warehouse as WarehouseIcon,
} from 'lucide-react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { apiRequest } from '../../lib/api';
import { EmptyState, MetricCard, PageHeader } from '../ui/DesignPrimitives';
import type {
  AppNotification,
  DataMode,
  Incident,
  IntegrationHealth,
  StructuredAIAgentOutput,
  SystemEvent,
  Warehouse,
} from '../../shared/types';

interface OverviewViewProps {
  mode: DataMode;
  analytics: any;
  incidents: Incident[];
  warehouses: Warehouse[];
  notifications: AppNotification[];
  recentEvents: SystemEvent[];
  integrations: IntegrationHealth[];
  connectionState: string;
  onNavigate: (view: string) => void;
  onRefresh: () => void;
}

export const OverviewView: React.FC<OverviewViewProps> = ({
  mode,
  analytics,
  incidents,
  warehouses,
  notifications,
  recentEvents,
  integrations,
  connectionState,
  onNavigate,
  onRefresh,
}) => {
  const [sitrep, setSitrep] = useState<StructuredAIAgentOutput | null>(null);
  const [loadingSitrep, setLoadingSitrep] = useState(false);
  const [sitrepError, setSitrepError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const kpis = analytics?.kpis || {
    activeIncidents: 0,
    criticalIncidents: 0,
    totalPeopleAffected: 0,
    openReliefRequests: 0,
    shortageSkus: 0,
    activeDispatches: 0,
    completedDeliveries: 0,
    pendingApprovals: 0,
    fulfillmentRatePct: 0,
  };

  const operationalWarehouses = warehouses.filter((w) => w.status === 'operational').length;
  const unreadNotifications = notifications.filter((n) => !n.read);
  const modeEvents = recentEvents.filter((e) => e.mode === mode);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await Promise.resolve(onRefresh());
    } finally {
      window.setTimeout(() => setRefreshing(false), 260);
    }
  };

  const generateSitrep = async () => {
    setLoadingSitrep(true);
    setSitrepError(null);
    try {
      const res = await apiRequest<{ task: StructuredAIAgentOutput }>('/ai/agent', {
        method: 'POST',
        body: {
          agentType: 'situation_report',
          mode,
          model: 'gemini-4-hydrogen',
          prompt:
            'Generate an executive operational SITREP covering active incidents, shortages, and top commander priorities.',
        },
      });
      setSitrep(res.task);
    } catch (err) {
      setSitrepError(err instanceof Error ? err.message : 'Failed to generate AI SITREP');
    } finally {
      setLoadingSitrep(false);
    }
  };

  return (
    <div className="space-y-7">
      {/* Executive Command Header */}
      <PageHeader
        kicker={`Central Command · ${mode === 'demo' ? 'Sandbox Demo Workspace' : 'Live Operational Workspace'} · Stream ${connectionState}`}
        title="Emergency Operations Overview"
        subtitle="Real-time operational readiness across verified incidents, regional warehouse capacity, relief demand, active dispatches, and AI coordination."
        actions={
          <>
            <button
              type="button"
              onClick={() => onNavigate('map')}
              className="rf-btn-primary text-[13.5px]"
            >
              <MapPin className="w-4 h-4" />
              <span>Open Live Map</span>
            </button>
            <button
              type="button"
              onClick={() => onNavigate('ai-command')}
              className="rf-btn-secondary text-[13.5px]"
            >
              <Shield className="w-4 h-4 text-[#5869E8] dark:text-[#8190FF]" />
              <span>AI Command</span>
            </button>
            <button
              type="button"
              onClick={generateSitrep}
              disabled={loadingSitrep}
              className="rf-btn-secondary text-[13.5px]"
            >
              <Bot className="w-4 h-4 text-[#089FCB] dark:text-[#35C8F5]" />
              <span>{loadingSitrep ? 'Generating SITREP...' : 'Run AI SITREP'}</span>
            </button>
            <button
              type="button"
              onClick={handleRefresh}
              className="rf-btn-secondary px-3"
              title="Refresh operational state"
              aria-label="Refresh operational state"
            >
              <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
            </button>
          </>
        }
      />

      {/* Primary 6-Metric Operational Grid (100% Real Connected Data) */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
        <MetricCard
          label="Active Incidents"
          value={kpis.activeIncidents}
          context={`${kpis.criticalIncidents} critical · ${kpis.totalPeopleAffected.toLocaleString()} affected`}
          icon={ShieldAlert}
          tone={kpis.criticalIncidents > 0 ? 'danger' : 'neutral'}
          onClick={() => onNavigate('incidents')}
        />
        <MetricCard
          label="Relief Requests"
          value={kpis.openReliefRequests}
          context={`${kpis.fulfillmentRatePct}% fulfilled`}
          icon={Users}
          tone={kpis.openReliefRequests > 0 ? 'warning' : 'neutral'}
          onClick={() => onNavigate('relief')}
        />
        <MetricCard
          label="Warehouses Ready"
          value={`${operationalWarehouses}/${warehouses.length}`}
          context={
            warehouses.length > 0 ? 'Operational supply hubs' : 'No depots registered yet'
          }
          icon={WarehouseIcon}
          tone={operationalWarehouses > 0 ? 'success' : 'neutral'}
          onClick={() => onNavigate('warehouses')}
        />
        <MetricCard
          label="Stock Shortages"
          value={kpis.shortageSkus}
          context="SKUs below threshold"
          icon={Box}
          tone={kpis.shortageSkus > 0 ? 'warning' : 'success'}
          onClick={() => onNavigate('inventory')}
        />
        <MetricCard
          label="Active Dispatches"
          value={kpis.activeDispatches}
          context={`${kpis.completedDeliveries} deliveries verified`}
          icon={Truck}
          tone="cyan"
          onClick={() => onNavigate('dispatches')}
        />
        <MetricCard
          label="Pending Approvals"
          value={kpis.pendingApprovals}
          context="Commander review gate"
          icon={ClipboardCheck}
          tone={kpis.pendingApprovals > 0 ? 'brand' : 'neutral'}
          onClick={() => onNavigate('allocations')}
        />
      </div>

      {/* On-Demand AI SITREP Panel (Only Shown When Requested) */}
      {(sitrep || sitrepError) && (
        <section className="rf-card p-6 border-[var(--rf-border-active)] space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-[var(--rf-border-default)]">
            <div className="flex items-center gap-2.5">
              <span className="w-8 h-8 rounded-[10px] bg-[#5869E8]/12 dark:bg-[#6D7CFF]/18 text-[#5869E8] dark:text-[#8190FF] flex items-center justify-center">
                <Bot className="w-4 h-4" />
              </span>
              <div>
                <h2 className="text-[15px] font-semibold text-[var(--rf-text-primary)]">
                  AI Situation Report
                </h2>
                <div className="text-xs text-[var(--rf-text-muted)]">
                  Decision support only · Commander verification required before execution
                </div>
              </div>
            </div>
            {sitrep && (
              <div className="text-xs font-mono text-[var(--rf-text-muted)] tabular-nums">
                {sitrep.model_used} · confidence{' '}
                {sitrep.confidence !== null ? `${Math.round(sitrep.confidence * 100)}%` : 'N/A'}
              </div>
            )}
          </div>

          {sitrepError ? (
            <div className="text-sm text-[#E5465D] dark:text-[#FF5C70]">{sitrepError}</div>
          ) : (
            sitrep && (
              <div className="space-y-4">
                <p className="text-sm text-[var(--rf-text-secondary)] leading-relaxed">{sitrep.summary}</p>
                <div className="grid md:grid-cols-2 gap-3.5">
                  {sitrep.recommendations.map((rec, idx) => (
                    <div key={idx} className="rf-card-surface p-4 space-y-1.5">
                      <div className="text-xs font-semibold text-[#5869E8] dark:text-[#35C8F5]">
                        {rec.priority} · {rec.title}
                      </div>
                      <div className="text-sm font-medium text-[var(--rf-text-primary)]">{rec.action}</div>
                      <div className="text-xs text-[var(--rf-text-muted)] leading-relaxed">
                        {rec.rationale}
                      </div>
                    </div>
                  ))}
                </div>
                {sitrep.source_ids.length > 0 && (
                  <div className="text-xs font-mono text-[var(--rf-text-muted)]">
                    Grounded record IDs: {sitrep.source_ids.join(', ')}
                  </div>
                )}
              </div>
            )
          )}
        </section>
      )}

      {/* Primary Operational Grid: Supply vs. Demand + Real-Time Event Stream */}
      <div className="grid lg:grid-cols-12 gap-5">
        <section className="lg:col-span-8 rf-card p-6 flex flex-col justify-between">
          <div className="flex flex-wrap items-start justify-between gap-3 mb-5">
            <div className="space-y-0.5">
              <h2 className="text-base font-semibold text-[var(--rf-text-primary)]">
                Supply Readiness vs. Open Relief Demand
              </h2>
              <p className="text-xs text-[var(--rf-text-muted)]">
                Live warehouse stock compared against active unfulfilled relief request quantities by category
              </p>
            </div>
            <button
              type="button"
              onClick={() => onNavigate('analytics')}
              className="text-xs font-medium text-[#5869E8] dark:text-[#8190FF] hover:underline inline-flex items-center gap-1 whitespace-nowrap"
            >
              <span>Full Analytics</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>

          <div className="h-[272px]">
            {analytics?.supplyVsDemand?.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={analytics.supplyVsDemand} barGap={4}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(148,163,184,0.16)" vertical={false} />
                  <XAxis
                    dataKey="category"
                    tick={{ fontSize: 11, fill: '#8FA0B9' }}
                    axisLine={{ stroke: 'rgba(148,163,184,0.18)' }}
                    tickLine={false}
                  />
                  <YAxis
                    tick={{ fontSize: 11, fill: '#8FA0B9' }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <Tooltip
                    cursor={{ fill: 'rgba(109, 124, 255, 0.08)' }}
                    contentStyle={{
                      backgroundColor: '#111A2A',
                      borderColor: 'rgba(148, 163, 184, 0.22)',
                      borderRadius: '10px',
                      color: '#F1F5F9',
                      fontSize: '12px',
                    }}
                  />
                  <Bar dataKey="available" name="Available Stock" fill="#6D7CFF" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="reserved" name="Reserved" fill="#FFB547" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="demand" name="Open Demand" fill="#FF5C70" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <EmptyState
                icon={Box}
                title={`No inventory or demand recorded in ${mode} mode`}
                description="Add warehouse stock or log an emergency relief request to compare live supply readiness against unmet demand."
                actionLabel="Open Warehouses"
                onAction={() => onNavigate('warehouses')}
              />
            )}
          </div>
        </section>

        {/* Live WebSocket Event Stream */}
        <section className="lg:col-span-4 rf-card p-6 flex flex-col">
          <div className="flex items-center justify-between gap-2 pb-4 border-b border-[var(--rf-border-default)]">
            <h2 className="text-base font-semibold text-[var(--rf-text-primary)] flex items-center gap-2">
              <Radio className="w-4 h-4 text-[#089FCB] dark:text-[#35C8F5]" />
              <span>Live Event Stream</span>
            </h2>
            <span className="text-xs font-mono text-[var(--rf-text-muted)] tabular-nums">
              {modeEvents.length} events
            </span>
          </div>

          <div className="mt-3 space-y-2.5 overflow-y-auto max-h-[268px] pr-1">
            {modeEvents.length === 0 ? (
              <EmptyState
                icon={Radio}
                title="Listening for live events"
                description="Mutations to incidents, inventory, allocations, dispatches, and AI sessions stream here in real time."
              />
            ) : (
              modeEvents.slice(0, 12).map((ev) => (
                <div
                  key={ev.event_id}
                  className="py-2.5 border-b border-[var(--rf-border-default)] last:border-0 space-y-1"
                >
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <span className="font-mono font-medium text-[#5869E8] dark:text-[#35C8F5] truncate">
                      {ev.event_type}
                    </span>
                    <span className="font-mono text-[11px] text-[var(--rf-text-muted)] tabular-nums shrink-0">
                      {new Date(ev.timestamp).toLocaleTimeString()}
                    </span>
                  </div>
                  <div className="text-[11.5px] text-[var(--rf-text-muted)] font-mono truncate">
                    {ev.source} · {ev.entity_id.slice(0, 14)}
                  </div>
                </div>
              ))
            )}
          </div>
        </section>
      </div>

      {/* Bottom Operational Row: Priority Incidents · Unread Alerts · Service Health */}
      <div className="grid lg:grid-cols-3 gap-5">
        {/* Priority Incidents */}
        <section className="rf-card p-6 flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold text-[var(--rf-text-primary)]">Priority Incidents</h2>
            <button
              type="button"
              onClick={() => onNavigate('incidents')}
              className="text-xs font-medium text-[#5869E8] dark:text-[#8190FF] hover:underline"
            >
              Manage all
            </button>
          </div>
          <div className="divide-y divide-[var(--rf-border-default)]">
            {incidents.slice(0, 4).map((inc) => (
              <button
                key={inc.id}
                type="button"
                onClick={() => onNavigate('incidents')}
                className="w-full text-left py-3 first:pt-0 last:pb-0 hover:opacity-85 transition-opacity space-y-1"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[13.5px] font-medium text-[var(--rf-text-primary)] truncate">
                    {inc.title}
                  </span>
                  <span
                    className={`text-[11px] font-mono font-semibold uppercase shrink-0 ${
                      inc.severity === 'critical'
                        ? 'text-[#E5465D] dark:text-[#FF465A]'
                        : inc.severity === 'high'
                        ? 'text-[#B97716] dark:text-[#FFB547]'
                        : 'text-[var(--rf-text-muted)]'
                    }`}
                  >
                    {inc.severity}
                  </span>
                </div>
                <div className="text-xs text-[var(--rf-text-muted)] tabular-nums">
                  {inc.region} · {inc.peopleAffected.toLocaleString()} affected · Risk{' '}
                  {inc.riskScore ?? 'Pending'}
                </div>
              </button>
            ))}
            {incidents.length === 0 && (
              <EmptyState
                icon={ShieldAlert}
                title="No incidents recorded"
                description={`Operational intake in ${mode} mode is currently clear.`}
                actionLabel="Report Incident"
                onAction={() => onNavigate('incidents')}
              />
            )}
          </div>
        </section>

        {/* Unread Operational Alerts */}
        <section className="rf-card p-6 flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold text-[var(--rf-text-primary)]">
              Unread Operational Alerts
            </h2>
            <button
              type="button"
              onClick={() => onNavigate('notifications')}
              className="text-xs font-medium text-[#5869E8] dark:text-[#8190FF] hover:underline"
            >
              Open inbox
            </button>
          </div>
          <div className="divide-y divide-[var(--rf-border-default)]">
            {unreadNotifications.slice(0, 4).map((n) => (
              <div key={n.id} className="py-3 first:pt-0 last:pb-0 space-y-1">
                <div className="flex items-center gap-2 text-[13.5px] font-medium text-[var(--rf-text-primary)]">
                  <AlertTriangle
                    className={`w-3.5 h-3.5 shrink-0 ${
                      n.severity === 'critical'
                        ? 'text-[#E5465D] dark:text-[#FF5C70]'
                        : 'text-[#B97716] dark:text-[#FFB547]'
                    }`}
                  />
                  <span className="truncate">{n.title}</span>
                </div>
                <p className="text-xs text-[var(--rf-text-muted)] line-clamp-2 leading-relaxed">
                  {n.message}
                </p>
              </div>
            ))}
            {unreadNotifications.length === 0 && (
              <EmptyState
                icon={CheckCircle2}
                title="All alerts acknowledged"
                description="No unread operational notifications require attention."
              />
            )}
          </div>
        </section>

        {/* Service & Integration Health */}
        <section className="rf-card p-6 flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold text-[var(--rf-text-primary)] flex items-center gap-2">
              <Activity className="w-4 h-4 text-[#5869E8] dark:text-[#8190FF]" />
              <span>Service Health</span>
            </h2>
            <button
              type="button"
              onClick={() => onNavigate('admin')}
              className="text-xs font-medium text-[#5869E8] dark:text-[#8190FF] hover:underline"
            >
              Diagnostics
            </button>
          </div>
          <div className="divide-y divide-[var(--rf-border-default)]">
            {integrations.map((int) => (
              <div
                key={int.id}
                className="flex items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0 text-xs"
              >
                <div className="min-w-0">
                  <div className="font-medium text-[var(--rf-text-primary)] truncate">{int.name}</div>
                  <div className="text-[11px] text-[var(--rf-text-muted)] truncate">{int.provider}</div>
                </div>
                <span
                  className={`font-mono text-[11px] font-semibold uppercase shrink-0 ${
                    int.status === 'healthy'
                      ? 'text-[#15966C] dark:text-[#35D6A0]'
                      : int.status === 'degraded'
                      ? 'text-[#B97716] dark:text-[#FFB547]'
                      : 'text-[#E5465D] dark:text-[#FF5C70]'
                  }`}
                >
                  {int.status}
                </span>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
};
