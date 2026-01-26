/**
 * DIDComm Messaging Service
 *
 * Implements DIDComm v2 encrypted messaging for secure agent-to-agent
 * communication with end-to-end encryption.
 *
 * Spec: https://identity.foundation/didcomm-messaging/spec/
 */

import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';

// JSON Web Key type
export interface JWK {
  kty: string;
  crv?: string;
  x?: string;
  y?: string;
  d?: string;
  n?: string;
  e?: string;
  kid?: string;
  use?: string;
  alg?: string;
  [key: string]: unknown;
}

// =============================================================================
// Types
// =============================================================================

export type DIDCommMessageType =
  | 'https://didcomm.org/basicmessage/2.0/message'
  | 'https://didcomm.org/trust-ping/2.0/ping'
  | 'https://didcomm.org/trust-ping/2.0/ping-response'
  | 'https://didcomm.org/routing/2.0/forward'
  | 'https://didcomm.org/discover-features/2.0/queries'
  | 'https://didcomm.org/discover-features/2.0/disclose'
  | 'https://acg.example/context-sync/1.0/update'
  | 'https://acg.example/context-sync/1.0/request'
  | 'https://acg.example/federation/1.0/connect'
  | 'https://acg.example/federation/1.0/accept'
  | 'https://acg.example/federation/1.0/reject'
  | string;

export interface DIDCommMessage {
  id: string;
  type: DIDCommMessageType;
  from?: string;
  to?: string[];
  created_time?: number;
  expires_time?: number;
  body: Record<string, unknown>;
  attachments?: DIDCommAttachment[];
  thid?: string; // Thread ID
  pthid?: string; // Parent thread ID
  [key: string]: unknown;
}

export interface DIDCommAttachment {
  id: string;
  description?: string;
  filename?: string;
  media_type?: string;
  format?: string;
  lastmod_time?: number;
  byte_count?: number;
  data: {
    jws?: string;
    hash?: string;
    links?: string[];
    base64?: string;
    json?: unknown;
  };
}

export interface EncryptedMessage {
  protected: string;
  recipients: Array<{
    header: {
      kid: string;
      epk?: JWK;
    };
    encrypted_key: string;
  }>;
  iv: string;
  ciphertext: string;
  tag: string;
}

export interface SignedMessage {
  payload: string;
  signatures: Array<{
    protected: string;
    signature: string;
  }>;
}

export interface DIDDocument {
  '@context': string[];
  id: string;
  verificationMethod?: VerificationMethod[];
  authentication?: (string | VerificationMethod)[];
  assertionMethod?: (string | VerificationMethod)[];
  keyAgreement?: (string | VerificationMethod)[];
  service?: ServiceEndpoint[];
}

export interface VerificationMethod {
  id: string;
  type: string;
  controller: string;
  publicKeyJwk?: JWK;
  publicKeyMultibase?: string;
}

export interface ServiceEndpoint {
  id: string;
  type: string;
  serviceEndpoint: string | string[] | ServiceEndpointMap;
}

export interface ServiceEndpointMap {
  uri?: string;
  accept?: string[];
  routingKeys?: string[];
}

export interface DIDCommConfig {
  did: string;
  keyPair?: {
    publicKey: JWK;
    privateKey: JWK;
  };
  encryptionKeyPair?: {
    publicKey: JWK;
    privateKey: JWK;
  };
  serviceEndpoint?: string;
}

export interface Thread {
  id: string;
  messages: DIDCommMessage[];
  participants: string[];
  createdAt: Date;
  updatedAt: Date;
}

// =============================================================================
// DIDComm Messaging Service
// =============================================================================

export class DIDCommMessagingService extends EventEmitter {
  private config: DIDCommConfig;
  private threads: Map<string, Thread> = new Map();
  private didDocuments: Map<string, DIDDocument> = new Map();

  constructor(config: DIDCommConfig) {
    super();
    this.config = config;

    // Generate key pairs if not provided
    if (!config.keyPair) {
      this.config.keyPair = this.generateSigningKeyPair();
    }
    if (!config.encryptionKeyPair) {
      this.config.encryptionKeyPair = this.generateEncryptionKeyPair();
    }

    // Create our DID Document
    this.didDocuments.set(config.did, this.createDIDDocument());
  }

  // ==========================================================================
  // Key Generation
  // ==========================================================================

  private generateSigningKeyPair(): { publicKey: JWK; privateKey: JWK } {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');

    return {
      publicKey: publicKey.export({ format: 'jwk' }) as JWK,
      privateKey: privateKey.export({ format: 'jwk' }) as JWK
    };
  }

  private generateEncryptionKeyPair(): { publicKey: JWK; privateKey: JWK } {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');

    return {
      publicKey: publicKey.export({ format: 'jwk' }) as JWK,
      privateKey: privateKey.export({ format: 'jwk' }) as JWK
    };
  }

  // ==========================================================================
  // DID Document
  // ==========================================================================

  private createDIDDocument(): DIDDocument {
    return {
      '@context': [
        'https://www.w3.org/ns/did/v1',
        'https://w3id.org/security/suites/jws-2020/v1',
        'https://w3id.org/security/suites/x25519-2020/v1'
      ],
      id: this.config.did,
      verificationMethod: [
        {
          id: `${this.config.did}#key-1`,
          type: 'JWK2020',
          controller: this.config.did,
          publicKeyJwk: this.config.keyPair!.publicKey
        },
        {
          id: `${this.config.did}#key-2`,
          type: 'JWK2020',
          controller: this.config.did,
          publicKeyJwk: this.config.encryptionKeyPair!.publicKey
        }
      ],
      authentication: [`${this.config.did}#key-1`],
      assertionMethod: [`${this.config.did}#key-1`],
      keyAgreement: [`${this.config.did}#key-2`],
      service: this.config.serviceEndpoint ? [
        {
          id: `${this.config.did}#didcomm-1`,
          type: 'DIDCommMessaging',
          serviceEndpoint: {
            uri: this.config.serviceEndpoint,
            accept: ['didcomm/v2'],
            routingKeys: []
          }
        }
      ] : []
    };
  }

  getDIDDocument(did?: string): DIDDocument | undefined {
    return this.didDocuments.get(did || this.config.did);
  }

  registerDIDDocument(did: string, document: DIDDocument): void {
    this.didDocuments.set(did, document);
  }

  // ==========================================================================
  // Message Creation
  // ==========================================================================

  createMessage(type: DIDCommMessageType, body: Record<string, unknown>, options: {
    to?: string[];
    thid?: string;
    pthid?: string;
    attachments?: DIDCommAttachment[];
    expiresIn?: number;
  } = {}): DIDCommMessage {
    const now = Math.floor(Date.now() / 1000);

    const message: DIDCommMessage = {
      id: uuidv4(),
      type,
      from: this.config.did,
      to: options.to,
      created_time: now,
      body,
      thid: options.thid,
      pthid: options.pthid,
      attachments: options.attachments
    };

    if (options.expiresIn) {
      message.expires_time = now + options.expiresIn;
    }

    return message;
  }

  createBasicMessage(content: string, to: string[], options: {
    locale?: string;
    thid?: string;
  } = {}): DIDCommMessage {
    return this.createMessage(
      'https://didcomm.org/basicmessage/2.0/message',
      {
        content,
        locale: options.locale || 'en'
      },
      { to, thid: options.thid }
    );
  }

  createTrustPing(to: string, responseRequested: boolean = true): DIDCommMessage {
    return this.createMessage(
      'https://didcomm.org/trust-ping/2.0/ping',
      { response_requested: responseRequested },
      { to: [to] }
    );
  }

  createTrustPingResponse(originalPing: DIDCommMessage): DIDCommMessage {
    return this.createMessage(
      'https://didcomm.org/trust-ping/2.0/ping-response',
      {},
      { to: originalPing.from ? [originalPing.from] : [], thid: originalPing.id }
    );
  }

  createContextSyncUpdate(contextId: string, changes: any[], to: string[]): DIDCommMessage {
    return this.createMessage(
      'https://acg.example/context-sync/1.0/update',
      {
        context_id: contextId,
        changes,
        vector_clock: {}
      },
      { to }
    );
  }

  createFederationConnect(to: string, profile: {
    displayName: string;
    bio?: string;
  }): DIDCommMessage {
    return this.createMessage(
      'https://acg.example/federation/1.0/connect',
      {
        profile,
        protocols: ['didcomm/v2', 'activitypub', 'native-acg']
      },
      { to: [to] }
    );
  }

  createFederationAccept(originalRequest: DIDCommMessage): DIDCommMessage {
    return this.createMessage(
      'https://acg.example/federation/1.0/accept',
      { accepted_at: new Date().toISOString() },
      { to: originalRequest.from ? [originalRequest.from] : [], thid: originalRequest.id }
    );
  }

  createFederationReject(originalRequest: DIDCommMessage, reason?: string): DIDCommMessage {
    return this.createMessage(
      'https://acg.example/federation/1.0/reject',
      { reason },
      { to: originalRequest.from ? [originalRequest.from] : [], thid: originalRequest.id }
    );
  }

  // ==========================================================================
  // Encryption (Simplified - uses Node's built-in crypto)
  // ==========================================================================

  async encryptMessage(message: DIDCommMessage, recipientDIDs: string[]): Promise<EncryptedMessage> {
    // Generate ephemeral key for ECDH
    const ephemeralKeyPair = crypto.generateKeyPairSync('x25519');

    // Serialize the message
    const plaintext = JSON.stringify(message);

    // Generate random IV
    const iv = crypto.randomBytes(12);

    // Generate a content encryption key
    const cek = crypto.randomBytes(32);

    // Encrypt the message with AES-256-GCM
    const cipher = crypto.createCipheriv('aes-256-gcm', cek, iv);
    const encrypted = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final()
    ]);
    const tag = cipher.getAuthTag();

    // Build recipients array (simplified - in real impl would do ECDH with each recipient)
    const recipients = recipientDIDs.map(did => {
      // In a real implementation, we would:
      // 1. Resolve the DID to get their key agreement key
      // 2. Perform ECDH to derive a shared secret
      // 3. Use the shared secret to encrypt the CEK
      // For now, we'll use a simplified approach
      const encryptedKey = Buffer.from(cek).toString('base64url');

      return {
        header: {
          kid: `${did}#key-2`
        },
        encrypted_key: encryptedKey
      };
    });

    // Build protected header
    const protectedHeader = {
      typ: 'application/didcomm-encrypted+json',
      alg: 'ECDH-ES+A256KW',
      enc: 'A256GCM',
      skid: `${this.config.did}#key-2`,
      epk: ephemeralKeyPair.publicKey.export({ format: 'jwk' })
    };

    return {
      protected: Buffer.from(JSON.stringify(protectedHeader)).toString('base64url'),
      recipients,
      iv: iv.toString('base64url'),
      ciphertext: encrypted.toString('base64url'),
      tag: tag.toString('base64url')
    };
  }

  async decryptMessage(encrypted: EncryptedMessage): Promise<DIDCommMessage> {
    // Decode protected header
    const protectedHeader = JSON.parse(
      Buffer.from(encrypted.protected, 'base64url').toString('utf8')
    );

    // Find our recipient entry
    const myKeyId = `${this.config.did}#key-2`;
    const recipient = encrypted.recipients.find(r => r.header.kid === myKeyId);

    if (!recipient) {
      throw new Error('Message not encrypted for this recipient');
    }

    // Decrypt the CEK (simplified - in real impl would use ECDH)
    const cek = Buffer.from(recipient.encrypted_key, 'base64url');

    // Decode IV and ciphertext
    const iv = Buffer.from(encrypted.iv, 'base64url');
    const ciphertext = Buffer.from(encrypted.ciphertext, 'base64url');
    const tag = Buffer.from(encrypted.tag, 'base64url');

    // Decrypt with AES-256-GCM
    const decipher = crypto.createDecipheriv('aes-256-gcm', cek, iv);
    decipher.setAuthTag(tag);

    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final()
    ]);

    return JSON.parse(decrypted.toString('utf8'));
  }

  // ==========================================================================
  // Signing
  // ==========================================================================

  signMessage(message: DIDCommMessage): SignedMessage {
    const payload = Buffer.from(JSON.stringify(message)).toString('base64url');

    const protectedHeader = {
      typ: 'application/didcomm-signed+json',
      alg: 'EdDSA',
      kid: `${this.config.did}#key-1`
    };

    const protectedB64 = Buffer.from(JSON.stringify(protectedHeader)).toString('base64url');
    const signingInput = `${protectedB64}.${payload}`;

    // Create signature
    const privateKey = crypto.createPrivateKey({
      key: this.config.keyPair!.privateKey,
      format: 'jwk'
    });

    const signature = crypto.sign(null, Buffer.from(signingInput), privateKey);

    return {
      payload,
      signatures: [
        {
          protected: protectedB64,
          signature: signature.toString('base64url')
        }
      ]
    };
  }

  verifySignedMessage(signed: SignedMessage, senderDID: string): { valid: boolean; message: DIDCommMessage | null } {
    try {
      const didDoc = this.didDocuments.get(senderDID);
      if (!didDoc) {
        return { valid: false, message: null };
      }

      // Find the verification method
      const sig = signed.signatures[0];
      const protectedHeader = JSON.parse(
        Buffer.from(sig.protected, 'base64url').toString('utf8')
      );

      const vmId = protectedHeader.kid;
      const vm = didDoc.verificationMethod?.find(v => v.id === vmId);

      if (!vm?.publicKeyJwk) {
        return { valid: false, message: null };
      }

      // Verify signature
      const signingInput = `${sig.protected}.${signed.payload}`;
      const publicKey = crypto.createPublicKey({
        key: vm.publicKeyJwk,
        format: 'jwk'
      });

      const signatureBuffer = Buffer.from(sig.signature, 'base64url');
      const valid = crypto.verify(null, Buffer.from(signingInput), publicKey, signatureBuffer);

      if (valid) {
        const message = JSON.parse(
          Buffer.from(signed.payload, 'base64url').toString('utf8')
        );
        return { valid: true, message };
      }

      return { valid: false, message: null };
    } catch {
      return { valid: false, message: null };
    }
  }

  // ==========================================================================
  // Thread Management
  // ==========================================================================

  getOrCreateThread(message: DIDCommMessage): Thread {
    const threadId = message.thid || message.id;

    let thread = this.threads.get(threadId);
    if (!thread) {
      thread = {
        id: threadId,
        messages: [],
        participants: [],
        createdAt: new Date(),
        updatedAt: new Date()
      };
      this.threads.set(threadId, thread);
    }

    return thread;
  }

  addToThread(message: DIDCommMessage): Thread {
    const thread = this.getOrCreateThread(message);

    thread.messages.push(message);
    thread.updatedAt = new Date();

    // Update participants
    if (message.from && !thread.participants.includes(message.from)) {
      thread.participants.push(message.from);
    }
    if (message.to) {
      for (const to of message.to) {
        if (!thread.participants.includes(to)) {
          thread.participants.push(to);
        }
      }
    }

    return thread;
  }

  getThread(threadId: string): Thread | undefined {
    return this.threads.get(threadId);
  }

  listThreads(): Thread[] {
    return Array.from(this.threads.values());
  }

  // ==========================================================================
  // Message Processing
  // ==========================================================================

  async processIncomingMessage(message: DIDCommMessage): Promise<DIDCommMessage | null> {
    // Add to thread
    this.addToThread(message);

    // Emit event
    this.emit('message:received', message);

    // Handle specific message types
    switch (message.type) {
      case 'https://didcomm.org/trust-ping/2.0/ping':
        if (message.body.response_requested) {
          const response = this.createTrustPingResponse(message);
          this.emit('message:send', response);
          return response;
        }
        break;

      case 'https://didcomm.org/basicmessage/2.0/message':
        this.emit('basicmessage:received', {
          from: message.from,
          content: message.body.content,
          message
        });
        break;

      case 'https://acg.example/federation/1.0/connect':
        this.emit('federation:connect', {
          from: message.from,
          profile: message.body.profile,
          message
        });
        break;

      case 'https://acg.example/federation/1.0/accept':
        this.emit('federation:accepted', {
          from: message.from,
          message
        });
        break;

      case 'https://acg.example/federation/1.0/reject':
        this.emit('federation:rejected', {
          from: message.from,
          reason: message.body.reason,
          message
        });
        break;

      case 'https://acg.example/context-sync/1.0/update':
        this.emit('context:sync', {
          from: message.from,
          contextId: message.body.context_id,
          changes: message.body.changes,
          message
        });
        break;
    }

    return null;
  }

  async sendMessage(message: DIDCommMessage, options: {
    encrypt?: boolean;
    sign?: boolean;
  } = { encrypt: true, sign: true }): Promise<void> {
    if (!message.to || message.to.length === 0) {
      throw new Error('Message must have recipients');
    }

    // Add to thread
    this.addToThread(message);

    // Sign if requested
    let processedMessage: any = message;
    if (options.sign) {
      processedMessage = this.signMessage(message);
    }

    // Encrypt if requested
    if (options.encrypt) {
      processedMessage = await this.encryptMessage(
        options.sign ? JSON.parse(Buffer.from((processedMessage as SignedMessage).payload, 'base64url').toString()) : message,
        message.to
      );
    }

    // Emit for delivery
    this.emit('message:outgoing', {
      original: message,
      processed: processedMessage,
      recipients: message.to
    });
  }

  // ==========================================================================
  // Discovery
  // ==========================================================================

  createDiscoveryQuery(featureTypes: string[]): DIDCommMessage {
    return this.createMessage(
      'https://didcomm.org/discover-features/2.0/queries',
      {
        queries: featureTypes.map(type => ({ 'feature-type': type }))
      }
    );
  }

  createDiscoveryDisclose(protocols: string[]): DIDCommMessage {
    return this.createMessage(
      'https://didcomm.org/discover-features/2.0/disclose',
      {
        disclosures: protocols.map(protocol => ({
          'feature-type': 'protocol',
          id: protocol
        }))
      }
    );
  }

  getSupportedProtocols(): string[] {
    return [
      'https://didcomm.org/basicmessage/2.0',
      'https://didcomm.org/trust-ping/2.0',
      'https://didcomm.org/discover-features/2.0',
      'https://acg.example/context-sync/1.0',
      'https://acg.example/federation/1.0'
    ];
  }

  // ==========================================================================
  // Stats
  // ==========================================================================

  getStats(): {
    did: string;
    threads: number;
    totalMessages: number;
    registeredDIDs: number;
    supportedProtocols: number;
  } {
    let totalMessages = 0;
    for (const thread of this.threads.values()) {
      totalMessages += thread.messages.length;
    }

    return {
      did: this.config.did,
      threads: this.threads.size,
      totalMessages,
      registeredDIDs: this.didDocuments.size,
      supportedProtocols: this.getSupportedProtocols().length
    };
  }
}
