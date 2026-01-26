import Hapi from '@hapi/hapi';
import { Orchestrator } from './agents/orchestrator.js';

async function init() {
  // Get configuration from environment
  const brokerUrl = process.env.BROKER_URL ?? 'http://localhost:3000';
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
  const port = process.env.ORCHESTRATOR_PORT ?? 3001;
  const useClaudeCodeCLI = process.env.USE_CLAUDE_CLI === 'true';
  const claudeCliPath = process.env.CLAUDE_CLI_PATH ?? 'claude';

  // Validate configuration based on backend
  if (!useClaudeCodeCLI && !anthropicApiKey) {
    console.error('ANTHROPIC_API_KEY environment variable is required when not using Claude Code CLI');
    console.error('Set USE_CLAUDE_CLI=true to use Claude Code CLI instead');
    process.exit(1);
  }

  // Create orchestrator with appropriate backend
  const orchestrator = new Orchestrator({
    brokerUrl,
    anthropicApiKey,
    maxConcurrentAgents: 5,
    useClaudeCodeCLI,
    cliConfig: useClaudeCodeCLI ? {
      cliPath: claudeCliPath,
      workingDirectory: process.cwd(),
      timeout: 120000
    } : undefined
  });

  // Set up event logging
  orchestrator.on('workflow-started', (id, goal) => {
    console.log(`[Workflow ${id}] Started: ${goal}`);
  });

  orchestrator.on('workflow-completed', (id, result) => {
    console.log(`[Workflow ${id}] Completed:`, JSON.stringify(result, null, 2));
  });

  orchestrator.on('workflow-failed', (id, error) => {
    console.error(`[Workflow ${id}] Failed: ${error}`);
  });

  orchestrator.on('agent-spawned', (agentId, type) => {
    console.log(`[Agent] Spawned ${type}: ${agentId}`);
  });

  orchestrator.on('task-routed', (taskId, agentId) => {
    console.log(`[Task ${taskId}] Routed to agent ${agentId}`);
  });

  // Start orchestrator
  orchestrator.start();

  // Create Hapi server
  const server = Hapi.server({
    port,
    host: '0.0.0.0',
    routes: {
      cors: true
    }
  });

  // Health check
  server.route({
    method: 'GET',
    path: '/health',
    handler: () => ({
      status: 'healthy',
      timestamp: new Date().toISOString()
    })
  });

  // Submit a goal
  server.route({
    method: 'POST',
    path: '/goals',
    handler: async (request, h) => {
      try {
        const payload = request.payload as {
          goal: string;
          priority?: 'low' | 'normal' | 'high' | 'critical';
          constraints?: string[];
          requiresApproval?: boolean;
        };

        if (!payload.goal) {
          return h.response({ error: 'goal is required' }).code(400);
        }

        const workflowId = await orchestrator.submitGoal(payload.goal, {
          priority: payload.priority,
          constraints: payload.constraints,
          requiresApproval: payload.requiresApproval
        });

        return h.response({
          workflowId,
          message: 'Goal submitted successfully'
        }).code(201);

      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return h.response({ error: message }).code(500);
      }
    }
  });

  // Get workflow status
  server.route({
    method: 'GET',
    path: '/workflows/{id}',
    handler: (request, h) => {
      const workflow = orchestrator.getWorkflowStatus(request.params.id);
      if (!workflow) {
        return h.response({ error: 'Workflow not found' }).code(404);
      }
      return h.response(workflow).code(200);
    }
  });

  // List all workflows
  server.route({
    method: 'GET',
    path: '/workflows',
    handler: () => {
      return { workflows: orchestrator.getAllWorkflows() };
    }
  });

  // Get orchestrator stats
  server.route({
    method: 'GET',
    path: '/stats',
    handler: () => {
      return orchestrator.getStats();
    }
  });

  // Stop orchestrator gracefully on shutdown
  process.on('SIGINT', () => {
    console.log('\nShutting down...');
    orchestrator.stop();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    console.log('\nShutting down...');
    orchestrator.stop();
    process.exit(0);
  });

  await server.start();

  console.log('');
  console.log('='.repeat(60));
  console.log('Agent Context Graph - Orchestrator');
  console.log('='.repeat(60));
  console.log(`Server running at: ${server.info.uri}`);
  console.log(`Broker URL: ${brokerUrl}`);
  console.log(`Reasoning Backend: ${useClaudeCodeCLI ? 'Claude Code CLI' : 'Anthropic API'}`);
  console.log('');
  console.log('Endpoints:');
  console.log('  POST /goals          - Submit a goal for agents to achieve');
  console.log('  GET  /workflows      - List all workflows');
  console.log('  GET  /workflows/{id} - Get workflow status');
  console.log('  GET  /stats          - Get orchestrator statistics');
  console.log('  GET  /health         - Health check');
  console.log('');
  console.log('Example:');
  console.log(`  curl -X POST ${server.info.uri}/goals \\`);
  console.log('    -H "Content-Type: application/json" \\');
  console.log('    -d \'{"goal": "Create a REST API for user management"}\'');
  console.log('='.repeat(60));
}

process.on('unhandledRejection', (err) => {
  console.error(err);
  process.exit(1);
});

init();
