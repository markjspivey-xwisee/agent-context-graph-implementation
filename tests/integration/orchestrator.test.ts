/**
 * Orchestrator Integration Tests
 * Tests the full workflow: Plan → Approve → Execute → Observe → Archive
 */
// Using vitest globals
import { vi } from 'vitest';
import { Orchestrator } from '../../src/agents/orchestrator.js';
import type { IReasoningClient, LLMResponse, AgentSystemPrompt } from '../../src/agents/reasoning-client.js';
import type { ContextGraph } from '../../src/interfaces/index.js';

/**
 * Mock reasoning client that returns predictable responses
 */
class MockReasoningClient implements IReasoningClient {
  private callCount = 0;
  private agentResponses: Map<string, LLMResponse[]> = new Map();

  constructor() {
    // Set up predictable responses for each agent type
    this.agentResponses.set('Planner', [{
      reasoning: 'I will create a plan with steps to achieve the goal',
      selectedAffordance: 'aff-emit-plan',
      parameters: {
        goal: 'Test goal',
        steps: [
          { action: 'Step 1: Prepare', rationale: 'Setup required' },
          { action: 'Step 2: Execute', rationale: 'Main action' }
        ]
      },
      shouldContinue: false,
      message: 'Plan created'
    }]);

    this.agentResponses.set('Arbiter', [{
      reasoning: 'The proposed action is safe and within policy',
      selectedAffordance: 'aff-approve',
      parameters: {
        decision: 'approve',
        reason: 'Action complies with all policies'
      },
      shouldContinue: false,
      message: 'Approved'
    }]);

    this.agentResponses.set('Executor', [{
      reasoning: 'I will execute the approved action',
      selectedAffordance: 'aff-act',
      parameters: {
        action: 'execute step',
        result: 'success'
      },
      shouldContinue: false,
      message: 'Executed'
    }]);

    this.agentResponses.set('Observer', [{
      reasoning: 'I observed the execution completed successfully',
      selectedAffordance: 'aff-report',
      parameters: {
        observation: 'Task completed successfully',
        status: 'verified'
      },
      shouldContinue: false,
      message: 'Observed'
    }]);

    this.agentResponses.set('Archivist', [{
      reasoning: 'I will store the workflow results',
      selectedAffordance: 'aff-store',
      parameters: {
        content: 'Workflow completed',
        contentType: 'trace'
      },
      shouldContinue: false,
      message: 'Archived'
    }]);
  }

  async reasonAboutContext(
    systemPrompt: AgentSystemPrompt,
    _context: ContextGraph,
    _task: string,
    _previousActions: string[]
  ): Promise<LLMResponse> {
    const responses = this.agentResponses.get(systemPrompt.role) ?? [];
    const response = responses[0] ?? {
      reasoning: 'Default response',
      selectedAffordance: null,
      parameters: {},
      shouldContinue: false
    };
    this.callCount++;
    return response;
  }

  async generatePlan(
    task: string,
    _constraints?: string[]
  ): Promise<{ goal: string; steps: Array<{ action: string; rationale: string }> }> {
    return {
      goal: task,
      steps: [
        { action: 'Step 1: Prepare', rationale: 'Setup required' },
        { action: 'Step 2: Execute', rationale: 'Main action' }
      ]
    };
  }

  async summarizeObservations(
    observations: string[],
    _context: string
  ): Promise<string> {
    return `Summary of ${observations.length} observations`;
  }

  async makeApprovalDecision(
    _proposedAction: string,
    _context: string,
    _policies: string[]
  ): Promise<{ decision: 'approve' | 'deny' | 'modify'; reason: string; modification?: string }> {
    return { decision: 'approve', reason: 'Action complies with all policies' };
  }

  getCallCount(): number {
    return this.callCount;
  }
}

/**
 * Mock HTTP server for broker endpoints
 */
function createMockBrokerServer() {
  const contexts = new Map<string, ContextGraph>();
  let contextCounter = 0;

  return {
    handleContextRequest: (agentDID: string, credentials: unknown[]): ContextGraph => {
      const contextId = `urn:uuid:ctx-${++contextCounter}`;

      // Determine agent type from credentials
      const agentType = determineAgentType(credentials);
      const affordances = buildAffordancesForType(agentType);
      const requiredOutputAction = getRequiredOutputAction(agentType);

      const context: ContextGraph = {
        '@context': ['https://www.w3.org/ns/did/v1'],
        id: contextId,
        agentDID,
        agentType,
        timestamp: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        nonce: `nonce-${contextCounter}`,
        scope: { domain: 'test', resources: [], actions: [] },
        verifiedCredentials: [],
        constraints: [],
        affordances,
        tracePolicy: { mustEmitProvActivity: true, retentionPeriod: 'P1Y', includeContextSnapshot: true, includeOutcomes: true },
        structuralRequirements: requiredOutputAction ? { requiredOutputAction } : undefined
      };

      contexts.set(contextId, context);
      return context;
    },

    handleTraverseRequest: (contextId: string, affordanceId: string, parameters: Record<string, unknown>) => {
      const context = contexts.get(contextId);
      if (!context) throw new Error('Context not found');

      const affordance = context.affordances.find(a => a.id === affordanceId);
      if (!affordance) throw new Error('Affordance not found');

      return {
        success: true,
        trace: {
          id: `urn:uuid:trace-${Date.now()}`,
          used: { affordance: { actionType: affordance.actionType } }
        },
        result: parameters
      };
    }
  };
}

function determineAgentType(credentials: unknown[]): string {
  for (const cred of credentials) {
    const c = cred as { credentialSubject?: { capability?: string } };
    if (c.credentialSubject?.capability?.includes('Planner')) return 'aat:PlannerAgentType';
    if (c.credentialSubject?.capability?.includes('Executor')) return 'aat:ExecutorAgentType';
    if (c.credentialSubject?.capability?.includes('Observer')) return 'aat:ObserverAgentType';
    if (c.credentialSubject?.capability?.includes('Arbiter')) return 'aat:ArbiterAgentType';
    if (c.credentialSubject?.capability?.includes('Archivist')) return 'aat:ArchivistAgentType';
  }
  return 'aat:UnknownAgentType';
}

function getRequiredOutputAction(agentType: string): string | undefined {
  const requirements: Record<string, string> = {
    'aat:PlannerAgentType': 'EmitPlan',
    'aat:ExecutorAgentType': undefined as unknown as string,
    'aat:ObserverAgentType': 'Report',
    'aat:ArbiterAgentType': undefined as unknown as string,
    'aat:ArchivistAgentType': 'Store'
  };
  return requirements[agentType];
}

function buildAffordancesForType(agentType: string): ContextGraph['affordances'] {
  const baseAffordances = [
    { id: 'aff-request-info', actionType: 'RequestInfo', rel: 'request-info', relVersion: '1.0.0', target: { type: 'HTTP', href: '/info' }, enabled: true, effects: [] }
  ];

  const typeAffordances: Record<string, ContextGraph['affordances']> = {
    'aat:PlannerAgentType': [
      { id: 'aff-emit-plan', actionType: 'EmitPlan', rel: 'emit-plan', relVersion: '1.0.0', target: { type: 'HTTP', href: '/plans' }, enabled: true, effects: [] }
    ],
    'aat:ExecutorAgentType': [
      { id: 'aff-act', actionType: 'Act', rel: 'act', relVersion: '1.0.0', target: { type: 'HTTP', href: '/actions' }, enabled: true, effects: [] }
    ],
    'aat:ObserverAgentType': [
      { id: 'aff-report', actionType: 'Report', rel: 'report', relVersion: '1.0.0', target: { type: 'HTTP', href: '/reports' }, enabled: true, effects: [] }
    ],
    'aat:ArbiterAgentType': [
      { id: 'aff-approve', actionType: 'Approve', rel: 'approve', relVersion: '1.0.0', target: { type: 'HTTP', href: '/decisions' }, enabled: true },
      { id: 'aff-deny', actionType: 'Deny', rel: 'deny', relVersion: '1.0.0', target: { type: 'HTTP', href: '/decisions' }, enabled: true }
    ],
    'aat:ArchivistAgentType': [
      { id: 'aff-store', actionType: 'Store', rel: 'store', relVersion: '1.0.0', target: { type: 'HTTP', href: '/records' }, enabled: true, effects: [] }
    ]
  };

  return [...baseAffordances, ...(typeAffordances[agentType] ?? [])] as ContextGraph['affordances'];
}

describe('Orchestrator Integration Tests', () => {
  let orchestrator: Orchestrator;
  let mockBroker: ReturnType<typeof createMockBrokerServer>;
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    mockBroker = createMockBrokerServer();

    // Mock fetch to intercept broker calls
    originalFetch = global.fetch;
    global.fetch = vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
      const urlStr = url.toString();
      const body = options?.body ? JSON.parse(options.body as string) : {};

      if (urlStr.endsWith('/context')) {
        const context = mockBroker.handleContextRequest(body.agentDID, body.credentials ?? []);
        return new Response(JSON.stringify(context), { status: 200 });
      }

      if (urlStr.endsWith('/traverse')) {
        const result = mockBroker.handleTraverseRequest(body.contextId, body.affordanceId, body.parameters);
        return new Response(JSON.stringify(result), { status: 200 });
      }

      return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
    }) as typeof fetch;

    // Create orchestrator with mock reasoning client
    const mockClient = new MockReasoningClient();
    orchestrator = new Orchestrator({
      brokerUrl: 'http://localhost:3001',
      maxConcurrentAgents: 5
    });

    // Inject mock client (accessing private field for testing)
    (orchestrator as unknown as { reasoningClient: IReasoningClient }).reasoningClient = mockClient;
  });

  afterEach(() => {
    orchestrator.stop();
    global.fetch = originalFetch;
  });

  describe('Workflow Submission', () => {
    it('should accept a goal and create initial planning task', async () => {
      const workflowId = await orchestrator.submitGoal('Test creating a hello world function');

      expect(workflowId).toBeDefined();
      expect(workflowId).toMatch(/^[0-9a-f-]{36}$/);

      const workflow = orchestrator.getWorkflowStatus(workflowId);
      expect(workflow).toBeDefined();
      expect(workflow?.status).toBe('planning');
      expect(workflow?.goal).toBe('Test creating a hello world function');
    });

    it('should track workflow in getAllWorkflows', async () => {
      await orchestrator.submitGoal('Goal 1');
      await orchestrator.submitGoal('Goal 2');

      const workflows = orchestrator.getAllWorkflows();
      expect(workflows.length).toBe(2);
    });
  });

  describe('Task Management', () => {
    it('should create plan task when goal is submitted', async () => {
      const workflowId = await orchestrator.submitGoal('Test goal');

      const tasks = orchestrator.getAllTasks();
      const planTask = tasks.find(t => t.type === 'plan');

      expect(planTask).toBeDefined();
      expect(planTask?.description).toContain('Test goal');
      expect(planTask?.metadata.workflowId).toBe(workflowId);
    });
  });

  describe('Statistics', () => {
    it('should report accurate statistics', async () => {
      await orchestrator.submitGoal('Stats test goal');

      const stats = orchestrator.getStats();

      expect(stats.workflows.total).toBe(1);
      expect(stats.workflows.byStatus.planning).toBe(1);
      expect(stats.tasks.total).toBeGreaterThanOrEqual(1);
      expect(stats.tasks.byType.plan).toBe(1);
    });
  });

  describe('Agent Pool', () => {
    it('should start with empty agent pool', () => {
      const agents = orchestrator.getAgents();
      expect(agents).toEqual([]);
    });
  });

  describe('Workflow Lifecycle Events', () => {
    it('should emit workflow-started event', async () => {
      const events: Array<{ id: string; goal: string }> = [];

      orchestrator.on('workflow-started', (id, goal) => {
        events.push({ id, goal });
      });

      const workflowId = await orchestrator.submitGoal('Event test goal');

      expect(events.length).toBe(1);
      expect(events[0].id).toBe(workflowId);
      expect(events[0].goal).toBe('Event test goal');
    });
  });
});
