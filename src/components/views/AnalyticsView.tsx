import React, { useCallback, useEffect, useState } from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { BarChart3, Download, Filter, RefreshCw } from 'lucide-react';
import { apiRequest } from '../../lib/api';
import type { DataMode, Warehouse } from '../../shared/types';

interface AnalyticsViewProps {
  mode: DataMode;
  analytics: any;
  warehouses?: Warehouse[];
  onNavigate?: (view: string) => void;
}

interface OverviewResponse {
  kpis: {
    totalWarehouses: number;
    operationalWarehouses: number;
    totalInventoryItems: number;
    totalOnHandUnits: number;
    totalAvailableUnits: number;
    totalReservedUnits: number;
    lowStockItems: number;
    criticalShortages: number;
    expiringItemsCount: number;
    pendingIncomingShipments: number;
    activeReservationsCount: number;
    demandFulfillmentRate: number;
  };
  inventoryByCategory: { category: string; available: number; reserved: number; total: number }[];
  criticalShortagesList: {
    stockId: string;
    itemName: string;
    warehouseName: string;
    availableQty: number;
    minStock: number;
    deficit: number;
    status: string;
  }[];
}

interface DemandResponse {
  totalDemand: number;
  totalFulfilled: number;
  totalAvailableStock: number;
  totalReservedStock: number;
  totalShortage: number;
  fulfillmentPercentage: number;
  criticalUnmetDemand: number;
  byCategory: { category: string; requestedQty: number; availableStock: number; shortageQty: number }[];
}

interface WarehouseAnalyticsRow {
  warehouseId: string;
  name: string;
  status: string;
  availableUnits: number;
  reservedUnits: number;
  capacityUnits: number;
  utilizationPct: number;
  criticalShortages: number;
}

interface MovementAnalyticsResponse {
  totals: { totalMovements: number; totalInbound: number; totalOutbound: number; totalReserved: number };
  timeline: { date: string; inbound: number; outbound: number; reserved: number; transfers: number }[];
  incomingVsOutgoing: { label: string; units: number }[];
}

export const AnalyticsView: React.FC<AnalyticsViewProps> = ({
  mode,
  analytics,
  warehouses = [],
  onNavigate,
}) => {
  const [warehouseFilter, setWarehouseFilter] = useState('all');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');

  const [invOverview, setInvOverview] = useState<OverviewResponse | null>(null);
  const [demandData, setDemandData] = useState<DemandResponse | null>(null);
  const [whAnalytics, setWhAnalytics] = useState<WarehouseAnalyticsRow[]>([]);
  const [movAnalytics, setMovAnalytics] = useState<MovementAnalyticsResponse | null>(null);
  const [loading, setLoading] = useState(false);

  const loadAnalytics = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams({ mode });
      if (warehouseFilter !== 'all') qs.set('warehouseId', warehouseFilter);
      if (categoryFilter !== 'all') qs.set('category', categoryFilter);
      if (statusFilter !== 'all') qs.set('status', statusFilter);

      const [ov, dm, wh, mv] = await Promise.all([
        apiRequest<OverviewResponse>(`/inventory/analytics/overview?${qs.toString()}`),
        apiRequest<DemandResponse>(`/inventory/analytics/demand?mode=${mode}`),
        apiRequest<{ warehouses: WarehouseAnalyticsRow[] }>(`/inventory/analytics/warehouse?mode=${mode}`),
        apiRequest<MovementAnalyticsResponse>(`/inventory/analytics/movements?mode=${mode}`),
      ]);
      setInvOverview(ov);
      setDemandData(dm);
      setWhAnalytics(wh.warehouses);
      setMovAnalytics(mv);
    } catch {
      // keep existing UI stable
    } finally {
      setLoading(false);
    }
  }, [mode, warehouseFilter, categoryFilter, statusFilter]);

  useEffect(() => {
    loadAnalytics();
  }, [loadAnalytics]);

  const kpis = invOverview?.kpis;
  const severityData = [
    { name: 'Critical', count: analytics?.severityBreakdown?.critical ?? 0 },
    { name: 'High', count: analytics?.severityBreakdown?.high ?? 0 },
    { name: 'Medium', count: analytics?.severityBreakdown?.medium ?? 0 },
    { name: 'Low', count: analytics?.severityBreakdown?.low ?? 0 },
  ];

  const downloadCsv = (entity: string) => {
    const a = document.createElement('a');
    a.href = `/api/v1/exports/csv/${entity}?mode=${mode}`;
    a.download = `resqflow-${entity}-${mode}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  return (
    <div className="space-y-5">
      {/* Header & Exports */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-900 dark:text-white flex items-center gap-2">
            <BarChart3 className="w-5 h-5 text-cyan-500" />
            Real-Time Inventory &amp; Relief Analytics
          </h1>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Live database metrics across warehouses, stock ledger, relief demand, shortages, and movements · Zero fabricated analytics
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={loadAnalytics}
            disabled={loading}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-medium hover:border-cyan-500"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
          {['incidents', 'inventory', 'relief-requests', 'audit-logs'].map((entity) => (
            <button
              key={entity}
              type="button"
              onClick={() => downloadCsv(entity)}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-medium hover:border-cyan-500"
            >
              <Download className="w-3.5 h-3.5 text-cyan-500" />
              {entity.replace(/-/g, ' ')} CSV
            </button>
          ))}
        </div>
      </div>

      {/* Filter Bar */}
      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/80 p-3 flex flex-wrap items-center gap-2.5 text-xs">
        <div className="flex items-center gap-1.5 text-slate-500 font-medium">
          <Filter className="w-3.5 h-3.5 text-cyan-500" />
          Inventory Slice:
        </div>
        <select
          value={warehouseFilter}
          onChange={(e) => setWarehouseFilter(e.target.value)}
          className="px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
        >
          <option value="all">All Warehouses</option>
          {warehouses.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </select>
        <select
          value={categoryFilter}
          onChange={(e) => setCategoryFilter(e.target.value)}
          className="px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
        >
          <option value="all">All Resource Categories</option>
          <option value="drinking_water">Water &amp; Hydration</option>
          <option value="food">Food &amp; Nutrition</option>
          <option value="medical_kits">Medical &amp; First-Aid</option>
          <option value="shelter">Shelter &amp; Tents</option>
          <option value="hygiene_kits">Purification &amp; Hygiene</option>
          <option value="power_equipment">Generators &amp; Power</option>
          <option value="rescue_equipment">Rescue Equipment</option>
        </select>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
        >
          <option value="all">All Stock Levels</option>
          <option value="NORMAL">Normal</option>
          <option value="LOW">Low</option>
          <option value="CRITICAL">Critical</option>
          <option value="OUT_OF_STOCK">Out of Stock</option>
        </select>
      </div>

      {/* Real Inventory KPI Strip (click-to-navigate) */}
      <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-7 gap-3 text-xs tabular-nums">
        <button
          type="button"
          onClick={() => onNavigate?.('warehouses')}
          className="text-left rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/80 p-3.5 hover:border-cyan-500/60 transition-colors"
        >
          <div className="text-slate-500">Operational Depots</div>
          <div className="text-xl font-bold font-mono text-slate-900 dark:text-white mt-0.5">
            {kpis?.operationalWarehouses ?? 0} / {kpis?.totalWarehouses ?? 0}
          </div>
        </button>
        <button
          type="button"
          onClick={() => onNavigate?.('inventory')}
          className="text-left rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/80 p-3.5 hover:border-cyan-500/60 transition-colors"
        >
          <div className="text-slate-500">Available Units</div>
          <div className="text-xl font-bold font-mono text-emerald-600 dark:text-emerald-400 mt-0.5">
            {(kpis?.totalAvailableUnits ?? 0).toLocaleString()}
          </div>
        </button>
        <button
          type="button"
          onClick={() => onNavigate?.('inventory')}
          className="text-left rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/80 p-3.5 hover:border-cyan-500/60 transition-colors"
        >
          <div className="text-slate-500">Reserved Units</div>
          <div className="text-xl font-bold font-mono text-cyan-600 dark:text-cyan-400 mt-0.5">
            {(kpis?.totalReservedUnits ?? 0).toLocaleString()}
          </div>
        </button>
        <button
          type="button"
          onClick={() => onNavigate?.('inventory')}
          className="text-left rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/80 p-3.5 hover:border-red-500/60 transition-colors"
        >
          <div className="text-slate-500">Critical Shortages</div>
          <div className="text-xl font-bold font-mono text-red-600 dark:text-red-400 mt-0.5">
            {kpis?.criticalShortages ?? 0}
          </div>
        </button>
        <button
          type="button"
          onClick={() => onNavigate?.('inventory')}
          className="text-left rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/80 p-3.5 hover:border-amber-500/60 transition-colors"
        >
          <div className="text-slate-500">Expiring / Expired</div>
          <div className="text-xl font-bold font-mono text-amber-600 dark:text-amber-400 mt-0.5">
            {kpis?.expiringItemsCount ?? 0}
          </div>
        </button>
        <button
          type="button"
          onClick={() => onNavigate?.('inventory')}
          className="text-left rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/80 p-3.5 hover:border-cyan-500/60 transition-colors"
        >
          <div className="text-slate-500">Pending Incoming</div>
          <div className="text-xl font-bold font-mono text-slate-900 dark:text-white mt-0.5">
            {kpis?.pendingIncomingShipments ?? 0}
          </div>
        </button>
        <button
          type="button"
          onClick={() => onNavigate?.('relief')}
          className="text-left rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/80 p-3.5 hover:border-cyan-500/60 transition-colors"
        >
          <div className="text-slate-500">Demand Fulfillment</div>
          <div className="text-xl font-bold font-mono text-slate-900 dark:text-white mt-0.5">
            {kpis?.demandFulfillmentRate ?? 0}%
          </div>
        </button>
      </div>

      {/* 6 Real Inventory & Operations Charts */}
      <div className="grid lg:grid-cols-2 gap-4">
        {/* 1. Inventory by Category */}
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/80 p-4 space-y-3">
          <div className="text-sm font-semibold text-slate-900 dark:text-white">
            1. Inventory by Category (Available vs. Reserved)
          </div>
          {!invOverview || invOverview.inventoryByCategory.length === 0 ? (
            <div className="h-56 flex items-center justify-center text-xs text-slate-500">
              No inventory records available in {mode.toUpperCase()} mode.
            </div>
          ) : (
            <div className="h-56">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={invOverview.inventoryByCategory}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#334155" opacity={0.25} />
                  <XAxis dataKey="category" stroke="#94a3b8" fontSize={11} />
                  <YAxis stroke="#94a3b8" fontSize={11} />
                  <Tooltip />
                  <Bar dataKey="available" name="Available" fill="#06b6d4" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="reserved" name="Reserved" fill="#8b5cf6" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>

        {/* 2. Stock Availability by Warehouse */}
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/80 p-4 space-y-3">
          <div className="text-sm font-semibold text-slate-900 dark:text-white">
            2. Stock Availability by Warehouse
          </div>
          {whAnalytics.length === 0 ? (
            <div className="h-56 flex items-center justify-center text-xs text-slate-500">
              No warehouses registered in {mode.toUpperCase()} mode.
            </div>
          ) : (
            <div className="h-56">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={whAnalytics.map((w) => ({ ...w, shortName: w.name.slice(0, 18) }))}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#334155" opacity={0.25} />
                  <XAxis dataKey="shortName" stroke="#94a3b8" fontSize={11} />
                  <YAxis stroke="#94a3b8" fontSize={11} />
                  <Tooltip />
                  <Bar dataKey="availableUnits" name="Available" fill="#10b981" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="reservedUnits" name="Reserved" fill="#f59e0b" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>

        {/* 3. Supply vs. Demand */}
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/80 p-4 space-y-3">
          <div className="text-sm font-semibold text-slate-900 dark:text-white">
            3. Supply vs. Emergency Demand by Category
          </div>
          {!demandData || demandData.byCategory.length === 0 ? (
            <div className="h-56 flex items-center justify-center text-xs text-slate-500">
              No active demand or supply records in {mode.toUpperCase()} mode.
            </div>
          ) : (
            <div className="h-56">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={demandData.byCategory.map((c) => ({
                    ...c,
                    label: c.category.replace(/_/g, ' '),
                  }))}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="#334155" opacity={0.25} />
                  <XAxis dataKey="label" stroke="#94a3b8" fontSize={11} />
                  <YAxis stroke="#94a3b8" fontSize={11} />
                  <Tooltip />
                  <Bar dataKey="availableStock" name="Available Supply" fill="#06b6d4" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="requestedQty" name="Requested Demand" fill="#ef4444" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>

        {/* 4. Critical Shortages */}
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/80 p-4 space-y-3">
          <div className="text-sm font-semibold text-slate-900 dark:text-white">
            4. Low &amp; Critical Stock Deficit Breakdown
          </div>
          {!invOverview || invOverview.criticalShortagesList.length === 0 ? (
            <div className="h-56 flex items-center justify-center text-xs text-slate-500">
              No stock items currently below minimum thresholds.
            </div>
          ) : (
            <div className="h-56">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={invOverview.criticalShortagesList.map((s) => ({
                    ...s,
                    label: s.itemName.slice(0, 20),
                  }))}
                  layout="vertical"
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="#334155" opacity={0.25} />
                  <XAxis type="number" stroke="#94a3b8" fontSize={11} />
                  <YAxis type="category" dataKey="label" stroke="#94a3b8" fontSize={11} width={120} />
                  <Tooltip />
                  <Bar dataKey="availableQty" name="Available" fill="#f59e0b" radius={[0, 4, 4, 0]} />
                  <Bar dataKey="deficit" name="Threshold Deficit" fill="#ef4444" radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>

        {/* 5. Stock Movements Over Time */}
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/80 p-4 space-y-3">
          <div className="text-sm font-semibold text-slate-900 dark:text-white">
            5. Stock Movements Over Time
          </div>
          {!movAnalytics || movAnalytics.timeline.length === 0 ? (
            <div className="h-56 flex items-center justify-center text-xs text-slate-500">
              No stock ledger movements recorded yet.
            </div>
          ) : (
            <div className="h-56">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={movAnalytics.timeline}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#334155" opacity={0.25} />
                  <XAxis dataKey="date" stroke="#94a3b8" fontSize={11} />
                  <YAxis stroke="#94a3b8" fontSize={11} />
                  <Tooltip />
                  <Area type="monotone" dataKey="inbound" name="Inbound" stroke="#10b981" fill="#10b981" fillOpacity={0.2} />
                  <Area type="monotone" dataKey="outbound" name="Outbound" stroke="#ef4444" fill="#ef4444" fillOpacity={0.2} />
                  <Area type="monotone" dataKey="reserved" name="Reserved" stroke="#06b6d4" fill="#06b6d4" fillOpacity={0.15} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>

        {/* 6. Incoming vs. Outgoing + Incident Severity */}
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/80 p-4 space-y-3">
          <div className="text-sm font-semibold text-slate-900 dark:text-white">
            6. Incoming vs. Outgoing Volume ({movAnalytics?.totals.totalMovements ?? 0} Movements)
          </div>
          {!movAnalytics || movAnalytics.totals.totalMovements === 0 ? (
            <div className="h-56 flex items-center justify-center text-xs text-slate-500">
              No movement volume recorded yet.
            </div>
          ) : (
            <div className="h-56">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={movAnalytics.incomingVsOutgoing}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#334155" opacity={0.25} />
                  <XAxis dataKey="label" stroke="#94a3b8" fontSize={11} />
                  <YAxis stroke="#94a3b8" fontSize={11} />
                  <Tooltip />
                  <Bar dataKey="units" name="Units" fill="#06b6d4" radius={[6, 6, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>
      </div>

      {/* Incident Severity Distribution (Preserved from Earlier Phases) */}
      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/80 p-4 space-y-3">
        <div className="text-sm font-semibold text-slate-900 dark:text-white">
          Incident Severity Distribution ({mode.toUpperCase()} Mode)
        </div>
        <div className="h-48">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={severityData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#334155" opacity={0.25} />
              <XAxis dataKey="name" stroke="#94a3b8" fontSize={12} />
              <YAxis stroke="#94a3b8" fontSize={12} allowDecimals={false} />
              <Tooltip />
              <Bar dataKey="count" fill="#06b6d4" radius={[6, 6, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
};
