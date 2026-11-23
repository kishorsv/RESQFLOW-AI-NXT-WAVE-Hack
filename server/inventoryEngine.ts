import { v4 as uuidv4 } from 'uuid';
import type {
  AlertRecord,
  DataMode,
  IncomingSupplyItem,
  IncomingSupplyOrder,
  InventoryBatch,
  InventoryCatalogItem,
  InventoryStock,
  MovementType,
  ReliefRequest,
  ReplenishmentRecommendation,
  ReservationStatus,
  ResourceCategory,
  Severity,
  StockAlertLevel,
  StockMovement,
  StockReservation,
  UserRole,
  Warehouse,
  WarehouseMatchRecommendation,
  WarehouseStatus,
} from '../src/shared/types.ts';
import { store } from './store.ts';
import { eventBus } from './events.ts';
import { haversineKm } from './engines.ts';

export interface InventoryActor {
  name: string;
  role: UserRole;
  orgId: string;
  userId?: string;
}

export class InventoryEngineError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly details?: Record<string, unknown>;

  constructor(message: string, statusCode = 400, code = 'INVENTORY_ERROR', details?: Record<string, unknown>) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

// Per-stock lock queue to serialize async operations and guarantee concurrency safety
const stockLockTails = new Map<string, Promise<void>>();

export async function withStockLock<T>(stockIds: string[], fn: () => T | Promise<T>): Promise<T> {
  const uniqueSorted = Array.from(new Set(stockIds)).sort();
  const acquired: { id: string; chained: Promise<void>; release: () => void }[] = [];
  for (const id of uniqueSorted) {
    const prev = stockLockTails.get(id) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chained = prev.then(() => next);
    stockLockTails.set(id, chained);
    await prev;
    acquired.push({ id, chained, release });
  }
  try {
    return await fn();
  } finally {
    for (const item of acquired) {
      item.release();
      if (stockLockTails.get(item.id) === item.chained) {
        stockLockTails.delete(item.id);
      }
    }
  }
}

export function getCriticalThreshold(stock: Pick<InventoryStock, 'minStock' | 'criticalStock'>): number {
  if (typeof stock.criticalStock === 'number' && stock.criticalStock >= 0) {
    return stock.criticalStock;
  }
  return Math.max(1, Math.floor(stock.minStock * 0.5));
}

export function classifyStockLevel(stock: Pick<InventoryStock, 'availableQty' | 'minStock' | 'criticalStock'>): StockAlertLevel {
  const critical = getCriticalThreshold(stock);
  if (stock.availableQty <= 0) return 'OUT_OF_STOCK';
  if (stock.availableQty <= critical) return 'CRITICAL';
  if (stock.availableQty <= stock.minStock) return 'LOW';
  return 'NORMAL';
}

export function mapCategoryToGroup(category: ResourceCategory): InventoryCatalogItem['categoryGroup'] {
  switch (category) {
    case 'food':
      return 'Food & Nutrition';
    case 'drinking_water':
    case 'hygiene_kits':
      return 'Water & Hydration';
    case 'medical_kits':
    case 'medicines':
      return 'Medical & Healthcare';
    case 'shelter':
    case 'blankets':
      return 'Shelter & Protection';
    case 'clothing':
      return 'Clothing';
    case 'rescue_equipment':
      return 'Rescue Equipment';
    case 'fuel':
    case 'power_equipment':
    case 'communication_equipment':
    case 'transportation':
      return 'Infrastructure & Utilities';
    default:
      return 'Other';
  }
}

export function isWarehouseOperationalForDispatch(status: WarehouseStatus, active?: boolean): boolean {
  if (active === false) return false;
  return status === 'operational' || status === 'limited';
}

export function syncWarehouseOccupancy(warehouseId: string): void {
  const wh = store.state.warehouses.find((w) => w.id === warehouseId);
  if (!wh) return;
  const totalOnHand = store.state.inventory
    .filter((i) => i.warehouseId === warehouseId)
    .reduce((sum, item) => sum + Math.max(0, item.totalQty), 0);
  wh.usedUnits = totalOnHand;
  wh.updatedAt = new Date().toISOString();
}

export function evaluateStockAlerts(
  stock: InventoryStock,
  actor: InventoryActor,
  previousStatus?: StockAlertLevel
): AlertRecord | null {
  const level = classifyStockLevel(stock);
  stock.stockStatus = level;
  if (level === 'NORMAL') return null;

  const wh = store.state.warehouses.find((w) => w.id === stock.warehouseId);
  const whName = wh?.name || stock.warehouseId;
  const criticalThreshold = getCriticalThreshold(stock);

  let alertType: AlertRecord['alertType'] = 'inventory_low_stock';
  let severity: AlertRecord['severity'] = 'warning';
  let eventType = 'inventory.low_stock';
  let title = `Low Stock: ${stock.itemName} at ${whName}`;
  let message = `Available stock (${stock.availableQty} ${stock.unit}) is at or below minimum threshold (${stock.minStock} ${stock.unit}).`;

  if (level === 'OUT_OF_STOCK') {
    alertType = 'inventory_out_of_stock';
    severity = 'critical';
    eventType = 'inventory.out_of_stock';
    title = `Out of Stock: ${stock.itemName} at ${whName}`;
    message = `Available usable stock has reached 0 ${stock.unit} (Reserved: ${stock.reservedQty}, Min: ${stock.minStock}). Immediate replenishment or transfer required.`;
  } else if (level === 'CRITICAL') {
    alertType = 'inventory_critical_stock';
    severity = 'high';
    eventType = 'inventory.critical_stock';
    title = `Critical Stock: ${stock.itemName} at ${whName}`;
    message = `Available stock (${stock.availableQty} ${stock.unit}) dropped to/below critical threshold (${criticalThreshold} ${stock.unit}).`;
  }

  const { alert } = store.triggerAlert({
    dedupKey: `${alertType}:${stock.id}:${level}`,
    warehouseId: stock.warehouseId,
    warehouseName: whName,
    itemId: stock.itemId || stock.id,
    itemName: stock.itemName,
    alertType,
    severity,
    title,
    message,
    triggerFactor: `available=${stock.availableQty}, min=${stock.minStock}, critical=${criticalThreshold}`,
    previousValue: previousStatus ?? null,
    currentValue: `${stock.availableQty} ${stock.unit} (${level})`,
    source: `inventory_engine:${actor.name}`,
    mode: stock.mode,
  });

  if (alert) {
    eventBus.publish({
      event_type: eventType,
      organization_id: actor.orgId,
      entity_id: stock.id,
      source: 'inventory_engine',
      mode: stock.mode,
      payload: {
        stockId: stock.id,
        warehouseId: stock.warehouseId,
        warehouseName: whName,
        sku: stock.sku,
        itemName: stock.itemName,
        availableQty: stock.availableQty,
        minStock: stock.minStock,
        criticalStock: criticalThreshold,
        stockStatus: level,
        alertId: alert.id,
      },
    });
  }

  return alert;
}

export interface AtomicMovementParams {
  stockId: string;
  type: MovementType;
  quantity: number;
  reason: string;
  referenceId?: string;
  idempotencyKey?: string;
  expectedVersion?: number;
  actor: InventoryActor;
  /** Internal flag used when dispatching already-reserved stock so reservedQty and totalQty decrease together */
  fromReserved?: boolean;
  /** Suppress redundant publish when caller publishes composite event (e.g., transfer) */
  suppressEvent?: boolean;
}

export function commitAtomicStockMovement(params: AtomicMovementParams): {
  stock: InventoryStock;
  movement: StockMovement;
  alert: AlertRecord | null;
  idempotentReplay: boolean;
} {
  const { stockId, type, quantity, reason, referenceId, idempotencyKey, expectedVersion, actor, fromReserved, suppressEvent } = params;

  if (!Number.isFinite(quantity)) {
    throw new InventoryEngineError('Quantity must be a valid number', 400, 'INVALID_QUANTITY');
  }
  if (type !== 'adjustment' && type !== 'reconciliation' && quantity <= 0) {
    throw new InventoryEngineError('Movement quantity must be greater than zero', 400, 'INVALID_QUANTITY');
  }
  if ((type === 'adjustment' || type === 'reconciliation') && quantity === 0) {
    throw new InventoryEngineError('Adjustment quantity cannot be zero', 400, 'INVALID_QUANTITY');
  }

  // Idempotency check
  if (idempotencyKey) {
    const existing = store.state.stockMovements.find((m) => m.idempotencyKey === idempotencyKey);
    if (existing) {
      const currentStock = store.state.inventory.find((s) => s.id === existing.stockId);
      if (currentStock) {
        return { stock: currentStock, movement: existing, alert: null, idempotentReplay: true };
      }
    }
  }

  const stock = store.state.inventory.find((i) => i.id === stockId);
  if (!stock) {
    throw new InventoryEngineError('Inventory stock record not found', 404, 'STOCK_NOT_FOUND');
  }

  const warehouse = store.state.warehouses.find((w) => w.id === stock.warehouseId);
  if (!warehouse) {
    throw new InventoryEngineError('Associated warehouse not found', 404, 'WAREHOUSE_NOT_FOUND');
  }

  if (expectedVersion !== undefined && stock.version !== expectedVersion) {
    throw new InventoryEngineError(
      `Version conflict: expected v${expectedVersion}, current is v${stock.version}. Reload before updating.`,
      409,
      'VERSION_CONFLICT',
      { expectedVersion, currentVersion: stock.version }
    );
  }

  const prevStatus = classifyStockLevel(stock);
  const prevAvailable = stock.availableQty;
  let nextTotal = stock.totalQty;
  let nextReserved = stock.reservedQty;
  let nextDamaged = stock.damagedQty;
  let nextExpired = stock.expiredQty;

  switch (type) {
    case 'inbound':
    case 'return': {
      nextTotal += quantity;
      break;
    }
    case 'outbound': {
      if (fromReserved) {
        if (nextReserved < quantity || nextTotal < quantity) {
          throw new InventoryEngineError(
            `Insufficient reserved stock: requested ${quantity}, reserved ${nextReserved}`,
            409,
            'INSUFFICIENT_RESERVED'
          );
        }
        nextReserved -= quantity;
        nextTotal -= quantity;
      } else {
        if (stock.availableQty < quantity) {
          throw new InventoryEngineError(
            `Insufficient available stock: requested ${quantity}, available ${stock.availableQty}. Available stock cannot become negative.`,
            409,
            'INSUFFICIENT_STOCK',
            { requested: quantity, available: stock.availableQty }
          );
        }
        nextTotal -= quantity;
      }
      break;
    }
    case 'transfer': {
      // Negative or positive transfer handled via sign or explicit direction; default outbound if positive
      if (quantity < 0) {
        // Explicit inbound leg of transfer via internal negative check? Prefer inbound/outbound helper, keep positive = outbound deduction
        throw new InventoryEngineError('Transfer quantity must be positive', 400, 'INVALID_QUANTITY');
      }
      if (stock.availableQty < quantity) {
        throw new InventoryEngineError(
          `Insufficient available stock for transfer: requested ${quantity}, available ${stock.availableQty}`,
          409,
          'INSUFFICIENT_STOCK'
        );
      }
      nextTotal -= quantity;
      break;
    }
    case 'reservation': {
      if (stock.availableQty < quantity) {
        throw new InventoryEngineError(
          `Insufficient available stock to reserve: requested ${quantity}, available ${stock.availableQty}`,
          409,
          'INSUFFICIENT_STOCK',
          { requested: quantity, available: stock.availableQty }
        );
      }
      nextReserved += quantity;
      break;
    }
    case 'release': {
      if (nextReserved < quantity) {
        throw new InventoryEngineError(
          `Cannot release ${quantity} ${stock.unit}; only ${nextReserved} currently reserved`,
          409,
          'INSUFFICIENT_RESERVED'
        );
      }
      nextReserved -= quantity;
      break;
    }
    case 'damage': {
      if (stock.availableQty < quantity) {
        throw new InventoryEngineError(
          `Cannot mark ${quantity} damaged; only ${stock.availableQty} available`,
          409,
          'INSUFFICIENT_STOCK'
        );
      }
      nextTotal -= quantity;
      nextDamaged += quantity;
      break;
    }
    case 'expiry': {
      if (stock.availableQty < quantity) {
        throw new InventoryEngineError(
          `Cannot expire ${quantity} units; only ${stock.availableQty} available`,
          409,
          'INSUFFICIENT_STOCK'
        );
      }
      nextTotal -= quantity;
      nextExpired += quantity;
      break;
    }
    case 'adjustment':
    case 'reconciliation': {
      const candidateTotal = nextTotal + quantity;
      const candidateAvailable = candidateTotal - nextReserved;
      if (candidateTotal < 0 || candidateAvailable < 0) {
        throw new InventoryEngineError(
          `Adjustment would make available stock negative (${candidateAvailable}). Reserved stock is ${nextReserved}.`,
          409,
          'NEGATIVE_STOCK_PREVENTED'
        );
      }
      nextTotal = candidateTotal;
      break;
    }
  }

  const nextAvailable = nextTotal - nextReserved;
  if (nextTotal < 0 || nextReserved < 0 || nextAvailable < 0) {
    throw new InventoryEngineError(
      'Ledger invariant violation prevented: Available Stock = On-Hand - Reserved must never be negative.',
      409,
      'LEDGER_INVARIANT_VIOLATION'
    );
  }

  // Commit atomic state update
  const now = new Date().toISOString();
  stock.totalQty = nextTotal;
  stock.reservedQty = nextReserved;
  stock.availableQty = nextAvailable;
  stock.damagedQty = nextDamaged;
  stock.expiredQty = nextExpired;
  stock.stockStatus = classifyStockLevel(stock);
  stock.version += 1;
  stock.updatedAt = now;

  const movement: StockMovement = {
    id: uuidv4(),
    idempotencyKey,
    stockId: stock.id,
    itemId: stock.itemId,
    warehouseId: stock.warehouseId,
    itemName: stock.itemName,
    type,
    quantity: Math.abs(quantity),
    previousAvailable: prevAvailable,
    newAvailable: nextAvailable,
    reason,
    referenceId,
    actor: actor.name,
    role: actor.role,
    orgId: actor.orgId,
    mode: stock.mode,
    createdAt: now,
  };

  store.state.stockMovements.unshift(movement);
  syncWarehouseOccupancy(stock.warehouseId);
  store.save();

  store.addAudit({
    actor: actor.name,
    role: actor.role,
    orgId: actor.orgId,
    action: `inventory.${type}`,
    entityType: 'inventory',
    entityId: stock.id,
    summary: `${type.toUpperCase()} ${quantity} ${stock.unit} of ${stock.itemName} (avail ${prevAvailable} -> ${nextAvailable}). Reason: ${reason}`,
    mode: stock.mode,
  });

  const alert = evaluateStockAlerts(stock, actor, prevStatus);

  if (!suppressEvent) {
    const specificEventMap: Partial<Record<MovementType, string>> = {
      inbound: 'inventory.stock_received',
      return: 'inventory.stock_received',
      outbound: 'inventory.stock_dispatched',
      reservation: 'inventory.stock_reserved',
      release: 'inventory.stock_released',
      transfer: 'inventory.stock_transferred',
    };
    const eventName = specificEventMap[type] || 'inventory.updated';
    const payload = {
      stockId: stock.id,
      warehouseId: stock.warehouseId,
      sku: stock.sku,
      itemName: stock.itemName,
      movementType: type,
      quantity: Math.abs(quantity),
      totalQty: stock.totalQty,
      reservedQty: stock.reservedQty,
      availableQty: stock.availableQty,
      stockStatus: stock.stockStatus,
      version: stock.version,
      movementId: movement.id,
    };
    eventBus.publish({
      event_type: eventName,
      organization_id: actor.orgId,
      entity_id: stock.id,
      source: 'inventory_ledger',
      mode: stock.mode,
      payload,
    });
    if (eventName !== 'inventory.updated') {
      eventBus.publish({
        event_type: 'inventory.updated',
        organization_id: actor.orgId,
        entity_id: stock.id,
        source: 'inventory_ledger',
        mode: stock.mode,
        payload,
      });
    }
  }

  return { stock, movement, alert, idempotentReplay: false };
}

export async function executeWarehouseTransfer(params: {
  sourceStockId: string;
  destinationWarehouseId: string;
  quantity: number;
  reason: string;
  actor: InventoryActor;
}): Promise<{
  transferReferenceId: string;
  sourceStock: InventoryStock;
  destinationStock: InventoryStock;
  sourceMovement: StockMovement;
  destinationMovement: StockMovement;
}> {
  const { sourceStockId, destinationWarehouseId, quantity, reason, actor } = params;
  if (!Number.isFinite(quantity) || quantity <= 0) {
    throw new InventoryEngineError('Transfer quantity must be positive', 400, 'INVALID_QUANTITY');
  }

  const sourceStock = store.state.inventory.find((s) => s.id === sourceStockId);
  if (!sourceStock) {
    throw new InventoryEngineError('Source stock record not found', 404, 'STOCK_NOT_FOUND');
  }
  const sourceWh = store.state.warehouses.find((w) => w.id === sourceStock.warehouseId);
  const destWh = store.state.warehouses.find((w) => w.id === destinationWarehouseId);
  if (!sourceWh || !destWh) {
    throw new InventoryEngineError('Source or destination warehouse not found', 404, 'WAREHOUSE_NOT_FOUND');
  }
  if (sourceWh.id === destWh.id) {
    throw new InventoryEngineError('Source and destination warehouses must be different', 400, 'SAME_WAREHOUSE');
  }
  if (sourceWh.mode !== destWh.mode) {
    throw new InventoryEngineError('Cannot transfer stock across Demo and Operational modes', 400, 'MODE_MISMATCH');
  }
  if (!isWarehouseOperationalForDispatch(sourceWh.status, sourceWh.active)) {
    throw new InventoryEngineError(`Source warehouse "${sourceWh.name}" is ${sourceWh.status} and cannot transfer stock`, 409, 'WAREHOUSE_UNAVAILABLE');
  }
  if (!isWarehouseOperationalForDispatch(destWh.status, destWh.active)) {
    throw new InventoryEngineError(`Destination warehouse "${destWh.name}" is ${destWh.status} and cannot receive stock`, 409, 'WAREHOUSE_UNAVAILABLE');
  }

  // Locate or prepare destination stock record
  let destStock = store.state.inventory.find(
    (s) => s.warehouseId === destWh.id && s.sku === sourceStock.sku && s.mode === sourceStock.mode
  );
  const lockIds = destStock ? [sourceStock.id, destStock.id] : [sourceStock.id, `new:${destWh.id}:${sourceStock.sku}`];

  return withStockLock(lockIds, () => {
    const transferRef = `TRF-${uuidv4().slice(0, 8).toUpperCase()}`;
    if (sourceStock.availableQty < quantity) {
      throw new InventoryEngineError(
        `Insufficient available stock at ${sourceWh.name}: requested ${quantity}, available ${sourceStock.availableQty}`,
        409,
        'INSUFFICIENT_STOCK'
      );
    }

    const now = new Date().toISOString();
    let createdDest = false;
    if (!destStock) {
      destStock = {
        id: uuidv4(),
        itemId: sourceStock.itemId,
        warehouseId: destWh.id,
        sku: sourceStock.sku,
        itemName: sourceStock.itemName,
        category: sourceStock.category,
        unit: sourceStock.unit,
        totalQty: 0,
        availableQty: 0,
        reservedQty: 0,
        inTransitQty: 0,
        damagedQty: 0,
        expiredQty: 0,
        minStock: sourceStock.minStock,
        criticalStock: sourceStock.criticalStock,
        reorderThreshold: sourceStock.reorderThreshold,
        stockStatus: 'OUT_OF_STOCK',
        version: 1,
        mode: sourceStock.mode,
        updatedAt: now,
      };
      store.state.inventory.unshift(destStock);
      createdDest = true;
    }

    // Snapshot for rollback guarantee
    const srcSnap = { ...sourceStock };
    const dstSnap = { ...destStock };

    try {
      const srcRes = commitAtomicStockMovement({
        stockId: sourceStock.id,
        type: 'transfer',
        quantity,
        reason: `Transfer out to ${destWh.name}: ${reason}`,
        referenceId: transferRef,
        actor,
        suppressEvent: true,
      });

      const dstRes = commitAtomicStockMovement({
        stockId: destStock.id,
        type: 'inbound',
        quantity,
        reason: `Transfer in from ${sourceWh.name}: ${reason}`,
        referenceId: transferRef,
        actor,
        suppressEvent: true,
      });

      // Mark destination movement type explicitly as 'transfer' for ledger symmetry
      dstRes.movement.type = 'transfer';
      store.save();

      eventBus.publish({
        event_type: 'inventory.stock_transferred',
        organization_id: actor.orgId,
        entity_id: transferRef,
        source: 'inventory_transfer',
        mode: sourceStock.mode,
        payload: {
          transferReferenceId: transferRef,
          sku: sourceStock.sku,
          itemName: sourceStock.itemName,
          quantity,
          sourceWarehouseId: sourceWh.id,
          sourceWarehouseName: sourceWh.name,
          sourceAvailableQty: srcRes.stock.availableQty,
          destinationWarehouseId: destWh.id,
          destinationWarehouseName: destWh.name,
          destinationAvailableQty: dstRes.stock.availableQty,
        },
      });
      eventBus.publish({
        event_type: 'inventory.updated',
        organization_id: actor.orgId,
        entity_id: sourceStock.id,
        source: 'inventory_transfer',
        mode: sourceStock.mode,
        payload: { stockId: sourceStock.id, destinationStockId: dstRes.stock.id, transferReferenceId: transferRef },
      });

      return {
        transferReferenceId: transferRef,
        sourceStock: srcRes.stock,
        destinationStock: dstRes.stock,
        sourceMovement: srcRes.movement,
        destinationMovement: dstRes.movement,
      };
    } catch (err) {
      // Atomic rollback
      Object.assign(sourceStock, srcSnap);
      if (createdDest) {
        const idx = store.state.inventory.findIndex((s) => s.id === destStock!.id);
        if (idx >= 0) store.state.inventory.splice(idx, 1);
      } else {
        Object.assign(destStock, dstSnap);
      }
      store.save();
      throw err;
    }
  });
}

export function expireStaleReservations(mode?: DataMode): StockReservation[] {
  const nowMs = Date.now();
  const expiredList: StockReservation[] = [];
  const activeStatuses: ReservationStatus[] = ['Reserved', 'Partially Reserved'];

  for (const res of store.state.stockReservations) {
    if (mode && res.mode !== mode) continue;
    if (!activeStatuses.includes(res.status)) continue;
    if (new Date(res.expiresAt).getTime() <= nowMs) {
      try {
        commitAtomicStockMovement({
          stockId: res.stockId,
          type: 'release',
          quantity: res.reservedQty,
          reason: `Automatic release: reservation ${res.id} expired at ${res.expiresAt}`,
          referenceId: res.id,
          actor: { name: 'Reservation Expiry Engine', role: 'super_admin', orgId: res.orgId },
        });
      } catch {
        // If stock was already adjusted/removed, still mark reservation expired
      }
      const nowIso = new Date().toISOString();
      res.status = 'Expired';
      res.updatedAt = nowIso;
      res.auditHistory.push({
        timestamp: nowIso,
        actor: 'System Expiry Engine',
        action: 'reservation.expired',
        detail: `Reservation expired and released ${res.reservedQty} ${res.unit} back to available stock.`,
      });
      expiredList.push(res);
    }
  }
  if (expiredList.length > 0) {
    store.save();
  }
  return expiredList;
}

function updateReliefRequestFulfillment(requestId: string | null | undefined, category: ResourceCategory, deltaQty: number): void {
  if (!requestId) return;
  const req = store.state.reliefRequests.find((r) => r.id === requestId);
  if (!req) return;
  const item = req.items.find((i) => i.category === category);
  if (item) {
    item.fulfilledQuantity = Math.max(0, Math.min(item.quantity, (item.fulfilledQuantity || 0) + deltaQty));
  }
  const totalRequested = req.items.reduce((s, i) => s + i.quantity, 0);
  const totalFulfilled = req.items.reduce((s, i) => s + (i.fulfilledQuantity || 0), 0);
  if (totalFulfilled <= 0) {
    req.fulfillmentStatus = 'unfulfilled';
  } else if (totalFulfilled >= totalRequested) {
    req.fulfillmentStatus = 'fulfilled';
  } else {
    req.fulfillmentStatus = 'partially_fulfilled';
  }
  req.updatedAt = new Date().toISOString();
}

export async function createStockReservation(params: {
  stockId: string;
  requestedQty: number;
  allowPartial?: boolean;
  requestId?: string | null;
  incidentId?: string | null;
  expiresInHours?: number;
  notes?: string;
  actor: InventoryActor;
}): Promise<{ reservation: StockReservation; stock: InventoryStock; movement: StockMovement }> {
  const { stockId, requestedQty, allowPartial = false, requestId, incidentId, expiresInHours = 24, notes, actor } = params;
  if (!Number.isFinite(requestedQty) || requestedQty <= 0) {
    throw new InventoryEngineError('Requested reservation quantity must be positive', 400, 'INVALID_QUANTITY');
  }

  return withStockLock([stockId], () => {
    expireStaleReservations();

    const stock = store.state.inventory.find((s) => s.id === stockId);
    if (!stock) {
      throw new InventoryEngineError('Inventory stock item not found', 404, 'STOCK_NOT_FOUND');
    }
    const warehouse = store.state.warehouses.find((w) => w.id === stock.warehouseId);
    if (!warehouse) {
      throw new InventoryEngineError('Warehouse not found', 404, 'WAREHOUSE_NOT_FOUND');
    }
    if (!isWarehouseOperationalForDispatch(warehouse.status, warehouse.active)) {
      throw new InventoryEngineError(
        `Warehouse "${warehouse.name}" is currently ${warehouse.status} and cannot accept reservations`,
        409,
        'WAREHOUSE_UNAVAILABLE'
      );
    }

    if (stock.availableQty <= 0 || (!allowPartial && stock.availableQty < requestedQty)) {
      store.triggerAlert({
        dedupKey: `reservation_conflict:${stock.id}:${requestId || 'ad-hoc'}`,
        incidentId: incidentId || undefined,
        warehouseId: warehouse.id,
        warehouseName: warehouse.name,
        itemId: stock.itemId || stock.id,
        itemName: stock.itemName,
        alertType: 'reservation_conflict',
        severity: 'high',
        title: `Reservation Conflict: ${stock.itemName} at ${warehouse.name}`,
        message: `Requested ${requestedQty} ${stock.unit} could not be reserved because only ${stock.availableQty} ${stock.unit} are available.`,
        triggerFactor: `requested=${requestedQty}, available=${stock.availableQty}`,
        currentValue: stock.availableQty,
        source: `reservation_engine:${actor.name}`,
        mode: stock.mode,
      });
      throw new InventoryEngineError(
        `Insufficient available stock for reservation: requested ${requestedQty} ${stock.unit}, available ${stock.availableQty} ${stock.unit}`,
        409,
        'RESERVATION_CONFLICT',
        { requestedQty, availableQty: stock.availableQty }
      );
    }

    const qtyToReserve = Math.min(requestedQty, stock.availableQty);
    const isPartial = qtyToReserve < requestedQty;
    const reservationId = uuidv4();
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + Math.max(1, expiresInHours) * 3600_000).toISOString();

    const { stock: updatedStock, movement } = commitAtomicStockMovement({
      stockId: stock.id,
      type: 'reservation',
      quantity: qtyToReserve,
      reason: notes || `Stock reservation ${reservationId}${requestId ? ` for request ${requestId}` : ''}`,
      referenceId: reservationId,
      actor,
    });

    const reservation: StockReservation = {
      id: reservationId,
      requestId: requestId || null,
      incidentId: incidentId || null,
      warehouseId: warehouse.id,
      warehouseName: warehouse.name,
      stockId: stock.id,
      itemId: stock.itemId,
      sku: stock.sku,
      itemName: stock.itemName,
      category: stock.category,
      unit: stock.unit,
      requestedQty,
      reservedQty: qtyToReserve,
      status: isPartial ? 'Partially Reserved' : 'Reserved',
      expiresAt,
      orgId: actor.orgId,
      reservedBy: actor.name,
      notes,
      auditHistory: [
        {
          timestamp: now,
          actor: actor.name,
          action: isPartial ? 'reservation.partial_created' : 'reservation.created',
          detail: `Reserved ${qtyToReserve} of ${requestedQty} ${stock.unit} at ${warehouse.name}`,
        },
      ],
      mode: stock.mode,
      createdAt: now,
      updatedAt: now,
    };

    store.state.stockReservations.unshift(reservation);
    updateReliefRequestFulfillment(requestId, stock.category, qtyToReserve);
    store.save();

    return { reservation, stock: updatedStock, movement };
  });
}

export async function releaseStockReservation(
  reservationId: string,
  actor: InventoryActor,
  reason = 'Released by operator'
): Promise<{ reservation: StockReservation; stock: InventoryStock }> {
  const existing = store.state.stockReservations.find((r) => r.id === reservationId);
  if (!existing) {
    throw new InventoryEngineError('Reservation not found', 404, 'RESERVATION_NOT_FOUND');
  }

  return withStockLock([existing.stockId], () => {
    const allowed: ReservationStatus[] = ['Reserved', 'Partially Reserved', 'Allocated'];
    if (!allowed.includes(existing.status)) {
      throw new InventoryEngineError(
        `Reservation in status "${existing.status}" cannot be released`,
        409,
        'INVALID_RESERVATION_STATE'
      );
    }

    const { stock } = commitAtomicStockMovement({
      stockId: existing.stockId,
      type: 'release',
      quantity: existing.reservedQty,
      reason: `Release reservation ${existing.id}: ${reason}`,
      referenceId: existing.id,
      actor,
    });

    const now = new Date().toISOString();
    existing.status = 'Reservation Released';
    existing.updatedAt = now;
    existing.auditHistory.push({
      timestamp: now,
      actor: actor.name,
      action: 'reservation.released',
      detail: `Released ${existing.reservedQty} ${existing.unit}. Reason: ${reason}`,
    });
    updateReliefRequestFulfillment(existing.requestId, existing.category, -existing.reservedQty);
    store.save();

    return { reservation: existing, stock };
  });
}

export async function confirmStockReservation(
  reservationId: string,
  actor: InventoryActor,
  targetStatus: 'Allocated' | 'Dispatched' | 'Delivered' = 'Allocated',
  note?: string
): Promise<{ reservation: StockReservation; stock: InventoryStock | null }> {
  const existing = store.state.stockReservations.find((r) => r.id === reservationId);
  if (!existing) {
    throw new InventoryEngineError('Reservation not found', 404, 'RESERVATION_NOT_FOUND');
  }

  return withStockLock([existing.stockId], () => {
    const validTransitions: Record<ReservationStatus, ReservationStatus[]> = {
      Requested: ['Reserved', 'Partially Reserved', 'Cancelled'],
      Reserved: ['Allocated', 'Dispatched', 'Reservation Released', 'Cancelled'],
      'Partially Reserved': ['Allocated', 'Dispatched', 'Reservation Released', 'Cancelled'],
      Allocated: ['Dispatched', 'Reservation Released', 'Cancelled'],
      Dispatched: ['Delivered'],
      Delivered: [],
      'Reservation Released': [],
      Expired: [],
      Cancelled: [],
    };

    if (!validTransitions[existing.status]?.includes(targetStatus)) {
      throw new InventoryEngineError(
        `Cannot transition reservation from "${existing.status}" to "${targetStatus}"`,
        409,
        'INVALID_RESERVATION_TRANSITION'
      );
    }

    let updatedStock: InventoryStock | null = store.state.inventory.find((s) => s.id === existing.stockId) || null;
    if (targetStatus === 'Dispatched') {
      const result = commitAtomicStockMovement({
        stockId: existing.stockId,
        type: 'outbound',
        quantity: existing.reservedQty,
        reason: note || `Dispatched reserved stock for reservation ${existing.id}`,
        referenceId: existing.id,
        actor,
        fromReserved: true,
      });
      updatedStock = result.stock;
    }

    const now = new Date().toISOString();
    existing.status = targetStatus;
    existing.updatedAt = now;
    existing.auditHistory.push({
      timestamp: now,
      actor: actor.name,
      action: `reservation.${targetStatus.toLowerCase()}`,
      detail: note || `Reservation confirmed as ${targetStatus}`,
    });

    if (existing.requestId) {
      const req = store.state.reliefRequests.find((r) => r.id === existing.requestId);
      if (req) {
        if (targetStatus === 'Allocated' && (req.status === 'submitted' || req.status === 'verified' || req.status === 'prioritized')) {
          req.status = 'allocated';
        } else if (targetStatus === 'Dispatched') {
          req.status = 'dispatched';
        } else if (targetStatus === 'Delivered') {
          req.status = 'delivered';
        }
        req.updatedAt = now;
      }
    }

    store.save();
    eventBus.publish({
      event_type: 'inventory.updated',
      organization_id: actor.orgId,
      entity_id: existing.stockId,
      source: 'reservation_engine',
      mode: existing.mode,
      payload: { reservationId: existing.id, status: existing.status, stockId: existing.stockId },
    });

    return { reservation: existing, stock: updatedStock };
  });
}

export function evaluateInventoryExpiry(mode: DataMode, actorName = 'Expiry Monitor') {
  const nowMs = Date.now();
  const dayMs = 24 * 60 * 60_000;
  const batches = store.state.inventoryBatches.filter((b) => b.mode === mode);

  const expired: (InventoryBatch & { daysRemaining: number })[] = [];
  const expiring7d: (InventoryBatch & { daysRemaining: number })[] = [];
  const expiring30d: (InventoryBatch & { daysRemaining: number })[] = [];
  const expiring90d: (InventoryBatch & { daysRemaining: number })[] = [];
  const healthy: (InventoryBatch & { daysRemaining: number })[] = [];
  const noExpiry: (InventoryBatch & { daysRemaining: null })[] = [];

  let changed = false;

  for (const batch of batches) {
    // Non-expiring items MUST NOT be treated as expired
    if (!batch.expiryDate) {
      noExpiry.push({ ...batch, daysRemaining: null });
      continue;
    }
    const expMs = new Date(batch.expiryDate).getTime();
    if (Number.isNaN(expMs)) {
      noExpiry.push({ ...batch, daysRemaining: null });
      continue;
    }

    const daysRemaining = Math.ceil((expMs - nowMs) / dayMs);
    if (daysRemaining <= 0) {
      // Auto-quarantine & deduct expired stock from usable available inventory exactly once
      if (batch.qualityStatus !== 'expired') {
        batch.qualityStatus = 'expired';
        batch.updatedAt = new Date().toISOString();
        changed = true;

        const stock = store.state.inventory.find((s) => s.id === batch.stockId);
        if (stock && batch.quantity > 0) {
          const deduct = Math.min(stock.availableQty, batch.quantity);
          if (deduct > 0) {
            try {
              commitAtomicStockMovement({
                stockId: stock.id,
                type: 'expiry',
                quantity: deduct,
                reason: `Batch ${batch.lotNumber} expired on ${batch.expiryDate}; excluded from usable inventory.`,
                referenceId: batch.id,
                actor: { name: actorName, role: 'super_admin', orgId: 'org-central-cmd' },
              });
            } catch {
              // ignore if already accounted
            }
          }
          const wh = store.state.warehouses.find((w) => w.id === batch.warehouseId);
          store.triggerAlert({
            dedupKey: `inventory_expired:${batch.id}`,
            warehouseId: batch.warehouseId,
            warehouseName: wh?.name,
            itemId: batch.itemId || batch.stockId,
            itemName: batch.itemName,
            alertType: 'inventory_expired_supply',
            severity: 'critical',
            title: `Expired Supply Quarantined: ${batch.itemName} (${batch.lotNumber})`,
            message: `${batch.quantity} units in lot ${batch.lotNumber} expired on ${batch.expiryDate} and were removed from usable stock.`,
            triggerFactor: `expiryDate=${batch.expiryDate}`,
            currentValue: `${batch.quantity} expired`,
            source: 'expiry_engine',
            mode,
          });
        }
      }
      expired.push({ ...batch, daysRemaining });
    } else if (daysRemaining <= 7) {
      expiring7d.push({ ...batch, daysRemaining });
      const wh = store.state.warehouses.find((w) => w.id === batch.warehouseId);
      store.triggerAlert({
        dedupKey: `inventory_expiring_7d:${batch.id}`,
        warehouseId: batch.warehouseId,
        warehouseName: wh?.name,
        itemId: batch.itemId || batch.stockId,
        itemName: batch.itemName,
        alertType: 'inventory_expiring_supply',
        severity: 'high',
        title: `Supply Expiring Within 7 Days: ${batch.itemName}`,
        message: `Lot ${batch.lotNumber} (${batch.quantity} units) at ${wh?.name || batch.warehouseId} expires in ${daysRemaining} day(s). Prioritize immediate dispatch.`,
        triggerFactor: `daysRemaining=${daysRemaining}`,
        currentValue: `${daysRemaining} days`,
        source: 'expiry_engine',
        mode,
      });
    } else if (daysRemaining <= 30) {
      expiring30d.push({ ...batch, daysRemaining });
    } else if (daysRemaining <= 90) {
      expiring90d.push({ ...batch, daysRemaining });
    } else {
      healthy.push({ ...batch, daysRemaining });
    }
  }

  if (changed) {
    store.save();
  }

  return {
    summary: {
      totalBatches: batches.length,
      expiredCount: expired.length,
      expiredUnits: expired.reduce((s, b) => s + b.quantity, 0),
      expiring7dCount: expiring7d.length,
      expiring30dCount: expiring30d.length,
      expiring90dCount: expiring90d.length,
      healthyCount: healthy.length,
      noExpiryCount: noExpiry.length,
    },
    expired,
    expiring7d,
    expiring30d,
    expiring90d,
    healthy,
    noExpiry,
  };
}

export function receiveIncomingSupply(params: {
  supplyId: string;
  receivedItems: { sku: string; receivedQty: number; damagedQty?: number; lotNumber?: string; expiryDate?: string | null }[];
  discrepancyNotes?: string;
  actor: InventoryActor;
}): IncomingSupplyOrder {
  const order = store.state.incomingSupplies.find((s) => s.id === params.supplyId);
  if (!order) {
    throw new InventoryEngineError('Incoming supply order not found', 404, 'SUPPLY_NOT_FOUND');
  }
  if (order.status === 'Verified' || order.status === 'Cancelled') {
    throw new InventoryEngineError(`Supply order is already ${order.status}`, 409, 'INVALID_SUPPLY_STATE');
  }

  let hasDiscrepancy = false;
  let allReceived = true;

  for (const item of order.items) {
    const update = params.receivedItems.find((u) => u.sku === item.sku);
    if (update) {
      item.receivedQty = Math.max(0, update.receivedQty);
      item.damagedQty = Math.max(0, update.damagedQty ?? 0);
      if (update.lotNumber !== undefined) item.lotNumber = update.lotNumber;
      if (update.expiryDate !== undefined) item.expiryDate = update.expiryDate;
    }
    if (item.receivedQty < item.orderedQty) {
      allReceived = false;
    }
    if (item.receivedQty !== item.orderedQty || item.damagedQty > 0) {
      hasDiscrepancy = true;
    }
  }

  const now = new Date().toISOString();
  order.actualArrival = now;
  order.status = allReceived ? 'Received' : 'Partially Received';
  order.verificationStatus = hasDiscrepancy ? 'discrepancy' : 'unverified';
  if (params.discrepancyNotes) {
    order.discrepancyNotes = params.discrepancyNotes;
  }
  order.updatedAt = now;

  if (hasDiscrepancy) {
    store.triggerAlert({
      dedupKey: `stock_discrepancy:${order.id}`,
      warehouseId: order.warehouseId,
      warehouseName: order.warehouseName,
      alertType: 'stock_discrepancy',
      severity: 'warning',
      title: `Incoming Supply Discrepancy: ${order.trackingReference}`,
      message: `Shipment from ${order.supplier} to ${order.warehouseName} arrived with quantity or damage discrepancy. Verification required before adding to available stock.`,
      triggerFactor: params.discrepancyNotes || 'ordered != received or damaged > 0',
      source: `supply_receiving:${params.actor.name}`,
      mode: order.mode,
    });
  }

  store.addAudit({
    actor: params.actor.name,
    role: params.actor.role,
    orgId: params.actor.orgId,
    action: 'supply.received',
    entityType: 'incoming_supply',
    entityId: order.id,
    summary: `Marked supply ${order.trackingReference} as ${order.status} (pending verification before stock update).`,
    mode: order.mode,
  });

  store.save();
  eventBus.publish({
    event_type: 'inventory.updated',
    organization_id: params.actor.orgId,
    entity_id: order.id,
    source: 'incoming_supply',
    mode: order.mode,
    payload: { supplyId: order.id, status: order.status, verificationStatus: order.verificationStatus },
  });

  return order;
}

export function verifyIncomingSupply(params: {
  supplyId: string;
  actor: InventoryActor;
  notes?: string;
}): { order: IncomingSupplyOrder; movements: StockMovement[]; createdBatches: InventoryBatch[] } {
  const order = store.state.incomingSupplies.find((s) => s.id === params.supplyId);
  if (!order) {
    throw new InventoryEngineError('Incoming supply order not found', 404, 'SUPPLY_NOT_FOUND');
  }
  if (order.status === 'Verified') {
    throw new InventoryEngineError('Incoming supply order is already verified', 409, 'ALREADY_VERIFIED');
  }
  if (order.status !== 'Received' && order.status !== 'Partially Received') {
    throw new InventoryEngineError(
      'Incoming supply must be marked Received or Partially Received before verification',
      409,
      'SUPPLY_NOT_RECEIVED'
    );
  }

  const now = new Date().toISOString();
  const movements: StockMovement[] = [];
  const createdBatches: InventoryBatch[] = [];

  for (const item of order.items) {
    const usableQty = Math.max(0, item.receivedQty - item.damagedQty);
    let stock = store.state.inventory.find(
      (s) => s.warehouseId === order.warehouseId && s.sku === item.sku && s.mode === order.mode
    );

    if (!stock) {
      const cat = store.state.inventoryCatalog.find((c) => c.sku === item.sku && c.mode === order.mode);
      stock = {
        id: uuidv4(),
        itemId: item.itemId || cat?.id,
        warehouseId: order.warehouseId,
        sku: item.sku,
        itemName: item.itemName,
        category: item.category,
        unit: item.unit,
        totalQty: 0,
        availableQty: 0,
        reservedQty: 0,
        inTransitQty: 0,
        damagedQty: 0,
        expiredQty: 0,
        minStock: cat?.minStock ?? 100,
        criticalStock: cat?.criticalStock ?? 50,
        reorderThreshold: cat?.reorderQty ?? 150,
        stockStatus: 'OUT_OF_STOCK',
        version: 1,
        mode: order.mode,
        updatedAt: now,
      };
      store.state.inventory.unshift(stock);
    }

    if (item.damagedQty > 0) {
      stock.damagedQty += item.damagedQty;
    }
    stock.inTransitQty = Math.max(0, stock.inTransitQty - item.orderedQty);

    if (usableQty > 0) {
      const res = commitAtomicStockMovement({
        stockId: stock.id,
        type: 'inbound',
        quantity: usableQty,
        reason: params.notes || `Verified incoming supply ${order.trackingReference} from ${order.supplier}`,
        referenceId: order.id,
        actor: params.actor,
      });
      movements.push(res.movement);

      const batch: InventoryBatch = {
        id: uuidv4(),
        stockId: stock.id,
        warehouseId: order.warehouseId,
        itemId: stock.itemId,
        sku: stock.sku,
        itemName: stock.itemName,
        lotNumber: item.lotNumber || `LOT-${order.trackingReference}`,
        quantity: usableQty,
        receivedDate: order.actualArrival || now,
        expiryDate: item.expiryDate ?? null,
        qualityStatus: 'good',
        storageRequirements:
          store.state.inventoryCatalog.find((c) => c.sku === stock!.sku && c.mode === order.mode)?.storageRequirements ||
          'Standard dry warehouse bay',
        batchLocation: 'Receiving Bay Verified',
        mode: order.mode,
        createdAt: now,
        updatedAt: now,
      };
      store.state.inventoryBatches.unshift(batch);
      createdBatches.push(batch);
    }
  }

  order.status = 'Verified';
  order.verificationStatus = 'verified';
  order.verifiedBy = params.actor.name;
  order.updatedAt = now;

  store.addAudit({
    actor: params.actor.name,
    role: params.actor.role,
    orgId: params.actor.orgId,
    action: 'supply.verified',
    entityType: 'incoming_supply',
    entityId: order.id,
    summary: `Verified incoming supply ${order.trackingReference}; committed ${movements.length} atomic inbound stock ledger update(s).`,
    mode: order.mode,
  });

  store.save();
  return { order, movements, createdBatches };
}

export function computeDemandSupplyIntelligence(mode: DataMode) {
  const requests = store.state.reliefRequests.filter((r) => r.mode === mode && r.status !== 'closed' && r.status !== 'delivered');
  const stocks = store.state.inventory.filter((s) => s.mode === mode);
  const incidents = store.state.incidents.filter((i) => i.mode === mode);

  const byCategoryMap = new Map<
    ResourceCategory,
    { category: ResourceCategory; requestedQty: number; fulfilledQty: number; availableStock: number; reservedStock: number; shortageQty: number }
  >();

  for (const s of stocks) {
    const row = byCategoryMap.get(s.category) || {
      category: s.category,
      requestedQty: 0,
      fulfilledQty: 0,
      availableStock: 0,
      reservedStock: 0,
      shortageQty: 0,
    };
    row.availableStock += s.availableQty;
    row.reservedStock += s.reservedQty;
    byCategoryMap.set(s.category, row);
  }

  let totalDemand = 0;
  let totalFulfilled = 0;
  let criticalUnmetDemand = 0;

  const byIncidentMap = new Map<
    string,
    { incidentId: string; incidentTitle: string; severity: Severity; requestedQty: number; fulfilledQty: number; remainingShortage: number; requestCount: number }
  >();

  for (const req of requests) {
    const inc = incidents.find((i) => i.id === req.incidentId);
    const incRow = byIncidentMap.get(req.incidentId) || {
      incidentId: req.incidentId,
      incidentTitle: inc?.title || req.locationName,
      severity: inc?.severity || req.urgency,
      requestedQty: 0,
      fulfilledQty: 0,
      remainingShortage: 0,
      requestCount: 0,
    };
    incRow.requestCount += 1;

    for (const item of req.items) {
      const remaining = Math.max(0, item.quantity - (item.fulfilledQuantity || 0));
      totalDemand += item.quantity;
      totalFulfilled += Math.min(item.quantity, item.fulfilledQuantity || 0);
      incRow.requestedQty += item.quantity;
      incRow.fulfilledQty += Math.min(item.quantity, item.fulfilledQuantity || 0);
      incRow.remainingShortage += remaining;

      if (req.priorityCategory === 'critical' || req.urgency === 'critical') {
        criticalUnmetDemand += remaining;
      }

      const catRow = byCategoryMap.get(item.category) || {
        category: item.category,
        requestedQty: 0,
        fulfilledQty: 0,
        availableStock: 0,
        reservedStock: 0,
        shortageQty: 0,
      };
      catRow.requestedQty += item.quantity;
      catRow.fulfilledQty += Math.min(item.quantity, item.fulfilledQuantity || 0);
      byCategoryMap.set(item.category, catRow);
    }

    byIncidentMap.set(req.incidentId, incRow);
  }

  let totalShortage = 0;
  const byCategory = Array.from(byCategoryMap.values()).map((c) => {
    const unmet = Math.max(0, c.requestedQty - c.fulfilledQty);
    const shortageQty = Math.max(0, unmet - c.availableStock);
    totalShortage += shortageQty;
    return { ...c, unmetDemand: unmet, shortageQty };
  });

  const totalAvailableStock = stocks.reduce((s, i) => s + i.availableQty, 0);
  const totalReservedStock = stocks.reduce((s, i) => s + i.reservedQty, 0);
  const fulfillmentPercentage = totalDemand > 0 ? Math.round((totalFulfilled / totalDemand) * 100) : 100;

  return {
    totalDemand,
    totalFulfilled,
    totalAvailableStock,
    totalReservedStock,
    totalShortage,
    fulfillmentPercentage,
    criticalUnmetDemand,
    activeRequestCount: requests.length,
    byCategory,
    byIncident: Array.from(byIncidentMap.values()).sort((a, b) => b.remainingShortage - a.remainingShortage),
  };
}

export function matchWarehousesForRequest(request: ReliefRequest): WarehouseMatchRecommendation[] {
  const mode = request.mode;
  const warehouses = store.state.warehouses.filter((w) => w.mode === mode);
  const stocks = store.state.inventory.filter((s) => s.mode === mode);
  const incident = store.state.incidents.find((i) => i.id === request.incidentId);
  const results: WarehouseMatchRecommendation[] = [];

  const hasRequestCoords =
    typeof request.lat === 'number' &&
    typeof request.lng === 'number' &&
    Number.isFinite(request.lat) &&
    Number.isFinite(request.lng) &&
    !(request.lat === 0 && request.lng === 0);

  const urgencyBonus = request.urgency === 'critical' || incident?.severity === 'critical' ? 12 : request.urgency === 'high' ? 6 : 0;

  for (const reqItem of request.items) {
    const remainingNeeded = Math.max(0, reqItem.quantity - (reqItem.fulfilledQuantity || 0));
    if (remainingNeeded <= 0) continue;

    const candidates: WarehouseMatchRecommendation[] = [];

    for (const wh of warehouses) {
      if (!isWarehouseOperationalForDispatch(wh.status, wh.active)) continue;

      const matchingStocks = stocks.filter(
        (s) => s.warehouseId === wh.id && s.category === reqItem.category && s.availableQty > 0
      );
      if (matchingStocks.length === 0) continue;

      const totalAvail = matchingStocks.reduce((sum, s) => sum + s.availableQty, 0);
      const fulfillable = Math.min(remainingNeeded, totalAvail);
      const shortage = Math.max(0, remainingNeeded - fulfillable);

      const hasWhCoords =
        typeof wh.lat === 'number' &&
        typeof wh.lng === 'number' &&
        Number.isFinite(wh.lat) &&
        Number.isFinite(wh.lng) &&
        !(wh.lat === 0 && wh.lng === 0);

      const incompleteData = !hasRequestCoords || !hasWhCoords;
      const distanceKm = !incompleteData
        ? Math.round(haversineKm(wh.lat, wh.lng, request.lat, request.lng) * 10) / 10
        : null;

      // Multi-factor score: stock coverage (45), operational status (20), distance (20), accessibility (10), freshness (5)
      const coverageScore = (fulfillable / remainingNeeded) * 45;
      const statusScore = wh.status === 'operational' ? 20 : 10;
      const distScore = distanceKm !== null ? Math.max(0, 20 - distanceKm * 0.15) : 8;
      const accessScore = wh.accessibility === 'high' ? 10 : wh.accessibility === 'moderate' ? 6 : 2;
      const latestUpdate = Math.max(...matchingStocks.map((s) => new Date(s.updatedAt).getTime()));
      const ageHours = (Date.now() - latestUpdate) / 3600_000;
      const freshnessScore = ageHours <= 2 ? 5 : ageHours <= 24 ? 3 : 1;

      const score = Math.min(100, Math.round(coverageScore + statusScore + distScore + accessScore + freshnessScore + (fulfillable === remainingNeeded ? urgencyBonus : 0)));

      const reasons: string[] = [];
      reasons.push(`Status: ${wh.status}`);
      reasons.push(`Available ${totalAvail} ${reqItem.unit} (fulfills ${Math.round((fulfillable / remainingNeeded) * 100)}%)`);
      if (distanceKm !== null) {
        reasons.push(`Estimated distance ${distanceKm} km (straight-line)`);
      } else {
        reasons.push('Distance unavailable (incomplete location coordinates)');
      }
      reasons.push(`Access: ${wh.accessibility}`);

      candidates.push({
        warehouseId: wh.id,
        warehouseName: wh.name,
        warehouseStatus: wh.status,
        accessibility: wh.accessibility,
        resourceName: reqItem.itemName,
        category: reqItem.category,
        availableQty: totalAvail,
        requestedQty: remainingNeeded,
        fulfillableQty: fulfillable,
        shortageQty: shortage,
        estimatedDistanceKm: distanceKm,
        score,
        incompleteData,
        reason: reasons.join(' · '),
      });
    }

    candidates.sort((a, b) => b.score - a.score);
    results.push(...candidates);
  }

  return results;
}

export function computeShortagesAndReplenishment(mode: DataMode) {
  const stocks = store.state.inventory.filter((s) => s.mode === mode);
  const warehouses = store.state.warehouses.filter((w) => w.mode === mode);
  const movements = store.state.stockMovements.filter((m) => m.mode === mode && m.type === 'outbound');
  const activeIncoming = store.state.incomingSupplies.filter(
    (s) => s.mode === mode && s.status !== 'Verified' && s.status !== 'Cancelled'
  );

  const recommendations: ReplenishmentRecommendation[] = [];
  const overstocked: { stockId: string; itemName: string; warehouseName: string; availableQty: number; reorderThreshold: number }[] = [];
  const imbalances: { sku: string; itemName: string; deficitWarehouse: string; surplusWarehouse: string; suggestedTransferQty: number }[] = [];

  const now = new Date().toISOString();

  for (const stock of stocks) {
    const level = classifyStockLevel(stock);
    stock.stockStatus = level;
    const wh = warehouses.find((w) => w.id === stock.warehouseId);
    const whName = wh?.name || stock.warehouseId;
    const criticalThreshold = getCriticalThreshold(stock);

    if (stock.reorderThreshold > 0 && stock.availableQty > stock.reorderThreshold * 2.5) {
      overstocked.push({
        stockId: stock.id,
        itemName: stock.itemName,
        warehouseName: whName,
        availableQty: stock.availableQty,
        reorderThreshold: stock.reorderThreshold,
      });
    }

    if (level === 'NORMAL') continue;

    // Historical outbound demand: require >= 3 outbound movements to compute average daily demand honestly
    const stockOutbound = movements.filter((m) => m.stockId === stock.id);
    let averageDailyDemand: number | null = null;
    let averageDemandLabel = 'Insufficient historical data.';

    if (stockOutbound.length >= 3) {
      const timestamps = stockOutbound.map((m) => new Date(m.createdAt).getTime());
      const spanDays = Math.max(1, (Math.max(...timestamps) - Math.min(...timestamps)) / (24 * 3600_000));
      const totalOut = stockOutbound.reduce((sum, m) => sum + m.quantity, 0);
      averageDailyDemand = Math.round((totalOut / spanDays) * 10) / 10;
      averageDemandLabel = `${averageDailyDemand} ${stock.unit}/day (${stockOutbound.length} outbound movements)`;
    }

    // Incoming unverified supply for this warehouse & SKU
    const incomingSupplyQty = activeIncoming
      .filter((sup) => sup.warehouseId === stock.warehouseId)
      .flatMap((sup) => sup.items)
      .filter((item) => item.sku === stock.sku)
      .reduce((sum, item) => sum + item.orderedQty, 0);

    const targetStock = Math.max(stock.reorderThreshold, stock.minStock * 1.5);
    const deficit = Math.max(0, Math.ceil(targetStock - (stock.availableQty + incomingSupplyQty)));
    const priority: Severity = level === 'OUT_OF_STOCK' ? 'critical' : level === 'CRITICAL' ? 'high' : 'medium';

    recommendations.push({
      stockId: stock.id,
      itemName: stock.itemName,
      sku: stock.sku,
      category: stock.category,
      warehouseId: stock.warehouseId,
      warehouseName: whName,
      currentAvailable: stock.availableQty,
      minThreshold: stock.minStock,
      criticalThreshold,
      alertLevel: level,
      averageDailyDemand,
      averageDemandLabel,
      incomingSupplyQty,
      recommendedReplenishmentQty: deficit,
      reason:
        level === 'OUT_OF_STOCK'
          ? `Zero available stock at ${whName}; ${incomingSupplyQty} incoming.`
          : `Available (${stock.availableQty}) below ${level === 'CRITICAL' ? `critical (${criticalThreshold})` : `minimum (${stock.minStock})`} threshold; ${incomingSupplyQty} incoming.`,
      priority,
      timestamp: now,
    });

    // Detect warehouse imbalance for same SKU
    if (level === 'OUT_OF_STOCK' || level === 'CRITICAL') {
      const surplusCandidate = stocks.find(
        (other) =>
          other.id !== stock.id &&
          other.sku === stock.sku &&
          other.availableQty > other.minStock * 1.5 &&
          isWarehouseOperationalForDispatch(
            warehouses.find((w) => w.id === other.warehouseId)?.status || 'unknown',
            warehouses.find((w) => w.id === other.warehouseId)?.active
          )
      );
      if (surplusCandidate) {
        const surplusWh = warehouses.find((w) => w.id === surplusCandidate.warehouseId);
        const transferable = Math.max(
          0,
          Math.min(Math.ceil(stock.minStock - stock.availableQty), Math.floor(surplusCandidate.availableQty - surplusCandidate.minStock))
        );
        if (transferable > 0) {
          imbalances.push({
            sku: stock.sku,
            itemName: stock.itemName,
            deficitWarehouse: whName,
            surplusWarehouse: surplusWh?.name || surplusCandidate.warehouseId,
            suggestedTransferQty: transferable,
          });
        }
      }
    }
  }

  const orderRank: Record<StockAlertLevel, number> = { OUT_OF_STOCK: 0, CRITICAL: 1, LOW: 2, NORMAL: 3 };
  recommendations.sort((a, b) => orderRank[a.alertLevel] - orderRank[b.alertLevel]);

  return {
    summary: {
      outOfStockCount: recommendations.filter((r) => r.alertLevel === 'OUT_OF_STOCK').length,
      criticalCount: recommendations.filter((r) => r.alertLevel === 'CRITICAL').length,
      lowCount: recommendations.filter((r) => r.alertLevel === 'LOW').length,
      overstockedCount: overstocked.length,
      imbalanceCount: imbalances.length,
    },
    recommendations,
    overstocked,
    imbalances,
  };
}

export function computeInventoryAnalyticsOverview(
  mode: DataMode,
  filters?: { warehouseId?: string; category?: string; status?: string }
) {
  let stocks = store.state.inventory.filter((s) => s.mode === mode);
  if (filters?.warehouseId) stocks = stocks.filter((s) => s.warehouseId === filters.warehouseId);
  if (filters?.category) stocks = stocks.filter((s) => s.category === filters.category);
  if (filters?.status) stocks = stocks.filter((s) => classifyStockLevel(s) === filters.status);

  const warehouses = store.state.warehouses.filter((w) => w.mode === mode);
  const activeReservations = store.state.stockReservations.filter(
    (r) => r.mode === mode && (r.status === 'Reserved' || r.status === 'Partially Reserved' || r.status === 'Allocated')
  );
  const incoming = store.state.incomingSupplies.filter(
    (s) => s.mode === mode && s.status !== 'Verified' && s.status !== 'Cancelled'
  );
  const expiry = evaluateInventoryExpiry(mode);
  const demand = computeDemandSupplyIntelligence(mode);

  const byCategoryMap = new Map<string, { category: string; available: number; reserved: number; total: number }>();
  for (const s of stocks) {
    const label = mapCategoryToGroup(s.category);
    const cur = byCategoryMap.get(label) || { category: label, available: 0, reserved: 0, total: 0 };
    cur.available += s.availableQty;
    cur.reserved += s.reservedQty;
    cur.total += s.totalQty;
    byCategoryMap.set(label, cur);
  }

  return {
    kpis: {
      totalWarehouses: warehouses.length,
      operationalWarehouses: warehouses.filter((w) => w.status === 'operational').length,
      totalInventoryItems: stocks.length,
      totalOnHandUnits: stocks.reduce((s, i) => s + i.totalQty, 0),
      totalAvailableUnits: stocks.reduce((s, i) => s + i.availableQty, 0),
      totalReservedUnits: stocks.reduce((s, i) => s + i.reservedQty, 0),
      lowStockItems: stocks.filter((s) => classifyStockLevel(s) === 'LOW').length,
      criticalShortages: stocks.filter((s) => {
        const lvl = classifyStockLevel(s);
        return lvl === 'CRITICAL' || lvl === 'OUT_OF_STOCK';
      }).length,
      expiringItemsCount: expiry.summary.expiring7dCount + expiry.summary.expiring30dCount + expiry.summary.expiredCount,
      pendingIncomingShipments: incoming.length,
      activeReservationsCount: activeReservations.length,
      demandFulfillmentRate: demand.fulfillmentPercentage,
    },
    inventoryByCategory: Array.from(byCategoryMap.values()),
    criticalShortagesList: stocks
      .filter((s) => {
        const lvl = classifyStockLevel(s);
        return lvl === 'LOW' || lvl === 'CRITICAL' || lvl === 'OUT_OF_STOCK';
      })
      .map((s) => ({
        stockId: s.id,
        itemName: s.itemName,
        warehouseId: s.warehouseId,
        warehouseName: warehouses.find((w) => w.id === s.warehouseId)?.name || s.warehouseId,
        availableQty: s.availableQty,
        minStock: s.minStock,
        criticalStock: getCriticalThreshold(s),
        deficit: Math.max(0, s.minStock - s.availableQty),
        status: classifyStockLevel(s),
      })),
  };
}

export function computeInventoryWarehouseAnalytics(mode: DataMode) {
  const warehouses = store.state.warehouses.filter((w) => w.mode === mode);
  const stocks = store.state.inventory.filter((s) => s.mode === mode);
  const incoming = store.state.incomingSupplies.filter(
    (s) => s.mode === mode && s.status !== 'Verified' && s.status !== 'Cancelled'
  );

  return warehouses.map((wh) => {
    const whStocks = stocks.filter((s) => s.warehouseId === wh.id);
    const totalOnHand = whStocks.reduce((s, i) => s + i.totalQty, 0);
    const available = whStocks.reduce((s, i) => s + i.availableQty, 0);
    const reserved = whStocks.reduce((s, i) => s + i.reservedQty, 0);
    const shortages = whStocks.filter((s) => {
      const lvl = classifyStockLevel(s);
      return lvl === 'CRITICAL' || lvl === 'OUT_OF_STOCK';
    }).length;
    const incomingCount = incoming.filter((i) => i.warehouseId === wh.id).length;
    return {
      warehouseId: wh.id,
      name: wh.name,
      status: wh.status,
      district: wh.district || wh.region,
      capacityUnits: wh.capacityUnits,
      usedUnits: totalOnHand,
      utilizationPct: wh.capacityUnits > 0 ? Math.min(100, Math.round((totalOnHand / wh.capacityUnits) * 100)) : 0,
      availableUnits: available,
      reservedUnits: reserved,
      skuCount: whStocks.length,
      criticalShortages: shortages,
      incomingShipments: incomingCount,
    };
  });
}

export function computeInventoryMovementAnalytics(mode: DataMode) {
  const movements = store.state.stockMovements.filter((m) => m.mode === mode);
  const byDayMap = new Map<string, { date: string; inbound: number; outbound: number; reserved: number; transfers: number }>();

  let totalInbound = 0;
  let totalOutbound = 0;
  let totalReserved = 0;
  let totalReleased = 0;

  for (const m of movements) {
    const date = m.createdAt.slice(0, 10);
    const row = byDayMap.get(date) || { date, inbound: 0, outbound: 0, reserved: 0, transfers: 0 };
    if (m.type === 'inbound' || m.type === 'return') {
      row.inbound += m.quantity;
      totalInbound += m.quantity;
    } else if (m.type === 'outbound' || m.type === 'damage' || m.type === 'expiry') {
      row.outbound += m.quantity;
      totalOutbound += m.quantity;
    } else if (m.type === 'reservation') {
      row.reserved += m.quantity;
      totalReserved += m.quantity;
    } else if (m.type === 'release') {
      totalReleased += m.quantity;
    } else if (m.type === 'transfer') {
      row.transfers += m.quantity;
    }
    byDayMap.set(date, row);
  }

  return {
    totals: {
      totalMovements: movements.length,
      totalInbound,
      totalOutbound,
      totalReserved,
      totalReleased,
    },
    timeline: Array.from(byDayMap.values()).sort((a, b) => a.date.localeCompare(b.date)),
    incomingVsOutgoing: [
      { label: 'Incoming (Inbound + Return)', units: totalInbound },
      { label: 'Outgoing (Outbound + Loss)', units: totalOutbound },
      { label: 'Reserved', units: totalReserved },
    ],
  };
}
