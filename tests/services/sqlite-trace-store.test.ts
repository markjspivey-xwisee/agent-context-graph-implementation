/**
 * SQLite Trace Store Tests
 */
import { SQLiteTraceStore } from '../../src/services/sqlite-trace-store.js';
import type { ProvTrace } from '../../src/interfaces/index.js';

describe('SQLiteTraceStore', () => {
  let store: SQLiteTraceStore;

  const createTestTrace = (id: string, agentDID: string = 'did:key:z6MkTest'): ProvTrace => ({
    '@context': ['https://www.w3.org/ns/prov-o'],
    '@type': ['prov:Activity', 'acg:AgentAction'],
    id,
    startedAtTime: new Date().toISOString(),
    wasAssociatedWith: {
      agentDID,
      agentType: 'aat:TestAgentType'
    },
    used: {
      contextId: 'urn:uuid:ctx-test',
      affordance: {
        id: 'aff-test',
        actionType: 'TestAction'
      }
    },
    generated: {
      outcome: 'success'
    }
  });

  beforeEach(() => {
    // Create in-memory database for testing
    store = new SQLiteTraceStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  describe('Trace Storage', () => {
    it('should store a trace successfully', async () => {
      const trace = createTestTrace('urn:uuid:trace-1');
      const result = await store.store(trace);

      expect(result.success).toBe(true);
      expect(result.traceId).toBe('urn:uuid:trace-1');
    });

    it('should reject traces without ID', async () => {
      const trace = createTestTrace('urn:uuid:trace-1');
      delete (trace as Record<string, unknown>).id;

      const result = await store.store(trace as ProvTrace);

      expect(result.success).toBe(false);
      expect(result.error).toContain('ID');
    });

    it('should reject duplicate traces (append-only)', async () => {
      const trace = createTestTrace('urn:uuid:trace-dup');

      await store.store(trace);
      const result = await store.store(trace);

      expect(result.success).toBe(false);
      expect(result.error).toContain('append-only');
    });

    it('should retrieve trace by ID', async () => {
      const trace = createTestTrace('urn:uuid:trace-get');
      await store.store(trace);

      const retrieved = await store.getById('urn:uuid:trace-get');

      expect(retrieved).toBeDefined();
      expect(retrieved?.id).toBe('urn:uuid:trace-get');
      expect(retrieved?.wasAssociatedWith.agentDID).toBe('did:key:z6MkTest');
    });

    it('should return null for non-existent trace', async () => {
      const retrieved = await store.getById('urn:uuid:nonexistent');
      expect(retrieved).toBeNull();
    });
  });

  describe('Trace Querying', () => {
    beforeEach(async () => {
      // Insert test traces
      await store.store(createTestTrace('urn:uuid:q1', 'did:key:z6MkAgent1'));
      await store.store(createTestTrace('urn:uuid:q2', 'did:key:z6MkAgent1'));
      await store.store(createTestTrace('urn:uuid:q3', 'did:key:z6MkAgent2'));
    });

    it('should query all traces', async () => {
      const traces = await store.query({});
      expect(traces.length).toBe(3);
    });

    it('should query traces by agent DID', async () => {
      const traces = await store.query({ agentDID: 'did:key:z6MkAgent1' });
      expect(traces.length).toBe(2);
    });

    it('should support pagination with limit and offset', async () => {
      const page1 = await store.query({ limit: 2, offset: 0 });
      const page2 = await store.query({ limit: 2, offset: 2 });

      expect(page1.length).toBe(2);
      expect(page2.length).toBe(1);
    });

    it('should get traces for specific agent', () => {
      const traces = store.getTracesForAgent('did:key:z6MkAgent2');
      expect(traces.length).toBe(1);
      expect(traces[0].wasAssociatedWith.agentDID).toBe('did:key:z6MkAgent2');
    });
  });

  describe('Workflow Persistence', () => {
    it('should save and retrieve a workflow', () => {
      const workflow = {
        id: 'workflow-1',
        goal: 'Test goal',
        status: 'planning',
        tasks: []
      };

      store.saveWorkflow(workflow);
      const retrieved = store.getWorkflow('workflow-1');

      expect(retrieved).toBeDefined();
      expect(retrieved?.goal).toBe('Test goal');
      expect(retrieved?.status).toBe('planning');
    });

    it('should return null for non-existent workflow', () => {
      const retrieved = store.getWorkflow('nonexistent');
      expect(retrieved).toBeNull();
    });

    it('should list all workflows', () => {
      store.saveWorkflow({ id: 'w1', goal: 'Goal 1', status: 'planning' });
      store.saveWorkflow({ id: 'w2', goal: 'Goal 2', status: 'executing' });

      const workflows = store.getAllWorkflows();
      expect(workflows.length).toBe(2);
    });

    it('should filter workflows by status', () => {
      store.saveWorkflow({ id: 'w1', goal: 'Goal 1', status: 'planning' });
      store.saveWorkflow({ id: 'w2', goal: 'Goal 2', status: 'executing' });
      store.saveWorkflow({ id: 'w3', goal: 'Goal 3', status: 'planning' });

      const planning = store.getWorkflowsByStatus('planning');
      expect(planning.length).toBe(2);
    });

    it('should update existing workflow on save', () => {
      store.saveWorkflow({ id: 'w1', goal: 'Goal 1', status: 'planning' });
      store.saveWorkflow({ id: 'w1', goal: 'Goal 1', status: 'completed' });

      const workflows = store.getAllWorkflows();
      expect(workflows.length).toBe(1);
      expect(workflows[0].status).toBe('completed');
    });
  });

  describe('Task Persistence', () => {
    it('should save and retrieve tasks for a workflow', () => {
      // Create workflow first (foreign key constraint)
      store.saveWorkflow({ id: 'workflow-1', goal: 'Test goal', status: 'planning' });

      const task = {
        id: 'task-1',
        workflowId: 'workflow-1',
        type: 'plan',
        status: 'pending',
        description: 'Create a plan'
      };

      store.saveTask(task);
      const tasks = store.getTasksForWorkflow('workflow-1');

      expect(tasks.length).toBe(1);
      expect(tasks[0].type).toBe('plan');
    });

    it('should handle multiple tasks per workflow', () => {
      // Create workflows first (foreign key constraint)
      store.saveWorkflow({ id: 'w1', goal: 'Goal 1', status: 'planning' });
      store.saveWorkflow({ id: 'w2', goal: 'Goal 2', status: 'planning' });

      store.saveTask({ id: 't1', workflowId: 'w1', type: 'plan', status: 'completed' });
      store.saveTask({ id: 't2', workflowId: 'w1', type: 'approve', status: 'pending' });
      store.saveTask({ id: 't3', workflowId: 'w2', type: 'plan', status: 'pending' });

      const w1Tasks = store.getTasksForWorkflow('w1');
      expect(w1Tasks.length).toBe(2);
    });
  });

  describe('Credential Persistence', () => {
    it('should save and retrieve credentials', () => {
      const credential = {
        id: 'urn:uuid:cred-1',
        type: ['VerifiableCredential', 'AgentCapabilityCredential'],
        issuer: 'did:web:issuer.example.com',
        credentialSubject: {
          id: 'did:key:z6MkHolder',
          capability: 'Planner'
        },
        issuanceDate: new Date().toISOString()
      };

      store.saveCredential(credential);
      const credentials = store.getCredentialsForHolder('did:key:z6MkHolder');

      expect(credentials.length).toBe(1);
      expect(credentials[0].issuer).toBe('did:web:issuer.example.com');
    });

    it('should list all credentials', () => {
      store.saveCredential({
        id: 'cred-1',
        type: ['VerifiableCredential'],
        issuer: 'did:web:issuer1.example.com',
        credentialSubject: { id: 'did:key:z6MkHolder1' }
      });
      store.saveCredential({
        id: 'cred-2',
        type: ['VerifiableCredential'],
        issuer: 'did:web:issuer2.example.com',
        credentialSubject: { id: 'did:key:z6MkHolder2' }
      });

      const all = store.getAllCredentials();
      expect(all.length).toBe(2);
    });
  });

  describe('Causal Evaluation Logging', () => {
    it('should log causal evaluations', () => {
      const evaluation = {
        id: 'eval-1',
        modelRef: 'model:test',
        interventions: ['do(X=1)'],
        context: { variable: 'Y', observed: 5 },
        predictions: { Y: 10 },
        confidence: 0.85
      };

      store.logCausalEvaluation(evaluation);
      const evals = store.getCausalEvaluationsForModel('model:test');

      expect(evals.length).toBe(1);
      expect(evals[0].confidence).toBe(0.85);
      expect(evals[0].interventions).toContain('do(X=1)');
    });
  });

  describe('Statistics and Utilities', () => {
    it('should return accurate statistics', async () => {
      await store.store(createTestTrace('urn:uuid:stats-1'));
      await store.store(createTestTrace('urn:uuid:stats-2'));
      // Create workflow before task (foreign key constraint)
      store.saveWorkflow({ id: 'w1', goal: 'Goal', status: 'planning' });
      store.saveTask({ id: 't1', workflowId: 'w1', type: 'plan', status: 'pending' });

      const stats = store.getStats();

      expect(stats.traces).toBe(2);
      expect(stats.workflows).toBe(1);
      expect(stats.tasks).toBe(1);
    });

    it('should count traces correctly', async () => {
      await store.store(createTestTrace('urn:uuid:count-1'));
      await store.store(createTestTrace('urn:uuid:count-2'));
      await store.store(createTestTrace('urn:uuid:count-3'));

      expect(store.getCount()).toBe(3);
    });

    it('should export all data', async () => {
      await store.store(createTestTrace('urn:uuid:export-1'));
      store.saveWorkflow({ id: 'w1', goal: 'Goal', status: 'planning' });
      store.saveCredential({
        id: 'cred-1',
        type: ['VerifiableCredential'],
        issuer: 'did:web:example.com',
        credentialSubject: { id: 'did:key:holder' }
      });

      const exported = store.exportData();

      expect(exported.traces.length).toBe(1);
      expect(exported.workflows.length).toBe(1);
      expect(exported.credentials.length).toBe(1);
    });

    it('should provide access to raw database', () => {
      const db = store.getRawDb();
      expect(db).toBeDefined();
      expect(db.pragma).toBeDefined();
    });

    it('should vacuum without error', () => {
      expect(() => store.vacuum()).not.toThrow();
    });
  });
});
