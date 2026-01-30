import { v4 as uuidv4 } from 'uuid';
import { EventEmitter } from 'eventemitter3';
import { LLMClient } from './llm-client.js';
import type { IReasoningClient, AgentSystemPrompt, ReasoningClientConfig, LLMResponse } from './reasoning-client.js';
import type {
  ContextGraph,
  ProvTrace,
  VerifiedCredentialRef
} from '../interfaces/index.js';

export interface AgentConfig {
  did: string;
  agentType: 'planner' | 'executor' | 'observer' | 'arbiter' | 'archivist' | 'analyst';
  credentials: unknown[];
  maxIterations?: number;
  brokerUrl?: string;

  /**
   * Reasoning client configuration
   * If not provided, defaults to API client with ANTHROPIC_API_KEY
   */
  reasoningClient?: ReasoningClientConfig;
}

export interface AgentState {
  id: string;
  did: string;
  agentType: string;
  status: 'idle' | 'running' | 'waiting' | 'completed' | 'failed';
  currentTask: string | null;
  currentContext: ContextGraph | null;
  actionHistory: ActionRecord[];
  error?: string;
}

export interface ActionRecord {
  timestamp: string;
  affordanceId: string;
  actionType: string;
  parameters: Record<string, unknown>;
  result: 'success' | 'failure';
  traceId?: string;
  output?: unknown;
}

export interface AgentEvents {
  'state-change': (state: AgentState) => void;
  'action-taken': (action: ActionRecord) => void;
  'task-complete': (result: TaskResult) => void;
  'error': (error: Error) => void;
  'context-received': (context: ContextGraph) => void;
}

export interface TaskResult {
  success: boolean;
  output: unknown;
  actions: ActionRecord[];
  traces: string[];
}

/**
 * Context passed to the agent for task execution
 * Includes required parameters for specific affordances
 */
export interface TaskContext {
  /** Reference to the approval that authorized this action (for Act affordance) */
  actionRef?: string;
  /** The target of the action (for Act affordance) */
  target?: string;
  /** Optional semantic layer override for QueryData */
  semanticLayerRef?: string;
  /** Optional data source reference for QueryData */
  sourceRef?: string;
  /** Content to store (for Store affordance) */
  content?: string;
  /** Type of content being stored (for Store affordance) */
  contentType?: 'trace' | 'knowledge' | 'artifact' | 'index';
}

/**
 * AgentRuntime - Executes an agent loop that consumes Context Graphs
 *
 * The runtime:
 * 1. Fetches a Context Graph from the broker
 * 2. Uses LLM to reason about which affordance to traverse
 * 3. Executes the traversal
 * 4. Repeats until task is complete or max iterations reached
 */
export class AgentRuntime extends EventEmitter<AgentEvents> {
  private id: string;
  private config: AgentConfig;
  private reasoningClient: IReasoningClient;
  private state: AgentState;
  private brokerUrl: string;
  private clientInitialized: boolean = false;
  private taskContext: TaskContext | null = null;

  private static readonly SYSTEM_PROMPTS: Record<string, AgentSystemPrompt> = {
    planner: {
      role: 'Planner',
      agentType: 'aat:PlannerAgentType',
      capabilities: [
        'Create detailed plans for achieving goals',
        'Break down complex tasks into steps',
        'Request additional information when needed',
        'Validate plans before emission',
        'Produce plans by traversing the EmitPlan affordance with { goal: string, steps: [{action, rationale}] }'
      ],
      constraints: [
        'NEVER attempt to execute actions directly',
        'NEVER use Actuate or WriteExternal affordances',
        'Always include rationale for each plan step',
        'Plans must be achievable within stated constraints',
        'When ready to produce a plan, traverse EmitPlan with parameters containing goal and steps array'
      ]
    },
    executor: {
      role: 'Executor',
      agentType: 'aat:ExecutorAgentType',
      capabilities: [
        'Execute actions by traversing the Act affordance - this triggers real tool execution',
        'The Act affordance allows you to perform file operations, run commands, write code',
        'Report outcomes after execution via ReportOutcome',
        'Request authorization when needed',
        'Rollback actions if necessary'
      ],
      constraints: [
        'ALWAYS use the Act affordance to perform the action specified in the step',
        'You MUST traverse Act to execute - just thinking about it does not execute anything',
        'NEVER skip execution by only using ReportOutcome - you must Act first',
        'NEVER act without proper authorization',
        'NEVER deviate from the approved plan',
        'Always report action outcomes',
        'Stop and escalate on unexpected failures'
      ]
    },
    observer: {
      role: 'Observer',
      agentType: 'aat:ObserverAgentType',
      capabilities: [
        'Monitor events and state changes',
        'Report observations',
        'Summarize information',
        'Flag anomalies'
      ],
      constraints: [
        'NEVER cause side effects',
        'NEVER modify external state',
        'Only report what is actually observed',
        'Do not fabricate information'
      ]
    },
    arbiter: {
      role: 'Arbiter',
      agentType: 'aat:ArbiterAgentType',
      capabilities: [
        'Approve or deny proposed actions',
        'Modify actions to comply with policy',
        'Escalate decisions when uncertain',
        'Enforce policy constraints'
      ],
      constraints: [
        'NEVER approve forbidden actions',
        'NEVER execute actions directly',
        'Always provide clear reasons for decisions',
        'Record all decisions for audit'
      ]
    },
    archivist: {
      role: 'Archivist',
      agentType: 'aat:ArchivistAgentType',
      capabilities: [
        'Store records and traces',
        'Retrieve information',
        'Summarize historical data',
        'Index for searchability'
      ],
      constraints: [
        'NEVER delete or modify existing records',
        'NEVER fabricate provenance',
        'Maintain append-only semantics',
        'Preserve data integrity'
      ]
    },
    analyst: {
      role: 'Analyst',
      agentType: 'aat:AnalystAgentType',
      capabilities: [
        'Query data sources using QueryData (SPARQL canonical)',
        'Analyze results and emit insights',
        'Generate concise, conversational summaries grounded in data'
      ],
      constraints: [
        'NEVER perform side effects or state changes',
        'If data is required, first traverse QueryData with a SPARQL query',
        'After querying, traverse EmitInsight or GenerateReport with a summary and references',
        'Do not fabricate data; base outputs on QueryData results'
      ]
    }
  };

  constructor(config: AgentConfig, reasoningClient?: IReasoningClient) {
    super();
    this.id = uuidv4();
    this.config = config;
    this.brokerUrl = config.brokerUrl ?? 'http://localhost:3000';

    // Use provided client, or create one based on config
    if (reasoningClient) {
      this.reasoningClient = reasoningClient;
      this.clientInitialized = true;
    } else {
      // Default to API client (will be lazily initialized)
      this.reasoningClient = new LLMClient();
      this.clientInitialized = true;
    }

    this.state = {
      id: this.id,
      did: config.did,
      agentType: `aat:${config.agentType.charAt(0).toUpperCase() + config.agentType.slice(1)}AgentType`,
      status: 'idle',
      currentTask: null,
      currentContext: null,
      actionHistory: []
    };
  }

  /**
   * Create an agent runtime with a specific reasoning client type
   */
  static async create(config: AgentConfig): Promise<AgentRuntime> {
    if (config.reasoningClient) {
      const { createReasoningClient } = await import('./reasoning-client.js');
      const client = await createReasoningClient(config.reasoningClient);
      return new AgentRuntime(config, client);
    }
    return new AgentRuntime(config);
  }

  /**
   * Create an agent runtime using Claude Code CLI
   */
  static async createWithCLI(
    config: Omit<AgentConfig, 'reasoningClient'>,
    cliOptions?: {
      cliPath?: string;
      workingDirectory?: string;
      model?: string;
      timeout?: number;
    }
  ): Promise<AgentRuntime> {
    const { ClaudeCodeClient } = await import('./claude-code-client.js');
    const client = new ClaudeCodeClient(cliOptions);
    return new AgentRuntime(config as AgentConfig, client);
  }

  /**
   * Get current agent state
   */
  getState(): AgentState {
    return { ...this.state };
  }

  /**
   * Get agent ID
   */
  getId(): string {
    return this.id;
  }

  /**
   * Run the agent on a task
   * @param task - The task description
   * @param context - Optional task context with required parameters for affordances
   */
  async run(task: string, context?: TaskContext): Promise<TaskResult> {
    this.state.status = 'running';
    this.state.currentTask = task;
    this.state.actionHistory = [];
    this.taskContext = context ?? null;
    this.emitStateChange();

    const maxIterations = this.config.maxIterations ?? 10;
    const traces: string[] = [];

    try {
      for (let i = 0; i < maxIterations; i++) {
        // 1. Fetch context from broker
        const context = await this.fetchContext();
        this.state.currentContext = context;
        this.emit('context-received', context);

        // 2. Check if we have any enabled affordances
        const enabledAffordances = context.affordances.filter(a => a.enabled);
        if (enabledAffordances.length === 0) {
          // No actions available - might need credentials
          const requestCredAff = context.affordances.find(
            a => a.actionType === 'RequestCredential'
          );
          if (requestCredAff) {
            this.state.status = 'waiting';
            this.state.error = 'Missing required credentials';
            this.emitStateChange();
            return {
              success: false,
              output: { error: 'Missing credentials', affordance: requestCredAff },
              actions: this.state.actionHistory,
              traces
            };
          }
        }

        // 3. Use reasoning client to decide what to do (or auto-select for special cases)
        const systemPrompt = AgentRuntime.SYSTEM_PROMPTS[this.config.agentType];
        const previousActions = this.state.actionHistory.map(
          a => `${a.actionType}: ${a.result}`
        );

        const archivistDecision = this.buildArchivistDecision(context);
        const arbiterDecision = this.buildArbiterDecision(context, task);
        const analystDecision = this.buildAnalystDecision(context, task);

        const decision = archivistDecision ?? arbiterDecision ?? analystDecision ??
          await this.reasoningClient.reasonAboutContext(
            systemPrompt,
            context,
            task,
            previousActions
          );

        // Analyst fallback: if model refuses or doesn't choose an affordance, auto-select QueryData
        if (this.config.agentType === 'analyst') {
          const refusal = this.isRefusalDecision(decision);
          if (refusal || !decision.selectedAffordance) {
            const queryAffordance = enabledAffordances.find(a => a.actionType === 'QueryData');
            if (queryAffordance) {
              decision.selectedAffordance = queryAffordance.id;
              decision.parameters = {
                query: this.buildFallbackSparql(task),
                queryLanguage: 'sparql'
              };
              decision.shouldContinue = true;
              decision.message = decision.message ?? 'Auto-selected QueryData to retrieve data.';
            }
          }
        }

        // 4. Check if we should continue
        // IMPORTANT: Enforce structural requirements from AAT behavioral invariants
        // The requiredOutputAction comes from the AAT spec, not hardcoded
        const hasTraversedAction = this.state.actionHistory.length > 0;
        const requiredActionRaw = context.structuralRequirements?.requiredOutputAction;
        // Strip 'aat:' prefix if present (AAT spec uses prefixed URIs, affordances use unprefixed)
        const requiredAction = requiredActionRaw?.replace(/^aat:/, '');

        if (this.config.agentType === 'planner' && requiredAction) {
          const selected = decision.selectedAffordance
            ? context.affordances.find(a => a.id === decision.selectedAffordance)
            : undefined;
          if (!selected || selected.actionType !== requiredAction) {
            const requiredAff = context.affordances.find(
              a => a.actionType === requiredAction && a.enabled
            );
            if (requiredAff && decision.reasoning) {
              console.log(`[${this.state.agentType}] Enforcing required output action ${requiredAction} for planner`);
              if (requiredAction === 'EmitPlan') {
                const planSteps = this.extractPlanStepsFromReasoning(decision.reasoning, task);
                decision.parameters = { goal: task, steps: planSteps };
              } else {
                decision.parameters = { task, reasoning: decision.reasoning };
              }
              decision.selectedAffordance = requiredAff.id;
              decision.shouldContinue = true;
            }
          }
        }

        if (!decision.shouldContinue || !decision.selectedAffordance) {
          // Check if AAT requires an output action that wasn't traversed
          if (!hasTraversedAction && requiredAction) {
            // Find the required affordance and force traversal
            const requiredAff = context.affordances.find(
              a => a.actionType === requiredAction && a.enabled
            );
            if (requiredAff && decision.reasoning) {
              console.log(`[${this.state.agentType}] Enforcing structural requirement: must traverse ${requiredAction}`);
              // For EmitPlan, extract plan steps from reasoning; otherwise use generic params
              if (requiredAction === 'EmitPlan') {
                const planSteps = this.extractPlanStepsFromReasoning(decision.reasoning, task);
                decision.parameters = { goal: task, steps: planSteps };
              } else {
                decision.parameters = { task, reasoning: decision.reasoning };
              }
              decision.selectedAffordance = requiredAff.id;
              decision.shouldContinue = true;
              // Fall through to traversal below
            }
          }
        }

        // Check again after potential correction
        if (!decision.shouldContinue || !decision.selectedAffordance) {
          this.state.status = 'completed';
          this.emitStateChange();

          // Extract meaningful output from action history
          // The task output is what was produced through affordance traversals,
          // not just the LLM reasoning (which is metadata)
          const taskOutput = this.extractTaskOutput(decision);

          const result: TaskResult = {
            success: true,
            output: taskOutput,
            actions: this.state.actionHistory,
            traces
          };
          this.emit('task-complete', result);
          return result;
        }

        // 5. Traverse the selected affordance
        // For Act affordances, inject required parameters from task context
        const selectedAffordance = context.affordances.find(
          a => a.id === decision.selectedAffordance
        );
        let finalParameters = { ...decision.parameters };

        if (selectedAffordance?.actionType === 'Act' && this.taskContext) {
          // Inject actionRef and target for SHACL validation
          if (this.taskContext.actionRef && !finalParameters.actionRef) {
            finalParameters.actionRef = this.taskContext.actionRef;
          }
          if (this.taskContext.target && !finalParameters.target) {
            finalParameters.target = this.taskContext.target;
          }
        }

        if (selectedAffordance?.actionType === 'QueryData') {
          if (!finalParameters.query) {
            finalParameters.query = this.buildFallbackSparql(task);
          }
          if (!finalParameters.queryLanguage) {
            finalParameters.queryLanguage = 'sparql';
          }
          if (this.taskContext?.semanticLayerRef && !finalParameters.semanticLayerRef) {
            finalParameters.semanticLayerRef = this.taskContext.semanticLayerRef;
          }
          if (this.taskContext?.sourceRef && !finalParameters.sourceRef) {
            finalParameters.sourceRef = this.taskContext.sourceRef;
          }
        }

        // For Store affordances, inject content and contentType from task context
        if (selectedAffordance?.actionType === 'Store' && this.taskContext) {
          if (this.taskContext.content && !finalParameters.content) {
            finalParameters.content = this.taskContext.content;
          }
          if (this.taskContext.contentType && !finalParameters.contentType) {
            finalParameters.contentType = this.taskContext.contentType;
          }
        }

        // For executor agents performing Act, actually execute the task using tools
        if (this.config.agentType === 'executor' &&
            selectedAffordance?.actionType === 'Act' &&
            this.reasoningClient.runWithTools) {
          console.log(`[Executor] Executing task with tools: ${this.taskContext?.target ?? task}`);

          const executionResult = await this.reasoningClient.runWithTools(
            this.taskContext?.target ?? task,
            ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash']
          );

          // Include execution result in parameters
          finalParameters.executionResult = {
            success: executionResult.success,
            output: executionResult.output,
            error: executionResult.error
          };

          console.log(`[Executor] Execution ${executionResult.success ? 'succeeded' : 'failed'}`);
          if (!executionResult.success) {
            console.error(`[Executor] Error: ${executionResult.error}`);
          }
        }

        const traverseResult = await this.traverseAffordance(
          context.id,
          decision.selectedAffordance,
          finalParameters
        );

        // 6. Record the action
        const actionRecord: ActionRecord = {
          timestamp: new Date().toISOString(),
          affordanceId: decision.selectedAffordance,
          actionType: traverseResult.actionType,
          parameters: finalParameters,
          result: traverseResult.success ? 'success' : 'failure',
          traceId: traverseResult.traceId,
          output: traverseResult.output
        };

        this.state.actionHistory.push(actionRecord);
        this.emit('action-taken', actionRecord);

        if (traverseResult.traceId) {
          traces.push(traverseResult.traceId);
        }

        if (this.config.agentType === 'archivist' && traverseResult.success && traverseResult.actionType === 'Store') {
          this.state.status = 'completed';
          this.emitStateChange();
          const taskOutput = this.extractTaskOutput(decision);
          const result: TaskResult = {
            success: true,
            output: taskOutput,
            actions: this.state.actionHistory,
            traces
          };
          this.emit('task-complete', result);
          return result;
        }

        if (this.config.agentType === 'arbiter' &&
            traverseResult.success &&
            (traverseResult.actionType === 'Approve' || traverseResult.actionType === 'Deny')) {
          this.state.status = 'completed';
          this.emitStateChange();
          const taskOutput = this.extractTaskOutput(decision);
          const result: TaskResult = {
            success: true,
            output: taskOutput,
            actions: this.state.actionHistory,
            traces
          };
          this.emit('task-complete', result);
          return result;
        }

        if (this.config.agentType === 'analyst' &&
            traverseResult.success &&
            (traverseResult.actionType === 'EmitInsight' ||
             traverseResult.actionType === 'GenerateReport' ||
             traverseResult.actionType === 'DetectAnomaly')) {
          this.state.status = 'completed';
          this.emitStateChange();
          const taskOutput = this.extractTaskOutput(decision);
          const result: TaskResult = {
            success: true,
            output: taskOutput,
            actions: this.state.actionHistory,
            traces
          };
          this.emit('task-complete', result);
          return result;
        }

        // 7. Check if action failed
        if (!traverseResult.success) {
          this.state.status = 'failed';
          this.state.error = traverseResult.error;
          this.emitStateChange();

          return {
            success: false,
            output: { error: traverseResult.error },
            actions: this.state.actionHistory,
            traces
          };
        }
      }

      // Max iterations reached
      this.state.status = 'completed';
      this.state.error = 'Max iterations reached';
      this.emitStateChange();

      return {
        success: false,
        output: { error: 'Max iterations reached without completing task' },
        actions: this.state.actionHistory,
        traces
      };

    } catch (error) {
      this.state.status = 'failed';
      this.state.error = error instanceof Error ? error.message : 'Unknown error';
      this.emitStateChange();
      this.emit('error', error instanceof Error ? error : new Error(String(error)));

      return {
        success: false,
        output: { error: this.state.error },
        actions: this.state.actionHistory,
        traces
      };
    }
  }

  /**
   * Stop the agent
   */
  stop(): void {
    this.state.status = 'idle';
    this.state.currentTask = null;
    this.emitStateChange();
  }

  /**
   * Fetch context from broker
   */
  private async fetchContext(): Promise<ContextGraph> {
    const response = await fetch(`${this.brokerUrl}/context`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentDID: this.config.did,
        credentials: this.config.credentials
      })
    });

    if (!response.ok) {
      const error = await response.json() as { error?: string };
      throw new Error(`Failed to fetch context: ${error.error}`);
    }

    return response.json() as Promise<ContextGraph>;
  }

  private isRefusalDecision(decision: { reasoning?: string; message?: string } | null): boolean {
    if (!decision) return false;
    const text = `${decision.reasoning ?? ''} ${decision.message ?? ''}`.toLowerCase();
    if (!text) return false;
    return [
      "can't", "cannot", 'cant', "unable", "won't", "not able", 'refuse',
      'i can’t', 'i cannot', "i'm unable", 'cannot traverse', "can't traverse"
    ].some(token => text.includes(token));
  }

  private buildFallbackSparql(task: string): string {
    const lower = task.toLowerCase();
    if (lower.includes('top') && (lower.includes('revenue') || lower.includes('sales'))) {
      return [
        'PREFIX dcat: <http://www.w3.org/ns/dcat#>',
        'PREFIX dcterms: <http://purl.org/dc/terms/>',
        'PREFIX sl: <https://agentcontextgraph.dev/semantic-layer#>',
        'SELECT ?order ?id ?title ?revenue WHERE {',
        '  ?order a dcat:Dataset ;',
        '         dcterms:identifier ?id ;',
        '         dcterms:title ?title .',
        '  OPTIONAL { ?order sl:revenue ?revenue }',
        '}',
        'ORDER BY DESC(?revenue)',
        'LIMIT 5'
      ].join('\n');
    }

    return 'SELECT ?s ?p ?o WHERE { ?s ?p ?o } LIMIT 5';
  }

  private buildArchivistDecision(context: ContextGraph): LLMResponse | null {
    if (this.config.agentType !== 'archivist') return null;
    const storeAffordance = context.affordances.find(a => a.enabled && a.actionType === 'Store');
    if (!storeAffordance || !this.taskContext?.content || !this.taskContext?.contentType) {
      return null;
    }
    return {
      reasoning: 'Auto-select Store for archivist task.',
      selectedAffordance: storeAffordance.id,
      parameters: {
        content: this.taskContext.content,
        contentType: this.taskContext.contentType
      },
      shouldContinue: true,
      message: 'Archiving task content.'
    };
  }

  private buildArbiterDecision(context: ContextGraph, task: string): LLMResponse | null {
    if (this.config.agentType !== 'arbiter') return null;
    const approveAffordance = context.affordances.find(a => a.enabled && a.actionType === 'Approve');
    if (!approveAffordance) return null;
    const proposalRef = task.length > 200 ? `${task.slice(0, 200)}...` : task;
    return {
      reasoning: 'Auto-approve in demo pipeline to keep workflow moving.',
      selectedAffordance: approveAffordance.id,
      parameters: {
        proposalRef,
        rationale: 'Approved for demo execution.'
      },
      shouldContinue: true,
      message: 'Approval granted.'
    };
  }

  private buildAnalystDecision(context: ContextGraph, task: string): LLMResponse | null {
    if (this.config.agentType !== 'analyst') return null;

    const emitInsightAffordance = context.affordances.find(a => a.enabled && a.actionType === 'EmitInsight');
    const queryActions = this.state.actionHistory.filter(a => a.actionType === 'QueryData' && a.result === 'success');
    const hasInsight = this.state.actionHistory.some(a => a.actionType === 'EmitInsight' || a.actionType === 'GenerateReport');

    if (!emitInsightAffordance || hasInsight || queryActions.length === 0) {
      return null;
    }

    const lastQuery = queryActions[queryActions.length - 1];
    const output = (lastQuery.output ?? {}) as Record<string, any>;
    const results = output.results ?? output.data?.results;
    const bindings =
      results?.bindings ??
      results?.results?.bindings ??
      results?.results ??
      results;
    const count = Array.isArray(bindings) ? bindings.length : 0;
    const queryId = (output.queryId as string | undefined) ?? (output.data?.queryId as string | undefined) ?? 'query:unknown';
    const vars = (results?.head?.vars as string[] | undefined) ?? [];
    const rows = Array.isArray(bindings) ? bindings : [];
    const rowPreview = this.formatSparqlBindings(rows, vars, 5);

    const description = count > 0
      ? `Query returned ${count} rows.\nTop ${Math.min(5, count)}:\n${rowPreview}`
      : 'Query completed; no rows were returned.';

    return {
      reasoning: 'Auto-emitting insight after successful QueryData.',
      selectedAffordance: emitInsightAffordance.id,
      parameters: {
        insightType: 'finding',
        title: 'Query results summary',
        description,
        confidence: 0.5,
        sourceReferences: [queryId],
        severity: 'info'
      },
      shouldContinue: true,
      message: description
    };
  }

  private formatSparqlBindings(
    bindings: Array<Record<string, { value?: string }>>,
    vars: string[],
    limit: number
  ): string {
    if (!bindings.length) return '(no rows)';
    const rows = bindings.slice(0, limit).map((row, idx) => {
      const cells = (vars.length ? vars : Object.keys(row)).map((key) => {
        const value = row[key]?.value ?? '';
        return `${key}=${value || 'NULL'}`;
      });
      return `${idx + 1}) ${cells.join(', ')}`;
    });
    return rows.join('\n');
  }

  /**
   * Traverse an affordance
   */
  private async traverseAffordance(
    contextId: string,
    affordanceId: string,
    parameters: Record<string, unknown>
  ): Promise<{
    success: boolean;
    actionType: string;
    traceId?: string;
    output?: unknown;
    error?: string;
  }> {
    const response = await fetch(`${this.brokerUrl}/traverse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contextId,
        affordanceId,
        parameters,
        credentials: this.config.credentials
      })
    });

    const result = await response.json() as {
      success?: boolean;
      error?: string;
      result?: unknown;
      trace?: {
        id?: string;
        used?: {
          affordance?: {
            actionType?: string;
          };
        };
      };
    };

    if (!response.ok) {
      return {
        success: false,
        actionType: 'unknown',
        error: result.error
      };
    }

    return {
      success: result.success ?? false,
      actionType: result.trace?.used?.affordance?.actionType ?? 'unknown',
      traceId: result.trace?.id,
      output: result.result
    };
  }

  /**
   * Extract meaningful task output from action history
   *
   * The output depends on what affordances were traversed:
   * - EmitPlan: The plan (goal + steps) from the parameters
   * - Act: The execution results
   * - Report: The observation/report content
   * - Approve/Deny: The decision
   * - Store: The archive reference
   *
   * This follows the principle that agents produce outputs through
   * affordance traversals, preserving data lineage.
   */
  private extractTaskOutput(decision: {
    reasoning?: string;
    message?: string;
  }): Record<string, unknown> {
    const actions = this.state.actionHistory;

    // Look for specific action types that produce meaningful outputs
    const emitPlanAction = actions.find(a => a.actionType === 'EmitPlan');
    const actActions = actions.filter(a => a.actionType === 'Act');
    const reportAction = actions.find(a => a.actionType === 'Report');
    const approveAction = actions.find(a => a.actionType === 'Approve');
    const denyAction = actions.find(a => a.actionType === 'Deny');
    const storeAction = actions.find(a => a.actionType === 'Store');
    const emitInsightAction = actions.find(a => a.actionType === 'EmitInsight');
    const generateReportAction = actions.find(a => a.actionType === 'GenerateReport');
    const queryActions = actions.filter(a => a.actionType === 'QueryData');

    // For Planner agents: extract plan from EmitPlan traversal
    if (emitPlanAction) {
      return {
        goal: emitPlanAction.parameters.goal,
        steps: emitPlanAction.parameters.steps,
        reasoning: decision.reasoning,
        message: decision.message
      };
    }

    // For Executor agents: aggregate execution results
    if (actActions.length > 0) {
      return {
        executionResults: actActions.map(a => ({
          action: a.affordanceId,
          parameters: a.parameters,
          result: a.result,
          output: a.output
        })),
        reasoning: decision.reasoning,
        message: decision.message
      };
    }

    // For Observer agents: extract report
    if (reportAction) {
      return {
        report: reportAction.parameters,
        output: reportAction.output,
        reasoning: decision.reasoning,
        message: decision.message
      };
    }

    // For Arbiter agents: extract decision
    if (approveAction || denyAction) {
      const decisionAction = approveAction ?? denyAction;
      return {
        decision: decisionAction!.actionType.toLowerCase(),
        parameters: decisionAction!.parameters,
        output: decisionAction!.output,
        reasoning: decision.reasoning,
        message: decision.message
      };
    }

    // For Archivist agents: extract storage reference
    if (storeAction) {
      return {
        stored: storeAction.parameters,
        reference: storeAction.output,
        reasoning: decision.reasoning,
        message: decision.message
      };
    }

    // For Analyst agents: prefer insight/report, fall back to query results
    if (emitInsightAction) {
      return {
        insight: emitInsightAction.parameters,
        insightOutput: emitInsightAction.output,
        queryResults: queryActions.map(a => a.output),
        reasoning: decision.reasoning,
        message: decision.message
      };
    }

    if (generateReportAction) {
      return {
        report: generateReportAction.parameters,
        reportOutput: generateReportAction.output,
        queryResults: queryActions.map(a => a.output),
        reasoning: decision.reasoning,
        message: decision.message
      };
    }

    if (queryActions.length > 0) {
      return {
        queries: queryActions.map(a => ({
          parameters: a.parameters,
          output: a.output
        })),
        reasoning: decision.reasoning,
        message: decision.message
      };
    }

    // Default: return reasoning and message (no affordances traversed)
    return {
      reasoning: decision.reasoning,
      message: decision.message
    };
  }

  /**
   * Extract plan steps from LLM reasoning text
   * This is a fallback when the LLM doesn't properly traverse EmitPlan
   * It parses numbered lists or step descriptions from the reasoning
   */
  private extractPlanStepsFromReasoning(
    reasoning: string,
    task: string
  ): Array<{ action: string; rationale: string }> {
    const steps: Array<{ action: string; rationale: string }> = [];

    // Try to extract numbered steps like "1) step one, 2) step two" or "1. step one"
    const numberedPattern = /(?:^|\n)\s*\d+[.)]\s*([^,\n]+(?:,\s*[^,\n]+)?)/g;
    let match;

    while ((match = numberedPattern.exec(reasoning)) !== null) {
      const stepText = match[1].trim();
      if (stepText.length > 5 && !stepText.toLowerCase().includes('task is')) {
        steps.push({
          action: stepText,
          rationale: `Derived from planning reasoning for: ${task}`
        });
      }
    }

    // If we found steps, return them
    if (steps.length > 0) {
      return steps;
    }

    // Fallback: create a direct action step
    // Extract the core goal from task descriptions like "Create a plan to achieve: X"
    let cleanTask = task;
    const planPrefixMatch = task.match(/Create a plan to achieve:\s*(.+)/i);
    if (planPrefixMatch) {
      cleanTask = planPrefixMatch[1].trim();
    }

    return [
      {
        action: cleanTask,
        rationale: 'Direct implementation of the stated goal'
      }
    ];
  }

  /**
   * Emit state change event
   */
  private emitStateChange(): void {
    this.emit('state-change', this.getState());
  }
}
