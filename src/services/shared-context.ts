/**
 * Shared Context Service
 *
 * Implements multiplayer context graphs with real-time synchronization.
 * Supports CRDT, Operational Transform, and other sync strategies.
 *
 * Based on spec/ontology/shared-context.ttl
 */

import { v4 as uuidv4 } from 'uuid';
import { EventEmitter } from 'events';

// ============================================================================
// Types
// ============================================================================

export type SyncStrategy = 'crdt' | 'operational_transform' | 'last_write_wins' | 'version_vector' | 'event_sourcing';
export type ConflictResolution = 'manual' | 'auto_merge' | 'last_write_wins' | 'first_write_wins' | 'custom';
export type ChangeType = 'add' | 'update' | 'delete' | 'move' | 'merge' | 'split';
export type ConflictStatus = 'detected' | 'resolved' | 'auto_resolved' | 'manual_pending';
export type AccessLevel = 'read' | 'write' | 'admin' | 'owner';
export type PresenceState = 'active' | 'idle' | 'away' | 'offline';

export interface SharedContext {
  id: string;
  name: string;
  description?: string;
  ownerBrokerId: string;
  syncStrategy: SyncStrategy;
  conflictResolution: ConflictResolution;
  createdAt: Date;
  updatedAt: Date;

  // Version tracking
  version: number;
  vectorClock: VectorClock;

  // Access control (WebACL-inspired)
  accessList: AccessEntry[];
  isPublic: boolean;

  // The actual context graph data
  graph: ContextGraph;

  // Active replicas
  replicas: Map<string, ContextReplica>;

  // Change history (for event sourcing)
  changeLog: ContextChange[];

  // Pending conflicts
  conflicts: ContextConflict[];
}

export interface VectorClock {
  [replicaId: string]: number;
}

export interface AccessEntry {
  brokerId: string;
  level: AccessLevel;
  grantedAt: Date;
  grantedBy: string;
  expiresAt?: Date;
}

export interface ContextGraph {
  nodes: Map<string, ContextNode>;
  edges: Map<string, ContextEdge>;
  metadata: Record<string, unknown>;
}

export interface ContextNode {
  id: string;
  type: string;
  data: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
  createdBy: string;
  version: number;
}

export interface ContextEdge {
  id: string;
  sourceId: string;
  targetId: string;
  type: string;
  data: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
  createdBy: string;
  version: number;
}

export interface ContextReplica {
  id: string;
  contextId: string;
  brokerId: string;
  lastSyncAt: Date;
  localVersion: number;
  vectorClock: VectorClock;
  status: 'synced' | 'syncing' | 'behind' | 'ahead' | 'diverged';

  // Presence info for this replica
  presence?: ReplicaPresence;
}

export interface ReplicaPresence {
  state: PresenceState;
  cursor?: CursorPosition;
  selection?: SelectionRange;
  lastActivity: Date;
  viewportBounds?: ViewportBounds;
}

export interface CursorPosition {
  nodeId: string;
  field?: string;
  offset?: number;
}

export interface SelectionRange {
  startNodeId: string;
  endNodeId: string;
  startOffset?: number;
  endOffset?: number;
}

export interface ViewportBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  zoom: number;
}

export interface ContextChange {
  id: string;
  contextId: string;
  replicaId: string;
  brokerId: string;
  type: ChangeType;
  timestamp: Date;
  vectorClock: VectorClock;

  // What changed
  targetType: 'node' | 'edge' | 'metadata';
  targetId: string;
  path?: string; // For nested updates

  // Change data
  previousValue?: unknown;
  newValue?: unknown;

  // For CRDT operations
  operation?: CRDTOperation;
}

export interface CRDTOperation {
  type: 'lww_register' | 'g_counter' | 'pn_counter' | 'or_set' | 'rga' | 'lww_map';
  data: unknown;
}

export interface ContextConflict {
  id: string;
  contextId: string;
  status: ConflictStatus;
  detectedAt: Date;
  resolvedAt?: Date;
  resolvedBy?: string;

  // Conflicting changes
  changes: ContextChange[];

  // Resolution
  resolution?: ConflictResolutionResult;
}

export interface ConflictResolutionResult {
  strategy: ConflictResolution;
  winningChangeId: string;
  mergedValue?: unknown;
  appliedAt: Date;
}

export interface SharedContextConfig {
  name: string;
  description?: string;
  syncStrategy?: SyncStrategy;
  conflictResolution?: ConflictResolution;
  isPublic?: boolean;
  initialAccess?: Array<{ brokerId: string; level: AccessLevel }>;
}

export interface SyncMessage {
  type: 'sync_request' | 'sync_response' | 'change' | 'ack' | 'conflict' | 'presence_update';
  contextId: string;
  replicaId: string;
  vectorClock: VectorClock;
  payload: unknown;
  timestamp: Date;
}

// ============================================================================
// CRDT Implementations
// ============================================================================

/**
 * Last-Writer-Wins Register
 */
export class LWWRegister<T> {
  private value: T;
  private timestamp: number;
  private replicaId: string;

  constructor(initialValue: T, replicaId: string) {
    this.value = initialValue;
    this.timestamp = Date.now();
    this.replicaId = replicaId;
  }

  get(): T {
    return this.value;
  }

  set(value: T, timestamp?: number): void {
    const ts = timestamp ?? Date.now();
    // Use >= to allow updates when timestamps are equal (same millisecond)
    // This ensures sequential operations in the same ms still work correctly
    if (ts >= this.timestamp) {
      this.value = value;
      this.timestamp = ts;
    }
  }

  merge(other: LWWRegister<T>): void {
    if (other.timestamp > this.timestamp ||
        (other.timestamp === this.timestamp && other.replicaId > this.replicaId)) {
      this.value = other.value;
      this.timestamp = other.timestamp;
      this.replicaId = other.replicaId;
    }
  }

  state(): { value: T; timestamp: number; replicaId: string } {
    return { value: this.value, timestamp: this.timestamp, replicaId: this.replicaId };
  }
}

/**
 * Grow-Only Counter
 */
export class GCounter {
  private counts: Map<string, number> = new Map();

  constructor(private replicaId: string) {
    this.counts.set(replicaId, 0);
  }

  increment(amount: number = 1): void {
    const current = this.counts.get(this.replicaId) ?? 0;
    this.counts.set(this.replicaId, current + amount);
  }

  value(): number {
    let sum = 0;
    for (const count of this.counts.values()) {
      sum += count;
    }
    return sum;
  }

  merge(other: GCounter): void {
    for (const [replicaId, count] of other.counts) {
      const current = this.counts.get(replicaId) ?? 0;
      this.counts.set(replicaId, Math.max(current, count));
    }
  }

  state(): Record<string, number> {
    return Object.fromEntries(this.counts);
  }
}

/**
 * Positive-Negative Counter
 */
export class PNCounter {
  private positive: GCounter;
  private negative: GCounter;

  constructor(replicaId: string) {
    this.positive = new GCounter(replicaId);
    this.negative = new GCounter(replicaId);
  }

  increment(amount: number = 1): void {
    this.positive.increment(amount);
  }

  decrement(amount: number = 1): void {
    this.negative.increment(amount);
  }

  value(): number {
    return this.positive.value() - this.negative.value();
  }

  merge(other: PNCounter): void {
    this.positive.merge(other.positive);
    this.negative.merge(other.negative);
  }
}

/**
 * Observed-Remove Set (OR-Set)
 * Allows adds and removes without conflicts
 */
export class ORSet<T> {
  private elements: Map<string, { value: T; unique: string; deleted: boolean }> = new Map();

  constructor(private replicaId: string) {}

  add(value: T): string {
    const unique = `${this.replicaId}:${uuidv4()}`;
    this.elements.set(unique, { value, unique, deleted: false });
    return unique;
  }

  remove(value: T): void {
    for (const [key, element] of this.elements) {
      if (element.value === value && !element.deleted) {
        element.deleted = true;
      }
    }
  }

  removeByUnique(unique: string): void {
    const element = this.elements.get(unique);
    if (element) {
      element.deleted = true;
    }
  }

  has(value: T): boolean {
    for (const element of this.elements.values()) {
      if (element.value === value && !element.deleted) {
        return true;
      }
    }
    return false;
  }

  values(): T[] {
    const result: T[] = [];
    const seen = new Set<string>();
    for (const element of this.elements.values()) {
      if (!element.deleted) {
        const key = JSON.stringify(element.value);
        if (!seen.has(key)) {
          seen.add(key);
          result.push(element.value);
        }
      }
    }
    return result;
  }

  merge(other: ORSet<T>): void {
    for (const [key, element] of other.elements) {
      const existing = this.elements.get(key);
      if (!existing) {
        this.elements.set(key, { ...element });
      } else if (element.deleted) {
        existing.deleted = true;
      }
    }
  }

  state(): Array<{ value: T; unique: string; deleted: boolean }> {
    return Array.from(this.elements.values());
  }
}

/**
 * Last-Writer-Wins Map
 */
export class LWWMap<K, V> {
  private registers: Map<string, LWWRegister<{ value: V; deleted: boolean }>> = new Map();

  constructor(private replicaId: string) {}

  set(key: K, value: V): void {
    const keyStr = JSON.stringify(key);
    const existing = this.registers.get(keyStr);
    if (existing) {
      existing.set({ value, deleted: false });
    } else {
      this.registers.set(keyStr, new LWWRegister({ value, deleted: false }, this.replicaId));
    }
  }

  delete(key: K): void {
    const keyStr = JSON.stringify(key);
    const existing = this.registers.get(keyStr);
    if (existing) {
      const current = existing.get();
      existing.set({ value: current.value, deleted: true });
    }
  }

  get(key: K): V | undefined {
    const keyStr = JSON.stringify(key);
    const register = this.registers.get(keyStr);
    if (register) {
      const state = register.get();
      if (!state.deleted) {
        return state.value;
      }
    }
    return undefined;
  }

  has(key: K): boolean {
    return this.get(key) !== undefined;
  }

  entries(): Array<[K, V]> {
    const result: Array<[K, V]> = [];
    for (const [keyStr, register] of this.registers) {
      const state = register.get();
      if (!state.deleted) {
        result.push([JSON.parse(keyStr), state.value]);
      }
    }
    return result;
  }

  merge(other: LWWMap<K, V>): void {
    for (const [keyStr, otherRegister] of other.registers) {
      const existing = this.registers.get(keyStr);
      if (!existing) {
        this.registers.set(keyStr, new LWWRegister(otherRegister.get(), this.replicaId));
      } else {
        existing.merge(otherRegister);
      }
    }
  }
}

// ============================================================================
// Shared Context Service
// ============================================================================

export class SharedContextService extends EventEmitter {
  private contexts: Map<string, SharedContext> = new Map();
  private replicasByBroker: Map<string, Set<string>> = new Map(); // brokerId -> set of contextIds

  constructor() {
    super();
  }

  // -------------------------------------------------------------------------
  // Context Management
  // -------------------------------------------------------------------------

  createContext(ownerBrokerId: string, config: SharedContextConfig): SharedContext {
    const id = `sc:${uuidv4()}`;
    const now = new Date();

    const initialAccess: AccessEntry[] = [
      {
        brokerId: ownerBrokerId,
        level: 'owner',
        grantedAt: now,
        grantedBy: ownerBrokerId
      },
      ...(config.initialAccess ?? []).map(a => ({
        brokerId: a.brokerId,
        level: a.level,
        grantedAt: now,
        grantedBy: ownerBrokerId
      }))
    ];

    const context: SharedContext = {
      id,
      name: config.name,
      description: config.description,
      ownerBrokerId,
      syncStrategy: config.syncStrategy ?? 'crdt',
      conflictResolution: config.conflictResolution ?? 'auto_merge',
      createdAt: now,
      updatedAt: now,
      version: 0,
      vectorClock: {},
      accessList: initialAccess,
      isPublic: config.isPublic ?? false,
      graph: {
        nodes: new Map(),
        edges: new Map(),
        metadata: {}
      },
      replicas: new Map(),
      changeLog: [],
      conflicts: []
    };

    this.contexts.set(id, context);

    // Auto-create owner replica
    this.joinContext(id, ownerBrokerId);

    this.emit('context:created', { context });
    return context;
  }

  getContext(contextId: string): SharedContext | undefined {
    return this.contexts.get(contextId);
  }

  getContextsForBroker(brokerId: string): SharedContext[] {
    const contextIds = this.replicasByBroker.get(brokerId);
    if (!contextIds) return [];

    return Array.from(contextIds)
      .map(id => this.contexts.get(id))
      .filter((c): c is SharedContext => c !== undefined);
  }

  deleteContext(contextId: string, requestingBrokerId: string): boolean {
    const context = this.contexts.get(contextId);
    if (!context) return false;

    // Only owner can delete
    if (context.ownerBrokerId !== requestingBrokerId) {
      return false;
    }

    // Remove all replica references
    for (const replica of context.replicas.values()) {
      const brokerContexts = this.replicasByBroker.get(replica.brokerId);
      if (brokerContexts) {
        brokerContexts.delete(contextId);
      }
    }

    this.contexts.delete(contextId);
    this.emit('context:deleted', { contextId, deletedBy: requestingBrokerId });
    return true;
  }

  // -------------------------------------------------------------------------
  // Access Control
  // -------------------------------------------------------------------------

  grantAccess(
    contextId: string,
    grantingBrokerId: string,
    targetBrokerId: string,
    level: AccessLevel
  ): boolean {
    const context = this.contexts.get(contextId);
    if (!context) return false;

    const granterAccess = this.getAccessLevel(contextId, grantingBrokerId);
    if (!granterAccess || (granterAccess !== 'owner' && granterAccess !== 'admin')) {
      return false;
    }

    // Can't grant higher than own level
    const levelOrder: AccessLevel[] = ['read', 'write', 'admin', 'owner'];
    if (levelOrder.indexOf(level) > levelOrder.indexOf(granterAccess)) {
      return false;
    }

    // Update or add access
    const existingIndex = context.accessList.findIndex(a => a.brokerId === targetBrokerId);
    if (existingIndex >= 0) {
      context.accessList[existingIndex].level = level;
    } else {
      context.accessList.push({
        brokerId: targetBrokerId,
        level,
        grantedAt: new Date(),
        grantedBy: grantingBrokerId
      });
    }

    this.emit('access:granted', { contextId, targetBrokerId, level, grantedBy: grantingBrokerId });
    return true;
  }

  revokeAccess(contextId: string, revokingBrokerId: string, targetBrokerId: string): boolean {
    const context = this.contexts.get(contextId);
    if (!context) return false;

    const revokerAccess = this.getAccessLevel(contextId, revokingBrokerId);
    if (!revokerAccess || (revokerAccess !== 'owner' && revokerAccess !== 'admin')) {
      return false;
    }

    // Can't revoke owner
    if (context.ownerBrokerId === targetBrokerId) {
      return false;
    }

    const index = context.accessList.findIndex(a => a.brokerId === targetBrokerId);
    if (index >= 0) {
      context.accessList.splice(index, 1);

      // Remove their replica if they have one
      this.leaveContext(contextId, targetBrokerId);

      this.emit('access:revoked', { contextId, targetBrokerId, revokedBy: revokingBrokerId });
      return true;
    }
    return false;
  }

  getAccessLevel(contextId: string, brokerId: string): AccessLevel | null {
    const context = this.contexts.get(contextId);
    if (!context) return null;

    const entry = context.accessList.find(a => a.brokerId === brokerId);
    if (entry) {
      // Check expiration
      if (entry.expiresAt && entry.expiresAt < new Date()) {
        return null;
      }
      return entry.level;
    }

    if (context.isPublic) {
      return 'read';
    }

    return null;
  }

  // -------------------------------------------------------------------------
  // Replica Management
  // -------------------------------------------------------------------------

  joinContext(contextId: string, brokerId: string): ContextReplica | null {
    const context = this.contexts.get(contextId);
    if (!context) return null;

    const accessLevel = this.getAccessLevel(contextId, brokerId);
    if (!accessLevel) return null;

    // Check if already has replica
    const existingReplica = Array.from(context.replicas.values())
      .find(r => r.brokerId === brokerId);
    if (existingReplica) {
      return existingReplica;
    }

    const replicaId = `replica:${uuidv4()}`;
    const replica: ContextReplica = {
      id: replicaId,
      contextId,
      brokerId,
      lastSyncAt: new Date(),
      localVersion: context.version,
      vectorClock: { ...context.vectorClock },
      status: 'synced',
      presence: {
        state: 'active',
        lastActivity: new Date()
      }
    };

    context.replicas.set(replicaId, replica);
    context.vectorClock[replicaId] = 0;

    // Track replica by broker
    if (!this.replicasByBroker.has(brokerId)) {
      this.replicasByBroker.set(brokerId, new Set());
    }
    this.replicasByBroker.get(brokerId)!.add(contextId);

    this.emit('replica:joined', { contextId, replica });
    return replica;
  }

  leaveContext(contextId: string, brokerId: string): boolean {
    const context = this.contexts.get(contextId);
    if (!context) return false;

    for (const [replicaId, replica] of context.replicas) {
      if (replica.brokerId === brokerId) {
        context.replicas.delete(replicaId);

        const brokerContexts = this.replicasByBroker.get(brokerId);
        if (brokerContexts) {
          brokerContexts.delete(contextId);
        }

        this.emit('replica:left', { contextId, replicaId, brokerId });
        return true;
      }
    }
    return false;
  }

  getReplicaForBroker(contextId: string, brokerId: string): ContextReplica | undefined {
    const context = this.contexts.get(contextId);
    if (!context) return undefined;

    return Array.from(context.replicas.values())
      .find(r => r.brokerId === brokerId);
  }

  // -------------------------------------------------------------------------
  // Graph Operations
  // -------------------------------------------------------------------------

  addNode(
    contextId: string,
    brokerId: string,
    type: string,
    data: Record<string, unknown>
  ): ContextNode | null {
    const context = this.contexts.get(contextId);
    if (!context) return null;

    const accessLevel = this.getAccessLevel(contextId, brokerId);
    if (!accessLevel || accessLevel === 'read') return null;

    const replica = this.getReplicaForBroker(contextId, brokerId);
    if (!replica) return null;

    const nodeId = `node:${uuidv4()}`;
    const now = new Date();
    const node: ContextNode = {
      id: nodeId,
      type,
      data,
      createdAt: now,
      updatedAt: now,
      createdBy: brokerId,
      version: 1
    };

    context.graph.nodes.set(nodeId, node);
    context.version++;
    context.updatedAt = now;
    context.vectorClock[replica.id] = (context.vectorClock[replica.id] ?? 0) + 1;

    // Log change
    const change = this.logChange(context, replica, 'add', 'node', nodeId, undefined, node);

    this.emit('node:added', { contextId, node, change });
    this.broadcastChange(context, change);

    return node;
  }

  updateNode(
    contextId: string,
    brokerId: string,
    nodeId: string,
    updates: Partial<Record<string, unknown>>
  ): ContextNode | null {
    const context = this.contexts.get(contextId);
    if (!context) return null;

    const accessLevel = this.getAccessLevel(contextId, brokerId);
    if (!accessLevel || accessLevel === 'read') return null;

    const replica = this.getReplicaForBroker(contextId, brokerId);
    if (!replica) return null;

    const node = context.graph.nodes.get(nodeId);
    if (!node) return null;

    const previousData = { ...node.data };
    const now = new Date();

    Object.assign(node.data, updates);
    node.updatedAt = now;
    node.version++;

    context.version++;
    context.updatedAt = now;
    context.vectorClock[replica.id] = (context.vectorClock[replica.id] ?? 0) + 1;

    const change = this.logChange(context, replica, 'update', 'node', nodeId, previousData, node.data);

    this.emit('node:updated', { contextId, node, change });
    this.broadcastChange(context, change);

    return node;
  }

  deleteNode(contextId: string, brokerId: string, nodeId: string): boolean {
    const context = this.contexts.get(contextId);
    if (!context) return false;

    const accessLevel = this.getAccessLevel(contextId, brokerId);
    if (!accessLevel || accessLevel === 'read') return false;

    const replica = this.getReplicaForBroker(contextId, brokerId);
    if (!replica) return false;

    const node = context.graph.nodes.get(nodeId);
    if (!node) return false;

    const previousValue = { ...node };
    context.graph.nodes.delete(nodeId);

    // Also delete connected edges
    for (const [edgeId, edge] of context.graph.edges) {
      if (edge.sourceId === nodeId || edge.targetId === nodeId) {
        context.graph.edges.delete(edgeId);
      }
    }

    context.version++;
    context.updatedAt = new Date();
    context.vectorClock[replica.id] = (context.vectorClock[replica.id] ?? 0) + 1;

    const change = this.logChange(context, replica, 'delete', 'node', nodeId, previousValue, undefined);

    this.emit('node:deleted', { contextId, nodeId, change });
    this.broadcastChange(context, change);

    return true;
  }

  addEdge(
    contextId: string,
    brokerId: string,
    sourceId: string,
    targetId: string,
    type: string,
    data: Record<string, unknown> = {}
  ): ContextEdge | null {
    const context = this.contexts.get(contextId);
    if (!context) return null;

    const accessLevel = this.getAccessLevel(contextId, brokerId);
    if (!accessLevel || accessLevel === 'read') return null;

    const replica = this.getReplicaForBroker(contextId, brokerId);
    if (!replica) return null;

    // Verify source and target exist
    if (!context.graph.nodes.has(sourceId) || !context.graph.nodes.has(targetId)) {
      return null;
    }

    const edgeId = `edge:${uuidv4()}`;
    const now = new Date();
    const edge: ContextEdge = {
      id: edgeId,
      sourceId,
      targetId,
      type,
      data,
      createdAt: now,
      updatedAt: now,
      createdBy: brokerId,
      version: 1
    };

    context.graph.edges.set(edgeId, edge);
    context.version++;
    context.updatedAt = now;
    context.vectorClock[replica.id] = (context.vectorClock[replica.id] ?? 0) + 1;

    const change = this.logChange(context, replica, 'add', 'edge', edgeId, undefined, edge);

    this.emit('edge:added', { contextId, edge, change });
    this.broadcastChange(context, change);

    return edge;
  }

  deleteEdge(contextId: string, brokerId: string, edgeId: string): boolean {
    const context = this.contexts.get(contextId);
    if (!context) return false;

    const accessLevel = this.getAccessLevel(contextId, brokerId);
    if (!accessLevel || accessLevel === 'read') return false;

    const replica = this.getReplicaForBroker(contextId, brokerId);
    if (!replica) return false;

    const edge = context.graph.edges.get(edgeId);
    if (!edge) return false;

    const previousValue = { ...edge };
    context.graph.edges.delete(edgeId);

    context.version++;
    context.updatedAt = new Date();
    context.vectorClock[replica.id] = (context.vectorClock[replica.id] ?? 0) + 1;

    const change = this.logChange(context, replica, 'delete', 'edge', edgeId, previousValue, undefined);

    this.emit('edge:deleted', { contextId, edgeId, change });
    this.broadcastChange(context, change);

    return true;
  }

  // -------------------------------------------------------------------------
  // Presence
  // -------------------------------------------------------------------------

  updatePresence(
    contextId: string,
    brokerId: string,
    presence: Partial<ReplicaPresence>
  ): boolean {
    const context = this.contexts.get(contextId);
    if (!context) return false;

    const replica = this.getReplicaForBroker(contextId, brokerId);
    if (!replica) return false;

    replica.presence = {
      ...replica.presence,
      ...presence,
      lastActivity: new Date()
    } as ReplicaPresence;

    this.emit('presence:updated', { contextId, replicaId: replica.id, presence: replica.presence });
    this.broadcastPresence(context, replica);

    return true;
  }

  getActiveParticipants(contextId: string): Array<{ brokerId: string; presence: ReplicaPresence }> {
    const context = this.contexts.get(contextId);
    if (!context) return [];

    const result: Array<{ brokerId: string; presence: ReplicaPresence }> = [];
    for (const replica of context.replicas.values()) {
      if (replica.presence && replica.presence.state !== 'offline') {
        result.push({
          brokerId: replica.brokerId,
          presence: replica.presence
        });
      }
    }
    return result;
  }

  // -------------------------------------------------------------------------
  // Synchronization
  // -------------------------------------------------------------------------

  private logChange(
    context: SharedContext,
    replica: ContextReplica,
    type: ChangeType,
    targetType: 'node' | 'edge' | 'metadata',
    targetId: string,
    previousValue: unknown,
    newValue: unknown
  ): ContextChange {
    const change: ContextChange = {
      id: `change:${uuidv4()}`,
      contextId: context.id,
      replicaId: replica.id,
      brokerId: replica.brokerId,
      type,
      timestamp: new Date(),
      vectorClock: { ...context.vectorClock },
      targetType,
      targetId,
      previousValue,
      newValue
    };

    context.changeLog.push(change);

    // Keep change log bounded (last 1000 changes)
    if (context.changeLog.length > 1000) {
      context.changeLog = context.changeLog.slice(-1000);
    }

    return change;
  }

  private broadcastChange(context: SharedContext, change: ContextChange): void {
    const message: SyncMessage = {
      type: 'change',
      contextId: context.id,
      replicaId: change.replicaId,
      vectorClock: change.vectorClock,
      payload: change,
      timestamp: new Date()
    };

    this.emit('sync:broadcast', { message, recipients: Array.from(context.replicas.keys()) });
  }

  private broadcastPresence(context: SharedContext, replica: ContextReplica): void {
    const message: SyncMessage = {
      type: 'presence_update',
      contextId: context.id,
      replicaId: replica.id,
      vectorClock: context.vectorClock,
      payload: { brokerId: replica.brokerId, presence: replica.presence },
      timestamp: new Date()
    };

    this.emit('sync:broadcast', { message, recipients: Array.from(context.replicas.keys()) });
  }

  applyRemoteChange(contextId: string, change: ContextChange): { success: boolean; conflict?: ContextConflict } {
    const context = this.contexts.get(contextId);
    if (!context) return { success: false };

    // Check for conflicts using vector clock
    const hasConflict = this.detectConflict(context, change);
    if (hasConflict) {
      const conflict = this.createConflict(context, change);

      if (context.conflictResolution === 'auto_merge') {
        this.autoResolveConflict(context, conflict);
        return { success: true, conflict };
      } else if (context.conflictResolution === 'last_write_wins') {
        this.lastWriteWinsResolve(context, conflict);
        return { success: true, conflict };
      }

      return { success: false, conflict };
    }

    // Apply the change
    this.applyChange(context, change);

    // Update vector clock
    this.mergeVectorClock(context.vectorClock, change.vectorClock);

    return { success: true };
  }

  private detectConflict(context: SharedContext, change: ContextChange): boolean {
    // Compare vector clocks
    // A conflict exists if neither clock dominates the other
    const localClock = context.vectorClock;
    const remoteClock = change.vectorClock;

    let localDominates = false;
    let remoteDominates = false;

    const allReplicas = new Set([...Object.keys(localClock), ...Object.keys(remoteClock)]);

    for (const replicaId of allReplicas) {
      const local = localClock[replicaId] ?? 0;
      const remote = remoteClock[replicaId] ?? 0;

      if (local > remote) localDominates = true;
      if (remote > local) remoteDominates = true;
    }

    // Concurrent changes = conflict
    return localDominates && remoteDominates;
  }

  private createConflict(context: SharedContext, incomingChange: ContextChange): ContextConflict {
    // Find conflicting local changes
    const conflictingChanges = context.changeLog.filter(c =>
      c.targetId === incomingChange.targetId &&
      c.targetType === incomingChange.targetType &&
      c.timestamp > new Date(incomingChange.timestamp.getTime() - 60000) // Within last minute
    );

    const conflict: ContextConflict = {
      id: `conflict:${uuidv4()}`,
      contextId: context.id,
      status: 'detected',
      detectedAt: new Date(),
      changes: [incomingChange, ...conflictingChanges]
    };

    context.conflicts.push(conflict);
    this.emit('conflict:detected', { contextId: context.id, conflict });

    return conflict;
  }

  private autoResolveConflict(context: SharedContext, conflict: ContextConflict): void {
    // For CRDT-style auto-merge, we merge the changes
    // This is a simplified implementation - real CRDTs would be more sophisticated

    const changes = conflict.changes.sort((a, b) =>
      a.timestamp.getTime() - b.timestamp.getTime()
    );

    // Apply all changes in timestamp order
    for (const change of changes) {
      this.applyChange(context, change);
    }

    conflict.status = 'auto_resolved';
    conflict.resolvedAt = new Date();
    conflict.resolution = {
      strategy: 'auto_merge',
      winningChangeId: changes[changes.length - 1].id,
      appliedAt: new Date()
    };

    this.emit('conflict:resolved', { contextId: context.id, conflict });
  }

  private lastWriteWinsResolve(context: SharedContext, conflict: ContextConflict): void {
    const changes = conflict.changes.sort((a, b) =>
      b.timestamp.getTime() - a.timestamp.getTime()
    );

    const winner = changes[0];
    this.applyChange(context, winner);

    conflict.status = 'auto_resolved';
    conflict.resolvedAt = new Date();
    conflict.resolution = {
      strategy: 'last_write_wins',
      winningChangeId: winner.id,
      appliedAt: new Date()
    };

    this.emit('conflict:resolved', { contextId: context.id, conflict });
  }

  private applyChange(context: SharedContext, change: ContextChange): void {
    switch (change.targetType) {
      case 'node':
        if (change.type === 'add') {
          context.graph.nodes.set(change.targetId, change.newValue as ContextNode);
        } else if (change.type === 'update') {
          const node = context.graph.nodes.get(change.targetId);
          if (node) {
            Object.assign(node.data, change.newValue);
            node.version++;
            node.updatedAt = new Date();
          }
        } else if (change.type === 'delete') {
          context.graph.nodes.delete(change.targetId);
        }
        break;

      case 'edge':
        if (change.type === 'add') {
          context.graph.edges.set(change.targetId, change.newValue as ContextEdge);
        } else if (change.type === 'delete') {
          context.graph.edges.delete(change.targetId);
        }
        break;

      case 'metadata':
        if (change.type === 'update') {
          Object.assign(context.graph.metadata, change.newValue);
        }
        break;
    }

    context.version++;
    context.updatedAt = new Date();
  }

  private mergeVectorClock(local: VectorClock, remote: VectorClock): void {
    for (const [replicaId, version] of Object.entries(remote)) {
      local[replicaId] = Math.max(local[replicaId] ?? 0, version);
    }
  }

  // -------------------------------------------------------------------------
  // Sync Protocol
  // -------------------------------------------------------------------------

  requestSync(contextId: string, replicaId: string): SyncMessage | null {
    const context = this.contexts.get(contextId);
    if (!context) return null;

    const replica = context.replicas.get(replicaId);
    if (!replica) return null;

    return {
      type: 'sync_request',
      contextId,
      replicaId,
      vectorClock: replica.vectorClock,
      payload: { lastSyncAt: replica.lastSyncAt },
      timestamp: new Date()
    };
  }

  handleSyncRequest(message: SyncMessage): SyncMessage | null {
    const context = this.contexts.get(message.contextId);
    if (!context) return null;

    // Find changes the requester doesn't have
    const missedChanges = context.changeLog.filter(change => {
      // Check if the requester has seen this change
      const requesterVersion = message.vectorClock[change.replicaId] ?? 0;
      const changeVersion = change.vectorClock[change.replicaId] ?? 0;
      return changeVersion > requesterVersion;
    });

    return {
      type: 'sync_response',
      contextId: context.id,
      replicaId: message.replicaId,
      vectorClock: context.vectorClock,
      payload: {
        changes: missedChanges,
        currentVersion: context.version
      },
      timestamp: new Date()
    };
  }

  // -------------------------------------------------------------------------
  // Query and Export
  // -------------------------------------------------------------------------

  getNodes(contextId: string, filter?: { type?: string }): ContextNode[] {
    const context = this.contexts.get(contextId);
    if (!context) return [];

    let nodes = Array.from(context.graph.nodes.values());

    if (filter?.type) {
      nodes = nodes.filter(n => n.type === filter.type);
    }

    return nodes;
  }

  getEdges(contextId: string, filter?: { type?: string; sourceId?: string; targetId?: string }): ContextEdge[] {
    const context = this.contexts.get(contextId);
    if (!context) return [];

    let edges = Array.from(context.graph.edges.values());

    if (filter?.type) {
      edges = edges.filter(e => e.type === filter.type);
    }
    if (filter?.sourceId) {
      edges = edges.filter(e => e.sourceId === filter.sourceId);
    }
    if (filter?.targetId) {
      edges = edges.filter(e => e.targetId === filter.targetId);
    }

    return edges;
  }

  exportContextAsJSON(contextId: string): object | null {
    const context = this.contexts.get(contextId);
    if (!context) return null;

    return {
      id: context.id,
      name: context.name,
      description: context.description,
      ownerBrokerId: context.ownerBrokerId,
      syncStrategy: context.syncStrategy,
      conflictResolution: context.conflictResolution,
      version: context.version,
      vectorClock: context.vectorClock,
      isPublic: context.isPublic,
      createdAt: context.createdAt.toISOString(),
      updatedAt: context.updatedAt.toISOString(),
      graph: {
        nodes: Array.from(context.graph.nodes.values()),
        edges: Array.from(context.graph.edges.values()),
        metadata: context.graph.metadata
      },
      replicas: Array.from(context.replicas.values()).map(r => ({
        id: r.id,
        brokerId: r.brokerId,
        status: r.status,
        lastSyncAt: r.lastSyncAt.toISOString()
      })),
      accessList: context.accessList.map(a => ({
        brokerId: a.brokerId,
        level: a.level
      }))
    };
  }

  getStats(): object {
    let totalNodes = 0;
    let totalEdges = 0;
    let totalReplicas = 0;

    for (const context of this.contexts.values()) {
      totalNodes += context.graph.nodes.size;
      totalEdges += context.graph.edges.size;
      totalReplicas += context.replicas.size;
    }

    return {
      totalContexts: this.contexts.size,
      totalNodes,
      totalEdges,
      totalReplicas,
      activeBrokers: this.replicasByBroker.size
    };
  }
}

// Export singleton-ready instance factory
export function createSharedContextService(): SharedContextService {
  return new SharedContextService();
}
