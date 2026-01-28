import { v4 as uuidv4 } from 'uuid';
import { EventEmitter } from 'eventemitter3';
import { AgentRuntime, type AgentConfig, type TaskResult } from './agent-runtime.js';
import { TaskManager, type Task } from './task-manager.js';
import { LLMClient } from './llm-client.js';
import { ClaudeCodeClient, type ClaudeCodeClientConfig } from './claude-code-client.js';
import type { IReasoningClient } from './reasoning-client.js';
import type { IAATRegistry, ParallelizationRules, ConcurrencyPolicy, ResourceLimits } from '../interfaces/index.js';
import { EnclaveService, type ExecutionEnclave } from '../services/enclave-service.js';
import { CheckpointStore, type ContextCheckpoint, type AgentCheckpointState } from '../services/checkpoint-store.js';

/**
 * AAT-aware Concurrent Orchestrator Configuration
 */
export interface ConcurrentOrchestratorConfig {
  brokerUrl: string;
  anthropicApiKey?: string;
  useClaudeCodeCLI?: boolean;
  cliConfig?: ClaudeCodeClientConfig;
  defaultCredentials?: unknown[];
  reasoningClient?: IReasoningClient;

  /**
   * AAT Registry for parallelization rules
   */
  aatRegistry: IAATRegistry;

  /**
   * Concurrency policy (overrides AAT defaults if provided)
   */
  concurrencyPolicy?: ConcurrencyPolicy;

  /**
   * Repository URL for creating enclaves
   */
  repositoryUrl?: string;

  /**
   * Enable automatic checkpointing
   */
  enableCheckpointing?: boolean;

  /**
   * Checkpoint interval in milliseconds
   */
  checkpointIntervalMs?: number;
}

/**
 * Agent execution slot with enclave binding
 */
interface AgentSlot {
  agent: AgentRuntime;
  config: AgentConfig;
  aatId: string;
  busy: boolean;
  currentTaskId: string | null;
  enclave?: ExecutionEnclave;
  startTime?: number;
  tokenUsage: number;
}

/**
 * Resource usage tracking
 */
interface ResourceUsage {
  tokensThisMinute: number;
  costThisHour: number;
  activeAPICalls: number;
  minuteStartTime: number;
  hourStartTime: number;
}

/**
 * Events emitted by the concurrent orchestrator
 */
export interface ConcurrentOrchestratorEvents {
  'agent-spawned': (agentId: string, type: string, enclaveId?: string) => void;
  'agent-completed': (agentId: string, result: TaskResult) => void;
  'agent-failed': (agentId: string, error: string) => void;
  'workflow-started': (workflowId: string, goal: string) => void;
  'workflow-completed': (workflowId: string, result: unknown) => void;
  'workflow-failed': (workflowId: string, error: string) => void;
  'task-routed': (taskId: string, agentId: string) => void;
  'concurrency-limited': (reason: string, agentType: string) => void;
  'checkpoint-created': (checkpointId: string, workflowId: string) => void;
  'enclave-created': (enclaveId: string, agentId: string) => void;
  'resource-limit-reached': (limitType: string, value: number) => void;
}

/**
 * ConcurrentOrchestrator - AAT-aware parallel agent execution
 *
 * Key features:
 * 1. Respects AAT parallelization rules (parallelizable, maxConcurrent, conflicts)
 * 2. Creates isolated enclaves for agents that require isolation
 * 3. Enforces resource limits to prevent cost overruns
 * 4. Automatic checkpointing for crash recovery
 * 5. Conflict-aware scheduling
 */
export class ConcurrentOrchestrator extends EventEmitter<ConcurrentOrchestratorEvents> {
  private config: ConcurrentOrchestratorConfig;
  private taskManager: TaskManager;
  private reasoningClient: IReasoningClient;
  private aatRegistry: IAATRegistry;

  // Agent management
  private agentSlots: Map<string, AgentSlot> = new Map();
  private agentsByType: Map<string, Set<string>> = new Map();

  // Infrastructure services
  private enclaveService: EnclaveService;
  private checkpointStore: CheckpointStore;

  // Workflow tracking
  private workflows: Map<string, ConcurrentWorkflow> = new Map();

  // Resource tracking
  private resourceUsage: ResourceUsage = {
    tokensThisMinute: 0,
    costThisHour: 0,
    activeAPICalls: 0,
    minuteStartTime: Date.now(),
    hourStartTime: Date.now()
  };

  // Concurrency limits (from policy or defaults)
  private concurrencyPolicy: ConcurrencyPolicy;

  // Orchestrator state
  private running: boolean = false;
  private loopInterval: NodeJS.Timeout | null = null;
  private checkpointInterval: NodeJS.Timeout | null = null;

  constructor(config: ConcurrentOrchestratorConfig) {
    super();
    this.config = config;
    this.taskManager = new TaskManager();
    this.aatRegistry = config.aatRegistry;

    // Create reasoning client
    if (config.reasoningClient) {
      this.reasoningClient = config.reasoningClient;
    } else if (config.useClaudeCodeCLI) {
      this.reasoningClient = new ClaudeCodeClient(config.cliConfig);
    } else {
      this.reasoningClient = new LLMClient(config.anthropicApiKey);
    }

    // Initialize infrastructure services
    this.enclaveService = new EnclaveService();
    this.checkpointStore = new CheckpointStore();

    // Set default concurrency policy
    this.concurrencyPolicy = config.concurrencyPolicy ?? this.getDefaultConcurrencyPolicy();

    // Set up event handlers
    this.setupTaskManagerEvents();
  }

  /**
   * Initialize and start the orchestrator
   */
  async start(): Promise<void> {
    if (this.running) return;

    // Initialize infrastructure
    await this.enclaveService.initialize();
    await this.checkpointStore.initialize();

    this.running = true;

    // Start main loop
    this.loopInterval = setInterval(() => this.mainLoop(), 500);

    // Start checkpoint interval if enabled
    if (this.config.enableCheckpointing) {
      const interval = this.config.checkpointIntervalMs ?? 60000;
      this.checkpointInterval = setInterval(() => this.checkpointActiveWorkflows(), interval);
    }

    console.log('ConcurrentOrchestrator started (AAT-aware parallelization enabled)');
  }

  /**
   * Stop the orchestrator
   */
  async stop(): Promise<void> {
    this.running = false;

    if (this.loopInterval) {
      clearInterval(this.loopInterval);
      this.loopInterval = null;
    }

    if (this.checkpointInterval) {
      clearInterval(this.checkpointInterval);
      this.checkpointInterval = null;
    }

    // Create final checkpoints
    await this.checkpointActiveWorkflows();

    // Stop all agents
    for (const slot of this.agentSlots.values()) {
      slot.agent.stop();
    }

    // Cleanup enclaves
    await this.cleanupEnclaves();

    console.log('ConcurrentOrchestrator stopped');
  }

  /**
   * Submit a goal for parallel execution
   */
  async submitGoal(goal: string, options?: {
    priority?: 'low' | 'normal' | 'high' | 'critical';
    constraints?: string[];
    requiresApproval?: boolean;
    enableParallelExecution?: boolean;
  }): Promise<string> {
    const workflowId = uuidv4();

    const workflow: ConcurrentWorkflow = {
      id: workflowId,
      goal,
      status: 'planning',
      tasks: [],
      activeTasks: new Set(),
      completedTasks: new Set(),
      result: null,
      createdAt: new Date().toISOString(),
      options: {
        ...options,
        enableParallelExecution: options?.enableParallelExecution ?? true
      },
      checkpoints: []
    };

    this.workflows.set(workflowId, workflow);
    this.emit('workflow-started', workflowId, goal);

    // Create initial planning task
    const planTask = this.taskManager.createTask({
      type: 'plan',
      description: `Create a plan to achieve: ${goal}`,
      priority: options?.priority ?? 'normal',
      input: { goal, constraints: options?.constraints ?? [] },
      metadata: { workflowId }
    });

    workflow.tasks.push(planTask.id);

    return workflowId;
  }

  /**
   * Get parallelization status
   */
  getParallelizationStatus(): {
    activeAgentsByType: Record<string, number>;
    maxByType: Record<string, number>;
    conflicts: string[];
    resourceUsage: ResourceUsage;
  } {
    const activeByType: Record<string, number> = {};
    const maxByType: Record<string, number> = {};
    const conflicts: string[] = [];

    for (const [type, agents] of this.agentsByType) {
      const busyCount = Array.from(agents).filter(id => this.agentSlots.get(id)?.busy).length;
      activeByType[type] = busyCount;
      maxByType[type] = this.concurrencyPolicy.maxPerType[type] ?? 1;
    }

    // Identify active conflicts
    for (const [type, conflictingTypes] of Object.entries(this.concurrencyPolicy.conflictMatrix)) {
      if ((activeByType[type] ?? 0) > 0) {
        for (const conflictType of conflictingTypes) {
          if ((activeByType[conflictType] ?? 0) > 0) {
            conflicts.push(`${type} <-> ${conflictType}`);
          }
        }
      }
    }

    return {
      activeAgentsByType: activeByType,
      maxByType,
      conflicts,
      resourceUsage: { ...this.resourceUsage }
    };
  }

  /**
   * Main orchestration loop with AAT-aware scheduling
   */
  private async mainLoop(): Promise<void> {
    if (!this.running) return;

    try {
      // Reset minute/hour counters if needed
      this.updateResourceCounters();

      // Check resource limits before assigning tasks
      if (!this.checkResourceLimits()) {
        return;
      }

      // Assign tasks respecting parallelization rules
      await this.assignTasksWithConcurrencyControl();

      // Check workflow completion
      this.checkWorkflowCompletion();

      // Cleanup expired enclaves
      await this.enclaveService.cleanupExpiredEnclaves();

    } catch (error) {
      console.error('ConcurrentOrchestrator loop error:', error);
    }
  }

  /**
   * Assign tasks while respecting AAT parallelization rules
   */
  private async assignTasksWithConcurrencyControl(): Promise<void> {
    const agentTypes: Array<AgentConfig['agentType']> = [
      'planner', 'executor', 'observer', 'arbiter', 'archivist', 'analyst'
    ];

    for (const agentType of agentTypes) {
      const aatId = this.agentTypeToAATId(agentType);

      // Check if we can spawn this agent type
      const canSpawn = await this.canSpawnAgentType(aatId);
      if (!canSpawn.allowed) {
        if (canSpawn.reason) {
          this.emit('concurrency-limited', canSpawn.reason, agentType);
        }
        continue;
      }

      // Get next task for this agent type
      const task = this.taskManager.getNextTask(agentType);
      if (!task) continue;

      // Get or spawn an agent (with enclave if required)
      const agent = await this.getOrSpawnAgentWithEnclave(agentType, aatId);
      if (!agent) continue;

      // Assign and run
      this.taskManager.assignTask(task.id, agent.getId());
      this.taskManager.startTask(task.id);

      const slot = this.agentSlots.get(agent.getId())!;
      slot.busy = true;
      slot.currentTaskId = task.id;
      slot.startTime = Date.now();

      this.emit('task-routed', task.id, agent.getId());

      // Run asynchronously
      this.runAgentTask(agent, task, slot);
    }
  }

  /**
   * Check if a new agent of this type can be spawned
   */
  private async canSpawnAgentType(aatId: string): Promise<{ allowed: boolean; reason?: string }> {
    // Get parallelization rules from AAT
    const rules = await this.aatRegistry.getParallelizationRules(aatId);
    if (!rules) {
      return { allowed: true }; // Allow by default if no rules
    }

    // Check if parallelizable at all
    if (!rules.parallelizable) {
      const existing = this.getActiveAgentCountForType(aatId);
      if (existing > 0) {
        return { allowed: false, reason: `${aatId} is not parallelizable and one is already running` };
      }
    }

    // Check max concurrent
    const activeCount = this.getActiveAgentCountForType(aatId);
    const maxConcurrent = Math.min(
      rules.maxConcurrent,
      this.concurrencyPolicy.maxPerType[aatId] ?? rules.maxConcurrent
    );

    if (activeCount >= maxConcurrent) {
      return { allowed: false, reason: `Max concurrent (${maxConcurrent}) reached for ${aatId}` };
    }

    // Check total agents limit
    const totalActive = this.getTotalActiveAgents();
    if (totalActive >= this.concurrencyPolicy.maxTotalAgents) {
      return { allowed: false, reason: `Max total agents (${this.concurrencyPolicy.maxTotalAgents}) reached` };
    }

    // Check conflict rules
    for (const conflictType of rules.conflictsWith) {
      const conflictActive = this.getActiveAgentCountForType(conflictType);
      if (conflictActive > 0) {
        return { allowed: false, reason: `${aatId} conflicts with active ${conflictType}` };
      }
    }

    // Check global conflicts from policy
    const globalConflicts = this.concurrencyPolicy.conflictMatrix[aatId] ?? [];
    for (const conflictType of globalConflicts) {
      const conflictActive = this.getActiveAgentCountForType(conflictType);
      if (conflictActive > 0) {
        return { allowed: false, reason: `Policy conflict: ${aatId} cannot run with ${conflictType}` };
      }
    }

    return { allowed: true };
  }

  /**
   * Get or spawn an agent with enclave support
   */
  private async getOrSpawnAgentWithEnclave(
    agentType: AgentConfig['agentType'],
    aatId: string
  ): Promise<AgentRuntime | null> {
    // Look for idle agent of this type
    const typeAgents = this.agentsByType.get(aatId);
    if (typeAgents) {
      for (const agentId of typeAgents) {
        const slot = this.agentSlots.get(agentId);
        if (slot && !slot.busy) {
          return slot.agent;
        }
      }
    }

    // Check if we can spawn
    const rules = await this.aatRegistry.getParallelizationRules(aatId);

    // Create enclave if isolation is required
    let enclave: ExecutionEnclave | undefined;
    if (rules?.requiresIsolation && this.config.repositoryUrl) {
      const enclaveResult = await this.enclaveService.createEnclave({
        agentDID: `did:key:z6Mk${agentType}${uuidv4().slice(0, 8)}`,
        repository: this.config.repositoryUrl,
        scope: rules.preferredEnclaveScope?.split(',') ?? [],
        ttlSeconds: 3600 // 1 hour default
      });

      if (enclaveResult.success && enclaveResult.enclave) {
        enclave = enclaveResult.enclave;
        this.emit('enclave-created', enclave.id, enclave.boundAgentDID);
      }
    }

    // Spawn the agent
    const agent = await this.spawnAgent(agentType, aatId, enclave);
    return agent;
  }

  /**
   * Spawn a new agent
   */
  private async spawnAgent(
    agentType: AgentConfig['agentType'],
    aatId: string,
    enclave?: ExecutionEnclave
  ): Promise<AgentRuntime> {
    const agentConfig: AgentConfig = {
      did: enclave?.boundAgentDID ?? `did:key:z6Mk${agentType}${uuidv4().slice(0, 8)}`,
      agentType,
      credentials: this.getCredentialsForAgentType(agentType),
      brokerUrl: this.config.brokerUrl,
      maxIterations: 10
    };

    const agent = new AgentRuntime(agentConfig, this.reasoningClient);

    const slot: AgentSlot = {
      agent,
      config: agentConfig,
      aatId,
      busy: false,
      currentTaskId: null,
      enclave,
      tokenUsage: 0
    };

    this.agentSlots.set(agent.getId(), slot);

    // Track by type
    if (!this.agentsByType.has(aatId)) {
      this.agentsByType.set(aatId, new Set());
    }
    this.agentsByType.get(aatId)!.add(agent.getId());

    this.emit('agent-spawned', agent.getId(), agentType, enclave?.id);
    console.log(`Spawned ${agentType} agent: ${agent.getId()}${enclave ? ` (enclave: ${enclave.id})` : ''}`);

    return agent;
  }

  /**
   * Run an agent on a task
   */
  private async runAgentTask(agent: AgentRuntime, task: Task, slot: AgentSlot): Promise<void> {
    // Track API call
    this.resourceUsage.activeAPICalls++;

    try {
      let taskDescription = task.description;

      // Include plan if this is an execute task
      if (task.type === 'execute' && task.input.plan) {
        taskDescription += `\n\nPlan to execute:\n${JSON.stringify(task.input.plan, null, 2)}`;
      }

      // Include enclave context if available
      if (slot.enclave) {
        taskDescription += `\n\nExecution Enclave: ${slot.enclave.worktreePath}`;
      }

      const result = await agent.run(taskDescription);

      // Update slot
      slot.busy = false;
      slot.currentTaskId = null;

      // Estimate token usage (rough estimate)
      const estimatedTokens = (taskDescription.length + JSON.stringify(result).length) / 4;
      slot.tokenUsage += estimatedTokens;
      this.resourceUsage.tokensThisMinute += estimatedTokens;

      if (result.success) {
        this.taskManager.completeTask(task.id, result.output);
        this.emit('agent-completed', agent.getId(), result);

        // Handle plan output
        if (task.type === 'plan' && result.output) {
          await this.handlePlanOutput(task, result.output as PlanOutput);
        }
      } else {
        const error = (result.output as { error?: string })?.error ?? 'Unknown error';
        this.taskManager.failTask(task.id, error);
        this.emit('agent-failed', agent.getId(), error);
      }

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      slot.busy = false;
      slot.currentTaskId = null;
      this.taskManager.failTask(task.id, errorMessage);
      this.emit('agent-failed', agent.getId(), errorMessage);
    } finally {
      this.resourceUsage.activeAPICalls--;
    }
  }

  /**
   * Handle plan output - create parallel execution tasks when possible
   */
  private async handlePlanOutput(planTask: Task, output: PlanOutput): Promise<void> {
    const workflowId = planTask.metadata.workflowId as string;
    const workflow = this.workflows.get(workflowId);
    if (!workflow) return;

    // Check if parallel execution is enabled
    const enableParallel = workflow.options.enableParallelExecution;

    if (enableParallel) {
      await this.createParallelExecutionTasks(workflow, planTask.id, output);
    } else {
      await this.createSequentialExecutionTasks(workflow, planTask.id, output);
    }
  }

  /**
   * Create parallel execution tasks where dependencies allow
   */
  private async createParallelExecutionTasks(
    workflow: ConcurrentWorkflow,
    planTaskId: string,
    plan: PlanOutput
  ): Promise<void> {
    workflow.status = 'executing';

    const steps = plan.steps ?? [];
    const executeTasks: string[] = [];

    // Create all execute tasks upfront (with dependency on plan)
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const stepNum = i + 1;

      // Each execute task depends only on the plan (parallel execution)
      const execTask = this.taskManager.createTask({
        type: 'execute',
        description: `[Step ${stepNum}/${steps.length}] Execute: ${step.action}`,
        priority: 'normal',
        dependencies: [planTaskId],
        input: {
          step,
          stepNumber: stepNum,
          plan,
          enableTools: true
        },
        metadata: { workflowId: workflow.id, stepNumber: stepNum, parallel: true }
      });

      executeTasks.push(execTask.id);
      workflow.tasks.push(execTask.id);
    }

    // Create archive task that depends on ALL execute tasks
    const archiveTask = this.taskManager.createTask({
      type: 'archive',
      description: `Archive parallel workflow results for: ${workflow.goal}`,
      priority: 'low',
      dependencies: executeTasks,
      input: {
        workflowId: workflow.id,
        plan,
        totalSteps: steps.length,
        executionMode: 'parallel'
      },
      metadata: { workflowId: workflow.id }
    });

    workflow.tasks.push(archiveTask.id);
  }

  /**
   * Create sequential execution tasks (traditional approach)
   */
  private async createSequentialExecutionTasks(
    workflow: ConcurrentWorkflow,
    planTaskId: string,
    plan: PlanOutput
  ): Promise<void> {
    workflow.status = 'executing';

    let previousTaskId = planTaskId;
    const steps = plan.steps ?? [];

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const stepNum = i + 1;

      // Arbiter approval
      const approveTask = this.taskManager.createTask({
        type: 'approve',
        description: `[Step ${stepNum}/${steps.length}] Approve: ${step.action}`,
        priority: 'normal',
        dependencies: [previousTaskId],
        input: { step, stepNumber: stepNum, plan },
        metadata: { workflowId: workflow.id, stepNumber: stepNum }
      });
      workflow.tasks.push(approveTask.id);

      // Execute
      const execTask = this.taskManager.createTask({
        type: 'execute',
        description: `[Step ${stepNum}/${steps.length}] Execute: ${step.action}`,
        priority: 'normal',
        dependencies: [approveTask.id],
        input: { step, stepNumber: stepNum, plan },
        metadata: { workflowId: workflow.id, stepNumber: stepNum }
      });
      workflow.tasks.push(execTask.id);

      // Observe
      const observeTask = this.taskManager.createTask({
        type: 'observe',
        description: `[Step ${stepNum}/${steps.length}] Verify: ${step.action}`,
        priority: 'normal',
        dependencies: [execTask.id],
        input: { step, stepNumber: stepNum },
        metadata: { workflowId: workflow.id, stepNumber: stepNum }
      });
      workflow.tasks.push(observeTask.id);

      previousTaskId = observeTask.id;
    }

    // Archive
    const archiveTask = this.taskManager.createTask({
      type: 'archive',
      description: `Archive workflow results for: ${workflow.goal}`,
      priority: 'low',
      dependencies: [previousTaskId],
      input: { workflowId: workflow.id, plan },
      metadata: { workflowId: workflow.id }
    });
    workflow.tasks.push(archiveTask.id);
  }

  /**
   * Checkpoint all active workflows
   */
  private async checkpointActiveWorkflows(): Promise<void> {
    for (const [workflowId, workflow] of this.workflows) {
      if (workflow.status === 'executing') {
        try {
          const agentState: AgentCheckpointState = {
            taskQueue: workflow.tasks
              .map(id => this.taskManager.getTask(id))
              .filter(t => t && t.status === 'queued')
              .map(t => ({
                id: t!.id,
                type: t!.type,
                description: t!.description,
                status: t!.status as 'pending' | 'in_progress' | 'completed' | 'failed'
              })),
            completedTasks: Array.from(workflow.completedTasks),
            workingMemory: { goal: workflow.goal },
            currentGoal: workflow.goal
          };

          const result = await this.checkpointStore.createCheckpoint({
            contextId: `workflow:${workflowId}`,
            agentDID: `did:orchestrator:${workflowId}`,
            context: {
              '@context': ['https://agentcontextgraph.dev/context/v1'],
              id: `urn:workflow:${workflowId}`,
              agentDID: `did:orchestrator:${workflowId}`,
              agentType: 'aat:OrchestratorType',
              timestamp: new Date().toISOString(),
              expiresAt: new Date(Date.now() + 3600000).toISOString(),
              nonce: uuidv4(),
              scope: { domain: 'orchestration', resources: [], actions: [] },
              verifiedCredentials: [],
              constraints: [],
              affordances: [],
              tracePolicy: { mustEmitProvActivity: true, includeContextSnapshot: true, includeOutcomes: true }
            },
            agentState,
            label: `Workflow ${workflowId} checkpoint`
          });

          if (result.success && result.checkpoint) {
            workflow.checkpoints.push(result.checkpoint.id);
            this.emit('checkpoint-created', result.checkpoint.id, workflowId);
          }
        } catch (error) {
          console.error(`Failed to checkpoint workflow ${workflowId}:`, error);
        }
      }
    }
  }

  /**
   * Check workflow completion
   */
  private checkWorkflowCompletion(): void {
    for (const [workflowId, workflow] of this.workflows) {
      if (workflow.status === 'completed' || workflow.status === 'failed') {
        continue;
      }

      const tasks = workflow.tasks.map(id => this.taskManager.getTask(id)).filter(Boolean) as Task[];

      const failedTask = tasks.find(t => t.status === 'failed');
      if (failedTask) {
        workflow.status = 'failed';
        workflow.result = { error: failedTask.error };
        this.emit('workflow-failed', workflowId, failedTask.error ?? 'Unknown error');
        continue;
      }

      const allComplete = tasks.every(t => t.status === 'completed');
      if (allComplete && tasks.length > 0) {
        workflow.status = 'completed';
        workflow.result = {
          tasks: tasks.map(t => ({
            id: t.id,
            type: t.type,
            description: t.description,
            output: t.output
          }))
        };
        this.emit('workflow-completed', workflowId, workflow.result);
      }
    }
  }

  /**
   * Check resource limits
   */
  private checkResourceLimits(): boolean {
    const limits = this.concurrencyPolicy.resourceLimits;

    if (this.resourceUsage.tokensThisMinute >= limits.maxTokensPerMinute) {
      this.emit('resource-limit-reached', 'tokens', this.resourceUsage.tokensThisMinute);
      return false;
    }

    if (this.resourceUsage.costThisHour >= limits.maxCostPerHour) {
      this.emit('resource-limit-reached', 'cost', this.resourceUsage.costThisHour);
      return false;
    }

    if (this.resourceUsage.activeAPICalls >= limits.maxConcurrentAPICalls) {
      this.emit('resource-limit-reached', 'api_calls', this.resourceUsage.activeAPICalls);
      return false;
    }

    return true;
  }

  /**
   * Update resource counters (reset minute/hour windows)
   */
  private updateResourceCounters(): void {
    const now = Date.now();

    // Reset minute counter
    if (now - this.resourceUsage.minuteStartTime >= 60000) {
      this.resourceUsage.tokensThisMinute = 0;
      this.resourceUsage.minuteStartTime = now;
    }

    // Reset hour counter
    if (now - this.resourceUsage.hourStartTime >= 3600000) {
      this.resourceUsage.costThisHour = 0;
      this.resourceUsage.hourStartTime = now;
    }
  }

  /**
   * Get active agent count for a type
   */
  private getActiveAgentCountForType(aatId: string): number {
    const agents = this.agentsByType.get(aatId);
    if (!agents) return 0;

    return Array.from(agents).filter(id => this.agentSlots.get(id)?.busy).length;
  }

  /**
   * Get total active agents
   */
  private getTotalActiveAgents(): number {
    return Array.from(this.agentSlots.values()).filter(s => s.busy).length;
  }

  /**
   * Convert agent type to AAT ID
   */
  private agentTypeToAATId(agentType: AgentConfig['agentType']): string {
    const mapping: Record<AgentConfig['agentType'], string> = {
      planner: 'aat:PlannerAgentType',
      executor: 'aat:ExecutorAgentType',
      observer: 'aat:ObserverAgentType',
      arbiter: 'aat:ArbiterAgentType',
      archivist: 'aat:ArchivistAgentType',
      analyst: 'aat:AnalystAgentType'
    };
    return mapping[agentType];
  }

  /**
   * Get credentials for agent type
   */
  private getCredentialsForAgentType(agentType: AgentConfig['agentType']): unknown[] {
    const capabilityMap: Record<AgentConfig['agentType'], string> = {
      planner: 'PlannerCapability',
      executor: 'ExecutorCapability',
      observer: 'ObserverCapability',
      arbiter: 'ArbiterCapability',
      archivist: 'ArchivistCapability',
      analyst: 'AnalystCapability'
    };

    const capability = capabilityMap[agentType];

    return [
      {
        type: ['VerifiableCredential', capability],
        issuer: 'did:web:authority.example.com',
        expirationDate: '2030-01-01T00:00:00Z',
        credentialSubject: { capability }
      },
      ...(this.config.defaultCredentials ?? [])
    ];
  }

  /**
   * Get default concurrency policy
   */
  private getDefaultConcurrencyPolicy(): ConcurrencyPolicy {
    return {
      maxTotalAgents: 10,
      maxPerType: {
        'aat:PlannerAgentType': 3,
        'aat:ExecutorAgentType': 5,
        'aat:AnalystAgentType': 3,
        'aat:ObserverAgentType': 5,
        'aat:ArbiterAgentType': 1,
        'aat:ArchivistAgentType': 2
      },
      conflictMatrix: {
        'aat:ArbiterAgentType': ['aat:ArbiterAgentType'],
        'aat:PlannerAgentType': ['aat:PlannerAgentType'] // Same goal
      },
      resourceLimits: {
        maxTokensPerMinute: 100000,
        maxCostPerHour: 10, // $10/hour limit
        maxConcurrentAPICalls: 10
      }
    };
  }

  /**
   * Cleanup enclaves on shutdown
   */
  private async cleanupEnclaves(): Promise<void> {
    for (const slot of this.agentSlots.values()) {
      if (slot.enclave && slot.enclave.status === 'active') {
        await this.enclaveService.sealEnclave({
          enclaveId: slot.enclave.id,
          reason: 'Orchestrator shutdown'
        });
      }
    }
  }

  /**
   * Set up task manager events
   */
  private setupTaskManagerEvents(): void {
    this.taskManager.on('task-completed', (task) => {
      console.log(`Task completed: ${task.id} (${task.type})`);

      // Track in workflow
      const workflowId = task.metadata.workflowId as string;
      const workflow = this.workflows.get(workflowId);
      if (workflow) {
        workflow.completedTasks.add(task.id);
        workflow.activeTasks.delete(task.id);
      }
    });

    this.taskManager.on('task-failed', (task, error) => {
      console.error(`Task failed: ${task.id} (${task.type}): ${error}`);
    });
  }

  /**
   * Get workflow status
   */
  getWorkflowStatus(workflowId: string): ConcurrentWorkflow | undefined {
    return this.workflows.get(workflowId);
  }

  /**
   * Get orchestrator stats
   */
  getStats(): {
    workflows: { total: number; byStatus: Record<string, number> };
    agents: { total: number; busy: number; idle: number; byType: Record<string, number> };
    resources: ResourceUsage;
    parallelization: ReturnType<ConcurrentOrchestrator['getParallelizationStatus']>;
  } {
    const workflowStats = {
      total: this.workflows.size,
      byStatus: {} as Record<string, number>
    };

    for (const workflow of this.workflows.values()) {
      workflowStats.byStatus[workflow.status] = (workflowStats.byStatus[workflow.status] ?? 0) + 1;
    }

    const byType: Record<string, number> = {};
    for (const [type, agents] of this.agentsByType) {
      byType[type] = agents.size;
    }

    return {
      workflows: workflowStats,
      agents: {
        total: this.agentSlots.size,
        busy: Array.from(this.agentSlots.values()).filter(s => s.busy).length,
        idle: Array.from(this.agentSlots.values()).filter(s => !s.busy).length,
        byType
      },
      resources: { ...this.resourceUsage },
      parallelization: this.getParallelizationStatus()
    };
  }
}

/**
 * Workflow with concurrent execution support
 */
interface ConcurrentWorkflow {
  id: string;
  goal: string;
  status: 'planning' | 'awaiting-approval' | 'executing' | 'completed' | 'failed';
  tasks: string[];
  activeTasks: Set<string>;
  completedTasks: Set<string>;
  result: unknown;
  createdAt: string;
  options: {
    priority?: 'low' | 'normal' | 'high' | 'critical';
    constraints?: string[];
    requiresApproval?: boolean;
    enableParallelExecution?: boolean;
  };
  checkpoints: string[];
}

interface PlanOutput {
  goal?: string;
  steps?: Array<{
    action: string;
    rationale: string;
  }>;
  reasoning?: string;
  message?: string;
}
