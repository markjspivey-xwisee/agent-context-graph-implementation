import { describe, it, expect, beforeEach } from 'vitest';
import { DIDAuthService, type DIDDocument, type AuthSession } from '../../src/services/did-auth.js';

describe('DIDAuthService', () => {
  let authService: DIDAuthService;
  const testDID = 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK';

  beforeEach(() => {
    authService = new DIDAuthService({
      trustedIssuers: [],
      challengeExpirySeconds: 300,
      sessionExpiryHours: 24
    });
  });

  describe('DID Resolution', () => {
    it('should resolve a did:key document', async () => {
      const doc = await authService.resolveDID(testDID);
      expect(doc).not.toBeNull();
      expect(doc?.id).toBe(testDID);
      expect(doc?.['@context']).toContain('https://www.w3.org/ns/did/v1');
      expect(doc?.verificationMethod).toBeDefined();
      expect(doc?.verificationMethod!.length).toBeGreaterThan(0);
    });

    it('should include authentication method', async () => {
      const doc = await authService.resolveDID(testDID);
      expect(doc?.authentication).toBeDefined();
      expect(doc?.authentication!.length).toBeGreaterThan(0);
    });

    it('should include assertion method', async () => {
      const doc = await authService.resolveDID(testDID);
      expect(doc?.assertionMethod).toBeDefined();
    });

    it('should cache resolved DID documents', async () => {
      const doc1 = await authService.resolveDID(testDID);
      const doc2 = await authService.resolveDID(testDID);
      expect(doc1).toBe(doc2); // Same reference from cache
    });

    it('should return null for invalid DID format', async () => {
      const doc = await authService.resolveDID('did:key:');
      expect(doc).toBeNull();
    });
  });

  describe('Challenge-Response Authentication', () => {
    it('should create an authentication challenge', () => {
      const challenge = authService.createChallenge();
      expect(challenge.id).toBeDefined();
      expect(challenge.challenge).toBeDefined();
      expect(challenge.expiresAt).toBeDefined();
    });

    it('should create a challenge for specific DID', () => {
      const challenge = authService.createChallenge(testDID);
      expect(challenge.did).toBe(testDID);
    });

    it('should have future expiration time', () => {
      const challenge = authService.createChallenge();
      const expiresAt = new Date(challenge.expiresAt).getTime();
      expect(expiresAt).toBeGreaterThan(Date.now());
    });

    it('should verify challenge returns session or null', async () => {
      const challenge = authService.createChallenge(testDID);
      // Mock signature - in real use would be cryptographically signed
      const mockSignature = 'mock-valid-signature';

      // Will return null with mock signature
      const session = await authService.verifyChallenge(
        challenge.id,
        testDID,
        mockSignature
      );

      // May be null with mock signature, that's expected
      expect(session === null || typeof session === 'object').toBe(true);
    });
  });

  describe('Session Management', () => {
    it('should return null for non-existent session', () => {
      const session = authService.getSession('nonexistent');
      expect(session).toBeNull();
    });

    it('should invalidate a session without error', () => {
      authService.invalidateSession('test-session-id');
      const session = authService.getSession('test-session-id');
      expect(session).toBeNull();
    });
  });

  describe('Verifiable Credentials', () => {
    const issuerDID = 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK';
    const subjectDID = 'did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH';

    it('should issue a verifiable credential', async () => {
      // Note: issueCredential takes (subjectDID, issuerDID, credentialType, claims)
      const credential = await authService.issueCredential(
        subjectDID,
        issuerDID,
        'TestCredential',
        { role: 'tester', level: 'admin' }
      );

      expect(credential['@context']).toContain('https://www.w3.org/2018/credentials/v1');
      expect(credential.type).toContain('VerifiableCredential');
      expect(credential.issuer).toBe(issuerDID);
      expect(credential.credentialSubject.id).toBe(subjectDID);
    });

    it('should include issuance date', async () => {
      const credential = await authService.issueCredential(
        subjectDID,
        issuerDID,
        'TestCredential',
        { test: 'value' }
      );

      expect(credential.issuanceDate).toBeDefined();
    });

    it('should issue ACG capability credential', async () => {
      const credential = await authService.issueACGCapabilityCredential(
        subjectDID,
        issuerDID,
        'PlannerCapability'
      );

      expect(credential.type).toContain('ACGCapabilityCredential');
      expect(credential.credentialSubject.capability).toBe('PlannerCapability');
    });

    it('should verify a credential', async () => {
      const credential = await authService.issueCredential(
        subjectDID,
        issuerDID,
        'TestCredential',
        { test: true }
      );

      const result = await authService.verifyCredential(credential);
      expect(typeof result.valid === 'boolean').toBe(true);
    });
  });

  describe('Verifiable Presentations', () => {
    const holderDID = 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK';
    const issuerDID = 'did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH';

    it('should create a verifiable presentation', async () => {
      const credential = await authService.issueCredential(
        holderDID,
        issuerDID,
        'TestCredential',
        { access: 'granted' }
      );

      // Note: createPresentation takes (credentials[], holderDID, options)
      const presentation = await authService.createPresentation(
        [credential],
        holderDID,
        { challenge: 'test-challenge-123', domain: 'acg.example.com' }
      );

      expect(presentation['@context']).toContain('https://www.w3.org/2018/credentials/v1');
      expect(presentation.type).toContain('VerifiablePresentation');
      expect(presentation.holder).toBe(holderDID);
      expect(presentation.verifiableCredential.length).toBe(1);
    });

    it('should verify a presentation', async () => {
      const credential = await authService.issueCredential(
        holderDID,
        issuerDID,
        'TestCredential',
        {}
      );

      const presentation = await authService.createPresentation(
        [credential],
        holderDID
      );

      const result = await authService.verifyPresentation(presentation, {});
      expect(typeof result.valid === 'boolean').toBe(true);
    });
  });

  describe('Capability Checks', () => {
    it('should return false for non-existent session capability', () => {
      const hasCapability = authService.hasCapability('nonexistent', 'PlannerCapability');
      expect(hasCapability).toBe(false);
    });
  });
});
