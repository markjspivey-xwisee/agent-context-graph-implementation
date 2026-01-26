import * as crypto from 'crypto';
import type { ContextGraph, Affordance, BrokerRef, FederationInfo, CredentialBridge } from '../interfaces/index.js';

/**
 * Trust levels for federated brokers
 */
export type TrustLevel = 'FullTrust' | 'LimitedTrust' | 'VerifyAlways';

/**
 * DIDComm v2 Message structure
 * https://identity.foundation/didcomm-messaging/spec/v2.0/
 */
export interface DIDCommMessage {
  id: string;
  type: string;
  from?: string;
  to?: string[];
  created_time?: number;
  expires_time?: number;
  body: Record<string, unknown>;
  attachments?: DIDCommAttachment[];
  return_route?: 'none' | 'all' | 'thread';
  thid?: string;  // Thread ID
  pthid?: string; // Parent thread ID
}

export interface DIDCommAttachment {
  id: string;
  description?: string;
  media_type?: string;
  data: {
    jws?: string;
    hash?: string;
    json?: Record<string, unknown>;
    base64?: string;
  };
}

/**
 * ActivityPub Activity structure
 * https://www.w3.org/TR/activitypub/
 */
export interface ActivityPubActivity {
  '@context': string | string[];
  id: string;
  type: string;
  actor: string;
  object?: unknown;
  target?: string;
  published?: string;
  to?: string[];
  cc?: string[];
}

/**
 * Protocol adapter interface
 */
export interface ProtocolAdapter {
  name: FederationProtocol;
  sendRequest(endpoint: string, payload: unknown, options?: RequestOptions): Promise<ProtocolResponse>;
  parseResponse(response: unknown): Promise<unknown>;
}

export interface RequestOptions {
  timeout?: number;
  retries?: number;
  headers?: Record<string, string>;
  auth?: {
    type: 'bearer' | 'didcomm' | 'none';
    token?: string;
    signingKey?: string;
  };
}

export interface ProtocolResponse {
  success: boolean;
  status?: number;
  data?: unknown;
  error?: string;
  headers?: Record<string, string>;
}

/**
 * Federation protocols supported
 */
export type FederationProtocol = 'ActivityPub' | 'DIDComm' | 'LDN' | 'HTTP';

/**
 * Trust relationship between brokers
 */
export interface TrustRelationship {
  id: string;
  partnerBrokerDID: string;
  trustLevel: TrustLevel;
  trustDomainDID?: string;
  protocols: FederationProtocol[];
  credentialBridges: CredentialBridge[];
  establishedAt: string;
  expiresAt?: string;
  status: 'active' | 'suspended' | 'revoked';
  revokedAt?: string;
  revokedReason?: string;
}

/**
 * Parameters for establishing trust
 */
export interface EstablishTrustParams {
  partnerBrokerDID: string;
  trustLevel: TrustLevel;
  trustDomainDID?: string;
  credentialBridges?: Omit<CredentialBridge, 'type'>[];
  supportedProtocols?: FederationProtocol[];
  expiresAt?: string;
  mutualTrust?: boolean;
}

/**
 * Parameters for revoking trust
 */
export interface RevokeTrustParams {
  partnerBrokerDID: string;
  reason: string;
  revokeCredentialBridges?: boolean;
  notifyPartner?: boolean;
  archiveEvidence?: boolean;
}

/**
 * Parameters for federating context
 */
export interface FederateContextParams {
  targetBrokerDID: string;
  resourceURNs: string[];
  federationProtocol?: FederationProtocol;
  credentialBridgeId?: string;
  maxHops?: number;
  ttlSeconds?: number;
}

/**
 * Result of federation operations
 */
export interface FederationOperationResult {
  success: boolean;
  error?: string;
  trustRelationship?: TrustRelationship;
  federatedContext?: Partial<ContextGraph>;
  traceId?: string;
}

/**
 * Federation hop in a multi-hop path
 */
export interface FederationHop {
  brokerDID: string;
  hopNumber: number;
  protocol: FederationProtocol | 'origin';
  timestamp: string;
}

/**
 * HTTP Protocol Adapter - implements federation over HTTP/REST
 */
export class HTTPProtocolAdapter implements ProtocolAdapter {
  name: FederationProtocol = 'HTTP';

  async sendRequest(endpoint: string, payload: unknown, options?: RequestOptions): Promise<ProtocolResponse> {
    const timeout = options?.timeout ?? 30000;
    const retries = options?.retries ?? 3;
    const headers: Record<string, string> = {
      'Content-Type': 'application/ld+json',
      'Accept': 'application/ld+json, application/json',
      ...options?.headers
    };

    // Add auth header if provided
    if (options?.auth?.type === 'bearer' && options.auth.token) {
      headers['Authorization'] = `Bearer ${options.auth.token}`;
    }

    let lastError: Error | null = null;

    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeout);

        const response = await fetch(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
          signal: controller.signal
        });

        clearTimeout(timeoutId);

        const responseHeaders: Record<string, string> = {};
        response.headers.forEach((value, key) => {
          responseHeaders[key] = value;
        });

        if (!response.ok) {
          return {
            success: false,
            status: response.status,
            error: `HTTP ${response.status}: ${response.statusText}`,
            headers: responseHeaders
          };
        }

        const data = await response.json();
        return {
          success: true,
          status: response.status,
          data,
          headers: responseHeaders
        };

      } catch (error) {
        lastError = error as Error;
        // Exponential backoff
        if (attempt < retries - 1) {
          await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt) * 1000));
        }
      }
    }

    return {
      success: false,
      error: lastError?.message ?? 'Request failed after retries'
    };
  }

  async parseResponse(response: unknown): Promise<unknown> {
    return response; // JSON responses are already parsed
  }
}

/**
 * DIDComm Protocol Adapter - implements federation over DIDComm v2
 */
export class DIDCommProtocolAdapter implements ProtocolAdapter {
  name: FederationProtocol = 'DIDComm';
  private senderDID: string;

  constructor(senderDID: string) {
    this.senderDID = senderDID;
  }

  /**
   * Create a DIDComm v2 message
   */
  createMessage(type: string, body: Record<string, unknown>, recipientDID?: string): DIDCommMessage {
    return {
      id: `urn:uuid:${crypto.randomUUID()}`,
      type: `https://agentcontextgraph.dev/protocols/federation/1.0/${type}`,
      from: this.senderDID,
      to: recipientDID ? [recipientDID] : undefined,
      created_time: Math.floor(Date.now() / 1000),
      expires_time: Math.floor(Date.now() / 1000) + 3600, // 1 hour expiry
      body,
      return_route: 'all'
    };
  }

  async sendRequest(endpoint: string, payload: unknown, options?: RequestOptions): Promise<ProtocolResponse> {
    // Wrap payload in DIDComm message structure
    const message = this.createMessage(
      'federation-request',
      payload as Record<string, unknown>,
      options?.headers?.['X-Recipient-DID']
    );

    // In production, this would:
    // 1. Pack the message (encrypt + sign)
    // 2. Resolve the recipient's DID document
    // 3. Find the DIDComm service endpoint
    // 4. Send the packed message

    const headers: Record<string, string> = {
      'Content-Type': 'application/didcomm-plain+json',
      ...options?.headers
    };

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(message)
      });

      if (!response.ok) {
        return {
          success: false,
          status: response.status,
          error: `DIDComm request failed: ${response.statusText}`
        };
      }

      const responseMessage = await response.json() as DIDCommMessage;
      return {
        success: true,
        status: response.status,
        data: responseMessage.body
      };

    } catch (error) {
      return {
        success: false,
        error: (error as Error).message
      };
    }
  }

  async parseResponse(response: unknown): Promise<unknown> {
    if (typeof response === 'object' && response !== null && 'body' in response) {
      return (response as DIDCommMessage).body;
    }
    return response;
  }
}

/**
 * ActivityPub Protocol Adapter - implements federation over ActivityPub
 */
export class ActivityPubProtocolAdapter implements ProtocolAdapter {
  name: FederationProtocol = 'ActivityPub';
  private actorId: string;

  constructor(actorId: string) {
    this.actorId = actorId;
  }

  /**
   * Create an ActivityPub activity
   */
  createActivity(type: string, object: unknown, target?: string): ActivityPubActivity {
    return {
      '@context': [
        'https://www.w3.org/ns/activitystreams',
        'https://agentcontextgraph.dev/ns/federation'
      ],
      id: `${this.actorId}/activities/${crypto.randomUUID()}`,
      type,
      actor: this.actorId,
      object,
      target,
      published: new Date().toISOString(),
      to: target ? [target] : ['https://www.w3.org/ns/activitystreams#Public']
    };
  }

  async sendRequest(endpoint: string, payload: unknown, options?: RequestOptions): Promise<ProtocolResponse> {
    // Wrap payload in ActivityPub activity structure
    const activity = this.createActivity(
      'Create',
      {
        type: 'Note',
        content: payload
      },
      options?.headers?.['X-Target-Actor']
    );

    const headers: Record<string, string> = {
      'Content-Type': 'application/ld+json; profile="https://www.w3.org/ns/activitystreams"',
      'Accept': 'application/ld+json; profile="https://www.w3.org/ns/activitystreams"',
      ...options?.headers
    };

    // ActivityPub uses HTTP Signatures for auth
    // In production, would add Signature header here

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(activity)
      });

      if (!response.ok) {
        return {
          success: false,
          status: response.status,
          error: `ActivityPub request failed: ${response.statusText}`
        };
      }

      // ActivityPub may return 202 Accepted with no body
      if (response.status === 202) {
        return {
          success: true,
          status: response.status,
          data: { accepted: true }
        };
      }

      const data = await response.json();
      return {
        success: true,
        status: response.status,
        data
      };

    } catch (error) {
      return {
        success: false,
        error: (error as Error).message
      };
    }
  }

  async parseResponse(response: unknown): Promise<unknown> {
    if (typeof response === 'object' && response !== null && 'object' in response) {
      return (response as ActivityPubActivity).object;
    }
    return response;
  }
}

/**
 * Linked Data Notifications Protocol Adapter
 * https://www.w3.org/TR/ldn/
 */
export class LDNProtocolAdapter implements ProtocolAdapter {
  name: FederationProtocol = 'LDN';
  private senderUrl: string;

  constructor(senderUrl: string) {
    this.senderUrl = senderUrl;
  }

  async sendRequest(endpoint: string, payload: unknown, options?: RequestOptions): Promise<ProtocolResponse> {
    // LDN uses POST to an inbox with JSON-LD payload
    const notification = {
      '@context': 'https://www.w3.org/ns/activitystreams',
      '@id': `${this.senderUrl}/notifications/${crypto.randomUUID()}`,
      '@type': 'Announce',
      actor: this.senderUrl,
      object: payload
    };

    const headers: Record<string, string> = {
      'Content-Type': 'application/ld+json',
      ...options?.headers
    };

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(notification)
      });

      if (!response.ok) {
        return {
          success: false,
          status: response.status,
          error: `LDN request failed: ${response.statusText}`
        };
      }

      // LDN returns 201 Created with Location header
      return {
        success: true,
        status: response.status,
        data: {
          notificationUrl: response.headers.get('Location')
        }
      };

    } catch (error) {
      return {
        success: false,
        error: (error as Error).message
      };
    }
  }

  async parseResponse(response: unknown): Promise<unknown> {
    return response;
  }
}

/**
 * FederationService manages cross-broker trust and context federation
 * following the fed: ontology from federation.ttl
 */
export class FederationService {
  private trustRelationships: Map<string, TrustRelationship> = new Map();
  private brokerDID: string;
  private brokerEndpoint: string;
  private maxFederationHops: number = 5;
  private traceEmitter?: (trace: Record<string, unknown>) => void;

  // Known broker registry (would be dynamic in production)
  private knownBrokers: Map<string, BrokerRef> = new Map();

  // Protocol adapters
  private protocolAdapters: Map<FederationProtocol, ProtocolAdapter> = new Map();

  constructor(brokerDID: string, brokerEndpoint: string) {
    this.brokerDID = brokerDID;
    this.brokerEndpoint = brokerEndpoint;

    // Initialize protocol adapters
    this.protocolAdapters.set('HTTP', new HTTPProtocolAdapter());
    this.protocolAdapters.set('DIDComm', new DIDCommProtocolAdapter(brokerDID));
    this.protocolAdapters.set('ActivityPub', new ActivityPubProtocolAdapter(brokerEndpoint));
    this.protocolAdapters.set('LDN', new LDNProtocolAdapter(brokerEndpoint));
  }

  /**
   * Get protocol adapter for a specific protocol
   */
  getProtocolAdapter(protocol: FederationProtocol): ProtocolAdapter | undefined {
    return this.protocolAdapters.get(protocol);
  }

  /**
   * Send a federation request using the appropriate protocol
   */
  async sendFederationRequest(
    targetBrokerDID: string,
    requestType: string,
    payload: unknown,
    protocol: FederationProtocol = 'HTTP'
  ): Promise<ProtocolResponse> {
    const adapter = this.protocolAdapters.get(protocol);
    if (!adapter) {
      return {
        success: false,
        error: `Unknown protocol: ${protocol}`
      };
    }

    // Get target broker info
    const targetBroker = this.knownBrokers.get(targetBrokerDID);
    const endpoint = targetBroker?.serviceEndpoint ?? `https://${targetBrokerDID.replace('did:web:', '')}/acg/v1`;

    // Determine the specific endpoint path based on request type
    const endpointPath = this.getEndpointPath(requestType, protocol);
    const fullEndpoint = `${endpoint}${endpointPath}`;

    // Get trust relationship for auth context
    const trust = this.getTrustRelationship(targetBrokerDID);

    const options: RequestOptions = {
      timeout: 30000,
      retries: 3,
      headers: {
        'X-Federation-Protocol': protocol,
        'X-Source-Broker': this.brokerDID,
        'X-Recipient-DID': targetBrokerDID,
        'X-Trust-Level': trust?.trustLevel ?? 'VerifyAlways'
      },
      auth: trust?.trustLevel === 'FullTrust'
        ? { type: 'none' }
        : { type: 'bearer', token: this.generateFederationToken(targetBrokerDID) }
    };

    return adapter.sendRequest(fullEndpoint, payload, options);
  }

  /**
   * Get the endpoint path for a request type
   */
  private getEndpointPath(requestType: string, protocol: FederationProtocol): string {
    const paths: Record<string, Record<FederationProtocol, string>> = {
      'federation-context': {
        'HTTP': '/federation/context',
        'DIDComm': '/didcomm/inbox',
        'ActivityPub': '/inbox',
        'LDN': '/inbox'
      },
      'trust-request': {
        'HTTP': '/federation/trust',
        'DIDComm': '/didcomm/inbox',
        'ActivityPub': '/inbox',
        'LDN': '/inbox'
      },
      'resource-query': {
        'HTTP': '/federation/resources',
        'DIDComm': '/didcomm/inbox',
        'ActivityPub': '/outbox',
        'LDN': '/inbox'
      }
    };

    return paths[requestType]?.[protocol] ?? '/federation';
  }

  /**
   * Generate a short-lived federation token
   */
  private generateFederationToken(targetBrokerDID: string): string {
    // In production, this would be a proper JWT signed with broker's key
    const payload = {
      iss: this.brokerDID,
      sub: this.brokerDID,
      aud: targetBrokerDID,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 300, // 5 minutes
      jti: crypto.randomUUID()
    };

    // Stub: return base64-encoded payload (would be signed JWT in production)
    return Buffer.from(JSON.stringify(payload)).toString('base64');
  }

  /**
   * Set a trace emitter function for PROV trace generation
   */
  setTraceEmitter(emitter: (trace: Record<string, unknown>) => void): void {
    this.traceEmitter = emitter;
  }

  /**
   * Set maximum federation hops
   */
  setMaxFederationHops(max: number): void {
    this.maxFederationHops = Math.min(max, 10); // Cap at 10
  }

  /**
   * Register a known broker
   */
  registerBroker(broker: BrokerRef): void {
    this.knownBrokers.set(broker.brokerDID, broker);
  }

  /**
   * Establish trust with another broker
   */
  async establishTrust(params: EstablishTrustParams): Promise<FederationOperationResult> {
    const timestamp = new Date().toISOString();
    const traceId = `urn:trace:${crypto.randomUUID()}`;

    // Check if trust already exists
    const existingTrust = this.getTrustRelationship(params.partnerBrokerDID);
    if (existingTrust && existingTrust.status === 'active') {
      return {
        success: false,
        error: `Active trust relationship already exists with ${params.partnerBrokerDID}`
      };
    }

    // Build credential bridges
    const bridges: CredentialBridge[] = (params.credentialBridges ?? []).map(b => ({
      type: 'fed:CredentialBridge',
      id: `urn:bridge:${crypto.randomUUID().slice(0, 8)}`,
      fromDomain: b.fromDomain,
      toDomain: b.toDomain
    }));

    // Default bridges if none provided
    if (bridges.length === 0) {
      bridges.push({
        type: 'fed:CredentialBridge',
        id: `urn:bridge:${crypto.randomUUID().slice(0, 8)}`,
        fromDomain: this.brokerDID,
        toDomain: params.partnerBrokerDID
      });
    }

    const trustRelationship: TrustRelationship = {
      id: `urn:trust:${crypto.randomUUID()}`,
      partnerBrokerDID: params.partnerBrokerDID,
      trustLevel: params.trustLevel,
      trustDomainDID: params.trustDomainDID,
      protocols: params.supportedProtocols ?? ['HTTP', 'DIDComm'],
      credentialBridges: bridges,
      establishedAt: timestamp,
      expiresAt: params.expiresAt,
      status: 'active'
    };

    this.trustRelationships.set(params.partnerBrokerDID, trustRelationship);

    // Emit PROV trace
    if (this.traceEmitter) {
      this.traceEmitter({
        '@context': [
          'https://www.w3.org/ns/prov#',
          'https://agentcontextgraph.dev/federation#'
        ],
        id: traceId,
        type: ['prov:Activity', 'fed:EstablishTrustActivity'],
        'prov:startedAtTime': timestamp,
        'prov:endedAtTime': new Date().toISOString(),
        'prov:wasAssociatedWith': {
          type: 'fed:Broker',
          'fed:brokerDID': this.brokerDID
        },
        'prov:generated': {
          type: 'fed:TrustRelationship',
          id: trustRelationship.id,
          'fed:partnerBroker': params.partnerBrokerDID,
          'fed:trustLevel': params.trustLevel
        }
      });
    }

    // If mutual trust requested, would send request to partner (stub)
    if (params.mutualTrust) {
      // In production: send trust establishment request to partner broker
      console.log(`[Federation] Mutual trust requested with ${params.partnerBrokerDID}`);
    }

    return {
      success: true,
      trustRelationship,
      traceId
    };
  }

  /**
   * Revoke trust with a broker
   */
  async revokeTrust(params: RevokeTrustParams): Promise<FederationOperationResult> {
    const timestamp = new Date().toISOString();
    const traceId = `urn:trace:${crypto.randomUUID()}`;

    const trustRelationship = this.trustRelationships.get(params.partnerBrokerDID);
    if (!trustRelationship) {
      return {
        success: false,
        error: `No trust relationship found with ${params.partnerBrokerDID}`
      };
    }

    if (trustRelationship.status === 'revoked') {
      return {
        success: false,
        error: 'Trust relationship already revoked'
      };
    }

    // Update trust relationship
    trustRelationship.status = 'revoked';
    trustRelationship.revokedAt = timestamp;
    trustRelationship.revokedReason = params.reason;

    // Revoke credential bridges if requested
    if (params.revokeCredentialBridges) {
      trustRelationship.credentialBridges = [];
    }

    // Emit PROV trace
    if (this.traceEmitter) {
      this.traceEmitter({
        '@context': [
          'https://www.w3.org/ns/prov#',
          'https://agentcontextgraph.dev/federation#'
        ],
        id: traceId,
        type: ['prov:Activity', 'fed:RevokeTrustActivity'],
        'prov:startedAtTime': timestamp,
        'prov:endedAtTime': new Date().toISOString(),
        'prov:invalidated': {
          type: 'fed:TrustRelationship',
          id: trustRelationship.id,
          'fed:partnerBroker': params.partnerBrokerDID
        },
        'fed:revocationReason': params.reason,
        'fed:notifiedPartner': params.notifyPartner ?? false
      });
    }

    // Notify partner if requested (stub)
    if (params.notifyPartner) {
      console.log(`[Federation] Notifying ${params.partnerBrokerDID} of trust revocation`);
    }

    return {
      success: true,
      trustRelationship,
      traceId
    };
  }

  /**
   * Federate context from another broker
   */
  async federateContext(
    params: FederateContextParams,
    currentHop: number = 0,
    federationPath: FederationHop[] = []
  ): Promise<FederationOperationResult> {
    const timestamp = new Date().toISOString();
    const traceId = `urn:trace:${crypto.randomUUID()}`;

    // Check hop limit
    if (currentHop >= (params.maxHops ?? this.maxFederationHops)) {
      return {
        success: false,
        error: `Maximum federation hops (${params.maxHops ?? this.maxFederationHops}) exceeded`
      };
    }

    // Check trust relationship
    const trustRelationship = this.getTrustRelationship(params.targetBrokerDID);
    if (!trustRelationship) {
      return {
        success: false,
        error: `No trust relationship with ${params.targetBrokerDID}`
      };
    }

    if (trustRelationship.status !== 'active') {
      return {
        success: false,
        error: `Trust relationship with ${params.targetBrokerDID} is ${trustRelationship.status}`
      };
    }

    // Check protocol support
    const protocol = params.federationProtocol ?? 'HTTP';
    if (!trustRelationship.protocols.includes(protocol)) {
      return {
        success: false,
        error: `Protocol ${protocol} not supported by trust relationship`
      };
    }

    // Check credential bridge if specified
    if (params.credentialBridgeId) {
      const bridge = trustRelationship.credentialBridges.find(b => b.id === params.credentialBridgeId);
      if (!bridge) {
        return {
          success: false,
          error: `Credential bridge ${params.credentialBridgeId} not found`
        };
      }
    }

    // Build federation path
    const newPath: FederationHop[] = [
      ...federationPath,
      {
        brokerDID: params.targetBrokerDID,
        hopNumber: currentHop + 1,
        protocol,
        timestamp
      }
    ];

    // In production: make actual HTTP/DIDComm/ActivityPub request to target broker
    // For now, return a stub federated context
    const remoteBroker = this.knownBrokers.get(params.targetBrokerDID) ?? {
      type: 'fed:BrokerRef',
      brokerDID: params.targetBrokerDID,
      status: 'Active' as const
    };

    // Build federated affordances for the requested resources
    const federatedAffordances: Affordance[] = params.resourceURNs.map((urn, i) => ({
      '@type': ['hydra:Operation', 'acg:Affordance'],
      id: `aff-federated-${crypto.randomUUID().slice(0, 8)}`,
      rel: 'observe-remote-resource',
      relVersion: '1.0.0',
      actionType: 'Observe',
      target: {
        type: 'Federated' as const,
        href: `${remoteBroker.serviceEndpoint ?? 'https://broker.example.com'}/resources/${encodeURIComponent(urn)}`,
        method: 'GET' as const,
        remoteBroker: {
          brokerDID: params.targetBrokerDID,
          serviceEndpoint: remoteBroker.serviceEndpoint
        },
        requiresCrossdomainAuth: trustRelationship.trustLevel !== 'FullTrust',
        federationProtocol: protocol
      },
      params: {
        shaclRef: 'https://agentcontextgraph.dev/shacl/params#ObserveParamsShape'
      },
      effects: [],
      enabled: true
    }));

    // Build federation info for context
    const federationInfo: FederationInfo = {
      type: 'fed:FederationInfo',
      originBroker: {
        type: 'fed:BrokerRef',
        brokerDID: this.brokerDID,
        serviceEndpoint: this.brokerEndpoint,
        status: 'Active'
      },
      trustDomain: trustRelationship.trustDomainDID,
      federatedBrokers: [remoteBroker],
      trustLevel: trustRelationship.trustLevel,
      maxFederationHops: params.maxHops ?? this.maxFederationHops,
      credentialBridges: trustRelationship.credentialBridges
    };

    // Emit PROV trace
    if (this.traceEmitter) {
      this.traceEmitter({
        '@context': [
          'https://www.w3.org/ns/prov#',
          'https://agentcontextgraph.dev/federation#'
        ],
        id: traceId,
        type: ['prov:Activity', 'fed:FederateContextActivity'],
        'prov:startedAtTime': timestamp,
        'prov:endedAtTime': new Date().toISOString(),
        'prov:used': {
          'fed:trustRelationship': trustRelationship.id,
          'fed:targetBroker': params.targetBrokerDID,
          'fed:resourceURNs': params.resourceURNs
        },
        'prov:generated': {
          type: 'fed:FederatedContext',
          'fed:federationPath': newPath,
          'fed:currentHop': currentHop + 1,
          'fed:affordanceCount': federatedAffordances.length
        }
      });
    }

    return {
      success: true,
      federatedContext: {
        federation: federationInfo,
        affordances: federatedAffordances
      },
      traceId
    };
  }

  /**
   * Get trust relationship with a broker
   */
  getTrustRelationship(partnerBrokerDID: string): TrustRelationship | undefined {
    return this.trustRelationships.get(partnerBrokerDID);
  }

  /**
   * Get all active trust relationships
   */
  getActiveTrustRelationships(): TrustRelationship[] {
    return Array.from(this.trustRelationships.values())
      .filter(t => t.status === 'active');
  }

  /**
   * Get all trust relationships (including revoked)
   */
  getAllTrustRelationships(): TrustRelationship[] {
    return Array.from(this.trustRelationships.values());
  }

  /**
   * Check if a credential can be bridged to a target domain
   */
  canBridgeCredential(credentialType: string, targetBrokerDID: string): boolean {
    const trust = this.getTrustRelationship(targetBrokerDID);
    if (!trust || trust.status !== 'active') {
      return false;
    }

    // Check if any bridge covers this credential's domain
    return trust.credentialBridges.some(bridge =>
      bridge.toDomain === targetBrokerDID || bridge.fromDomain === this.brokerDID
    );
  }

  /**
   * Get available credential bridges for a target broker
   */
  getCredentialBridges(targetBrokerDID: string): CredentialBridge[] {
    const trust = this.getTrustRelationship(targetBrokerDID);
    if (!trust || trust.status !== 'active') {
      return [];
    }
    return trust.credentialBridges;
  }

  /**
   * Clean up expired trust relationships
   */
  cleanupExpiredTrust(): number {
    const now = Date.now();
    let cleaned = 0;

    for (const trust of this.trustRelationships.values()) {
      if (trust.expiresAt && new Date(trust.expiresAt).getTime() < now) {
        trust.status = 'revoked';
        trust.revokedAt = new Date().toISOString();
        trust.revokedReason = 'Expired';
        cleaned++;
      }
    }

    return cleaned;
  }

  /**
   * Get broker info
   */
  getBrokerInfo(): BrokerRef {
    return {
      type: 'fed:BrokerRef',
      brokerDID: this.brokerDID,
      serviceEndpoint: this.brokerEndpoint,
      status: 'Active',
      supportedDIDMethods: ['did:key', 'did:web'],
      federationProtocols: ['ActivityPub', 'DIDComm', 'HTTP']
    };
  }
}
