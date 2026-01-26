/**
 * Social Federation Service
 *
 * Implements the Social Federation Protocol ontology - how users connect,
 * discover, share, and collaborate through their personal brokers.
 * Enables social graph construction, multiplayer agent workflows,
 * and federated AI experiences.
 */

import { v4 as uuidv4 } from 'uuid';
import type { PersonalBroker } from './personal-broker.js';

// =============================================================================
// Types aligned with social-federation.ttl ontology
// =============================================================================

export type ConnectionState = 'requested' | 'accepted' | 'rejected' | 'blocked' | 'muted' | 'removed';
export type ProfileVisibility = 'public' | 'connections' | 'close' | 'private';
export type DiscoveryMethod = 'did' | 'webid' | 'qrcode' | 'invite_link' | 'directory' | 'contact_sync' | 'mutual';
export type PresenceStatus = 'online' | 'away' | 'busy' | 'dnd' | 'offline' | 'invisible';
export type CollaborationPermission = 'view' | 'suggest' | 'contribute' | 'edit' | 'admin';
export type GroupRole = 'owner' | 'admin' | 'moderator' | 'member' | 'guest';
export type FederationProtocol = 'activitypub' | 'didcomm' | 'atprotocol' | 'native_acg';
export type NotificationType =
  | 'connection_request'
  | 'connection_accepted'
  | 'message'
  | 'mention'
  | 'workflow_invite'
  | 'workflow_update'
  | 'group_invite'
  | 'system';

// =============================================================================
// Core Interfaces
// =============================================================================

export interface SocialConnection {
  id: string;
  fromBrokerId: string;
  toBrokerId: string;
  toBrokerEndpoint?: string;
  state: ConnectionState;
  discoveredVia?: DiscoveryMethod;
  grantedPermissions: CollaborationPermission[];
  localNickname?: string;
  connectionNote?: string;
  createdAt: string;
  updatedAt: string;
  mutualConnectionIds: string[];
  usesProtocol: FederationProtocol;
}

export interface ConnectionRequest {
  id: string;
  fromBrokerId: string;
  fromBrokerEndpoint: string;
  fromDisplayName?: string;
  toBrokerId: string;
  message?: string;
  requestedPermissions?: CollaborationPermission[];
  createdAt: string;
  expiresAt?: string;
}

export interface SocialProfile {
  brokerId: string;
  displayName: string;
  bio?: string;
  avatarUrl?: string;
  bannerUrl?: string;
  location?: string;
  website?: string;
  visibility: ProfileVisibility;
  joinedAt: string;
  connectionCount?: number;
  supportedProtocols: FederationProtocol[];
}

export interface InviteLink {
  id: string;
  code: string;
  url: string;
  createdBy: string;
  type: 'single_use' | 'multi_use' | 'time_limited' | 'group';
  createdAt: string;
  expiresAt?: string;
  maxUses?: number;
  useCount: number;
  usedBy: string[];
  targetGroupId?: string;
  defaultPermissions?: CollaborationPermission[];
}

export interface SocialNotification {
  id: string;
  type: NotificationType;
  forBrokerId: string;
  title: string;
  body: string;
  triggeredById?: string;
  triggeredByType?: string;
  createdAt: string;
  read: boolean;
  actionUrl?: string;
  metadata?: Record<string, unknown>;
}

export interface Presence {
  brokerId: string;
  status: PresenceStatus;
  statusMessage?: string;
  lastSeen: string;
  visibleTo: ProfileVisibility;
  currentActivity?: string;
}

export interface SocialGroup {
  id: string;
  name: string;
  description?: string;
  ownerBrokerId: string;
  isPublic: boolean;
  createdAt: string;
  memberCount: number;
  sharedContextId?: string;
}

export interface GroupMembership {
  groupId: string;
  brokerId: string;
  role: GroupRole;
  joinedAt: string;
  invitedBy?: string;
}

export interface WorkflowInvitation {
  id: string;
  workflowId: string;
  fromBrokerId: string;
  toBrokerId: string;
  role: 'contributor' | 'observer' | 'agent';
  message?: string;
  createdAt: string;
  expiresAt?: string;
  status: 'pending' | 'accepted' | 'rejected' | 'expired';
}

// =============================================================================
// Federation Message Types (for broker-to-broker communication)
// =============================================================================

export interface FederationMessage {
  id: string;
  type: FederationMessageType;
  from: string; // Broker DID or ID
  to: string;
  timestamp: string;
  payload: unknown;
  signature?: string;
}

export type FederationMessageType =
  | 'connection_request'
  | 'connection_response'
  | 'message'
  | 'presence_update'
  | 'workflow_invite'
  | 'workflow_update'
  | 'context_sync'
  | 'group_activity';

// =============================================================================
// Social Federation Service
// =============================================================================

export class SocialFederationService {
  private connections: Map<string, SocialConnection> = new Map();
  private pendingRequests: Map<string, ConnectionRequest> = new Map();
  private profiles: Map<string, SocialProfile> = new Map();
  private inviteLinks: Map<string, InviteLink> = new Map();
  private invitesByCode: Map<string, string> = new Map(); // code -> inviteId
  private notifications: Map<string, SocialNotification[]> = new Map(); // brokerId -> notifications
  private presences: Map<string, Presence> = new Map();
  private groups: Map<string, SocialGroup> = new Map();
  private memberships: Map<string, GroupMembership[]> = new Map(); // groupId -> memberships
  private workflowInvites: Map<string, WorkflowInvitation> = new Map();

  // Event handlers for federation events
  private eventHandlers: Map<string, Function[]> = new Map();

  // Reference to broker registry for looking up brokers
  private brokerLookup?: (brokerId: string) => PersonalBroker | undefined;

  constructor() {}

  setBrokerLookup(lookup: (brokerId: string) => PersonalBroker | undefined): void {
    this.brokerLookup = lookup;
  }

  // ===========================================
  // Profile Management
  // ===========================================

  createProfile(broker: PersonalBroker): SocialProfile {
    const profile: SocialProfile = {
      brokerId: broker.id,
      displayName: broker.config.displayName,
      bio: broker.config.bio,
      avatarUrl: broker.config.avatarUrl,
      visibility: 'connections',
      joinedAt: broker.createdAt,
      connectionCount: 0,
      supportedProtocols: ['native_acg', 'activitypub']
    };

    this.profiles.set(broker.id, profile);
    return profile;
  }

  getProfile(brokerId: string): SocialProfile | undefined {
    return this.profiles.get(brokerId);
  }

  updateProfile(brokerId: string, updates: Partial<SocialProfile>): SocialProfile | undefined {
    const profile = this.profiles.get(brokerId);
    if (!profile) return undefined;

    Object.assign(profile, updates);
    this.emit('profile:updated', profile);
    return profile;
  }

  // ===========================================
  // Connection Management
  // ===========================================

  async requestConnection(
    fromBroker: PersonalBroker,
    toBrokerId: string,
    options: {
      toBrokerEndpoint?: string;
      message?: string;
      requestedPermissions?: CollaborationPermission[];
    } = {}
  ): Promise<ConnectionRequest> {
    const request: ConnectionRequest = {
      id: `req:${uuidv4()}`,
      fromBrokerId: fromBroker.id,
      fromBrokerEndpoint: `http://localhost:3000/broker/${fromBroker.id}`, // Would be real endpoint
      fromDisplayName: fromBroker.config.displayName,
      toBrokerId,
      message: options.message,
      requestedPermissions: options.requestedPermissions ?? ['view'],
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString() // 7 days
    };

    this.pendingRequests.set(request.id, request);

    // Create notification for recipient
    this.addNotification(toBrokerId, {
      type: 'connection_request',
      title: 'New Connection Request',
      body: `${fromBroker.config.displayName} wants to connect`,
      triggeredById: request.id,
      triggeredByType: 'ConnectionRequest',
      actionUrl: `/federation/requests/${request.id}`
    });

    // In real implementation, send via federation protocol
    this.emit('federation:connection_requested', request);

    return request;
  }

  getPendingRequests(brokerId: string): ConnectionRequest[] {
    return Array.from(this.pendingRequests.values())
      .filter(r => r.toBrokerId === brokerId);
  }

  async acceptConnection(
    request: ConnectionRequest,
    acceptingBroker: PersonalBroker,
    grantedPermissions?: CollaborationPermission[]
  ): Promise<SocialConnection> {
    // Create connection for accepting broker
    const connection: SocialConnection = {
      id: `conn:${uuidv4()}`,
      fromBrokerId: acceptingBroker.id,
      toBrokerId: request.fromBrokerId,
      toBrokerEndpoint: request.fromBrokerEndpoint,
      state: 'accepted',
      discoveredVia: 'did',
      grantedPermissions: grantedPermissions ?? request.requestedPermissions ?? ['view'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      mutualConnectionIds: [],
      usesProtocol: 'native_acg'
    };

    this.connections.set(connection.id, connection);

    // Create reciprocal connection for requester
    const reciprocalConnection: SocialConnection = {
      id: `conn:${uuidv4()}`,
      fromBrokerId: request.fromBrokerId,
      toBrokerId: acceptingBroker.id,
      toBrokerEndpoint: `http://localhost:3000/broker/${acceptingBroker.id}`,
      state: 'accepted',
      discoveredVia: 'did',
      grantedPermissions: ['view'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      mutualConnectionIds: [],
      usesProtocol: 'native_acg'
    };

    this.connections.set(reciprocalConnection.id, reciprocalConnection);

    // Link mutual connections
    connection.mutualConnectionIds.push(reciprocalConnection.id);
    reciprocalConnection.mutualConnectionIds.push(connection.id);

    // Remove pending request
    this.pendingRequests.delete(request.id);

    // Notify requester
    this.addNotification(request.fromBrokerId, {
      type: 'connection_accepted',
      title: 'Connection Accepted',
      body: `${acceptingBroker.config.displayName} accepted your connection request`,
      triggeredById: connection.id,
      triggeredByType: 'SocialConnection'
    });

    // Update connection counts
    this.updateConnectionCount(acceptingBroker.id);
    this.updateConnectionCount(request.fromBrokerId);

    this.emit('federation:connection_accepted', { connection, reciprocalConnection });

    return connection;
  }

  async rejectConnection(requestId: string): Promise<void> {
    const request = this.pendingRequests.get(requestId);
    if (request) {
      this.pendingRequests.delete(requestId);
      this.emit('federation:connection_rejected', request);
    }
  }

  getConnection(connectionId: string): SocialConnection | undefined {
    return this.connections.get(connectionId);
  }

  getConnectionsForBroker(brokerId: string): SocialConnection[] {
    return Array.from(this.connections.values())
      .filter(c => c.fromBrokerId === brokerId && c.state === 'accepted');
  }

  async blockConnection(connectionId: string): Promise<void> {
    const connection = this.connections.get(connectionId);
    if (connection) {
      connection.state = 'blocked';
      connection.updatedAt = new Date().toISOString();
      this.emit('federation:connection_blocked', connection);
    }
  }

  async removeConnection(connectionId: string): Promise<void> {
    const connection = this.connections.get(connectionId);
    if (connection) {
      connection.state = 'removed';
      connection.updatedAt = new Date().toISOString();

      // Also update reciprocal connection
      for (const recipId of connection.mutualConnectionIds) {
        const reciprocal = this.connections.get(recipId);
        if (reciprocal) {
          reciprocal.state = 'removed';
          reciprocal.updatedAt = new Date().toISOString();
        }
      }

      this.emit('federation:connection_removed', connection);
    }
  }

  private updateConnectionCount(brokerId: string): void {
    const profile = this.profiles.get(brokerId);
    if (profile) {
      profile.connectionCount = this.getConnectionsForBroker(brokerId).length;
    }
  }

  // ===========================================
  // Invite Links
  // ===========================================

  createInviteLink(
    brokerId: string,
    options: {
      type?: 'single_use' | 'multi_use' | 'time_limited' | 'group';
      maxUses?: number;
      expiresInHours?: number;
      targetGroupId?: string;
      defaultPermissions?: CollaborationPermission[];
    } = {}
  ): InviteLink {
    const code = this.generateInviteCode();
    const id = `invite:${uuidv4()}`;

    const invite: InviteLink = {
      id,
      code,
      url: `acg://connect/${code}`, // Would be real URL
      createdBy: brokerId,
      type: options.type ?? 'single_use',
      createdAt: new Date().toISOString(),
      expiresAt: options.expiresInHours
        ? new Date(Date.now() + options.expiresInHours * 60 * 60 * 1000).toISOString()
        : undefined,
      maxUses: options.maxUses,
      useCount: 0,
      usedBy: [],
      targetGroupId: options.targetGroupId,
      defaultPermissions: options.defaultPermissions ?? ['view']
    };

    this.inviteLinks.set(id, invite);
    this.invitesByCode.set(code, id);

    this.emit('invite:created', invite);
    return invite;
  }

  async useInviteLink(
    code: string,
    usingBroker: PersonalBroker
  ): Promise<{ success: boolean; connection?: SocialConnection; error?: string }> {
    const inviteId = this.invitesByCode.get(code);
    if (!inviteId) {
      return { success: false, error: 'Invalid invite code' };
    }

    const invite = this.inviteLinks.get(inviteId);
    if (!invite) {
      return { success: false, error: 'Invite not found' };
    }

    // Check expiration
    if (invite.expiresAt && new Date(invite.expiresAt) < new Date()) {
      return { success: false, error: 'Invite has expired' };
    }

    // Check max uses
    if (invite.maxUses && invite.useCount >= invite.maxUses) {
      return { success: false, error: 'Invite has reached maximum uses' };
    }

    // Check if already used by this broker
    if (invite.usedBy.includes(usingBroker.id)) {
      return { success: false, error: 'You have already used this invite' };
    }

    // Create connection
    const connection: SocialConnection = {
      id: `conn:${uuidv4()}`,
      fromBrokerId: usingBroker.id,
      toBrokerId: invite.createdBy,
      state: 'accepted', // Invites auto-accept
      discoveredVia: 'invite_link',
      grantedPermissions: invite.defaultPermissions ?? ['view'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      mutualConnectionIds: [],
      usesProtocol: 'native_acg'
    };

    this.connections.set(connection.id, connection);

    // Create reciprocal
    const reciprocal: SocialConnection = {
      id: `conn:${uuidv4()}`,
      fromBrokerId: invite.createdBy,
      toBrokerId: usingBroker.id,
      state: 'accepted',
      discoveredVia: 'invite_link',
      grantedPermissions: ['view'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      mutualConnectionIds: [connection.id],
      usesProtocol: 'native_acg'
    };

    this.connections.set(reciprocal.id, reciprocal);
    connection.mutualConnectionIds.push(reciprocal.id);

    // Update invite usage
    invite.useCount++;
    invite.usedBy.push(usingBroker.id);

    // If single use, invalidate
    if (invite.type === 'single_use') {
      this.invitesByCode.delete(code);
    }

    // Handle group invite
    if (invite.targetGroupId) {
      await this.addToGroup(invite.targetGroupId, usingBroker.id, 'member', invite.createdBy);
    }

    this.emit('invite:used', { invite, connection });
    return { success: true, connection };
  }

  private generateInviteCode(): string {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // No O, 0, 1, I for clarity
    let code = '';
    for (let i = 0; i < 8; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
  }

  // ===========================================
  // Notifications
  // ===========================================

  addNotification(
    brokerId: string,
    notification: Omit<SocialNotification, 'id' | 'forBrokerId' | 'createdAt' | 'read'>
  ): SocialNotification {
    const fullNotification: SocialNotification = {
      id: `notif:${uuidv4()}`,
      forBrokerId: brokerId,
      createdAt: new Date().toISOString(),
      read: false,
      ...notification
    };

    const brokerNotifs = this.notifications.get(brokerId) ?? [];
    brokerNotifs.unshift(fullNotification);
    this.notifications.set(brokerId, brokerNotifs);

    this.emit('notification:created', fullNotification);
    return fullNotification;
  }

  getNotifications(brokerId: string, options?: { unreadOnly?: boolean; limit?: number }): SocialNotification[] {
    let notifs = this.notifications.get(brokerId) ?? [];

    if (options?.unreadOnly) {
      notifs = notifs.filter(n => !n.read);
    }

    if (options?.limit) {
      notifs = notifs.slice(0, options.limit);
    }

    return notifs;
  }

  markNotificationRead(notificationId: string): void {
    for (const notifs of this.notifications.values()) {
      const notif = notifs.find(n => n.id === notificationId);
      if (notif) {
        notif.read = true;
        break;
      }
    }
  }

  markAllNotificationsRead(brokerId: string): void {
    const notifs = this.notifications.get(brokerId);
    if (notifs) {
      notifs.forEach(n => n.read = true);
    }
  }

  // ===========================================
  // Presence Management
  // ===========================================

  updatePresence(brokerId: string, updates: Partial<Presence>): Presence {
    const existing = this.presences.get(brokerId);
    const presence: Presence = {
      brokerId,
      status: updates.status ?? existing?.status ?? 'online',
      statusMessage: updates.statusMessage ?? existing?.statusMessage,
      lastSeen: new Date().toISOString(),
      visibleTo: updates.visibleTo ?? existing?.visibleTo ?? 'connections',
      currentActivity: updates.currentActivity ?? existing?.currentActivity
    };

    this.presences.set(brokerId, presence);
    this.emit('presence:updated', presence);

    // Broadcast to connections
    this.broadcastPresenceToConnections(brokerId, presence);

    return presence;
  }

  getPresence(brokerId: string): Presence | undefined {
    return this.presences.get(brokerId);
  }

  getConnectionPresences(brokerId: string): Presence[] {
    const connections = this.getConnectionsForBroker(brokerId);
    const presences: Presence[] = [];

    for (const conn of connections) {
      const presence = this.presences.get(conn.toBrokerId);
      if (presence && this.canSeePresence(brokerId, presence)) {
        presences.push(presence);
      }
    }

    return presences;
  }

  private canSeePresence(viewerId: string, presence: Presence): boolean {
    if (presence.status === 'invisible') return false;
    if (presence.visibleTo === 'public') return true;
    if (presence.visibleTo === 'private') return false;

    // Check if viewer is a connection
    const connection = this.getConnectionsForBroker(presence.brokerId)
      .find(c => c.toBrokerId === viewerId);

    if (!connection) return false;

    if (presence.visibleTo === 'connections') return true;
    if (presence.visibleTo === 'close') {
      return connection.grantedPermissions.includes('edit') ||
             connection.grantedPermissions.includes('admin');
    }

    return false;
  }

  private broadcastPresenceToConnections(brokerId: string, presence: Presence): void {
    const connections = this.getConnectionsForBroker(brokerId);
    for (const conn of connections) {
      if (this.canSeePresence(conn.toBrokerId, presence)) {
        this.emit('presence:broadcast', { to: conn.toBrokerId, presence });
      }
    }
  }

  // ===========================================
  // Group Management
  // ===========================================

  createGroup(
    ownerBrokerId: string,
    options: {
      name: string;
      description?: string;
      isPublic?: boolean;
    }
  ): SocialGroup {
    const group: SocialGroup = {
      id: `group:${uuidv4()}`,
      name: options.name,
      description: options.description,
      ownerBrokerId,
      isPublic: options.isPublic ?? false,
      createdAt: new Date().toISOString(),
      memberCount: 1
    };

    this.groups.set(group.id, group);

    // Add owner as member
    const membership: GroupMembership = {
      groupId: group.id,
      brokerId: ownerBrokerId,
      role: 'owner',
      joinedAt: group.createdAt
    };

    this.memberships.set(group.id, [membership]);

    this.emit('group:created', group);
    return group;
  }

  getGroup(groupId: string): SocialGroup | undefined {
    return this.groups.get(groupId);
  }

  getGroupsForBroker(brokerId: string): SocialGroup[] {
    const groups: SocialGroup[] = [];
    for (const [groupId, memberships] of this.memberships.entries()) {
      if (memberships.some(m => m.brokerId === brokerId)) {
        const group = this.groups.get(groupId);
        if (group) groups.push(group);
      }
    }
    return groups;
  }

  async addToGroup(
    groupId: string,
    brokerId: string,
    role: GroupRole = 'member',
    invitedBy?: string
  ): Promise<GroupMembership | undefined> {
    const group = this.groups.get(groupId);
    if (!group) return undefined;

    const memberships = this.memberships.get(groupId) ?? [];

    // Check if already a member
    if (memberships.some(m => m.brokerId === brokerId)) {
      return memberships.find(m => m.brokerId === brokerId);
    }

    const membership: GroupMembership = {
      groupId,
      brokerId,
      role,
      joinedAt: new Date().toISOString(),
      invitedBy
    };

    memberships.push(membership);
    this.memberships.set(groupId, memberships);
    group.memberCount = memberships.length;

    this.emit('group:member_added', { group, membership });
    return membership;
  }

  async removeFromGroup(groupId: string, brokerId: string): Promise<boolean> {
    const memberships = this.memberships.get(groupId);
    if (!memberships) return false;

    const index = memberships.findIndex(m => m.brokerId === brokerId);
    if (index === -1) return false;

    const [removed] = memberships.splice(index, 1);

    const group = this.groups.get(groupId);
    if (group) {
      group.memberCount = memberships.length;
    }

    this.emit('group:member_removed', { group, membership: removed });
    return true;
  }

  getGroupMembers(groupId: string): GroupMembership[] {
    return this.memberships.get(groupId) ?? [];
  }

  // ===========================================
  // Workflow Invitations
  // ===========================================

  createWorkflowInvitation(
    workflowId: string,
    fromBrokerId: string,
    toBrokerId: string,
    options: {
      role?: 'contributor' | 'observer' | 'agent';
      message?: string;
      expiresInHours?: number;
    } = {}
  ): WorkflowInvitation {
    const invite: WorkflowInvitation = {
      id: `wfinvite:${uuidv4()}`,
      workflowId,
      fromBrokerId,
      toBrokerId,
      role: options.role ?? 'contributor',
      message: options.message,
      createdAt: new Date().toISOString(),
      expiresAt: options.expiresInHours
        ? new Date(Date.now() + options.expiresInHours * 60 * 60 * 1000).toISOString()
        : undefined,
      status: 'pending'
    };

    this.workflowInvites.set(invite.id, invite);

    // Notify recipient
    this.addNotification(toBrokerId, {
      type: 'workflow_invite',
      title: 'Workflow Invitation',
      body: options.message ?? 'You have been invited to collaborate on a workflow',
      triggeredById: invite.id,
      triggeredByType: 'WorkflowInvitation',
      actionUrl: `/workflows/${workflowId}/invite/${invite.id}`
    });

    this.emit('workflow:invitation_sent', invite);
    return invite;
  }

  async acceptWorkflowInvitation(inviteId: string): Promise<WorkflowInvitation | undefined> {
    const invite = this.workflowInvites.get(inviteId);
    if (!invite || invite.status !== 'pending') return undefined;

    // Check expiration
    if (invite.expiresAt && new Date(invite.expiresAt) < new Date()) {
      invite.status = 'expired';
      return undefined;
    }

    invite.status = 'accepted';
    this.emit('workflow:invitation_accepted', invite);

    return invite;
  }

  async rejectWorkflowInvitation(inviteId: string): Promise<void> {
    const invite = this.workflowInvites.get(inviteId);
    if (invite && invite.status === 'pending') {
      invite.status = 'rejected';
      this.emit('workflow:invitation_rejected', invite);
    }
  }

  getPendingWorkflowInvitations(brokerId: string): WorkflowInvitation[] {
    return Array.from(this.workflowInvites.values())
      .filter(i => i.toBrokerId === brokerId && i.status === 'pending');
  }

  // ===========================================
  // Discovery
  // ===========================================

  async discoverByDID(did: string): Promise<SocialProfile | undefined> {
    // In real implementation, resolve DID and fetch profile
    // For now, look up in local profiles
    for (const profile of this.profiles.values()) {
      if (profile.brokerId.includes(did)) {
        return profile;
      }
    }
    return undefined;
  }

  async discoverByWebID(webId: string): Promise<SocialProfile | undefined> {
    // In real implementation, dereference WebID and fetch profile
    return undefined;
  }

  searchProfiles(query: string, limit: number = 10): SocialProfile[] {
    const lowerQuery = query.toLowerCase();
    return Array.from(this.profiles.values())
      .filter(p =>
        p.visibility === 'public' &&
        (p.displayName.toLowerCase().includes(lowerQuery) ||
         p.bio?.toLowerCase().includes(lowerQuery))
      )
      .slice(0, limit);
  }

  // ===========================================
  // Federation Protocol Handling
  // ===========================================

  async handleIncomingFederationMessage(message: FederationMessage): Promise<void> {
    switch (message.type) {
      case 'connection_request':
        this.emit('federation:incoming_request', message);
        break;
      case 'connection_response':
        this.emit('federation:incoming_response', message);
        break;
      case 'message':
        this.emit('federation:incoming_message', message);
        break;
      case 'presence_update':
        const presence = message.payload as Partial<Presence>;
        if (presence.brokerId) {
          this.presences.set(presence.brokerId, presence as Presence);
        }
        break;
      case 'workflow_invite':
        this.emit('federation:incoming_workflow_invite', message);
        break;
      case 'context_sync':
        this.emit('federation:incoming_context_sync', message);
        break;
      default:
        console.warn('Unknown federation message type:', message.type);
    }
  }

  createFederationMessage(
    type: FederationMessageType,
    from: string,
    to: string,
    payload: unknown
  ): FederationMessage {
    return {
      id: `fed:${uuidv4()}`,
      type,
      from,
      to,
      timestamp: new Date().toISOString(),
      payload
    };
  }

  // ===========================================
  // Event System
  // ===========================================

  on(event: string, handler: Function): void {
    const handlers = this.eventHandlers.get(event) ?? [];
    handlers.push(handler);
    this.eventHandlers.set(event, handlers);
  }

  off(event: string, handler: Function): void {
    const handlers = this.eventHandlers.get(event) ?? [];
    const index = handlers.indexOf(handler);
    if (index >= 0) {
      handlers.splice(index, 1);
    }
  }

  private emit(event: string, data: unknown): void {
    const handlers = this.eventHandlers.get(event) ?? [];
    for (const handler of handlers) {
      try {
        handler(data);
      } catch (error) {
        console.error(`Error in federation event handler for ${event}:`, error);
      }
    }
  }
}
