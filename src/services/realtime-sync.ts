/**
 * Real-time Sync Service
 *
 * WebSocket-based real-time synchronization for:
 * - Shared context changes (CRDT updates)
 * - Presence updates (cursors, selections, activity)
 * - Federation messages between brokers
 * - Notifications and alerts
 */

import { WebSocketServer, WebSocket } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import { EventEmitter } from 'events';
import type { Server } from 'http';
import type { SharedContextService, SyncMessage, ContextChange, ReplicaPresence } from './shared-context.js';
import type { SocialFederationService, FederationMessage, SocialNotification } from './social-federation.js';

// ============================================================================
// Types
// ============================================================================

export type MessageType =
  | 'auth'
  | 'auth_success'
  | 'auth_error'
  | 'subscribe'
  | 'unsubscribe'
  | 'subscribed'
  | 'context_change'
  | 'presence_update'
  | 'sync_request'
  | 'sync_response'
  | 'notification'
  | 'federation_message'
  | 'ping'
  | 'pong'
  | 'error';

export interface WSMessage {
  type: MessageType;
  id: string;
  timestamp: string;
  payload: unknown;
}

export interface AuthPayload {
  brokerId: string;
  token?: string;
}

export interface SubscribePayload {
  channel: 'context' | 'presence' | 'notifications' | 'federation';
  contextId?: string;
}

export interface ContextChangePayload {
  contextId: string;
  change: ContextChange;
}

export interface PresenceUpdatePayload {
  contextId: string;
  brokerId: string;
  presence: Partial<ReplicaPresence>;
}

export interface NotificationPayload {
  notification: SocialNotification;
}

export interface ClientInfo {
  id: string;
  socket: WebSocket;
  brokerId?: string;
  authenticated: boolean;
  subscriptions: Set<string>; // channel:contextId or just channel
  connectedAt: Date;
  lastPing: Date;
}

// ============================================================================
// Real-time Sync Service
// ============================================================================

export class RealtimeSyncService extends EventEmitter {
  private wss: WebSocketServer | null = null;
  private clients: Map<string, ClientInfo> = new Map();
  private brokerClients: Map<string, Set<string>> = new Map(); // brokerId -> clientIds
  private contextSubscribers: Map<string, Set<string>> = new Map(); // contextId -> clientIds
  private pingInterval: NodeJS.Timeout | null = null;

  private sharedContextService?: SharedContextService;
  private socialFederationService?: SocialFederationService;

  constructor() {
    super();
  }

  // -------------------------------------------------------------------------
  // Initialization
  // -------------------------------------------------------------------------

  /**
   * Attach to an HTTP server and start WebSocket handling
   */
  attach(server: Server, path: string = '/ws'): void {
    this.wss = new WebSocketServer({
      server,
      path
    });

    this.wss.on('connection', (socket, request) => {
      this.handleConnection(socket, request);
    });

    this.wss.on('error', (error) => {
      console.error('WebSocket server error:', error);
      this.emit('error', error);
    });

    // Start ping interval to keep connections alive
    this.pingInterval = setInterval(() => {
      this.pingAllClients();
    }, 30000);

    console.log(`WebSocket server attached at ${path}`);
  }

  /**
   * Set service references for handling sync
   */
  setServices(
    sharedContext: SharedContextService,
    socialFederation: SocialFederationService
  ): void {
    this.sharedContextService = sharedContext;
    this.socialFederationService = socialFederation;

    // Listen for context changes
    sharedContext.on('node:added', (data) => this.broadcastContextChange(data));
    sharedContext.on('node:updated', (data) => this.broadcastContextChange(data));
    sharedContext.on('node:deleted', (data) => this.broadcastContextChange(data));
    sharedContext.on('edge:added', (data) => this.broadcastContextChange(data));
    sharedContext.on('edge:deleted', (data) => this.broadcastContextChange(data));
    sharedContext.on('presence:updated', (data) => this.broadcastPresenceUpdate(data));
    sharedContext.on('conflict:detected', (data) => this.broadcastConflict(data));

    // Listen for federation events
    socialFederation.on('notification:created', (notif: SocialNotification) => this.sendNotification(notif));
  }

  /**
   * Standalone start (for testing without HTTP server)
   */
  startStandalone(port: number): void {
    this.wss = new WebSocketServer({ port });

    this.wss.on('connection', (socket, request) => {
      this.handleConnection(socket, request);
    });

    this.pingInterval = setInterval(() => {
      this.pingAllClients();
    }, 30000);

    console.log(`WebSocket server listening on port ${port}`);
  }

  /**
   * Shutdown the WebSocket server
   */
  shutdown(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }

    // Close all client connections
    for (const client of this.clients.values()) {
      client.socket.close(1001, 'Server shutting down');
    }

    this.clients.clear();
    this.brokerClients.clear();
    this.contextSubscribers.clear();

    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }
  }

  // -------------------------------------------------------------------------
  // Connection Handling
  // -------------------------------------------------------------------------

  private handleConnection(socket: WebSocket, request: any): void {
    const clientId = `ws:${uuidv4()}`;

    const client: ClientInfo = {
      id: clientId,
      socket,
      authenticated: false,
      subscriptions: new Set(),
      connectedAt: new Date(),
      lastPing: new Date()
    };

    this.clients.set(clientId, client);
    this.emit('client:connected', { clientId });

    socket.on('message', (data) => {
      this.handleMessage(client, data);
    });

    socket.on('close', (code, reason) => {
      this.handleDisconnect(client, code, reason.toString());
    });

    socket.on('error', (error) => {
      console.error(`WebSocket error for client ${clientId}:`, error);
      this.handleDisconnect(client, 1006, 'Connection error');
    });

    socket.on('pong', () => {
      client.lastPing = new Date();
    });

    // Send welcome message
    this.send(client, {
      type: 'auth',
      id: uuidv4(),
      timestamp: new Date().toISOString(),
      payload: { message: 'Please authenticate with your broker ID' }
    });
  }

  private handleDisconnect(client: ClientInfo, code: number, reason: string): void {
    // Remove from subscriptions
    for (const sub of client.subscriptions) {
      if (sub.startsWith('context:')) {
        const contextId = sub.slice(8);
        const subscribers = this.contextSubscribers.get(contextId);
        if (subscribers) {
          subscribers.delete(client.id);
        }
      }
    }

    // Remove from broker clients
    if (client.brokerId) {
      const brokerClients = this.brokerClients.get(client.brokerId);
      if (brokerClients) {
        brokerClients.delete(client.id);
      }
    }

    this.clients.delete(client.id);
    this.emit('client:disconnected', { clientId: client.id, code, reason });
  }

  // -------------------------------------------------------------------------
  // Message Handling
  // -------------------------------------------------------------------------

  private handleMessage(client: ClientInfo, rawData: any): void {
    try {
      const data = JSON.parse(rawData.toString());
      const message = data as WSMessage;

      switch (message.type) {
        case 'auth':
          this.handleAuth(client, message.payload as AuthPayload);
          break;

        case 'subscribe':
          this.handleSubscribe(client, message.payload as SubscribePayload);
          break;

        case 'unsubscribe':
          this.handleUnsubscribe(client, message.payload as SubscribePayload);
          break;

        case 'context_change':
          this.handleContextChange(client, message.payload as ContextChangePayload);
          break;

        case 'presence_update':
          this.handlePresenceUpdate(client, message.payload as PresenceUpdatePayload);
          break;

        case 'sync_request':
          this.handleSyncRequest(client, message);
          break;

        case 'ping':
          this.send(client, {
            type: 'pong',
            id: message.id,
            timestamp: new Date().toISOString(),
            payload: {}
          });
          break;

        default:
          this.sendError(client, `Unknown message type: ${message.type}`);
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Invalid message format';
      this.sendError(client, msg);
    }
  }

  private handleAuth(client: ClientInfo, payload: AuthPayload): void {
    // In production, verify token against broker registry
    // For now, accept any broker ID
    if (!payload.brokerId) {
      this.send(client, {
        type: 'auth_error',
        id: uuidv4(),
        timestamp: new Date().toISOString(),
        payload: { error: 'brokerId is required' }
      });
      return;
    }

    client.brokerId = payload.brokerId;
    client.authenticated = true;

    // Track broker clients
    if (!this.brokerClients.has(payload.brokerId)) {
      this.brokerClients.set(payload.brokerId, new Set());
    }
    this.brokerClients.get(payload.brokerId)!.add(client.id);

    this.send(client, {
      type: 'auth_success',
      id: uuidv4(),
      timestamp: new Date().toISOString(),
      payload: {
        brokerId: payload.brokerId,
        clientId: client.id
      }
    });

    this.emit('client:authenticated', { clientId: client.id, brokerId: payload.brokerId });
  }

  private handleSubscribe(client: ClientInfo, payload: SubscribePayload): void {
    if (!client.authenticated) {
      this.sendError(client, 'Not authenticated');
      return;
    }

    let subscriptionKey: string;

    switch (payload.channel) {
      case 'context':
        if (!payload.contextId) {
          this.sendError(client, 'contextId required for context subscription');
          return;
        }
        subscriptionKey = `context:${payload.contextId}`;

        // Add to context subscribers
        if (!this.contextSubscribers.has(payload.contextId)) {
          this.contextSubscribers.set(payload.contextId, new Set());
        }
        this.contextSubscribers.get(payload.contextId)!.add(client.id);
        break;

      case 'presence':
        if (!payload.contextId) {
          this.sendError(client, 'contextId required for presence subscription');
          return;
        }
        subscriptionKey = `presence:${payload.contextId}`;
        break;

      case 'notifications':
        subscriptionKey = 'notifications';
        break;

      case 'federation':
        subscriptionKey = 'federation';
        break;

      default:
        this.sendError(client, `Unknown channel: ${payload.channel}`);
        return;
    }

    client.subscriptions.add(subscriptionKey);

    this.send(client, {
      type: 'subscribed',
      id: uuidv4(),
      timestamp: new Date().toISOString(),
      payload: {
        channel: payload.channel,
        contextId: payload.contextId,
        subscriptionKey
      }
    });
  }

  private handleUnsubscribe(client: ClientInfo, payload: SubscribePayload): void {
    let subscriptionKey: string;

    switch (payload.channel) {
      case 'context':
        subscriptionKey = `context:${payload.contextId}`;
        if (payload.contextId) {
          const subscribers = this.contextSubscribers.get(payload.contextId);
          if (subscribers) {
            subscribers.delete(client.id);
          }
        }
        break;

      case 'presence':
        subscriptionKey = `presence:${payload.contextId}`;
        break;

      case 'notifications':
        subscriptionKey = 'notifications';
        break;

      case 'federation':
        subscriptionKey = 'federation';
        break;

      default:
        return;
    }

    client.subscriptions.delete(subscriptionKey);
  }

  private handleContextChange(client: ClientInfo, payload: ContextChangePayload): void {
    if (!client.authenticated || !client.brokerId) {
      this.sendError(client, 'Not authenticated');
      return;
    }

    if (!this.sharedContextService) {
      this.sendError(client, 'Shared context service not available');
      return;
    }

    // Apply the change through the service
    const result = this.sharedContextService.applyRemoteChange(
      payload.contextId,
      payload.change
    );

    if (!result.success && result.conflict) {
      // Notify client of conflict
      this.send(client, {
        type: 'error',
        id: uuidv4(),
        timestamp: new Date().toISOString(),
        payload: {
          error: 'Conflict detected',
          conflict: result.conflict
        }
      });
    }
  }

  private handlePresenceUpdate(client: ClientInfo, payload: PresenceUpdatePayload): void {
    if (!client.authenticated || !client.brokerId) {
      this.sendError(client, 'Not authenticated');
      return;
    }

    if (!this.sharedContextService) {
      this.sendError(client, 'Shared context service not available');
      return;
    }

    // Update presence through the service
    this.sharedContextService.updatePresence(
      payload.contextId,
      payload.brokerId,
      payload.presence
    );
  }

  private handleSyncRequest(client: ClientInfo, message: WSMessage): void {
    if (!client.authenticated) {
      this.sendError(client, 'Not authenticated');
      return;
    }

    if (!this.sharedContextService) {
      this.sendError(client, 'Shared context service not available');
      return;
    }

    const payload = message.payload as { contextId: string; replicaId: string };
    const response = this.sharedContextService.handleSyncRequest({
      type: 'sync_request',
      contextId: payload.contextId,
      replicaId: payload.replicaId,
      vectorClock: {},
      payload: {},
      timestamp: new Date()
    });

    if (response) {
      this.send(client, {
        type: 'sync_response',
        id: uuidv4(),
        timestamp: new Date().toISOString(),
        payload: response
      });
    }
  }

  // -------------------------------------------------------------------------
  // Broadcasting
  // -------------------------------------------------------------------------

  private broadcastContextChange(data: { contextId: string; change?: ContextChange; node?: any; edge?: any }): void {
    const contextId = data.contextId;
    const subscribers = this.contextSubscribers.get(contextId);

    if (!subscribers || subscribers.size === 0) return;

    const message: WSMessage = {
      type: 'context_change',
      id: uuidv4(),
      timestamp: new Date().toISOString(),
      payload: data
    };

    for (const clientId of subscribers) {
      const client = this.clients.get(clientId);
      if (client && client.socket.readyState === WebSocket.OPEN) {
        this.send(client, message);
      }
    }
  }

  private broadcastPresenceUpdate(data: { contextId: string; replicaId: string; presence: ReplicaPresence }): void {
    const contextId = data.contextId;
    const subscribers = this.contextSubscribers.get(contextId);

    if (!subscribers || subscribers.size === 0) return;

    const message: WSMessage = {
      type: 'presence_update',
      id: uuidv4(),
      timestamp: new Date().toISOString(),
      payload: data
    };

    for (const clientId of subscribers) {
      const client = this.clients.get(clientId);
      if (client && client.socket.readyState === WebSocket.OPEN) {
        // Don't send presence back to the originating client
        if (client.id !== data.replicaId) {
          this.send(client, message);
        }
      }
    }
  }

  private broadcastConflict(data: { contextId: string; conflict: any }): void {
    const contextId = data.contextId;
    const subscribers = this.contextSubscribers.get(contextId);

    if (!subscribers || subscribers.size === 0) return;

    const message: WSMessage = {
      type: 'error',
      id: uuidv4(),
      timestamp: new Date().toISOString(),
      payload: {
        error: 'Conflict detected in shared context',
        ...data
      }
    };

    for (const clientId of subscribers) {
      const client = this.clients.get(clientId);
      if (client && client.socket.readyState === WebSocket.OPEN) {
        this.send(client, message);
      }
    }
  }

  private sendNotification(notification: SocialNotification): void {
    const brokerId = notification.forBrokerId;
    const clientIds = this.brokerClients.get(brokerId);

    if (!clientIds || clientIds.size === 0) return;

    const message: WSMessage = {
      type: 'notification',
      id: uuidv4(),
      timestamp: new Date().toISOString(),
      payload: { notification }
    };

    for (const clientId of clientIds) {
      const client = this.clients.get(clientId);
      if (client && client.subscriptions.has('notifications')) {
        this.send(client, message);
      }
    }
  }

  /**
   * Send a federation message to a specific broker
   */
  sendFederationMessage(toBrokerId: string, message: FederationMessage): boolean {
    const clientIds = this.brokerClients.get(toBrokerId);

    if (!clientIds || clientIds.size === 0) return false;

    const wsMessage: WSMessage = {
      type: 'federation_message',
      id: uuidv4(),
      timestamp: new Date().toISOString(),
      payload: message
    };

    let sent = false;
    for (const clientId of clientIds) {
      const client = this.clients.get(clientId);
      if (client && client.subscriptions.has('federation')) {
        this.send(client, wsMessage);
        sent = true;
      }
    }

    return sent;
  }

  // -------------------------------------------------------------------------
  // Utilities
  // -------------------------------------------------------------------------

  private send(client: ClientInfo, message: WSMessage): void {
    if (client.socket.readyState === WebSocket.OPEN) {
      client.socket.send(JSON.stringify(message));
    }
  }

  private sendError(client: ClientInfo, error: string): void {
    this.send(client, {
      type: 'error',
      id: uuidv4(),
      timestamp: new Date().toISOString(),
      payload: { error }
    });
  }

  private pingAllClients(): void {
    const now = new Date();
    const timeout = 60000; // 60 seconds

    for (const [clientId, client] of this.clients) {
      // Check for dead connections
      if (now.getTime() - client.lastPing.getTime() > timeout) {
        console.log(`Client ${clientId} timed out, disconnecting`);
        client.socket.terminate();
        this.handleDisconnect(client, 1006, 'Ping timeout');
        continue;
      }

      // Send ping
      if (client.socket.readyState === WebSocket.OPEN) {
        client.socket.ping();
      }
    }
  }

  // -------------------------------------------------------------------------
  // Stats
  // -------------------------------------------------------------------------

  getStats(): object {
    return {
      totalClients: this.clients.size,
      authenticatedClients: Array.from(this.clients.values()).filter(c => c.authenticated).length,
      brokerCount: this.brokerClients.size,
      contextSubscriptions: this.contextSubscribers.size,
      subscriptionsByContext: Object.fromEntries(
        Array.from(this.contextSubscribers.entries()).map(([k, v]) => [k, v.size])
      )
    };
  }

  getConnectedBrokers(): string[] {
    return Array.from(this.brokerClients.keys());
  }

  isConnected(brokerId: string): boolean {
    const clients = this.brokerClients.get(brokerId);
    return clients !== undefined && clients.size > 0;
  }
}

// Export factory function
export function createRealtimeSyncService(): RealtimeSyncService {
  return new RealtimeSyncService();
}
