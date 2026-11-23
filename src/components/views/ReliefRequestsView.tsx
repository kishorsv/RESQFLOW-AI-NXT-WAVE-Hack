import React, { useCallback, useEffect, useState } from 'react';
import { ArrowRight, Calculator, CheckCircle2, Edit3, Plus, Warehouse as WarehouseIcon, X } from 'lucide-react';
import { apiRequest } from '../../lib/api';
import type {
  DataMode,
  Incident,
  ReliefRequest,
  ResourceCategory,
  Severity,
  WarehouseMatchRecommendation,
} from '../../shared/types';

interface ReliefRequestsViewProps {
  mode: DataMode;
  requests: ReliefRequest[];
  incidents: Incident[];
  onRefresh: () => void;
  onNavigate: (view: string) => void;
}

const CATEGORIES: ResourceCategory[] = [
  'drinking_water',
  'food',
  'medical_kits',
  'medicines',
  'shelter',
  'blankets',
  'hygiene_kits',
  'rescue_equipment',
  'power_equipment',
  'fuel',
  'communication_equipment',
];

export const ReliefRequestsView: React.FC<ReliefRequestsViewProps> = ({
  mode,
  requests,
  incidents,
  onRefresh,
  onNavigate,
}) => {
  const [showCreate, setShowCreate] = useState(false);
  const [overrideTarget, setOverrideTarget] = useState<ReliefRequest | null>(null);
  const [overrideCategory, setOverrideCategory] = useState<Severity>('critical');
  const [overrideReason, setOverrideReason] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const [demandSummary, setDemandSummary] = useState<{
    totalDemand: number;
    totalAvailableStock: number;
    totalReservedStock: number;
    totalShortage: number;
    fulfillmentPercentage: number;
    criticalUnmetDemand: number;
  } | null>(null);
  const [matchesByReq, setMatchesByReq] = useState<Record<string, WarehouseMatchRecommendation[]>>({});

  const loadDemandSummary = useCallback(async () => {
    try {
      const data = await apiRequest<{
        totalDemand: number;
        totalAvailableStock: number;
        totalReservedStock: number;
        totalShortage: number;
        fulfillmentPercentage: number;
        criticalUnmetDemand: number;
      }>(`/relief-requests/demand-summary?mode=${mode}`);
      setDemandSummary(data);
    } catch {
      // ignore
    }
  }, [mode]);

  useEffect(() => {
    loadDemandSummary();
  }, [loadDemandSummary, requests.length]);

  const [form, setForm] = useState({
    incidentId: incidents[0]?.id || '',
    requesterName: '',
    contact: '+91-98400-00112',
    locationName: '',
    lat: incidents[0]?.lat ?? 12.9784,
    lng: incidents[0]?.lng ?? 80.2186,
    peopleAffected: 400,
    familiesAffected: 95,
    vulnerableGroups: 'elderly, infants',
    urgency: 'high' as Severity,
    category: 'drinking_water' as ResourceCategory,
    itemName: 'Potable Drinking Water Packs (20L)',
    quantity: 500,
    unit: 'packs',
    notes: '',
  });

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy('create');
    setMsg(null);
    try {
      await apiRequest('/relief-requests', {
        method: 'POST',
        body: {
          incidentId: form.incidentId || incidents[0]?.id || 'unlinked',
          requesterName: form.requesterName,
          contact: form.contact,
          locationName: form.locationName,
          lat: form.lat,
          lng: form.lng,
          peopleAffected: form.peopleAffected,
          familiesAffected: form.familiesAffected,
          vulnerableGroups: form.vulnerableGroups
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
          urgency: form.urgency,
          items: [
            {
              category: form.category,
              itemName: form.itemName,
              quantity: form.quantity,
              unit: form.unit,
            },
          ],
          notes: form.notes,
          mode,
        },
      });
      setShowCreate(false);
      setMsg({ type: 'ok', text: 'Relief request submitted and scored via transparent priority engine.' });
      onRefresh();
    } catch (err) {
      setMsg({ type: 'err', text: err instanceof Error ? err.message : 'Failed to create request' });
    } finally {
      setBusy(null);
    }
  };

  const handleOverride = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!overrideTarget) return;
    setBusy(overrideTarget.id);
    setMsg(null);
    try {
      await apiRequest(`/relief-requests/${overrideTarget.id}/override-priority`, {
        method: 'POST',
        body: { newCategory: overrideCategory, reason: overrideReason },
      });
      setOverrideTarget(null);
      setOverrideReason('');
      setMsg({ type: 'ok', text: 'Human commander priority override logged to immutable audit trail.' });
      onRefresh();
    } catch (err) {
      setMsg({ type: 'err', text: err instanceof Error ? err.message : 'Override failed' });
    } finally {
      setBusy(null);
    }
  };

  const handleVerifyRequest = async (requestId: string) => {
    setBusy(requestId);
    setMsg(null);
    try {
      await apiRequest(`/relief-requests/${requestId}/verify`, { method: 'POST' });
      setMsg({ type: 'ok', text: 'Relief request verified.' });
      onRefresh();
    } catch (err) {
      setMsg({ type: 'err', text: err instanceof Error ? err.message : 'Verification failed' });
    } finally {
      setBusy(null);
    }
  };

  const handleMatchWarehouses = async (requestId: string) => {
    setBusy(requestId);
    setMsg(null);
    try {
      const res = await apiRequest<{ warehouseMatches: WarehouseMatchRecommendation[] }>(
        `/relief-requests/${requestId}`
      );
      setMatchesByReq((prev) => ({ ...prev, [requestId]: res.warehouseMatches }));
    } catch (err) {
      setMsg({ type: 'err', text: err instanceof Error ? err.message : 'Warehouse matching failed' });
    } finally {
      setBusy(null);
    }
  };

  const handleRecommendAllocation = async (requestId: string) => {
    setBusy(requestId);
    setMsg(null);
    try {
      await apiRequest(`/relief-requests/${requestId}/allocate`, {
        method: 'POST',
      });
      setMsg({ type: 'ok', text: 'Multi-warehouse allocation recommendation generated. Opening Allocation Center...' });
      onRefresh();
      onNavigate('allocations');
    } catch (err) {
      setMsg({ type: 'err', text: err instanceof Error ? err.message : 'Allocation recommendation failed' });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-900 dark:text-white">
            Relief Requests &amp; Transparent Priority Engine
          </h1>
          <p className="text-xs text-slate-500 dark:text-slate-400 font-mono">
            Formula: P = 0.30S + 0.25N + 0.20V + 0.15U + 0.10A · Commander override preserves original algorithmic score
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowCreate(true)}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#5869E8] hover:bg-[#4758D6] dark:bg-[#6D7CFF] dark:hover:bg-[#8190FF] text-white text-sm font-medium"
        >
          <Plus className="w-4 h-4" />
          New Relief Request
        </button>
      </div>

      {msg && (
        <div
          className={`px-4 py-2.5 rounded-lg border text-xs flex items-center justify-between ${
            msg.type === 'ok'
              ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
              : 'border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300'
          }`}
        >
          <span>{msg.text}</span>
          <button type="button" onClick={() => setMsg(null)}>
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Phase 4 Emergency Demand vs. Supply Intelligence Strip */}
      {demandSummary && (
        <div className="grid grid-cols-2 md:grid-cols-6 gap-3 text-xs tabular-nums">
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/80 p-3">
            <div className="text-slate-500">Total Demand</div>
            <div className="text-lg font-bold font-mono text-slate-900 dark:text-white">
              {demandSummary.totalDemand.toLocaleString()}
            </div>
          </div>
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/80 p-3">
            <div className="text-slate-500">Available Stock</div>
            <div className="text-lg font-bold font-mono text-emerald-600 dark:text-emerald-400">
              {demandSummary.totalAvailableStock.toLocaleString()}
            </div>
          </div>
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/80 p-3">
            <div className="text-slate-500">Reserved Stock</div>
            <div className="text-lg font-bold font-mono text-cyan-600 dark:text-cyan-400">
              {demandSummary.totalReservedStock.toLocaleString()}
            </div>
          </div>
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/80 p-3">
            <div className="text-slate-500">Total Shortage</div>
            <div className="text-lg font-bold font-mono text-red-600 dark:text-red-400">
              {demandSummary.totalShortage.toLocaleString()}
            </div>
          </div>
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/80 p-3">
            <div className="text-slate-500">Critical Unmet</div>
            <div className="text-lg font-bold font-mono text-orange-600 dark:text-orange-400">
              {demandSummary.criticalUnmetDemand.toLocaleString()}
            </div>
          </div>
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/80 p-3">
            <div className="text-slate-500">Fulfillment Rate</div>
            <div className="text-lg font-bold font-mono text-slate-900 dark:text-white">
              {demandSummary.fulfillmentPercentage}%
            </div>
          </div>
        </div>
      )}

      <div className="space-y-4">
        {requests.map((req) => (
          <div
            key={req.id}
            className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/80 p-5 space-y-4"
          >
            <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-3">
              <div className="space-y-1">
                <div className="text-xs font-mono text-slate-500">
                  {req.status.toUpperCase()} · Priority{' '}
                  <span
                    className={
                      req.priorityCategory === 'critical'
                        ? 'text-red-500 font-semibold'
                        : req.priorityCategory === 'high'
                        ? 'text-orange-500 font-semibold'
                        : 'text-amber-500 font-semibold'
                    }
                  >
                    {req.priorityCategory.toUpperCase()} ({req.priorityScore}/100)
                  </span>{' '}
                  · {req.peopleAffected.toLocaleString()} people · {req.requesterName} ({req.contactMasked})
                </div>
                <h2 className="text-base font-semibold text-slate-900 dark:text-white">{req.locationName}</h2>
                {req.vulnerableGroups.length > 0 && (
                  <div className="text-xs text-slate-500 dark:text-slate-400">
                    Vulnerable groups: {req.vulnerableGroups.join(', ')}
                  </div>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {req.verificationStatus !== 'verified' && (
                  <button
                    type="button"
                    disabled={busy === req.id}
                    onClick={() => handleVerifyRequest(req.id)}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-emerald-500/50 text-xs font-medium text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/10"
                  >
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    Verify
                  </button>
                )}
                <button
                  type="button"
                  disabled={busy === req.id}
                  onClick={() => handleMatchWarehouses(req.id)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-cyan-500/40 text-xs font-medium text-cyan-700 dark:text-cyan-300 hover:bg-cyan-500/10"
                >
                  <WarehouseIcon className="w-3.5 h-3.5" />
                  Match Warehouses
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setOverrideTarget(req);
                    setOverrideCategory(req.priorityCategory);
                  }}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
                >
                  <Edit3 className="w-3.5 h-3.5" />
                  Commander Override
                </button>
                <button
                  type="button"
                  disabled={busy === req.id}
                  onClick={() => handleRecommendAllocation(req.id)}
                  className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-[#5869E8] hover:bg-[#4758D6] dark:bg-[#6D7CFF] dark:hover:bg-[#8190FF] text-white text-xs font-medium disabled:opacity-60"
                >
                  Generate Allocation Plan
                  <ArrowRight className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            {/* Requested Supplies */}
            <div className="grid sm:grid-cols-3 gap-2.5 text-xs">
              {req.items.map((it, idx) => (
                <div
                  key={idx}
                  className="p-3 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/60 flex items-center justify-between"
                >
                  <div>
                    <div className="font-medium text-slate-900 dark:text-slate-100">{it.itemName}</div>
                    <div className="text-[11px] text-slate-500">{it.category.replace(/_/g, ' ')}</div>
                  </div>
                  <div className="font-mono font-semibold text-slate-900 dark:text-white tabular-nums">
                    {it.fulfilledQuantity}/{it.quantity} {it.unit}
                  </div>
                </div>
              ))}
            </div>

            {/* Transparent Priority Formula Breakdown */}
            <div className="rounded-lg bg-slate-50 dark:bg-slate-950/60 border border-slate-200 dark:border-slate-800 p-3 text-xs space-y-1.5">
              <div className="flex items-center gap-1.5 font-medium text-slate-700 dark:text-slate-300">
                <Calculator className="w-3.5 h-3.5 text-cyan-500" />
                Transparent Priority Breakdown ({req.priorityBreakdown.calculationVersion})
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 font-mono text-[11px] text-slate-600 dark:text-slate-400 tabular-nums">
                <div>Severity (S): {req.priorityBreakdown.severityScore}</div>
                <div>Need (N): {req.priorityBreakdown.needScore}</div>
                <div>Vulnerability (V): {req.priorityBreakdown.vulnerabilityScore}</div>
                <div>Urgency (U): {req.priorityBreakdown.urgencyScore}</div>
                <div>Access (A): {req.priorityBreakdown.accessScore}</div>
              </div>
              {req.priorityBreakdown.override && (
                <div className="text-amber-600 dark:text-amber-400 pt-1">
                  Human Override by {req.priorityBreakdown.override.userId}:{' '}
                  {req.priorityBreakdown.override.previousCategory.toUpperCase()} →{' '}
                  {req.priorityBreakdown.override.newCategory.toUpperCase()} — &ldquo;
                  {req.priorityBreakdown.override.reason}&rdquo; (Algorithmic score preserved:{' '}
                  {req.priorityBreakdown.algorithmicScore}/100)
                </div>
              )}
            </div>

            {/* Phase 4 Intelligent Warehouse Matching Output */}
            {matchesByReq[req.id] && (
              <div className="rounded-lg border border-cyan-500/30 bg-cyan-500/5 p-3 text-xs space-y-2">
                <div className="flex items-center justify-between">
                  <div className="font-semibold text-cyan-700 dark:text-cyan-300">
                    Intelligent Warehouse Selection ({matchesByReq[req.id].length} operational candidate match(es))
                  </div>
                  <button
                    type="button"
                    onClick={() => onNavigate('inventory')}
                    className="text-[11px] underline text-cyan-600 dark:text-cyan-400"
                  >
                    Open Reservations
                  </button>
                </div>
                {matchesByReq[req.id].length === 0 ? (
                  <div className="text-slate-500">
                    No operational warehouses currently hold available stock matching this request.
                  </div>
                ) : (
                  <div className="space-y-1.5 tabular-nums">
                    {matchesByReq[req.id].slice(0, 6).map((m, idx) => (
                      <div
                        key={`${m.warehouseId}-${m.category}-${idx}`}
                        className="p-2 rounded bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1"
                      >
                        <div>
                          <div className="font-medium text-slate-900 dark:text-white">
                            {m.warehouseName} · {m.resourceName}
                          </div>
                          <div className="text-[11px] text-slate-500">{m.reason}</div>
                        </div>
                        <div className="font-mono text-[11px] text-right shrink-0">
                          <span className="text-emerald-600 dark:text-emerald-400 font-semibold">
                            Fulfillable {m.fulfillableQty}/{m.requestedQty}
                          </span>
                          {m.shortageQty > 0 && (
                            <span className="text-red-500"> · Shortage {m.shortageQty}</span>
                          )}
                          <span className="text-slate-400"> · Score {m.score}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
        {requests.length === 0 && (
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 p-10 text-center text-sm text-slate-500">
            No relief requests in {mode.toUpperCase()} mode.
          </div>
        )}
      </div>

      {/* Create Request Modal */}
      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/75 p-4">
          <form
            onSubmit={handleCreate}
            className="w-full max-w-xl rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-2xl overflow-hidden"
          >
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200 dark:border-slate-800">
              <h3 className="text-base font-semibold text-slate-900 dark:text-white">Submit Relief Request</h3>
              <button type="button" onClick={() => setShowCreate(false)}>
                <X className="w-4 h-4 text-slate-400" />
              </button>
            </div>
            <div className="p-5 grid sm:grid-cols-2 gap-3 text-xs max-h-[75vh] overflow-y-auto">
              <div className="sm:col-span-2">
                <label className="block text-slate-500 mb-1">Linked Incident</label>
                <select
                  value={form.incidentId}
                  onChange={(e) => {
                    const inc = incidents.find((i) => i.id === e.target.value);
                    setForm({
                      ...form,
                      incidentId: e.target.value,
                      lat: inc?.lat ?? form.lat,
                      lng: inc?.lng ?? form.lng,
                    });
                  }}
                  className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-white"
                >
                  {incidents.map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.title}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-slate-500 mb-1">Shelter / Site Location</label>
                <input
                  required
                  value={form.locationName}
                  onChange={(e) => setForm({ ...form, locationName: e.target.value })}
                  placeholder="e.g., Tambaram Community Relief Camp"
                  className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-white"
                />
              </div>
              <div>
                <label className="block text-slate-500 mb-1">Requester Name</label>
                <input
                  required
                  value={form.requesterName}
                  onChange={(e) => setForm({ ...form, requesterName: e.target.value })}
                  placeholder="Camp Coordinator Name"
                  className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-white"
                />
              </div>
              <div>
                <label className="block text-slate-500 mb-1">People Affected</label>
                <input
                  type="number"
                  min={1}
                  required
                  value={form.peopleAffected}
                  onChange={(e) => setForm({ ...form, peopleAffected: Number(e.target.value) })}
                  className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-white"
                />
              </div>
              <div>
                <label className="block text-slate-500 mb-1">Urgency</label>
                <select
                  value={form.urgency}
                  onChange={(e) => setForm({ ...form, urgency: e.target.value as Severity })}
                  className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-white"
                >
                  {(['low', 'medium', 'high', 'critical'] as Severity[]).map((u) => (
                    <option key={u} value={u}>
                      {u.toUpperCase()}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-slate-500 mb-1">Resource Category</label>
                <select
                  value={form.category}
                  onChange={(e) => setForm({ ...form, category: e.target.value as ResourceCategory })}
                  className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-white"
                >
                  {CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {c.replace(/_/g, ' ')}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-slate-500 mb-1">Item Name</label>
                <input
                  required
                  value={form.itemName}
                  onChange={(e) => setForm({ ...form, itemName: e.target.value })}
                  className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-white"
                />
              </div>
              <div>
                <label className="block text-slate-500 mb-1">Quantity</label>
                <input
                  type="number"
                  min={1}
                  required
                  value={form.quantity}
                  onChange={(e) => setForm({ ...form, quantity: Number(e.target.value) })}
                  className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-white"
                />
              </div>
              <div>
                <label className="block text-slate-500 mb-1">Vulnerable Groups (comma separated)</label>
                <input
                  value={form.vulnerableGroups}
                  onChange={(e) => setForm({ ...form, vulnerableGroups: e.target.value })}
                  className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-white"
                />
              </div>
            </div>
            <div className="flex justify-end gap-2 px-5 py-3.5 bg-slate-50 dark:bg-slate-950/60 border-t border-slate-200 dark:border-slate-800">
              <button
                type="button"
                onClick={() => setShowCreate(false)}
                className="px-3.5 py-2 rounded-lg text-xs border border-slate-300 dark:border-slate-700 text-slate-600 dark:text-slate-300"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={busy === 'create'}
                className="px-4 py-2 rounded-lg text-xs font-medium bg-[#5869E8] hover:bg-[#4758D6] dark:bg-[#6D7CFF] dark:hover:bg-[#8190FF] text-white"
              >
                {busy === 'create' ? 'Submitting...' : 'Submit & Score Request'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Priority Override Modal */}
      {overrideTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/75 p-4">
          <form
            onSubmit={handleOverride}
            className="w-full max-w-md rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-2xl overflow-hidden"
          >
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200 dark:border-slate-800">
              <h3 className="text-base font-semibold text-slate-900 dark:text-white">Commander Priority Override</h3>
              <button type="button" onClick={() => setOverrideTarget(null)}>
                <X className="w-4 h-4 text-slate-400" />
              </button>
            </div>
            <div className="p-5 space-y-3 text-xs">
              <p className="text-slate-600 dark:text-slate-300">
                Original algorithmic score ({overrideTarget.priorityBreakdown.algorithmicScore}/100) will remain preserved in the audit ledger.
              </p>
              <div>
                <label className="block text-slate-500 mb-1">New Priority Category</label>
                <select
                  value={overrideCategory}
                  onChange={(e) => setOverrideCategory(e.target.value as Severity)}
                  className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-white"
                >
                  {(['critical', 'high', 'medium', 'low'] as Severity[]).map((s) => (
                    <option key={s} value={s}>
                      {s.toUpperCase()}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-slate-500 mb-1">Mandatory Justification Reason</label>
                <textarea
                  required
                  minLength={5}
                  rows={3}
                  value={overrideReason}
                  onChange={(e) => setOverrideReason(e.target.value)}
                  placeholder="Explain operational field justification for overriding priority..."
                  className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-white"
                />
              </div>
            </div>
            <div className="flex justify-end gap-2 px-5 py-3.5 bg-slate-50 dark:bg-slate-950/60 border-t border-slate-200 dark:border-slate-800">
              <button
                type="button"
                onClick={() => setOverrideTarget(null)}
                className="px-3.5 py-2 rounded-lg text-xs border border-slate-300 dark:border-slate-700 text-slate-600 dark:text-slate-300"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={busy === overrideTarget.id}
                className="px-4 py-2 rounded-lg text-xs font-medium bg-amber-600 hover:bg-amber-500 text-white"
              >
                Confirm Override
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};
