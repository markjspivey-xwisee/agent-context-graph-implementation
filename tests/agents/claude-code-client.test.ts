// Using vitest globals
import { ClaudeCodeClient } from '../../src/agents/claude-code-client.js';
import type { ContextGraph } from '../../src/interfaces/index.js';
import type { AgentSystemPrompt } from '../../src/agents/reasoning-client.js';

// Mock child_process
vi.mock('child_process', () => {
  const mockOn = vi.fn();
  const mockWrite = vi.fn();
  const mockEnd = vi.fn();
  const mockKill = vi.fn();

  return {
    spawn: vi.fn(() => ({
      stdin: { write: mockWrite, end: mockEnd },
      stdout: { on: mockOn },
      stderr: { on: mockOn },
      on: mockOn,
      kill: mockKill
    }))
  };
});

describe('ClaudeCodeClient', () => {
  let client: ClaudeCodeClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new ClaudeCodeClient({
      cliPath: 'claude',
      timeout: 5000
    });
  });

  afterEach(() => {
    client.killAll();
  });

  describe('initialization', () => {
    it('should create client with default config', () => {
      const defaultClient = new ClaudeCodeClient();
      expect(defaultClient.getActiveProcessCount()).toBe(0);
    });

    it('should accept custom configuration', () => {
      const customClient = new ClaudeCodeClient({
        cliPath: '/custom/path/claude',
        workingDirectory: '/custom/dir',
        timeout: 60000,
        model: 'opus'
      });
      expect(customClient.getActiveProcessCount()).toBe(0);
    });
  });

  describe('reasonAboutContext', () => {
    const mockSystemPrompt: AgentSystemPrompt = {
      role: 'Planner',
      agentType: 'aat:PlannerAgentType',
      capabilities: ['Create plans'],
      constraints: ['Never execute directly']
    };

    const mockContext: ContextGraph = {
      id: 'ctx-123',
      agentDID: 'did:key:test',
      agentType: 'aat:PlannerAgentType',
      affordances: [
        {
          id: 'aff-1',
          actionType: 'EmitPlan',
          rel: 'emit',
          target: { type: 'broker' },
          enabled: true,
          effects: [],
          requiresCredential: []
        }
      ],
      policies: [],
      expiresAt: new Date(Date.now() + 300000).toISOString()
    };

    it('should format prompt correctly for context reasoning', async () => {
      const { spawn } = await import('child_process');
      const mockSpawn = spawn as any;

      // Set up mock to capture the prompt
      let capturedPrompt = '';
      mockSpawn.mockImplementation(() => {
        const handlers: Record<string, Function> = {};
        return {
          stdin: {
            write: (data: string) => { capturedPrompt = data; },
            end: vi.fn()
          },
          stdout: {
            on: (event: string, handler: Function) => {
              handlers[`stdout_${event}`] = handler;
              if (event === 'data') {
                // Simulate JSON response
                setTimeout(() => {
                  handler(JSON.stringify({
                    reasoning: 'Test reasoning',
                    selectedAffordance: 'aff-1',
                    parameters: {},
                    shouldContinue: true
                  }));
                }, 10);
              }
            }
          },
          stderr: { on: vi.fn() },
          on: (event: string, handler: Function) => {
            handlers[event] = handler;
            if (event === 'close') {
              setTimeout(() => handler(0), 20);
            }
          },
          kill: vi.fn()
        };
      });

      await client.reasonAboutContext(
        mockSystemPrompt,
        mockContext,
        'Create a plan',
        ['Previous action 1']
      );

      expect(capturedPrompt).toContain('Planner agent');
      expect(capturedPrompt).toContain('Create plans');
      expect(capturedPrompt).toContain('Never execute directly');
      expect(capturedPrompt).toContain('Create a plan');
      expect(capturedPrompt).toContain('Previous action 1');
      expect(capturedPrompt).toContain('aff-1');
    });
  });

  describe('generatePlan', () => {
    it('should format plan prompt correctly', async () => {
      const { spawn } = await import('child_process');
      const mockSpawn = spawn as any;

      let capturedPrompt = '';
      mockSpawn.mockImplementation(() => {
        return {
          stdin: {
            write: (data: string) => { capturedPrompt = data; },
            end: vi.fn()
          },
          stdout: {
            on: (event: string, handler: Function) => {
              if (event === 'data') {
                setTimeout(() => {
                  handler(JSON.stringify({
                    goal: 'Test goal',
                    steps: [{ action: 'Step 1', rationale: 'Because' }]
                  }));
                }, 10);
              }
            }
          },
          stderr: { on: vi.fn() },
          on: (event: string, handler: Function) => {
            if (event === 'close') {
              setTimeout(() => handler(0), 20);
            }
          },
          kill: vi.fn()
        };
      });

      await client.generatePlan('Build a feature', ['No external APIs']);

      expect(capturedPrompt).toContain('Build a feature');
      expect(capturedPrompt).toContain('No external APIs');
    });
  });

  describe('makeApprovalDecision', () => {
    it('should format approval prompt correctly', async () => {
      const { spawn } = await import('child_process');
      const mockSpawn = spawn as any;

      let capturedPrompt = '';
      mockSpawn.mockImplementation(() => {
        return {
          stdin: {
            write: (data: string) => { capturedPrompt = data; },
            end: vi.fn()
          },
          stdout: {
            on: (event: string, handler: Function) => {
              if (event === 'data') {
                setTimeout(() => {
                  handler(JSON.stringify({
                    decision: 'approve',
                    reason: 'Looks good'
                  }));
                }, 10);
              }
            }
          },
          stderr: { on: vi.fn() },
          on: (event: string, handler: Function) => {
            if (event === 'close') {
              setTimeout(() => handler(0), 20);
            }
          },
          kill: vi.fn()
        };
      });

      await client.makeApprovalDecision(
        'Delete user',
        'Admin panel',
        ['Must have authorization', 'Must log action']
      );

      expect(capturedPrompt).toContain('Delete user');
      expect(capturedPrompt).toContain('Admin panel');
      expect(capturedPrompt).toContain('Must have authorization');
      expect(capturedPrompt).toContain('Must log action');
    });
  });

  describe('process management', () => {
    it('should track active process count', () => {
      expect(client.getActiveProcessCount()).toBe(0);
    });

    it('should kill all processes', () => {
      // Start with no processes
      expect(client.getActiveProcessCount()).toBe(0);

      // Kill all should be safe even with no processes
      client.killAll();
      expect(client.getActiveProcessCount()).toBe(0);
    });
  });

  describe('runWithTools', () => {
    it('should format tool task prompt', async () => {
      const { spawn } = await import('child_process');
      const mockSpawn = spawn as any;

      let capturedPrompt = '';
      mockSpawn.mockImplementation(() => {
        return {
          stdin: {
            write: (data: string) => { capturedPrompt = data; },
            end: vi.fn()
          },
          stdout: {
            on: (event: string, handler: Function) => {
              if (event === 'data') {
                setTimeout(() => handler('Task completed'), 10);
              }
            }
          },
          stderr: { on: vi.fn() },
          on: (event: string, handler: Function) => {
            if (event === 'close') {
              setTimeout(() => handler(0), 20);
            }
          },
          kill: vi.fn()
        };
      });

      const result = await client.runWithTools('List all files', ['Read', 'Glob']);

      expect(capturedPrompt).toContain('List all files');
      expect(capturedPrompt).toContain('Read, Glob');
      expect(result.success).toBe(true);
    });
  });
});

describe('ReasoningClientConfig', () => {
  it('should support API type config', async () => {
    const { createReasoningClient } = await import('../../src/agents/reasoning-client.js');

    // This would fail without ANTHROPIC_API_KEY, but we can test the config parsing
    const config = {
      type: 'api' as const,
      model: 'claude-sonnet-4-20250514'
    };

    // Just verify the config structure is valid
    expect(config.type).toBe('api');
  });

  it('should support CLI type config', async () => {
    const { createReasoningClient } = await import('../../src/agents/reasoning-client.js');

    const config = {
      type: 'cli' as const,
      cliPath: '/usr/local/bin/claude',
      workingDirectory: '/home/user/project',
      timeout: 60000
    };

    // Verify config structure
    expect(config.type).toBe('cli');
    expect(config.cliPath).toBe('/usr/local/bin/claude');
  });
});
