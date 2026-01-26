/**
 * Multi-Agent Collaboration Demo
 *
 * This demo shows how the orchestrator coordinates multiple agents
 * to achieve a goal. It runs both the broker and orchestrator in-process.
 */

import { ContextBroker } from '../broker/context-broker.js';
import { Orchestrator } from '../agents/orchestrator.js';
import { AATRegistry } from '../services/aat-registry.js';
import { StubVerifier } from '../services/verifier.js';
import { PolicyEngine } from '../services/policy-engine.js';
import { StubCausalEvaluator } from '../services/causal-evaluator.js';
import { InMemoryTraceStore } from '../services/trace-store.js';
import Hapi from '@hapi/hapi';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function runDemo() {
  console.log('');
  console.log('='.repeat(70));
  console.log('  Agent Context Graph - Multi-Agent Collaboration Demo');
  console.log('='.repeat(70));
  console.log('');

  // Check for API key
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ERROR: ANTHROPIC_API_KEY environment variable is required');
    console.log('');
    console.log('Set it with:');
    console.log('  export ANTHROPIC_API_KEY=your-key-here');
    console.log('');
    process.exit(1);
  }

  console.log('Step 1: Setting up services...');

  // =====================================================
  // Set up the Context Broker
  // =====================================================
  const aatRegistry = new AATRegistry();

  // Load AAT specs
  const specDir = join(__dirname, '..', '..', 'spec', 'aat');
  try {
    const aatFiles = ['planner.json', 'executor.json', 'observer.json', 'arbiter.json', 'archivist.json'];
    for (const file of aatFiles) {
      try {
        const content = readFileSync(join(specDir, file), 'utf-8');
        aatRegistry.register(JSON.parse(content));
      } catch {
        // File might not exist, skip
      }
    }
    console.log(`  - Loaded AATs: ${aatRegistry.getRegisteredAATs().join(', ')}`);
  } catch {
    console.log('  - Using default AAT configuration');
  }

  // If no AATs loaded, register defaults
  if (aatRegistry.getRegisteredAATs().length === 0) {
    aatRegistry.register({
      id: 'aat:PlannerAgentType',
      name: 'Planner',
      version: '1.0.0',
      description: 'Planning agent',
      perceptSpace: { description: '', types: [] },
      actionSpace: {
        allowed: [
          { type: 'EmitPlan', description: 'Create a plan', requiresCapability: 'PlannerCapability' },
          { type: 'RequestInfo', description: 'Request information', requiresCapability: null }
        ],
        forbidden: [
          { type: 'Actuate', description: 'Direct execution', rationale: 'Planners cannot actuate' }
        ]
      },
      internalState: { description: '', components: [] },
      behavioralInvariants: [],
      traceRequirements: { mustEmitProvActivity: true, requiredFields: [], retentionPolicy: '' },
      livenessGuarantees: [],
      compositionRules: { canComposeBefore: [], canComposeAfter: [], notes: '' }
    });

    aatRegistry.register({
      id: 'aat:ExecutorAgentType',
      name: 'Executor',
      version: '1.0.0',
      description: 'Execution agent',
      perceptSpace: { description: '', types: [] },
      actionSpace: {
        allowed: [
          { type: 'Act', description: 'Execute action', requiresCapability: 'ExecutorCapability' },
          { type: 'ReportOutcome', description: 'Report result', requiresCapability: null }
        ],
        forbidden: [
          { type: 'EmitPlan', description: 'Creating plans', rationale: 'Executors follow plans' }
        ]
      },
      internalState: { description: '', components: [] },
      behavioralInvariants: [],
      traceRequirements: { mustEmitProvActivity: true, requiredFields: [], retentionPolicy: '' },
      livenessGuarantees: [],
      compositionRules: { canComposeBefore: [], canComposeAfter: [], notes: '' }
    });

    console.log('  - Registered default AATs');
  }

  const verifier = new StubVerifier(['did:web:authority.example.com']);
  const policyEngine = new PolicyEngine();
  const causalEvaluator = new StubCausalEvaluator();
  const traceStore = new InMemoryTraceStore();

  const broker = new ContextBroker(
    verifier,
    policyEngine,
    aatRegistry,
    traceStore,
    causalEvaluator
  );

  // =====================================================
  // Start the Broker Server
  // =====================================================
  const brokerServer = Hapi.server({
    port: 3000,
    host: '0.0.0.0'
  });

  brokerServer.route({
    method: 'POST',
    path: '/context',
    handler: async (request, h) => {
      try {
        const payload = request.payload as { agentDID: string; credentials?: unknown[] };
        const context = await broker.getContext(payload);
        return h.response(context).code(200);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return h.response({ error: message }).code(400);
      }
    }
  });

  brokerServer.route({
    method: 'POST',
    path: '/traverse',
    handler: async (request, h) => {
      try {
        const payload = request.payload as {
          contextId: string;
          affordanceId: string;
          parameters: Record<string, unknown>;
        };
        const result = await broker.traverse(payload);
        return h.response(result).code(200);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return h.response({ error: message }).code(400);
      }
    }
  });

  await brokerServer.start();
  console.log(`  - Context Broker running at: ${brokerServer.info.uri}`);

  // =====================================================
  // Create the Orchestrator
  // =====================================================
  const orchestrator = new Orchestrator({
    brokerUrl: brokerServer.info.uri,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    maxConcurrentAgents: 3
  });

  // Set up event logging
  orchestrator.on('workflow-started', (id, goal) => {
    console.log(`\n[Workflow] Started: ${goal}`);
    console.log(`  ID: ${id}`);
  });

  orchestrator.on('agent-spawned', (agentId, type) => {
    console.log(`[Agent] Spawned ${type} agent`);
  });

  orchestrator.on('task-routed', (taskId, agentId) => {
    console.log(`[Task] Routed to agent`);
  });

  orchestrator.on('workflow-completed', (id, result) => {
    console.log(`\n[Workflow] Completed!`);
    console.log('Result:', JSON.stringify(result, null, 2));
  });

  orchestrator.on('workflow-failed', (id, error) => {
    console.log(`\n[Workflow] Failed: ${error}`);
  });

  orchestrator.start();
  console.log('  - Orchestrator started');

  console.log('');
  console.log('Step 2: Submitting goal to orchestrator...');
  console.log('');

  // =====================================================
  // Submit a Goal
  // =====================================================
  const goal = process.argv[2] ?? 'Create a simple TODO list application with add, remove, and list functionality';

  console.log(`Goal: "${goal}"`);
  console.log('');
  console.log('-'.repeat(70));
  console.log('');

  const workflowId = await orchestrator.submitGoal(goal, {
    priority: 'high'
  });

  // =====================================================
  // Monitor Progress
  // =====================================================
  console.log('Monitoring workflow progress...');
  console.log('(This may take a minute as agents reason about the task)');
  console.log('');

  // Poll for completion
  let completed = false;
  let attempts = 0;
  const maxAttempts = 60; // 60 seconds timeout

  while (!completed && attempts < maxAttempts) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    attempts++;

    const workflow = orchestrator.getWorkflowStatus(workflowId);
    if (!workflow) continue;

    if (workflow.status === 'completed' || workflow.status === 'failed') {
      completed = true;
    }

    // Show progress every 5 seconds
    if (attempts % 5 === 0) {
      const stats = orchestrator.getStats();
      console.log(`  [${attempts}s] Workflow: ${workflow.status}, Tasks: ${stats.tasks.total}, Agents: ${stats.agents.busy} busy / ${stats.agents.idle} idle`);
    }
  }

  // =====================================================
  // Show Final Results
  // =====================================================
  console.log('');
  console.log('='.repeat(70));
  console.log('  Final Results');
  console.log('='.repeat(70));
  console.log('');

  const finalWorkflow = orchestrator.getWorkflowStatus(workflowId);
  if (finalWorkflow) {
    console.log(`Status: ${finalWorkflow.status}`);
    console.log(`Tasks completed: ${finalWorkflow.tasks.length}`);
    console.log('');

    if (finalWorkflow.result) {
      console.log('Output:');
      console.log(JSON.stringify(finalWorkflow.result, null, 2));
    }
  }

  // Show trace statistics
  console.log('');
  console.log('Trace Statistics:');
  console.log(`  Total traces stored: ${traceStore.getCount()}`);

  // =====================================================
  // Cleanup
  // =====================================================
  console.log('');
  console.log('Shutting down...');
  orchestrator.stop();
  await brokerServer.stop();

  console.log('Demo complete!');
  process.exit(0);
}

// Handle errors
process.on('unhandledRejection', (err) => {
  console.error('Unhandled error:', err);
  process.exit(1);
});

// Run the demo
runDemo();
