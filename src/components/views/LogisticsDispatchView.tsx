import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardCheck,
  Clock,
  Filter,
  MapPin,
  Navigation,
  PackageCheck,
  Plus,
  Route as RouteIcon,
  ShieldAlert,
  Truck,
  UserCheck,
  Users,
  Wrench,
  XCircle,
} from 'lucide-react';
import { apiRequest } from '../../lib/api';
import type {
  Allocation,
  DataMode,
  DeliveryConfirmation,
  Dispatch,
  DispatchPlan,
  Driver,
  DriverStatus,
  Incident,
  ReliefRequest,
  RouteHazardReport,
  RouteResult,
  Severity,
  Vehicle,
  VehicleStatus,
  VehicleType,
  Warehouse,
} from '../../shared/types';

interface LogisticsDispatchViewProps {
  mode: DataMode;
  initialTab: 'routes' | 'vehicles' | 'dispatches';
  warehouses: Warehouse[];
  incidents: Incident[];
  requests?: ReliefRequest[];
  allocations?: Allocation[];
  vehicles: Vehicle[];
  dispatches: Dispatch[];
  onRefresh: () => void;
}

type ActiveTab = 'dispatches' | 'planner' | 'routes' | 'vehicles' | 'drivers';

const VEHICLE_TYPES: { value: VehicleType; label: string }[] = [
  { value: 'heavy_truck', label: 'Heavy Relief Truck' },
  { value: 'relief_truck', label: 'Relief Truck' },
  { value: 'cargo_truck', label: 'Cargo Truck' },
  { value: 'light_van', label: 'Light Van' },
  { value: 'ambulance', label: 'Ambulance / Medical' },
  { value: 'pickup', label: 'Pickup Truck' },
  { value: 'rescue_vehicle', label: 'Rescue Vehicle' },
  { value: 'water_tanker', label: 'Water Tanker' },
  { value: 'bus', label: 'Evacuation Bus' },
  { value: 'utility_vehicle', label: 'Utility Vehicle' },
  { value: '4x4_utility', label: '4x4 Utility' },
  { value: 'motorcycle', label: 'Motorcycle Scout' },
  { value: 'boat', label: 'Boat' },
  { value: 'rescue_boat', label: 'Rescue Boat' },
  { value: 'helicopter', label: 'Helicopter' },
  { value: 'other', label: 'Other' },
];

export const LogisticsDispatchView: React.FC<LogisticsDispatchViewProps> = ({
  mode,
  initialTab,
  warehouses,
  incidents,
  requests = [],
  vehicles,
  dispatches,
  onRefresh,
}) => {
  const [tab, setTab] = useState<ActiveTab>(initialTab);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Additional Phase 5 state loaded from backend
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [hazards, setHazards] = useState<RouteHazardReport[]>([]);
  const [deliveries, setDeliveries] = useState<DeliveryConfirmation[]>([]);

  // Dispatch Filters
  const [statusFilter, setStatusFilter] = useState('all');
  const [priorityFilter, setPriorityFilter] = useState('all');
  const [riskFilter, setRiskFilter] = useState('all');

  // Dispatch Planner state
  const [planReqId, setPlanReqId] = useState(requests[0]?.id || '');
  const [planWhId, setPlanWhId] = useState('');
  const [planVehId, setPlanVehId] = useState('');
  const [planDrvId, setPlanDrvId] = useState('');
  const [activePlan, setActivePlan] = useState<DispatchPlan | null>(null);

  // Delivery Confirmation Modal state
  const [deliveryModalDispatch, setDeliveryModalDispatch] = useState<Dispatch | null>(null);
  const [recipientName, setRecipientName] = useState('');
  const [recipientOrg, setRecipientOrg] = useState('');
  const [deliveryNotes, setDeliveryNotes] = useState('');
  const [deliveryItemQty, setDeliveryItemQty] = useState<Record<string, { delivered: number; damaged: number }>>({});

  // Route Optimizer & Hazard Reporting state
  const [originId, setOriginId] = useState(warehouses[0]?.id || '');
  const [destId, setDestId] = useState(incidents[0]?.id || '');
  const [routeResult, setRouteResult] = useState<RouteResult | null>(null);
  const [routeNotice, setRouteNotice] = useState<string | null>(null);
  const [hazardForm, setHazardForm] = useState({
    type: 'flood' as RouteHazardReport['type'],
    severity: 'high' as Severity,
    lat: String(incidents[0]?.lat ?? 12.9784),
    lng: String(incidents[0]?.lng ?? 80.2186),
    radiusKm: '1.5',
    description: '',
  });

  // Vehicle Registration state
  const [vehForm, setVehForm] = useState({
    callsign: '',
    registrationNumber: '',
    vehicleType: 'heavy_truck' as VehicleType,
    warehouseId: warehouses[0]?.id || '',
    capacityKg: '5000',
    capacityUnits: '1500',
    driverTeam: '',
    fuelPct: '90',
    equipment: 'VHF Radio, First-Aid Kit',
  });

  // Driver Registration state
  const [drvForm, setDrvForm] = useState({
    name: '',
    contact: '',
    certifications: 'Heavy Commercial, Emergency Response',
  });

  const loadPhase5Lists = useCallback(async () => {
    try {
      const [drvRes, hazRes, delRes] = await Promise.all([
        apiRequest<{ drivers: Driver[] }>(`/drivers?mode=${mode}`),
        apiRequest<{ hazards: RouteHazardReport[] }>(`/routes/hazards?mode=${mode}`),
        apiRequest<{ deliveries: DeliveryConfirmation[] }>(`/deliveries?mode=${mode}`),
      ]);
      setDrivers(drvRes.drivers);
      setHazards(hazRes.hazards);
      setDeliveries(delRes.deliveries);
    } catch {
      // handled gracefully
    }
  }, [mode]);

  useEffect(() => {
    setTab(initialTab);
  }, [initialTab]);

  useEffect(() => {
    loadPhase5Lists();
  }, [loadPhase5Lists, dispatches.length, vehicles.length]);

  useEffect(() => {
    if (!planReqId && requests.length > 0) setPlanReqId(requests[0].id);
    if (!originId && warehouses.length > 0) setOriginId(warehouses[0].id);
    if (!destId && incidents.length > 0) setDestId(incidents[0].id);
    if (!vehForm.warehouseId && warehouses.length > 0) {
      setVehForm((f) => ({ ...f, warehouseId: warehouses[0].id }));
    }
  }, [requests, warehouses, incidents, planReqId, originId, destId, vehForm.warehouseId]);

  const filteredDispatches = useMemo(() => {
    return dispatches.filter((d) => {
      if (statusFilter !== 'all' && d.status !== statusFilter) return false;
      if (priorityFilter !== 'all' && d.priorityLevel !== priorityFilter) return false;
      if (riskFilter !== 'all' && (d.routeRisk?.riskBand || 'UNKNOWN') !== riskFilter) return false;
      return true;
    });
  }, [dispatches, statusFilter, priorityFilter, riskFilter]);

  // --- Dispatch Planner ---
  const generatePlan = async () => {
    if (!planReqId) {
      setError('Select a relief request to generate a dispatch plan.');
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await apiRequest<{ plan: DispatchPlan }>('/dispatches/plan', {
        method: 'POST',
        body: JSON.stringify({
          requestId: planReqId,
          warehouseId: planWhId || undefined,
          vehicleId: planVehId || undefined,
          driverId: planDrvId || undefined,
        }),
      });
      setActivePlan(res.plan);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to build dispatch plan');
    } finally {
      setBusy(false);
    }
  };

  const submitPlanForApproval = async () => {
    if (!activePlan || !activePlan.allocationId || !activePlan.vehicleId) {
      setError('A valid allocation and available vehicle are required before submitting a dispatch.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await apiRequest('/dispatches', {
        method: 'POST',
        body: JSON.stringify({
          allocationId: activePlan.allocationId,
          vehicleId: activePlan.vehicleId,
          driverId: activePlan.driverId,
          warehouseId: activePlan.warehouseId,
          deliveryDeadline: activePlan.deliveryDeadline,
          requireApproval: true,
          note: 'Submitted from Dispatch Planner — awaiting commander approval',
        }),
      });
      setActivePlan(null);
      setNotice('Dispatch created in PENDING_APPROVAL state. Authorized commander approval is required before loading.');
      setTab('dispatches');
      onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to submit dispatch');
    } finally {
      setBusy(false);
    }
  };

  // --- Dispatch Lifecycle Actions ---
  const invokeDispatchAction = async (
    dispatchId: string,
    endpoint: 'approve' | 'reject' | 'load' | 'depart' | 'arrive' | 'cancel',
    body: Record<string, unknown> = {}
  ) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await apiRequest(`/dispatches/${dispatchId}/${endpoint}`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      setNotice(`Dispatch action '${endpoint}' succeeded.`);
      onRefresh();
      loadPhase5Lists();
    } catch (err) {
      setError(err instanceof Error ? err.message : `Dispatch action '${endpoint}' failed`);
    } finally {
      setBusy(false);
    }
  };

  const openDeliveryModal = (d: Dispatch) => {
    const qtyMap: Record<string, { delivered: number; damaged: number }> = {};
    for (const item of d.items || []) {
      qtyMap[item.stockId] = { delivered: item.quantity, damaged: 0 };
    }
    setDeliveryItemQty(qtyMap);
    setRecipientName('');
    setRecipientOrg(d.destinationName);
    setDeliveryNotes('');
    setDeliveryModalDispatch(d);
  };

  const submitDeliveryConfirmation = async () => {
    if (!deliveryModalDispatch) return;
    if (recipientName.trim().length < 2) {
      setError('Recipient name is required to confirm delivery.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const items = Object.entries(deliveryItemQty).map(([stockId, v]) => ({
        stockId,
        deliveredQty: Math.max(0, Math.floor(v.delivered)),
        damagedQty: Math.max(0, Math.floor(v.damaged)),
      }));
      await apiRequest(`/dispatches/${deliveryModalDispatch.id}/deliver`, {
        method: 'POST',
        body: JSON.stringify({
          recipientName: recipientName.trim(),
          recipientOrg: recipientOrg.trim() || deliveryModalDispatch.destinationName,
          notes: deliveryNotes.trim(),
          items: items.length > 0 ? items : undefined,
        }),
      });
      setDeliveryModalDispatch(null);
      setNotice('Delivery confirmed — inventory ledger, reservations, relief request, vehicle, and driver reconciled.');
      onRefresh();
      loadPhase5Lists();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delivery confirmation failed');
    } finally {
      setBusy(false);
    }
  };

  const verifyDelivery = async (deliveryId: string) => {
    setBusy(true);
    setError(null);
    try {
      await apiRequest(`/deliveries/${deliveryId}/verify`, {
        method: 'POST',
        body: JSON.stringify({ notes: 'Verified in Logistics Operations Console' }),
      });
      setNotice('Delivery confirmation verified.');
      loadPhase5Lists();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Verification failed');
    } finally {
      setBusy(false);
    }
  };

  const recordGpsStep = async (d: Dispatch) => {
    const pts = d.route?.geometry || [];
    const target = pts.length > 2 ? pts[Math.floor(pts.length / 2)] : { lat: d.destinationLat, lng: d.destinationLng };
    setBusy(true);
    setError(null);
    try {
      await apiRequest(`/dispatches/${d.id}/location`, {
        method: 'POST',
        body: JSON.stringify({
          lat: target.lat,
          lng: target.lng,
          speedKmh: 42,
          gpsSource: mode === 'demo' ? 'simulated_demo' : 'authorized_device',
        }),
      });
      setNotice(
        mode === 'demo'
          ? 'Demo GPS checkpoint recorded.'
          : 'Authorized field GPS checkpoint recorded and ETA updated.'
      );
      onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'GPS update rejected');
    } finally {
      setBusy(false);
    }
  };

  // --- Routes & Hazards ---
  const runRouteOptimization = async () => {
    const wh = warehouses.find((w) => w.id === originId) || warehouses[0];
    const inc = incidents.find((i) => i.id === destId) || incidents[0];
    if (!wh || !inc) {
      setError('At least one warehouse and one incident are required to calculate a route.');
      return;
    }
    setBusy(true);
    setError(null);
    setRouteNotice(null);
    try {
      const res = await apiRequest<{ route: RouteResult; notice: string }>('/routes/alternatives', {
        method: 'POST',
        body: JSON.stringify({
          origin: { lat: wh.lat, lng: wh.lng, label: wh.name },
          destination: { lat: inc.lat, lng: inc.lng, label: inc.title },
          mode,
        }),
      });
      setRouteResult(res.route);
      setRouteNotice(res.notice);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Route optimization failed');
    } finally {
      setBusy(false);
    }
  };

  const submitRouteHazard = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await apiRequest('/routes/hazards', {
        method: 'POST',
        body: JSON.stringify({
          type: hazardForm.type,
          severity: hazardForm.severity,
          lat: Number(hazardForm.lat),
          lng: Number(hazardForm.lng),
          radiusKm: Number(hazardForm.radiusKm) || 1.5,
          description: hazardForm.description,
          verified: true,
          mode,
        }),
      });
      setHazardForm((f) => ({ ...f, description: '' }));
      setNotice('Road hazard persisted and linked to Route Risk Engine.');
      loadPhase5Lists();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to report road hazard');
    } finally {
      setBusy(false);
    }
  };

  // --- Fleet Vehicles & Drivers ---
  const registerVehicle = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await apiRequest('/vehicles', {
        method: 'POST',
        body: JSON.stringify({
          callsign: vehForm.callsign,
          registrationNumber: vehForm.registrationNumber || undefined,
          vehicleType: vehForm.vehicleType,
          warehouseId: vehForm.warehouseId || warehouses[0]?.id,
          capacityKg: Number(vehForm.capacityKg) || 3000,
          capacityUnits: Number(vehForm.capacityUnits) || 1000,
          driverTeam: vehForm.driverTeam || 'Unassigned Crew',
          fuelPct: Number(vehForm.fuelPct) || null,
          equipment: vehForm.equipment
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
          mode,
        }),
      });
      setVehForm((f) => ({ ...f, callsign: '', registrationNumber: '', driverTeam: '' }));
      setNotice('Vehicle registered in fleet.');
      onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to register vehicle');
    } finally {
      setBusy(false);
    }
  };

  const setVehicleState = async (vehicleId: string, status: VehicleStatus) => {
    setBusy(true);
    setError(null);
    try {
      await apiRequest(`/vehicles/${vehicleId}/status`, {
        method: 'POST',
        body: JSON.stringify({ status }),
      });
      onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to change vehicle status');
    } finally {
      setBusy(false);
    }
  };

  const assignDriver = async (vehicleId: string, driverId: string) => {
    if (!driverId) return;
    setBusy(true);
    setError(null);
    try {
      await apiRequest(`/vehicles/${vehicleId}/assign-driver`, {
        method: 'POST',
        body: JSON.stringify({ driverId }),
      });
      setNotice('Driver assigned to vehicle.');
      onRefresh();
      loadPhase5Lists();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to assign driver');
    } finally {
      setBusy(false);
    }
  };

  const registerDriver = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await apiRequest('/drivers', {
        method: 'POST',
        body: JSON.stringify({
          name: drvForm.name,
          contact: drvForm.contact,
          certifications: drvForm.certifications
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
          mode,
        }),
      });
      setDrvForm({ name: '', contact: '', certifications: 'Heavy Commercial, Emergency Response' });
      setNotice('Driver/responder registered.');
      loadPhase5Lists();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to register driver');
    } finally {
      setBusy(false);
    }
  };

  const updateDriverStatus = async (driverId: string, status: DriverStatus) => {
    setBusy(true);
    setError(null);
    try {
      await apiRequest(`/drivers/${driverId}/availability`, {
        method: 'POST',
        body: JSON.stringify({ status }),
      });
      loadPhase5Lists();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update driver availability');
    } finally {
      setBusy(false);
    }
  };

  const riskBadgeClass = (band?: string) => {
    switch (band) {
      case 'BLOCKED':
        return 'bg-red-600/20 text-red-600 dark:text-red-400 border-red-500/40';
      case 'HIGH':
        return 'bg-orange-500/15 text-orange-600 dark:text-orange-400 border-orange-500/40';
      case 'MODERATE':
        return 'bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/40';
      case 'LOW':
        return 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/40';
      default:
        return 'bg-slate-500/15 text-slate-600 dark:text-slate-300 border-slate-500/30';
    }
  };

  return (
    <div className="space-y-5">
      {/* Header & 5 Focused Phase 5 Tabs */}
      <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-900 dark:text-white">
            Fleet Intelligence, Route Optimization &amp; Emergency Dispatch
          </h1>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Human-approved dispatch state machine, real road routing, route hazard intelligence &amp; transactional delivery reconciliation
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5 text-xs">
          {(
            [
              ['dispatches', `Dispatches (${dispatches.length})`],
              ['planner', 'Dispatch Planner'],
              ['routes', `Routes & Hazards (${hazards.length})`],
              ['vehicles', `Fleet (${vehicles.length})`],
              ['drivers', `Drivers (${drivers.length})`],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              className={`px-3 py-1.5 rounded-lg border font-medium transition-colors tabular-nums ${
                tab === id
                  ? 'border-[#5869E8]/50 dark:border-[#6D7CFF]/55 bg-[#5869E8]/10 dark:bg-[#6D7CFF]/16 text-[#5869E8] dark:text-[#A5B0FF]'
                  : 'border-slate-200 dark:border-slate-800 text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

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

      {/* TAB 1: ACTIVE DISPATCHES & STATE MACHINE */}
      {tab === 'dispatches' && (
        <div className="space-y-4">
          {/* Filter Bar */}
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/80 p-3 flex flex-wrap items-center gap-2.5 text-xs">
            <div className="flex items-center gap-1.5 text-slate-500 font-medium">
              <Filter className="w-3.5 h-3.5 text-cyan-500" />
              Filters:
            </div>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
            >
              <option value="all">All Statuses</option>
              {[
                'PENDING_APPROVAL',
                'APPROVED',
                'LOADING',
                'EN_ROUTE',
                'ARRIVED',
                'COMPLETED',
                'PARTIALLY_DELIVERED',
                'DELAYED',
                'CANCELLED',
                'in_transit',
                'delivered',
              ].map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <select
              value={priorityFilter}
              onChange={(e) => setPriorityFilter(e.target.value)}
              className="px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
            >
              <option value="all">All Priorities</option>
              {['CRITICAL', 'URGENT', 'HIGH', 'NORMAL', 'LOW'].map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
            <select
              value={riskFilter}
              onChange={(e) => setRiskFilter(e.target.value)}
              className="px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
            >
              <option value="all">All Route Risks</option>
              {['BLOCKED', 'HIGH', 'MODERATE', 'LOW', 'UNKNOWN'].map((r) => (
                <option key={r} value={r}>
                  Route Risk: {r}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => setTab('planner')}
              className="ml-auto inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#5869E8] hover:bg-[#4758D6] dark:bg-[#6D7CFF] dark:hover:bg-[#8190FF] text-white font-medium"
            >
              <Plus className="w-3.5 h-3.5" />
              New Dispatch Plan
            </button>
          </div>

          {filteredDispatches.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-300 dark:border-slate-700 p-10 text-center space-y-2">
              <Truck className="w-8 h-8 text-slate-400 mx-auto" />
              <div className="text-sm font-medium text-slate-700 dark:text-slate-200">
                No dispatches match the current filters in {mode} mode.
              </div>
              <p className="text-xs text-slate-500">
                Use the Dispatch Planner or Resource Allocation workspace to build a human-approved dispatch.
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              {filteredDispatches.map((d) => {
                const isPending = d.status === 'PENDING_APPROVAL' || d.status === 'DRAFT';
                const isApproved = d.status === 'APPROVED' || d.status === 'vehicle_assigned';
                const isLoading = d.status === 'LOADING' || d.status === 'loading';
                const isMoving = ['DISPATCHED', 'EN_ROUTE', 'DELAYED', 'departed', 'in_transit'].includes(d.status);
                const isArrived = ['ARRIVED', 'DELIVERING', 'arrived'].includes(d.status);
                const isTerminal = ['COMPLETED', 'DELIVERED', 'PARTIALLY_DELIVERED', 'CANCELLED', 'REJECTED', 'FAILED', 'delivered', 'cancelled'].includes(
                  d.status
                );
                const riskBand = d.routeRisk?.riskBand || 'UNKNOWN';
                return (
                  <div
                    key={d.id}
                    className={`rounded-xl border p-5 space-y-4 ${
                      isPending
                        ? 'border-dashed border-amber-500/60 bg-amber-500/[0.03]'
                        : 'border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/80'
                    }`}
                  >
                    <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-3">
                      <div className="space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-mono text-[11px] text-slate-500">DSP-{d.id.slice(0, 8)}</span>
                          <span
                            className={`px-2 py-0.5 rounded text-[10px] font-mono uppercase ${
                              isPending
                                ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
                                : isTerminal
                                ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                                : 'bg-[#5869E8]/12 dark:bg-[#6D7CFF]/16 text-[#5869E8] dark:text-[#A5B0FF]'
                            }`}
                          >
                            {d.status}
                          </span>
                          {d.priorityLevel && (
                            <span className="px-2 py-0.5 rounded text-[10px] font-mono uppercase bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300">
                              {d.priorityLevel}
                            </span>
                          )}
                          <span className={`px-2 py-0.5 rounded text-[10px] font-mono uppercase border ${riskBadgeClass(riskBand)}`}>
                            Route Risk: {riskBand}
                          </span>
                          <span className="text-[10px] font-mono text-amber-700 dark:text-amber-400">
                            {d.trackingStatus || 'UNAVAILABLE'} · {d.gpsLabel}
                          </span>
                        </div>
                        <h3 className="text-sm font-semibold text-slate-900 dark:text-white">
                          {d.vehicleCallsign} {d.driverName ? `(${d.driverName})` : ''} · {d.warehouseName} → {d.destinationName}
                        </h3>
                        <div className="text-xs text-slate-500 tabular-nums flex flex-wrap gap-x-4 gap-y-1">
                          {d.route && (
                            <span>
                              Distance: <strong>{d.route.distanceKm} km</strong> · ETA:{' '}
                              <strong>
                                {d.currentEtaMin !== null && d.currentEtaMin !== undefined
                                  ? `${d.currentEtaMin} min`
                                  : d.route.durationMin !== null
                                  ? `${d.route.durationMin} min`
                                  : 'Unavailable'}
                              </strong>{' '}
                              ({d.etaStatus || 'UNKNOWN'})
                            </span>
                          )}
                          {d.approvedBy && (
                            <span className="text-emerald-600 dark:text-emerald-400">
                              Approved by {d.approvedBy}
                            </span>
                          )}
                        </div>
                      </div>

                      {/* Strict Human Approval & State-Machine Action Buttons */}
                      <div className="flex flex-wrap items-center gap-2 shrink-0">
                        {isPending && (
                          <>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => invokeDispatchAction(d.id, 'approve')}
                              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium disabled:opacity-50"
                            >
                              <CheckCircle2 className="w-3.5 h-3.5" />
                              Approve Dispatch
                            </button>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => invokeDispatchAction(d.id, 'reject', { reason: 'Rejected by commander' })}
                              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-red-500/40 text-red-600 dark:text-red-400 hover:bg-red-500/10 text-xs font-medium"
                            >
                              <XCircle className="w-3.5 h-3.5" />
                              Reject
                            </button>
                          </>
                        )}
                        {isApproved && (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => invokeDispatchAction(d.id, 'load')}
                            className="px-3 py-1.5 rounded-lg bg-[#5869E8] hover:bg-[#4758D6] dark:bg-[#6D7CFF] dark:hover:bg-[#8190FF] text-white text-xs font-medium"
                          >
                            Start Loading
                          </button>
                        )}
                        {isLoading && (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => invokeDispatchAction(d.id, 'depart')}
                            className="px-3 py-1.5 rounded-lg bg-[#5869E8] hover:bg-[#4758D6] dark:bg-[#6D7CFF] dark:hover:bg-[#8190FF] text-white text-xs font-medium"
                          >
                            Depart Depot
                          </button>
                        )}
                        {isMoving && (
                          <>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => recordGpsStep(d)}
                              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-cyan-500/40 text-cyan-700 dark:text-cyan-300 text-xs"
                            >
                              <MapPin className="w-3.5 h-3.5" />
                              {mode === 'demo' ? 'Demo GPS Ping' : 'Log Field GPS'}
                            </button>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => invokeDispatchAction(d.id, 'arrive')}
                              className="px-3 py-1.5 rounded-lg bg-violet-600 hover:bg-violet-500 text-white text-xs font-medium"
                            >
                              Mark Arrived
                            </button>
                          </>
                        )}
                        {isArrived && (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => openDeliveryModal(d)}
                            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium"
                          >
                            <PackageCheck className="w-3.5 h-3.5" />
                            Confirm Delivery
                          </button>
                        )}
                        {!isTerminal && !isPending && (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => invokeDispatchAction(d.id, 'cancel', { reason: 'Cancelled by command' })}
                            className="px-2.5 py-1.5 rounded-lg border border-red-500/40 text-red-600 dark:text-red-400 hover:bg-red-500/10 text-xs"
                          >
                            Cancel
                          </button>
                        )}
                      </div>
                    </div>

                    {/* Manifest Items */}
                    {d.items && d.items.length > 0 && (
                      <div className="flex flex-wrap gap-2 text-[11px] tabular-nums">
                        {d.items.map((it, idx) => (
                          <div
                            key={`${it.stockId}-${idx}`}
                            className="px-2.5 py-1 rounded-lg bg-slate-50 dark:bg-slate-950/60 border border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-300"
                          >
                            <strong>{it.itemName}</strong>: {it.quantity} {it.unit}
                            {it.deliveredQty > 0 && (
                              <span className="text-emerald-600 dark:text-emerald-400 ml-1">
                                ({it.deliveredQty} delivered{it.damagedQty > 0 ? `, ${it.damagedQty} dmg` : ''})
                              </span>
                            )}
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Route Safety Notice */}
                    {d.routeRisk && (
                      <div className="text-[11px] text-slate-600 dark:text-slate-400 flex items-center gap-1.5">
                        <ShieldAlert className="w-3.5 h-3.5 text-amber-500 shrink-0" />
                        <span>{d.routeRisk.safetyNotice}</span>
                      </div>
                    )}

                    {/* Audit Event Timeline */}
                    <div className="border-t border-slate-200 dark:border-slate-800 pt-2.5 flex flex-wrap gap-2">
                      {d.events.slice(-6).map((ev) => (
                        <div
                          key={ev.id}
                          className="text-[11px] px-2.5 py-1 rounded bg-slate-50 dark:bg-slate-950/60 border border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-300"
                        >
                          <span className="font-mono text-cyan-600 dark:text-cyan-400">{ev.status}</span> · {ev.note}{' '}
                          <span className="text-slate-400">({new Date(ev.timestamp).toLocaleTimeString()})</span>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Confirmed Deliveries Reconciliation Log */}
          {deliveries.length > 0 && (
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/80 p-4 space-y-3">
              <div className="text-sm font-semibold text-slate-900 dark:text-white flex items-center gap-2">
                <ClipboardCheck className="w-4 h-4 text-emerald-500" />
                Delivery Confirmations &amp; Inventory Reconciliation ({deliveries.length})
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs text-left tabular-nums">
                  <thead className="text-[10px] font-mono uppercase text-slate-500 border-b border-slate-200 dark:border-slate-800">
                    <tr>
                      <th className="py-2 pr-3">Delivery</th>
                      <th className="py-2 pr-3">Status</th>
                      <th className="py-2 pr-3">Recipient</th>
                      <th className="py-2 pr-3">Reconciled Items</th>
                      <th className="py-2 pr-3">Confirmed</th>
                      <th className="py-2">Verification</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                    {deliveries.map((del) => (
                      <tr key={del.id}>
                        <td className="py-2 pr-3 font-mono">{del.id.slice(0, 8)}</td>
                        <td className="py-2 pr-3 font-mono text-emerald-600 dark:text-emerald-400">{del.status}</td>
                        <td className="py-2 pr-3">
                          {del.recipientName} <span className="text-slate-400">({del.recipientOrg})</span>
                        </td>
                        <td className="py-2 pr-3">
                          {del.items.map((it) => `${it.deliveredQty}/${it.dispatchedQty} ${it.unit} ${it.itemName}`).join(', ')}
                        </td>
                        <td className="py-2 pr-3 text-slate-500">{new Date(del.confirmedAt).toLocaleString()}</td>
                        <td className="py-2">
                          {del.verifiedBy ? (
                            <span className="text-emerald-600 dark:text-emerald-400">Verified by {del.verifiedBy}</span>
                          ) : (
                            <button
                              type="button"
                              onClick={() => verifyDelivery(del.id)}
                              disabled={busy}
                              className="text-cyan-600 dark:text-cyan-400 hover:underline font-medium"
                            >
                              Verify Receipt
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {/* TAB 2: DISPATCH PLANNER & HUMAN APPROVAL PANEL */}
      {tab === 'planner' && (
        <div className="space-y-4">
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/80 p-5 space-y-4">
            <div className="text-sm font-semibold text-slate-900 dark:text-white">
              Build Dispatch Plan (Pre-Approval Verification)
            </div>
            <div className="grid md:grid-cols-4 gap-3 text-xs">
              <div>
                <label className="block text-slate-500 mb-1">Relief Request</label>
                <select
                  value={planReqId}
                  onChange={(e) => setPlanReqId(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                >
                  {requests.length === 0 && <option value="">No relief requests</option>}
                  {requests.map((r) => (
                    <option key={r.id} value={r.id}>
                      [{r.priorityCategory.toUpperCase()}] {r.locationName}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-slate-500 mb-1">Source Warehouse (optional)</label>
                <select
                  value={planWhId}
                  onChange={(e) => setPlanWhId(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                >
                  <option value="">Auto-select optimal depot</option>
                  {warehouses.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name} ({w.status})
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-slate-500 mb-1">Vehicle (optional)</label>
                <select
                  value={planVehId}
                  onChange={(e) => setPlanVehId(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                >
                  <option value="">Auto-match available vehicle</option>
                  {vehicles
                    .filter((v) => v.status === 'available')
                    .map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.callsign} ({v.capacityUnits} units)
                      </option>
                    ))}
                </select>
              </div>
              <div>
                <label className="block text-slate-500 mb-1">Driver (optional)</label>
                <select
                  value={planDrvId}
                  onChange={(e) => setPlanDrvId(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                >
                  <option value="">Auto-match assigned/available driver</option>
                  {drivers
                    .filter((d) => d.status === 'Available' || d.status === 'On Duty')
                    .map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name} ({d.status})
                      </option>
                    ))}
                </select>
              </div>
            </div>
            <button
              type="button"
              onClick={generatePlan}
              disabled={busy || !planReqId}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#5869E8] hover:bg-[#4758D6] dark:bg-[#6D7CFF] dark:hover:bg-[#8190FF] text-white text-xs font-medium disabled:opacity-50"
            >
              <Navigation className="w-3.5 h-3.5" />
              {busy ? 'Evaluating Logistics...' : 'Evaluate Dispatch Plan'}
            </button>
          </div>

          {activePlan && (
            <div className="rounded-xl border border-cyan-500/40 bg-white dark:bg-slate-900/90 p-5 space-y-4 text-xs">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="font-mono text-[10px] uppercase text-cyan-600 dark:text-cyan-400">
                    Human Dispatch Approval Review Package
                  </div>
                  <h3 className="text-base font-semibold text-slate-900 dark:text-white">
                    {activePlan.warehouseName} → Request {activePlan.requestId.slice(0, 8)}
                  </h3>
                </div>
                <span
                  className={`px-2.5 py-1 rounded font-mono text-[11px] uppercase border ${riskBadgeClass(
                    activePlan.routeRisk?.riskBand
                  )}`}
                >
                  Route Risk: {activePlan.routeRisk?.riskBand || 'UNKNOWN'}
                </span>
              </div>

              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 tabular-nums">
                <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-950/60 border border-slate-200 dark:border-slate-800">
                  <div className="text-slate-500">Priority &amp; Cargo</div>
                  <div className="font-semibold text-slate-900 dark:text-white mt-0.5">
                    {activePlan.priorityLevel} · {activePlan.totalUnits} units (~{activePlan.estimatedWeightKg} kg)
                  </div>
                </div>
                <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-950/60 border border-slate-200 dark:border-slate-800">
                  <div className="text-slate-500">Vehicle &amp; Capacity</div>
                  <div className="font-semibold text-slate-900 dark:text-white mt-0.5">
                    {activePlan.vehicleCallsign || 'None Available'}
                  </div>
                  <div className={activePlan.vehicleCapacityOk ? 'text-emerald-600' : 'text-red-500'}>
                    {activePlan.vehicleCapacityOk ? 'Capacity Verified' : activePlan.capacityWarning || 'Check Capacity'}
                  </div>
                </div>
                <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-950/60 border border-slate-200 dark:border-slate-800">
                  <div className="text-slate-500">Assigned Driver</div>
                  <div className="font-semibold text-slate-900 dark:text-white mt-0.5">
                    {activePlan.driverName || 'Unassigned'}
                  </div>
                </div>
                <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-950/60 border border-slate-200 dark:border-slate-800">
                  <div className="text-slate-500">Route Distance &amp; ETA</div>
                  <div className="font-semibold text-slate-900 dark:text-white mt-0.5">
                    {activePlan.route ? `${activePlan.route.distanceKm} km` : 'N/A'} ·{' '}
                    {activePlan.route?.durationMin !== null && activePlan.route?.durationMin !== undefined
                      ? `${activePlan.route.durationMin} min`
                      : 'Unavailable'}
                  </div>
                  <div className="text-[11px] text-slate-500">Deadline Status: {activePlan.etaStatus}</div>
                </div>
              </div>

              {activePlan.feasibilityWarnings.length > 0 && (
                <div className="p-3 rounded-lg border border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-200 space-y-1">
                  {activePlan.feasibilityWarnings.map((w, i) => (
                    <div key={i} className="flex items-center gap-1.5">
                      <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                      {w}
                    </div>
                  ))}
                </div>
              )}

              <div className="flex items-center justify-between pt-2 border-t border-slate-200 dark:border-slate-800">
                <div className="text-[11px] text-slate-500">
                  {activePlan.routeRisk?.safetyNotice || 'Road safety data unavailable — route has not been safety verified.'}
                </div>
                <button
                  type="button"
                  onClick={submitPlanForApproval}
                  disabled={busy || !activePlan.vehicleId || !activePlan.allocationId}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-medium disabled:opacity-50"
                >
                  <CheckCircle2 className="w-4 h-4" />
                  Submit Dispatch for Commander Approval
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* TAB 3: REAL ROUTE OPTIMIZER, ALTERNATIVES & ROAD HAZARDS */}
      {tab === 'routes' && (
        <div className="grid lg:grid-cols-3 gap-4">
          <div className="lg:col-span-2 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/80 p-5 space-y-4">
            <div className="grid md:grid-cols-3 gap-3 items-end text-xs">
              <div>
                <label className="block text-slate-500 mb-1">Origin Warehouse</label>
                <select
                  value={originId || warehouses[0]?.id || ''}
                  onChange={(e) => setOriginId(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                >
                  {warehouses.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-slate-500 mb-1">Destination Incident</label>
                <select
                  value={destId || incidents[0]?.id || ''}
                  onChange={(e) => setDestId(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                >
                  {incidents.map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.title}
                    </option>
                  ))}
                </select>
              </div>
              <button
                type="button"
                onClick={runRouteOptimization}
                disabled={busy}
                className="inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg bg-[#5869E8] hover:bg-[#4758D6] dark:bg-[#6D7CFF] dark:hover:bg-[#8190FF] text-white font-medium disabled:opacity-50"
              >
                <RouteIcon className="w-3.5 h-3.5" />
                {busy ? 'Calculating...' : 'Optimize & Check Risk'}
              </button>
            </div>

            {routeResult && (
              <div className="space-y-4 pt-3 border-t border-slate-200 dark:border-slate-800 text-xs">
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3 tabular-nums">
                  <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-950/60 border border-slate-200 dark:border-slate-800">
                    <div className="text-slate-500">Road Distance</div>
                    <div className="text-lg font-semibold text-slate-900 dark:text-white">{routeResult.distanceKm} km</div>
                  </div>
                  <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-950/60 border border-slate-200 dark:border-slate-800">
                    <div className="text-slate-500">Estimated Time</div>
                    <div className="text-lg font-semibold text-slate-900 dark:text-white">
                      {routeResult.durationMin !== null ? `${routeResult.durationMin} min` : 'Unavailable'}
                    </div>
                  </div>
                  <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-950/60 border border-slate-200 dark:border-slate-800">
                    <div className="text-slate-500">Provider / Status</div>
                    <div className="text-sm font-mono uppercase text-cyan-600 dark:text-cyan-400">
                      {routeResult.provider}
                    </div>
                    <div className="text-[10px] font-mono text-slate-500">{routeResult.routeStatus}</div>
                  </div>
                  <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-950/60 border border-slate-200 dark:border-slate-800">
                    <div className="text-slate-500">Route Risk Layer</div>
                    <div
                      className={`inline-block mt-0.5 px-2 py-0.5 rounded font-mono text-xs border ${riskBadgeClass(
                        routeResult.riskAssessment?.riskBand
                      )}`}
                    >
                      {routeResult.riskAssessment?.riskBand || 'UNKNOWN'}
                    </div>
                  </div>
                </div>

                {/* Honest Route Risk Notice */}
                <div className="p-3 rounded-lg border border-amber-500/35 bg-amber-500/10 text-amber-900 dark:text-amber-200 space-y-1">
                  <div className="font-semibold flex items-center gap-1.5">
                    <ShieldAlert className="w-4 h-4 text-amber-500" />
                    {routeResult.riskAssessment?.safetyNotice || routeResult.roadConditionsNotice}
                  </div>
                  {routeResult.riskAssessment?.hazards.map((hz) => (
                    <div key={hz.id} className="text-[11px]">
                      • [{hz.severity.toUpperCase()} {hz.type}] {hz.description} ({hz.distanceFromRouteKm} km from corridor)
                    </div>
                  ))}
                </div>

                {/* Real Route Alternatives Comparison */}
                <div className="space-y-2">
                  <div className="font-medium text-slate-800 dark:text-slate-200">
                    Alternative Corridors ({routeResult.alternatives?.length || 0})
                    {routeNotice && <span className="ml-2 text-[11px] font-normal text-slate-500">— {routeNotice}</span>}
                  </div>
                  {routeResult.alternatives && routeResult.alternatives.length > 0 ? (
                    <div className="grid md:grid-cols-2 gap-2 tabular-nums">
                      {routeResult.alternatives.map((alt) => (
                        <div
                          key={alt.id}
                          className="p-3 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/50 space-y-1"
                        >
                          <div className="flex items-center justify-between font-medium text-slate-900 dark:text-white">
                            <span>{alt.label}</span>
                            <span className={`px-1.5 py-0.5 rounded text-[10px] font-mono border ${riskBadgeClass(alt.riskBand)}`}>
                              {alt.riskBand}
                            </span>
                          </div>
                          <div className="font-mono text-[11px] text-slate-600 dark:text-slate-300">
                            {alt.distanceKm} km · {alt.durationMin !== null ? `${alt.durationMin} min` : 'ETA N/A'} ·{' '}
                            {alt.hazardsCount} hazard(s)
                          </div>
                          <div className="text-[11px] text-slate-500">{alt.selectionReason}</div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="text-slate-500">No live road alternatives returned by provider.</div>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Road Hazard Reporter & Registry */}
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/80 p-5 space-y-4 text-xs">
            <div className="font-semibold text-sm text-slate-900 dark:text-white flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-amber-500" />
              Report Field Road Hazard
            </div>
            <form onSubmit={submitRouteHazard} className="space-y-2.5">
              <div className="grid grid-cols-2 gap-2">
                <select
                  value={hazardForm.type}
                  onChange={(e) => setHazardForm((f) => ({ ...f, type: e.target.value as RouteHazardReport['type'] }))}
                  className="px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                >
                  <option value="flood">Flooded Road</option>
                  <option value="closure">Road Closure</option>
                  <option value="landslide">Landslide</option>
                  <option value="bridge_damage">Bridge Damage</option>
                  <option value="debris">Debris Obstruction</option>
                  <option value="severe_weather">Severe Weather</option>
                </select>
                <select
                  value={hazardForm.severity}
                  onChange={(e) => setHazardForm((f) => ({ ...f, severity: e.target.value as Severity }))}
                  className="px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                >
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                  <option value="critical">Critical (Blocked)</option>
                </select>
              </div>
              <div className="grid grid-cols-3 gap-2">
                <input
                  type="number"
                  step="any"
                  required
                  value={hazardForm.lat}
                  onChange={(e) => setHazardForm((f) => ({ ...f, lat: e.target.value }))}
                  placeholder="Lat"
                  className="px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 tabular-nums"
                />
                <input
                  type="number"
                  step="any"
                  required
                  value={hazardForm.lng}
                  onChange={(e) => setHazardForm((f) => ({ ...f, lng: e.target.value }))}
                  placeholder="Lng"
                  className="px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 tabular-nums"
                />
                <input
                  type="number"
                  step="0.1"
                  required
                  value={hazardForm.radiusKm}
                  onChange={(e) => setHazardForm((f) => ({ ...f, radiusKm: e.target.value }))}
                  placeholder="Radius km"
                  className="px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 tabular-nums"
                />
              </div>
              <textarea
                required
                rows={2}
                value={hazardForm.description}
                onChange={(e) => setHazardForm((f) => ({ ...f, description: e.target.value }))}
                placeholder="Describe road closure, water depth, or structural damage..."
                className="w-full px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
              />
              <button
                type="submit"
                disabled={busy}
                className="w-full py-2 rounded-lg bg-amber-600 hover:bg-amber-500 text-white font-medium"
              >
                Persist Road Hazard Report
              </button>
            </form>

            <div className="border-t border-slate-200 dark:border-slate-800 pt-3 space-y-2 max-h-60 overflow-y-auto">
              <div className="font-mono text-[10px] uppercase text-slate-500">
                Active Route Hazards ({hazards.length})
              </div>
              {hazards.length === 0 ? (
                <div className="text-slate-500">No road hazards reported in {mode} mode.</div>
              ) : (
                hazards.map((h) => (
                  <div
                    key={h.id}
                    className="p-2.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/60 space-y-0.5"
                  >
                    <div className="flex items-center justify-between font-medium text-slate-900 dark:text-white">
                      <span className="uppercase font-mono text-[10px] text-amber-600 dark:text-amber-400">
                        {h.type} · {h.severity}
                      </span>
                      <span className="font-mono text-[10px] text-slate-500">{h.radiusKm}km</span>
                    </div>
                    <div className="text-slate-700 dark:text-slate-300">{h.description}</div>
                    <div className="text-[10px] text-slate-400 font-mono">
                      {h.lat.toFixed(4)}, {h.lng.toFixed(4)} · {h.source}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* TAB 4: FLEET VEHICLE MANAGEMENT */}
      {tab === 'vehicles' && (
        <div className="space-y-4">
          <form
            onSubmit={registerVehicle}
            className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/80 p-4 grid md:grid-cols-4 gap-3 text-xs"
          >
            <input
              required
              value={vehForm.callsign}
              onChange={(e) => setVehForm((f) => ({ ...f, callsign: e.target.value }))}
              placeholder="Callsign (e.g. RF-TRK-401)"
              className="px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
            />
            <input
              value={vehForm.registrationNumber}
              onChange={(e) => setVehForm((f) => ({ ...f, registrationNumber: e.target.value }))}
              placeholder="Registration Plate"
              className="px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
            />
            <select
              value={vehForm.vehicleType}
              onChange={(e) => setVehForm((f) => ({ ...f, vehicleType: e.target.value as VehicleType }))}
              className="px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
            >
              {VEHICLE_TYPES.map((vt) => (
                <option key={vt.value} value={vt.value}>
                  {vt.label}
                </option>
              ))}
            </select>
            <select
              value={vehForm.warehouseId || warehouses[0]?.id || ''}
              onChange={(e) => setVehForm((f) => ({ ...f, warehouseId: e.target.value }))}
              className="px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
            >
              {warehouses.map((w) => (
                <option key={w.id} value={w.id}>
                  Base: {w.name}
                </option>
              ))}
            </select>
            <input
              required
              type="number"
              value={vehForm.capacityUnits}
              onChange={(e) => setVehForm((f) => ({ ...f, capacityUnits: e.target.value }))}
              placeholder="Capacity (units)"
              className="px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 tabular-nums"
            />
            <input
              required
              type="number"
              value={vehForm.capacityKg}
              onChange={(e) => setVehForm((f) => ({ ...f, capacityKg: e.target.value }))}
              placeholder="Payload (kg)"
              className="px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 tabular-nums"
            />
            <input
              required
              value={vehForm.driverTeam}
              onChange={(e) => setVehForm((f) => ({ ...f, driverTeam: e.target.value }))}
              placeholder="Driver / Crew Name"
              className="px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
            />
            <button
              type="submit"
              disabled={busy || warehouses.length === 0}
              className="inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg bg-[#5869E8] hover:bg-[#4758D6] dark:bg-[#6D7CFF] dark:hover:bg-[#8190FF] text-white font-medium disabled:opacity-50"
            >
              <Plus className="w-3.5 h-3.5" /> Register Vehicle
            </button>
          </form>

          {vehicles.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-300 dark:border-slate-700 p-8 text-center text-xs text-slate-500">
              No fleet vehicles registered in {mode} mode yet.
            </div>
          ) : (
            <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-4">
              {vehicles.map((v) => {
                const wh = warehouses.find((w) => w.id === v.warehouseId);
                return (
                  <div
                    key={v.id}
                    className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/80 p-4 space-y-2.5 text-xs"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <div className="text-sm font-semibold text-slate-900 dark:text-white">{v.callsign}</div>
                        <div className="text-[11px] font-mono text-slate-500">
                          {v.registrationNumber || 'UNREG'} · {v.vehicleType.replace(/_/g, ' ')}
                        </div>
                      </div>
                      <span
                        className={`px-2 py-0.5 rounded font-mono text-[10px] uppercase ${
                          v.status === 'available'
                            ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                            : v.status === 'maintenance' || v.status === 'unavailable'
                            ? 'bg-red-500/15 text-red-600 dark:text-red-400'
                            : 'bg-[#5869E8]/12 dark:bg-[#6D7CFF]/16 text-[#5869E8] dark:text-[#A5B0FF]'
                        }`}
                      >
                        {v.status}
                      </span>
                    </div>
                    <div className="text-slate-600 dark:text-slate-300 space-y-0.5 tabular-nums">
                      <div>
                        Capacity: <strong>{v.capacityUnits.toLocaleString()} units</strong> ({v.capacityKg.toLocaleString()} kg)
                        {typeof v.fuelPct === 'number' ? ` · Fuel ${v.fuelPct}%` : ''}
                      </div>
                      <div>Base Depot: {wh?.name || v.warehouseId}</div>
                      <div>Driver / Crew: {v.driverTeam}</div>
                      <div className="text-[11px] font-mono text-slate-500">
                        GPS: {v.gpsSource} · Maint: {v.maintenanceStatus || 'operational'}
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-slate-200 dark:border-slate-800">
                      <select
                        value={v.driverId || ''}
                        onChange={(e) => assignDriver(v.id, e.target.value)}
                        className="flex-1 px-2 py-1 rounded border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-[11px]"
                      >
                        <option value="">Assign Driver...</option>
                        {drivers.map((d) => (
                          <option key={d.id} value={d.id}>
                            {d.name} ({d.status})
                          </option>
                        ))}
                      </select>
                      {v.status === 'available' ? (
                        <button
                          type="button"
                          onClick={() => setVehicleState(v.id, 'maintenance')}
                          disabled={busy}
                          className="inline-flex items-center gap-1 px-2 py-1 rounded border border-amber-500/40 text-amber-700 dark:text-amber-300 text-[11px]"
                        >
                          <Wrench className="w-3 h-3" /> Maintenance
                        </button>
                      ) : v.status === 'maintenance' || v.status === 'unavailable' ? (
                        <button
                          type="button"
                          onClick={() => setVehicleState(v.id, 'available')}
                          disabled={busy}
                          className="px-2 py-1 rounded bg-emerald-600 text-white text-[11px]"
                        >
                          Mark Operational
                        </button>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* TAB 5: DRIVERS & RESPONDER CREWS */}
      {tab === 'drivers' && (
        <div className="space-y-4">
          <form
            onSubmit={registerDriver}
            className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/80 p-4 grid md:grid-cols-4 gap-3 text-xs"
          >
            <input
              required
              value={drvForm.name}
              onChange={(e) => setDrvForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="Driver Full Name"
              className="px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
            />
            <input
              required
              value={drvForm.contact}
              onChange={(e) => setDrvForm((f) => ({ ...f, contact: e.target.value }))}
              placeholder="Phone / Radio Contact"
              className="px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
            />
            <input
              value={drvForm.certifications}
              onChange={(e) => setDrvForm((f) => ({ ...f, certifications: e.target.value }))}
              placeholder="Certifications (comma-separated)"
              className="px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
            />
            <button
              type="submit"
              disabled={busy}
              className="inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg bg-[#5869E8] hover:bg-[#4758D6] dark:bg-[#6D7CFF] dark:hover:bg-[#8190FF] text-white font-medium"
            >
              <UserCheck className="w-3.5 h-3.5" /> Register Driver
            </button>
          </form>

          {drivers.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-300 dark:border-slate-700 p-8 text-center text-xs text-slate-500">
              No drivers registered in {mode} mode yet.
            </div>
          ) : (
            <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-4">
              {drivers.map((drv) => {
                const veh = vehicles.find((v) => v.id === drv.assignedVehicleId);
                return (
                  <div
                    key={drv.id}
                    className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/80 p-4 space-y-2 text-xs"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <div className="text-sm font-semibold text-slate-900 dark:text-white flex items-center gap-1.5">
                          <Users className="w-3.5 h-3.5 text-cyan-500" />
                          {drv.name}
                        </div>
                        <div className="font-mono text-[11px] text-slate-500">{drv.contact}</div>
                      </div>
                      <select
                        value={drv.status}
                        onChange={(e) => updateDriverStatus(drv.id, e.target.value as DriverStatus)}
                        className="px-2 py-1 rounded border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-[11px]"
                      >
                        {(['Available', 'Assigned', 'On Duty', 'Off Duty', 'Unavailable'] as DriverStatus[]).map((st) => (
                          <option key={st} value={st}>
                            {st}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="text-slate-600 dark:text-slate-300">
                      Assigned Vehicle: <strong>{veh?.callsign || 'None'}</strong>
                    </div>
                    {drv.certifications.length > 0 && (
                      <div className="text-[11px] text-slate-500">
                        Certifications: {drv.certifications.join(' · ')}
                      </div>
                    )}
                    {drv.lastLocationAt && (
                      <div className="text-[10px] font-mono text-slate-400 flex items-center gap-1">
                        <Clock className="w-3 h-3" /> Last check-in: {new Date(drv.lastLocationAt).toLocaleString()}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Delivery Confirmation Modal */}
      {deliveryModalDispatch && (
        <div className="fixed inset-0 z-50 bg-slate-950/60 flex items-center justify-center p-4">
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl max-w-lg w-full p-5 space-y-4 text-xs">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-900 dark:text-white">
                Confirm Relief Delivery — DSP-{deliveryModalDispatch.id.slice(0, 8)}
              </h3>
              <button
                type="button"
                onClick={() => setDeliveryModalDispatch(null)}
                className="text-slate-500 hover:text-slate-800 dark:hover:text-slate-200"
              >
                Close
              </button>
            </div>
            <div className="grid grid-cols-2 gap-2.5">
              <div>
                <label className="block text-slate-500 mb-1">Recipient Name *</label>
                <input
                  required
                  value={recipientName}
                  onChange={(e) => setRecipientName(e.target.value)}
                  placeholder="Field Shelter Coordinator"
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                />
              </div>
              <div>
                <label className="block text-slate-500 mb-1">Receiving Organization</label>
                <input
                  value={recipientOrg}
                  onChange={(e) => setRecipientOrg(e.target.value)}
                  placeholder="Shelter / Clinic Name"
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                />
              </div>
            </div>
            <div className="space-y-2 max-h-56 overflow-y-auto tabular-nums">
              {(deliveryModalDispatch.items || []).map((it) => {
                const current = deliveryItemQty[it.stockId] || { delivered: it.quantity, damaged: 0 };
                return (
                  <div
                    key={it.stockId}
                    className="p-2.5 rounded-lg border border-slate-200 dark:border-slate-800 flex items-center justify-between gap-2"
                  >
                    <div>
                      <div className="font-medium text-slate-900 dark:text-white">{it.itemName}</div>
                      <div className="text-[11px] text-slate-500">
                        Dispatched: {it.quantity} {it.unit}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <label className="text-[10px] text-slate-500">
                        Delivered
                        <input
                          type="number"
                          min={0}
                          max={it.quantity}
                          value={current.delivered}
                          onChange={(e) =>
                            setDeliveryItemQty((prev) => ({
                              ...prev,
                              [it.stockId]: { ...current, delivered: Number(e.target.value) },
                            }))
                          }
                          className="ml-1 w-16 px-1.5 py-1 rounded border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-right"
                        />
                      </label>
                      <label className="text-[10px] text-slate-500">
                        Damaged
                        <input
                          type="number"
                          min={0}
                          max={it.quantity}
                          value={current.damaged}
                          onChange={(e) =>
                            setDeliveryItemQty((prev) => ({
                              ...prev,
                              [it.stockId]: { ...current, damaged: Number(e.target.value) },
                            }))
                          }
                          className="ml-1 w-14 px-1.5 py-1 rounded border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-right"
                        />
                      </label>
                    </div>
                  </div>
                );
              })}
            </div>
            <textarea
              rows={2}
              value={deliveryNotes}
              onChange={(e) => setDeliveryNotes(e.target.value)}
              placeholder="Handover notes, partial delivery reason, or proof reference..."
              className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setDeliveryModalDispatch(null)}
                className="px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={submitDeliveryConfirmation}
                disabled={busy}
                className="px-4 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-medium"
              >
                Confirm &amp; Reconcile Inventory
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
