// Using vitest globals
import { AgentRuntime, type AgentConfig } from '../../src/agents/agent-runtime.js';

// Mock fetch for tests
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('AgentRuntime', () => {
  let agentConfig: AgentConfig;

  beforeEach(() => {
    vi.clearAllMocks();

    agentConfig = {
      did: 'did:key:z6MktestAgent123',
      agentType: 'planner',
      credentials: [
        {
          type: ['VerifiableCredential', 'PlannerCapability'],
          issuer: 'did:web:authority.example.com',
          credentialSubject: { capability: 'PlannerCapability' }
        }
      ],
      brokerUrl: 'http://localhost:3000',
      maxIterations: 3
    };
  });

  describe('initialization', () => {
    it('should create agent with correct initial state', () => {
      const agent = new AgentRuntime(agentConfig);

      const state = agent.getState();
      expect(state.did).toBe(agentConfig.did);
      expect(state.agentType).toBe('aat:PlannerAgentType');
      expect(state.status).toBe('idle');
      expect(state.currentTask).toBeNull();
      expect(state.actionHistory).toHaveLength(0);
    });

    it('should generate unique agent ID', () => {
      const agent1 = new AgentRuntime(agentConfig);
      const agent2 = new AgentRuntime(agentConfig);

      expect(agent1.getId()).not.toBe(agent2.getId());
    });
  });

  describe('state management', () => {
    it('should emit state-change events', async () => {
      const agent = new AgentRuntime(agentConfig);
      const stateChanges: unknown[] = [];

      agent.on('state-change', (state) => {
        stateChanges.push(state.status);
      });

      // Mock broker responses
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            id: 'ctx-1',
            agentDID: agentConfig.did,
            agentType: 'aat:PlannerAgentType',
            affordances: [],
            expiresAt: new Date(Date.now() + 300000).toISOString()
          })
        });

      // This will fail because no affordances, but we can check state changes
      try {
        await agent.run('Test task');
      } catch {
        // Expected to fail
      }

      expect(stateChanges).toContain('running');
    });
  });

  describe('agent type mapping', () => {
    const typeTests: Array<{ input: AgentConfig['agentType']; expected: string }> = [
      { input: 'planner', expected: 'aat:PlannerAgentType' },
      { input: 'executor', expected: 'aat:ExecutorAgentType' },
      { input: 'observer', expected: 'aat:ObserverAgentType' },
      { input: 'arbiter', expected: 'aat:ArbiterAgentType' },
      { input: 'archivist', expected: 'aat:ArchivistAgentType' }
    ];

    for (const { input, expected } of typeTests) {
      it(`should map ${input} to ${expected}`, () => {
        const config = { ...agentConfig, agentType: input };
        const agent = new AgentRuntime(config);

        expect(agent.getState().agentType).toBe(expected);
      });
    }
  });

  describe('stop', () => {
    it('should reset agent state on stop', () => {
      const agent = new AgentRuntime(agentConfig);

      // Manually set some state
      const state = agent.getState();
      (agent as any).state.currentTask = 'Some task';
      (agent as any).state.status = 'running';

      agent.stop();

      const newState = agent.getState();
      expect(newState.status).toBe('idle');
      expect(newState.currentTask).toBeNull();
    });
  });
});

describe('AgentRuntime - Context Fetching', () => {
  it('should throw error when context fetch fails', async () => {
    const agent = new AgentRuntime({
      did: 'did:key:test',
      agentType: 'planner',
      credentials: [],
      brokerUrl: 'http://localhost:3000'
    });

    mockFetch.mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: 'Invalid DID' })
    });

    const result = await agent.run('Test task');

    expect(result.success).toBe(false);
    expect((result.output as any).error).toContain('Failed to fetch context');
  });
});
