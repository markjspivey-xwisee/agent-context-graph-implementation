// Using vitest globals
import { ContextBroker } from '../src/broker/context-broker.js';
import { AATRegistry } from '../src/services/aat-registry.js';
import { StubVerifier } from '../src/services/verifier.js';
import { PolicyEngine } from '../src/services/policy-engine.js';
import { StubCausalEvaluator } from '../src/services/causal-evaluator.js';
import { InMemoryTraceStore } from '../src/services/trace-store.js';

describe('ContextBroker', () => {
  let broker: ContextBroker;
  let aatRegistry: AATRegistry;
  let verifier: StubVerifier;
  let policyEngine: PolicyEngine;
  let causalEvaluator: StubCausalEvaluator;
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

  const executorCredential = {
    id: 'urn:uuid:test-cred-002',
    type: ['VerifiableCredential', 'ExecutorCapability'],
    issuer: 'did:web:authority.example.com',
    issuanceDate: '2024-01-01T00:00:00Z',
    expirationDate: '2030-01-01T00:00:00Z',
    credentialSubject: {
      id: 'did:key:z6MkexecutorDID123456789',
      capability: 'ExecutorCapability'
    }
  };

  beforeEach(() => {
    aatRegistry = new AATRegistry();

    // Register AATs manually for testing
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
          { type: 'Actuate', description: '', rationale: 'Planners cannot actuate' }
        ]
      },
      internalState: { description: '', components: [] },
      behavioralInvariants: [],
      traceRequirements: { mustEmitProvActivity: true, requiredFields: [], retentionPolicy: '' },
      livenessGuarantees: [],
      compositionRules: { canComposeBefore: [], canComposeAfter: [], notes: '' }
    });

    aatRegistry.register({
      id: 'aat:ExecutorAgentType',
      name: 'Executor Agent Type',
      version: '1.0.0',
      description: 'Test executor',
      perceptSpace: { description: '', types: [] },
      actionSpace: {
        allowed: [
          { type: 'Act', description: '', requiresCapability: 'ExecutorCapability' },
          { type: 'ReportOutcome', description: '', requiresCapability: null }
        ],
        forbidden: [
          { type: 'EmitPlan', description: '', rationale: 'Executors cannot plan' }
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
    causalEvaluator = new StubCausalEvaluator();
    traceStore = new InMemoryTraceStore();

    broker = new ContextBroker(
      verifier,
      policyEngine,
      aatRegistry,
      traceStore,
      causalEvaluator
    );
  });

  describe('getContext', () => {
    it('should generate a context graph for an agent with credentials', async () => {
      const context = await broker.getContext({
        agentDID: 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK',
        credentials: [plannerCredential]
      });

      expect(context).toBeDefined();
      expect(context.agentDID).toBe('did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK');
      expect(context.agentType).toBe('aat:PlannerAgentType');
      expect(context.affordances.length).toBeGreaterThan(0);
      expect(context.nonce).toBeDefined();
      expect(context.expiresAt).toBeDefined();
    });

    it('should include EmitPlan affordance for planner with credential', async () => {
      const context = await broker.getContext({
        agentDID: 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK',
        credentials: [plannerCredential]
      });

      const emitPlanAffordance = context.affordances.find(a => a.actionType === 'EmitPlan');
      expect(emitPlanAffordance).toBeDefined();
      expect(emitPlanAffordance?.enabled).toBe(true);
    });

    it('should provide request-credential affordance for agent without credentials', async () => {
      const context = await broker.getContext({
        agentDID: 'did:key:z6MknewAgentWithoutCredentials123456789',
        credentials: []
      });

      const requestCredAffordance = context.affordances.find(
        a => a.actionType === 'RequestCredential'
      );
      expect(requestCredAffordance).toBeDefined();
      expect(requestCredAffordance?.target.type).toBe('OID4VCI');
    });

    it('should include trace policy in context', async () => {
      const context = await broker.getContext({
        agentDID: 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK',
        credentials: [plannerCredential]
      });

      expect(context.tracePolicy).toBeDefined();
      expect(context.tracePolicy.mustEmitProvActivity).toBe(true);
    });
  });

  describe('traverse', () => {
    it('should execute an affordance and emit a trace', async () => {
      // Get context first
      const context = await broker.getContext({
        agentDID: 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK',
        credentials: [plannerCredential]
      });

      const emitPlanAffordance = context.affordances.find(a => a.actionType === 'EmitPlan');
      expect(emitPlanAffordance).toBeDefined();

      // Traverse the affordance
      const result = await broker.traverse({
        contextId: context.id,
        affordanceId: emitPlanAffordance!.id,
        parameters: {
          goal: 'Test goal',
          steps: [{ action: 'test', rationale: 'testing' }]
        }
      });

      expect(result.success).toBe(true);
      expect(result.trace).toBeDefined();
      expect(result.trace.wasAssociatedWith.agentDID).toBe(context.agentDID);
      expect(result.trace.used.affordance.actionType).toBe('EmitPlan');
    });

    it('should store trace after traversal', async () => {
      const context = await broker.getContext({
        agentDID: 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK',
        credentials: [plannerCredential]
      });

      const emitPlanAffordance = context.affordances.find(a => a.actionType === 'EmitPlan');

      await broker.traverse({
        contextId: context.id,
        affordanceId: emitPlanAffordance!.id,
        parameters: { goal: 'Test', steps: [] }
      });

      // Verify trace was stored
      const traces = await traceStore.query({
        agentDID: context.agentDID
      });

      expect(traces.length).toBe(1);
      expect(traces[0].used.affordance.actionType).toBe('EmitPlan');
    });
  });
});
