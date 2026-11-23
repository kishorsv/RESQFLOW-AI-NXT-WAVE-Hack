import type { IncomingMessage } from 'node:http';
import { v4 as uuidv4 } from 'uuid';
import { WebSocket, WebSocketServer } from 'ws';
import type { DataMode, SystemEvent, UserRole } from '../src/shared/types.ts';
import { store } from './store.ts';

export interface RealtimeClientMeta {
  uid: string;
  orgId: string;
  role: UserRole;
  connectedAt: number;
  isAlive: boolean;
}

const MAX_WS_CLIENTS = 500;
const MAX_CLIENT_BUFFERED_BYTES = 1024 * 1024; // 1MB slow-consumer threshold
const HEARTBEAT_INTERVAL_MS = 30_000;

const COMMAND_WIDE_ROLES = new Set<UserRole>(['super_admin', 'emergency_commander']);

class RealtimeEventBus {
  private clients = new Map<WebSocket, RealtimeClientMeta>();
  private listeners = new Set<(event: SystemEvent) => void>();
  private publishedCount = 0;
  private failedDeliveries = 0;
  private droppedBackpressure = 0;
  private rejectedConnections = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  public subscribe(listener: (event: SystemEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public canAcceptConnection(): boolean {
    if (this.clients.size >= MAX_WS_CLIENTS) {
      this.rejectedConnections += 1;
      return false;
    }
    return true;
  }

  private canReceiveEvent(meta: RealtimeClientMeta, event: SystemEvent): boolean {
    // Demo mode events are visible to all authenticated users exploring the shared demo sandbox
    if (event.mode === 'demo') return true;
    // Operational mode events are scoped to same organization or command-wide roles
    if (COMMAND_WIDE_ROLES.has(meta.role)) return true;
    if (!event.organization_id || event.organization_id === 'all') return true;
    return event.organization_id === meta.orgId;
  }

  public attach(wss: WebSocketServer) {
    if (!this.heartbeatTimer) {
      this.heartbeatTimer = setInterval(() => {
        for (const [ws, meta] of this.clients) {
          if (!meta.isAlive || ws.readyState !== WebSocket.OPEN) {
            this.clients.delete(ws);
            try {
              ws.terminate();
            } catch {
              // ignore
            }
            continue;
          }
          meta.isAlive = false;
          try {
            ws.ping();
          } catch {
            this.clients.delete(ws);
          }
        }
      }, HEARTBEAT_INTERVAL_MS);
      if (typeof this.heartbeatTimer.unref === 'function') {
        this.heartbeatTimer.unref();
      }
    }

    wss.on('connection', (ws, req: IncomingMessage & { resqflowActor?: { uid: string; orgId: string; role: UserRole } }) => {
      if (this.clients.size >= MAX_WS_CLIENTS) {
        this.rejectedConnections += 1;
        ws.close(1013, 'Realtime capacity reached. Please reconnect shortly.');
        return;
      }

      const actor = req.resqflowActor || {
        uid: 'unknown',
        orgId: 'org-central-cmd',
        role: 'field_responder' as UserRole,
      };
      const meta: RealtimeClientMeta = {
        uid: actor.uid,
        orgId: actor.orgId,
        role: actor.role,
        connectedAt: Date.now(),
        isAlive: true,
      };
      this.clients.set(ws, meta);

      ws.on('pong', () => {
        meta.isAlive = true;
      });

      const url = new URL(req.url || '/ws/events', 'http://localhost');
      const sinceEventId = url.searchParams.get('sinceEventId');

      // Send initial connection ack + org-scoped missed events reconciliation
      const missed = this.getEventsSince(sinceEventId).filter((ev) => this.canReceiveEvent(meta, ev));
      try {
        ws.send(
          JSON.stringify({
            type: 'connection.ack',
            status: 'LIVE',
            serverTime: new Date().toISOString(),
            connectedClients: this.clients.size,
            reconciledEvents: missed,
          })
        );
      } catch {
        this.clients.delete(ws);
        return;
      }

      ws.on('message', (raw) => {
        meta.isAlive = true;
        if (raw.toString().length > 4096) return;
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.type === 'ping') {
            ws.send(JSON.stringify({ type: 'pong', serverTime: new Date().toISOString() }));
          }
        } catch {
          // ignore malformed client frames
        }
      });

      ws.on('close', () => {
        this.clients.delete(ws);
      });

      ws.on('error', () => {
        this.clients.delete(ws);
      });
    });
  }

  public publish(params: {
    event_type: string;
    organization_id: string;
    entity_id: string;
    source: string;
    mode: DataMode;
    payload: Record<string, unknown>;
    correlation_id?: string;
  }): SystemEvent {
    const event: SystemEvent = {
      event_id: uuidv4(),
      event_type: params.event_type,
      organization_id: params.organization_id,
      entity_id: params.entity_id,
      timestamp: new Date().toISOString(),
      version: 1,
      source: params.source,
      mode: params.mode,
      payload: params.payload,
      correlation_id: params.correlation_id || uuidv4(),
    };

    // Persist in outbox/event log first
    store.state.events.unshift(event);
    if (store.state.events.length > 300) {
      store.state.events.length = 300;
    }
    store.save();
    this.publishedCount += 1;

    const serialized = JSON.stringify({ type: 'event', event });
    for (const [client, meta] of this.clients) {
      if (client.readyState !== WebSocket.OPEN) {
        this.clients.delete(client);
        continue;
      }
      if (!this.canReceiveEvent(meta, event)) {
        continue;
      }
      // Protect server memory from slow consumers with unbounded send buffers
      if (client.bufferedAmount > MAX_CLIENT_BUFFERED_BYTES) {
        this.droppedBackpressure += 1;
        continue;
      }
      try {
        client.send(serialized);
      } catch {
        this.failedDeliveries += 1;
        this.clients.delete(client);
      }
    }

    store.updateIntegrationHealth('int-realtime', {
      status: 'healthy',
      lastSuccessAt: event.timestamp,
      lastError: null,
    });

    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        console.error('EventBus subscriber error:', err);
      }
    }

    return event;
  }

  public getEventsSince(sinceEventId: string | null): SystemEvent[] {
    if (!sinceEventId) return store.state.events.slice(0, 25);
    const idx = store.state.events.findIndex((e) => e.event_id === sinceEventId);
    if (idx <= 0) return [];
    return store.state.events.slice(0, idx);
  }

  public shutdown() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    for (const [client] of this.clients) {
      try {
        client.close(1001, 'Server restarting');
      } catch {
        // ignore
      }
    }
    this.clients.clear();
  }

  public getStats() {
    return {
      connectedClients: this.clients.size,
      maxClients: MAX_WS_CLIENTS,
      publishedEvents: this.publishedCount,
      storedEvents: store.state.events.length,
      failedDeliveries: this.failedDeliveries,
      droppedBackpressure: this.droppedBackpressure,
      rejectedConnections: this.rejectedConnections,
      status: 'LIVE' as const,
    };
  }
}

export const eventBus = new RealtimeEventBus();

