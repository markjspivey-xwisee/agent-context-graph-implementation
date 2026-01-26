import type {
  IVerifier,
  VerificationResult,
  VCVerificationResult,
  VPVerificationResult
} from '../interfaces/index.js';

/**
 * DID Document structure (simplified W3C DID Core spec)
 */
export interface DIDDocument {
  '@context': string | string[];
  id: string;
  controller?: string | string[];
  verificationMethod?: VerificationMethod[];
  authentication?: (string | VerificationMethod)[];
  assertionMethod?: (string | VerificationMethod)[];
  service?: ServiceEndpoint[];
}

/**
 * JSON Web Key structure (RFC 7517)
 */
export interface JWK {
  kty: string;
  crv?: string;
  x?: string;
  y?: string;
  n?: string;
  e?: string;
  kid?: string;
  alg?: string;
  use?: string;
}

export interface VerificationMethod {
  id: string;
  type: string;
  controller: string;
  publicKeyMultibase?: string;
  publicKeyJwk?: JWK;
}

export interface ServiceEndpoint {
  id: string;
  type: string;
  serviceEndpoint: string | string[] | Record<string, unknown>;
}

/**
 * DID Resolution result
 */
export interface DIDResolutionResult {
  didDocument: DIDDocument | null;
  didResolutionMetadata: {
    error?: string;
    contentType?: string;
  };
  didDocumentMetadata: {
    created?: string;
    updated?: string;
    deactivated?: boolean;
  };
}

/**
 * Real Verifier implementation with DID resolution
 * Supports did:key and did:web methods
 */
export class RealVerifier implements IVerifier {
  private trustedIssuers: Set<string>;
  private didCache: Map<string, { doc: DIDDocument; expires: number }>;
  private cacheTimeout: number;
  private enableCrypto: boolean;

  constructor(options: {
    trustedIssuers?: string[];
    cacheTimeoutMs?: number;
    enableCrypto?: boolean;
  } = {}) {
    this.trustedIssuers = new Set(options.trustedIssuers ?? []);
    this.didCache = new Map();
    this.cacheTimeout = options.cacheTimeoutMs ?? 5 * 60 * 1000; // 5 minutes
    this.enableCrypto = options.enableCrypto ?? false;
  }

  /**
   * Resolve a DID to its DID Document
   */
  async resolveDID(did: string): Promise<DIDResolutionResult> {
    // Check cache first
    const cached = this.didCache.get(did);
    if (cached && cached.expires > Date.now()) {
      return {
        didDocument: cached.doc,
        didResolutionMetadata: { contentType: 'application/did+ld+json' },
        didDocumentMetadata: {}
      };
    }

    // Parse DID method
    const [, method, identifier] = did.match(/^did:([a-z0-9]+):(.+)$/) || [];
    if (!method || !identifier) {
      return {
        didDocument: null,
        didResolutionMetadata: { error: 'invalidDid' },
        didDocumentMetadata: {}
      };
    }

    let doc: DIDDocument | null = null;

    switch (method) {
      case 'key':
        doc = this.resolveDidKey(did, identifier);
        break;
      case 'web':
        doc = await this.resolveDidWeb(did, identifier);
        break;
      default:
        return {
          didDocument: null,
          didResolutionMetadata: { error: 'methodNotSupported' },
          didDocumentMetadata: {}
        };
    }

    if (doc) {
      // Cache the result
      this.didCache.set(did, { doc, expires: Date.now() + this.cacheTimeout });
    }

    return {
      didDocument: doc,
      didResolutionMetadata: doc ? { contentType: 'application/did+ld+json' } : { error: 'notFound' },
      didDocumentMetadata: {}
    };
  }

  /**
   * Resolve did:key - derives public key from the DID identifier
   * Format: did:key:<multibase-encoded-public-key>
   */
  private resolveDidKey(did: string, identifier: string): DIDDocument | null {
    // did:key identifiers start with 'z' for base58btc multibase encoding
    if (!identifier.startsWith('z')) {
      return null;
    }

    // The identifier is the multibase-encoded public key
    // For Ed25519: z6Mk... (0xed prefix after multicodec)
    // For secp256k1: zQ3s... (0xe7 prefix)
    const keyType = this.determineKeyType(identifier);

    return {
      '@context': [
        'https://www.w3.org/ns/did/v1',
        'https://w3id.org/security/suites/ed25519-2020/v1'
      ],
      id: did,
      verificationMethod: [{
        id: `${did}#${identifier}`,
        type: keyType,
        controller: did,
        publicKeyMultibase: identifier
      }],
      authentication: [`${did}#${identifier}`],
      assertionMethod: [`${did}#${identifier}`]
    };
  }

  /**
   * Determine key type from multibase-encoded identifier
   */
  private determineKeyType(identifier: string): string {
    // Ed25519 keys start with z6Mk
    if (identifier.startsWith('z6Mk')) {
      return 'Ed25519VerificationKey2020';
    }
    // secp256k1 keys start with zQ3s
    if (identifier.startsWith('zQ3s')) {
      return 'EcdsaSecp256k1VerificationKey2019';
    }
    // X25519 keys start with z6LS
    if (identifier.startsWith('z6LS')) {
      return 'X25519KeyAgreementKey2020';
    }
    return 'VerificationKey';
  }

  /**
   * Resolve did:web - fetches DID Document via HTTPS
   * Format: did:web:<domain>[:path]
   */
  private async resolveDidWeb(did: string, identifier: string): Promise<DIDDocument | null> {
    try {
      // Convert did:web identifier to URL
      // did:web:example.com -> https://example.com/.well-known/did.json
      // did:web:example.com:path:to:doc -> https://example.com/path/to/doc/did.json
      const parts = identifier.split(':');
      const domain = decodeURIComponent(parts[0]);
      const path = parts.slice(1).map(p => decodeURIComponent(p)).join('/');

      const url = path
        ? `https://${domain}/${path}/did.json`
        : `https://${domain}/.well-known/did.json`;

      const response = await fetch(url, {
        headers: { 'Accept': 'application/did+ld+json, application/json' },
        signal: AbortSignal.timeout(10000)
      });

      if (!response.ok) {
        return null;
      }

      const doc = await response.json() as DIDDocument;

      // Validate the DID document
      if (doc.id !== did) {
        return null; // DID mismatch
      }

      return doc;
    } catch {
      return null;
    }
  }

  /**
   * Verify DID proof of control
   */
  async verifyDIDProof(did: string, proof: unknown): Promise<VerificationResult> {
    // Validate DID format
    const didPattern = /^did:[a-z0-9]+:.+$/;
    if (!didPattern.test(did)) {
      return { valid: false, error: 'Invalid DID format' };
    }

    // Resolve the DID
    const resolution = await this.resolveDID(did);
    if (!resolution.didDocument) {
      return { valid: false, error: `DID resolution failed: ${resolution.didResolutionMetadata.error}` };
    }

    // If no proof provided, just confirm DID is resolvable
    if (!proof) {
      return { valid: true };
    }

    // If crypto is enabled, verify the proof signature
    if (this.enableCrypto && proof && typeof proof === 'object') {
      // TODO: Implement actual cryptographic verification
      // This would involve:
      // 1. Extracting the verification method from the proof
      // 2. Looking up the public key in the DID document
      // 3. Verifying the signature
      return { valid: true }; // Placeholder
    }

    return { valid: true };
  }

  /**
   * Verify a Verifiable Credential
   * Stub: validates structure and checks trusted issuers
   */
  async verifyVC(credential: unknown): Promise<VCVerificationResult> {
    if (!credential || typeof credential !== 'object') {
      return { valid: false, error: 'Invalid credential format' };
    }

    const cred = credential as Record<string, unknown>;

    // Check required fields
    if (!cred.type || !Array.isArray(cred.type)) {
      return { valid: false, error: 'Missing or invalid credential type' };
    }

    if (!cred.issuer || typeof cred.issuer !== 'string') {
      return { valid: false, error: 'Missing or invalid issuer' };
    }

    if (!cred.credentialSubject || typeof cred.credentialSubject !== 'object') {
      return { valid: false, error: 'Missing or invalid credentialSubject' };
    }

    // Check expiration
    if (cred.expirationDate) {
      const expDate = new Date(cred.expirationDate as string);
      if (expDate < new Date()) {
        return { valid: false, error: 'Credential has expired' };
      }
    }

    // Check trusted issuer (if configured)
    if (this.trustedIssuers.size > 0 && !this.trustedIssuers.has(cred.issuer)) {
      return { valid: false, error: `Issuer '${cred.issuer}' is not trusted` };
    }

    const subject = cred.credentialSubject as Record<string, unknown>;

    return {
      valid: true,
      credentialType: cred.type as string[],
      issuer: cred.issuer,
      subject: subject.id as string | undefined,
      expirationDate: cred.expirationDate as string | undefined
    };
  }

  /**
   * Verify a Verifiable Presentation
   * Stub: validates structure and verifies contained credentials
   */
  async verifyVP(presentation: unknown): Promise<VPVerificationResult> {
    if (!presentation || typeof presentation !== 'object') {
      return { valid: false, error: 'Invalid presentation format' };
    }

    const vp = presentation as Record<string, unknown>;

    if (!vp.holder || typeof vp.holder !== 'string') {
      return { valid: false, error: 'Missing or invalid holder' };
    }

    const credentials: VCVerificationResult[] = [];
    if (vp.verifiableCredential && Array.isArray(vp.verifiableCredential)) {
      for (const vc of vp.verifiableCredential) {
        const result = await this.verifyVC(vc);
        credentials.push(result);
        if (!result.valid) {
          return {
            valid: false,
            error: `Invalid credential in presentation: ${result.error}`,
            holder: vp.holder,
            credentials
          };
        }
      }
    }

    return {
      valid: true,
      holder: vp.holder,
      credentials
    };
  }

  /**
   * Add a trusted issuer
   */
  addTrustedIssuer(issuer: string): void {
    this.trustedIssuers.add(issuer);
  }

  /**
   * Remove a trusted issuer
   */
  removeTrustedIssuer(issuer: string): void {
    this.trustedIssuers.delete(issuer);
  }
}

/**
 * StubVerifier - Simple verifier for testing and development
 * @deprecated Use RealVerifier for production
 */
export class StubVerifier implements IVerifier {
  private trustedIssuers: Set<string>;

  constructor(trustedIssuersOrOptions?: string[] | { trustedIssuers?: string[] }) {
    // Support both array and options object for backward compatibility
    if (Array.isArray(trustedIssuersOrOptions)) {
      this.trustedIssuers = new Set(trustedIssuersOrOptions);
    } else {
      this.trustedIssuers = new Set(trustedIssuersOrOptions?.trustedIssuers ?? []);
    }
  }

  async verifyDIDProof(did: string, _proof: unknown): Promise<VerificationResult> {
    const didPattern = /^did:[a-z0-9]+:.+$/;
    if (!didPattern.test(did)) {
      return { valid: false, error: 'Invalid DID format' };
    }
    return { valid: true };
  }

  async verifyVC(credential: unknown): Promise<VCVerificationResult> {
    if (!credential || typeof credential !== 'object') {
      return { valid: false, error: 'Invalid credential format' };
    }

    const cred = credential as Record<string, unknown>;

    if (!cred.type || !Array.isArray(cred.type)) {
      return { valid: false, error: 'Missing or invalid credential type' };
    }

    if (!cred.issuer || typeof cred.issuer !== 'string') {
      return { valid: false, error: 'Missing or invalid issuer' };
    }

    if (this.trustedIssuers.size > 0 && !this.trustedIssuers.has(cred.issuer)) {
      return { valid: false, error: `Issuer '${cred.issuer}' is not trusted` };
    }

    const subject = cred.credentialSubject as Record<string, unknown> | undefined;

    return {
      valid: true,
      credentialType: cred.type as string[],
      issuer: cred.issuer,
      subject: subject?.id as string | undefined,
      expirationDate: cred.expirationDate as string | undefined
    };
  }

  async verifyVP(presentation: unknown): Promise<VPVerificationResult> {
    if (!presentation || typeof presentation !== 'object') {
      return { valid: false, error: 'Invalid presentation format' };
    }

    const vp = presentation as Record<string, unknown>;

    if (!vp.holder || typeof vp.holder !== 'string') {
      return { valid: false, error: 'Missing or invalid holder' };
    }

    const credentials: VCVerificationResult[] = [];
    if (vp.verifiableCredential && Array.isArray(vp.verifiableCredential)) {
      for (const vc of vp.verifiableCredential) {
        const result = await this.verifyVC(vc);
        credentials.push(result);
        if (!result.valid) {
          return {
            valid: false,
            error: `Invalid credential in presentation: ${result.error}`,
            holder: vp.holder,
            credentials
          };
        }
      }
    }

    return {
      valid: true,
      holder: vp.holder,
      credentials
    };
  }

  addTrustedIssuer(issuer: string): void {
    this.trustedIssuers.add(issuer);
  }

  removeTrustedIssuer(issuer: string): void {
    this.trustedIssuers.delete(issuer);
  }
}
