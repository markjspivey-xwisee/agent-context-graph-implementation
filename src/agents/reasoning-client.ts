import type { ContextGraph } from '../interfaces/index.js';

/**
 * Common interface for agent reasoning clients
 * Both LLMClient (API) and ClaudeCodeClient (CLI) implement this interface
 */
export interface IReasoningClient {
  /**
   * Reason about what action to take given a context
   */
  reasonAboutContext(
    systemPrompt: AgentSystemPrompt,
    context: ContextGraph,
    task: string,
    previousActions?: string[]
  ): Promise<LLMResponse>;

  /**
   * Generate a plan for a complex task
   */
  generatePlan(
    task: string,
    constraints?: string[]
  ): Promise<{ goal: string; steps: Array<{ action: string; rationale: string }> }>;

  /**
   * Summarize observations
   */
  summarizeObservations(
    observations: string[],
    context: string
  ): Promise<string>;

  /**
   * Make an approval decision
   */
  makeApprovalDecision(
    proposedAction: string,
    context: string,
    policies: string[]
  ): Promise<{ decision: 'approve' | 'deny' | 'modify'; reason: string; modification?: string }>;

  /**
   * Execute a task using tools (for executors)
   * Returns the actual output of executing the task
   */
  runWithTools?(
    task: string,
    allowedTools?: string[]
  ): Promise<{ success: boolean; output: string; error?: string }>;
}

export interface LLMResponse {
  reasoning: string;
  selectedAffordance: string | null;
  parameters: Record<string, unknown>;
  shouldContinue: boolean;
  message?: string;
}

export interface AgentSystemPrompt {
  role: string;
  agentType: string;
  capabilities: string[];
  constraints: string[];
}

/**
 * Configuration for creating a reasoning client
 */
export interface ReasoningClientConfig {
  /**
   * Type of client: 'api' for API-based reasoning, 'cli' for CLI-based reasoning
   */
  type: 'api' | 'cli';

  /**
   * Provider to use (defaults: api->anthropic, cli->claude-cli)
   */
  provider?: 'anthropic' | 'openai' | 'claude-cli' | 'codex-cli';

  /**
   * API key for API-based providers
   */
  apiKey?: string;

  /**
   * Model to use
   */
  model?: string;

  /**
   * Base URL for API-based providers
   */
  baseUrl?: string;

  /**
   * Path to Claude CLI executable (for 'cli' type)
   */
  cliPath?: string;

  /**
   * Working directory for CLI processes
   */
  workingDirectory?: string;

  /**
   * Timeout in milliseconds
   */
  timeout?: number;

  /**
   * Additional CLI flags
   */
  additionalFlags?: string[];

  /**
   * Sandbox mode for CLI providers
   */
  sandbox?: string;
}

/**
 * Create a reasoning client based on configuration
 */
export async function createReasoningClient(
  config: ReasoningClientConfig
): Promise<IReasoningClient> {
  const provider = (config.provider ?? (config.type === 'cli' ? 'claude-cli' : 'anthropic')).toLowerCase();

  if (config.type === 'cli') {
    if (provider === 'codex-cli' || provider === 'codex') {
      const { CodexCLIClient } = await import('./codex-cli-client.js');
      return new CodexCLIClient({
        cliPath: config.cliPath,
        workingDirectory: config.workingDirectory,
        timeout: config.timeout,
        model: config.model,
        additionalFlags: config.additionalFlags,
        sandbox: config.sandbox
      });
    }
    const { ClaudeCodeClient } = await import('./claude-code-client.js');
    return new ClaudeCodeClient({
      cliPath: config.cliPath,
      workingDirectory: config.workingDirectory,
      timeout: config.timeout,
      model: config.model,
      additionalFlags: config.additionalFlags
    });
  }

  if (provider === 'openai') {
    const { OpenAIClient } = await import('./openai-client.js');
    return new OpenAIClient(config.apiKey, config.model, config.baseUrl);
  }

  const { LLMClient } = await import('./llm-client.js');
  return new LLMClient(config.apiKey, config.model);
}
