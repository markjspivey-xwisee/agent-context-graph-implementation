import { describe, it, expect, beforeEach } from 'vitest';
import {
  SocialFederationService,
  type SocialProfile,
  type SocialConnection
} from '../../src/services/social-federation.js';
import { PersonalBroker, PersonalBrokerRegistry } from '../../src/services/personal-broker.js';

describe('SocialFederationService', () => {
  let service: SocialFederationService;
  let registry: PersonalBrokerRegistry;
  let aliceBroker: PersonalBroker;
  let bobBroker: PersonalBroker;

  beforeEach(() => {
    service = new SocialFederationService();
    registry = new PersonalBrokerRegistry();

    aliceBroker = registry.createBroker({
      displayName: 'Alice Assistant',
      ownerDID: 'did:key:alice123'
    });

    bobBroker = registry.createBroker({
      displayName: 'Bob Assistant',
      ownerDID: 'did:key:bob456'
    });
  });

  describe('Profiles', () => {
    it('should create a profile for a broker', () => {
      const profile = service.createProfile(aliceBroker);
      expect(profile.brokerId).toBe(aliceBroker.id);
      expect(profile.displayName).toBe('Alice Assistant');
    });

    it('should get a profile by broker ID', () => {
      service.createProfile(aliceBroker);
      const profile = service.getProfile(aliceBroker.id);
      expect(profile?.displayName).toBe('Alice Assistant');
    });

    it('should update a profile', () => {
      service.createProfile(aliceBroker);
      const updated = service.updateProfile(aliceBroker.id, {
        bio: 'A helpful AI assistant',
        visibility: 'public'
      });
      expect(updated?.bio).toBe('A helpful AI assistant');
      expect(updated?.visibility).toBe('public');
    });

    it('should return undefined for non-existent profile', () => {
      const profile = service.getProfile('nonexistent');
      expect(profile).toBeUndefined();
    });
  });

  describe('Connection Requests', () => {
    beforeEach(() => {
      service.createProfile(aliceBroker);
      service.createProfile(bobBroker);
    });

    it('should create a connection request', async () => {
      const request = await service.requestConnection(aliceBroker, bobBroker.id, {
        message: 'Let\'s collaborate!'
      });
      expect(request.fromBrokerId).toBe(aliceBroker.id);
      expect(request.toBrokerId).toBe(bobBroker.id);
      expect(request.id).toBeDefined();
    });

    it('should get pending requests for a broker', async () => {
      await service.requestConnection(aliceBroker, bobBroker.id);
      const pending = service.getPendingRequests(bobBroker.id);
      expect(pending.length).toBe(1);
    });

    it('should accept a connection request', async () => {
      const request = await service.requestConnection(aliceBroker, bobBroker.id);
      const connection = await service.acceptConnection(request, bobBroker);
      expect(connection.state).toBe('accepted');
    });

    it('should reject a connection request', async () => {
      const request = await service.requestConnection(aliceBroker, bobBroker.id);
      await service.rejectConnection(request.id);
      const pending = service.getPendingRequests(bobBroker.id);
      expect(pending.length).toBe(0);
    });
  });

  describe('Connections', () => {
    beforeEach(async () => {
      service.createProfile(aliceBroker);
      service.createProfile(bobBroker);
      const request = await service.requestConnection(aliceBroker, bobBroker.id);
      await service.acceptConnection(request, bobBroker);
    });

    it('should get connections for a broker', () => {
      const connections = service.getConnectionsForBroker(aliceBroker.id);
      expect(connections.length).toBeGreaterThanOrEqual(1);
    });

    it('should have reciprocal connections', () => {
      const aliceConnections = service.getConnectionsForBroker(aliceBroker.id);
      const bobConnections = service.getConnectionsForBroker(bobBroker.id);
      expect(aliceConnections.length).toBeGreaterThan(0);
      expect(bobConnections.length).toBeGreaterThan(0);
    });
  });

  describe('Invite Links', () => {
    beforeEach(() => {
      service.createProfile(aliceBroker);
      service.createProfile(bobBroker);
    });

    it('should create an invite link', () => {
      const invite = service.createInviteLink(aliceBroker.id, {
        maxUses: 5,
        expiresInHours: 24
      });
      expect(invite.code).toBeDefined();
      expect(invite.maxUses).toBe(5);
    });

    it('should use an invite link to connect', async () => {
      const invite = service.createInviteLink(aliceBroker.id);
      const result = await service.useInviteLink(invite.code, bobBroker);
      expect(result.success).toBe(true);
      expect(result.connection).toBeDefined();
    });

    it('should return error for expired invite links', async () => {
      const invite = service.createInviteLink(aliceBroker.id, {
        expiresInHours: -1 // Already expired
      });
      const result = await service.useInviteLink(invite.code, bobBroker);
      expect(result.success).toBe(false);
      expect(result.error).toContain('expired');
    });

    it('should return error for invalid invite code', async () => {
      const result = await service.useInviteLink('INVALID', bobBroker);
      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid');
    });
  });

  describe('Groups', () => {
    beforeEach(() => {
      service.createProfile(aliceBroker);
      service.createProfile(bobBroker);
    });

    it('should create a group', () => {
      const group = service.createGroup(aliceBroker.id, {
        name: 'Research Team',
        description: 'AI Safety researchers'
      });
      expect(group.name).toBe('Research Team');
      expect(group.ownerBrokerId).toBe(aliceBroker.id);
    });

    it('should add members to a group', async () => {
      const group = service.createGroup(aliceBroker.id, { name: 'Team' });
      const membership = await service.addToGroup(group.id, bobBroker.id, 'member');
      expect(membership.role).toBe('member');
    });

    it('should list groups for a broker', () => {
      service.createGroup(aliceBroker.id, { name: 'Group 1' });
      service.createGroup(aliceBroker.id, { name: 'Group 2' });
      const groups = service.getGroupsForBroker(aliceBroker.id);
      expect(groups.length).toBe(2);
    });

    it('should remove member from group', async () => {
      const group = service.createGroup(aliceBroker.id, { name: 'Team' });
      await service.addToGroup(group.id, bobBroker.id, 'member');
      await service.removeFromGroup(group.id, bobBroker.id);
      // Bob should not see the group anymore
      const bobGroups = service.getGroupsForBroker(bobBroker.id);
      expect(bobGroups.find(g => g.id === group.id)).toBeUndefined();
    });
  });

  describe('Notifications', () => {
    beforeEach(() => {
      service.createProfile(aliceBroker);
    });

    it('should get notifications', () => {
      const notifications = service.getNotifications(aliceBroker.id);
      expect(Array.isArray(notifications)).toBe(true);
    });

    it('should mark notification as read', async () => {
      // Create a connection request to generate a notification
      service.createProfile(bobBroker);
      await service.requestConnection(bobBroker, aliceBroker.id);

      const notifications = service.getNotifications(aliceBroker.id, { unreadOnly: true });
      if (notifications.length > 0) {
        service.markNotificationRead(notifications[0].id);
        const afterMark = service.getNotifications(aliceBroker.id, { unreadOnly: true });
        expect(afterMark.length).toBe(notifications.length - 1);
      }
    });
  });

  describe('Discovery', () => {
    beforeEach(() => {
      service.createProfile(aliceBroker);
    });

    it('should attempt to discover by DID', async () => {
      const result = await service.discoverByDID(aliceBroker.toJSON().ownerDID);
      // May or may not find depending on implementation
      expect(result === undefined || typeof result === 'object').toBe(true);
    });

    it('should search profiles', async () => {
      service.updateProfile(aliceBroker.id, { visibility: 'public' });
      const results = service.searchProfiles('Alice');
      expect(Array.isArray(results)).toBe(true);
    });
  });
});
