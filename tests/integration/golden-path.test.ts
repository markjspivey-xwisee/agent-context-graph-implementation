// Using vitest globals
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { ContextBroker } from '../../src/broker/context-broker.js';
import { AATRegistry } from '../../src/services/aat-registry.js';
import { StubVerifier } from '../../src/services/verifier.js';
import { PolicyEngine } from '../../src/services/policy-engine.js';
import { StubCausalEvaluator } from '../../src/services/causal-evaluator.js';
import { InMemoryTraceStore } from '../../src/services/trace-store.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const specDir = join(__dirname, '..', '..', 'spec');
const examplesDir = join(__dirname, '..', '..', 'examples', 'golden-path');

/**
 * Golden path integration tests
 * Validates that the system correctly handles the canonical examples
 */
describe('Golden Path - Integration Tests', () => {
  let ajv: Ajv2020;
  let contextGraphSchema: object;
  let provTraceSchema: object;

  beforeEach(() => {
    ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(ajv);

    // Load schemas
    contextGraphSchema = JSON.parse(
      readFileSync(join(specDir, 'context-graph.schema.json'), 'utf-8')
    );
    provTraceSchema = JSON.parse(
      readFileSync(join(specDir, 'prov-trace.schema.json'), 'utf-8')
    );
  });

  describe('Schema Validation', () => {
    it('should validate context-fragment.json against schema', () => {
      const contextFragment = JSON.parse(
        readFileSync(join(examplesDir, 'context-fragment.json'), 'utf-8')
      );

      const validate = ajv.compile(contextGraphSchema);
      const valid = validate(contextFragment);

      if (!valid) {
        console.log('Validation errors:', validate.errors);
      }
      expect(contextFragment.hypergraph).toBeDefined();
      expect(contextFragment.category).toBeDefined();
      expect(contextFragment.affordances.every((a: any) => a.usageSemantics)).toBe(true);
      expect(valid).toBe(true);
    });

    it('should validate prov-trace.json against schema', () => {
      const provTrace = JSON.parse(
        readFileSync(join(examplesDir, 'prov-trace.json'), 'utf-8')
      );

      const validate = ajv.compile(provTraceSchema);
      const valid = validate(provTrace);

      if (!valid) {
        console.log('Validation errors:', validate.errors);
      }
      expect(provTrace.usageEvent).toBeDefined();
      expect(provTrace.usageEvent.usageRel).toBeDefined();
      expect(valid).toBe(true);
    });

    it('should validate request-credential.json against schema', () => {
      const requestCredential = JSON.parse(
        readFileSync(join(examplesDir, 'request-credential.json'), 'utf-8')
      );

      const validate = ajv.compile(contextGraphSchema);
      const valid = validate(requestCredential);

      if (!valid) {
        console.log('Validation errors:', validate.errors);
      }
      expect(valid).toBe(true);
    });

    it('should validate causal-affordance.json against schema', () => {
      const causalAffordance = JSON.parse(
        readFileSync(join(examplesDir, 'causal-affordance.json'), 'utf-8')
      );

      const validate = ajv.compile(contextGraphSchema);
      const valid = validate(causalAffordance);

      if (!valid) {
        console.log('Validation errors:', validate.errors);
      }
      expect(valid).toBe(true);
    });
  });

  describe('AAT Spec Validation', () => {
    it('should load planner AAT spec', () => {
      const plannerAAT = JSON.parse(
        readFileSync(join(specDir, 'aat', 'planner.json'), 'utf-8')
      );

      expect(plannerAAT.id).toBe('aat:PlannerAgentType');
      // Note: In AAT JSON-LD, 'type' is 'aat:ActionType' and 'name' is the action name
      expect(plannerAAT.actionSpace.forbidden).toContainEqual(
        expect.objectContaining({ name: 'Actuate' })
      );
    });

    it('should load executor AAT spec', () => {
      const executorAAT = JSON.parse(
        readFileSync(join(specDir, 'aat', 'executor.json'), 'utf-8')
      );

      expect(executorAAT.id).toBe('aat:ExecutorAgentType');
      expect(executorAAT.actionSpace.forbidden).toContainEqual(
        expect.objectContaining({ name: 'EmitPlan' })
      );
    });

    it('should load observer AAT spec', () => {
      const observerAAT = JSON.parse(
        readFileSync(join(specDir, 'aat', 'observer.json'), 'utf-8')
      );

      expect(observerAAT.id).toBe('aat:ObserverAgentType');
      expect(observerAAT.actionSpace.forbidden).toContainEqual(
        expect.objectContaining({ name: 'Actuate' })
      );
    });
  });

  describe('End-to-End Flow', () => {
    let broker: ContextBroker;

    beforeEach(() => {
      const aatRegistry = new AATRegistry();

      // Load AATs from spec files
      const plannerAAT = JSON.parse(
        readFileSync(join(specDir, 'aat', 'planner.json'), 'utf-8')
      );
      const executorAAT = JSON.parse(
        readFileSync(join(specDir, 'aat', 'executor.json'), 'utf-8')
      );
      const observerAAT = JSON.parse(
        readFileSync(join(specDir, 'aat', 'observer.json'), 'utf-8')
      );

      aatRegistry.register(plannerAAT);
      aatRegistry.register(executorAAT);
      aatRegistry.register(observerAAT);

      const verifier = new StubVerifier(['did:web:authority.example.com']);
      const policyEngine = new PolicyEngine();
      const causalEvaluator = new StubCausalEvaluator();
      const traceStore = new InMemoryTraceStore();

      broker = new ContextBroker(
        verifier,
        policyEngine,
        aatRegistry,
        traceStore,
        causalEvaluator
      );
    });

    it('should complete a full planner workflow', async () => {
      // 1. Agent requests context with PlannerCapability
      const credential = {
        id: 'urn:uuid:test-cred',
        type: ['VerifiableCredential', 'PlannerCapability'],
        issuer: 'did:web:authority.example.com',
        issuanceDate: '2024-01-01T00:00:00Z',
        expirationDate: '2030-01-01T00:00:00Z',
        credentialSubject: {
          id: 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK',
          capability: 'PlannerCapability'
        }
      };

      const context = await broker.getContext({
        agentDID: 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK',
        credentials: [credential]
      });

      // 2. Verify context has expected structure
      expect(context.agentType).toBe('aat:PlannerAgentType');
      expect(context.affordances.some(a => a.actionType === 'EmitPlan')).toBe(true);
      expect(context.affordances.some(a => a.actionType === 'Actuate')).toBe(false);

      // 3. Find EmitPlan affordance and traverse it
      const emitPlanAff = context.affordances.find(a => a.actionType === 'EmitPlan')!;

      const result = await broker.traverse({
        contextId: context.id,
        affordanceId: emitPlanAff.id,
        parameters: {
          goal: 'Implement user authentication',
          steps: [
            { action: 'Design schema', rationale: 'Need data model first' },
            { action: 'Implement login', rationale: 'Core functionality' }
          ]
        }
      });

      // 4. Verify traversal succeeded
      expect(result.success).toBe(true);

      // 5. Verify trace was emitted with all required fields
      expect(result.trace.wasAssociatedWith.agentDID).toBe(context.agentDID);
      expect(result.trace.used.contextSnapshot.contextId).toBe(context.id);
      expect(result.trace.used.affordance.actionType).toBe('EmitPlan');
      expect(result.trace.generated.outcome.status).toBe('success');
      expect(result.trace.usageEvent?.usageRel).toBe('emit-plan');
    });

    it('should correctly gate affordances based on credentials', async () => {
      // Request context WITHOUT credentials
      const contextNoCred = await broker.getContext({
        agentDID: 'did:key:z6MknewAgent',
        credentials: []
      });

      // Should have request-credential but NOT EmitPlan
      expect(contextNoCred.affordances.some(a => a.actionType === 'RequestCredential')).toBe(true);
      expect(contextNoCred.affordances.some(a => a.actionType === 'EmitPlan')).toBe(false);

      // Request context WITH credentials
      const contextWithCred = await broker.getContext({
        agentDID: 'did:key:z6MknewAgent',
        credentials: [{
          id: 'urn:uuid:cred',
          type: ['VerifiableCredential', 'PlannerCapability'],
          issuer: 'did:web:authority.example.com',
          expirationDate: '2030-01-01T00:00:00Z',
          credentialSubject: {
            id: 'did:key:z6MknewAgent',
            capability: 'PlannerCapability'
          }
        }]
      });

      // Should have EmitPlan now
      expect(contextWithCred.affordances.some(a => a.actionType === 'EmitPlan')).toBe(true);
    });
  });
});
