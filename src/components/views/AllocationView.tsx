import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  Edit3,
  GitFork,
  Layers,
  Lock,
  RefreshCw,
  Scale,
  Send,
  Sparkles,
  Truck,
  XCircle,
} from 'lucide-react';
import { apiRequest } from '../../lib/api';
import type {
  Allocation,
  DataMode,
  LogisticsAIAdvisory,
  ReliefRequest,
  Vehicle,
  Warehouse,
} from '../../shared/types';

interface AllocationViewProps {
  mode: DataMode;
  allocations: Allocation[];
  requests: ReliefRequest[];
  vehicles: Vehicle[];
  warehouses?: Warehouse[];
  onRefresh: () => void;
  onNavigate: (view: string) => void;
}

interface LogisticsOverviewData {
  allocationMetrics: {
    totalAllocations: number;
    proposedCount: number;
    approvedOrReservedCount: number;
    multiWarehouseSplitCount: number;
    unmetDemandCount: number;
    avgFulfillmentPct: number | null;
  };
  fleetMetrics: {
    totalVehicles: number;
    availableVehicles: number;
    deployedVehicles: number;
    maintenanceVehicles: number;
    utilizationPct: number | null;
    totalDrivers: number;
    availableDrivers: number;
  };
  dispatchMetrics: {
    totalDispatches: number;
    activeDispatches: number;
    pendingApproval: number;
    enRoute: number;
    delayed: number;
    completed: number;
    totalDeliveriesConfirmed: number;
    activeRouteHazards: number;
  };
  coordination: {
    openRequestsCount: number;
    competingWarehouses: { warehouseId: string; warehouseName: string; competingAllocations: number }[];
    underutilizedWarehouses: { warehouseId: string; warehouseName: string; region: string }[];
    unservedHighPriorityIncidents: { incidentId: string; title: string; severity: string; riskScore: number }[];
    fleetOverloaded: boolean;
    delayedDispatchIds: string[];
  };
}

export const AllocationView: React.FC<AllocationViewProps> = ({
  mode,
  allocations,
  requests,
  vehicles,
  onRefresh,
  onNavigate,
}) => {
  const [selectedRequestId, setSelectedRequestId] = useState(requests[0]?.id || '');
  const [allowSplit, setAllowSplit] = useState(true);
  const [selectedVehicleByAlloc, setSelectedVehicleByAlloc] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [overview, setOverview] = useState<LogisticsOverviewData | null>(null);

  // Edit proposal quantities modal state
  const [editingAlloc, setEditingAlloc] = useState<Allocation | null>(null);
  const [editQuantities, setEditQuantities] = useState<Record<string, number>>({});
  const [editNote, setEditNote] = useState('');

  // Grounded AI Logistics Assistant state
  const [aiQuestion, setAiQuestion] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
  const [advisory, setAdvisory] = useState<LogisticsAIAdvisory | null>(null);
  const [aiError, setAiError] = useState<string | null>(null);

  const loadOverview = useCallback(async () => {
    try {
      const data = await apiRequest<LogisticsOverviewData>(`/logistics/overview?mode=${mode}`);
      setOverview(data);
    } catch {
      // handled gracefully
    }
  }, [mode]);

  useEffect(() => {
    loadOverview();
  }, [loadOverview, allocations.length, vehicles.length]);

  useEffect(() => {
    if (!selectedRequestId && requests.length > 0) {
      setSelectedRequestId(requests[0].id);
    }
  }, [requests, selectedRequestId]);

  const availableVehicles = vehicles.filter(
    (v) => v.status === 'available' && v.maintenanceStatus !== 'in_maintenance' && v.maintenanceStatus !== 'out_of_service'
  );

  const runOptimize = async () => {
    const reqId = selectedRequestId || requests[0]?.id;
    if (!reqId) {
      setError('Select a verified relief request first.');
      return;
    }
    setBusyId('optimize');
    setError(null);
    setNotice(null);
    try {
      await apiRequest('/allocations/optimize', {
        method: 'POST',
        body: JSON.stringify({ requestId: reqId, allowSplit }),
      });
      setNotice('Multi-warehouse allocation proposal generated. Human approval required before stock reservation.');
      onRefresh();
      loadOverview();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to optimize allocation');
    } finally {
      setBusyId(null);
    }
  };

  const handleAction = async (id: string, action: 'approve' | 'reject' | 'reserve' | 'recalculate') => {
    setBusyId(`${id}-${action}`);
    setError(null);
    setNotice(null);
    try {
      await apiRequest(`/allocations/${id}/${action}`, {
        method: 'POST',
        body: JSON.stringify(
          action === 'reject' ? { reason: 'Commander rejected proposal in review' } : { allowSplit }
        ),
      });
      setNotice(`Allocation ${action} completed.`);
      onRefresh();
      loadOverview();
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to ${action} allocation`);
    } finally {
      setBusyId(null);
    }
  };

  const openEditModal = (alloc: Allocation) => {
    const map: Record<string, number> = {};
    for (const item of alloc.items) {
      map[item.stockId] = item.quantity;
    }
    setEditQuantities(map);
    setEditNote('');
    setEditingAlloc(alloc);
  };

  const saveAllocationEdit = async () => {
    if (!editingAlloc) return;
    setBusyId(`${editingAlloc.id}-edit`);
    setError(null);
    try {
      const items = Object.entries(editQuantities)
        .filter(([, q]) => q > 0)
        .map(([stockId, quantity]) => ({ stockId, quantity: Math.floor(quantity) }));
      await apiRequest(`/allocations/${editingAlloc.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ items, note: editNote || undefined }),
      });
      setEditingAlloc(null);
      setNotice('Allocation proposal updated.');
      onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update allocation quantities');
    } finally {
      setBusyId(null);
    }
  };

  const createPendingDispatch = async (alloc: Allocation) => {
    const vehicleId =
      selectedVehicleByAlloc[alloc.id] || alloc.recommendedVehicleId || availableVehicles[0]?.id;
    if (!vehicleId) {
      setError('No available vehicle selected. Register or free a vehicle in Fleet Management first.');
      return;
    }
    setBusyId(`${alloc.id}-dispatch`);
    setError(null);
    setNotice(null);
    try {
      await apiRequest('/dispatches', {
        method: 'POST',
        body: JSON.stringify({
          allocationId: alloc.id,
          vehicleId,
          requireApproval: true,
          note: 'Submitted from Smart Allocation Workspace for commander dispatch approval',
        }),
      });
      setNotice('Dispatch proposal queued for human approval in Active Dispatches.');
      onRefresh();
      onNavigate('dispatches');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to queue dispatch');
    } finally {
      setBusyId(null);
    }
  };

  const runAiLogisticsAssist = async (focusAllocationId?: string) => {
    setAiBusy(true);
    setAiError(null);
    try {
      const res = await apiRequest<{ advisory: LogisticsAIAdvisory }>('/logistics/ai/assist', {
        method: 'POST',
        body: JSON.stringify({
          mode,
          requestId: selectedRequestId || undefined,
          allocationId: focusAllocationId || allocations[0]?.id || undefined,
          question: aiQuestion.trim() || undefined,
        }),
      });
      setAdvisory(res.advisory);
    } catch (err) {
      setAiError(err instanceof Error ? err.message : 'AI Logistics Assistant unavailable.');
    } finally {
      setAiBusy(false);
    }
  };

  const priorityBadgeClass = (band?: string) => {
    switch (band) {
      case 'CRITICAL':
        return 'bg-red-500/15 text-red-600 dark:text-red-400 border-red-500/30';
      case 'URGENT':
        return 'bg-orange-500/15 text-orange-600 dark:text-orange-400 border-orange-500/30';
      case 'HIGH':
        return 'bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30';
      default:
        return 'bg-[#5869E8]/12 dark:bg-[#6D7CFF]/16 text-[#5869E8] dark:text-[#A5B0FF] border-cyan-500/30';
    }
  };

  return (
    <div className="space-y-5">
      {/* Header & Optimizer Controls */}
      <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-900 dark:text-white">
            Smart Resource Allocation &amp; Multi-Warehouse Coordination
          </h1>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            13-factor depot ranking, fairness-aging priority engine, atomic reservations &amp; human approval gate
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={selectedRequestId || requests[0]?.id || ''}
            onChange={(e) => setSelectedRequestId(e.target.value)}
            className="px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs text-slate-800 dark:text-slate-200 max-w-xs"
          >
            {requests.length === 0 && <option value="">No relief requests in {mode} mode</option>}
            {requests.map((r) => (
              <option key={r.id} value={r.id}>
                [{r.priorityCategory.toUpperCase()} {r.priorityScore}] {r.locationName} ({r.status})
              </option>
            ))}
          </select>
          <label className="inline-flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300 px-2.5 py-2 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
            <input
              type="checkbox"
              checked={allowSplit}
              onChange={(e) => setAllowSplit(e.target.checked)}
              className="rounded border-slate-300 text-cyan-600"
            />
            Allow Multi-Warehouse Split
          </label>
          <button
            type="button"
            onClick={runOptimize}
            disabled={busyId === 'optimize' || requests.length === 0}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-[#5869E8] hover:bg-[#4758D6] dark:bg-[#6D7CFF] dark:hover:bg-[#8190FF] text-white text-xs font-medium disabled:opacity-50"
          >
            <Sparkles className="w-3.5 h-3.5" />
            {busyId === 'optimize' ? 'Optimizing...' : 'Optimize Allocation'}
          </button>
        </div>
      </div>

      {/* Multi-Incident Coordination KPI Strip */}
      {overview && (
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 tabular-nums">
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/80 p-3.5">
            <div className="text-[11px] font-mono uppercase text-slate-500">Avg Fulfillment</div>
            <div className="text-xl font-semibold text-slate-900 dark:text-white mt-0.5">
              {overview.allocationMetrics.avgFulfillmentPct !== null
                ? `${overview.allocationMetrics.avgFulfillmentPct}%`
                : '—'}
            </div>
            <div className="text-[11px] text-slate-500">
              {overview.allocationMetrics.totalAllocations} plan(s) · {overview.allocationMetrics.multiWarehouseSplitCount} split
            </div>
          </div>
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/80 p-3.5">
            <div className="text-[11px] font-mono uppercase text-slate-500">Fleet Availability</div>
            <div className="text-xl font-semibold text-slate-900 dark:text-white mt-0.5">
              {overview.fleetMetrics.availableVehicles} / {overview.fleetMetrics.totalVehicles}
            </div>
            <div className="text-[11px] text-slate-500">
              {overview.fleetMetrics.availableDrivers} driver(s) ready · {overview.fleetMetrics.maintenanceVehicles} in maint.
            </div>
          </div>
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/80 p-3.5">
            <div className="text-[11px] font-mono uppercase text-slate-500">Pending Approvals</div>
            <div className="text-xl font-semibold text-amber-600 dark:text-amber-400 mt-0.5">
              {overview.allocationMetrics.proposedCount + overview.dispatchMetrics.pendingApproval}
            </div>
            <div className="text-[11px] text-slate-500">
              {overview.allocationMetrics.proposedCount} alloc · {overview.dispatchMetrics.pendingApproval} dispatch
            </div>
          </div>
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/80 p-3.5">
            <div className="text-[11px] font-mono uppercase text-slate-500">Active Dispatches</div>
            <div className="text-xl font-semibold text-cyan-600 dark:text-cyan-400 mt-0.5">
              {overview.dispatchMetrics.activeDispatches}
            </div>
            <div className="text-[11px] text-slate-500">
              {overview.dispatchMetrics.enRoute} en route · {overview.dispatchMetrics.delayed} delayed
            </div>
          </div>
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/80 p-3.5">
            <div className="text-[11px] font-mono uppercase text-slate-500">Unserved High-Risk</div>
            <div className="text-xl font-semibold text-red-600 dark:text-red-400 mt-0.5">
              {overview.coordination.unservedHighPriorityIncidents.length}
            </div>
            <div className="text-[11px] text-slate-500">
              {overview.coordination.competingWarehouses.length} competing depot(s)
            </div>
          </div>
        </div>
      )}

      {/* Multi-Incident Bottleneck / Conflict Warnings */}
      {overview &&
        (overview.coordination.fleetOverloaded ||
          overview.coordination.competingWarehouses.length > 0 ||
          overview.coordination.unservedHighPriorityIncidents.length > 0) && (
          <div className="rounded-xl border border-amber-500/35 bg-amber-500/10 p-3.5 space-y-1.5 text-xs text-amber-900 dark:text-amber-200">
            <div className="font-semibold flex items-center gap-1.5">
              <AlertTriangle className="w-4 h-4 text-amber-500" />
              Multi-Incident Coordination Advisories
            </div>
            {overview.coordination.fleetOverloaded && (
              <div>• Fleet capacity saturated: 0 available vehicles remain in {mode} mode.</div>
            )}
            {overview.coordination.competingWarehouses.map((cw) => (
              <div key={cw.warehouseId}>
                • Competing demand at <strong>{cw.warehouseName}</strong> ({cw.competingAllocations} active allocations).
              </div>
            ))}
            {overview.coordination.unservedHighPriorityIncidents.slice(0, 3).map((inc) => (
              <div key={inc.incidentId}>
                • Unserved {inc.severity.toUpperCase()} incident (Risk {inc.riskScore}/100): <strong>{inc.title}</strong>.
              </div>
            ))}
          </div>
        )}

      {error && (
        <div className="p-3 rounded-lg border border-red-500/40 bg-red-500/10 text-xs text-red-600 dark:text-red-300">
          {error}
        </div>
      )}
      {notice && (
        <div className="p-3 rounded-lg border border-emerald-500/40 bg-emerald-500/10 text-xs text-emerald-700 dark:text-emerald-300">
          {notice}
        </div>
      )}

      {/* Allocation Proposals & Confirmed Allocations */}
      {allocations.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 dark:border-slate-700 p-10 text-center space-y-2">
          <Layers className="w-8 h-8 text-slate-400 mx-auto" />
          <div className="text-sm font-medium text-slate-700 dark:text-slate-200">
            No allocation plans generated yet in {mode} mode.
          </div>
          <p className="text-xs text-slate-500 max-w-md mx-auto">
            Select a relief request above and click <strong>Optimize Allocation</strong> to rank operational warehouses across stock availability, distance, travel time, accessibility, vehicle readiness, and freshness.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {allocations.map((alloc) => {
            const req = requests.find((r) => r.id === alloc.requestId);
            const isProposal = alloc.status === 'proposed';
            return (
              <div
                key={alloc.id}
                className={`rounded-xl border p-5 space-y-4 ${
                  isProposal
                    ? 'border-dashed border-amber-500/60 bg-amber-500/[0.03] dark:bg-amber-950/10'
                    : 'border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/80'
                }`}
              >
                <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-3">
                  <div className="space-y-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-[11px] text-slate-500">ALLOC-{alloc.id.slice(0, 8)}</span>
                      <span
                        className={`px-2 py-0.5 rounded text-[10px] font-mono uppercase border ${
                          isProposal
                            ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/40'
                            : alloc.status === 'rejected'
                            ? 'bg-red-500/15 text-red-600 dark:text-red-400 border-red-500/30'
                            : 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30'
                        }`}
                      >
                        {isProposal ? 'PROPOSAL — AWAITING APPROVAL' : `CONFIRMED · ${alloc.status.toUpperCase()}`}
                      </span>
                      {alloc.priorityResult && (
                        <span
                          className={`px-2 py-0.5 rounded text-[10px] font-mono uppercase border tabular-nums ${priorityBadgeClass(
                            alloc.priorityResult.band
                          )}`}
                        >
                          Priority: {alloc.priorityResult.band} ({alloc.priorityResult.score}/100)
                        </span>
                      )}
                      {alloc.splitAllocation && (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-mono uppercase bg-violet-500/15 text-violet-600 dark:text-violet-300">
                          <GitFork className="w-3 h-3" /> Multi-Warehouse Split
                        </span>
                      )}
                      {typeof alloc.fulfillmentPct === 'number' && (
                        <span className="text-[11px] font-mono text-slate-600 dark:text-slate-300 tabular-nums">
                          Coverage: <strong>{alloc.fulfillmentPct}%</strong>
                        </span>
                      )}
                    </div>
                    <h2 className="text-sm font-semibold text-slate-900 dark:text-white">
                      {req ? `Destination: ${req.locationName}` : `Request ${alloc.requestId}`}
                    </h2>
                    <p className="text-xs text-slate-600 dark:text-slate-300">{alloc.explanation}</p>
                  </div>

                  <div className="text-right text-xs font-mono text-slate-500 tabular-nums shrink-0 space-y-0.5">
                    <div>
                      Route: {alloc.totalDistanceKm} km ·{' '}
                      {alloc.estimatedDurationMin !== null ? `${alloc.estimatedDurationMin} min` : 'ETA unavailable'}
                    </div>
                    <div className="text-[10px] uppercase">
                      Provider: {alloc.routeProvider} · Confidence: {Math.round(alloc.confidence * 100)}%
                    </div>
                    {alloc.approvedBy && (
                      <div className="text-[10px] text-emerald-600 dark:text-emerald-400">
                        Approved by {alloc.approvedBy}
                      </div>
                    )}
                  </div>
                </div>

                {/* Fairness / Priority Reasoning */}
                {alloc.priorityResult && alloc.priorityResult.fairnessAgingBoost >= 1 && (
                  <div className="flex items-center gap-2 text-xs text-cyan-800 dark:text-cyan-300 bg-cyan-500/10 border border-cyan-500/25 rounded-lg px-3 py-2">
                    <Scale className="w-3.5 h-3.5 shrink-0" />
                    <span>
                      Fairness Aging Policy applied: +{alloc.priorityResult.fairnessAgingBoost} priority pts after{' '}
                      {alloc.priorityResult.waitingHours}h waiting.
                    </span>
                  </div>
                )}

                {/* Allocated Supply Lines Table */}
                <div className="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-800">
                  <table className="w-full text-xs text-left">
                    <thead className="bg-slate-50 dark:bg-slate-950/60 text-slate-500 font-mono text-[10px] uppercase">
                      <tr>
                        <th className="px-3 py-2">Source Warehouse</th>
                        <th className="px-3 py-2">Resource Item</th>
                        <th className="px-3 py-2">Allocated Qty</th>
                        <th className="px-3 py-2">Distance</th>
                        <th className="px-3 py-2">Depot Score</th>
                        <th className="px-3 py-2">Freshness / FEFO</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200 dark:divide-slate-800 tabular-nums">
                      {alloc.items.map((line, idx) => (
                        <tr key={`${line.stockId}-${idx}`}>
                          <td className="px-3 py-2 font-medium text-slate-900 dark:text-white">{line.warehouseName}</td>
                          <td className="px-3 py-2 text-slate-700 dark:text-slate-300">{line.itemName}</td>
                          <td className="px-3 py-2 font-semibold text-cyan-600 dark:text-cyan-400">
                            {line.quantity.toLocaleString()} {line.unit}
                          </td>
                          <td className="px-3 py-2 font-mono">{line.distanceKm} km</td>
                          <td className="px-3 py-2 font-mono">{line.candidateScore}/100</td>
                          <td className="px-3 py-2 text-[11px] text-slate-500">{line.expiryRiskNote || 'Standard FIFO'}</td>
                        </tr>
                      ))}
                      {alloc.items.length === 0 && (
                        <tr>
                          <td colSpan={6} className="px-3 py-4 text-center text-slate-500">
                            No available inventory could be matched across operational depots.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>

                {/* Candidate Warehouse Alternatives Comparison */}
                {alloc.alternatives && alloc.alternatives.length > 0 && (
                  <details className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-950/40 p-3 text-xs">
                    <summary className="cursor-pointer font-medium text-slate-700 dark:text-slate-200">
                      Candidate Warehouse Ranking Comparison ({alloc.alternatives.length} depots evaluated)
                    </summary>
                    <div className="mt-2.5 grid md:grid-cols-2 lg:grid-cols-3 gap-2 tabular-nums">
                      {alloc.alternatives.map((alt) => (
                        <div
                          key={alt.warehouseId}
                          className="p-2.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/70 space-y-1"
                        >
                          <div className="flex items-center justify-between font-medium text-slate-900 dark:text-white">
                            <span className="truncate pr-2">{alt.warehouseName}</span>
                            <span className="font-mono text-cyan-600 dark:text-cyan-400">{alt.score}/100</span>
                          </div>
                          <div className="text-[11px] text-slate-500">
                            {alt.distanceKm} km · {alt.fulfillableQty.toLocaleString()} units coverable ·{' '}
                            {alt.hasAvailableVehicle ? 'Vehicle Ready' : 'No Local Vehicle'}
                          </div>
                          <div className="text-[11px] text-slate-600 dark:text-slate-400">{alt.reason}</div>
                        </div>
                      ))}
                    </div>
                  </details>
                )}

                {/* Unmet Shortages & Warnings */}
                {(alloc.unmetItems.length > 0 || alloc.warnings.length > 0) && (
                  <div className="p-3 rounded-lg border border-amber-500/30 bg-amber-500/10 text-xs text-amber-800 dark:text-amber-200 space-y-1">
                    {alloc.unmetItems.map((u, i) => (
                      <div key={i} className="font-medium flex items-center gap-1.5">
                        <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                        Shortage: {u.quantity.toLocaleString()} {u.unit} of {u.itemName} unmet
                      </div>
                    ))}
                    {alloc.warnings.map((w, i) => (
                      <div key={`w-${i}`} className="text-[11px]">
                        • {w}
                      </div>
                    ))}
                  </div>
                )}

                {/* Action Bar */}
                <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-slate-200 dark:border-slate-800">
                  <div className="text-[11px] text-slate-500 max-w-md">{alloc.roadConditionsNotice}</div>
                  <div className="flex flex-wrap items-center gap-2">
                    {isProposal && (
                      <>
                        <button
                          type="button"
                          onClick={() => openEditModal(alloc)}
                          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:border-cyan-500 text-xs"
                        >
                          <Edit3 className="w-3.5 h-3.5" />
                          Edit Quantities
                        </button>
                        <button
                          type="button"
                          onClick={() => handleAction(alloc.id, 'recalculate')}
                          disabled={busyId !== null}
                          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:border-cyan-500 text-xs"
                        >
                          <RefreshCw className="w-3.5 h-3.5" />
                          Recalculate
                        </button>
                        <button
                          type="button"
                          onClick={() => handleAction(alloc.id, 'approve')}
                          disabled={busyId !== null}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium disabled:opacity-50"
                        >
                          <CheckCircle2 className="w-3.5 h-3.5" />
                          Approve Allocation
                        </button>
                        <button
                          type="button"
                          onClick={() => handleAction(alloc.id, 'reject')}
                          disabled={busyId !== null}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-red-500/40 text-red-600 dark:text-red-400 hover:bg-red-500/10 text-xs font-medium"
                        >
                          <XCircle className="w-3.5 h-3.5" />
                          Reject
                        </button>
                      </>
                    )}
                    {alloc.status === 'approved' && (
                      <button
                        type="button"
                        onClick={() => handleAction(alloc.id, 'reserve')}
                        disabled={busyId !== null}
                        className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-[#5869E8] hover:bg-[#4758D6] dark:bg-[#6D7CFF] dark:hover:bg-[#8190FF] text-white text-xs font-medium disabled:opacity-50"
                      >
                        <Lock className="w-3.5 h-3.5" />
                        Atomically Reserve Stock
                      </button>
                    )}
                    {(alloc.status === 'reserved' || alloc.status === 'approved') && (
                      <div className="flex flex-wrap items-center gap-2">
                        <select
                          value={
                            selectedVehicleByAlloc[alloc.id] ||
                            alloc.recommendedVehicleId ||
                            availableVehicles[0]?.id ||
                            ''
                          }
                          onChange={(e) =>
                            setSelectedVehicleByAlloc((prev) => ({ ...prev, [alloc.id]: e.target.value }))
                          }
                          className="px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-xs text-slate-800 dark:text-slate-200"
                        >
                          {availableVehicles.length === 0 && <option value="">No Available Vehicles</option>}
                          {availableVehicles.map((v) => (
                            <option key={v.id} value={v.id}>
                              {v.callsign} ({v.capacityUnits} units)
                            </option>
                          ))}
                        </select>
                        <button
                          type="button"
                          onClick={() => createPendingDispatch(alloc)}
                          disabled={busyId !== null || availableVehicles.length === 0}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-violet-600 hover:bg-violet-500 text-white text-xs font-medium disabled:opacity-50"
                        >
                          <Truck className="w-3.5 h-3.5" />
                          Queue Dispatch for Approval
                        </button>
                      </div>
                    )}
                    <button
                      type="button"
                      onClick={() => runAiLogisticsAssist(alloc.id)}
                      disabled={aiBusy}
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-cyan-500/40 text-cyan-700 dark:text-cyan-300 hover:bg-cyan-500/10 text-xs"
                    >
                      <Bot className="w-3.5 h-3.5" />
                      AI Explain
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* AI Logistics Assistant Advisory Panel */}
      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/80 p-5 space-y-3">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
          <div>
            <div className="text-sm font-semibold text-slate-900 dark:text-white flex items-center gap-2">
              <Bot className="w-4 h-4 text-cyan-500" />
              AI Logistics Decision-Support Assistant
              <span className="text-[10px] font-mono uppercase px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-500">
                Advisory Only · No Auto-Dispatch
              </span>
            </div>
            <p className="text-xs text-slate-500">
              Grounded strictly in persisted warehouses, allocations, fleet status, and reported hazards.
            </p>
          </div>
          <div className="flex items-center gap-2 w-full sm:w-auto">
            <input
              type="text"
              value={aiQuestion}
              onChange={(e) => setAiQuestion(e.target.value)}
              placeholder="Ask about split trade-offs, route risks, or shortages..."
              className="flex-1 sm:w-72 px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-xs text-slate-900 dark:text-slate-100"
            />
            <button
              type="button"
              onClick={() => runAiLogisticsAssist()}
              disabled={aiBusy}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#5869E8] hover:bg-[#4758D6] dark:bg-[#6D7CFF] dark:hover:bg-[#8190FF] text-white text-xs font-medium disabled:opacity-50"
            >
              <Send className="w-3.5 h-3.5" />
              {aiBusy ? 'Analyzing...' : 'Consult AI'}
            </button>
          </div>
        </div>

        {aiError && (
          <div className="p-3 rounded-lg border border-amber-500/40 bg-amber-500/10 text-xs text-amber-800 dark:text-amber-300">
            {aiError}
          </div>
        )}

        {advisory && (
          <div className="rounded-lg border border-cyan-500/30 bg-cyan-500/[0.04] p-4 space-y-3 text-xs">
            <div className="flex items-center justify-between gap-2">
              <div className="font-semibold text-slate-900 dark:text-white">{advisory.summary}</div>
              <span className="font-mono text-[10px] text-slate-500 shrink-0">
                {advisory.model_used} · {advisory.confidence !== null ? `${Math.round(advisory.confidence * 100)}% conf` : 'unrated'}
              </span>
            </div>
            <div className="p-2.5 rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
              <div className="text-[10px] font-mono uppercase text-cyan-600 dark:text-cyan-400">Recommended Next Step (Human Approval Required)</div>
              <div className="text-slate-800 dark:text-slate-200 mt-0.5">{advisory.recommended_action}</div>
            </div>
            <div className="text-slate-700 dark:text-slate-300">{advisory.allocation_explanation}</div>
            <div className="grid md:grid-cols-2 gap-3">
              {advisory.warehouse_comparison.length > 0 && (
                <div>
                  <div className="font-mono text-[10px] uppercase text-slate-500 mb-1">Warehouse Comparison</div>
                  <ul className="space-y-1 text-slate-700 dark:text-slate-300">
                    {advisory.warehouse_comparison.map((c, idx) => (
                      <li key={idx}>• {c}</li>
                    ))}
                  </ul>
                </div>
              )}
              {advisory.risks.length > 0 && (
                <div>
                  <div className="font-mono text-[10px] uppercase text-red-500 mb-1">Identified Risks</div>
                  <ul className="space-y-1 text-slate-700 dark:text-slate-300">
                    {advisory.risks.map((r, idx) => (
                      <li key={idx}>• {r}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
            {advisory.missing_data.length > 0 && (
              <div className="text-[11px] text-amber-700 dark:text-amber-300">
                <strong>Missing / Unverified Data:</strong> {advisory.missing_data.join(' · ')}
              </div>
            )}
            <div className="text-[10px] font-mono text-slate-500">
              Evidence: {advisory.evidence_references.join(', ')}
            </div>
          </div>
        )}
      </div>

      {/* Inline Edit Allocation Modal */}
      {editingAlloc && (
        <div className="fixed inset-0 z-50 bg-slate-950/60 flex items-center justify-center p-4">
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl max-w-lg w-full p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-900 dark:text-white">
                Edit Allocation Proposal ({editingAlloc.id.slice(0, 8)})
              </h3>
              <button
                type="button"
                onClick={() => setEditingAlloc(null)}
                className="text-xs text-slate-500 hover:text-slate-800 dark:hover:text-slate-200"
              >
                Close
              </button>
            </div>
            <div className="space-y-2.5 max-h-64 overflow-y-auto">
              {editingAlloc.items.map((item) => (
                <div
                  key={item.stockId}
                  className="flex items-center justify-between gap-3 p-2.5 rounded-lg border border-slate-200 dark:border-slate-800 text-xs"
                >
                  <div>
                    <div className="font-medium text-slate-900 dark:text-white">{item.itemName}</div>
                    <div className="text-[11px] text-slate-500">{item.warehouseName}</div>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <input
                      type="number"
                      min={0}
                      value={editQuantities[item.stockId] ?? item.quantity}
                      onChange={(e) =>
                        setEditQuantities((prev) => ({ ...prev, [item.stockId]: Number(e.target.value) }))
                      }
                      className="w-24 px-2 py-1 rounded border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-right tabular-nums"
                    />
                    <span className="text-slate-500">{item.unit}</span>
                  </div>
                </div>
              ))}
            </div>
            <input
              type="text"
              value={editNote}
              onChange={(e) => setEditNote(e.target.value)}
              placeholder="Reason for manual allocation adjustment..."
              className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-xs"
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setEditingAlloc(null)}
                className="px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 text-xs"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={saveAllocationEdit}
                disabled={busyId !== null}
                className="px-3.5 py-1.5 rounded-lg bg-[#5869E8] hover:bg-[#4758D6] dark:bg-[#6D7CFF] dark:hover:bg-[#8190FF] text-white text-xs font-medium"
              >
                Save Adjustments
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
