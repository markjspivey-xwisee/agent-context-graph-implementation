import { describe, it, expect, beforeEach } from 'vitest';
import {
  PersonalBroker,
  PersonalBrokerRegistry,
  type PersonalBrokerConfig
} from '../../src/services/personal-broker.js';

describe('PersonalBroker', () => {
  let registry: PersonalBrokerRegistry;
  let broker: PersonalBroker;

  beforeEach(() => {
    registry = new PersonalBrokerRegistry();
    broker = registry.createBroker({
      displayName: 'Test Assistant',
      ownerDID: 'did:key:z6MkTest123',
      timezone: 'UTC',
      locale: 'en-US'
    });
  });

  describe('Initialization', () => {
    it('should create a broker with generated ID', () => {
      expect(broker.id).toBeDefined();
      expect(broker.id).toMatch(/^pb:/);
    });

    it('should store broker in registry', () => {
      const retrieved = registry.getBroker(broker.id);
      expect(retrieved).toBe(broker);
    });

    it('should serialize to JSON', () => {
      const json = broker.toJSON();
      expect(json.id).toBe(broker.id);
      expect((json.config as any).displayName).toBe('Test Assistant');
      expect(json.ownerDID).toBe('did:key:z6MkTest123');
    });
  });

  describe('Conversations', () => {
    it('should start a new conversation', () => {
      const conv = broker.startConversation({ title: 'Test Chat' });
      expect(conv.id).toBeDefined();
      expect(conv.title).toBe('Test Chat');
      expect(conv.status).toBe('active');
    });

    it('should list conversations', () => {
      broker.startConversation({ title: 'Chat 1' });
      broker.startConversation({ title: 'Chat 2' });
      const list = broker.listConversations();
      expect(list.length).toBe(2);
    });

    it('should get a specific conversation', () => {
      const conv = broker.startConversation({ title: 'Test' });
      const retrieved = broker.getConversation(conv.id);
      expect(retrieved?.id).toBe(conv.id);
    });

    it('should end a conversation', () => {
      const conv = broker.startConversation({ title: 'Test' });
      broker.endConversation(conv.id);
      const retrieved = broker.getConversation(conv.id);
      expect(retrieved?.status).toBe('ended');
    });

    it('should filter conversations by status', () => {
      broker.startConversation({ title: 'Active' });
      const conv2 = broker.startConversation({ title: 'Ended' });
      broker.endConversation(conv2.id);

      const active = broker.listConversations({ status: 'active' });
      expect(active.length).toBe(1);
      expect(active[0].title).toBe('Active');
    });
  });

  describe('Messages', () => {
    let conversationId: string;

    beforeEach(() => {
      const conv = broker.startConversation({ title: 'Message Test' });
      conversationId = conv.id;
    });

    it('should send a user message', async () => {
      const msg = await broker.sendMessage(conversationId, 'Hello!', { role: 'user' });
      expect(msg.content).toBe('Hello!');
      expect(msg.role).toBe('user');
    });

    it('should get messages from conversation', async () => {
      await broker.sendMessage(conversationId, 'First', { role: 'user' });
      await broker.sendMessage(conversationId, 'Second', { role: 'assistant' });

      const messages = broker.getMessages(conversationId);
      expect(messages.length).toBe(2);
    });

    it('should limit messages returned', async () => {
      await broker.sendMessage(conversationId, 'One', { role: 'user' });
      await broker.sendMessage(conversationId, 'Two', { role: 'user' });
      await broker.sendMessage(conversationId, 'Three', { role: 'user' });

      const messages = broker.getMessages(conversationId, { limit: 2 });
      expect(messages.length).toBe(2);
    });
  });

  describe('Memory', () => {
    it('should store a memory entry', () => {
      const entry = broker.storeMemory({
        type: 'semantic',
        content: 'The user prefers dark mode',
        importance: 0.8,
        tags: ['preference', 'ui']
      });
      expect(entry.id).toBeDefined();
      expect(entry.content).toBe('The user prefers dark mode');
    });

    it('should recall memories by type', () => {
      broker.storeMemory({ type: 'semantic', content: 'Fact 1' });
      broker.storeMemory({ type: 'episodic', content: 'Event 1' });
      broker.storeMemory({ type: 'semantic', content: 'Fact 2' });

      const semantic = broker.recallMemory({ type: 'semantic' });
      expect(semantic.length).toBe(2);
    });

    it('should filter by minimum importance', () => {
      broker.storeMemory({ type: 'semantic', content: 'Low', importance: 0.3 });
      broker.storeMemory({ type: 'semantic', content: 'High', importance: 0.9 });

      const important = broker.recallMemory({ minImportance: 0.5 });
      expect(important.length).toBe(1);
      expect(important[0].content).toBe('High');
    });
  });

  describe('Contacts', () => {
    it('should list contacts', () => {
      const contacts = broker.listContacts();
      expect(Array.isArray(contacts)).toBe(true);
    });
  });

  describe('Presence', () => {
    it('should get presence status', () => {
      const presence = broker.getPresence();
      expect(presence.status).toBeDefined();
    });

    it('should update presence', () => {
      const updated = broker.updatePresence({ status: 'busy', statusMessage: 'In a meeting' });
      expect(updated.status).toBe('busy');
      expect(updated.statusMessage).toBe('In a meeting');
    });
  });

  describe('Channels', () => {
    it('should list channels', () => {
      const channels = broker.listChannels();
      expect(Array.isArray(channels)).toBe(true);
    });
  });

  describe('Tools', () => {
    it('should list available tools', () => {
      const tools = broker.listTools();
      expect(Array.isArray(tools)).toBe(true);
    });
  });

  describe('Routines', () => {
    it('should list routines', () => {
      const routines = broker.listRoutines();
      expect(Array.isArray(routines)).toBe(true);
    });
  });
});

describe('PersonalBrokerRegistry', () => {
  let registry: PersonalBrokerRegistry;

  beforeEach(() => {
    registry = new PersonalBrokerRegistry();
  });

  it('should create multiple brokers', () => {
    const broker1 = registry.createBroker({ displayName: 'Broker 1', ownerDID: 'did:1' });
    const broker2 = registry.createBroker({ displayName: 'Broker 2', ownerDID: 'did:2' });
    expect(broker1.id).not.toBe(broker2.id);
  });

  it('should list all brokers', () => {
    registry.createBroker({ displayName: 'Broker 1', ownerDID: 'did:1' });
    registry.createBroker({ displayName: 'Broker 2', ownerDID: 'did:2' });
    const list = registry.listBrokers();
    expect(list.length).toBe(2);
  });

  it('should get broker by owner DID', () => {
    const broker = registry.createBroker({ displayName: 'Test', ownerDID: 'did:owner:123' });
    const found = registry.getBrokerByOwner('did:owner:123');
    expect(found?.id).toBe(broker.id);
  });

  it('should delete a broker', () => {
    const broker = registry.createBroker({ displayName: 'To Delete', ownerDID: 'did:delete' });
    expect(registry.removeBroker(broker.id)).toBe(true);
    expect(registry.getBroker(broker.id)).toBeUndefined();
  });
});
