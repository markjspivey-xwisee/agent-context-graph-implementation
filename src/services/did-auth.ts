/**
 * DID/VC Authentication Service
 *
 * Implements decentralized authentication using:
 * - Decentralized Identifiers (DIDs) for identity
 * - Verifiable Credentials (VCs) for capabilities and permissions
 * - DID-based challenge-response authentication
 *
 * Specs:
 * - DIDs: https://www.w3.org/TR/did-core/
 * - VCs: https://www.w3.org/TR/vc-data-model/
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

export type DIDMethod = 'key' | 'web' | 'peer' | 'ion' | 'ethr';

export interface DIDDocument {
  '@context': string[];
  id: string;
  controller?: string | string[];
  verificationMethod?: VerificationMethod[];
  authentication?: (string | VerificationMethod)[];
  assertionMethod?: (string | VerificationMethod)[];
  keyAgreement?: (string | VerificationMethod)[];
  capabilityInvocation?: (string | VerificationMethod)[];
  capabilityDelegation?: (string | VerificationMethod)[];
  service?: ServiceEndpoint[];
}

export interface VerificationMethod {
  id: string;
  type: string;
  controller: string;
  publicKeyJwk?: JWK;
  publicKeyMultibase?: string;
  publicKeyBase58?: string;
}

export interface ServiceEndpoint {
  id: string;
  type: string;
  serviceEndpoint: string | string[] | Record<string, unknown>;
}

export interface VerifiableCredential {
  '@context': string[];
  id?: string;
  type: string[];
  issuer: string | { id: string; [key: string]: unknown };
  issuanceDate: string;
  expirationDate?: string;
  credentialSubject: {
    id?: string;
    [key: string]: unknown;
  };
  proof?: CredentialProof;
}

export interface CredentialProof {
  type: string;
  created: string;
  verificationMethod: string;
  proofPurpose: string;
  proofValue: string;
  challenge?: string;
  domain?: string;
}

export interface VerifiablePresentation {
  '@context': string[];
  id?: string;
  type: string[];
  holder?: string;
  verifiableCredential: VerifiableCredential[];
  proof?: CredentialProof;
}

export interface AuthChallenge {
  id: string;
  challenge: string;
  domain: string;
  issuedAt: Date;
  expiresAt: Date;
  did?: string;
}

export interface AuthSession {
  id: string;
  did: string;
  authenticatedAt: Date;
  expiresAt: Date;
  credentials: VerifiableCredential[];
  capabilities: string[];
}

export type ACGCapability =
  | 'PlannerCapability'
  | 'ExecutorCapability'
  | 'ObserverCapability'
  | 'ArbiterCapability'
  | 'ArchivistCapability'
  | 'AdminCapability'
  | 'ReadOnlyCapability'
  | 'WriteCapability'
  | 'FederationCapability';

export interface AuthConfig {
  domain: string;
  challengeExpirySeconds?: number;
  sessionExpiryHours?: number;
  trustedIssuers?: string[];
}

// =============================================================================
// DID Authentication Service
// =============================================================================

export class DIDAuthService extends EventEmitter {
  private config: AuthConfig;
  private challenges: Map<string, AuthChallenge> = new Map();
  private sessions: Map<string, AuthSession> = new Map();
  private didDocuments: Map<string, DIDDocument> = new Map();
  private revokedCredentials: Set<string> = new Set();

  constructor(config: AuthConfig) {
    super();
    this.config = {
      challengeExpirySeconds: 300, // 5 minutes
      sessionExpiryHours: 24,
      trustedIssuers: [],
      ...config
    };

    // Cleanup expired challenges/sessions periodically
    setInterval(() => this.cleanup(), 60000);
  }

  // ==========================================================================
  // DID Resolution
  // ==========================================================================

  async resolveDID(did: string): Promise<DIDDocument | null> {
    // Check cache first
    const cached = this.didDocuments.get(did);
    if (cached) return cached;

    // Parse DID method
    const [, method] = did.split(':');

    switch (method) {
      case 'key':
        return this.resolveKeyDID(did);
      case 'web':
        return this.resolveWebDID(did);
      default:
        // For other methods, try universal resolver
        return this.resolveUniversal(did);
    }
  }

  private resolveKeyDID(did: string): DIDDocument | null {
    // did:key DIDs encode the public key in the identifier
    // Format: did:key:<multibase-encoded-public-key>
    const [, , multibaseKey] = did.split(':');

    if (!multibaseKey) return null;

    // Simplified - in production would decode multibase and determine key type
    const keyId = `${did}#${multibaseKey.slice(0, 8)}`;

    const doc: DIDDocument = {
      '@context': [
        'https://www.w3.org/ns/did/v1',
        'https://w3id.org/security/suites/ed25519-2020/v1'
      ],
      id: did,
      verificationMethod: [
        {
          id: keyId,
          type: 'Ed25519VerificationKey2020',
          controller: did,
          publicKeyMultibase: multibaseKey
        }
      ],
      authentication: [keyId],
      assertionMethod: [keyId],
      capabilityInvocation: [keyId],
      capabilityDelegation: [keyId]
    };

    this.didDocuments.set(did, doc);
    return doc;
  }

  private async resolveWebDID(did: string): Promise<DIDDocument | null> {
    // did:web resolves to a DID document at a web URL
    // Format: did:web:example.com or did:web:example.com:path:to:doc
    const [, , ...parts] = did.split(':');
    const domain = parts[0];
    const path = parts.slice(1).join('/');

    const url = path
      ? `https://${domain}/${path}/did.json`
      : `https://${domain}/.well-known/did.json`;

    try {
      const response = await fetch(url, {
        headers: { 'Accept': 'application/did+json, application/json' }
      });

      if (!response.ok) return null;

      const doc = await response.json() as DIDDocument;
      this.didDocuments.set(did, doc);
      return doc;
    } catch {
      return null;
    }
  }

  private async resolveUniversal(did: string): Promise<DIDDocument | null> {
    // Use universal resolver
    const url = `https://dev.uniresolver.io/1.0/identifiers/${encodeURIComponent(did)}`;

    try {
      const response = await fetch(url);
      if (!response.ok) return null;

      const result = await response.json() as { didDocument: DIDDocument };
      const doc = result.didDocument;
      this.didDocuments.set(did, doc);
      return doc;
    } catch {
      return null;
    }
  }

  registerDIDDocument(did: string, document: DIDDocument): void {
    this.didDocuments.set(did, document);
  }

  // ==========================================================================
  // Challenge-Response Authentication
  // ==========================================================================

  createChallenge(did?: string): AuthChallenge {
    const challenge: AuthChallenge = {
      id: uuidv4(),
      challenge: crypto.randomBytes(32).toString('base64url'),
      domain: this.config.domain,
      issuedAt: new Date(),
      expiresAt: new Date(Date.now() + (this.config.challengeExpirySeconds! * 1000)),
      did
    };

    this.challenges.set(challenge.id, challenge);
    return challenge;
  }

  async verifyChallenge(challengeId: string, did: string, signature: string): Promise<AuthSession | null> {
    const challenge = this.challenges.get(challengeId);

    if (!challenge) {
      this.emit('auth:failed', { reason: 'challenge_not_found', did });
      return null;
    }

    if (new Date() > challenge.expiresAt) {
      this.challenges.delete(challengeId);
      this.emit('auth:failed', { reason: 'challenge_expired', did });
      return null;
    }

    if (challenge.did && challenge.did !== did) {
      this.emit('auth:failed', { reason: 'did_mismatch', did });
      return null;
    }

    // Resolve DID document
    const didDoc = await this.resolveDID(did);
    if (!didDoc) {
      this.emit('auth:failed', { reason: 'did_resolution_failed', did });
      return null;
    }

    // Find authentication key
    const authKey = this.findVerificationMethod(didDoc, 'authentication');
    if (!authKey) {
      this.emit('auth:failed', { reason: 'no_auth_key', did });
      return null;
    }

    // Verify signature
    const signatureData = `${challenge.challenge}:${challenge.domain}:${challenge.issuedAt.toISOString()}`;
    const valid = await this.verifySignature(signatureData, signature, authKey);

    if (!valid) {
      this.emit('auth:failed', { reason: 'invalid_signature', did });
      return null;
    }

    // Clean up challenge
    this.challenges.delete(challengeId);

    // Create session
    const session = this.createSession(did);
    this.emit('auth:success', { did, sessionId: session.id });

    return session;
  }

  private findVerificationMethod(
    didDoc: DIDDocument,
    purpose: 'authentication' | 'assertionMethod' | 'keyAgreement' | 'capabilityInvocation'
  ): VerificationMethod | null {
    const methodRefs = didDoc[purpose];
    if (!methodRefs || methodRefs.length === 0) return null;

    const ref = methodRefs[0];
    if (typeof ref === 'string') {
      // Reference to a verification method
      return didDoc.verificationMethod?.find(vm => vm.id === ref) || null;
    }

    return ref;
  }

  private async verifySignature(data: string, signature: string, method: VerificationMethod): Promise<boolean> {
    try {
      if (method.publicKeyJwk) {
        const publicKey = crypto.createPublicKey({
          key: method.publicKeyJwk,
          format: 'jwk'
        });

        const signatureBuffer = Buffer.from(signature, 'base64url');

        // Determine algorithm from key type
        const alg = method.type.includes('Ed25519') ? null : 'RSA-SHA256';

        return crypto.verify(alg, Buffer.from(data), publicKey, signatureBuffer);
      }

      // Handle other key formats (multibase, base58)
      // Simplified for demo - would need proper multibase/multicodec handling
      return false;
    } catch {
      return false;
    }
  }

  // ==========================================================================
  // Session Management
  // ==========================================================================

  private createSession(did: string): AuthSession {
    const session: AuthSession = {
      id: uuidv4(),
      did,
      authenticatedAt: new Date(),
      expiresAt: new Date(Date.now() + (this.config.sessionExpiryHours! * 60 * 60 * 1000)),
      credentials: [],
      capabilities: []
    };

    this.sessions.set(session.id, session);
    return session;
  }

  getSession(sessionId: string): AuthSession | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    if (new Date() > session.expiresAt) {
      this.sessions.delete(sessionId);
      return null;
    }

    return session;
  }

  invalidateSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.emit('session:invalidated', { sessionId });
  }

  // ==========================================================================
  // Verifiable Credentials
  // ==========================================================================

  async issueCredential(
    subjectDID: string,
    issuerDID: string,
    credentialType: string,
    claims: Record<string, unknown>,
    options: {
      expirationDate?: Date;
      privateKey?: JWK;
    } = {}
  ): Promise<VerifiableCredential> {
    const credential: VerifiableCredential = {
      '@context': [
        'https://www.w3.org/2018/credentials/v1',
        'https://acg.example/credentials/v1'
      ],
      id: `urn:uuid:${uuidv4()}`,
      type: ['VerifiableCredential', credentialType],
      issuer: issuerDID,
      issuanceDate: new Date().toISOString(),
      credentialSubject: {
        id: subjectDID,
        ...claims
      }
    };

    if (options.expirationDate) {
      credential.expirationDate = options.expirationDate.toISOString();
    }

    // Sign the credential if private key provided
    if (options.privateKey) {
      credential.proof = await this.createProof(credential, issuerDID, options.privateKey);
    }

    this.emit('credential:issued', { credentialId: credential.id, subjectDID, issuerDID });
    return credential;
  }

  issueACGCapabilityCredential(
    subjectDID: string,
    issuerDID: string,
    capability: ACGCapability,
    options: {
      expirationDate?: Date;
      constraints?: Record<string, unknown>;
      privateKey?: JWK;
    } = {}
  ): Promise<VerifiableCredential> {
    return this.issueCredential(
      subjectDID,
      issuerDID,
      'ACGCapabilityCredential',
      {
        capability,
        constraints: options.constraints || {}
      },
      options
    );
  }

  private async createProof(
    credential: VerifiableCredential,
    issuerDID: string,
    privateKey: JWK
  ): Promise<CredentialProof> {
    const created = new Date().toISOString();

    // Create canonical form for signing
    const dataToSign = JSON.stringify({
      ...credential,
      proof: undefined
    });

    // Sign
    const key = crypto.createPrivateKey({ key: privateKey, format: 'jwk' });
    const signature = crypto.sign(null, Buffer.from(dataToSign), key);

    return {
      type: 'Ed25519Signature2020',
      created,
      verificationMethod: `${issuerDID}#key-1`,
      proofPurpose: 'assertionMethod',
      proofValue: signature.toString('base64url')
    };
  }

  async verifyCredential(credential: VerifiableCredential): Promise<{
    valid: boolean;
    errors: string[];
  }> {
    const errors: string[] = [];

    // Check required fields
    if (!credential['@context'] || !credential.type || !credential.issuer || !credential.issuanceDate) {
      errors.push('Missing required fields');
    }

    // Check expiration
    if (credential.expirationDate && new Date(credential.expirationDate) < new Date()) {
      errors.push('Credential expired');
    }

    // Check revocation
    if (credential.id && this.revokedCredentials.has(credential.id)) {
      errors.push('Credential revoked');
    }

    // Check trusted issuer
    const issuerId = typeof credential.issuer === 'string' ? credential.issuer : credential.issuer.id;
    if (this.config.trustedIssuers && this.config.trustedIssuers.length > 0) {
      if (!this.config.trustedIssuers.includes(issuerId)) {
        errors.push('Issuer not trusted');
      }
    }

    // Verify proof if present
    if (credential.proof) {
      const proofValid = await this.verifyCredentialProof(credential);
      if (!proofValid) {
        errors.push('Invalid proof');
      }
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  private async verifyCredentialProof(credential: VerifiableCredential): Promise<boolean> {
    if (!credential.proof) return false;

    try {
      // Get issuer's DID document
      const issuerId = typeof credential.issuer === 'string' ? credential.issuer : credential.issuer.id;
      const didDoc = await this.resolveDID(issuerId);
      if (!didDoc) return false;

      // Find the verification method
      const vmId = credential.proof.verificationMethod;
      const vm = didDoc.verificationMethod?.find(m => m.id === vmId);
      if (!vm?.publicKeyJwk) return false;

      // Verify signature
      const dataToVerify = JSON.stringify({
        ...credential,
        proof: undefined
      });

      const publicKey = crypto.createPublicKey({ key: vm.publicKeyJwk, format: 'jwk' });
      const signatureBuffer = Buffer.from(credential.proof.proofValue, 'base64url');

      return crypto.verify(null, Buffer.from(dataToVerify), publicKey, signatureBuffer);
    } catch {
      return false;
    }
  }

  revokeCredential(credentialId: string): void {
    this.revokedCredentials.add(credentialId);
    this.emit('credential:revoked', { credentialId });
  }

  // ==========================================================================
  // Verifiable Presentations
  // ==========================================================================

  async createPresentation(
    credentials: VerifiableCredential[],
    holderDID: string,
    options: {
      challenge?: string;
      domain?: string;
      privateKey?: JWK;
    } = {}
  ): Promise<VerifiablePresentation> {
    const presentation: VerifiablePresentation = {
      '@context': ['https://www.w3.org/2018/credentials/v1'],
      id: `urn:uuid:${uuidv4()}`,
      type: ['VerifiablePresentation'],
      holder: holderDID,
      verifiableCredential: credentials
    };

    if (options.privateKey) {
      const created = new Date().toISOString();

      const dataToSign = JSON.stringify({
        ...presentation,
        proof: undefined
      });

      const key = crypto.createPrivateKey({ key: options.privateKey, format: 'jwk' });
      const signature = crypto.sign(null, Buffer.from(dataToSign), key);

      presentation.proof = {
        type: 'Ed25519Signature2020',
        created,
        verificationMethod: `${holderDID}#key-1`,
        proofPurpose: 'authentication',
        proofValue: signature.toString('base64url'),
        challenge: options.challenge,
        domain: options.domain
      };
    }

    return presentation;
  }

  async verifyPresentation(presentation: VerifiablePresentation, options: {
    challenge?: string;
    domain?: string;
  } = {}): Promise<{
    valid: boolean;
    credentialResults: Array<{ valid: boolean; errors: string[] }>;
    errors: string[];
  }> {
    const errors: string[] = [];

    // Verify each credential
    const credentialResults = await Promise.all(
      presentation.verifiableCredential.map(vc => this.verifyCredential(vc))
    );

    // Check challenge/domain if required
    if (options.challenge && presentation.proof?.challenge !== options.challenge) {
      errors.push('Challenge mismatch');
    }

    if (options.domain && presentation.proof?.domain !== options.domain) {
      errors.push('Domain mismatch');
    }

    // Verify presentation proof
    if (presentation.proof && presentation.holder) {
      const holderDoc = await this.resolveDID(presentation.holder);
      if (!holderDoc) {
        errors.push('Holder DID resolution failed');
      } else {
        // Verify holder's signature
        const vmId = presentation.proof.verificationMethod;
        const vm = holderDoc.verificationMethod?.find(m => m.id === vmId);

        if (!vm?.publicKeyJwk) {
          errors.push('Holder verification method not found');
        } else {
          const dataToVerify = JSON.stringify({
            ...presentation,
            proof: undefined
          });

          try {
            const publicKey = crypto.createPublicKey({ key: vm.publicKeyJwk, format: 'jwk' });
            const signatureBuffer = Buffer.from(presentation.proof.proofValue, 'base64url');
            const valid = crypto.verify(null, Buffer.from(dataToVerify), publicKey, signatureBuffer);

            if (!valid) {
              errors.push('Invalid presentation signature');
            }
          } catch {
            errors.push('Signature verification failed');
          }
        }
      }
    }

    const allCredentialsValid = credentialResults.every(r => r.valid);

    return {
      valid: errors.length === 0 && allCredentialsValid,
      credentialResults,
      errors
    };
  }

  // ==========================================================================
  // Authorization
  // ==========================================================================

  async addCredentialToSession(sessionId: string, credential: VerifiableCredential): Promise<boolean> {
    const session = this.getSession(sessionId);
    if (!session) return false;

    // Verify credential
    const { valid } = await this.verifyCredential(credential);
    if (!valid) return false;

    // Check subject matches session DID
    const subjectId = credential.credentialSubject.id;
    if (subjectId && subjectId !== session.did) return false;

    session.credentials.push(credential);

    // Extract capabilities
    if (credential.type.includes('ACGCapabilityCredential')) {
      const capability = credential.credentialSubject.capability as string;
      if (capability && !session.capabilities.includes(capability)) {
        session.capabilities.push(capability);
      }
    }

    return true;
  }

  hasCapability(sessionId: string, capability: ACGCapability): boolean {
    const session = this.getSession(sessionId);
    if (!session) return false;

    return session.capabilities.includes(capability) ||
           session.capabilities.includes('AdminCapability');
  }

  getSessionCapabilities(sessionId: string): string[] {
    const session = this.getSession(sessionId);
    return session?.capabilities || [];
  }

  // ==========================================================================
  // Cleanup
  // ==========================================================================

  private cleanup(): void {
    const now = new Date();

    // Cleanup expired challenges
    for (const [id, challenge] of this.challenges) {
      if (now > challenge.expiresAt) {
        this.challenges.delete(id);
      }
    }

    // Cleanup expired sessions
    for (const [id, session] of this.sessions) {
      if (now > session.expiresAt) {
        this.sessions.delete(id);
      }
    }
  }

  // ==========================================================================
  // Stats
  // ==========================================================================

  getStats(): {
    activeSessions: number;
    pendingChallenges: number;
    cachedDIDs: number;
    revokedCredentials: number;
  } {
    return {
      activeSessions: this.sessions.size,
      pendingChallenges: this.challenges.size,
      cachedDIDs: this.didDocuments.size,
      revokedCredentials: this.revokedCredentials.size
    };
  }
}
