import { v4 as uuidv4 } from 'uuid';
import { EventEmitter } from 'eventemitter3';
import { ContextBroker } from '../broker/context-broker.js';
import { RDFStore } from '../services/rdf-store.js';
import { OPAPolicyEngine } from '../services/opa-policy-engine.js';
import { SPARQLEndpoint, sparqlToJson } from '../services/sparql-endpoint.js';
import { RealVerifier } from '../services/verifier.js';
import { AATRegistry } from '../services/aat-registry.js';
import { RealCausalEvaluator } from '../services/causal-evaluator.js';
import { LLMClient } from '../agents/llm-client.js';
import type {
  ContextGraph,
  ProvTrace,
  ITraceStore,
  StoreResult,
  TraceQuery
} from '../interfaces/index.js';

/**
 * Workflow Events
 */
export interface WorkflowRunnerEvents {
  'workflow:started': (workflowId: string, goal: string) => void;
  'workflow:completed': (workflowId: string, result: WorkflowResult) => void;
  'workflow:failed': (workflowId: string, error: string) => void;
  'step:started': (stepId: string, stepType: string, description: string) => void;
  'step:completed': (stepId: string, output: unknown) => void;
  'step:failed': (stepId: string, error: string) => void;
  'trace:stored': (traceId: string) => void;
  'policy:evaluated': (result: PolicyEvaluationSummary) => void;
}

/**
 * Step in the workflow
 */
interface WorkflowStep {
  id: string;
  type: 'plan' | 'approve' | 'execute' | 'observe' | 'archive';
  description: string;
  agentType: string;
  input: Record<string, unknown>;
  output?: unknown;
  trace?: ProvTrace;
  status: 'pending' | 'running' | 'completed' | 'failed';
  error?: string;
}

/**
 * Workflow Result
 */
export interface WorkflowResult {
  success: boolean;
  workflowId: string;
  goal: string;
  steps: WorkflowStep[];
  traces: ProvTrace[];
  timing: {
    startTime: string;
    endTime: string;
    durationMs: number;
  };
  sparqlQueries?: Record<string, unknown>;
}

/**
 * Policy Evaluation Summary
 */
interface PolicyEvaluationSummary {
  stepId: string;
  allowed: boolean;
  appliedRules: number;
  denialReasons: string[];
  warnings: string[];
}

/**
 * End-to-End Workflow Runner
 * Demonstrates the full Agent Context Graph system:
 * - Planner creates plan → Arbiter approves → Executor executes → Observer verifies → Archivist stores
 * - All actions produce PROV traces stored in RDF
 * - Policy engine enforces constraints
 * - SPARQL queries over trace data
 */
export class EndToEndWorkflowRunner extends EventEmitter<WorkflowRunnerEvents> {
  private broker: ContextBroker;
  private rdfStore: RDFStore;
  private policyEngine: OPAPolicyEngine;
  private sparqlEndpoint: SPARQLEndpoint;
  private llmClient: LLMClient;
  private aatRegistry: AATRegistry;

  constructor(options: {
    anthropicApiKey?: string;
    shaclDir?: string;
  } = {}) {
    super();

    // Initialize RDF store
    this.rdfStore = new RDFStore();

    // Create trace store adapter
    const traceStoreAdapter = this.createTraceStoreAdapter();

    // Initialize components
    const verifier = new RealVerifier({
      trustedIssuers: [
        'did:web:authority.example.com',
        'did:web:issuer.example.com'
      ]
    });

    this.policyEngine = new OPAPolicyEngine();
    this.aatRegistry = new AATRegistry();
    const causalEvaluator = new RealCausalEvaluator();

    // Create broker with RDF-backed trace store
    this.broker = new ContextBroker(
      verifier,
      this.policyEngine,
      this.aatRegistry,
      traceStoreAdapter,
      causalEvaluator
    );

    // Initialize SPARQL endpoint
    this.sparqlEndpoint = new SPARQLEndpoint(this.rdfStore);

    // Initialize LLM client
    this.llmClient = new LLMClient(options.anthropicApiKey);
  }

  /**
   * Run a complete workflow from goal to completion
   */
  async runWorkflow(goal: string, options: {
    constraints?: string[];
    requiresApproval?: boolean;
    enableCausal?: boolean;
  } = {}): Promise<WorkflowResult> {
    const workflowId = `urn:workflow:${uuidv4()}`;
    const startTime = new Date().toISOString();
    const steps: WorkflowStep[] = [];
    const traces: ProvTrace[] = [];

    this.emit('workflow:started', workflowId, goal);

    try {
      // ===========================================
      // Step 1: PLANNER - Create a plan
      // ===========================================
      const planStep = await this.runPlannerStep(workflowId, goal, options.constraints);
      steps.push(planStep);
      if (planStep.trace) traces.push(planStep.trace);

      if (planStep.status === 'failed') {
        throw new Error(`Planning failed: ${planStep.error}`);
      }

      const plan = planStep.output as { goal: string; steps: Array<{ action: string; rationale: string }> };

      // ===========================================
      // Step 2: For each plan step: APPROVE → EXECUTE → OBSERVE
      // ===========================================
      for (let i = 0; i < plan.steps.length; i++) {
        const planAction = plan.steps[i];
        const stepNum = i + 1;

        // 2a: ARBITER - Approve the action
        const approveStep = await this.runArbiterStep(
          workflowId,
          stepNum,
          planAction,
          options.constraints ?? []
        );
        steps.push(approveStep);
        if (approveStep.trace) traces.push(approveStep.trace);

        if (approveStep.status === 'failed') {
          // Arbiter denied - workflow fails
          throw new Error(`Step ${stepNum} denied: ${approveStep.error}`);
        }

        const approval = approveStep.output as { approved: boolean; reason: string };
        if (!approval.approved) {
          throw new Error(`Step ${stepNum} not approved: ${approval.reason}`);
        }

        // 2b: EXECUTOR - Execute the action
        const executeStep = await this.runExecutorStep(
          workflowId,
          stepNum,
          planAction,
          options.enableCausal
        );
        steps.push(executeStep);
        if (executeStep.trace) traces.push(executeStep.trace);

        if (executeStep.status === 'failed') {
          // Execution failed - but we continue observing
        }

        // 2c: OBSERVER - Verify the execution
        const observeStep = await this.runObserverStep(
          workflowId,
          stepNum,
          planAction,
          executeStep.output
        );
        steps.push(observeStep);
        if (observeStep.trace) traces.push(observeStep.trace);
      }

      // ===========================================
      // Step 3: ARCHIVIST - Store workflow results
      // ===========================================
      const archiveStep = await this.runArchivistStep(workflowId, goal, plan, steps);
      steps.push(archiveStep);
      if (archiveStep.trace) traces.push(archiveStep.trace);

      const endTime = new Date().toISOString();

      // Run SPARQL queries to demonstrate trace querying
      const sparqlQueries = await this.runDemoSparqlQueries();

      const result: WorkflowResult = {
        success: steps.every(s => s.status === 'completed'),
        workflowId,
        goal,
        steps,
        traces,
        timing: {
          startTime,
          endTime,
          durationMs: new Date(endTime).getTime() - new Date(startTime).getTime()
        },
        sparqlQueries
      };

      this.emit('workflow:completed', workflowId, result);
      return result;

    } catch (error) {
      const endTime = new Date().toISOString();
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      this.emit('workflow:failed', workflowId, errorMessage);

      return {
        success: false,
        workflowId,
        goal,
        steps,
        traces,
        timing: {
          startTime,
          endTime,
          durationMs: new Date(endTime).getTime() - new Date(startTime).getTime()
        }
      };
    }
  }

  /**
   * Get SPARQL endpoint for external queries
   */
  getSparqlEndpoint(): SPARQLEndpoint {
    return this.sparqlEndpoint;
  }

  /**
   * Get RDF store for direct access
   */
  getRdfStore(): RDFStore {
    return this.rdfStore;
  }

  /**
   * Export all traces as Turtle
   */
  exportTraces(): string {
    return this.rdfStore.exportTurtle();
  }

  /**
   * Get store statistics
   */
  getStats(): { quads: number; traces: number; agents: number; graphs: number } {
    return this.rdfStore.getStats();
  }

  // ===========================================
  // Step Runners
  // ===========================================

  private async runPlannerStep(
    workflowId: string,
    goal: string,
    constraints?: string[]
  ): Promise<WorkflowStep> {
    const stepId = `${workflowId}#plan`;
    const step: WorkflowStep = {
      id: stepId,
      type: 'plan',
      description: `Create plan for: ${goal}`,
      agentType: 'aat:PlannerAgentType',
      input: { goal, constraints },
      status: 'running'
    };

    this.emit('step:started', stepId, 'plan', step.description);

    try {
      // Get context for planner
      const context = await this.broker.getContext({
        agentDID: `did:key:z6MkPlanner${uuidv4().slice(0, 8)}`,
        credentials: this.createPlannerCredentials()
      });

      // Use LLM to generate plan
      const planResult = await this.llmClient.generatePlan(goal, constraints);

      // Create and store trace
      const trace = this.createTrace(
        context,
        'EmitPlan',
        { goal, constraints },
        { outcome: 'success', plan: planResult }
      );

      await this.rdfStore.store(trace);
      this.emit('trace:stored', trace.id);

      step.output = planResult;
      step.trace = trace;
      step.status = 'completed';

      this.emit('step:completed', stepId, planResult);

    } catch (error) {
      step.status = 'failed';
      step.error = error instanceof Error ? error.message : 'Planning failed';
      this.emit('step:failed', stepId, step.error);
    }

    return step;
  }

  private async runArbiterStep(
    workflowId: string,
    stepNum: number,
    planAction: { action: string; rationale: string },
    policies: string[]
  ): Promise<WorkflowStep> {
    const stepId = `${workflowId}#approve-${stepNum}`;
    const step: WorkflowStep = {
      id: stepId,
      type: 'approve',
      description: `Approve step ${stepNum}: ${planAction.action}`,
      agentType: 'aat:ArbiterAgentType',
      input: { planAction, policies },
      status: 'running'
    };

    this.emit('step:started', stepId, 'approve', step.description);

    try {
      // Get context for arbiter
      const context = await this.broker.getContext({
        agentDID: `did:key:z6MkArbiter${uuidv4().slice(0, 8)}`,
        credentials: this.createArbiterCredentials()
      });

      // Evaluate policy
      const policyResult = this.policyEngine.evaluatePolicies(
        policies,
        planAction.action,
        { target: planAction.action }
      );

      this.emit('policy:evaluated', {
        stepId,
        allowed: policyResult.allowed,
        appliedRules: policies.length,
        denialReasons: policyResult.denialReasons,
        warnings: []
      });

      // Use LLM for approval decision
      const decision = await this.llmClient.makeApprovalDecision(
        planAction.action,
        planAction.rationale,
        policies
      );

      const approved = policyResult.allowed && decision.decision === 'approve';

      // Create and store trace
      const trace = this.createTrace(
        context,
        approved ? 'Approve' : 'Deny',
        { planAction, policies },
        {
          outcome: approved ? 'success' : 'failure',
          decision,
          policyResult
        }
      );

      await this.rdfStore.store(trace);
      this.emit('trace:stored', trace.id);

      step.output = { approved, reason: decision.reason };
      step.trace = trace;
      step.status = 'completed';

      this.emit('step:completed', stepId, step.output);

    } catch (error) {
      step.status = 'failed';
      step.error = error instanceof Error ? error.message : 'Approval failed';
      this.emit('step:failed', stepId, step.error);
    }

    return step;
  }

  private async runExecutorStep(
    workflowId: string,
    stepNum: number,
    planAction: { action: string; rationale: string },
    enableCausal?: boolean
  ): Promise<WorkflowStep> {
    const stepId = `${workflowId}#execute-${stepNum}`;
    const step: WorkflowStep = {
      id: stepId,
      type: 'execute',
      description: `Execute step ${stepNum}: ${planAction.action}`,
      agentType: 'aat:ExecutorAgentType',
      input: { planAction },
      status: 'running'
    };

    this.emit('step:started', stepId, 'execute', step.description);

    try {
      // Get context for executor
      const context = await this.broker.getContext({
        agentDID: `did:key:z6MkExecutor${uuidv4().slice(0, 8)}`,
        credentials: this.createExecutorCredentials()
      });

      // Simulate execution (in real system, would call actual tools)
      const executionResult = {
        status: 'completed',
        action: planAction.action,
        timestamp: new Date().toISOString(),
        output: `Executed: ${planAction.action}`
      };

      // Create causal label if enabled
      const causalLabel = enableCausal
        ? `do(action=${planAction.action.replace(/[^a-zA-Z0-9]/g, '_')})`
        : undefined;

      // Create and store trace
      const trace = this.createTrace(
        context,
        'Act',
        { planAction },
        { outcome: 'success', result: executionResult },
        causalLabel
      );

      await this.rdfStore.store(trace);
      this.emit('trace:stored', trace.id);

      step.output = executionResult;
      step.trace = trace;
      step.status = 'completed';

      this.emit('step:completed', stepId, executionResult);

    } catch (error) {
      step.status = 'failed';
      step.error = error instanceof Error ? error.message : 'Execution failed';
      this.emit('step:failed', stepId, step.error);
    }

    return step;
  }

  private async runObserverStep(
    workflowId: string,
    stepNum: number,
    planAction: { action: string; rationale: string },
    executionResult: unknown
  ): Promise<WorkflowStep> {
    const stepId = `${workflowId}#observe-${stepNum}`;
    const step: WorkflowStep = {
      id: stepId,
      type: 'observe',
      description: `Verify step ${stepNum}: ${planAction.action}`,
      agentType: 'aat:ObserverAgentType',
      input: { planAction, executionResult },
      status: 'running'
    };

    this.emit('step:started', stepId, 'observe', step.description);

    try {
      // Get context for observer
      const context = await this.broker.getContext({
        agentDID: `did:key:z6MkObserver${uuidv4().slice(0, 8)}`,
        credentials: this.createObserverCredentials()
      });

      // Use LLM to summarize observations
      const observations = [
        `Action "${planAction.action}" was executed`,
        `Expected outcome: ${planAction.rationale}`,
        `Actual result: ${JSON.stringify(executionResult)}`
      ];

      const summary = await this.llmClient.summarizeObservations(
        observations,
        `Verifying step ${stepNum} of workflow`
      );

      const observationResult = {
        verified: true,
        summary,
        timestamp: new Date().toISOString()
      };

      // Create and store trace
      const trace = this.createTrace(
        context,
        'Report',
        { planAction, executionResult },
        { outcome: 'success', observation: observationResult }
      );

      await this.rdfStore.store(trace);
      this.emit('trace:stored', trace.id);

      step.output = observationResult;
      step.trace = trace;
      step.status = 'completed';

      this.emit('step:completed', stepId, observationResult);

    } catch (error) {
      step.status = 'failed';
      step.error = error instanceof Error ? error.message : 'Observation failed';
      this.emit('step:failed', stepId, step.error);
    }

    return step;
  }

  private async runArchivistStep(
    workflowId: string,
    goal: string,
    plan: { goal: string; steps: Array<{ action: string; rationale: string }> },
    completedSteps: WorkflowStep[]
  ): Promise<WorkflowStep> {
    const stepId = `${workflowId}#archive`;
    const step: WorkflowStep = {
      id: stepId,
      type: 'archive',
      description: `Archive workflow: ${goal}`,
      agentType: 'aat:ArchivistAgentType',
      input: { goal, plan, stepsCount: completedSteps.length },
      status: 'running'
    };

    this.emit('step:started', stepId, 'archive', step.description);

    try {
      // Get context for archivist
      const context = await this.broker.getContext({
        agentDID: `did:key:z6MkArchivist${uuidv4().slice(0, 8)}`,
        credentials: this.createArchivistCredentials()
      });

      const archiveRecord = {
        workflowId,
        goal,
        plan,
        completedSteps: completedSteps.map(s => ({
          id: s.id,
          type: s.type,
          status: s.status,
          traceId: s.trace?.id
        })),
        archivedAt: new Date().toISOString()
      };

      // Create and store trace
      const trace = this.createTrace(
        context,
        'Store',
        { workflowId, goal },
        { outcome: 'success', record: archiveRecord }
      );

      await this.rdfStore.store(trace);
      this.emit('trace:stored', trace.id);

      step.output = archiveRecord;
      step.trace = trace;
      step.status = 'completed';

      this.emit('step:completed', stepId, archiveRecord);

    } catch (error) {
      step.status = 'failed';
      step.error = error instanceof Error ? error.message : 'Archive failed';
      this.emit('step:failed', stepId, step.error);
    }

    return step;
  }

  // ===========================================
  // Helper Methods
  // ===========================================

  private createTrace(
    context: ContextGraph,
    actionType: string,
    input: Record<string, unknown>,
    output: { outcome: string; [key: string]: unknown },
    interventionLabel?: string
  ): ProvTrace {
    const now = new Date().toISOString();
    const affordance = context.affordances.find(a => a.actionType === actionType);

    return {
      '@context': ['https://www.w3.org/ns/prov-o', 'https://agentcontextgraph.dev/ontology'],
      '@type': ['prov:Activity', 'acg:AgentAction'],
      id: `urn:uuid:${uuidv4()}`,
      startedAtTime: now,
      endedAtTime: now,
      wasAssociatedWith: {
        agentDID: context.agentDID,
        agentType: context.agentType
      },
      used: {
        contextSnapshot: {
          contextId: context.id,
          timestamp: context.timestamp,
          nonce: context.nonce,
          agentDID: context.agentDID,
          affordanceCount: context.affordances.length
        },
        affordance: {
          id: affordance?.id ?? `aff-${actionType}`,
          rel: affordance?.rel ?? 'self',
          relVersion: affordance?.relVersion ?? '1.0',
          actionType,
          targetType: affordance?.target?.type ?? 'Internal'
        },
        parameters: input,
        credentials: []
      },
      generated: {
        outcome: {
          status: output.outcome === 'success' ? 'success' : 'failure',
          resultType: typeof output.result === 'string' ? output.result : undefined
        }
      },
      interventionLabel
    };
  }

  private createTraceStoreAdapter(): ITraceStore {
    const rdfStore = this.rdfStore;

    return {
      async store(trace: ProvTrace): Promise<StoreResult> {
        return rdfStore.store(trace);
      },
      async query(query: TraceQuery): Promise<ProvTrace[]> {
        return rdfStore.query(query);
      },
      async getById(traceId: string): Promise<ProvTrace | null> {
        return rdfStore.getById(traceId);
      }
    };
  }

  private createPlannerCredentials(): unknown[] {
    return [{
      type: ['VerifiableCredential', 'AgentCapabilityCredential'],
      issuer: 'did:web:authority.example.com',
      credentialSubject: {
        capability: 'PlannerCapability',
        agentType: 'aat:PlannerAgentType'
      },
      expirationDate: '2030-01-01T00:00:00Z'
    }];
  }

  private createArbiterCredentials(): unknown[] {
    return [{
      type: ['VerifiableCredential', 'AgentCapabilityCredential'],
      issuer: 'did:web:authority.example.com',
      credentialSubject: {
        capability: 'ArbiterCapability',
        agentType: 'aat:ArbiterAgentType'
      },
      expirationDate: '2030-01-01T00:00:00Z'
    }];
  }

  private createExecutorCredentials(): unknown[] {
    return [{
      type: ['VerifiableCredential', 'AgentCapabilityCredential'],
      issuer: 'did:web:authority.example.com',
      credentialSubject: {
        capability: 'ExecutorCapability',
        agentType: 'aat:ExecutorAgentType'
      },
      expirationDate: '2030-01-01T00:00:00Z'
    }];
  }

  private createObserverCredentials(): unknown[] {
    return [{
      type: ['VerifiableCredential', 'AgentCapabilityCredential'],
      issuer: 'did:web:authority.example.com',
      credentialSubject: {
        capability: 'ObserverCapability',
        agentType: 'aat:ObserverAgentType'
      },
      expirationDate: '2030-01-01T00:00:00Z'
    }];
  }

  private createArchivistCredentials(): unknown[] {
    return [{
      type: ['VerifiableCredential', 'AgentCapabilityCredential'],
      issuer: 'did:web:authority.example.com',
      credentialSubject: {
        capability: 'ArchivistCapability',
        agentType: 'aat:ArchivistAgentType'
      },
      expirationDate: '2030-01-01T00:00:00Z'
    }];
  }

  private async runDemoSparqlQueries(): Promise<Record<string, unknown>> {
    const results: Record<string, unknown> = {};

    // Query 1: Get all traces
    const allTraces = this.sparqlEndpoint.executeNamedQuery('agent-summary');
    results['agent-summary'] = sparqlToJson(allTraces);

    // Query 2: Get action distribution
    const actionDist = this.sparqlEndpoint.executeNamedQuery('action-distribution');
    results['action-distribution'] = sparqlToJson(actionDist);

    // Query 3: Get causal interventions
    const causal = this.sparqlEndpoint.executeNamedQuery('causal-interventions');
    results['causal-interventions'] = sparqlToJson(causal);

    // Query 4: Store statistics
    results['store-stats'] = this.rdfStore.getStats();

    return results;
  }
}
