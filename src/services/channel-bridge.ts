/**
 * Channel Bridge Service
 *
 * Implements the Channel Bridge Protocol ontology - how external communication
 * platforms (WhatsApp, Telegram, Discord, etc.) connect to ACG personal brokers.
 * Channels act as federated bridges, translating platform-specific messages
 * to ACG messages and back.
 */

import { v4 as uuidv4 } from 'uuid';
import type {
  PersonalBroker,
  Message,
  Conversation,
  ChannelType,
  ChannelStatus,
  MessageRole
} from './personal-broker.js';

// =============================================================================
// Types aligned with channel-bridge.ttl ontology
// =============================================================================

export type PlatformCapability =
  | 'text_messages'
  | 'rich_messages'
  | 'media_messages'
  | 'voice_messages'
  | 'video_messages'
  | 'reactions'
  | 'threads'
  | 'edit_messages'
  | 'delete_messages'
  | 'read_receipts'
  | 'typing_indicators'
  | 'group_chats'
  | 'direct_messages'
  | 'channels'
  | 'webhooks'
  | 'bot_api'
  | 'user_api'
  | 'e2e_encryption';

export type AuthenticationMethod =
  | 'phone_number'
  | 'bot_token'
  | 'oauth2'
  | 'api_key'
  | 'matrix_auth'
  | 'apple_id'
  | 'imap'
  | 'session'
  | 'local'
  | 'webhook_signature'
  | 'mtls';

export type ConnectionStatus =
  | 'active'
  | 'inactive'
  | 'expired'
  | 'revoked'
  | 'pending';

// =============================================================================
// Platform Definitions
// =============================================================================

export interface PlatformDefinition {
  id: string;
  name: string;
  channelType: ChannelType;
  capabilities: PlatformCapability[];
  authMethods: AuthenticationMethod[];
  apiSpec?: string;
  icon?: string;
}

export const PLATFORMS: Record<string, PlatformDefinition> = {
  whatsapp: {
    id: 'whatsapp',
    name: 'WhatsApp',
    channelType: 'whatsapp',
    capabilities: [
      'text_messages', 'media_messages', 'voice_messages',
      'video_messages', 'reactions', 'group_chats',
      'direct_messages', 'e2e_encryption', 'bot_api'
    ],
    authMethods: ['phone_number'],
    apiSpec: 'https://developers.facebook.com/docs/whatsapp/cloud-api'
  },
  telegram: {
    id: 'telegram',
    name: 'Telegram',
    channelType: 'telegram',
    capabilities: [
      'text_messages', 'rich_messages', 'media_messages',
      'voice_messages', 'video_messages', 'reactions',
      'threads', 'edit_messages', 'delete_messages',
      'group_chats', 'direct_messages', 'channels',
      'webhooks', 'bot_api'
    ],
    authMethods: ['bot_token'],
    apiSpec: 'https://core.telegram.org/bots/api'
  },
  discord: {
    id: 'discord',
    name: 'Discord',
    channelType: 'discord',
    capabilities: [
      'text_messages', 'rich_messages', 'media_messages',
      'voice_messages', 'reactions', 'threads',
      'edit_messages', 'delete_messages', 'group_chats',
      'direct_messages', 'channels', 'webhooks', 'bot_api'
    ],
    authMethods: ['oauth2', 'bot_token'],
    apiSpec: 'https://discord.com/developers/docs'
  },
  slack: {
    id: 'slack',
    name: 'Slack',
    channelType: 'slack',
    capabilities: [
      'text_messages', 'rich_messages', 'media_messages',
      'reactions', 'threads', 'edit_messages',
      'delete_messages', 'group_chats', 'direct_messages',
      'channels', 'webhooks', 'bot_api'
    ],
    authMethods: ['oauth2'],
    apiSpec: 'https://api.slack.com/'
  },
  matrix: {
    id: 'matrix',
    name: 'Matrix',
    channelType: 'matrix',
    capabilities: [
      'text_messages', 'rich_messages', 'media_messages',
      'reactions', 'threads', 'edit_messages',
      'delete_messages', 'group_chats', 'direct_messages',
      'e2e_encryption', 'user_api'
    ],
    authMethods: ['matrix_auth'],
    apiSpec: 'https://spec.matrix.org/latest/client-server-api/'
  },
  web: {
    id: 'web',
    name: 'Web Chat',
    channelType: 'web',
    capabilities: [
      'text_messages', 'rich_messages', 'media_messages',
      'typing_indicators', 'direct_messages', 'webhooks'
    ],
    authMethods: ['session', 'oauth2']
  },
  cli: {
    id: 'cli',
    name: 'Command Line',
    channelType: 'cli',
    capabilities: ['text_messages'],
    authMethods: ['local']
  },
  email: {
    id: 'email',
    name: 'Email',
    channelType: 'email',
    capabilities: [
      'text_messages', 'rich_messages', 'media_messages',
      'threads', 'direct_messages'
    ],
    authMethods: ['oauth2', 'imap']
  },
  sms: {
    id: 'sms',
    name: 'SMS',
    channelType: 'sms',
    capabilities: ['text_messages', 'direct_messages'],
    authMethods: ['phone_number'],
    apiSpec: 'https://www.twilio.com/docs/sms'
  }
};

// =============================================================================
// Bridge Connection
// =============================================================================

export interface BridgeConnection {
  id: string;
  brokerId: string;
  bridgeId: string;
  channelId: string;
  platformUserId?: string;
  platformUserHandle?: string;
  status: ConnectionStatus;
  accessToken?: string; // Encrypted
  refreshToken?: string; // Encrypted
  tokenExpiry?: string;
  createdAt: string;
  lastActivity?: string;
  metadata?: Record<string, unknown>;
}

// =============================================================================
// Inbound/Outbound Messages
// =============================================================================

export interface InboundPlatformMessage {
  id: string;
  platformMessageId: string;
  platformChatId: string;
  platform: string;
  content: string;
  authorId?: string;
  authorName?: string;
  timestamp: string;
  attachments?: PlatformAttachment[];
  replyToId?: string;
  rawPayload?: string;
  metadata?: Record<string, unknown>;
}

export interface OutboundPlatformMessage {
  id: string;
  acgMessageId: string;
  platformChatId: string;
  content: string;
  attachments?: PlatformAttachment[];
  replyToId?: string;
  deliveryStatus?: 'pending' | 'sent' | 'delivered' | 'read' | 'failed';
  platformMessageId?: string; // Set after sending
  errorMessage?: string;
}

export interface PlatformAttachment {
  type: 'image' | 'video' | 'audio' | 'file' | 'document';
  url?: string;
  data?: Buffer;
  mimeType?: string;
  filename?: string;
  size?: number;
}

// =============================================================================
// Message Transform
// =============================================================================

export interface MessageTransform {
  id: string;
  name: string;
  direction: 'inbound' | 'outbound' | 'bidirectional';
  capability: PlatformCapability;
  priority: number;
  transform: (message: unknown) => unknown;
}

// =============================================================================
// Rate Limiter
// =============================================================================

export interface RateLimiterConfig {
  requestsPerSecond?: number;
  requestsPerMinute?: number;
  requestsPerDay?: number;
  burstLimit?: number;
}

export class RateLimiter {
  private timestamps: number[] = [];
  private config: RateLimiterConfig;

  constructor(config: RateLimiterConfig) {
    this.config = config;
  }

  async acquire(): Promise<boolean> {
    const now = Date.now();

    // Clean old timestamps
    const oneMinuteAgo = now - 60000;
    const oneDayAgo = now - 86400000;
    this.timestamps = this.timestamps.filter(t => t > oneDayAgo);

    // Check per-second limit
    if (this.config.requestsPerSecond) {
      const oneSecondAgo = now - 1000;
      const recentCount = this.timestamps.filter(t => t > oneSecondAgo).length;
      if (recentCount >= this.config.requestsPerSecond) {
        return false;
      }
    }

    // Check per-minute limit
    if (this.config.requestsPerMinute) {
      const minuteCount = this.timestamps.filter(t => t > oneMinuteAgo).length;
      if (minuteCount >= this.config.requestsPerMinute) {
        return false;
      }
    }

    // Check per-day limit
    if (this.config.requestsPerDay) {
      const dayCount = this.timestamps.filter(t => t > oneDayAgo).length;
      if (dayCount >= this.config.requestsPerDay) {
        return false;
      }
    }

    this.timestamps.push(now);
    return true;
  }

  getUsage(): { second: number; minute: number; day: number } {
    const now = Date.now();
    return {
      second: this.timestamps.filter(t => t > now - 1000).length,
      minute: this.timestamps.filter(t => t > now - 60000).length,
      day: this.timestamps.filter(t => t > now - 86400000).length
    };
  }
}

// =============================================================================
// Abstract Channel Adapter
// =============================================================================

export abstract class ChannelAdapter {
  readonly platform: PlatformDefinition;
  readonly bridgeId: string;
  protected rateLimiter?: RateLimiter;
  protected transforms: MessageTransform[] = [];
  protected eventHandlers: Map<string, Function[]> = new Map();

  constructor(platform: PlatformDefinition, rateLimiterConfig?: RateLimiterConfig) {
    this.platform = platform;
    this.bridgeId = `bridge:${platform.id}:${uuidv4()}`;

    if (rateLimiterConfig) {
      this.rateLimiter = new RateLimiter(rateLimiterConfig);
    }
  }

  // Abstract methods to be implemented by platform-specific adapters
  abstract connect(credentials: Record<string, string>): Promise<BridgeConnection>;
  abstract disconnect(connectionId: string): Promise<void>;
  abstract sendMessage(connection: BridgeConnection, message: OutboundPlatformMessage): Promise<string>;
  abstract handleWebhook(payload: unknown): Promise<InboundPlatformMessage | null>;

  // Transform inbound message to ACG format
  transformInbound(platformMessage: InboundPlatformMessage): Partial<Message> {
    const acgMessage: Partial<Message> = {
      id: `msg:${uuidv4()}`,
      role: 'user' as MessageRole,
      content: platformMessage.content,
      timestamp: platformMessage.timestamp,
      metadata: {
        platform: platformMessage.platform,
        platformMessageId: platformMessage.platformMessageId,
        platformChatId: platformMessage.platformChatId,
        authorId: platformMessage.authorId,
        authorName: platformMessage.authorName
      }
    };

    // Apply transforms
    let transformed = acgMessage;
    for (const t of this.transforms.filter(t =>
      t.direction === 'inbound' || t.direction === 'bidirectional'
    ).sort((a, b) => a.priority - b.priority)) {
      transformed = t.transform(transformed) as Partial<Message>;
    }

    return transformed;
  }

  // Transform outbound ACG message to platform format
  transformOutbound(acgMessage: Message, platformChatId: string): OutboundPlatformMessage {
    const platformMessage: OutboundPlatformMessage = {
      id: `out:${uuidv4()}`,
      acgMessageId: acgMessage.id,
      platformChatId,
      content: acgMessage.content,
      deliveryStatus: 'pending'
    };

    // Apply transforms
    let transformed = platformMessage;
    for (const t of this.transforms.filter(t =>
      t.direction === 'outbound' || t.direction === 'bidirectional'
    ).sort((a, b) => a.priority - b.priority)) {
      transformed = t.transform(transformed) as OutboundPlatformMessage;
    }

    return transformed;
  }

  // Add a custom transform
  addTransform(transform: MessageTransform): void {
    this.transforms.push(transform);
    this.transforms.sort((a, b) => a.priority - b.priority);
  }

  // Check rate limit before sending
  protected async checkRateLimit(): Promise<boolean> {
    if (!this.rateLimiter) return true;
    return this.rateLimiter.acquire();
  }

  // Event handling
  on(event: string, handler: Function): void {
    const handlers = this.eventHandlers.get(event) ?? [];
    handlers.push(handler);
    this.eventHandlers.set(event, handlers);
  }

  protected emit(event: string, data: unknown): void {
    const handlers = this.eventHandlers.get(event) ?? [];
    for (const handler of handlers) {
      try {
        handler(data);
      } catch (error) {
        console.error(`Error in channel adapter event handler for ${event}:`, error);
      }
    }
  }

  // Capability check
  hasCapability(capability: PlatformCapability): boolean {
    return this.platform.capabilities.includes(capability);
  }
}

// =============================================================================
// Web Chat Adapter (Reference Implementation)
// =============================================================================

export class WebChatAdapter extends ChannelAdapter {
  private connections: Map<string, BridgeConnection> = new Map();
  private sessions: Map<string, { socketId?: string; lastPing?: string }> = new Map();

  constructor() {
    super(PLATFORMS.web, {
      requestsPerSecond: 10,
      requestsPerMinute: 300
    });
  }

  async connect(credentials: Record<string, string>): Promise<BridgeConnection> {
    const connection: BridgeConnection = {
      id: `conn:${uuidv4()}`,
      brokerId: credentials.brokerId,
      bridgeId: this.bridgeId,
      channelId: credentials.channelId,
      platformUserId: credentials.sessionId ?? uuidv4(),
      status: 'active',
      createdAt: new Date().toISOString(),
      lastActivity: new Date().toISOString()
    };

    this.connections.set(connection.id, connection);
    this.sessions.set(connection.id, {});

    this.emit('connected', connection);
    return connection;
  }

  async disconnect(connectionId: string): Promise<void> {
    const connection = this.connections.get(connectionId);
    if (connection) {
      connection.status = 'inactive';
      this.connections.delete(connectionId);
      this.sessions.delete(connectionId);
      this.emit('disconnected', connection);
    }
  }

  async sendMessage(connection: BridgeConnection, message: OutboundPlatformMessage): Promise<string> {
    if (!await this.checkRateLimit()) {
      throw new Error('Rate limit exceeded');
    }

    // In a real implementation, this would send via WebSocket
    const platformMessageId = `web:${uuidv4()}`;
    message.platformMessageId = platformMessageId;
    message.deliveryStatus = 'sent';

    connection.lastActivity = new Date().toISOString();

    this.emit('message:sent', { connection, message });
    return platformMessageId;
  }

  async handleWebhook(payload: unknown): Promise<InboundPlatformMessage | null> {
    const data = payload as {
      sessionId: string;
      content: string;
      timestamp?: string;
    };

    if (!data.sessionId || !data.content) {
      return null;
    }

    const inbound: InboundPlatformMessage = {
      id: `in:${uuidv4()}`,
      platformMessageId: uuidv4(),
      platformChatId: data.sessionId,
      platform: 'web',
      content: data.content,
      authorId: data.sessionId,
      timestamp: data.timestamp ?? new Date().toISOString()
    };

    this.emit('message:received', inbound);
    return inbound;
  }

  // WebSocket-specific methods
  handleSocketConnect(connectionId: string, socketId: string): void {
    const session = this.sessions.get(connectionId);
    if (session) {
      session.socketId = socketId;
      this.emit('socket:connected', { connectionId, socketId });
    }
  }

  handleSocketDisconnect(socketId: string): void {
    for (const [connId, session] of this.sessions.entries()) {
      if (session.socketId === socketId) {
        session.socketId = undefined;
        this.emit('socket:disconnected', { connectionId: connId, socketId });
        break;
      }
    }
  }
}

// =============================================================================
// CLI Adapter (For local development/testing)
// =============================================================================

export class CLIAdapter extends ChannelAdapter {
  private connection?: BridgeConnection;

  constructor() {
    super(PLATFORMS.cli);
  }

  async connect(credentials: Record<string, string>): Promise<BridgeConnection> {
    this.connection = {
      id: `conn:cli:${uuidv4()}`,
      brokerId: credentials.brokerId,
      bridgeId: this.bridgeId,
      channelId: credentials.channelId,
      platformUserId: 'cli-user',
      status: 'active',
      createdAt: new Date().toISOString()
    };

    this.emit('connected', this.connection);
    return this.connection;
  }

  async disconnect(connectionId: string): Promise<void> {
    if (this.connection?.id === connectionId) {
      this.connection.status = 'inactive';
      this.emit('disconnected', this.connection);
      this.connection = undefined;
    }
  }

  async sendMessage(connection: BridgeConnection, message: OutboundPlatformMessage): Promise<string> {
    // For CLI, just log to console
    console.log(`\n[Assistant]: ${message.content}\n`);

    const platformMessageId = `cli:${uuidv4()}`;
    message.platformMessageId = platformMessageId;
    message.deliveryStatus = 'delivered';

    this.emit('message:sent', { connection, message });
    return platformMessageId;
  }

  async handleWebhook(payload: unknown): Promise<InboundPlatformMessage | null> {
    // CLI doesn't use webhooks
    return null;
  }

  // CLI-specific: Process user input from stdin
  processInput(input: string): InboundPlatformMessage {
    const inbound: InboundPlatformMessage = {
      id: `in:${uuidv4()}`,
      platformMessageId: uuidv4(),
      platformChatId: 'cli-session',
      platform: 'cli',
      content: input.trim(),
      authorId: 'cli-user',
      timestamp: new Date().toISOString()
    };

    this.emit('message:received', inbound);
    return inbound;
  }
}

// =============================================================================
// Telegram Adapter (Stub - would need bot token)
// =============================================================================

export class TelegramAdapter extends ChannelAdapter {
  private botToken?: string;
  private webhookUrl?: string;
  private connections: Map<string, BridgeConnection> = new Map();

  constructor() {
    super(PLATFORMS.telegram, {
      requestsPerSecond: 30,
      requestsPerMinute: 20 * 60 // 20 per second sustained
    });
  }

  async connect(credentials: Record<string, string>): Promise<BridgeConnection> {
    if (!credentials.botToken) {
      throw new Error('Telegram bot token required');
    }

    this.botToken = credentials.botToken;
    this.webhookUrl = credentials.webhookUrl;

    const connection: BridgeConnection = {
      id: `conn:telegram:${uuidv4()}`,
      brokerId: credentials.brokerId,
      bridgeId: this.bridgeId,
      channelId: credentials.channelId,
      status: 'active',
      accessToken: credentials.botToken,
      createdAt: new Date().toISOString()
    };

    this.connections.set(connection.id, connection);

    // In real implementation: register webhook with Telegram API
    // await this.registerWebhook();

    this.emit('connected', connection);
    return connection;
  }

  async disconnect(connectionId: string): Promise<void> {
    const connection = this.connections.get(connectionId);
    if (connection) {
      connection.status = 'inactive';
      this.connections.delete(connectionId);
      // In real implementation: unregister webhook
      this.emit('disconnected', connection);
    }
  }

  async sendMessage(connection: BridgeConnection, message: OutboundPlatformMessage): Promise<string> {
    if (!await this.checkRateLimit()) {
      throw new Error('Rate limit exceeded');
    }

    // In real implementation: call Telegram sendMessage API
    // const response = await fetch(`https://api.telegram.org/bot${this.botToken}/sendMessage`, {
    //   method: 'POST',
    //   headers: { 'Content-Type': 'application/json' },
    //   body: JSON.stringify({
    //     chat_id: message.platformChatId,
    //     text: message.content,
    //     reply_to_message_id: message.replyToId
    //   })
    // });

    const platformMessageId = `tg:${Date.now()}`;
    message.platformMessageId = platformMessageId;
    message.deliveryStatus = 'sent';

    this.emit('message:sent', { connection, message });
    return platformMessageId;
  }

  async handleWebhook(payload: unknown): Promise<InboundPlatformMessage | null> {
    // Telegram webhook format
    const update = payload as {
      message?: {
        message_id: number;
        chat: { id: number; type: string };
        from?: { id: number; username?: string; first_name?: string };
        text?: string;
        date: number;
        reply_to_message?: { message_id: number };
      };
    };

    if (!update.message?.text) {
      return null;
    }

    const msg = update.message;
    const inbound: InboundPlatformMessage = {
      id: `in:${uuidv4()}`,
      platformMessageId: String(msg.message_id),
      platformChatId: String(msg.chat.id),
      platform: 'telegram',
      content: msg.text!, // We already checked msg.text exists above
      authorId: msg.from ? String(msg.from.id) : undefined,
      authorName: msg.from?.first_name ?? msg.from?.username,
      timestamp: new Date(msg.date * 1000).toISOString(),
      replyToId: msg.reply_to_message ? String(msg.reply_to_message.message_id) : undefined,
      rawPayload: JSON.stringify(payload)
    };

    this.emit('message:received', inbound);
    return inbound;
  }
}

// =============================================================================
// Channel Bridge Registry
// =============================================================================

export class ChannelBridgeRegistry {
  private adapters: Map<string, ChannelAdapter> = new Map();

  registerAdapter(adapter: ChannelAdapter): void {
    this.adapters.set(adapter.platform.id, adapter);
  }

  getAdapter(platformId: string): ChannelAdapter | undefined {
    return this.adapters.get(platformId);
  }

  listAdapters(): ChannelAdapter[] {
    return Array.from(this.adapters.values());
  }

  listPlatforms(): PlatformDefinition[] {
    return Array.from(this.adapters.values()).map(a => a.platform);
  }

  // Create default adapters
  static createDefault(): ChannelBridgeRegistry {
    const registry = new ChannelBridgeRegistry();

    registry.registerAdapter(new WebChatAdapter());
    registry.registerAdapter(new CLIAdapter());
    registry.registerAdapter(new TelegramAdapter());

    return registry;
  }
}

// =============================================================================
// Channel Bridge Service
// =============================================================================

export class ChannelBridgeService {
  private registry: ChannelBridgeRegistry;
  private connections: Map<string, { adapter: ChannelAdapter; connection: BridgeConnection }> = new Map();
  private brokerChannels: Map<string, string[]> = new Map(); // brokerId -> connectionIds

  constructor(registry?: ChannelBridgeRegistry) {
    this.registry = registry ?? ChannelBridgeRegistry.createDefault();
  }

  async connectChannel(
    broker: PersonalBroker,
    platformId: string,
    credentials: Record<string, string>
  ): Promise<BridgeConnection> {
    const adapter = this.registry.getAdapter(platformId);
    if (!adapter) {
      throw new Error(`Unknown platform: ${platformId}`);
    }

    // Add broker info to credentials
    const channel = broker.addChannel({
      type: adapter.platform.channelType,
      name: adapter.platform.name,
      status: 'disconnected'
    });

    const fullCredentials = {
      ...credentials,
      brokerId: broker.id,
      channelId: channel.id
    };

    const connection = await adapter.connect(fullCredentials);

    // Update channel status
    broker.updateChannelStatus(channel.id, 'connected');

    // Store connection
    this.connections.set(connection.id, { adapter, connection });

    // Track broker's channels
    const brokerChannelList = this.brokerChannels.get(broker.id) ?? [];
    brokerChannelList.push(connection.id);
    this.brokerChannels.set(broker.id, brokerChannelList);

    // Wire up event handlers
    adapter.on('message:received', async (inbound: InboundPlatformMessage) => {
      await this.handleInboundMessage(broker, connection, adapter, inbound);
    });

    return connection;
  }

  async disconnectChannel(connectionId: string): Promise<void> {
    const entry = this.connections.get(connectionId);
    if (entry) {
      await entry.adapter.disconnect(connectionId);
      this.connections.delete(connectionId);
    }
  }

  async sendMessage(
    connectionId: string,
    message: Message,
    platformChatId: string
  ): Promise<string> {
    const entry = this.connections.get(connectionId);
    if (!entry) {
      throw new Error(`Connection not found: ${connectionId}`);
    }

    const outbound = entry.adapter.transformOutbound(message, platformChatId);
    return entry.adapter.sendMessage(entry.connection, outbound);
  }

  private async handleInboundMessage(
    broker: PersonalBroker,
    connection: BridgeConnection,
    adapter: ChannelAdapter,
    inbound: InboundPlatformMessage
  ): Promise<void> {
    // Transform to ACG message format
    const acgMessagePartial = adapter.transformInbound(inbound);

    // Find or create conversation for this chat
    let conversation = broker.listConversations({ channelId: connection.channelId })
      .find(c => c.status === 'active');

    if (!conversation) {
      conversation = broker.startConversation({
        channelId: connection.channelId,
        title: `${adapter.platform.name} Chat`
      });
    }

    // Add message to conversation
    await broker.sendMessage(conversation.id, acgMessagePartial.content ?? '', {
      role: acgMessagePartial.role,
      metadata: acgMessagePartial.metadata
    });
  }

  getConnection(connectionId: string): BridgeConnection | undefined {
    return this.connections.get(connectionId)?.connection;
  }

  getBrokerConnections(brokerId: string): BridgeConnection[] {
    const connectionIds = this.brokerChannels.get(brokerId) ?? [];
    return connectionIds
      .map(id => this.connections.get(id)?.connection)
      .filter((c): c is BridgeConnection => c !== undefined);
  }

  listPlatforms(): PlatformDefinition[] {
    return this.registry.listPlatforms();
  }
}
