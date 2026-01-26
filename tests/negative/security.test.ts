// Using vitest globals
import { ContextBroker } from '../../src/broker/context-broker.js';
import { AATRegistry } from '../../src/services/aat-registry.js';
import { StubVerifier } from '../../src/services/verifier.js';
import { PolicyEngine } from '../../src/services/policy-engine.js';
import { StubCausalEvaluator } from '../../src/services/causal-evaluator.js';
import { InMemoryTraceStore } from '../../src/services/trace-store.js';

/**
 * Negative test cases for security invariants
 * These tests verify that the system correctly rejects invalid requests
 */
describe('Security - Negative Cases', () => {
  let broker: ContextBroker;
  let aatRegistry: AATRegistry;
  let verifier: StubVerifier;
  let policyEngine: PolicyEngine;
  let traceStore: InMemoryTraceStore;

  const plannerCredential = {
    id: 'urn:uuid:test-cred-001',
    type: ['VerifiableCredential', 'PlannerCapability'],
    issuer: 'did:web:authority.example.com',
    issuanceDate: '2024-01-01T00:00:00Z',
    expirationDate: '2030-01-01T00:00:00Z',
    credentialSubject: {
      id: 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK',
      capability: 'PlannerCapability'
    }
  };

  beforeEach(() => {
    aatRegistry = new AATRegistry();

    aatRegistry.register({
      id: 'aat:PlannerAgentType',
      name: 'Planner Agent Type',
      version: '1.0.0',
      description: 'Test planner',
      perceptSpace: { description: '', types: [] },
      actionSpace: {
        allowed: [
          { type: 'EmitPlan', description: '', requiresCapability: 'PlannerCapability' },
          { type: 'RequestInfo', description: '', requiresCapability: null }
        ],
        forbidden: [
          { type: 'Actuate', description: '', rationale: 'Planners cannot actuate' },
          { type: 'WriteExternal', description: '', rationale: 'No direct writes' }
        ]
      },
      internalState: { description: '', components: [] },
      behavioralInvariants: [],
      traceRequirements: { mustEmitProvActivity: true, requiredFields: [], retentionPolicy: '' },
      livenessGuarantees: [],
      compositionRules: { canComposeBefore: [], canComposeAfter: [], notes: '' }
    });

    verifier = new StubVerifier(['did:web:authority.example.com']);
    policyEngine = new PolicyEngine();
    const causalEvaluator = new StubCausalEvaluator();
    traceStore = new InMemoryTraceStore();

    broker = new ContextBroker(
      verifier,
      policyEngine,
      aatRegistry,
      traceStore,
      causalEvaluator
    );
  });

  describe('T1: Stale Context Replay', () => {
    it('should reject traversal with non-existent context', async () => {
      await expect(
        broker.traverse({
          contextId: 'urn:uuid:non-existent-context',
          affordanceId: 'any-affordance',
          parameters: {}
        })
      ).rejects.toThrow('Context not found');
    });

    it('should reject traversal with expired context', async () => {
      // Get a valid context
      const context = await broker.getContext({
        agentDID: 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK',
        credentials: [plannerCredential]
      });

      // Manually expire the context (hack for testing)
      const storedContext = broker.getStoredContext(context.id);
      if (storedContext) {
        (storedContext as any).expiresAt = '2020-01-01T00:00:00Z';
      }

      const affordance = context.affordances[0];

      await expect(
        broker.traverse({
          contextId: context.id,
          affordanceId: affordance.id,
          parameters: {}
        })
      ).rejects.toThrow('Context has expired');
    });
  });

  describe('T2: Credential Replay / Missing Credentials', () => {
    it('should not include credential-gated affordances without credentials', async () => {
      const context = await broker.getContext({
        agentDID: 'did:key:z6MknewAgentWithoutCredentials123456789',
        credentials: []
      });

      // Should not have EmitPlan (requires PlannerCapability)
      const emitPlanAffordance = context.affordances.find(a => a.actionType === 'EmitPlan');
      expect(emitPlanAffordance).toBeUndefined();
    });

    it('should reject credentials from untrusted issuers', async () => {
      const untrustedCredential = {
        ...plannerCredential,
        issuer: 'did:web:untrusted.example.com'
      };

      const context = await broker.getContext({
        agentDID: 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK',
        credentials: [untrustedCredential]
      });

      // Should not have EmitPlan because credential is not from trusted issuer
      const emitPlanAffordance = context.affordances.find(a => a.actionType === 'EmitPlan');
      expect(emitPlanAffordance).toBeUndefined();
    });
  });

  describe('T3: Confused Deputy - AAT Type Safety', () => {
    it('should never include Actuate affordance in Planner context', async () => {
      const context = await broker.getContext({
        agentDID: 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK',
        credentials: [plannerCredential]
      });

      // Planner should NEVER have Actuate
      const actuateAffordance = context.affordances.find(a => a.actionType === 'Actuate');
      expect(actuateAffordance).toBeUndefined();

      // Also check WriteExternal is not present
      const writeExternalAffordance = context.affordances.find(
        a => a.actionType === 'WriteExternal'
      );
      expect(writeExternalAffordance).toBeUndefined();
    });

    it('should determine agent type from credentials', async () => {
      const context = await broker.getContext({
        agentDID: 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK',
        credentials: [plannerCredential]
      });

      expect(context.agentType).toBe('aat:PlannerAgentType');
    });
  });

  describe('T5: Trace Omission', () => {
    it('should always emit trace after successful traversal', async () => {
      const context = await broker.getContext({
        agentDID: 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK',
        credentials: [plannerCredential]
      });

      const affordance = context.affordances.find(a => a.actionType === 'EmitPlan');
      expect(affordance).toBeDefined();

      const result = await broker.traverse({
        contextId: context.id,
        affordanceId: affordance!.id,
        parameters: { goal: 'Test', steps: [] }
      });

      // Verify trace was returned
      expect(result.trace).toBeDefined();
      expect(result.trace.id).toBeDefined();

      // Verify trace was stored
      const storedTrace = await traceStore.getById(result.trace.id);
      expect(storedTrace).not.toBeNull();
    });
  });

  describe('T6: Capability Escalation', () => {
    it('should reject traversal of affordance not in context', async () => {
      const context = await broker.getContext({
        agentDID: 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK',
        credentials: [plannerCredential]
      });

      // Try to traverse a non-existent affordance
      await expect(
        broker.traverse({
          contextId: context.id,
          affordanceId: 'fake-affordance-id',
          parameters: {}
        })
      ).rejects.toThrow('Affordance not found in context');
    });
  });

  describe('T7: Policy Bypass', () => {
    it('should include policy evaluations in trace', async () => {
      const context = await broker.getContext({
        agentDID: 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK',
        credentials: [plannerCredential]
      });

      const affordance = context.affordances.find(a => a.actionType === 'EmitPlan');

      const result = await broker.traverse({
        contextId: context.id,
        affordanceId: affordance!.id,
        parameters: { goal: 'Test', steps: [] }
      });

      // Verify policy evaluations are in trace
      expect(result.trace.policyEvaluations).toBeDefined();
      expect(result.trace.policyEvaluations!.length).toBeGreaterThan(0);
    });
  });
});

describe('AAT Registry - Negative Cases', () => {
  let aatRegistry: AATRegistry;

  beforeEach(() => {
    aatRegistry = new AATRegistry();
    aatRegistry.register({
      id: 'aat:TestType',
      name: 'Test Type',
      version: '1.0.0',
      description: 'Test',
      perceptSpace: { description: '', types: [] },
      actionSpace: {
        allowed: [{ type: 'AllowedAction', description: '' }],
        forbidden: [{ type: 'ForbiddenAction', description: '', rationale: 'Not allowed' }]
      },
      internalState: { description: '', components: [] },
      behavioralInvariants: [],
      traceRequirements: { mustEmitProvActivity: true, requiredFields: [], retentionPolicy: '' },
      livenessGuarantees: [],
      compositionRules: { canComposeBefore: [], canComposeAfter: [], notes: '' }
    });
  });

  it('should return null for unknown AAT', async () => {
    const aat = await aatRegistry.getAAT('aat:NonExistent');
    expect(aat).toBeNull();
  });

  it('should report forbidden actions correctly', async () => {
    const isForbidden = await aatRegistry.isActionForbidden('aat:TestType', 'ForbiddenAction');
    expect(isForbidden).toBe(true);
  });

  it('should report allowed actions correctly', async () => {
    const isAllowed = await aatRegistry.isActionAllowed('aat:TestType', 'AllowedAction');
    expect(isAllowed).toBe(true);

    const isForbiddenAllowed = await aatRegistry.isActionAllowed('aat:TestType', 'ForbiddenAction');
    expect(isForbiddenAllowed).toBe(false);
  });

  it('should fail validation for forbidden actions', async () => {
    const result = await aatRegistry.validateAffordanceForAAT('aat:TestType', 'ForbiddenAction');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('forbidden');
  });
});

describe('Trace Store - Negative Cases', () => {
  let traceStore: InMemoryTraceStore;

  beforeEach(() => {
    traceStore = new InMemoryTraceStore();
  });

  it('should reject duplicate trace storage (append-only)', async () => {
    const trace = {
      '@context': ['https://www.w3.org/ns/prov#'],
      id: 'urn:uuid:test-trace-001',
      type: ['prov:Activity'],
      wasAssociatedWith: { agentDID: 'did:key:test', agentType: 'aat:Test' },
      used: {
        contextSnapshot: { contextId: '', timestamp: '', nonce: '', agentDID: '', affordanceCount: 0 },
        affordance: { id: '', rel: '', relVersion: '', actionType: '', targetType: '' },
        parameters: {},
        credentials: []
      },
      generated: { outcome: { status: 'success' as const } },
      startedAtTime: '2024-01-01T00:00:00Z',
      endedAtTime: '2024-01-01T00:00:01Z'
    };

    // First store should succeed
    const result1 = await traceStore.store(trace);
    expect(result1.success).toBe(true);

    // Second store with same ID should fail
    const result2 = await traceStore.store(trace);
    expect(result2.success).toBe(false);
    expect(result2.error).toContain('already exists');
  });

  it('should return null for non-existent trace', async () => {
    const trace = await traceStore.getById('urn:uuid:non-existent');
    expect(trace).toBeNull();
  });
});
