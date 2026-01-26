// Using vitest globals
import { FederationService } from '../../src/services/federation-service.js';

describe('FederationService', () => {
  let federation: FederationService;

  beforeEach(() => {
    federation = new FederationService(
      'did:web:broker-alpha.example.com',
      'https://broker-alpha.example.com/acg/v1'
    );
  });

  describe('establishTrust', () => {
    it('should establish trust with another broker', async () => {
      const result = await federation.establishTrust({
        partnerBrokerDID: 'did:web:broker-beta.example.com',
        trustLevel: 'LimitedTrust',
        supportedProtocols: ['HTTP', 'DIDComm']
      });

      expect(result.success).toBe(true);
      expect(result.trustRelationship).toBeDefined();
      expect(result.trustRelationship?.partnerBrokerDID).toBe('did:web:broker-beta.example.com');
      expect(result.trustRelationship?.trustLevel).toBe('LimitedTrust');
      expect(result.trustRelationship?.status).toBe('active');
    });

    it('should create credential bridges', async () => {
      const result = await federation.establishTrust({
        partnerBrokerDID: 'did:web:broker-beta.example.com',
        trustLevel: 'FullTrust',
        credentialBridges: [
          {
            fromDomain: 'did:web:broker-alpha.example.com',
            toDomain: 'did:web:broker-beta.example.com'
          }
        ]
      });

      expect(result.success).toBe(true);
      expect(result.trustRelationship?.credentialBridges).toHaveLength(1);
      expect(result.trustRelationship?.credentialBridges[0].fromDomain).toBe('did:web:broker-alpha.example.com');
    });

    it('should reject duplicate active trust', async () => {
      await federation.establishTrust({
        partnerBrokerDID: 'did:web:broker-beta.example.com',
        trustLevel: 'LimitedTrust'
      });

      const result = await federation.establishTrust({
        partnerBrokerDID: 'did:web:broker-beta.example.com',
        trustLevel: 'FullTrust'
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('already exists');
    });
  });

  describe('revokeTrust', () => {
    it('should revoke existing trust', async () => {
      await federation.establishTrust({
        partnerBrokerDID: 'did:web:broker-beta.example.com',
        trustLevel: 'LimitedTrust'
      });

      const result = await federation.revokeTrust({
        partnerBrokerDID: 'did:web:broker-beta.example.com',
        reason: 'Security incident'
      });

      expect(result.success).toBe(true);
      expect(result.trustRelationship?.status).toBe('revoked');
      expect(result.trustRelationship?.revokedReason).toBe('Security incident');
    });

    it('should fail for non-existent trust', async () => {
      const result = await federation.revokeTrust({
        partnerBrokerDID: 'did:web:unknown.example.com',
        reason: 'Test'
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('No trust relationship');
    });

    it('should revoke credential bridges when requested', async () => {
      await federation.establishTrust({
        partnerBrokerDID: 'did:web:broker-beta.example.com',
        trustLevel: 'LimitedTrust'
      });

      const result = await federation.revokeTrust({
        partnerBrokerDID: 'did:web:broker-beta.example.com',
        reason: 'Policy change',
        revokeCredentialBridges: true
      });

      expect(result.success).toBe(true);
      expect(result.trustRelationship?.credentialBridges).toHaveLength(0);
    });
  });

  describe('federateContext', () => {
    beforeEach(async () => {
      // Set up trust relationship first
      await federation.establishTrust({
        partnerBrokerDID: 'did:web:broker-beta.example.com',
        trustLevel: 'LimitedTrust',
        supportedProtocols: ['HTTP', 'DIDComm']
      });
    });

    it('should federate context from trusted broker', async () => {
      const result = await federation.federateContext({
        targetBrokerDID: 'did:web:broker-beta.example.com',
        resourceURNs: ['urn:resource:inventory', 'urn:resource:orders']
      });

      expect(result.success).toBe(true);
      expect(result.federatedContext).toBeDefined();
      expect(result.federatedContext?.affordances).toHaveLength(2);
      expect(result.federatedContext?.federation?.trustLevel).toBe('LimitedTrust');
    });

    it('should fail for untrusted broker', async () => {
      const result = await federation.federateContext({
        targetBrokerDID: 'did:web:untrusted.example.com',
        resourceURNs: ['urn:resource:data']
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('No trust relationship');
    });

    it('should respect max hops limit', async () => {
      const result = await federation.federateContext(
        {
          targetBrokerDID: 'did:web:broker-beta.example.com',
          resourceURNs: ['urn:resource:data'],
          maxHops: 2
        },
        2 // Already at hop 2
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Maximum federation hops');
    });

    it('should fail for unsupported protocol', async () => {
      const result = await federation.federateContext({
        targetBrokerDID: 'did:web:broker-beta.example.com',
        resourceURNs: ['urn:resource:data'],
        federationProtocol: 'ActivityPub' // Not in supported protocols
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('not supported');
    });

    it('should create federated affordances with correct target type', async () => {
      const result = await federation.federateContext({
        targetBrokerDID: 'did:web:broker-beta.example.com',
        resourceURNs: ['urn:resource:inventory']
      });

      expect(result.success).toBe(true);
      const affordance = result.federatedContext?.affordances?.[0];
      expect(affordance?.target.type).toBe('Federated');
      expect(affordance?.target.remoteBroker?.brokerDID).toBe('did:web:broker-beta.example.com');
      expect(affordance?.target.requiresCrossdomainAuth).toBe(true); // LimitedTrust
    });
  });

  describe('trust queries', () => {
    it('should return active trust relationships', async () => {
      await federation.establishTrust({
        partnerBrokerDID: 'did:web:broker-beta.example.com',
        trustLevel: 'FullTrust'
      });

      await federation.establishTrust({
        partnerBrokerDID: 'did:web:broker-gamma.example.com',
        trustLevel: 'LimitedTrust'
      });

      const active = federation.getActiveTrustRelationships();
      expect(active).toHaveLength(2);
    });

    it('should check credential bridging', async () => {
      await federation.establishTrust({
        partnerBrokerDID: 'did:web:broker-beta.example.com',
        trustLevel: 'FullTrust'
      });

      expect(federation.canBridgeCredential('PlannerCapability', 'did:web:broker-beta.example.com')).toBe(true);
      expect(federation.canBridgeCredential('PlannerCapability', 'did:web:unknown.example.com')).toBe(false);
    });
  });

  describe('broker info', () => {
    it('should return correct broker info', () => {
      const info = federation.getBrokerInfo();
      expect(info.brokerDID).toBe('did:web:broker-alpha.example.com');
      expect(info.serviceEndpoint).toBe('https://broker-alpha.example.com/acg/v1');
      expect(info.status).toBe('Active');
    });
  });
});
