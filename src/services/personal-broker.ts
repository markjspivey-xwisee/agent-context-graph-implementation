/**
 * Personal Broker Service
 *
 * Implements the Personal Broker ontology - a user-owned federated agent runtime
 * that acts as a personal AI assistant hub. Each user runs their own broker,
 * federating with others for social, collaborative, and multiplayer agent experiences.
 */

import { v4 as uuidv4 } from 'uuid';
import type { ContextBroker } from '../broker/context-broker.js';

// =============================================================================
// Types aligned with personal-broker.ttl ontology
// =============================================================================

export type MessageRole = 'user' | 'assistant' | 'agent' | 'system' | 'remote';
export type ConversationStatus = 'active' | 'paused' | 'ended' | 'archived';
export type ChannelType = 'web' | 'cli' | 'whatsapp' | 'telegram' | 'discord' | 'slack' | 'matrix' | 'email' | 'sms' | 'voice' | 'api';
export type ChannelStatus = 'connected' | 'disconnected' | 'error' | 'rate_limited';
export type MemoryType = 'episodic' | 'semantic' | 'procedural' | 'preference';
export type RoutineTrigger = 'scheduled' | 'event' | 'command' | 'context';
export type ToolCategory = 'search' | 'productivity' | 'smart_home' | 'communication' | 'finance' | 'media' | 'developer' | 'custom';
export type ContactStatus = 'pending' | 'accepted' | 'blocked' | 'muted';
export type ContactTrustLevel = 'public' | 'friend' | 'close' | 'family';
export type ParticipantRole = 'owner' | 'contributor' | 'observer' | 'agent';
export type PresenceStatus = 'online' | 'away' | 'busy' | 'dnd' | 'offline' | 'invisible';

// =============================================================================
// Core Interfaces
// =============================================================================

export interface Message {
  id: string;
  conversationId: string;
  role: MessageRole;
  content: string;
  timestamp: string;
  authorDID?: string;
  attachments?: string[];
  replyToId?: string;
  triggeredActionId?: string;
  metadata?: Record<string, unknown>;
}

export interface Conversation {
  id: string;
  brokerId: string;
  title?: string;
  status: ConversationStatus;
  startedAt: string;
  endedAt?: string;
  summary?: string;
  sourceChannelId?: string;
  contextGraphId?: string;
  spawnedWorkflowIds: string[];
  messageCount: number;
}

export interface Channel {
  id: string;
  brokerId: string;
  type: ChannelType;
  status: ChannelStatus;
  name?: string;
  identifier?: string; // Platform-specific ID (phone number, chat ID, etc.)
  webhookUrl?: string;
  lastActivity?: string;
  config?: Record<string, unknown>;
}

export interface MemoryEntry {
  id: string;
  brokerId: string;
  memoryType: MemoryType;
  content: string;
  createdAt: string;
  lastAccessed?: string;
  importance: number; // 0.0 to 1.0
  relatedConversationIds: string[];
  embedding?: number[]; // For vector similarity search
  tags: string[];
}

export interface Routine {
  id: string;
  brokerId: string;
  name: string;
  description?: string;
  trigger: RoutineTrigger;
  schedule?: string; // Cron expression for scheduled triggers
  triggerPattern?: string; // Pattern for command/event triggers
  actionTemplate: unknown; // Action to execute
  enabled: boolean;
  lastRun?: string;
  nextRun?: string;
}

export interface Tool {
  id: string;
  brokerId: string;
  name: string;
  description?: string;
  category: ToolCategory;
  endpoint?: string;
  enabled: boolean;
  requiredCredentialIds: string[];
  schema?: unknown; // JSON Schema for tool parameters
}

export interface Contact {
  id: string;
  brokerId: string; // Owner's broker
  contactBrokerId: string; // Contact's broker
  contactBrokerEndpoint?: string;
  displayName?: string;
  nickname?: string;
  status: ContactStatus;
  trustLevel: ContactTrustLevel;
  addedAt: string;
  notes?: string;
  groupIds: string[];
}

export interface Group {
  id: string;
  brokerId: string;
  name: string;
  description?: string;
  createdAt: string;
  memberContactIds: string[];
}

export interface SharedWorkflow {
  id: string;
  ownerBrokerId: string;
  participants: WorkflowParticipant[];
  sharedContextId: string;
  status: 'active' | 'completed' | 'cancelled';
  createdAt: string;
}

export interface WorkflowParticipant {
  brokerId: string;
  role: ParticipantRole;
  joinedAt: string;
}

export interface Presence {
  brokerId: string;
  status: PresenceStatus;
  statusMessage?: string;
  lastSeen: string;
  visibleTo: 'public' | 'connections' | 'close' | 'private';
}

export interface PersonalBrokerConfig {
  displayName: string;
  ownerDID: string;
  timezone?: string;
  locale?: string;
  avatarUrl?: string;
  bio?: string;
  dataSpaceEndpoint?: string;
  federationEnabled?: boolean;
  supportedProtocols?: string[];
}

// =============================================================================
// Personal Broker Class
// =============================================================================

export class PersonalBroker {
  readonly id: string;
  readonly ownerDID: string;
  readonly config: PersonalBrokerConfig;
  readonly createdAt: string;

  // Core stores
  private conversations: Map<string, Conversation> = new Map();
  private messages: Map<string, Message[]> = new Map(); // conversationId -> messages
  private channels: Map<string, Channel> = new Map();
  private memory: Map<string, MemoryEntry> = new Map();
  private routines: Map<string, Routine> = new Map();
  private tools: Map<string, Tool> = new Map();
  private contacts: Map<string, Contact> = new Map();
  private groups: Map<string, Group> = new Map();
  private sharedWorkflows: Map<string, SharedWorkflow> = new Map();

  // Presence
  private presence: Presence;

  // Reference to ACG context broker for agent workflows
  private contextBroker?: ContextBroker;

  // Event handlers
  private eventHandlers: Map<string, Function[]> = new Map();

  constructor(config: PersonalBrokerConfig) {
    this.id = `pb:${uuidv4()}`;
    this.ownerDID = config.ownerDID;
    this.config = config;
    this.createdAt = new Date().toISOString();

    this.presence = {
      brokerId: this.id,
      status: 'online',
      lastSeen: this.createdAt,
      visibleTo: 'connections'
    };

    // Initialize default CLI channel
    this.addChannel({
      type: 'cli',
      name: 'Command Line',
      status: 'connected'
    });
  }

  // ===========================================
  // Context Broker Integration
  // ===========================================

  setContextBroker(broker: ContextBroker): void {
    this.contextBroker = broker;
  }

  // ===========================================
  // Conversation Management
  // ===========================================

  startConversation(options: {
    channelId?: string;
    title?: string;
    initialContext?: unknown;
  } = {}): Conversation {
    const id = `conv:${uuidv4()}`;
    const conversation: Conversation = {
      id,
      brokerId: this.id,
      title: options.title,
      status: 'active',
      startedAt: new Date().toISOString(),
      sourceChannelId: options.channelId,
      spawnedWorkflowIds: [],
      messageCount: 0
    };

    this.conversations.set(id, conversation);
    this.messages.set(id, []);
    this.emit('conversation:started', conversation);

    return conversation;
  }

  getConversation(id: string): Conversation | undefined {
    return this.conversations.get(id);
  }

  listConversations(filter?: {
    status?: ConversationStatus;
    channelId?: string;
    limit?: number;
  }): Conversation[] {
    let conversations = Array.from(this.conversations.values());

    if (filter?.status) {
      conversations = conversations.filter(c => c.status === filter.status);
    }
    if (filter?.channelId) {
      conversations = conversations.filter(c => c.sourceChannelId === filter.channelId);
    }

    // Sort by most recent first
    conversations.sort((a, b) =>
      new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
    );

    if (filter?.limit) {
      conversations = conversations.slice(0, filter.limit);
    }

    return conversations;
  }

  endConversation(id: string, summary?: string): void {
    const conversation = this.conversations.get(id);
    if (conversation) {
      conversation.status = 'ended';
      conversation.endedAt = new Date().toISOString();
      if (summary) {
        conversation.summary = summary;
      }
      this.emit('conversation:ended', conversation);
    }
  }

  archiveConversation(id: string): void {
    const conversation = this.conversations.get(id);
    if (conversation) {
      conversation.status = 'archived';
      this.emit('conversation:archived', conversation);
    }
  }

  // ===========================================
  // Message Management
  // ===========================================

  async sendMessage(conversationId: string, content: string, options: {
    role?: MessageRole;
    attachments?: string[];
    replyToId?: string;
    metadata?: Record<string, unknown>;
  } = {}): Promise<Message> {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) {
      throw new Error(`Conversation ${conversationId} not found`);
    }

    const message: Message = {
      id: `msg:${uuidv4()}`,
      conversationId,
      role: options.role ?? 'user',
      content,
      timestamp: new Date().toISOString(),
      authorDID: this.ownerDID,
      attachments: options.attachments,
      replyToId: options.replyToId,
      metadata: options.metadata
    };

    const messages = this.messages.get(conversationId) ?? [];
    messages.push(message);
    this.messages.set(conversationId, messages);

    conversation.messageCount = messages.length;

    this.emit('message:sent', message);

    // If this is a user message, generate an assistant response
    if (message.role === 'user') {
      await this.processUserMessage(message);
    }

    return message;
  }

  getMessages(conversationId: string, options?: {
    limit?: number;
    offset?: number;
    sinceId?: string;
  }): Message[] {
    let messages = this.messages.get(conversationId) ?? [];

    if (options?.sinceId) {
      const sinceIndex = messages.findIndex(m => m.id === options.sinceId);
      if (sinceIndex >= 0) {
        messages = messages.slice(sinceIndex + 1);
      }
    }

    if (options?.offset) {
      messages = messages.slice(options.offset);
    }

    if (options?.limit) {
      messages = messages.slice(0, options.limit);
    }

    return messages;
  }

  private async processUserMessage(message: Message): Promise<void> {
    // This is where we'd integrate with an LLM to generate responses
    // For now, we'll emit an event so external handlers can process it

    this.emit('message:received', message);

    // Check if message triggers any routines
    await this.checkRoutineTriggers(message);
  }

  // ===========================================
  // Channel Management
  // ===========================================

  addChannel(options: {
    type: ChannelType;
    name?: string;
    identifier?: string;
    webhookUrl?: string;
    config?: Record<string, unknown>;
    status?: ChannelStatus;
  }): Channel {
    const id = `ch:${uuidv4()}`;
    const channel: Channel = {
      id,
      brokerId: this.id,
      type: options.type,
      status: options.status ?? 'disconnected',
      name: options.name,
      identifier: options.identifier,
      webhookUrl: options.webhookUrl,
      config: options.config,
      lastActivity: new Date().toISOString()
    };

    this.channels.set(id, channel);
    this.emit('channel:added', channel);

    return channel;
  }

  getChannel(id: string): Channel | undefined {
    return this.channels.get(id);
  }

  listChannels(filter?: { type?: ChannelType; status?: ChannelStatus }): Channel[] {
    let channels = Array.from(this.channels.values());

    if (filter?.type) {
      channels = channels.filter(c => c.type === filter.type);
    }
    if (filter?.status) {
      channels = channels.filter(c => c.status === filter.status);
    }

    return channels;
  }

  updateChannelStatus(id: string, status: ChannelStatus): void {
    const channel = this.channels.get(id);
    if (channel) {
      channel.status = status;
      channel.lastActivity = new Date().toISOString();
      this.emit('channel:status_changed', channel);
    }
  }

  removeChannel(id: string): boolean {
    const channel = this.channels.get(id);
    if (channel) {
      this.channels.delete(id);
      this.emit('channel:removed', channel);
      return true;
    }
    return false;
  }

  // ===========================================
  // Memory Management
  // ===========================================

  storeMemory(options: {
    type: MemoryType;
    content: string;
    importance?: number;
    relatedConversationIds?: string[];
    tags?: string[];
    embedding?: number[];
  }): MemoryEntry {
    const id = `mem:${uuidv4()}`;
    const entry: MemoryEntry = {
      id,
      brokerId: this.id,
      memoryType: options.type,
      content: options.content,
      createdAt: new Date().toISOString(),
      importance: options.importance ?? 0.5,
      relatedConversationIds: options.relatedConversationIds ?? [],
      tags: options.tags ?? [],
      embedding: options.embedding
    };

    this.memory.set(id, entry);
    this.emit('memory:stored', entry);

    return entry;
  }

  recallMemory(query: {
    type?: MemoryType;
    tags?: string[];
    minImportance?: number;
    limit?: number;
  }): MemoryEntry[] {
    let entries = Array.from(this.memory.values());

    if (query.type) {
      entries = entries.filter(e => e.memoryType === query.type);
    }
    if (query.tags && query.tags.length > 0) {
      entries = entries.filter(e =>
        query.tags!.some(tag => e.tags.includes(tag))
      );
    }
    if (query.minImportance !== undefined) {
      entries = entries.filter(e => e.importance >= query.minImportance!);
    }

    // Sort by importance and recency
    entries.sort((a, b) => {
      const importanceDiff = b.importance - a.importance;
      if (Math.abs(importanceDiff) > 0.1) return importanceDiff;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });

    // Update last accessed
    const now = new Date().toISOString();
    entries.forEach(e => {
      e.lastAccessed = now;
    });

    if (query.limit) {
      entries = entries.slice(0, query.limit);
    }

    return entries;
  }

  // ===========================================
  // Routine Management
  // ===========================================

  addRoutine(options: {
    name: string;
    description?: string;
    trigger: RoutineTrigger;
    schedule?: string;
    triggerPattern?: string;
    actionTemplate: unknown;
    enabled?: boolean;
  }): Routine {
    const id = `routine:${uuidv4()}`;
    const routine: Routine = {
      id,
      brokerId: this.id,
      name: options.name,
      description: options.description,
      trigger: options.trigger,
      schedule: options.schedule,
      triggerPattern: options.triggerPattern,
      actionTemplate: options.actionTemplate,
      enabled: options.enabled ?? true
    };

    this.routines.set(id, routine);
    this.emit('routine:added', routine);

    return routine;
  }

  listRoutines(filter?: { trigger?: RoutineTrigger; enabled?: boolean }): Routine[] {
    let routines = Array.from(this.routines.values());

    if (filter?.trigger) {
      routines = routines.filter(r => r.trigger === filter.trigger);
    }
    if (filter?.enabled !== undefined) {
      routines = routines.filter(r => r.enabled === filter.enabled);
    }

    return routines;
  }

  toggleRoutine(id: string, enabled: boolean): void {
    const routine = this.routines.get(id);
    if (routine) {
      routine.enabled = enabled;
      this.emit('routine:toggled', routine);
    }
  }

  private async checkRoutineTriggers(message: Message): Promise<void> {
    const commandRoutines = this.listRoutines({ trigger: 'command', enabled: true });

    for (const routine of commandRoutines) {
      if (routine.triggerPattern) {
        const pattern = new RegExp(routine.triggerPattern, 'i');
        if (pattern.test(message.content)) {
          this.emit('routine:triggered', { routine, trigger: message });
          // Execute routine action
          await this.executeRoutine(routine);
        }
      }
    }
  }

  private async executeRoutine(routine: Routine): Promise<void> {
    routine.lastRun = new Date().toISOString();
    this.emit('routine:executing', routine);

    // Execute the action template
    // This would integrate with the context broker to spawn workflows
    if (this.contextBroker && routine.actionTemplate) {
      // TODO: Implement action execution via context broker
    }

    this.emit('routine:completed', routine);
  }

  // ===========================================
  // Tool Management
  // ===========================================

  registerTool(options: {
    name: string;
    description?: string;
    category: ToolCategory;
    endpoint?: string;
    requiredCredentialIds?: string[];
    schema?: unknown;
    enabled?: boolean;
  }): Tool {
    const id = `tool:${uuidv4()}`;
    const tool: Tool = {
      id,
      brokerId: this.id,
      name: options.name,
      description: options.description,
      category: options.category,
      endpoint: options.endpoint,
      enabled: options.enabled ?? true,
      requiredCredentialIds: options.requiredCredentialIds ?? [],
      schema: options.schema
    };

    this.tools.set(id, tool);
    this.emit('tool:registered', tool);

    return tool;
  }

  listTools(filter?: { category?: ToolCategory; enabled?: boolean }): Tool[] {
    let tools = Array.from(this.tools.values());

    if (filter?.category) {
      tools = tools.filter(t => t.category === filter.category);
    }
    if (filter?.enabled !== undefined) {
      tools = tools.filter(t => t.enabled === filter.enabled);
    }

    return tools;
  }

  // ===========================================
  // Contact & Social Management
  // ===========================================

  addContact(options: {
    contactBrokerId: string;
    contactBrokerEndpoint?: string;
    displayName?: string;
    trustLevel?: ContactTrustLevel;
  }): Contact {
    const id = `contact:${uuidv4()}`;
    const contact: Contact = {
      id,
      brokerId: this.id,
      contactBrokerId: options.contactBrokerId,
      contactBrokerEndpoint: options.contactBrokerEndpoint,
      displayName: options.displayName,
      status: 'pending',
      trustLevel: options.trustLevel ?? 'public',
      addedAt: new Date().toISOString(),
      groupIds: []
    };

    this.contacts.set(id, contact);
    this.emit('contact:added', contact);

    // Send connection request to remote broker
    this.emit('federation:connection_requested', {
      from: this.id,
      to: options.contactBrokerId,
      endpoint: options.contactBrokerEndpoint
    });

    return contact;
  }

  acceptContact(id: string): void {
    const contact = this.contacts.get(id);
    if (contact && contact.status === 'pending') {
      contact.status = 'accepted';
      this.emit('contact:accepted', contact);
      this.emit('federation:connection_accepted', {
        contact,
        brokerId: this.id
      });
    }
  }

  blockContact(id: string): void {
    const contact = this.contacts.get(id);
    if (contact) {
      contact.status = 'blocked';
      this.emit('contact:blocked', contact);
    }
  }

  listContacts(filter?: {
    status?: ContactStatus;
    trustLevel?: ContactTrustLevel;
    groupId?: string;
  }): Contact[] {
    let contacts = Array.from(this.contacts.values());

    if (filter?.status) {
      contacts = contacts.filter(c => c.status === filter.status);
    }
    if (filter?.trustLevel) {
      contacts = contacts.filter(c => c.trustLevel === filter.trustLevel);
    }
    if (filter?.groupId) {
      contacts = contacts.filter(c => c.groupIds.includes(filter.groupId!));
    }

    return contacts;
  }

  // ===========================================
  // Group Management
  // ===========================================

  createGroup(options: {
    name: string;
    description?: string;
    memberContactIds?: string[];
  }): Group {
    const id = `group:${uuidv4()}`;
    const group: Group = {
      id,
      brokerId: this.id,
      name: options.name,
      description: options.description,
      createdAt: new Date().toISOString(),
      memberContactIds: options.memberContactIds ?? []
    };

    this.groups.set(id, group);

    // Update contacts with group membership
    for (const contactId of group.memberContactIds) {
      const contact = this.contacts.get(contactId);
      if (contact && !contact.groupIds.includes(id)) {
        contact.groupIds.push(id);
      }
    }

    this.emit('group:created', group);
    return group;
  }

  addToGroup(groupId: string, contactId: string): void {
    const group = this.groups.get(groupId);
    const contact = this.contacts.get(contactId);

    if (group && contact) {
      if (!group.memberContactIds.includes(contactId)) {
        group.memberContactIds.push(contactId);
      }
      if (!contact.groupIds.includes(groupId)) {
        contact.groupIds.push(groupId);
      }
      this.emit('group:member_added', { group, contact });
    }
  }

  listGroups(): Group[] {
    return Array.from(this.groups.values());
  }

  // ===========================================
  // Shared Workflow Management
  // ===========================================

  createSharedWorkflow(options: {
    participantBrokerIds: string[];
    sharedContextId: string;
  }): SharedWorkflow {
    const id = `swf:${uuidv4()}`;
    const now = new Date().toISOString();

    const participants: WorkflowParticipant[] = [
      { brokerId: this.id, role: 'owner', joinedAt: now },
      ...options.participantBrokerIds.map(brokerId => ({
        brokerId,
        role: 'contributor' as ParticipantRole,
        joinedAt: now
      }))
    ];

    const workflow: SharedWorkflow = {
      id,
      ownerBrokerId: this.id,
      participants,
      sharedContextId: options.sharedContextId,
      status: 'active',
      createdAt: now
    };

    this.sharedWorkflows.set(id, workflow);
    this.emit('workflow:shared_created', workflow);

    // Notify participants via federation
    for (const brokerId of options.participantBrokerIds) {
      this.emit('federation:workflow_invitation', {
        workflow,
        targetBrokerId: brokerId
      });
    }

    return workflow;
  }

  listSharedWorkflows(filter?: {
    status?: 'active' | 'completed' | 'cancelled';
    participantBrokerId?: string;
  }): SharedWorkflow[] {
    let workflows = Array.from(this.sharedWorkflows.values());

    if (filter?.status) {
      workflows = workflows.filter(w => w.status === filter.status);
    }
    if (filter?.participantBrokerId) {
      workflows = workflows.filter(w =>
        w.participants.some(p => p.brokerId === filter.participantBrokerId)
      );
    }

    return workflows;
  }

  // ===========================================
  // Presence Management
  // ===========================================

  updatePresence(updates: {
    status?: PresenceStatus;
    statusMessage?: string;
    visibleTo?: 'public' | 'connections' | 'close' | 'private';
  }): Presence {
    if (updates.status) {
      this.presence.status = updates.status;
    }
    if (updates.statusMessage !== undefined) {
      this.presence.statusMessage = updates.statusMessage;
    }
    if (updates.visibleTo) {
      this.presence.visibleTo = updates.visibleTo;
    }
    this.presence.lastSeen = new Date().toISOString();

    this.emit('presence:updated', this.presence);
    return this.presence;
  }

  getPresence(): Presence {
    return { ...this.presence };
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
      this.eventHandlers.set(event, handlers);
    }
  }

  private emit(event: string, data: unknown): void {
    const handlers = this.eventHandlers.get(event) ?? [];
    for (const handler of handlers) {
      try {
        handler(data);
      } catch (error) {
        console.error(`Error in event handler for ${event}:`, error);
      }
    }
  }

  // ===========================================
  // Serialization
  // ===========================================

  toJSON(): Record<string, unknown> {
    return {
      '@type': 'pb:PersonalBroker',
      id: this.id,
      ownerDID: this.ownerDID,
      config: this.config,
      createdAt: this.createdAt,
      presence: this.presence,
      stats: {
        conversations: this.conversations.size,
        channels: this.channels.size,
        memories: this.memory.size,
        routines: this.routines.size,
        tools: this.tools.size,
        contacts: this.contacts.size,
        groups: this.groups.size,
        sharedWorkflows: this.sharedWorkflows.size
      }
    };
  }
}

// =============================================================================
// Personal Broker Registry
// =============================================================================

export class PersonalBrokerRegistry {
  private brokers: Map<string, PersonalBroker> = new Map();
  private brokersByOwner: Map<string, string> = new Map(); // ownerDID -> brokerId

  createBroker(config: PersonalBrokerConfig): PersonalBroker {
    // Check if owner already has a broker
    if (this.brokersByOwner.has(config.ownerDID)) {
      throw new Error(`Broker already exists for owner ${config.ownerDID}`);
    }

    const broker = new PersonalBroker(config);
    this.brokers.set(broker.id, broker);
    this.brokersByOwner.set(config.ownerDID, broker.id);

    return broker;
  }

  getBroker(id: string): PersonalBroker | undefined {
    return this.brokers.get(id);
  }

  getBrokerByOwner(ownerDID: string): PersonalBroker | undefined {
    const brokerId = this.brokersByOwner.get(ownerDID);
    return brokerId ? this.brokers.get(brokerId) : undefined;
  }

  listBrokers(): PersonalBroker[] {
    return Array.from(this.brokers.values());
  }

  removeBroker(id: string): boolean {
    const broker = this.brokers.get(id);
    if (broker) {
      this.brokers.delete(id);
      this.brokersByOwner.delete(broker.ownerDID);
      return true;
    }
    return false;
  }
}
