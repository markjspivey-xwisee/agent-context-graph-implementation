import { v4 as uuidv4 } from 'uuid';
import { EventEmitter } from 'eventemitter3';
import { AgentRuntime, type AgentConfig, type AgentState, type TaskResult, type TaskContext } from './agent-runtime.js';
import { TaskManager, type Task, type TaskStatus } from './task-manager.js';
import { LLMClient } from './llm-client.js';
import { ClaudeCodeClient, type ClaudeCodeClientConfig } from './claude-code-client.js';
import type { IReasoningClient } from './reasoning-client.js';

export interface OrchestratorConfig {
  brokerUrl: string;
  maxConcurrentAgents?: number;
  defaultCredentials?: unknown[];

  /**
   * Prebuilt reasoning client (overrides other settings)
   */
  reasoningClient?: IReasoningClient;

  /**
   * Anthropic API key (for API-based reasoning)
   */
  anthropicApiKey?: string;

  /**
   * Use Claude Code CLI instances instead of API
   */
  useClaudeCodeCLI?: boolean;

  /**
   * CLI configuration (when useClaudeCodeCLI is true)
   */
  cliConfig?: ClaudeCodeClientConfig;
}

export interface AgentPoolEntry {
  agent: AgentRuntime;
  config: AgentConfig;
  busy: boolean;
  currentTaskId: string | null;
}

export interface WorkflowStep {
  type: 'plan' | 'execute' | 'observe' | 'approve' | 'archive';
  description: string;
  input?: Record<string, unknown>;
  requiresApproval?: boolean;
}

export interface OrchestratorEvents {
  'agent-spawned': (agentId: string, type: string) => void;
  'agent-completed': (agentId: string, result: TaskResult) => void;
  'agent-failed': (agentId: string, error: string) => void;
  'workflow-started': (workflowId: string, goal: string) => void;
  'workflow-completed': (workflowId: string, result: unknown) => void;
  'workflow-failed': (workflowId: string, error: string) => void;
  'task-routed': (taskId: string, agentId: string) => void;
}

/**
 * Orchestrator - Coordinates a team of agents to achieve goals
 *
 * The orchestrator:
 * 1. Accepts high-level goals
 * 2. Creates tasks and routes them to appropriate agents
 * 3. Manages the agent pool
 * 4. Handles plan→execute handoffs
 * 5. Monitors progress and handles failures
 */
export class Orchestrator extends EventEmitter<OrchestratorEvents> {
  private config: OrchestratorConfig;
  private taskManager: TaskManager;
  private reasoningClient: IReasoningClient;
  private agentPool: Map<string, AgentPoolEntry> = new Map();
  private workflows: Map<string, Workflow> = new Map();
  private running: boolean = false;
  private loopInterval: NodeJS.Timeout | null = null;

  constructor(config: OrchestratorConfig) {
    super();
    this.config = config;
    this.taskManager = new TaskManager();

    // Create reasoning client based on configuration
    if (config.reasoningClient) {
      this.reasoningClient = config.reasoningClient;
      console.log('Orchestrator using custom reasoning client');
    } else if (config.useClaudeCodeCLI) {
      this.reasoningClient = new ClaudeCodeClient(config.cliConfig);
      console.log('Orchestrator using Claude Code CLI for agent reasoning');
    } else {
      this.reasoningClient = new LLMClient(config.anthropicApiKey);
      console.log('Orchestrator using Anthropic API for agent reasoning');
    }

    // Set up task manager event handlers
    this.setupTaskManagerEvents();
  }

  /**
   * Start the orchestrator
   */
  start(): void {
    if (this.running) return;
    this.running = true;

    // Start the main loop
    this.loopInterval = setInterval(() => this.mainLoop(), 1000);
    console.log('Orchestrator started');
  }

  /**
   * Stop the orchestrator
   */
  stop(): void {
    this.running = false;
    if (this.loopInterval) {
      clearInterval(this.loopInterval);
      this.loopInterval = null;
    }

    // Stop all agents
    for (const entry of this.agentPool.values()) {
      entry.agent.stop();
    }

    console.log('Orchestrator stopped');
  }

  /**
   * Submit a goal for the orchestrator to achieve
   */
  async submitGoal(goal: string, options?: {
    priority?: 'low' | 'normal' | 'high' | 'critical';
    constraints?: string[];
    requiresApproval?: boolean;
  }): Promise<string> {
    const workflowId = uuidv4();

    const workflow: Workflow = {
      id: workflowId,
      goal,
      status: 'planning',
      tasks: [],
      result: null,
      createdAt: new Date().toISOString(),
      options: options ?? {}
    };

    this.workflows.set(workflowId, workflow);
    this.emit('workflow-started', workflowId, goal);

    // Create the initial planning task
    const planTask = this.taskManager.createTask({
      type: 'plan',
      description: `Create a plan to achieve: ${goal}`,
      priority: options?.priority ?? 'normal',
      input: {
        goal,
        constraints: options?.constraints ?? []
      },
      metadata: { workflowId }
    });

    workflow.tasks.push(planTask.id);

    return workflowId;
  }

  /**
   * Get workflow status
   */
  getWorkflowStatus(workflowId: string): Workflow | undefined {
    return this.workflows.get(workflowId);
  }

  /**
   * Get all workflows
   */
  getAllWorkflows(): Workflow[] {
    return Array.from(this.workflows.values());
  }

  /**
   * Get orchestrator statistics
   */
  getStats(): {
    workflows: { total: number; byStatus: Record<string, number> };
    tasks: ReturnType<TaskManager['getStats']>;
    agents: { total: number; busy: number; idle: number };
  } {
    const workflowStats = {
      total: this.workflows.size,
      byStatus: {} as Record<string, number>
    };

    for (const workflow of this.workflows.values()) {
      workflowStats.byStatus[workflow.status] =
        (workflowStats.byStatus[workflow.status] ?? 0) + 1;
    }

    const agentStats = {
      total: this.agentPool.size,
      busy: Array.from(this.agentPool.values()).filter(e => e.busy).length,
      idle: Array.from(this.agentPool.values()).filter(e => !e.busy).length
    };

    return {
      workflows: workflowStats,
      tasks: this.taskManager.getStats(),
      agents: agentStats
    };
  }

  /**
   * Get detailed agent information
   */
  getAgents(): Array<{
    id: string;
    type: string;
    busy: boolean;
    currentTaskId: string | null;
    did: string;
  }> {
    return Array.from(this.agentPool.entries()).map(([id, entry]) => ({
      id,
      type: entry.config.agentType,
      busy: entry.busy,
      currentTaskId: entry.currentTaskId,
      did: entry.config.did
    }));
  }

  /**
   * Get detailed workflow information with full task data
   */
  getWorkflowDetail(workflowId: string): WorkflowDetail | undefined {
    const workflow = this.workflows.get(workflowId);
    if (!workflow) return undefined;

    const tasks = workflow.tasks
      .map(id => this.taskManager.getTask(id))
      .filter(Boolean) as Task[];

    // Calculate timing
    const startTime = workflow.createdAt;
    const endTime = tasks.find(t => t.completedAt && t.type === 'archive')?.completedAt ??
                    (workflow.status === 'completed' || workflow.status === 'failed'
                      ? tasks[tasks.length - 1]?.completedAt
                      : null);

    return {
      ...workflow,
      taskDetails: tasks.map(task => ({
        id: task.id,
        type: task.type,
        description: task.description,
        status: task.status,
        assignedAgent: task.assignedAgent,
        createdAt: task.createdAt,
        startedAt: task.startedAt,
        completedAt: task.completedAt,
        error: task.error,
        input: task.input,
        output: task.output,
        stepNumber: task.metadata.stepNumber as number | undefined
      })),
      timing: {
        startTime,
        endTime,
        durationMs: endTime ? new Date(endTime).getTime() - new Date(startTime).getTime() : null
      }
    };
  }

  /**
   * Get all tasks across all workflows
   */
  getAllTasks(): Task[] {
    return this.taskManager.getAllTasks();
  }

  /**
   * Main orchestration loop
   */
  private async mainLoop(): Promise<void> {
    if (!this.running) return;

    try {
      // Check for queued tasks and assign to available agents
      await this.assignTasks();

      // Check for completed workflows
      this.checkWorkflowCompletion();

    } catch (error) {
      console.error('Orchestrator loop error:', error);
    }
  }

  /**
   * Assign queued tasks to available agents
   */
  private async assignTasks(): Promise<void> {
    const agentTypes: Array<AgentConfig['agentType']> = [
      'planner', 'executor', 'observer', 'arbiter', 'archivist'
    ];

    for (const agentType of agentTypes) {
      // Get next task for this agent type
      const task = this.taskManager.getNextTask(agentType);
      if (!task) continue;

      // Get or spawn an agent
      const agent = await this.getOrSpawnAgent(agentType);
      if (!agent) continue;

      // Assign and run the task
      this.taskManager.assignTask(task.id, agent.getId());
      this.taskManager.startTask(task.id);

      const entry = this.agentPool.get(agent.getId())!;
      entry.busy = true;
      entry.currentTaskId = task.id;

      this.emit('task-routed', task.id, agent.getId());

      // Run the agent asynchronously
      this.runAgentTask(agent, task);
    }
  }

  /**
   * Run an agent on a task
   */
  private async runAgentTask(agent: AgentRuntime, task: Task): Promise<void> {
    try {
      // Build the task description for the agent
      let taskDescription = task.description;

      // Build task context for different task types (provides required SHACL parameters)
      let taskContext: TaskContext | undefined;

      if (task.type === 'execute') {
        if (task.input.plan) {
          taskDescription += `\n\nPlan to execute:\n${JSON.stringify(task.input.plan, null, 2)}`;
        }
        // Create task context with actionRef and target for automatic injection
        taskContext = {
          actionRef: task.input.actionRef as string,
          target: task.input.target as string
        };
      } else if (task.type === 'archive') {
        // Create task context with content and contentType for Store affordance
        taskContext = {
          content: task.input.content as string,
          contentType: task.input.contentType as 'trace' | 'knowledge' | 'artifact' | 'index'
        };
      }

      // Run the agent with optional task context
      const result = await agent.run(taskDescription, taskContext);

      // Update agent pool entry
      const entry = this.agentPool.get(agent.getId());
      if (entry) {
        entry.busy = false;
        entry.currentTaskId = null;
      }

      if (result.success) {
        // Complete the task
        this.taskManager.completeTask(task.id, result.output);
        this.emit('agent-completed', agent.getId(), result);

        // Handle plan output - create execute tasks
        if (task.type === 'plan' && result.output) {
          await this.handlePlanOutput(task, result.output as PlanOutput);
        }

      } else {
        // Fail the task
        const error = (result.output as { error?: string })?.error ?? 'Unknown error';
        this.taskManager.failTask(task.id, error);
        this.emit('agent-failed', agent.getId(), error);
      }

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      const entry = this.agentPool.get(agent.getId());
      if (entry) {
        entry.busy = false;
        entry.currentTaskId = null;
      }

      this.taskManager.failTask(task.id, errorMessage);
      this.emit('agent-failed', agent.getId(), errorMessage);
    }
  }

  /**
   * Handle plan output by creating execution tasks
   */
  private async handlePlanOutput(planTask: Task, output: PlanOutput): Promise<void> {
    const workflowId = planTask.metadata.workflowId as string;
    const workflow = this.workflows.get(workflowId);
    if (!workflow) return;

    // Check if approval is required
    if (workflow.options.requiresApproval) {
      // Create approval task
      const approvalTask = this.taskManager.createTask({
        type: 'approve',
        description: `Approve plan for: ${workflow.goal}`,
        priority: planTask.priority,
        dependencies: [planTask.id],
        input: { plan: output },
        metadata: { workflowId }
      });

      workflow.tasks.push(approvalTask.id);
      workflow.status = 'awaiting-approval';
      return;
    }

    // Create execution tasks for each step
    await this.createExecutionTasks(workflow, planTask.id, output);
  }

  /**
   * Create execution tasks from a plan
   * Full workflow: Planner -> Arbiter (per step) -> Executor -> Observer -> Archivist
   */
  private async createExecutionTasks(
    workflow: Workflow,
    planTaskId: string,
    plan: PlanOutput
  ): Promise<void> {
    workflow.status = 'executing';

    let previousTaskId = planTaskId;
    const steps = plan.steps ?? [];

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const stepNum = i + 1;

      // 1. Arbiter approval for each step
      const approveTask = this.taskManager.createTask({
        type: 'approve',
        description: `[Step ${stepNum}/${steps.length}] Approve: ${step.action}`,
        priority: 'normal',
        dependencies: [previousTaskId],
        input: {
          step,
          stepNumber: stepNum,
          totalSteps: steps.length,
          plan,
          policies: [
            'Actions must not delete critical files',
            'Actions must not expose secrets',
            'Actions must be reversible when possible'
          ]
        },
        metadata: { workflowId: workflow.id, stepNumber: stepNum }
      });
      workflow.tasks.push(approveTask.id);

      // 2. Executor performs the action
      const execTask = this.taskManager.createTask({
        type: 'execute',
        description: `[Step ${stepNum}/${steps.length}] Execute: ${step.action}`,
        priority: 'normal',
        dependencies: [approveTask.id],
        input: {
          step,
          stepNumber: stepNum,
          plan,
          enableTools: true,
          // Required for SHACL validation - provides traceability
          actionRef: approveTask.id, // Reference to the approval that authorized this action
          target: step.action // The action being performed
        },
        metadata: { workflowId: workflow.id, stepNumber: stepNum }
      });
      workflow.tasks.push(execTask.id);

      // 3. Observer monitors/validates the result
      const observeTask = this.taskManager.createTask({
        type: 'observe',
        description: `[Step ${stepNum}/${steps.length}] Verify: ${step.action}`,
        priority: 'normal',
        dependencies: [execTask.id],
        input: {
          step,
          stepNumber: stepNum,
          expectedOutcome: step.rationale
        },
        metadata: { workflowId: workflow.id, stepNumber: stepNum }
      });
      workflow.tasks.push(observeTask.id);

      previousTaskId = observeTask.id;
    }

    // 4. Final archive task to record the workflow
    const archiveTask = this.taskManager.createTask({
      type: 'archive',
      description: `Archive workflow results for: ${workflow.goal}`,
      priority: 'low',
      dependencies: [previousTaskId],
      input: {
        workflowId: workflow.id,
        plan,
        totalSteps: steps.length,
        // Required for SHACL validation - Store affordance parameters
        content: JSON.stringify({
          goal: workflow.goal,
          plan: plan,
          completedAt: new Date().toISOString()
        }),
        contentType: 'trace' // One of: trace, knowledge, artifact, index
      },
      metadata: { workflowId: workflow.id }
    });
    workflow.tasks.push(archiveTask.id);
  }

  /**
   * Check if workflows are complete
   */
  private checkWorkflowCompletion(): void {
    for (const [workflowId, workflow] of this.workflows) {
      if (workflow.status === 'completed' || workflow.status === 'failed') {
        continue;
      }

      // Get all tasks for this workflow
      const tasks = workflow.tasks.map(id => this.taskManager.getTask(id)).filter(Boolean) as Task[];

      // Check if any task failed
      const failedTask = tasks.find(t => t.status === 'failed');
      if (failedTask) {
        workflow.status = 'failed';
        workflow.result = { error: failedTask.error };
        this.emit('workflow-failed', workflowId, failedTask.error ?? 'Unknown error');
        continue;
      }

      // Check if all tasks are complete
      const allComplete = tasks.every(t => t.status === 'completed');
      if (allComplete && tasks.length > 0) {
        workflow.status = 'completed';

        // Aggregate results from all tasks
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
   * Get or spawn an agent of the specified type
   */
  private async getOrSpawnAgent(
    agentType: AgentConfig['agentType']
  ): Promise<AgentRuntime | null> {
    // Look for an idle agent of this type
    for (const entry of this.agentPool.values()) {
      if (entry.config.agentType === agentType && !entry.busy) {
        return entry.agent;
      }
    }

    // Check if we can spawn a new agent
    const maxAgents = this.config.maxConcurrentAgents ?? 5;
    if (this.agentPool.size >= maxAgents) {
      return null;
    }

    // Spawn a new agent
    const agent = await this.spawnAgent(agentType);
    return agent;
  }

  /**
   * Spawn a new agent
   */
  private async spawnAgent(agentType: AgentConfig['agentType']): Promise<AgentRuntime> {
    const agentConfig: AgentConfig = {
      did: `did:key:z6Mk${agentType}Agent${uuidv4().slice(0, 8)}`,
      agentType,
      credentials: this.getCredentialsForAgentType(agentType),
      brokerUrl: this.config.brokerUrl,
      maxIterations: 10
    };

    const agent = new AgentRuntime(agentConfig, this.reasoningClient);

    const entry: AgentPoolEntry = {
      agent,
      config: agentConfig,
      busy: false,
      currentTaskId: null
    };

    this.agentPool.set(agent.getId(), entry);

    // Set up agent event handlers
    agent.on('state-change', (state) => {
      // Could log or emit state changes
    });

    agent.on('error', (error) => {
      console.error(`Agent ${agent.getId()} error:`, error);
    });

    this.emit('agent-spawned', agent.getId(), agentType);
    console.log(`Spawned ${agentType} agent: ${agent.getId()}`);

    return agent;
  }

  /**
   * Get credentials for an agent type
   */
  private getCredentialsForAgentType(agentType: AgentConfig['agentType']): unknown[] {
    const capabilityMap: Record<AgentConfig['agentType'], string> = {
      planner: 'PlannerCapability',
      executor: 'ExecutorCapability',
      observer: 'ObserverCapability',
      arbiter: 'ArbiterCapability',
      archivist: 'ArchivistCapability'
    };

    const capability = capabilityMap[agentType];

    return [
      {
        type: ['VerifiableCredential', capability],
        issuer: 'did:web:authority.example.com',
        expirationDate: '2030-01-01T00:00:00Z',
        credentialSubject: {
          capability
        }
      },
      ...(this.config.defaultCredentials ?? [])
    ];
  }

  /**
   * Set up task manager event handlers
   */
  private setupTaskManagerEvents(): void {
    this.taskManager.on('task-completed', (task) => {
      console.log(`Task completed: ${task.id} (${task.type}): ${task.description.slice(0, 50)}...`);
    });

    this.taskManager.on('task-failed', (task, error) => {
      console.error(`Task failed: ${task.id} (${task.type}): ${error}`);
    });
  }
}

interface Workflow {
  id: string;
  goal: string;
  status: 'planning' | 'awaiting-approval' | 'executing' | 'completed' | 'failed';
  tasks: string[];
  result: unknown;
  createdAt: string;
  options: {
    priority?: 'low' | 'normal' | 'high' | 'critical';
    constraints?: string[];
    requiresApproval?: boolean;
  };
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

interface TaskDetail {
  id: string;
  type: string;
  description: string;
  status: string;
  assignedAgent: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
  input: Record<string, unknown>;
  output: unknown;
  stepNumber?: number;
}

interface WorkflowDetail extends Workflow {
  taskDetails: TaskDetail[];
  timing: {
    startTime: string;
    endTime: string | null;
    durationMs: number | null;
  };
}
