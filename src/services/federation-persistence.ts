/**
 * Federation Persistence Service
 *
 * SQLite-based persistence for federation data including:
 * - Social connections and profiles
 * - Shared contexts and their graphs
 * - Groups and memberships
 * - Notifications and invites
 */

import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';

// =============================================================================
// Internal Persistence Types
// These are storage-optimized types that can be mapped to/from service types
// =============================================================================

export interface StoredProfile {
  id: string;
  brokerId: string;
  displayName: string;
  bio?: string;
  avatar?: string;
  visibility: string;
  discoverableMethods: string[];
  verifiedCredentials: string[];
  createdAt: Date;
  updatedAt: Date;
}

export interface StoredConnection {
  id: string;
  fromBrokerId: string;
  toBrokerId: string;
  state: string;
  protocol: string;
  establishedAt?: Date;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface StoredConnectionRequest {
  id: string;
  fromBrokerId: string;
  toBrokerId: string;
  message?: string;
  status: string;
  createdAt: Date;
  respondedAt?: Date;
}

export interface StoredInviteLink {
  id: string;
  code: string;
  creatorBrokerId: string;
  maxUses?: number;
  useCount: number;
  expiresAt?: Date;
  createdAt: Date;
}

export interface StoredNotification {
  id: string;
  brokerId: string;
  type: string;
  title: string;
  body?: string;
  data: Record<string, unknown>;
  read: boolean;
  createdAt: Date;
}

export interface StoredGroup {
  id: string;
  name: string;
  description?: string;
  ownerBrokerId: string;
  isPublic: boolean;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface StoredGroupMembership {
  id: string;
  groupId: string;
  brokerId: string;
  role: string;
  joinedAt: Date;
}

export interface StoredContext {
  id: string;
  name: string;
  description?: string;
  ownerBrokerId: string;
  syncStrategy: string;
  conflictResolution: string;
  isPublic: boolean;
  version: number;
  vectorClock: Record<string, number>;
  createdAt: Date;
  updatedAt: Date;
}

export interface StoredAccessEntry {
  brokerId: string;
  level: string;
  grantedBy: string;
  grantedAt: Date;
  expiresAt?: Date;
}

export interface StoredContextNode {
  id: string;
  type: string;
  data: Record<string, unknown>;
  createdBy: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface StoredContextEdge {
  id: string;
  sourceId: string;
  targetId: string;
  type: string;
  data: Record<string, unknown>;
  createdBy: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface StoredContextReplica {
  id: string;
  contextId: string;
  brokerId: string;
  localVersion: number;
  vectorClock: Record<string, number>;
  status: string;
  lastSyncAt: Date;
}

export interface FederationPersistenceConfig {
  dbPath: string;
  enableWAL?: boolean;
}

export class FederationPersistenceService {
  private db: Database.Database;

  constructor(config: FederationPersistenceConfig) {
    this.db = new Database(config.dbPath);

    if (config.enableWAL !== false) {
      this.db.pragma('journal_mode = WAL');
    }

    this.initializeSchema();
  }

  private initializeSchema(): void {
    // Social Profiles
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS social_profiles (
        id TEXT PRIMARY KEY,
        broker_id TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        bio TEXT,
        avatar TEXT,
        visibility TEXT DEFAULT 'connections',
        discoverable_methods TEXT DEFAULT '[]',
        verified_credentials TEXT DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_profiles_broker ON social_profiles(broker_id);
    `);

    // Social Connections
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS social_connections (
        id TEXT PRIMARY KEY,
        from_broker_id TEXT NOT NULL,
        to_broker_id TEXT NOT NULL,
        state TEXT NOT NULL,
        protocol TEXT DEFAULT 'native_acg',
        established_at TEXT,
        metadata TEXT DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(from_broker_id, to_broker_id)
      );
      CREATE INDEX IF NOT EXISTS idx_connections_from ON social_connections(from_broker_id);
      CREATE INDEX IF NOT EXISTS idx_connections_to ON social_connections(to_broker_id);
      CREATE INDEX IF NOT EXISTS idx_connections_state ON social_connections(state);
    `);

    // Connection Requests
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS connection_requests (
        id TEXT PRIMARY KEY,
        from_broker_id TEXT NOT NULL,
        to_broker_id TEXT NOT NULL,
        message TEXT,
        status TEXT DEFAULT 'pending',
        created_at TEXT NOT NULL,
        responded_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_requests_to ON connection_requests(to_broker_id);
      CREATE INDEX IF NOT EXISTS idx_requests_status ON connection_requests(status);
    `);

    // Invite Links
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS invite_links (
        id TEXT PRIMARY KEY,
        code TEXT NOT NULL UNIQUE,
        creator_broker_id TEXT NOT NULL,
        max_uses INTEGER,
        use_count INTEGER DEFAULT 0,
        expires_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_invites_code ON invite_links(code);
      CREATE INDEX IF NOT EXISTS idx_invites_creator ON invite_links(creator_broker_id);
    `);

    // Notifications
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS notifications (
        id TEXT PRIMARY KEY,
        broker_id TEXT NOT NULL,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT,
        data TEXT DEFAULT '{}',
        read INTEGER DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_notifications_broker ON notifications(broker_id);
      CREATE INDEX IF NOT EXISTS idx_notifications_read ON notifications(read);
    `);

    // Groups
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS social_groups (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        owner_broker_id TEXT NOT NULL,
        is_public INTEGER DEFAULT 0,
        metadata TEXT DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_groups_owner ON social_groups(owner_broker_id);
    `);

    // Group Memberships
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS group_memberships (
        id TEXT PRIMARY KEY,
        group_id TEXT NOT NULL,
        broker_id TEXT NOT NULL,
        role TEXT DEFAULT 'member',
        joined_at TEXT NOT NULL,
        UNIQUE(group_id, broker_id),
        FOREIGN KEY(group_id) REFERENCES social_groups(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_memberships_group ON group_memberships(group_id);
      CREATE INDEX IF NOT EXISTS idx_memberships_broker ON group_memberships(broker_id);
    `);

    // Shared Contexts
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS shared_contexts (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        owner_broker_id TEXT NOT NULL,
        sync_strategy TEXT DEFAULT 'crdt',
        conflict_resolution TEXT DEFAULT 'auto_merge',
        is_public INTEGER DEFAULT 0,
        version INTEGER DEFAULT 1,
        vector_clock TEXT DEFAULT '{}',
        metadata TEXT DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_contexts_owner ON shared_contexts(owner_broker_id);
    `);

    // Context Access Control
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS context_access (
        id TEXT PRIMARY KEY,
        context_id TEXT NOT NULL,
        broker_id TEXT NOT NULL,
        level TEXT NOT NULL,
        granted_by TEXT NOT NULL,
        granted_at TEXT NOT NULL,
        expires_at TEXT,
        UNIQUE(context_id, broker_id),
        FOREIGN KEY(context_id) REFERENCES shared_contexts(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_access_context ON context_access(context_id);
      CREATE INDEX IF NOT EXISTS idx_access_broker ON context_access(broker_id);
    `);

    // Context Nodes
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS context_nodes (
        id TEXT PRIMARY KEY,
        context_id TEXT NOT NULL,
        type TEXT NOT NULL,
        data TEXT DEFAULT '{}',
        created_by TEXT NOT NULL,
        version INTEGER DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(context_id) REFERENCES shared_contexts(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_nodes_context ON context_nodes(context_id);
      CREATE INDEX IF NOT EXISTS idx_nodes_type ON context_nodes(type);
    `);

    // Context Edges
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS context_edges (
        id TEXT PRIMARY KEY,
        context_id TEXT NOT NULL,
        source_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        type TEXT NOT NULL,
        data TEXT DEFAULT '{}',
        created_by TEXT NOT NULL,
        version INTEGER DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(context_id) REFERENCES shared_contexts(id) ON DELETE CASCADE,
        FOREIGN KEY(source_id) REFERENCES context_nodes(id) ON DELETE CASCADE,
        FOREIGN KEY(target_id) REFERENCES context_nodes(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_edges_context ON context_edges(context_id);
      CREATE INDEX IF NOT EXISTS idx_edges_source ON context_edges(source_id);
      CREATE INDEX IF NOT EXISTS idx_edges_target ON context_edges(target_id);
    `);

    // Context Replicas
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS context_replicas (
        id TEXT PRIMARY KEY,
        context_id TEXT NOT NULL,
        broker_id TEXT NOT NULL,
        local_version INTEGER DEFAULT 0,
        vector_clock TEXT DEFAULT '{}',
        status TEXT DEFAULT 'synced',
        last_sync_at TEXT NOT NULL,
        UNIQUE(context_id, broker_id),
        FOREIGN KEY(context_id) REFERENCES shared_contexts(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_replicas_context ON context_replicas(context_id);
      CREATE INDEX IF NOT EXISTS idx_replicas_broker ON context_replicas(broker_id);
    `);

    // Change Log (for event sourcing)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS change_log (
        id TEXT PRIMARY KEY,
        context_id TEXT NOT NULL,
        change_type TEXT NOT NULL,
        target_type TEXT NOT NULL,
        target_id TEXT NOT NULL,
        broker_id TEXT NOT NULL,
        before_state TEXT,
        after_state TEXT,
        vector_clock TEXT DEFAULT '{}',
        created_at TEXT NOT NULL,
        FOREIGN KEY(context_id) REFERENCES shared_contexts(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_changelog_context ON change_log(context_id);
      CREATE INDEX IF NOT EXISTS idx_changelog_created ON change_log(created_at);
    `);
  }

  // ==========================================================================
  // Profile Operations
  // ==========================================================================

  saveProfile(profile: StoredProfile): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO social_profiles
      (id, broker_id, display_name, bio, avatar, visibility, discoverable_methods, verified_credentials, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      profile.id,
      profile.brokerId,
      profile.displayName,
      profile.bio || null,
      profile.avatar || null,
      profile.visibility,
      JSON.stringify(profile.discoverableMethods || []),
      JSON.stringify(profile.verifiedCredentials || []),
      profile.createdAt.toISOString(),
      profile.updatedAt.toISOString()
    );
  }

  getProfile(brokerId: string): StoredProfile | null {
    const stmt = this.db.prepare('SELECT * FROM social_profiles WHERE broker_id = ?');
    const row = stmt.get(brokerId) as any;
    if (!row) return null;
    return this.rowToProfile(row);
  }

  private rowToProfile(row: any): StoredProfile {
    return {
      id: row.id,
      brokerId: row.broker_id,
      displayName: row.display_name,
      bio: row.bio,
      avatar: row.avatar,
      visibility: row.visibility,
      discoverableMethods: JSON.parse(row.discoverable_methods || '[]'),
      verifiedCredentials: JSON.parse(row.verified_credentials || '[]'),
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at)
    };
  }

  // ==========================================================================
  // Connection Operations
  // ==========================================================================

  saveConnection(connection: StoredConnection): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO social_connections
      (id, from_broker_id, to_broker_id, state, protocol, established_at, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      connection.id,
      connection.fromBrokerId,
      connection.toBrokerId,
      connection.state,
      connection.protocol || 'native_acg',
      connection.establishedAt?.toISOString() || null,
      JSON.stringify(connection.metadata || {}),
      connection.createdAt.toISOString(),
      connection.updatedAt.toISOString()
    );
  }

  getConnectionsForBroker(brokerId: string): StoredConnection[] {
    const stmt = this.db.prepare(`
      SELECT * FROM social_connections
      WHERE from_broker_id = ? OR to_broker_id = ?
    `);
    const rows = stmt.all(brokerId, brokerId) as any[];
    return rows.map(row => this.rowToConnection(row));
  }

  private rowToConnection(row: any): StoredConnection {
    return {
      id: row.id,
      fromBrokerId: row.from_broker_id,
      toBrokerId: row.to_broker_id,
      state: row.state,
      protocol: row.protocol,
      establishedAt: row.established_at ? new Date(row.established_at) : undefined,
      metadata: JSON.parse(row.metadata || '{}'),
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at)
    };
  }

  // ==========================================================================
  // Connection Request Operations
  // ==========================================================================

  saveConnectionRequest(request: StoredConnectionRequest): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO connection_requests
      (id, from_broker_id, to_broker_id, message, status, created_at, responded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      request.id,
      request.fromBrokerId,
      request.toBrokerId,
      request.message || null,
      request.status,
      request.createdAt.toISOString(),
      request.respondedAt?.toISOString() || null
    );
  }

  getPendingRequests(brokerId: string): StoredConnectionRequest[] {
    const stmt = this.db.prepare(`
      SELECT * FROM connection_requests
      WHERE to_broker_id = ? AND status = 'pending'
    `);
    const rows = stmt.all(brokerId) as any[];
    return rows.map(row => ({
      id: row.id,
      fromBrokerId: row.from_broker_id,
      toBrokerId: row.to_broker_id,
      message: row.message,
      status: row.status,
      createdAt: new Date(row.created_at),
      respondedAt: row.responded_at ? new Date(row.responded_at) : undefined
    }));
  }

  // ==========================================================================
  // Invite Link Operations
  // ==========================================================================

  saveInviteLink(invite: StoredInviteLink): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO invite_links
      (id, code, creator_broker_id, max_uses, use_count, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      invite.id,
      invite.code,
      invite.creatorBrokerId,
      invite.maxUses || null,
      invite.useCount || 0,
      invite.expiresAt?.toISOString() || null,
      invite.createdAt.toISOString()
    );
  }

  getInviteByCode(code: string): StoredInviteLink | null {
    const stmt = this.db.prepare('SELECT * FROM invite_links WHERE code = ?');
    const row = stmt.get(code) as any;
    if (!row) return null;
    return {
      id: row.id,
      code: row.code,
      creatorBrokerId: row.creator_broker_id,
      maxUses: row.max_uses,
      useCount: row.use_count,
      expiresAt: row.expires_at ? new Date(row.expires_at) : undefined,
      createdAt: new Date(row.created_at)
    };
  }

  incrementInviteUseCount(code: string): void {
    const stmt = this.db.prepare('UPDATE invite_links SET use_count = use_count + 1 WHERE code = ?');
    stmt.run(code);
  }

  // ==========================================================================
  // Notification Operations
  // ==========================================================================

  saveNotification(notification: StoredNotification): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO notifications
      (id, broker_id, type, title, body, data, read, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      notification.id,
      notification.brokerId,
      notification.type,
      notification.title,
      notification.body || null,
      JSON.stringify(notification.data || {}),
      notification.read ? 1 : 0,
      notification.createdAt.toISOString()
    );
  }

  getNotifications(brokerId: string, options: { unreadOnly?: boolean; limit?: number } = {}): StoredNotification[] {
    let sql = 'SELECT * FROM notifications WHERE broker_id = ?';
    if (options.unreadOnly) {
      sql += ' AND read = 0';
    }
    sql += ' ORDER BY created_at DESC';
    if (options.limit) {
      sql += ` LIMIT ${options.limit}`;
    }
    const stmt = this.db.prepare(sql);
    const rows = stmt.all(brokerId) as any[];
    return rows.map(row => ({
      id: row.id,
      brokerId: row.broker_id,
      type: row.type,
      title: row.title,
      body: row.body,
      data: JSON.parse(row.data || '{}'),
      read: row.read === 1,
      createdAt: new Date(row.created_at)
    }));
  }

  markNotificationRead(notificationId: string): void {
    const stmt = this.db.prepare('UPDATE notifications SET read = 1 WHERE id = ?');
    stmt.run(notificationId);
  }

  // ==========================================================================
  // Group Operations
  // ==========================================================================

  saveGroup(group: StoredGroup): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO social_groups
      (id, name, description, owner_broker_id, is_public, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      group.id,
      group.name,
      group.description || null,
      group.ownerBrokerId,
      group.isPublic ? 1 : 0,
      JSON.stringify(group.metadata || {}),
      group.createdAt.toISOString(),
      group.updatedAt.toISOString()
    );
  }

  getGroupsForBroker(brokerId: string): StoredGroup[] {
    const stmt = this.db.prepare(`
      SELECT g.* FROM social_groups g
      LEFT JOIN group_memberships m ON g.id = m.group_id
      WHERE g.owner_broker_id = ? OR m.broker_id = ?
    `);
    const rows = stmt.all(brokerId, brokerId) as any[];
    return rows.map(row => ({
      id: row.id,
      name: row.name,
      description: row.description,
      ownerBrokerId: row.owner_broker_id,
      isPublic: row.is_public === 1,
      metadata: JSON.parse(row.metadata || '{}'),
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at)
    }));
  }

  saveMembership(membership: StoredGroupMembership): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO group_memberships
      (id, group_id, broker_id, role, joined_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run(
      membership.id,
      membership.groupId,
      membership.brokerId,
      membership.role,
      membership.joinedAt.toISOString()
    );
  }

  // ==========================================================================
  // Shared Context Operations
  // ==========================================================================

  saveContext(context: StoredContext): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO shared_contexts
      (id, name, description, owner_broker_id, sync_strategy, conflict_resolution, is_public, version, vector_clock, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      context.id,
      context.name,
      context.description || null,
      context.ownerBrokerId,
      context.syncStrategy,
      context.conflictResolution,
      context.isPublic ? 1 : 0,
      context.version,
      JSON.stringify(context.vectorClock || {}),
      JSON.stringify({}),
      context.createdAt.toISOString(),
      context.updatedAt.toISOString()
    );
  }

  getContext(contextId: string): Partial<StoredContext> | null {
    const stmt = this.db.prepare('SELECT * FROM shared_contexts WHERE id = ?');
    const row = stmt.get(contextId) as any;
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      ownerBrokerId: row.owner_broker_id,
      syncStrategy: row.sync_strategy,
      conflictResolution: row.conflict_resolution,
      isPublic: row.is_public === 1,
      version: row.version,
      vectorClock: JSON.parse(row.vector_clock || '{}'),
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at)
    };
  }

  getContextsForBroker(brokerId: string): Partial<StoredContext>[] {
    const stmt = this.db.prepare(`
      SELECT c.* FROM shared_contexts c
      LEFT JOIN context_access a ON c.id = a.context_id
      WHERE c.owner_broker_id = ? OR a.broker_id = ?
    `);
    const rows = stmt.all(brokerId, brokerId) as any[];
    return rows.map(row => ({
      id: row.id,
      name: row.name,
      description: row.description,
      ownerBrokerId: row.owner_broker_id,
      syncStrategy: row.sync_strategy,
      conflictResolution: row.conflict_resolution,
      isPublic: row.is_public === 1,
      version: row.version,
      vectorClock: JSON.parse(row.vector_clock || '{}'),
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at)
    }));
  }

  deleteContext(contextId: string): void {
    const stmt = this.db.prepare('DELETE FROM shared_contexts WHERE id = ?');
    stmt.run(contextId);
  }

  // ==========================================================================
  // Context Access Operations
  // ==========================================================================

  saveAccess(contextId: string, entry: StoredAccessEntry): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO context_access
      (id, context_id, broker_id, level, granted_by, granted_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      uuidv4(),
      contextId,
      entry.brokerId,
      entry.level,
      entry.grantedBy,
      entry.grantedAt.toISOString(),
      entry.expiresAt?.toISOString() || null
    );
  }

  getAccessList(contextId: string): StoredAccessEntry[] {
    const stmt = this.db.prepare('SELECT * FROM context_access WHERE context_id = ?');
    const rows = stmt.all(contextId) as any[];
    return rows.map(row => ({
      brokerId: row.broker_id,
      level: row.level,
      grantedBy: row.granted_by,
      grantedAt: new Date(row.granted_at),
      expiresAt: row.expires_at ? new Date(row.expires_at) : undefined
    }));
  }

  revokeAccess(contextId: string, brokerId: string): void {
    const stmt = this.db.prepare('DELETE FROM context_access WHERE context_id = ? AND broker_id = ?');
    stmt.run(contextId, brokerId);
  }

  // ==========================================================================
  // Context Node Operations
  // ==========================================================================

  saveNode(contextId: string, node: StoredContextNode): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO context_nodes
      (id, context_id, type, data, created_by, version, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      node.id,
      contextId,
      node.type,
      JSON.stringify(node.data || {}),
      node.createdBy,
      node.version,
      node.createdAt.toISOString(),
      node.updatedAt.toISOString()
    );
  }

  getNodes(contextId: string, options: { type?: string } = {}): StoredContextNode[] {
    let sql = 'SELECT * FROM context_nodes WHERE context_id = ?';
    const params: any[] = [contextId];
    if (options.type) {
      sql += ' AND type = ?';
      params.push(options.type);
    }
    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params) as any[];
    return rows.map(row => ({
      id: row.id,
      type: row.type,
      data: JSON.parse(row.data || '{}'),
      createdBy: row.created_by,
      version: row.version,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at)
    }));
  }

  deleteNode(contextId: string, nodeId: string): void {
    const stmt = this.db.prepare('DELETE FROM context_nodes WHERE context_id = ? AND id = ?');
    stmt.run(contextId, nodeId);
  }

  // ==========================================================================
  // Context Edge Operations
  // ==========================================================================

  saveEdge(contextId: string, edge: StoredContextEdge): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO context_edges
      (id, context_id, source_id, target_id, type, data, created_by, version, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      edge.id,
      contextId,
      edge.sourceId,
      edge.targetId,
      edge.type,
      JSON.stringify(edge.data || {}),
      edge.createdBy,
      edge.version,
      edge.createdAt.toISOString(),
      edge.updatedAt.toISOString()
    );
  }

  getEdges(contextId: string, options: { type?: string; sourceId?: string; targetId?: string } = {}): StoredContextEdge[] {
    let sql = 'SELECT * FROM context_edges WHERE context_id = ?';
    const params: any[] = [contextId];
    if (options.type) {
      sql += ' AND type = ?';
      params.push(options.type);
    }
    if (options.sourceId) {
      sql += ' AND source_id = ?';
      params.push(options.sourceId);
    }
    if (options.targetId) {
      sql += ' AND target_id = ?';
      params.push(options.targetId);
    }
    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params) as any[];
    return rows.map(row => ({
      id: row.id,
      sourceId: row.source_id,
      targetId: row.target_id,
      type: row.type,
      data: JSON.parse(row.data || '{}'),
      createdBy: row.created_by,
      version: row.version,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at)
    }));
  }

  deleteEdge(contextId: string, edgeId: string): void {
    const stmt = this.db.prepare('DELETE FROM context_edges WHERE context_id = ? AND id = ?');
    stmt.run(contextId, edgeId);
  }

  // ==========================================================================
  // Replica Operations
  // ==========================================================================

  saveReplica(replica: StoredContextReplica): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO context_replicas
      (id, context_id, broker_id, local_version, vector_clock, status, last_sync_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      replica.id,
      replica.contextId,
      replica.brokerId,
      replica.localVersion,
      JSON.stringify(replica.vectorClock || {}),
      replica.status,
      replica.lastSyncAt.toISOString()
    );
  }

  getReplicas(contextId: string): StoredContextReplica[] {
    const stmt = this.db.prepare('SELECT * FROM context_replicas WHERE context_id = ?');
    const rows = stmt.all(contextId) as any[];
    return rows.map(row => ({
      id: row.id,
      contextId: row.context_id,
      brokerId: row.broker_id,
      localVersion: row.local_version,
      vectorClock: JSON.parse(row.vector_clock || '{}'),
      status: row.status,
      lastSyncAt: new Date(row.last_sync_at)
    }));
  }

  // ==========================================================================
  // Change Log Operations
  // ==========================================================================

  logChange(contextId: string, change: {
    changeType: string;
    targetType: string;
    targetId: string;
    brokerId: string;
    beforeState?: any;
    afterState?: any;
    vectorClock?: Record<string, number>;
  }): void {
    const stmt = this.db.prepare(`
      INSERT INTO change_log
      (id, context_id, change_type, target_type, target_id, broker_id, before_state, after_state, vector_clock, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      uuidv4(),
      contextId,
      change.changeType,
      change.targetType,
      change.targetId,
      change.brokerId,
      change.beforeState ? JSON.stringify(change.beforeState) : null,
      change.afterState ? JSON.stringify(change.afterState) : null,
      JSON.stringify(change.vectorClock || {}),
      new Date().toISOString()
    );
  }

  getChangeLog(contextId: string, options: { since?: Date; limit?: number } = {}): any[] {
    let sql = 'SELECT * FROM change_log WHERE context_id = ?';
    const params: any[] = [contextId];
    if (options.since) {
      sql += ' AND created_at > ?';
      params.push(options.since.toISOString());
    }
    sql += ' ORDER BY created_at ASC';
    if (options.limit) {
      sql += ` LIMIT ${options.limit}`;
    }
    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params) as any[];
    return rows.map(row => ({
      id: row.id,
      contextId: row.context_id,
      changeType: row.change_type,
      targetType: row.target_type,
      targetId: row.target_id,
      brokerId: row.broker_id,
      beforeState: row.before_state ? JSON.parse(row.before_state) : null,
      afterState: row.after_state ? JSON.parse(row.after_state) : null,
      vectorClock: JSON.parse(row.vector_clock || '{}'),
      createdAt: new Date(row.created_at)
    }));
  }

  // ==========================================================================
  // Utility
  // ==========================================================================

  close(): void {
    this.db.close();
  }

  getStats(): {
    profiles: number;
    connections: number;
    groups: number;
    contexts: number;
    nodes: number;
    edges: number;
  } {
    return {
      profiles: (this.db.prepare('SELECT COUNT(*) as count FROM social_profiles').get() as any).count,
      connections: (this.db.prepare('SELECT COUNT(*) as count FROM social_connections').get() as any).count,
      groups: (this.db.prepare('SELECT COUNT(*) as count FROM social_groups').get() as any).count,
      contexts: (this.db.prepare('SELECT COUNT(*) as count FROM shared_contexts').get() as any).count,
      nodes: (this.db.prepare('SELECT COUNT(*) as count FROM context_nodes').get() as any).count,
      edges: (this.db.prepare('SELECT COUNT(*) as count FROM context_edges').get() as any).count
    };
  }
}
