/**
 * Integration Tests for Federation System
 *
 * Tests the complete flow of:
 * - Personal Broker operations
 * - Social Federation (connections, invites, groups)
 * - Shared Contexts (CRDT sync, access control)
 * - Real-time sync (WebSocket events)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PersonalBroker, PersonalBrokerRegistry } from '../../src/services/personal-broker.js';
import { SocialFederationService } from '../../src/services/social-federation.js';
import { SharedContextService } from '../../src/services/shared-context.js';
import { RealtimeSyncService } from '../../src/services/realtime-sync.js';

describe('Federation Integration Tests', () => {
  let brokerRegistry: PersonalBrokerRegistry;
  let socialService: SocialFederationService;
  let contextService: SharedContextService;
  let realtimeService: RealtimeSyncService;

  let alice: PersonalBroker;
  let bob: PersonalBroker;

  beforeEach(() => {
    // Initialize services
    brokerRegistry = new PersonalBrokerRegistry();
    socialService = new SocialFederationService();
    contextService = new SharedContextService();
    realtimeService = new RealtimeSyncService();

    // Wire up services
    realtimeService.setServices(contextService, socialService);

    // Create test brokers
    alice = brokerRegistry.createBroker({
      displayName: 'Alice',
      ownerDID: 'did:web:alice.example',
      timezone: 'America/New_York',
      locale: 'en-US'
    });

    bob = brokerRegistry.createBroker({
      displayName: 'Bob',
      ownerDID: 'did:web:bob.example',
      timezone: 'America/Los_Angeles',
      locale: 'en-US'
    });

    // Create social profiles
    socialService.createProfile(alice);
    socialService.createProfile(bob);
  });

  afterEach(() => {
    realtimeService.shutdown();
  });

  // =========================================================================
  // Personal Broker Tests
  // =========================================================================

  describe('Personal Broker', () => {
    it('should create a conversation and send messages', async () => {
      const conversation = alice.startConversation({ title: 'Test Chat' });
      expect(conversation).toBeDefined();
      expect(conversation.title).toBe('Test Chat');

      const message = await alice.sendMessage(conversation.id, 'Hello, world!', { role: 'user' });
      expect(message.content).toBe('Hello, world!');
      expect(message.role).toBe('user');

      const messages = alice.getMessages(conversation.id);
      expect(messages.length).toBe(1);
    });

    it('should store and recall memories', () => {
      const memory = alice.storeMemory({
        type: 'semantic',
        content: 'Alice likes coffee',
        importance: 0.8,
        tags: ['preference', 'beverage']
      });

      expect(memory.content).toBe('Alice likes coffee');

      const recalled = alice.recallMemory({ type: 'semantic' });
      expect(recalled.length).toBe(1);
      expect(recalled[0].content).toBe('Alice likes coffee');

      // Search by tags
      const byTag = alice.recallMemory({ tags: ['preference'] });
      expect(byTag.length).toBe(1);
    });

    it('should manage presence status', () => {
      const presence = alice.updatePresence({ status: 'busy', statusMessage: 'In a meeting' });
      expect(presence.status).toBe('busy');
      expect(presence.statusMessage).toBe('In a meeting');

      const retrieved = alice.getPresence();
      expect(retrieved.status).toBe('busy');
    });
  });

  // =========================================================================
  // Social Federation Tests
  // =========================================================================

  describe('Social Federation', () => {
    it('should handle connection request flow', async () => {
      // Alice requests connection to Bob
      const request = await socialService.requestConnection(alice, bob.id, {
        message: 'Hi Bob, let\'s connect!'
      });

      expect(request.fromBrokerId).toBe(alice.id);
      expect(request.toBrokerId).toBe(bob.id);

      // Bob should have pending request
      const pendingRequests = socialService.getPendingRequests(bob.id);
      expect(pendingRequests.length).toBe(1);
      expect(pendingRequests[0].id).toBe(request.id);

      // Bob should have notification
      const notifications = socialService.getNotifications(bob.id);
      expect(notifications.length).toBeGreaterThan(0);
      expect(notifications[0].type).toBe('connection_request');

      // Bob accepts
      const connection = await socialService.acceptConnection(request, bob);
      expect(connection.state).toBe('accepted');

      // Both should now be connected
      const aliceConnections = socialService.getConnectionsForBroker(alice.id);
      const bobConnections = socialService.getConnectionsForBroker(bob.id);

      expect(aliceConnections.length).toBe(1);
      expect(bobConnections.length).toBe(1);
    });

    it('should create and use invite links', async () => {
      // Alice creates invite link
      const invite = socialService.createInviteLink(alice.id, {
        type: 'multi_use',
        maxUses: 5
      });

      expect(invite.code).toBeDefined();
      expect(invite.maxUses).toBe(5);
      expect(invite.useCount).toBe(0);

      // Bob uses the invite
      const result = await socialService.useInviteLink(invite.code, bob);
      expect(result.success).toBe(true);
      expect(result.connection).toBeDefined();
      expect(result.connection?.state).toBe('accepted');

      // Connections should exist
      const aliceConnections = socialService.getConnectionsForBroker(alice.id);
      expect(aliceConnections.length).toBe(1);
    });

    it('should create and manage groups', async () => {
      // Alice creates a group
      const group = socialService.createGroup(alice.id, {
        name: 'Test Group',
        description: 'A test group',
        isPublic: false
      });

      expect(group.name).toBe('Test Group');
      expect(group.ownerBrokerId).toBe(alice.id);
      expect(group.memberCount).toBe(1); // Owner is first member

      // Add Bob to the group
      const membership = await socialService.addToGroup(group.id, bob.id, 'member', alice.id);
      expect(membership).toBeDefined();
      expect(membership?.role).toBe('member');

      // Verify membership
      const members = socialService.getGroupMembers(group.id);
      expect(members.length).toBe(2);

      // Both should see the group
      const aliceGroups = socialService.getGroupsForBroker(alice.id);
      const bobGroups = socialService.getGroupsForBroker(bob.id);
      expect(aliceGroups.length).toBe(1);
      expect(bobGroups.length).toBe(1);
    });

    it('should update and broadcast presence', () => {
      const presence = socialService.updatePresence(alice.id, {
        status: 'online',
        statusMessage: 'Available for chat'
      });

      expect(presence.status).toBe('online');
      expect(presence.statusMessage).toBe('Available for chat');

      const retrieved = socialService.getPresence(alice.id);
      expect(retrieved?.status).toBe('online');
    });

    it('should search for profiles', () => {
      // Update Alice's profile to be public
      socialService.updateProfile(alice.id, { visibility: 'public' });

      // Search should find Alice
      const results = socialService.searchProfiles('Alice');
      expect(results.length).toBe(1);
      expect(results[0].displayName).toBe('Alice');

      // Search for non-existent should return empty
      const noResults = socialService.searchProfiles('Charlie');
      expect(noResults.length).toBe(0);
    });
  });

  // =========================================================================
  // Shared Context Tests
  // =========================================================================

  describe('Shared Context', () => {
    it('should create and join shared contexts', () => {
      // Alice creates a shared context
      const context = contextService.createContext(alice.id, {
        name: 'Project Alpha',
        description: 'A collaborative project',
        syncStrategy: 'crdt',
        conflictResolution: 'auto_merge'
      });

      expect(context.name).toBe('Project Alpha');
      expect(context.ownerBrokerId).toBe(alice.id);

      // Grant Bob access
      const granted = contextService.grantAccess(context.id, alice.id, bob.id, 'write');
      expect(granted).toBe(true);

      // Bob joins
      const replica = contextService.joinContext(context.id, bob.id);
      expect(replica).toBeDefined();
      expect(replica?.brokerId).toBe(bob.id);

      // Both should see the context
      const aliceContexts = contextService.getContextsForBroker(alice.id);
      const bobContexts = contextService.getContextsForBroker(bob.id);
      expect(aliceContexts.length).toBe(1);
      expect(bobContexts.length).toBe(1);
    });

    it('should add and update nodes in shared context', () => {
      const context = contextService.createContext(alice.id, { name: 'Node Test' });

      // Add a node
      const node = contextService.addNode(context.id, alice.id, 'task', {
        title: 'Complete feature',
        status: 'pending'
      });

      expect(node).toBeDefined();
      expect(node?.type).toBe('task');
      expect((node?.data as any).title).toBe('Complete feature');

      // Update the node
      const updated = contextService.updateNode(context.id, alice.id, node!.id, {
        status: 'in_progress'
      });

      expect(updated).toBeDefined();
      expect((updated?.data as any).status).toBe('in_progress');

      // Verify node exists
      const nodes = contextService.getNodes(context.id);
      expect(nodes.length).toBe(1);
    });

    it('should add edges between nodes', () => {
      const context = contextService.createContext(alice.id, { name: 'Edge Test' });

      // Add two nodes
      const node1 = contextService.addNode(context.id, alice.id, 'idea', { text: 'Main idea' });
      const node2 = contextService.addNode(context.id, alice.id, 'idea', { text: 'Supporting idea' });

      expect(node1).toBeDefined();
      expect(node2).toBeDefined();

      // Add an edge
      const edge = contextService.addEdge(
        context.id,
        alice.id,
        node1!.id,
        node2!.id,
        'supports'
      );

      expect(edge).toBeDefined();
      expect(edge?.type).toBe('supports');

      // Verify edge
      const edges = contextService.getEdges(context.id);
      expect(edges.length).toBe(1);
    });

    it('should enforce access control', () => {
      const context = contextService.createContext(alice.id, { name: 'Access Test' });

      // Bob shouldn't be able to add nodes (no access)
      const node = contextService.addNode(context.id, bob.id, 'test', {});
      expect(node).toBeNull();

      // Grant Bob read access
      contextService.grantAccess(context.id, alice.id, bob.id, 'read');
      contextService.joinContext(context.id, bob.id);

      // Bob still shouldn't be able to add nodes (only read)
      const node2 = contextService.addNode(context.id, bob.id, 'test', {});
      expect(node2).toBeNull();

      // Upgrade to write
      contextService.grantAccess(context.id, alice.id, bob.id, 'write');

      // Now Bob can add
      const node3 = contextService.addNode(context.id, bob.id, 'test', { value: 123 });
      expect(node3).toBeDefined();
    });

    it('should track presence in shared contexts', () => {
      const context = contextService.createContext(alice.id, { name: 'Presence Test' });
      contextService.grantAccess(context.id, alice.id, bob.id, 'write');
      contextService.joinContext(context.id, bob.id);

      // Update Alice's presence
      contextService.updatePresence(context.id, alice.id, {
        state: 'active',
        cursor: { nodeId: 'node:123', field: 'title' }
      });

      // Update Bob's presence
      contextService.updatePresence(context.id, bob.id, {
        state: 'active'
      });

      // Get participants
      const participants = contextService.getActiveParticipants(context.id);
      expect(participants.length).toBe(2);
    });

    it('should export context as JSON', () => {
      const context = contextService.createContext(alice.id, { name: 'Export Test' });
      contextService.addNode(context.id, alice.id, 'test', { value: 1 });

      const exported = contextService.exportContextAsJSON(context.id);
      expect(exported).toBeDefined();
      expect((exported as any).name).toBe('Export Test');
      expect((exported as any).graph.nodes.length).toBe(1);
    });
  });

  // =========================================================================
  // Multi-User Collaboration Tests
  // =========================================================================

  describe('Multi-User Collaboration', () => {
    it('should support complete collaboration workflow', async () => {
      // 1. Alice and Bob connect
      const request = await socialService.requestConnection(alice, bob.id);
      await socialService.acceptConnection(request, bob);

      // 2. Alice creates a shared context
      const context = contextService.createContext(alice.id, {
        name: 'Collaborative Brainstorm',
        syncStrategy: 'crdt'
      });

      // 3. Alice grants Bob access and invites him
      contextService.grantAccess(context.id, alice.id, bob.id, 'write');

      // 4. Bob joins
      contextService.joinContext(context.id, bob.id);

      // 5. Both add nodes
      const aliceNode = contextService.addNode(context.id, alice.id, 'idea', {
        text: 'Use AI for summarization'
      });

      const bobNode = contextService.addNode(context.id, bob.id, 'idea', {
        text: 'Add real-time collaboration'
      });

      expect(aliceNode).toBeDefined();
      expect(bobNode).toBeDefined();

      // 6. Connect their ideas
      const edge = contextService.addEdge(
        context.id,
        alice.id,
        aliceNode!.id,
        bobNode!.id,
        'relates_to'
      );

      expect(edge).toBeDefined();

      // 7. Verify the graph
      const nodes = contextService.getNodes(context.id);
      const edges = contextService.getEdges(context.id);

      expect(nodes.length).toBe(2);
      expect(edges.length).toBe(1);

      // 8. Both are active participants
      const participants = contextService.getActiveParticipants(context.id);
      expect(participants.length).toBe(2);
    });

    it('should create a group and shared context together', async () => {
      // Create group
      const group = socialService.createGroup(alice.id, {
        name: 'Project Team',
        isPublic: false
      });

      // Add Bob
      await socialService.addToGroup(group.id, bob.id, 'member');

      // Create shared context for the group
      const context = contextService.createContext(alice.id, {
        name: `${group.name} Workspace`
      });

      // Grant access to all group members
      const members = socialService.getGroupMembers(group.id);
      for (const member of members) {
        if (member.brokerId !== alice.id) {
          contextService.grantAccess(context.id, alice.id, member.brokerId, 'write');
        }
      }

      // Bob joins
      contextService.joinContext(context.id, bob.id);

      // Both can contribute
      const aliceNode = contextService.addNode(context.id, alice.id, 'task', { title: 'Setup' });
      const bobNode = contextService.addNode(context.id, bob.id, 'task', { title: 'Design' });

      expect(aliceNode).toBeDefined();
      expect(bobNode).toBeDefined();
    });
  });

  // =========================================================================
  // Stats and Monitoring Tests
  // =========================================================================

  describe('Stats and Monitoring', () => {
    it('should provide context stats', () => {
      contextService.createContext(alice.id, { name: 'Test 1' });
      contextService.createContext(alice.id, { name: 'Test 2' });

      const stats = contextService.getStats() as any;
      expect(stats.totalContexts).toBe(2);
    });

    it('should provide realtime sync stats', () => {
      const stats = realtimeService.getStats() as any;
      expect(stats.totalClients).toBe(0); // No WebSocket clients in unit test
      expect(stats.brokerCount).toBe(0);
    });
  });
});

// =========================================================================
// CRDT Unit Tests
// =========================================================================

describe('CRDT Implementations', () => {
  describe('LWW Register', () => {
    it('should use last-write-wins semantics', async () => {
      const { LWWRegister } = await import('../../src/services/shared-context.js');

      const reg1 = new LWWRegister('initial', 'replica1');
      expect(reg1.get()).toBe('initial');

      reg1.set('updated', Date.now() + 100);
      expect(reg1.get()).toBe('updated');

      // Earlier timestamp should not overwrite
      reg1.set('old', Date.now() - 1000);
      expect(reg1.get()).toBe('updated');
    });
  });

  describe('G-Counter', () => {
    it('should only grow', async () => {
      const { GCounter } = await import('../../src/services/shared-context.js');

      const counter = new GCounter('replica1');
      expect(counter.value()).toBe(0);

      counter.increment(5);
      expect(counter.value()).toBe(5);

      counter.increment(3);
      expect(counter.value()).toBe(8);
    });
  });

  describe('PN-Counter', () => {
    it('should support increment and decrement', async () => {
      const { PNCounter } = await import('../../src/services/shared-context.js');

      const counter = new PNCounter('replica1');
      expect(counter.value()).toBe(0);

      counter.increment(10);
      expect(counter.value()).toBe(10);

      counter.decrement(3);
      expect(counter.value()).toBe(7);

      counter.decrement(10);
      expect(counter.value()).toBe(-3);
    });
  });

  describe('OR-Set', () => {
    it('should handle add and remove correctly', async () => {
      const { ORSet } = await import('../../src/services/shared-context.js');

      const set = new ORSet<string>('replica1');

      set.add('apple');
      set.add('banana');
      expect(set.has('apple')).toBe(true);
      expect(set.has('banana')).toBe(true);

      set.remove('apple');
      expect(set.has('apple')).toBe(false);
      expect(set.has('banana')).toBe(true);

      // Can re-add after remove
      set.add('apple');
      expect(set.has('apple')).toBe(true);
    });
  });

  describe('LWW-Map', () => {
    it('should handle map operations with LWW semantics', async () => {
      const { LWWMap } = await import('../../src/services/shared-context.js');

      const map = new LWWMap<string, number>('replica1');

      map.set('count', 10);
      expect(map.get('count')).toBe(10);

      map.set('count', 20);
      expect(map.get('count')).toBe(20);

      map.delete('count');
      expect(map.get('count')).toBeUndefined();
      expect(map.has('count')).toBe(false);
    });
  });
});
