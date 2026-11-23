import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowDownLeft,
  ArrowRightLeft,
  ArrowUpRight,
  Box,
  CalendarClock,
  CheckCircle2,
  ClipboardList,
  Edit3,
  Layers,
  MapPin,
  PackageCheck,
  Plus,
  RefreshCw,
  Search,
  ShieldAlert,
  Truck,
  Warehouse as WarehouseIcon,
  X,
} from 'lucide-react';
import { apiRequest } from '../../lib/api';
import type {
  DataMode,
  IncomingSupplyOrder,
  InventoryBatch,
  InventoryCatalogItem,
  InventoryStock,
  MovementType,
  ReplenishmentRecommendation,
  ResourceCategory,
  StockAlertLevel,
  StockMovement,
  StockReservation,
  Warehouse,
  WarehouseStatus,
  WarehouseType,
} from '../../shared/types';

interface WarehousesInventoryViewProps {
  mode: DataMode;
  initialTab?: 'warehouses' | 'inventory';
  warehouses: Warehouse[];
  inventory: InventoryStock[];
  movements: StockMovement[];
  onRefresh: () => void;
  onNavigate?: (view: string) => void;
}

type WorkspaceTab = 'inventory' | 'warehouses' | 'reservations' | 'shortages' | 'expiry' | 'incoming';

const RESOURCE_CATEGORIES: { value: ResourceCategory; label: string }[] = [
  { value: 'food', label: 'Food & Nutrition' },
  { value: 'drinking_water', label: 'Water & Hydration' },
  { value: 'hygiene_kits', label: 'Water Purification & Hygiene' },
  { value: 'medical_kits', label: 'Medical & First-Aid' },
  { value: 'medicines', label: 'Essential Medicines' },
  { value: 'shelter', label: 'Shelter & Tents' },
  { value: 'blankets', label: 'Blankets & Mats' },
  { value: 'clothing', label: 'Emergency Clothing' },
  { value: 'rescue_equipment', label: 'Rescue Equipment' },
  { value: 'power_equipment', label: 'Generators & Power' },
  { value: 'fuel', label: 'Fuel & Energy' },
  { value: 'communication_equipment', label: 'Communications' },
  { value: 'other', label: 'Other Supplies' },
];

const WAREHOUSE_STATUSES: { value: WarehouseStatus; label: string }[] = [
  { value: 'operational', label: 'Operational' },
  { value: 'limited', label: 'Limited Operations' },
  { value: 'temporarily_unavailable', label: 'Temporarily Unavailable' },
  { value: 'under_maintenance', label: 'Under Maintenance' },
  { value: 'closed', label: 'Closed' },
];

const WAREHOUSE_TYPES: { value: WarehouseType; label: string }[] = [
  { value: 'central_hub', label: 'Central Hub' },
  { value: 'regional_depot', label: 'Regional Depot' },
  { value: 'medical_cold_chain', label: 'Medical Cold-Chain' },
  { value: 'forward_staging', label: 'Forward Staging' },
  { value: 'mobile_unit', label: 'Mobile Unit' },
  { value: 'ngo_partner', label: 'NGO Partner Depot' },
];

interface WarehouseSummaryPayload {
  warehouse: Warehouse;
  stats: {
    skuCount: number;
    totalOnHand: number;
    totalAvailable: number;
    totalReserved: number;
    lowOrCriticalCount: number;
    utilizationPct: number;
  };
  inventory: InventoryStock[];
  movements: StockMovement[];
  pendingOutgoingDispatches: { id: string; vehicleCallsign: string; destinationName: string; status: string }[];
  activeReservations: StockReservation[];
  incomingSupplies: IncomingSupplyOrder[];
  vehicles: { id: string; callsign: string; vehicleType: string; status: string }[];
}

interface ExpiryResponse {
  summary: {
    totalBatches: number;
    expiredCount: number;
    expiredUnits: number;
    expiring7dCount: number;
    expiring30dCount: number;
    expiring90dCount: number;
    healthyCount: number;
    noExpiryCount: number;
  };
  expired: (InventoryBatch & { daysRemaining: number })[];
  expiring7d: (InventoryBatch & { daysRemaining: number })[];
  expiring30d: (InventoryBatch & { daysRemaining: number })[];
  expiring90d: (InventoryBatch & { daysRemaining: number })[];
  healthy: (InventoryBatch & { daysRemaining: number })[];
  noExpiry: (InventoryBatch & { daysRemaining: null })[];
}

interface ShortagesResponse {
  summary: {
    outOfStockCount: number;
    criticalCount: number;
    lowCount: number;
    overstockedCount: number;
    imbalanceCount: number;
  };
  recommendations: ReplenishmentRecommendation[];
  overstocked: { stockId: string; itemName: string; warehouseName: string; availableQty: number; reorderThreshold: number }[];
  imbalances: { sku: string; itemName: string; deficitWarehouse: string; surplusWarehouse: string; suggestedTransferQty: number }[];
}

function stockStatusColor(level?: StockAlertLevel): string {
  switch (level) {
    case 'OUT_OF_STOCK':
      return 'text-red-600 dark:text-red-400 font-semibold';
    case 'CRITICAL':
      return 'text-orange-600 dark:text-orange-400 font-semibold';
    case 'LOW':
      return 'text-amber-600 dark:text-amber-400 font-semibold';
    default:
      return 'text-emerald-600 dark:text-emerald-400';
  }
}

export const WarehousesInventoryView: React.FC<WarehousesInventoryViewProps> = ({
  mode,
  initialTab = 'inventory',
  warehouses,
  inventory,
  movements,
  onRefresh,
  onNavigate,
}) => {
  const [tab, setTab] = useState<WorkspaceTab>(initialTab);
  const [msg, setMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // Phase 4 live data slices fetched from dedicated endpoints
  const [catalog, setCatalog] = useState<InventoryCatalogItem[]>([]);
  const [reservations, setReservations] = useState<StockReservation[]>([]);
  const [shortagesData, setShortagesData] = useState<ShortagesResponse | null>(null);
  const [expiryData, setExpiryData] = useState<ExpiryResponse | null>(null);
  const [incomingSupplies, setIncomingSupplies] = useState<IncomingSupplyOrder[]>([]);

  // Filters
  const [invSearch, setInvSearch] = useState('');
  const [invWarehouseFilter, setInvWarehouseFilter] = useState('all');
  const [invCategoryFilter, setInvCategoryFilter] = useState('all');
  const [invStatusFilter, setInvStatusFilter] = useState('all');

  const [whSearch, setWhSearch] = useState('');
  const [whStatusFilter, setWhStatusFilter] = useState('all');
  const [whTypeFilter, setWhTypeFilter] = useState('all');
  const [whDistrictFilter, setWhDistrictFilter] = useState('');
  const [whMinCap, setWhMinCap] = useState('');

  // Warehouse detail summary drawer
  const [selectedWhSummary, setSelectedWhSummary] = useState<WarehouseSummaryPayload | null>(null);
  const [loadingSummary, setLoadingSummary] = useState(false);

  // Modals
  const [showWhModal, setShowWhModal] = useState(false);
  const [editingWh, setEditingWh] = useState<Warehouse | null>(null);
  const [showCatalogModal, setShowCatalogModal] = useState(false);
  const [showReceiveModal, setShowReceiveModal] = useState(false);
  const [movementModal, setMovementModal] = useState<{
    stock: InventoryStock;
    mode: 'dispatch' | 'adjust' | 'transfer';
  } | null>(null);
  const [showReservationModal, setShowReservationModal] = useState(false);
  const [showBatchModal, setShowBatchModal] = useState(false);
  const [showSupplyModal, setShowSupplyModal] = useState(false);
  const [receiveSupplyTarget, setReceiveSupplyTarget] = useState<IncomingSupplyOrder | null>(null);

  // Form States
  const [whForm, setWhForm] = useState({
    name: '',
    warehouseType: 'regional_depot' as WarehouseType,
    location: '',
    region: '',
    district: '',
    state: '',
    country: 'India',
    lat: 13.05,
    lng: 80.22,
    managerName: '',
    capacityUnits: 25000,
    status: 'operational' as WarehouseStatus,
    contact: '+91-44-5550-0200',
    operatingHours: '24/7 Emergency Operations',
    accessibility: 'high' as Warehouse['accessibility'],
  });

  const [catForm, setCatForm] = useState({
    sku: '',
    name: '',
    category: 'food' as ResourceCategory,
    description: '',
    unit: 'kits',
    minStock: 200,
    criticalStock: 100,
    reorderQty: 400,
    storageRequirements: 'Dry climate-controlled storage',
    expiryTracking: true,
    supplier: '',
  });

  const [receiveForm, setReceiveForm] = useState({
    warehouseId: warehouses[0]?.id || '',
    sku: '',
    itemName: '',
    category: 'drinking_water' as ResourceCategory,
    unit: 'packs',
    quantity: 500,
    reason: 'Verified supplier inbound delivery',
    lotNumber: '',
    expiryDate: '',
  });

  const [movForm, setMovForm] = useState({
    type: 'adjustment' as MovementType,
    quantity: 50,
    destinationWarehouseId: '',
    reason: '',
  });

  const [resForm, setResForm] = useState({
    stockId: inventory[0]?.id || '',
    requestedQty: 100,
    allowPartial: true,
    expiresInHours: 24,
    notes: 'Emergency relief reservation',
  });

  const [batchForm, setBatchForm] = useState({
    stockId: inventory[0]?.id || '',
    lotNumber: '',
    quantity: 100,
    expiryDate: '',
    noExpiry: false,
    batchLocation: 'Bay A / Rack 2',
    storageRequirements: 'Dry warehouse bay',
  });

  const [supplyForm, setSupplyForm] = useState({
    supplier: '',
    warehouseId: warehouses[0]?.id || '',
    trackingReference: '',
    expectedArrival: new Date(Date.now() + 2 * 24 * 3600_000).toISOString().slice(0, 10),
    sku: 'WTR-20L-001',
    itemName: 'Potable Drinking Water Packs (20L)',
    category: 'drinking_water' as ResourceCategory,
    unit: 'packs',
    orderedQty: 500,
    lotNumber: '',
    expiryDate: '',
  });

  const [receiveSupplyLines, setReceiveSupplyLines] = useState<
    Record<string, { receivedQty: number; damagedQty: number }>
  >({});
  const [receiveDiscrepancyNotes, setReceiveDiscrepancyNotes] = useState('');

  const fetchPhase4Slices = useCallback(async () => {
    try {
      const [catRes, resRes, shRes, expRes, supRes] = await Promise.all([
        apiRequest<{ items: InventoryCatalogItem[] }>(`/inventory/items?mode=${mode}`),
        apiRequest<{ reservations: StockReservation[] }>(`/reservations?mode=${mode}`),
        apiRequest<ShortagesResponse>(`/inventory/shortages?mode=${mode}`),
        apiRequest<ExpiryResponse>(`/inventory/expiry?mode=${mode}`),
        apiRequest<{ supplies: IncomingSupplyOrder[] }>(`/supplies/incoming?mode=${mode}`),
      ]);
      setCatalog(catRes.items);
      setReservations(resRes.reservations);
      setShortagesData(shRes);
      setExpiryData(expRes);
      setIncomingSupplies(supRes.supplies);
    } catch {
      // keep existing UI responsive
    }
  }, [mode]);

  useEffect(() => {
    fetchPhase4Slices();
  }, [fetchPhase4Slices, inventory.length, movements.length, warehouses.length]);

  useEffect(() => {
    if (warehouses[0] && !receiveForm.warehouseId) {
      setReceiveForm((f) => ({ ...f, warehouseId: warehouses[0].id }));
    }
    if (warehouses[0] && !supplyForm.warehouseId) {
      setSupplyForm((f) => ({ ...f, warehouseId: warehouses[0].id }));
    }
  }, [warehouses, receiveForm.warehouseId, supplyForm.warehouseId]);

  useEffect(() => {
    if (inventory[0] && !resForm.stockId) {
      setResForm((f) => ({ ...f, stockId: inventory[0].id }));
    }
    if (inventory[0] && !batchForm.stockId) {
      setBatchForm((f) => ({ ...f, stockId: inventory[0].id }));
    }
  }, [inventory, resForm.stockId, batchForm.stockId]);

  const warehouseName = (id: string) => warehouses.find((w) => w.id === id)?.name || id;

  const filteredInventory = useMemo(() => {
    const q = invSearch.trim().toLowerCase();
    return inventory.filter((item) => {
      if (invWarehouseFilter !== 'all' && item.warehouseId !== invWarehouseFilter) return false;
      if (invCategoryFilter !== 'all' && item.category !== invCategoryFilter) return false;
      if (invStatusFilter !== 'all' && (item.stockStatus || 'NORMAL') !== invStatusFilter) return false;
      if (q && !item.itemName.toLowerCase().includes(q) && !item.sku.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [inventory, invSearch, invWarehouseFilter, invCategoryFilter, invStatusFilter]);

  const filteredWarehouses = useMemo(() => {
    const q = whSearch.trim().toLowerCase();
    const dq = whDistrictFilter.trim().toLowerCase();
    const minCap = Number(whMinCap) || 0;
    return warehouses.filter((w) => {
      if (whStatusFilter !== 'all' && w.status !== whStatusFilter) return false;
      if (whTypeFilter !== 'all' && w.warehouseType !== whTypeFilter) return false;
      if (dq && !(w.district || w.region).toLowerCase().includes(dq)) return false;
      if (minCap > 0 && w.capacityUnits < minCap) return false;
      if (
        q &&
        !w.name.toLowerCase().includes(q) &&
        !w.location.toLowerCase().includes(q) &&
        !(w.managerName || '').toLowerCase().includes(q)
      ) {
        return false;
      }
      return true;
    });
  }, [warehouses, whSearch, whStatusFilter, whTypeFilter, whDistrictFilter, whMinCap]);

  const refreshAll = async () => {
    onRefresh();
    await fetchPhase4Slices();
  };

  const openWarehouseSummary = async (whId: string) => {
    setLoadingSummary(true);
    try {
      const data = await apiRequest<WarehouseSummaryPayload>(`/warehouses/${whId}/summary`);
      setSelectedWhSummary(data);
    } catch (err) {
      setMsg({ type: 'err', text: err instanceof Error ? err.message : 'Failed to load warehouse summary' });
    } finally {
      setLoadingSummary(false);
    }
  };

  const openEditWarehouse = (wh: Warehouse) => {
    setEditingWh(wh);
    setWhForm({
      name: wh.name,
      warehouseType: wh.warehouseType || 'regional_depot',
      location: wh.location,
      region: wh.region,
      district: wh.district || wh.region,
      state: wh.state || '',
      country: wh.country || 'India',
      lat: wh.lat,
      lng: wh.lng,
      managerName: wh.managerName || '',
      capacityUnits: wh.capacityUnits,
      status: wh.status,
      contact: wh.contact,
      operatingHours: wh.operatingHours,
      accessibility: wh.accessibility,
    });
    setShowWhModal(true);
  };

  const handleSaveWarehouse = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy('wh');
    setMsg(null);
    try {
      if (editingWh) {
        await apiRequest(`/warehouses/${editingWh.id}`, {
          method: 'PATCH',
          body: { ...whForm, verifyNow: true },
        });
        setMsg({ type: 'ok', text: `Warehouse "${whForm.name}" updated.` });
      } else {
        await apiRequest('/warehouses', {
          method: 'POST',
          body: { ...whForm, mode },
        });
        setMsg({ type: 'ok', text: `Warehouse "${whForm.name}" registered.` });
      }
      setShowWhModal(false);
      setEditingWh(null);
      await refreshAll();
    } catch (err) {
      setMsg({ type: 'err', text: err instanceof Error ? err.message : 'Warehouse save failed' });
    } finally {
      setBusy(null);
    }
  };

  const handleToggleWarehouseActive = async (wh: Warehouse) => {
    setBusy(wh.id);
    setMsg(null);
    try {
      const nextActive = wh.active === false;
      await apiRequest(`/warehouses/${wh.id}`, {
        method: 'PATCH',
        body: { active: nextActive, status: nextActive ? 'operational' : 'temporarily_unavailable' },
      });
      setMsg({
        type: 'ok',
        text: `${wh.name} ${nextActive ? 'activated (Operational)' : 'deactivated (Temporarily Unavailable)'}.`,
      });
      await refreshAll();
    } catch (err) {
      setMsg({ type: 'err', text: err instanceof Error ? err.message : 'Status toggle failed' });
    } finally {
      setBusy(null);
    }
  };

  const handleCreateCatalogItem = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy('cat');
    setMsg(null);
    try {
      await apiRequest('/inventory/items', {
        method: 'POST',
        body: { ...catForm, mode },
      });
      setShowCatalogModal(false);
      setCatForm({
        sku: '',
        name: '',
        category: 'food',
        description: '',
        unit: 'kits',
        minStock: 200,
        criticalStock: 100,
        reorderQty: 400,
        storageRequirements: 'Dry climate-controlled storage',
        expiryTracking: true,
        supplier: '',
      });
      setMsg({ type: 'ok', text: 'Inventory catalog item created.' });
      await refreshAll();
    } catch (err) {
      setMsg({ type: 'err', text: err instanceof Error ? err.message : 'Failed to create catalog item' });
    } finally {
      setBusy(null);
    }
  };

  const handleReceiveStock = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy('receive');
    setMsg(null);
    try {
      await apiRequest('/inventory/receive', {
        method: 'POST',
        body: {
          warehouseId: receiveForm.warehouseId,
          sku: receiveForm.sku,
          itemName: receiveForm.itemName,
          category: receiveForm.category,
          unit: receiveForm.unit,
          quantity: Number(receiveForm.quantity),
          reason: receiveForm.reason,
          lotNumber: receiveForm.lotNumber || undefined,
          expiryDate: receiveForm.expiryDate ? new Date(receiveForm.expiryDate).toISOString() : undefined,
          mode,
        },
      });
      setShowReceiveModal(false);
      setMsg({ type: 'ok', text: `Received ${receiveForm.quantity} ${receiveForm.unit} into stock ledger.` });
      await refreshAll();
    } catch (err) {
      setMsg({ type: 'err', text: err instanceof Error ? err.message : 'Stock receipt failed' });
    } finally {
      setBusy(null);
    }
  };

  const handleStockOperation = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!movementModal) return;
    setBusy('mov');
    setMsg(null);
    try {
      const { stock, mode: opMode } = movementModal;
      if (opMode === 'dispatch') {
        await apiRequest('/inventory/dispatch', {
          method: 'POST',
          body: {
            stockId: stock.id,
            quantity: Number(movForm.quantity),
            reason: movForm.reason || 'Emergency field dispatch',
            expectedVersion: stock.version,
          },
        });
        setMsg({ type: 'ok', text: `Dispatched ${movForm.quantity} ${stock.unit} of ${stock.itemName}.` });
      } else if (opMode === 'transfer') {
        await apiRequest('/inventory/transfer', {
          method: 'POST',
          body: {
            sourceStockId: stock.id,
            destinationWarehouseId: movForm.destinationWarehouseId,
            quantity: Number(movForm.quantity),
            reason: movForm.reason || 'Inter-warehouse transfer',
          },
        });
        setMsg({
          type: 'ok',
          text: `Transferred ${movForm.quantity} ${stock.unit} of ${stock.itemName} to ${warehouseName(movForm.destinationWarehouseId)}.`,
        });
      } else {
        await apiRequest('/inventory/adjust', {
          method: 'POST',
          body: {
            stockId: stock.id,
            type: movForm.type,
            quantity: Number(movForm.quantity),
            reason: movForm.reason || 'Cycle count stock adjustment',
            expectedVersion: stock.version,
          },
        });
        setMsg({ type: 'ok', text: `Recorded ${movForm.type} adjustment (${movForm.quantity}) for ${stock.itemName}.` });
      }
      setMovementModal(null);
      await refreshAll();
    } catch (err) {
      setMsg({ type: 'err', text: err instanceof Error ? err.message : 'Stock operation failed' });
    } finally {
      setBusy(null);
    }
  };

  const handleCreateReservation = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy('res');
    setMsg(null);
    try {
      const result = await apiRequest<{ reservation: StockReservation }>('/reservations', {
        method: 'POST',
        body: {
          stockId: resForm.stockId,
          requestedQty: Number(resForm.requestedQty),
          allowPartial: resForm.allowPartial,
          expiresInHours: Number(resForm.expiresInHours),
          notes: resForm.notes,
        },
      });
      setShowReservationModal(false);
      setMsg({
        type: 'ok',
        text: `Reservation ${result.reservation.status}: ${result.reservation.reservedQty}/${result.reservation.requestedQty} ${result.reservation.unit}.`,
      });
      await refreshAll();
    } catch (err) {
      setMsg({ type: 'err', text: err instanceof Error ? err.message : 'Reservation failed' });
    } finally {
      setBusy(null);
    }
  };

  const handleReservationAction = async (
    id: string,
    action: 'release' | 'Allocated' | 'Dispatched' | 'Delivered'
  ) => {
    setBusy(id);
    setMsg(null);
    try {
      if (action === 'release') {
        await apiRequest(`/reservations/${id}/release`, {
          method: 'POST',
          body: { reason: 'Released by logistics operator' },
        });
        setMsg({ type: 'ok', text: 'Reservation released back to available stock.' });
      } else {
        await apiRequest(`/reservations/${id}/confirm`, {
          method: 'POST',
          body: { status: action },
        });
        setMsg({ type: 'ok', text: `Reservation transitioned to ${action}.` });
      }
      await refreshAll();
    } catch (err) {
      setMsg({ type: 'err', text: err instanceof Error ? err.message : 'Reservation update failed' });
    } finally {
      setBusy(null);
    }
  };

  const handleCreateBatch = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy('batch');
    setMsg(null);
    try {
      await apiRequest('/inventory/batches', {
        method: 'POST',
        body: {
          stockId: batchForm.stockId,
          lotNumber: batchForm.lotNumber,
          quantity: Number(batchForm.quantity),
          expiryDate: batchForm.noExpiry || !batchForm.expiryDate ? null : new Date(batchForm.expiryDate).toISOString(),
          batchLocation: batchForm.batchLocation,
          storageRequirements: batchForm.storageRequirements,
        },
      });
      setShowBatchModal(false);
      setMsg({ type: 'ok', text: `Batch ${batchForm.lotNumber} registered and evaluated.` });
      await refreshAll();
    } catch (err) {
      setMsg({ type: 'err', text: err instanceof Error ? err.message : 'Failed to register batch' });
    } finally {
      setBusy(null);
    }
  };

  const handleCreateIncomingSupply = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy('sup');
    setMsg(null);
    try {
      await apiRequest('/supplies/incoming', {
        method: 'POST',
        body: {
          supplier: supplyForm.supplier,
          warehouseId: supplyForm.warehouseId,
          trackingReference: supplyForm.trackingReference || undefined,
          expectedArrival: new Date(supplyForm.expectedArrival).toISOString(),
          status: 'In Transit',
          items: [
            {
              sku: supplyForm.sku,
              itemName: supplyForm.itemName,
              category: supplyForm.category,
              unit: supplyForm.unit,
              orderedQty: Number(supplyForm.orderedQty),
              lotNumber: supplyForm.lotNumber || undefined,
              expiryDate: supplyForm.expiryDate ? new Date(supplyForm.expiryDate).toISOString() : null,
            },
          ],
          mode,
        },
      });
      setShowSupplyModal(false);
      setMsg({ type: 'ok', text: 'Incoming supply order logged (not counted as available until verified).' });
      await refreshAll();
    } catch (err) {
      setMsg({ type: 'err', text: err instanceof Error ? err.message : 'Failed to log incoming supply' });
    } finally {
      setBusy(null);
    }
  };

  const openReceiveSupplyModal = (sup: IncomingSupplyOrder) => {
    setReceiveSupplyTarget(sup);
    const initial: Record<string, { receivedQty: number; damagedQty: number }> = {};
    for (const item of sup.items) {
      initial[item.sku] = { receivedQty: item.orderedQty, damagedQty: 0 };
    }
    setReceiveSupplyLines(initial);
    setReceiveDiscrepancyNotes('');
  };

  const handleReceiveIncomingSupply = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!receiveSupplyTarget) return;
    setBusy(receiveSupplyTarget.id);
    setMsg(null);
    try {
      await apiRequest(`/supplies/incoming/${receiveSupplyTarget.id}/receive`, {
        method: 'POST',
        body: {
          items: receiveSupplyTarget.items.map((it) => ({
            sku: it.sku,
            receivedQty: receiveSupplyLines[it.sku]?.receivedQty ?? it.orderedQty,
            damagedQty: receiveSupplyLines[it.sku]?.damagedQty ?? 0,
          })),
          discrepancyNotes: receiveDiscrepancyNotes || undefined,
        },
      });
      setReceiveSupplyTarget(null);
      setMsg({ type: 'ok', text: 'Shipment arrival logged. Click Verify to commit usable units into available stock.' });
      await refreshAll();
    } catch (err) {
      setMsg({ type: 'err', text: err instanceof Error ? err.message : 'Failed to receive supply' });
    } finally {
      setBusy(null);
    }
  };

  const handleVerifyIncomingSupply = async (supId: string) => {
    setBusy(supId);
    setMsg(null);
    try {
      await apiRequest(`/supplies/incoming/${supId}/verify`, {
        method: 'POST',
        body: { notes: 'Verified by warehouse operator into atomic stock ledger' },
      });
      setMsg({ type: 'ok', text: 'Incoming shipment verified and committed atomically to warehouse inventory.' });
      await refreshAll();
    } catch (err) {
      setMsg({ type: 'err', text: err instanceof Error ? err.message : 'Verification failed' });
    } finally {
      setBusy(null);
    }
  };

  const shortageCount =
    (shortagesData?.summary.outOfStockCount || 0) +
    (shortagesData?.summary.criticalCount || 0) +
    (shortagesData?.summary.lowCount || 0);
  const expiringAlertCount = (expiryData?.summary.expiredCount || 0) + (expiryData?.summary.expiring7dCount || 0);

  return (
    <div className="space-y-5">
      {/* Header & Workspace Tab Strip */}
      <div className="flex flex-col xl:flex-row xl:items-center xl:justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-900 dark:text-white">
            Relief Warehouses &amp; Real-Time Inventory Intelligence
          </h1>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Atomic stock ledger (Available = On-Hand − Reserved) · Concurrency-safe reservations · Expiry &amp; incoming supply verification
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {(
            [
              ['inventory', 'Stock Ledger', Box, inventory.length],
              ['warehouses', 'Warehouses', WarehouseIcon, warehouses.length],
              ['reservations', 'Reservations', ClipboardList, reservations.filter((r) => r.status === 'Reserved' || r.status === 'Partially Reserved' || r.status === 'Allocated').length],
              ['shortages', 'Shortages', ShieldAlert, shortageCount],
              ['expiry', 'Expiry & Lots', CalendarClock, expiringAlertCount],
              ['incoming', 'Incoming Supply', Truck, incomingSupplies.filter((s) => s.status !== 'Verified' && s.status !== 'Cancelled').length],
            ] as const
          ).map(([id, label, Icon, count]) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium border flex items-center gap-1.5 transition-colors tabular-nums ${
                tab === id
                  ? 'bg-cyan-600 border-cyan-600 text-white'
                  : 'border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 hover:border-cyan-500/60'
              }`}
            >
              <Icon className="w-3.5 h-3.5" />
              {label}
              <span className="font-mono text-[11px] opacity-80">({count})</span>
            </button>
          ))}
        </div>
      </div>

      {msg && (
        <div
          className={`p-3 rounded-lg border text-xs flex items-center justify-between ${
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

      {/* =====================================================================
          TAB 1: INVENTORY STOCK LEDGER & CATALOG
         ===================================================================== */}
      {tab === 'inventory' && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2.5">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <div className="relative">
                <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-2.5" />
                <input
                  value={invSearch}
                  onChange={(e) => setInvSearch(e.target.value)}
                  placeholder="Search SKU or item..."
                  className="pl-8 pr-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-200 w-48"
                />
              </div>
              <select
                value={invWarehouseFilter}
                onChange={(e) => setInvWarehouseFilter(e.target.value)}
                className="px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-200"
              >
                <option value="all">All Warehouses</option>
                {warehouses.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
              <select
                value={invCategoryFilter}
                onChange={(e) => setInvCategoryFilter(e.target.value)}
                className="px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-200"
              >
                <option value="all">All Categories</option>
                {RESOURCE_CATEGORIES.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
              <select
                value={invStatusFilter}
                onChange={(e) => setInvStatusFilter(e.target.value)}
                className="px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-200"
              >
                <option value="all">All Stock Levels</option>
                <option value="NORMAL">Normal</option>
                <option value="LOW">Low Stock</option>
                <option value="CRITICAL">Critical</option>
                <option value="OUT_OF_STOCK">Out of Stock</option>
              </select>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setShowCatalogModal(true)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 hover:border-cyan-500 text-xs font-medium text-slate-700 dark:text-slate-200"
              >
                <Layers className="w-3.5 h-3.5" />
                Add Catalog SKU ({catalog.length})
              </button>
              <button
                type="button"
                onClick={() => {
                  const firstCat = catalog[0];
                  setReceiveForm((f) => ({
                    ...f,
                    warehouseId: f.warehouseId || warehouses[0]?.id || '',
                    sku: f.sku || firstCat?.sku || 'WTR-20L-001',
                    itemName: f.itemName || firstCat?.name || 'Potable Drinking Water Packs (20L)',
                    category: firstCat?.category || f.category,
                    unit: firstCat?.unit || f.unit,
                  }));
                  setShowReceiveModal(true);
                }}
                disabled={warehouses.length === 0}
                className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-[#5869E8] hover:bg-[#4758D6] dark:bg-[#6D7CFF] dark:hover:bg-[#8190FF] text-white text-xs font-medium disabled:opacity-40"
              >
                <ArrowDownLeft className="w-3.5 h-3.5" />
                Receive Stock
              </button>
            </div>
          </div>

          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/80 overflow-x-auto">
            {filteredInventory.length === 0 ? (
              <div className="p-10 text-center text-sm text-slate-500">
                No inventory stock records match the current filter in {mode.toUpperCase()} mode.
                {warehouses.length === 0
                  ? ' Register a warehouse first, then receive stock.'
                  : ' Use "Receive Stock" to log initial relief supplies.'}
              </div>
            ) : (
              <table className="w-full text-left text-xs">
                <thead className="border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/60 text-slate-500 font-mono uppercase">
                  <tr>
                    <th className="py-2.5 px-3">Resource &amp; SKU</th>
                    <th className="py-2.5 px-3">Warehouse</th>
                    <th className="py-2.5 px-3 text-right">Available</th>
                    <th className="py-2.5 px-3 text-right">Reserved</th>
                    <th className="py-2.5 px-3 text-right">On-Hand</th>
                    <th className="py-2.5 px-3 text-right">In Transit</th>
                    <th className="py-2.5 px-3">Status · Thresholds</th>
                    <th className="py-2.5 px-3 text-right">Atomic Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 dark:divide-slate-800 tabular-nums">
                  {filteredInventory.map((item) => {
                    const status = item.stockStatus || 'NORMAL';
                    return (
                      <tr key={item.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                        <td className="py-2.5 px-3">
                          <div className="font-medium text-slate-900 dark:text-white">{item.itemName}</div>
                          <div className="font-mono text-[11px] text-slate-500">
                            {item.sku} · {item.category.replace(/_/g, ' ')} · v{item.version}
                          </div>
                        </td>
                        <td className="py-2.5 px-3 text-slate-600 dark:text-slate-300">
                          {warehouseName(item.warehouseId)}
                        </td>
                        <td className={`py-2.5 px-3 text-right font-mono text-sm ${stockStatusColor(status)}`}>
                          {item.availableQty.toLocaleString()} {item.unit}
                        </td>
                        <td className="py-2.5 px-3 text-right font-mono text-slate-600 dark:text-slate-300">
                          {item.reservedQty.toLocaleString()}
                        </td>
                        <td className="py-2.5 px-3 text-right font-mono text-slate-500">
                          {item.totalQty.toLocaleString()}
                        </td>
                        <td className="py-2.5 px-3 text-right font-mono text-cyan-600 dark:text-cyan-400">
                          {item.inTransitQty > 0 ? `+${item.inTransitQty.toLocaleString()}` : '0'}
                        </td>
                        <td className="py-2.5 px-3 font-mono text-[11px]">
                          <span className={stockStatusColor(status)}>{status.replace(/_/g, ' ')}</span>
                          <span className="text-slate-400">
                            {' '}
                            · Min {item.minStock} · Crit {item.criticalStock ?? Math.floor(item.minStock * 0.5)}
                          </span>
                        </td>
                        <td className="py-2.5 px-3 text-right whitespace-nowrap space-x-1">
                          <button
                            type="button"
                            onClick={() => {
                              setMovForm({ type: 'outbound', quantity: 25, destinationWarehouseId: '', reason: '' });
                              setMovementModal({ stock: item, mode: 'dispatch' });
                            }}
                            className="px-2 py-1 rounded border border-slate-200 dark:border-slate-700 hover:border-cyan-500 text-[11px]"
                            title="Dispatch outbound stock"
                          >
                            Dispatch
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              const otherWh = warehouses.find((w) => w.id !== item.warehouseId);
                              setMovForm({
                                type: 'transfer',
                                quantity: 25,
                                destinationWarehouseId: otherWh?.id || '',
                                reason: '',
                              });
                              setMovementModal({ stock: item, mode: 'transfer' });
                            }}
                            disabled={warehouses.length < 2}
                            className="px-2 py-1 rounded border border-slate-200 dark:border-slate-700 hover:border-cyan-500 text-[11px] disabled:opacity-40"
                            title="Transfer stock to another warehouse"
                          >
                            Transfer
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setMovForm({ type: 'adjustment', quantity: 10, destinationWarehouseId: '', reason: '' });
                              setMovementModal({ stock: item, mode: 'adjust' });
                            }}
                            className="px-2 py-1 rounded border border-slate-200 dark:border-slate-700 hover:border-amber-500 text-[11px]"
                            title="Adjust / Damage / Return"
                          >
                            Adjust
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>

          {/* Immutable Stock Movement Ledger */}
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/80 p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div className="text-sm font-semibold text-slate-900 dark:text-white flex items-center gap-2">
                <ArrowRightLeft className="w-4 h-4 text-cyan-500" />
                Immutable Stock Movement Ledger ({movements.length})
              </div>
              <button
                type="button"
                onClick={refreshAll}
                className="text-xs text-slate-500 hover:text-cyan-500 inline-flex items-center gap-1"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                Refresh
              </button>
            </div>
            {movements.length === 0 ? (
              <div className="text-xs text-slate-500">No stock movements recorded yet.</div>
            ) : (
              <div className="divide-y divide-slate-200 dark:divide-slate-800 max-h-72 overflow-y-auto text-xs tabular-nums">
                {movements.slice(0, 30).map((m) => (
                  <div key={m.id} className="py-2 flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0">
                      <span className="font-mono uppercase text-[11px] font-semibold text-cyan-600 dark:text-cyan-400 mr-2">
                        {m.type}
                      </span>
                      <span className="font-medium text-slate-800 dark:text-slate-100">{m.itemName}</span>
                      <span className="text-slate-500">
                        {' '}
                        · {warehouseName(m.warehouseId)} · {m.reason}
                      </span>
                    </div>
                    <div className="font-mono text-[11px] text-slate-500 whitespace-nowrap">
                      Qty {m.quantity} · Avail {m.previousAvailable} → {m.newAvailable} · {m.actor}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* =====================================================================
          TAB 2: WAREHOUSE MANAGEMENT SYSTEM
         ===================================================================== */}
      {tab === 'warehouses' && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2.5 text-xs">
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative">
                <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-2.5" />
                <input
                  value={whSearch}
                  onChange={(e) => setWhSearch(e.target.value)}
                  placeholder="Search warehouse or manager..."
                  className="pl-8 pr-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 w-52"
                />
              </div>
              <input
                value={whDistrictFilter}
                onChange={(e) => setWhDistrictFilter(e.target.value)}
                placeholder="Filter district..."
                className="px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 w-36"
              />
              <select
                value={whStatusFilter}
                onChange={(e) => setWhStatusFilter(e.target.value)}
                className="px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900"
              >
                <option value="all">All Statuses</option>
                {WAREHOUSE_STATUSES.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
              <select
                value={whTypeFilter}
                onChange={(e) => setWhTypeFilter(e.target.value)}
                className="px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900"
              >
                <option value="all">All Types</option>
                {WAREHOUSE_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
              <input
                type="number"
                value={whMinCap}
                onChange={(e) => setWhMinCap(e.target.value)}
                placeholder="Min capacity"
                className="px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 w-28"
              />
            </div>
            <button
              type="button"
              onClick={() => {
                setEditingWh(null);
                setWhForm({
                  name: '',
                  warehouseType: 'regional_depot',
                  location: '',
                  region: '',
                  district: '',
                  state: '',
                  country: 'India',
                  lat: 13.05,
                  lng: 80.22,
                  managerName: '',
                  capacityUnits: 25000,
                  status: 'operational',
                  contact: '+91-44-5550-0200',
                  operatingHours: '24/7 Emergency Operations',
                  accessibility: 'high',
                });
                setShowWhModal(true);
              }}
              className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-[#5869E8] hover:bg-[#4758D6] dark:bg-[#6D7CFF] dark:hover:bg-[#8190FF] text-white text-xs font-medium"
            >
              <Plus className="w-3.5 h-3.5" />
              Register Warehouse
            </button>
          </div>

          {filteredWarehouses.length === 0 ? (
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/80 p-10 text-center text-sm text-slate-500">
              No warehouses found in {mode.toUpperCase()} mode matching current filters.
            </div>
          ) : (
            <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-4">
              {filteredWarehouses.map((wh) => {
                const whInv = inventory.filter((i) => i.warehouseId === wh.id);
                const pct = wh.capacityUnits > 0 ? Math.min(100, Math.round((wh.usedUnits / wh.capacityUnits) * 100)) : 0;
                const isInactive = wh.active === false || wh.status === 'closed' || wh.status === 'temporarily_unavailable';
                return (
                  <div
                    key={wh.id}
                    className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/80 p-4 space-y-3 flex flex-col justify-between"
                  >
                    <div className="space-y-2">
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <div className="text-sm font-semibold text-slate-900 dark:text-white">{wh.name}</div>
                          <div className="text-[11px] text-slate-500">
                            {(wh.warehouseType || 'regional_depot').replace(/_/g, ' ')} · {wh.district || wh.region}
                            {wh.state ? `, ${wh.state}` : ''}
                          </div>
                        </div>
                        <span
                          className={`text-[11px] font-mono uppercase font-semibold ${
                            wh.status === 'operational'
                              ? 'text-emerald-600 dark:text-emerald-400'
                              : wh.status === 'limited'
                              ? 'text-amber-600 dark:text-amber-400'
                              : 'text-red-600 dark:text-red-400'
                          }`}
                        >
                          {wh.status.replace(/_/g, ' ')}
                        </span>
                      </div>

                      <div className="text-xs text-slate-600 dark:text-slate-400 space-y-0.5">
                        <div>{wh.location}</div>
                        <div className="font-mono text-[11px] text-slate-500 tabular-nums">
                          {wh.lat.toFixed(4)}, {wh.lng.toFixed(4)} · Mgr: {wh.managerName || 'Unassigned'} · {wh.contact}
                        </div>
                      </div>

                      <div className="space-y-1 text-xs tabular-nums">
                        <div className="flex justify-between text-slate-500">
                          <span>Occupancy ({whInv.length} SKUs)</span>
                          <span className="font-mono">
                            {wh.usedUnits.toLocaleString()} / {wh.capacityUnits.toLocaleString()} ({pct}%)
                          </span>
                        </div>
                        <div className="h-1.5 rounded-full bg-slate-200 dark:bg-slate-800 overflow-hidden">
                          <div className="h-full bg-cyan-500" style={{ width: `${pct}%` }} />
                        </div>
                      </div>

                      <div className="text-[11px] font-mono text-slate-500">
                        Access: {wh.accessibility.toUpperCase()} · Hours: {wh.operatingHours}
                      </div>
                    </div>

                    <div className="pt-2 border-t border-slate-200 dark:border-slate-800 flex flex-wrap items-center gap-1.5 text-[11px]">
                      <button
                        type="button"
                        onClick={() => openWarehouseSummary(wh.id)}
                        className="px-2.5 py-1 rounded-md bg-cyan-600/10 text-cyan-700 dark:text-cyan-300 border border-cyan-500/30 hover:bg-cyan-600/20 font-medium"
                      >
                        Inspect Detail
                      </button>
                      <button
                        type="button"
                        onClick={() => openEditWarehouse(wh)}
                        className="px-2 py-1 rounded-md border border-slate-200 dark:border-slate-700 hover:border-cyan-500 inline-flex items-center gap-1"
                      >
                        <Edit3 className="w-3 h-3" />
                        Edit
                      </button>
                      <button
                        type="button"
                        onClick={() => handleToggleWarehouseActive(wh)}
                        disabled={busy === wh.id}
                        className="px-2 py-1 rounded-md border border-slate-200 dark:border-slate-700 hover:border-amber-500"
                      >
                        {isInactive ? 'Activate' : 'Deactivate'}
                      </button>
                      {onNavigate && (
                        <button
                          type="button"
                          onClick={() => onNavigate('map')}
                          className="ml-auto text-slate-500 hover:text-cyan-500 inline-flex items-center gap-1"
                        >
                          <MapPin className="w-3 h-3" />
                          Map
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Warehouse Detail & Supply Summary Drawer */}
          {(loadingSummary || selectedWhSummary) && (
            <div className="rounded-xl border border-cyan-500/40 bg-white dark:bg-slate-900 p-5 space-y-4">
              {loadingSummary ? (
                <div className="text-xs text-slate-500">Loading warehouse live summary...</div>
              ) : (
                selectedWhSummary && (
                  <>
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="text-xs font-mono uppercase text-cyan-600 dark:text-cyan-400">
                          Warehouse Operations Summary
                        </div>
                        <h3 className="text-base font-semibold text-slate-900 dark:text-white">
                          {selectedWhSummary.warehouse.name}
                        </h3>
                        <p className="text-xs text-slate-500">
                          {selectedWhSummary.warehouse.location} · Verified{' '}
                          {new Date(selectedWhSummary.warehouse.lastVerified).toLocaleString()}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => setSelectedWhSummary(null)}
                        className="text-slate-400 hover:text-slate-200"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>

                    <div className="grid grid-cols-2 md:grid-cols-5 gap-3 text-xs tabular-nums">
                      <div className="p-3 rounded-lg border border-slate-200 dark:border-slate-800">
                        <div className="text-slate-500">Available Units</div>
                        <div className="text-base font-semibold font-mono text-emerald-600 dark:text-emerald-400">
                          {selectedWhSummary.stats.totalAvailable.toLocaleString()}
                        </div>
                      </div>
                      <div className="p-3 rounded-lg border border-slate-200 dark:border-slate-800">
                        <div className="text-slate-500">Reserved Units</div>
                        <div className="text-base font-semibold font-mono">
                          {selectedWhSummary.stats.totalReserved.toLocaleString()}
                        </div>
                      </div>
                      <div className="p-3 rounded-lg border border-slate-200 dark:border-slate-800">
                        <div className="text-slate-500">Active Reservations</div>
                        <div className="text-base font-semibold font-mono">
                          {selectedWhSummary.activeReservations.length}
                        </div>
                      </div>
                      <div className="p-3 rounded-lg border border-slate-200 dark:border-slate-800">
                        <div className="text-slate-500">Pending Outgoing</div>
                        <div className="text-base font-semibold font-mono">
                          {selectedWhSummary.pendingOutgoingDispatches.length}
                        </div>
                      </div>
                      <div className="p-3 rounded-lg border border-slate-200 dark:border-slate-800">
                        <div className="text-slate-500">Incoming Orders</div>
                        <div className="text-base font-semibold font-mono text-cyan-600 dark:text-cyan-400">
                          {selectedWhSummary.incomingSupplies.length}
                        </div>
                      </div>
                    </div>

                    <div className="grid md:grid-cols-2 gap-4 text-xs">
                      <div className="space-y-1.5">
                        <div className="font-semibold text-slate-800 dark:text-slate-200">
                          Warehouse Stock ({selectedWhSummary.inventory.length})
                        </div>
                        {selectedWhSummary.inventory.length === 0 ? (
                          <div className="text-slate-500">No inventory assigned to this warehouse.</div>
                        ) : (
                          selectedWhSummary.inventory.map((i) => (
                            <div
                              key={i.id}
                              className="flex justify-between py-1 border-b border-slate-100 dark:border-slate-800 tabular-nums"
                            >
                              <span>{i.itemName}</span>
                              <span className={`font-mono ${stockStatusColor(i.stockStatus)}`}>
                                {i.availableQty} avail / {i.reservedQty} rsv ({i.stockStatus})
                              </span>
                            </div>
                          ))
                        )}
                      </div>
                      <div className="space-y-1.5">
                        <div className="font-semibold text-slate-800 dark:text-slate-200">
                          Incoming Supply &amp; Assigned Vehicles
                        </div>
                        {selectedWhSummary.incomingSupplies.length === 0 ? (
                          <div className="text-slate-500">No pending incoming supply shipments.</div>
                        ) : (
                          selectedWhSummary.incomingSupplies.map((s) => (
                            <div
                              key={s.id}
                              className="flex justify-between py-1 border-b border-slate-100 dark:border-slate-800"
                            >
                              <span>
                                {s.trackingReference} · {s.supplier}
                              </span>
                              <span className="font-mono text-cyan-600 dark:text-cyan-400">{s.status}</span>
                            </div>
                          ))
                        )}
                        <div className="pt-2 text-slate-500 font-mono text-[11px]">
                          Fleet Assigned: {selectedWhSummary.vehicles.map((v) => `${v.callsign} (${v.status})`).join(' · ') || 'None'}
                        </div>
                      </div>
                    </div>
                  </>
                )
              )}
            </div>
          )}
        </div>
      )}

      {/* =====================================================================
          TAB 3: CONCURRENCY-SAFE STOCK RESERVATIONS
         ===================================================================== */}
      {tab === 'reservations' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="text-xs text-slate-500">
              Lifecycle: Requested → Reserved / Partially Reserved → Allocated → Dispatched → Delivered · Atomic per-stock locking prevents double allocation
            </div>
            <button
              type="button"
              onClick={() => setShowReservationModal(true)}
              disabled={inventory.length === 0}
              className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-[#5869E8] hover:bg-[#4758D6] dark:bg-[#6D7CFF] dark:hover:bg-[#8190FF] text-white text-xs font-medium disabled:opacity-40"
            >
              <Plus className="w-3.5 h-3.5" />
              Reserve Stock
            </button>
          </div>

          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/80 overflow-x-auto">
            {reservations.length === 0 ? (
              <div className="p-10 text-center text-sm text-slate-500">
                No stock reservations recorded in {mode.toUpperCase()} mode.
              </div>
            ) : (
              <table className="w-full text-left text-xs">
                <thead className="border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/60 text-slate-500 font-mono uppercase">
                  <tr>
                    <th className="py-2.5 px-3">Resource &amp; Warehouse</th>
                    <th className="py-2.5 px-3 text-right">Reserved / Req</th>
                    <th className="py-2.5 px-3">Status</th>
                    <th className="py-2.5 px-3">Expires</th>
                    <th className="py-2.5 px-3">Reserved By</th>
                    <th className="py-2.5 px-3 text-right">Lifecycle Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 dark:divide-slate-800 tabular-nums">
                  {reservations.map((r) => (
                    <tr key={r.id}>
                      <td className="py-2.5 px-3">
                        <div className="font-medium text-slate-900 dark:text-white">{r.itemName}</div>
                        <div className="text-[11px] text-slate-500 font-mono">
                          {r.warehouseName} {r.requestId ? `· Req ${r.requestId.slice(0, 8)}` : ''}
                        </div>
                      </td>
                      <td className="py-2.5 px-3 text-right font-mono font-semibold">
                        {r.reservedQty.toLocaleString()} / {r.requestedQty.toLocaleString()} {r.unit}
                      </td>
                      <td className="py-2.5 px-3 font-mono text-[11px]">
                        <span
                          className={
                            r.status === 'Delivered' || r.status === 'Dispatched'
                              ? 'text-emerald-600 dark:text-emerald-400 font-semibold'
                              : r.status === 'Expired' || r.status === 'Reservation Released'
                              ? 'text-slate-500'
                              : 'text-cyan-600 dark:text-cyan-400 font-semibold'
                          }
                        >
                          {r.status}
                        </span>
                      </td>
                      <td className="py-2.5 px-3 font-mono text-[11px] text-slate-500">
                        {new Date(r.expiresAt).toLocaleString()}
                      </td>
                      <td className="py-2.5 px-3 text-slate-600 dark:text-slate-300">{r.reservedBy}</td>
                      <td className="py-2.5 px-3 text-right whitespace-nowrap space-x-1">
                        {(r.status === 'Reserved' || r.status === 'Partially Reserved') && (
                          <button
                            type="button"
                            disabled={busy === r.id}
                            onClick={() => handleReservationAction(r.id, 'Allocated')}
                            className="px-2 py-1 rounded border border-cyan-500/40 text-cyan-600 dark:text-cyan-400 text-[11px]"
                          >
                            Allocate
                          </button>
                        )}
                        {(r.status === 'Reserved' || r.status === 'Partially Reserved' || r.status === 'Allocated') && (
                          <>
                            <button
                              type="button"
                              disabled={busy === r.id}
                              onClick={() => handleReservationAction(r.id, 'Dispatched')}
                              className="px-2 py-1 rounded border border-emerald-500/40 text-emerald-600 dark:text-emerald-400 text-[11px]"
                            >
                              Dispatch
                            </button>
                            <button
                              type="button"
                              disabled={busy === r.id}
                              onClick={() => handleReservationAction(r.id, 'release')}
                              className="px-2 py-1 rounded border border-amber-500/40 text-amber-600 dark:text-amber-400 text-[11px]"
                            >
                              Release
                            </button>
                          </>
                        )}
                        {r.status === 'Dispatched' && (
                          <button
                            type="button"
                            disabled={busy === r.id}
                            onClick={() => handleReservationAction(r.id, 'Delivered')}
                            className="px-2 py-1 rounded border border-emerald-500/40 text-emerald-600 dark:text-emerald-400 text-[11px]"
                          >
                            Mark Delivered
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {/* =====================================================================
          TAB 4: SHORTAGES & REPLENISHMENT INTELLIGENCE
         ===================================================================== */}
      {tab === 'shortages' && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3 text-xs tabular-nums">
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/80 p-3.5">
              <div className="text-slate-500">Out of Stock</div>
              <div className="text-2xl font-bold font-mono text-red-600 dark:text-red-400">
                {shortagesData?.summary.outOfStockCount ?? 0}
              </div>
            </div>
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/80 p-3.5">
              <div className="text-slate-500">Critical Level</div>
              <div className="text-2xl font-bold font-mono text-orange-600 dark:text-orange-400">
                {shortagesData?.summary.criticalCount ?? 0}
              </div>
            </div>
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/80 p-3.5">
              <div className="text-slate-500">Low Stock</div>
              <div className="text-2xl font-bold font-mono text-amber-600 dark:text-amber-400">
                {shortagesData?.summary.lowCount ?? 0}
              </div>
            </div>
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/80 p-3.5">
              <div className="text-slate-500">Overstocked SKUs</div>
              <div className="text-2xl font-bold font-mono text-cyan-600 dark:text-cyan-400">
                {shortagesData?.summary.overstockedCount ?? 0}
              </div>
            </div>
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/80 p-3.5">
              <div className="text-slate-500">Depot Imbalances</div>
              <div className="text-2xl font-bold font-mono text-violet-600 dark:text-violet-400">
                {shortagesData?.summary.imbalanceCount ?? 0}
              </div>
            </div>
          </div>

          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/80 overflow-x-auto">
            {!shortagesData || shortagesData.recommendations.length === 0 ? (
              <div className="p-10 text-center text-sm text-slate-500">
                No low, critical, or out-of-stock shortages detected in {mode.toUpperCase()} mode.
              </div>
            ) : (
              <table className="w-full text-left text-xs">
                <thead className="border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/60 text-slate-500 font-mono uppercase">
                  <tr>
                    <th className="py-2.5 px-3">Resource &amp; Warehouse</th>
                    <th className="py-2.5 px-3">Level</th>
                    <th className="py-2.5 px-3 text-right">Available / Min</th>
                    <th className="py-2.5 px-3 text-right">Incoming</th>
                    <th className="py-2.5 px-3 text-right">Rec. Replenish</th>
                    <th className="py-2.5 px-3">Historical Daily Demand</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 dark:divide-slate-800 tabular-nums">
                  {shortagesData.recommendations.map((rec) => (
                    <tr key={rec.stockId}>
                      <td className="py-2.5 px-3">
                        <div className="font-medium text-slate-900 dark:text-white">{rec.itemName}</div>
                        <div className="text-[11px] text-slate-500">{rec.warehouseName}</div>
                      </td>
                      <td className={`py-2.5 px-3 font-mono ${stockStatusColor(rec.alertLevel)}`}>
                        {rec.alertLevel.replace(/_/g, ' ')}
                      </td>
                      <td className="py-2.5 px-3 text-right font-mono">
                        {rec.currentAvailable} / {rec.minThreshold}
                      </td>
                      <td className="py-2.5 px-3 text-right font-mono text-cyan-600 dark:text-cyan-400">
                        +{rec.incomingSupplyQty}
                      </td>
                      <td className="py-2.5 px-3 text-right font-mono font-semibold text-slate-900 dark:text-white">
                        {rec.recommendedReplenishmentQty}
                      </td>
                      <td className="py-2.5 px-3 text-slate-500 font-mono text-[11px]">
                        {rec.averageDemandLabel}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {shortagesData && shortagesData.imbalances.length > 0 && (
            <div className="rounded-xl border border-amber-500/40 bg-amber-500/5 p-4 space-y-2 text-xs">
              <div className="font-semibold text-amber-700 dark:text-amber-300 flex items-center gap-1.5">
                <AlertTriangle className="w-4 h-4" />
                Inter-Warehouse Rebalancing Suggestions
              </div>
              {shortagesData.imbalances.map((imb, i) => (
                <div key={`${imb.sku}-${i}`} className="text-slate-700 dark:text-slate-300">
                  Transfer <span className="font-mono font-semibold">{imb.suggestedTransferQty}</span> units of{' '}
                  <span className="font-medium">{imb.itemName}</span> from{' '}
                  <span className="font-medium">{imb.surplusWarehouse}</span> →{' '}
                  <span className="font-medium">{imb.deficitWarehouse}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* =====================================================================
          TAB 5: EXPIRY & BATCH MONITORING
         ===================================================================== */}
      {tab === 'expiry' && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-xs text-slate-500">
              Expired batches are automatically quarantined and excluded from usable inventory. Non-expiring items (null expiry) are never flagged expired.
            </div>
            <button
              type="button"
              onClick={() => setShowBatchModal(true)}
              disabled={inventory.length === 0}
              className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-[#5869E8] hover:bg-[#4758D6] dark:bg-[#6D7CFF] dark:hover:bg-[#8190FF] text-white text-xs font-medium disabled:opacity-40"
            >
              <Plus className="w-3.5 h-3.5" />
              Register Batch / Lot
            </button>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-5 gap-3 text-xs tabular-nums">
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/80 p-3.5">
              <div className="text-slate-500">Expired (Quarantined)</div>
              <div className="text-2xl font-bold font-mono text-red-600 dark:text-red-400">
                {expiryData?.summary.expiredCount ?? 0}
              </div>
            </div>
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/80 p-3.5">
              <div className="text-slate-500">Expiring ≤ 7 Days</div>
              <div className="text-2xl font-bold font-mono text-orange-600 dark:text-orange-400">
                {expiryData?.summary.expiring7dCount ?? 0}
              </div>
            </div>
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/80 p-3.5">
              <div className="text-slate-500">Expiring ≤ 30 Days</div>
              <div className="text-2xl font-bold font-mono text-amber-600 dark:text-amber-400">
                {expiryData?.summary.expiring30dCount ?? 0}
              </div>
            </div>
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/80 p-3.5">
              <div className="text-slate-500">Expiring ≤ 90 Days</div>
              <div className="text-2xl font-bold font-mono text-cyan-600 dark:text-cyan-400">
                {expiryData?.summary.expiring90dCount ?? 0}
              </div>
            </div>
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/80 p-3.5">
              <div className="text-slate-500">Non-Expiring Gear</div>
              <div className="text-2xl font-bold font-mono text-slate-700 dark:text-slate-200">
                {expiryData?.summary.noExpiryCount ?? 0}
              </div>
            </div>
          </div>

          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/80 overflow-x-auto">
            {!expiryData || expiryData.summary.totalBatches === 0 ? (
              <div className="p-10 text-center text-sm text-slate-500">
                No tracked batches recorded in {mode.toUpperCase()} mode.
              </div>
            ) : (
              <table className="w-full text-left text-xs">
                <thead className="border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/60 text-slate-500 font-mono uppercase">
                  <tr>
                    <th className="py-2.5 px-3">Lot &amp; Resource</th>
                    <th className="py-2.5 px-3">Warehouse · Bay</th>
                    <th className="py-2.5 px-3 text-right">Qty</th>
                    <th className="py-2.5 px-3">Expiry Date</th>
                    <th className="py-2.5 px-3">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 dark:divide-slate-800 tabular-nums">
                  {[
                    ...expiryData.expired,
                    ...expiryData.expiring7d,
                    ...expiryData.expiring30d,
                    ...expiryData.expiring90d,
                    ...expiryData.healthy,
                    ...expiryData.noExpiry,
                  ].map((b) => (
                    <tr key={b.id}>
                      <td className="py-2.5 px-3">
                        <div className="font-medium text-slate-900 dark:text-white">{b.itemName}</div>
                        <div className="font-mono text-[11px] text-slate-500">
                          {b.lotNumber} · {b.sku}
                        </div>
                      </td>
                      <td className="py-2.5 px-3 text-slate-600 dark:text-slate-300">
                        {warehouseName(b.warehouseId)} · {b.batchLocation}
                      </td>
                      <td className="py-2.5 px-3 text-right font-mono font-semibold">{b.quantity.toLocaleString()}</td>
                      <td className="py-2.5 px-3 font-mono text-[11px]">
                        {b.expiryDate ? new Date(b.expiryDate).toLocaleDateString() : 'No Expiry'}
                      </td>
                      <td className="py-2.5 px-3 font-mono text-[11px]">
                        {b.daysRemaining === null ? (
                          <span className="text-slate-500">NON-EXPIRING</span>
                        ) : b.daysRemaining <= 0 ? (
                          <span className="text-red-600 dark:text-red-400 font-semibold">EXPIRED (QUARANTINED)</span>
                        ) : b.daysRemaining <= 7 ? (
                          <span className="text-orange-600 dark:text-orange-400 font-semibold">
                            {b.daysRemaining}d LEFT · PRIORITY DISPATCH
                          </span>
                        ) : (
                          <span className="text-emerald-600 dark:text-emerald-400">{b.daysRemaining}d remaining</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {/* =====================================================================
          TAB 6: INCOMING SUPPLY & PROCUREMENT TRACKING
         ===================================================================== */}
      {tab === 'incoming' && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-xs text-slate-500">
              Incoming supplies are tracked separately from available inventory until marked Received and explicitly Verified.
            </div>
            <button
              type="button"
              onClick={() => setShowSupplyModal(true)}
              disabled={warehouses.length === 0}
              className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-[#5869E8] hover:bg-[#4758D6] dark:bg-[#6D7CFF] dark:hover:bg-[#8190FF] text-white text-xs font-medium disabled:opacity-40"
            >
              <Plus className="w-3.5 h-3.5" />
              Register Incoming Supply
            </button>
          </div>

          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/80 overflow-x-auto">
            {incomingSupplies.length === 0 ? (
              <div className="p-10 text-center text-sm text-slate-500">
                No incoming supply shipments registered in {mode.toUpperCase()} mode.
              </div>
            ) : (
              <table className="w-full text-left text-xs">
                <thead className="border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/60 text-slate-500 font-mono uppercase">
                  <tr>
                    <th className="py-2.5 px-3">Tracking &amp; Supplier</th>
                    <th className="py-2.5 px-3">Destination</th>
                    <th className="py-2.5 px-3">Items</th>
                    <th className="py-2.5 px-3">Expected ETA</th>
                    <th className="py-2.5 px-3">Status</th>
                    <th className="py-2.5 px-3 text-right">Receiving Workflow</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 dark:divide-slate-800 tabular-nums">
                  {incomingSupplies.map((sup) => (
                    <tr key={sup.id}>
                      <td className="py-2.5 px-3">
                        <div className="font-mono font-semibold text-slate-900 dark:text-white">
                          {sup.trackingReference}
                        </div>
                        <div className="text-[11px] text-slate-500">{sup.supplier}</div>
                      </td>
                      <td className="py-2.5 px-3 text-slate-600 dark:text-slate-300">{sup.warehouseName}</td>
                      <td className="py-2.5 px-3">
                        {sup.items.map((it) => (
                          <div key={it.sku} className="font-mono text-[11px]">
                            {it.itemName}: {it.orderedQty} ord
                            {it.receivedQty > 0 ? ` · ${it.receivedQty} rcv` : ''}
                            {it.damagedQty > 0 ? ` · ${it.damagedQty} dmg` : ''}
                          </div>
                        ))}
                      </td>
                      <td className="py-2.5 px-3 font-mono text-[11px] text-slate-500">
                        {new Date(sup.expectedArrival).toLocaleDateString()}
                      </td>
                      <td className="py-2.5 px-3 font-mono text-[11px]">
                        <span
                          className={
                            sup.status === 'Verified'
                              ? 'text-emerald-600 dark:text-emerald-400 font-semibold'
                              : sup.status === 'Delayed' || sup.verificationStatus === 'discrepancy'
                              ? 'text-amber-600 dark:text-amber-400 font-semibold'
                              : 'text-cyan-600 dark:text-cyan-400'
                          }
                        >
                          {sup.status}
                        </span>
                        {sup.verificationStatus === 'discrepancy' && (
                          <div className="text-amber-600 dark:text-amber-400 text-[10px]">DISCREPANCY LOGGED</div>
                        )}
                      </td>
                      <td className="py-2.5 px-3 text-right whitespace-nowrap space-x-1">
                        {sup.status !== 'Received' &&
                          sup.status !== 'Partially Received' &&
                          sup.status !== 'Verified' &&
                          sup.status !== 'Cancelled' && (
                            <button
                              type="button"
                              onClick={() => openReceiveSupplyModal(sup)}
                              className="px-2.5 py-1 rounded border border-cyan-500/40 text-cyan-600 dark:text-cyan-400 text-[11px]"
                            >
                              Record Arrival
                            </button>
                          )}
                        {(sup.status === 'Received' || sup.status === 'Partially Received') && (
                          <button
                            type="button"
                            disabled={busy === sup.id}
                            onClick={() => handleVerifyIncomingSupply(sup.id)}
                            className="px-2.5 py-1 rounded bg-emerald-600 hover:bg-emerald-500 text-white text-[11px] inline-flex items-center gap-1"
                          >
                            <PackageCheck className="w-3 h-3" />
                            Verify into Stock
                          </button>
                        )}
                        {sup.status === 'Verified' && (
                          <span className="text-emerald-600 dark:text-emerald-400 font-mono text-[11px] inline-flex items-center gap-1">
                            <CheckCircle2 className="w-3 h-3" />
                            Verified
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {/* =====================================================================
          MODALS
         ===================================================================== */}

      {/* Add / Edit Warehouse Modal */}
      {showWhModal && (
        <div className="fixed inset-0 z-50 bg-slate-950/70 flex items-center justify-center p-4">
          <form
            onSubmit={handleSaveWarehouse}
            className="w-full max-w-xl rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-5 space-y-3 text-xs max-h-[90vh] overflow-y-auto"
          >
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-slate-900 dark:text-white">
                {editingWh ? 'Edit Warehouse' : 'Register Relief Warehouse'}
              </h2>
              <button type="button" onClick={() => setShowWhModal(false)}>
                <X className="w-4 h-4 text-slate-400" />
              </button>
            </div>
            <div className="grid sm:grid-cols-2 gap-3">
              <label className="space-y-1">
                <span className="text-slate-500">Warehouse Name *</span>
                <input
                  required
                  value={whForm.name}
                  onChange={(e) => setWhForm({ ...whForm, name: e.target.value })}
                  className="w-full px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                />
              </label>
              <label className="space-y-1">
                <span className="text-slate-500">Warehouse Type</span>
                <select
                  value={whForm.warehouseType}
                  onChange={(e) => setWhForm({ ...whForm, warehouseType: e.target.value as WarehouseType })}
                  className="w-full px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                >
                  {WAREHOUSE_TYPES.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="space-y-1 sm:col-span-2">
                <span className="text-slate-500">Street Address / Location *</span>
                <input
                  required
                  value={whForm.location}
                  onChange={(e) => setWhForm({ ...whForm, location: e.target.value })}
                  className="w-full px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                />
              </label>
              <label className="space-y-1">
                <span className="text-slate-500">Region / Zone *</span>
                <input
                  required
                  value={whForm.region}
                  onChange={(e) => setWhForm({ ...whForm, region: e.target.value, district: whForm.district || e.target.value })}
                  className="w-full px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                />
              </label>
              <label className="space-y-1">
                <span className="text-slate-500">District</span>
                <input
                  value={whForm.district}
                  onChange={(e) => setWhForm({ ...whForm, district: e.target.value })}
                  className="w-full px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                />
              </label>
              <label className="space-y-1">
                <span className="text-slate-500">State</span>
                <input
                  value={whForm.state}
                  onChange={(e) => setWhForm({ ...whForm, state: e.target.value })}
                  className="w-full px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                />
              </label>
              <label className="space-y-1">
                <span className="text-slate-500">Manager Name</span>
                <input
                  value={whForm.managerName}
                  onChange={(e) => setWhForm({ ...whForm, managerName: e.target.value })}
                  className="w-full px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                />
              </label>
              <label className="space-y-1">
                <span className="text-slate-500">Latitude *</span>
                <input
                  type="number"
                  step="any"
                  required
                  value={whForm.lat}
                  onChange={(e) => setWhForm({ ...whForm, lat: Number(e.target.value) })}
                  className="w-full px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                />
              </label>
              <label className="space-y-1">
                <span className="text-slate-500">Longitude *</span>
                <input
                  type="number"
                  step="any"
                  required
                  value={whForm.lng}
                  onChange={(e) => setWhForm({ ...whForm, lng: Number(e.target.value) })}
                  className="w-full px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                />
              </label>
              <label className="space-y-1">
                <span className="text-slate-500">Storage Capacity (Units) *</span>
                <input
                  type="number"
                  required
                  min={1}
                  value={whForm.capacityUnits}
                  onChange={(e) => setWhForm({ ...whForm, capacityUnits: Number(e.target.value) })}
                  className="w-full px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                />
              </label>
              <label className="space-y-1">
                <span className="text-slate-500">Operational Status</span>
                <select
                  value={whForm.status}
                  onChange={(e) => setWhForm({ ...whForm, status: e.target.value as WarehouseStatus })}
                  className="w-full px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                >
                  {WAREHOUSE_STATUSES.map((s) => (
                    <option key={s.value} value={s.value}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="space-y-1">
                <span className="text-slate-500">Contact</span>
                <input
                  value={whForm.contact}
                  onChange={(e) => setWhForm({ ...whForm, contact: e.target.value })}
                  className="w-full px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                />
              </label>
              <label className="space-y-1">
                <span className="text-slate-500">Accessibility</span>
                <select
                  value={whForm.accessibility}
                  onChange={(e) =>
                    setWhForm({ ...whForm, accessibility: e.target.value as Warehouse['accessibility'] })
                  }
                  className="w-full px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                >
                  <option value="high">High (Heavy Vehicles)</option>
                  <option value="moderate">Moderate</option>
                  <option value="restricted">Restricted</option>
                </select>
              </label>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={() => setShowWhModal(false)} className="px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700">
                Cancel
              </button>
              <button
                type="submit"
                disabled={busy === 'wh'}
                className="px-4 py-1.5 rounded-lg bg-[#5869E8] hover:bg-[#4758D6] dark:bg-[#6D7CFF] dark:hover:bg-[#8190FF] text-white font-medium"
              >
                {editingWh ? 'Save Changes' : 'Register Warehouse'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Add Catalog SKU Modal */}
      {showCatalogModal && (
        <div className="fixed inset-0 z-50 bg-slate-950/70 flex items-center justify-center p-4">
          <form
            onSubmit={handleCreateCatalogItem}
            className="w-full max-w-lg rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-5 space-y-3 text-xs"
          >
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-slate-900 dark:text-white">Add Relief Inventory Catalog Item</h2>
              <button type="button" onClick={() => setShowCatalogModal(false)}>
                <X className="w-4 h-4 text-slate-400" />
              </button>
            </div>
            <div className="grid sm:grid-cols-2 gap-3">
              <label className="space-y-1">
                <span className="text-slate-500">SKU *</span>
                <input
                  required
                  value={catForm.sku}
                  onChange={(e) => setCatForm({ ...catForm, sku: e.target.value })}
                  placeholder="e.g. FOD-RIC-011"
                  className="w-full px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                />
              </label>
              <label className="space-y-1">
                <span className="text-slate-500">Item Name *</span>
                <input
                  required
                  value={catForm.name}
                  onChange={(e) => setCatForm({ ...catForm, name: e.target.value })}
                  placeholder="e.g. Dry Food Ration Kits"
                  className="w-full px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                />
              </label>
              <label className="space-y-1">
                <span className="text-slate-500">Category</span>
                <select
                  value={catForm.category}
                  onChange={(e) => setCatForm({ ...catForm, category: e.target.value as ResourceCategory })}
                  className="w-full px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                >
                  {RESOURCE_CATEGORIES.map((c) => (
                    <option key={c.value} value={c.value}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="space-y-1">
                <span className="text-slate-500">Unit</span>
                <input
                  required
                  value={catForm.unit}
                  onChange={(e) => setCatForm({ ...catForm, unit: e.target.value })}
                  className="w-full px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                />
              </label>
              <label className="space-y-1">
                <span className="text-slate-500">Min Threshold</span>
                <input
                  type="number"
                  min={0}
                  value={catForm.minStock}
                  onChange={(e) => setCatForm({ ...catForm, minStock: Number(e.target.value) })}
                  className="w-full px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                />
              </label>
              <label className="space-y-1">
                <span className="text-slate-500">Critical Threshold</span>
                <input
                  type="number"
                  min={0}
                  value={catForm.criticalStock}
                  onChange={(e) => setCatForm({ ...catForm, criticalStock: Number(e.target.value) })}
                  className="w-full px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                />
              </label>
              <label className="space-y-1 sm:col-span-2">
                <span className="text-slate-500">Supplier</span>
                <input
                  value={catForm.supplier}
                  onChange={(e) => setCatForm({ ...catForm, supplier: e.target.value })}
                  placeholder="Verified relief supplier name"
                  className="w-full px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                />
              </label>
            </div>
            <label className="flex items-center gap-2 text-slate-600 dark:text-slate-300">
              <input
                type="checkbox"
                checked={catForm.expiryTracking}
                onChange={(e) => setCatForm({ ...catForm, expiryTracking: e.target.checked })}
              />
              Enable expiry &amp; batch shelf-life tracking
            </label>
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={() => setShowCatalogModal(false)} className="px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700">
                Cancel
              </button>
              <button type="submit" disabled={busy === 'cat'} className="px-4 py-1.5 rounded-lg bg-cyan-600 text-white font-medium">
                Create Catalog Item
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Receive Stock Modal */}
      {showReceiveModal && (
        <div className="fixed inset-0 z-50 bg-slate-950/70 flex items-center justify-center p-4">
          <form
            onSubmit={handleReceiveStock}
            className="w-full max-w-lg rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-5 space-y-3 text-xs"
          >
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-slate-900 dark:text-white">Receive Inbound Stock</h2>
              <button type="button" onClick={() => setShowReceiveModal(false)}>
                <X className="w-4 h-4 text-slate-400" />
              </button>
            </div>
            <div className="grid sm:grid-cols-2 gap-3">
              <label className="space-y-1 sm:col-span-2">
                <span className="text-slate-500">Target Warehouse *</span>
                <select
                  required
                  value={receiveForm.warehouseId}
                  onChange={(e) => setReceiveForm({ ...receiveForm, warehouseId: e.target.value })}
                  className="w-full px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                >
                  {warehouses.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="space-y-1">
                <span className="text-slate-500">SKU *</span>
                <input
                  required
                  value={receiveForm.sku}
                  onChange={(e) => setReceiveForm({ ...receiveForm, sku: e.target.value })}
                  className="w-full px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                />
              </label>
              <label className="space-y-1">
                <span className="text-slate-500">Item Name *</span>
                <input
                  required
                  value={receiveForm.itemName}
                  onChange={(e) => setReceiveForm({ ...receiveForm, itemName: e.target.value })}
                  className="w-full px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                />
              </label>
              <label className="space-y-1">
                <span className="text-slate-500">Category</span>
                <select
                  value={receiveForm.category}
                  onChange={(e) => setReceiveForm({ ...receiveForm, category: e.target.value as ResourceCategory })}
                  className="w-full px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                >
                  {RESOURCE_CATEGORIES.map((c) => (
                    <option key={c.value} value={c.value}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="space-y-1">
                <span className="text-slate-500">Quantity *</span>
                <input
                  type="number"
                  min={1}
                  required
                  value={receiveForm.quantity}
                  onChange={(e) => setReceiveForm({ ...receiveForm, quantity: Number(e.target.value) })}
                  className="w-full px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                />
              </label>
              <label className="space-y-1">
                <span className="text-slate-500">Lot Number (optional)</span>
                <input
                  value={receiveForm.lotNumber}
                  onChange={(e) => setReceiveForm({ ...receiveForm, lotNumber: e.target.value })}
                  className="w-full px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                />
              </label>
              <label className="space-y-1">
                <span className="text-slate-500">Expiry Date (optional)</span>
                <input
                  type="date"
                  value={receiveForm.expiryDate}
                  onChange={(e) => setReceiveForm({ ...receiveForm, expiryDate: e.target.value })}
                  className="w-full px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                />
              </label>
              <label className="space-y-1 sm:col-span-2">
                <span className="text-slate-500">Reason *</span>
                <input
                  required
                  value={receiveForm.reason}
                  onChange={(e) => setReceiveForm({ ...receiveForm, reason: e.target.value })}
                  className="w-full px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                />
              </label>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={() => setShowReceiveModal(false)} className="px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700">
                Cancel
              </button>
              <button type="submit" disabled={busy === 'receive'} className="px-4 py-1.5 rounded-lg bg-cyan-600 text-white font-medium">
                Commit Inbound Receipt
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Dispatch / Transfer / Adjust Modal */}
      {movementModal && (
        <div className="fixed inset-0 z-50 bg-slate-950/70 flex items-center justify-center p-4">
          <form
            onSubmit={handleStockOperation}
            className="w-full max-w-md rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-5 space-y-3 text-xs"
          >
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-slate-900 dark:text-white capitalize">
                {movementModal.mode} Stock — {movementModal.stock.itemName}
              </h2>
              <button type="button" onClick={() => setMovementModal(null)}>
                <X className="w-4 h-4 text-slate-400" />
              </button>
            </div>
            <div className="font-mono text-[11px] text-slate-500">
              {warehouseName(movementModal.stock.warehouseId)} · Available: {movementModal.stock.availableQty}{' '}
              {movementModal.stock.unit} · Version v{movementModal.stock.version}
            </div>
            {movementModal.mode === 'transfer' && (
              <label className="block space-y-1">
                <span className="text-slate-500">Destination Warehouse *</span>
                <select
                  required
                  value={movForm.destinationWarehouseId}
                  onChange={(e) => setMovForm({ ...movForm, destinationWarehouseId: e.target.value })}
                  className="w-full px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                >
                  {warehouses
                    .filter((w) => w.id !== movementModal.stock.warehouseId)
                    .map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.name} ({w.status})
                      </option>
                    ))}
                </select>
              </label>
            )}
            {movementModal.mode === 'adjust' && (
              <label className="block space-y-1">
                <span className="text-slate-500">Adjustment Type</span>
                <select
                  value={movForm.type}
                  onChange={(e) => setMovForm({ ...movForm, type: e.target.value as MovementType })}
                  className="w-full px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                >
                  <option value="adjustment">Cycle Count Adjustment (+/-)</option>
                  <option value="damage">Damaged Stock Write-Off</option>
                  <option value="expiry">Expired Stock Write-Off</option>
                  <option value="return">Stock Returned to Depot</option>
                </select>
              </label>
            )}
            <label className="block space-y-1">
              <span className="text-slate-500">
                Quantity {movementModal.mode === 'adjust' && movForm.type === 'adjustment' ? '(use negative to deduct)' : ''} *
              </span>
              <input
                type="number"
                required
                value={movForm.quantity}
                onChange={(e) => setMovForm({ ...movForm, quantity: Number(e.target.value) })}
                className="w-full px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
              />
            </label>
            <label className="block space-y-1">
              <span className="text-slate-500">Audit Reason *</span>
              <input
                required
                minLength={3}
                value={movForm.reason}
                onChange={(e) => setMovForm({ ...movForm, reason: e.target.value })}
                placeholder="Mandatory audit reason"
                className="w-full px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
              />
            </label>
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={() => setMovementModal(null)} className="px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700">
                Cancel
              </button>
              <button type="submit" disabled={busy === 'mov'} className="px-4 py-1.5 rounded-lg bg-cyan-600 text-white font-medium inline-flex items-center gap-1">
                <ArrowUpRight className="w-3.5 h-3.5" />
                Commit Ledger Transaction
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Create Reservation Modal */}
      {showReservationModal && (
        <div className="fixed inset-0 z-50 bg-slate-950/70 flex items-center justify-center p-4">
          <form
            onSubmit={handleCreateReservation}
            className="w-full max-w-md rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-5 space-y-3 text-xs"
          >
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-slate-900 dark:text-white">Create Stock Reservation</h2>
              <button type="button" onClick={() => setShowReservationModal(false)}>
                <X className="w-4 h-4 text-slate-400" />
              </button>
            </div>
            <label className="block space-y-1">
              <span className="text-slate-500">Stock Record *</span>
              <select
                required
                value={resForm.stockId}
                onChange={(e) => setResForm({ ...resForm, stockId: e.target.value })}
                className="w-full px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
              >
                {inventory.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.itemName} — {warehouseName(i.warehouseId)} ({i.availableQty} {i.unit} avail)
                  </option>
                ))}
              </select>
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="space-y-1">
                <span className="text-slate-500">Requested Qty *</span>
                <input
                  type="number"
                  min={1}
                  required
                  value={resForm.requestedQty}
                  onChange={(e) => setResForm({ ...resForm, requestedQty: Number(e.target.value) })}
                  className="w-full px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                />
              </label>
              <label className="space-y-1">
                <span className="text-slate-500">Expiry (Hours)</span>
                <input
                  type="number"
                  min={1}
                  max={720}
                  value={resForm.expiresInHours}
                  onChange={(e) => setResForm({ ...resForm, expiresInHours: Number(e.target.value) })}
                  className="w-full px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                />
              </label>
            </div>
            <label className="flex items-center gap-2 text-slate-600 dark:text-slate-300">
              <input
                type="checkbox"
                checked={resForm.allowPartial}
                onChange={(e) => setResForm({ ...resForm, allowPartial: e.target.checked })}
              />
              Allow partial reservation if available stock is lower than requested
            </label>
            <label className="block space-y-1">
              <span className="text-slate-500">Notes</span>
              <input
                value={resForm.notes}
                onChange={(e) => setResForm({ ...resForm, notes: e.target.value })}
                className="w-full px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
              />
            </label>
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={() => setShowReservationModal(false)} className="px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700">
                Cancel
              </button>
              <button type="submit" disabled={busy === 'res'} className="px-4 py-1.5 rounded-lg bg-cyan-600 text-white font-medium">
                Lock Reservation
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Register Batch Modal */}
      {showBatchModal && (
        <div className="fixed inset-0 z-50 bg-slate-950/70 flex items-center justify-center p-4">
          <form
            onSubmit={handleCreateBatch}
            className="w-full max-w-md rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-5 space-y-3 text-xs"
          >
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-slate-900 dark:text-white">Register Tracked Batch / Lot</h2>
              <button type="button" onClick={() => setShowBatchModal(false)}>
                <X className="w-4 h-4 text-slate-400" />
              </button>
            </div>
            <label className="block space-y-1">
              <span className="text-slate-500">Stock Record *</span>
              <select
                required
                value={batchForm.stockId}
                onChange={(e) => setBatchForm({ ...batchForm, stockId: e.target.value })}
                className="w-full px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
              >
                {inventory.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.itemName} — {warehouseName(i.warehouseId)}
                  </option>
                ))}
              </select>
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="space-y-1">
                <span className="text-slate-500">Lot Number *</span>
                <input
                  required
                  value={batchForm.lotNumber}
                  onChange={(e) => setBatchForm({ ...batchForm, lotNumber: e.target.value })}
                  placeholder="LOT-2026-01A"
                  className="w-full px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                />
              </label>
              <label className="space-y-1">
                <span className="text-slate-500">Quantity *</span>
                <input
                  type="number"
                  min={1}
                  required
                  value={batchForm.quantity}
                  onChange={(e) => setBatchForm({ ...batchForm, quantity: Number(e.target.value) })}
                  className="w-full px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                />
              </label>
            </div>
            <label className="flex items-center gap-2 text-slate-600 dark:text-slate-300">
              <input
                type="checkbox"
                checked={batchForm.noExpiry}
                onChange={(e) => setBatchForm({ ...batchForm, noExpiry: e.target.checked })}
              />
              Non-expiring equipment / supplies (no expiry date)
            </label>
            {!batchForm.noExpiry && (
              <label className="block space-y-1">
                <span className="text-slate-500">Expiry Date</span>
                <input
                  type="date"
                  value={batchForm.expiryDate}
                  onChange={(e) => setBatchForm({ ...batchForm, expiryDate: e.target.value })}
                  className="w-full px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                />
              </label>
            )}
            <label className="block space-y-1">
              <span className="text-slate-500">Batch Bay Location</span>
              <input
                value={batchForm.batchLocation}
                onChange={(e) => setBatchForm({ ...batchForm, batchLocation: e.target.value })}
                className="w-full px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
              />
            </label>
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={() => setShowBatchModal(false)} className="px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700">
                Cancel
              </button>
              <button type="submit" disabled={busy === 'batch'} className="px-4 py-1.5 rounded-lg bg-cyan-600 text-white font-medium">
                Save Batch
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Create Incoming Supply Modal */}
      {showSupplyModal && (
        <div className="fixed inset-0 z-50 bg-slate-950/70 flex items-center justify-center p-4">
          <form
            onSubmit={handleCreateIncomingSupply}
            className="w-full max-w-lg rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-5 space-y-3 text-xs"
          >
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-slate-900 dark:text-white">Register Incoming Supply Order</h2>
              <button type="button" onClick={() => setShowSupplyModal(false)}>
                <X className="w-4 h-4 text-slate-400" />
              </button>
            </div>
            <div className="grid sm:grid-cols-2 gap-3">
              <label className="space-y-1">
                <span className="text-slate-500">Supplier *</span>
                <input
                  required
                  value={supplyForm.supplier}
                  onChange={(e) => setSupplyForm({ ...supplyForm, supplier: e.target.value })}
                  placeholder="Supplier or donor organization"
                  className="w-full px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                />
              </label>
              <label className="space-y-1">
                <span className="text-slate-500">Destination Warehouse *</span>
                <select
                  required
                  value={supplyForm.warehouseId}
                  onChange={(e) => setSupplyForm({ ...supplyForm, warehouseId: e.target.value })}
                  className="w-full px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                >
                  {warehouses.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="space-y-1">
                <span className="text-slate-500">Expected Arrival *</span>
                <input
                  type="date"
                  required
                  value={supplyForm.expectedArrival}
                  onChange={(e) => setSupplyForm({ ...supplyForm, expectedArrival: e.target.value })}
                  className="w-full px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                />
              </label>
              <label className="space-y-1">
                <span className="text-slate-500">Tracking Ref</span>
                <input
                  value={supplyForm.trackingReference}
                  onChange={(e) => setSupplyForm({ ...supplyForm, trackingReference: e.target.value })}
                  placeholder="Auto-generated if blank"
                  className="w-full px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                />
              </label>
              <label className="space-y-1">
                <span className="text-slate-500">SKU *</span>
                <input
                  required
                  value={supplyForm.sku}
                  onChange={(e) => setSupplyForm({ ...supplyForm, sku: e.target.value })}
                  className="w-full px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                />
              </label>
              <label className="space-y-1">
                <span className="text-slate-500">Item Name *</span>
                <input
                  required
                  value={supplyForm.itemName}
                  onChange={(e) => setSupplyForm({ ...supplyForm, itemName: e.target.value })}
                  className="w-full px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                />
              </label>
              <label className="space-y-1">
                <span className="text-slate-500">Ordered Qty *</span>
                <input
                  type="number"
                  min={1}
                  required
                  value={supplyForm.orderedQty}
                  onChange={(e) => setSupplyForm({ ...supplyForm, orderedQty: Number(e.target.value) })}
                  className="w-full px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                />
              </label>
              <label className="space-y-1">
                <span className="text-slate-500">Unit</span>
                <input
                  value={supplyForm.unit}
                  onChange={(e) => setSupplyForm({ ...supplyForm, unit: e.target.value })}
                  className="w-full px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                />
              </label>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={() => setShowSupplyModal(false)} className="px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700">
                Cancel
              </button>
              <button type="submit" disabled={busy === 'sup'} className="px-4 py-1.5 rounded-lg bg-cyan-600 text-white font-medium">
                Create Incoming Order
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Receive Incoming Supply Discrepancy Modal */}
      {receiveSupplyTarget && (
        <div className="fixed inset-0 z-50 bg-slate-950/70 flex items-center justify-center p-4">
          <form
            onSubmit={handleReceiveIncomingSupply}
            className="w-full max-w-lg rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-5 space-y-3 text-xs"
          >
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-slate-900 dark:text-white">
                Record Arrival — {receiveSupplyTarget.trackingReference}
              </h2>
              <button type="button" onClick={() => setReceiveSupplyTarget(null)}>
                <X className="w-4 h-4 text-slate-400" />
              </button>
            </div>
            <p className="text-slate-500">
              Log actual received and damaged counts. Stock remains unavailable until explicitly verified.
            </p>
            <div className="space-y-2">
              {receiveSupplyTarget.items.map((it) => (
                <div key={it.sku} className="p-2.5 rounded-lg border border-slate-200 dark:border-slate-800 grid grid-cols-3 gap-2 items-center">
                  <div>
                    <div className="font-medium">{it.itemName}</div>
                    <div className="font-mono text-[10px] text-slate-500">Ordered: {it.orderedQty}</div>
                  </div>
                  <label className="space-y-0.5">
                    <span className="text-[10px] text-slate-500">Received Qty</span>
                    <input
                      type="number"
                      min={0}
                      value={receiveSupplyLines[it.sku]?.receivedQty ?? it.orderedQty}
                      onChange={(e) =>
                        setReceiveSupplyLines((prev) => ({
                          ...prev,
                          [it.sku]: {
                            receivedQty: Number(e.target.value),
                            damagedQty: prev[it.sku]?.damagedQty ?? 0,
                          },
                        }))
                      }
                      className="w-full px-2 py-1 rounded border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                    />
                  </label>
                  <label className="space-y-0.5">
                    <span className="text-[10px] text-slate-500">Damaged Qty</span>
                    <input
                      type="number"
                      min={0}
                      value={receiveSupplyLines[it.sku]?.damagedQty ?? 0}
                      onChange={(e) =>
                        setReceiveSupplyLines((prev) => ({
                          ...prev,
                          [it.sku]: {
                            receivedQty: prev[it.sku]?.receivedQty ?? it.orderedQty,
                            damagedQty: Number(e.target.value),
                          },
                        }))
                      }
                      className="w-full px-2 py-1 rounded border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                    />
                  </label>
                </div>
              ))}
            </div>
            <label className="block space-y-1">
              <span className="text-slate-500">Discrepancy / Inspection Notes</span>
              <input
                value={receiveDiscrepancyNotes}
                onChange={(e) => setReceiveDiscrepancyNotes(e.target.value)}
                placeholder="Note any missing cartons or damaged seals..."
                className="w-full px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
              />
            </label>
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={() => setReceiveSupplyTarget(null)} className="px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700">
                Cancel
              </button>
              <button type="submit" disabled={busy === receiveSupplyTarget.id} className="px-4 py-1.5 rounded-lg bg-cyan-600 text-white font-medium">
                Save Arrival Inspection
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};
