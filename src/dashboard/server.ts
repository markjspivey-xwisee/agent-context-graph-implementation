import Hapi from '@hapi/hapi';
import inert from '@hapi/inert';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync, existsSync, appendFileSync } from 'fs';
import { WebSocketServer, WebSocket } from 'ws';
import { Orchestrator } from '../agents/orchestrator.js';
import { ContextBroker } from '../broker/context-broker.js';
import { AATRegistry } from '../services/aat-registry.js';
import { StubVerifier } from '../services/verifier.js';
import { PolicyEngine } from '../services/policy-engine.js';
import { InMemoryTraceStore } from '../services/trace-store.js';
import { StubCausalEvaluator } from '../services/causal-evaluator.js';
import { resolveSpecPath } from '../utils/spec-path.js';
import { KnowledgeGraphService } from '../services/knowledge-graph-service.js';

// ============================================================
// Structured Logging
// ============================================================
type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  component: string;
  message: string;
  data?: Record<string, unknown>;
}

const logHistory: LogEntry[] = [];
const MAX_LOG_HISTORY = 1000;

function log(level: LogLevel, component: string, message: string, data?: Record<string, unknown>) {
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    component,
    message,
    data
  };

  logHistory.push(entry);
  if (logHistory.length > MAX_LOG_HISTORY) {
    logHistory.shift();
  }

  const prefix = `[${entry.timestamp}] [${level.toUpperCase()}] [${component}]`;
  const logMessage = data ? `${prefix} ${message} ${JSON.stringify(data)}` : `${prefix} ${message}`;

  switch (level) {
    case 'error': console.error(logMessage); break;
    case 'warn': console.warn(logMessage); break;
    default: console.log(logMessage);
  }

  // Broadcast to WebSocket clients
  broadcastLog(entry);
}

// ============================================================
// WebSocket Management
// ============================================================
let wss: WebSocketServer | null = null;
const wsClients = new Set<WebSocket>();

function broadcastLog(entry: LogEntry) {
  broadcast({ type: 'log', payload: entry });
}

function broadcast(message: { type: string; payload: unknown }) {
  const data = JSON.stringify(message);
  for (const client of wsClients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  }
}

// ============================================================
// Credential Store (in-memory for demo)
// ============================================================
interface StoredCredential {
  id: string;
  type: string[];
  issuer: string;
  issuanceDate: string;
  expirationDate: string;
  credentialSubject: Record<string, unknown>;
}

const credentialStore = new Map<string, StoredCredential>();

// Pre-populate with demo credentials
function initCredentialStore() {
  const demoCredentials: StoredCredential[] = [
    {
      id: 'urn:uuid:cred-planner-001',
      type: ['VerifiableCredential', 'PlannerCapability'],
      issuer: 'did:web:authority.example.com',
      issuanceDate: new Date().toISOString(),
      expirationDate: '2030-01-01T00:00:00Z',
      credentialSubject: { capability: 'PlannerCapability', scope: '*' }
    },
    {
      id: 'urn:uuid:cred-executor-001',
      type: ['VerifiableCredential', 'ExecutorCapability'],
      issuer: 'did:web:authority.example.com',
      issuanceDate: new Date().toISOString(),
      expirationDate: '2030-01-01T00:00:00Z',
      credentialSubject: { capability: 'ExecutorCapability', scope: 'file:*,api:*' }
    },
    {
      id: 'urn:uuid:cred-observer-001',
      type: ['VerifiableCredential', 'ObserverCapability'],
      issuer: 'did:web:authority.example.com',
      issuanceDate: new Date().toISOString(),
      expirationDate: '2030-01-01T00:00:00Z',
      credentialSubject: { capability: 'ObserverCapability', scope: '*' }
    },
    {
      id: 'urn:uuid:cred-arbiter-001',
      type: ['VerifiableCredential', 'ArbiterCapability'],
      issuer: 'did:web:authority.example.com',
      issuanceDate: new Date().toISOString(),
      expirationDate: '2030-01-01T00:00:00Z',
      credentialSubject: { capability: 'ArbiterCapability', policyAuthority: true }
    },
    {
      id: 'urn:uuid:cred-coordinator-001',
      type: ['VerifiableCredential', 'CoordinatorCapability'],
      issuer: 'did:web:authority.example.com',
      issuanceDate: new Date().toISOString(),
      expirationDate: '2030-01-01T00:00:00Z',
      credentialSubject: { capability: 'CoordinatorCapability', maxDelegations: 10 }
    }
  ];

  for (const cred of demoCredentials) {
    credentialStore.set(cred.id, cred);
  }
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function init() {
  // Get configuration from environment
  // Default broker URL is the dashboard server itself (self-contained)
  const brokerUrl = process.env.BROKER_URL ?? `http://localhost:${process.env.DASHBOARD_PORT ?? 3001}`;
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
  const port = process.env.DASHBOARD_PORT ?? 3001;
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
    maxConcurrentAgents: 10,
    useClaudeCodeCLI,
    cliConfig: useClaudeCodeCLI ? {
      cliPath: claudeCliPath,
      workingDirectory: process.cwd(),
      timeout: 120000
    } : undefined
  });

  // Initialize credential store
  initCredentialStore();
  log('info', 'credentials', `Initialized credential store with ${credentialStore.size} demo credentials`);

  // Set up event logging with structured logging and WebSocket broadcast
  orchestrator.on('workflow-started', (id, goal) => {
    log('info', 'workflow', `Workflow started: ${goal}`, { workflowId: id, goal });
    broadcast({ type: 'workflow-started', payload: { id, goal, timestamp: new Date().toISOString() } });
  });

  orchestrator.on('workflow-completed', (id, result) => {
    log('info', 'workflow', `Workflow completed`, { workflowId: id });
    broadcast({ type: 'workflow-completed', payload: { id, result, timestamp: new Date().toISOString() } });
  });

  orchestrator.on('workflow-failed', (id, error) => {
    log('error', 'workflow', `Workflow failed: ${error}`, { workflowId: id, error });
    broadcast({ type: 'workflow-failed', payload: { id, error, timestamp: new Date().toISOString() } });
  });

  orchestrator.on('agent-spawned', (agentId, type) => {
    log('info', 'agent', `Spawned ${type} agent`, { agentId: agentId.slice(0, 8), type });
    broadcast({ type: 'agent-spawned', payload: { agentId, agentType: type, timestamp: new Date().toISOString() } });
  });

  orchestrator.on('task-routed', (taskId, agentId) => {
    log('debug', 'task', `Task routed to agent`, { taskId, agentId: agentId.slice(0, 8) });
    broadcast({ type: 'task-routed', payload: { taskId, agentId, timestamp: new Date().toISOString() } });
  });

  orchestrator.on('agent-completed', (agentId, result) => {
    log('info', 'agent', `Agent completed task`, { agentId: agentId.slice(0, 8) });
    broadcast({ type: 'agent-completed', payload: { agentId, result, timestamp: new Date().toISOString() } });
  });

  orchestrator.on('agent-failed', (agentId, error) => {
    log('error', 'agent', `Agent failed: ${error}`, { agentId: agentId.slice(0, 8), error });
    broadcast({ type: 'agent-failed', payload: { agentId, error, timestamp: new Date().toISOString() } });
  });

  // Initialize the real ContextBroker with proper AAT integration
  const specDir = resolveSpecPath('aat');
  const shaclDir = resolveSpecPath('shacl');

  const aatRegistry = new AATRegistry();
  if (existsSync(specDir)) {
    try {
      aatRegistry.loadFromDirectory(specDir);
    } catch (error) {
      console.warn('AAT spec loading skipped:', error);
    }
  }
  const verifier = new StubVerifier(['did:web:authority.example.com']);
  const policyEngine = new PolicyEngine();
  const traceStore = new InMemoryTraceStore();
  const causalEvaluator = new StubCausalEvaluator();

  const knowledgeGraphService = new KnowledgeGraphService([
    {
      id: 'urn:kg:default',
      label: 'Enterprise Knowledge Graph',
      version: '2026.01',
      ontologyRefs: [
        'https://www.w3.org/ns/dcat#',
        'https://www.omg.org/spec/DPROD/',
        'https://www.w3.org/ns/r2rml#'
      ],
      queryEndpoint: 'https://broker.example.com/knowledge-graphs/default/query',
      updateEndpoint: 'https://broker.example.com/knowledge-graphs/default/update',
      mappingsRef: 'https://broker.example.com/knowledge-graphs/default/mappings'
    }
  ]);

  const contextBroker = new ContextBroker(
    verifier,
    policyEngine,
    aatRegistry,
    traceStore,
    causalEvaluator,
    undefined,
    undefined,
    undefined,
    knowledgeGraphService
  );

  // Initialize SHACL validation if spec directory exists
  if (existsSync(shaclDir)) {
    try {
      await contextBroker.initializeSHACL(shaclDir);
      console.log('SHACL validation initialized');
    } catch (err) {
      console.warn('SHACL initialization skipped:', err);
    }
  }

  // Start orchestrator
  orchestrator.start();

  // Create Hapi server
  const server = Hapi.server({
    port,
    host: '0.0.0.0',
    routes: {
      cors: {
        origin: ['*'],
        headers: ['Accept', 'Content-Type'],
        additionalHeaders: ['X-Requested-With']
      },
      files: {
        relativeTo: __dirname
      }
    }
  });

  // Register inert for static files
  await server.register(inert);

  // Serve dashboard - index.html is in src/dashboard, not dist/dashboard
  const srcDashboardDir = join(__dirname, '..', '..', 'src', 'dashboard');
  server.route({
    method: 'GET',
    path: '/',
    handler: (request, h) => {
      return h.file(join(srcDashboardDir, 'index.html'), { confine: false });
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

  // Serve golden path examples
  server.route({
    method: 'GET',
    path: '/examples/{name}',
    handler: (request, h) => {
      const name = request.params.name;
      // Go up from dist/dashboard to project root, then into examples
      const examplePath = join(__dirname, '..', '..', 'examples', 'golden-path', `${name}.json`);

      if (!existsSync(examplePath)) {
        return h.response({ error: `Example '${name}' not found` }).code(404);
      }

      try {
        const content = readFileSync(examplePath, 'utf-8');
        const json = JSON.parse(content);
        return h.response(json).type('application/ld+json');
      } catch (err) {
        return h.response({ error: 'Failed to load example' }).code(500);
      }
    }
  });

  // List available examples
  server.route({
    method: 'GET',
    path: '/examples',
    handler: (h) => {
      return {
        examples: [
          { id: 'observer-context', name: 'Observer Agent', category: 'Agent Contexts' },
          { id: 'arbiter-context', name: 'Arbiter Agent', category: 'Agent Contexts' },
          { id: 'archivist-context', name: 'Archivist Agent', category: 'Agent Contexts' },
          { id: 'coordinator-context', name: 'Coordinator Agent', category: 'Agent Contexts' },
          { id: 'federated-context', name: 'Federated Context', category: 'Federation' },
          { id: 'multi-hop-federation-context', name: 'Multi-Hop Federation', category: 'Federation' },
          { id: 'delegated-planning-context', name: 'Delegated Planning', category: 'Advanced Scenarios' },
          { id: 'causal-intervention-context', name: 'Causal Intervention', category: 'Advanced Scenarios' },
          { id: 'causal-affordance', name: 'Causal Affordance', category: 'Advanced Scenarios' },
          { id: 'error-scenario-context', name: 'Error Scenario', category: 'Advanced Scenarios' },
          { id: 'infrastructure-context', name: 'Infrastructure Context', category: 'Infrastructure' },
          { id: 'context-fragment', name: 'Context Fragment', category: 'Infrastructure' },
          { id: 'prov-trace', name: 'PROV Trace', category: 'Infrastructure' },
          { id: 'request-credential', name: 'Request Credential', category: 'Infrastructure' }
        ]
      };
    }
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

  // Get detailed workflow info
  server.route({
    method: 'GET',
    path: '/workflows/{id}/detail',
    handler: (request, h) => {
      const detail = orchestrator.getWorkflowDetail(request.params.id);
      if (!detail) {
        return h.response({ error: 'Workflow not found' }).code(404);
      }
      return h.response(detail).code(200);
    }
  });

  // Get all agents
  server.route({
    method: 'GET',
    path: '/agents',
    handler: () => {
      return { agents: orchestrator.getAgents() };
    }
  });

  // Get all tasks
  server.route({
    method: 'GET',
    path: '/tasks',
    handler: () => {
      return { tasks: orchestrator.getAllTasks() };
    }
  });

  // Get context graph using real ContextBroker (GET - for dashboard display)
  server.route({
    method: 'GET',
    path: '/context',
    handler: async (request, h) => {
      try {
        // Default context for dashboard display (Coordinator type)
        const context = await contextBroker.getContext({
          agentDID: 'did:key:z6MkDashboardOrchestratorAgent',
          credentials: [{
            type: ['VerifiableCredential', 'CoordinatorCapability'],
            issuer: 'did:web:authority.example.com',
            expirationDate: '2030-01-01T00:00:00Z',
            credentialSubject: { capability: 'CoordinatorCapability' }
          }]
        });
        return h.response(context).type('application/ld+json');
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        return h.response({ error: message }).code(500);
      }
    }
  });

  // Get context graph using real ContextBroker (POST - for agents)
  server.route({
    method: 'POST',
    path: '/context',
    handler: async (request, h) => {
      try {
        const payload = request.payload as {
          agentDID?: string;
          credentials?: unknown[];
          scope?: { domain?: string; resources?: string[] };
        } | null;

        const context = await contextBroker.getContext({
          agentDID: payload?.agentDID ?? 'did:key:z6MkUnknownAgent',
          credentials: payload?.credentials,
          scope: payload?.scope
        });

        return h.response(context).type('application/ld+json');
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        return h.response({ error: message }).code(500);
      }
    }
  });

  // Traverse an affordance using real ContextBroker
  server.route({
    method: 'POST',
    path: '/traverse',
    handler: async (request, h) => {
      try {
        const payload = request.payload as {
          contextId: string;
          affordanceId: string;
          parameters: Record<string, unknown>;
          credentials?: unknown[];
        };

        const result = await contextBroker.traverse({
          contextId: payload.contextId,
          affordanceId: payload.affordanceId,
          parameters: payload.parameters,
          credentials: payload.credentials
        });

        return h.response({
          success: result.success,
          result: result.result,
          trace: result.trace,
          newContext: result.newContext
        }).code(result.success ? 200 : 400);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        return h.response({ error: message, success: false }).code(400);
      }
    }
  });

  // ============================================================
  // Credential Management API
  // ============================================================
  server.route({
    method: 'GET',
    path: '/credentials',
    handler: () => {
      return { credentials: Array.from(credentialStore.values()) };
    }
  });

  server.route({
    method: 'GET',
    path: '/credentials/{id}',
    handler: (request, h) => {
      const id = decodeURIComponent(request.params.id);
      const cred = credentialStore.get(id);
      if (!cred) {
        return h.response({ error: 'Credential not found' }).code(404);
      }
      return cred;
    }
  });

  server.route({
    method: 'POST',
    path: '/credentials',
    handler: (request, h) => {
      const payload = request.payload as Partial<StoredCredential>;
      const id = payload.id ?? `urn:uuid:cred-${Date.now()}`;
      const cred: StoredCredential = {
        id,
        type: payload.type ?? ['VerifiableCredential'],
        issuer: payload.issuer ?? 'did:web:authority.example.com',
        issuanceDate: new Date().toISOString(),
        expirationDate: payload.expirationDate ?? '2030-01-01T00:00:00Z',
        credentialSubject: payload.credentialSubject ?? {}
      };
      credentialStore.set(id, cred);
      log('info', 'credentials', `Created credential`, { id, type: cred.type });
      return h.response(cred).code(201);
    }
  });

  server.route({
    method: 'DELETE',
    path: '/credentials/{id}',
    handler: (request, h) => {
      const id = decodeURIComponent(request.params.id);
      if (!credentialStore.has(id)) {
        return h.response({ error: 'Credential not found' }).code(404);
      }
      credentialStore.delete(id);
      log('info', 'credentials', `Deleted credential`, { id });
      return h.response({ deleted: true }).code(200);
    }
  });

  // ============================================================
  // Log History API
  // ============================================================
  server.route({
    method: 'GET',
    path: '/logs',
    handler: (request) => {
      const query = request.query as { level?: string; component?: string; limit?: string };
      let logs = [...logHistory];

      if (query.level) {
        logs = logs.filter(l => l.level === query.level);
      }
      if (query.component) {
        logs = logs.filter(l => l.component === query.component);
      }

      const limit = parseInt(query.limit ?? '100', 10);
      logs = logs.slice(-limit);

      return { logs, total: logHistory.length };
    }
  });

  // ============================================================
  // Workflow Cancellation API
  // ============================================================
  server.route({
    method: 'POST',
    path: '/workflows/{id}/cancel',
    handler: async (request, h) => {
      const workflowId = request.params.id;
      const workflow = orchestrator.getWorkflowStatus(workflowId);

      if (!workflow) {
        return h.response({ error: 'Workflow not found' }).code(404);
      }

      if (workflow.status === 'completed' || workflow.status === 'failed') {
        return h.response({ error: 'Workflow already finished' }).code(400);
      }

      try {
        // Mark workflow as cancelled (would need orchestrator support)
        log('warn', 'workflow', `Workflow cancellation requested`, { workflowId });
        broadcast({ type: 'workflow-cancelled', payload: { id: workflowId, timestamp: new Date().toISOString() } });
        return { cancelled: true, workflowId };
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        return h.response({ error: message }).code(500);
      }
    }
  });

  // ============================================================
  // Workflow Graph/Visualization Data API
  // ============================================================
  server.route({
    method: 'GET',
    path: '/workflows/{id}/graph',
    handler: (request, h) => {
      const workflowId = request.params.id;
      const workflow = orchestrator.getWorkflowStatus(workflowId);

      if (!workflow) {
        return h.response({ error: 'Workflow not found' }).code(404);
      }

      // Build graph data for visualization
      const tasks = orchestrator.getAllTasks().filter(t => t.metadata?.workflowId === workflowId);
      const agents = orchestrator.getAgents();

      // Create nodes for tasks
      const nodes: Array<{ id: string; type: string; label: string; status: string }> = [];
      const edges: Array<{ from: string; to: string; label?: string }> = [];

      // Add workflow node
      nodes.push({
        id: workflowId,
        type: 'workflow',
        label: workflow.goal.slice(0, 30) + (workflow.goal.length > 30 ? '...' : ''),
        status: workflow.status
      });

      // Add task nodes and edges
      for (const task of tasks) {
        nodes.push({
          id: task.id,
          type: task.type,
          label: `${task.type}: ${task.description.slice(0, 20)}...`,
          status: task.status
        });

        // Edge from workflow to task
        edges.push({ from: workflowId, to: task.id, label: 'spawned' });

        // Edge from task to dependent tasks
        if (task.dependencies && task.dependencies.length > 0) {
          for (const depId of task.dependencies) {
            edges.push({ from: depId, to: task.id, label: 'depends' });
          }
        }
      }

      return {
        workflowId,
        nodes,
        edges,
        stats: {
          totalTasks: tasks.length,
          byStatus: {
            pending: tasks.filter(t => t.status === 'pending').length,
            running: tasks.filter(t => t.status === 'running').length,
            completed: tasks.filter(t => t.status === 'completed').length,
            failed: tasks.filter(t => t.status === 'failed').length
          }
        }
      };
    }
  });

  // ============================================================
  // AAT Registry API
  // ============================================================
  server.route({
    method: 'GET',
    path: '/aat',
    handler: () => {
      const aatIds = aatRegistry.getRegisteredAATs();
      return { aatTypes: aatIds };
    }
  });

  server.route({
    method: 'GET',
    path: '/aat/{id}',
    handler: async (request, h) => {
      const aatId = decodeURIComponent(request.params.id);
      const aat = await aatRegistry.getAAT(aatId);
      if (!aat) {
        return h.response({ error: 'AAT not found' }).code(404);
      }
      return aat;
    }
  });

  // Stop orchestrator gracefully on shutdown
  process.on('SIGINT', () => {
    log('info', 'server', 'Shutting down...');
    orchestrator.stop();
    if (wss) wss.close();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    log('info', 'server', 'Shutting down...');
    orchestrator.stop();
    if (wss) wss.close();
    process.exit(0);
  });

  await server.start();

  // ============================================================
  // WebSocket Server
  // ============================================================
  const wsPort = parseInt(String(port), 10) + 1;
  wss = new WebSocketServer({ port: wsPort });

  wss.on('connection', (ws) => {
    wsClients.add(ws);
    log('info', 'websocket', `Client connected (${wsClients.size} total)`);

    // Send current state on connection
    ws.send(JSON.stringify({
      type: 'init',
      payload: {
        workflows: orchestrator.getAllWorkflows(),
        agents: orchestrator.getAgents(),
        stats: orchestrator.getStats(),
        logs: logHistory.slice(-50)
      }
    }));

    ws.on('close', () => {
      wsClients.delete(ws);
      log('debug', 'websocket', `Client disconnected (${wsClients.size} remaining)`);
    });

    ws.on('error', (err) => {
      log('error', 'websocket', `Client error: ${err.message}`);
      wsClients.delete(ws);
    });
  });

  log('info', 'server', 'Server started', { httpPort: port, wsPort });

  console.log('');
  console.log('='.repeat(60));
  console.log('Agent Context Graph - Dashboard + Orchestrator');
  console.log('='.repeat(60));
  console.log(`Dashboard:        ${server.info.uri}`);
  console.log(`WebSocket:        ws://localhost:${wsPort}`);
  console.log(`Broker URL:       ${brokerUrl}`);
  console.log(`Reasoning:        ${useClaudeCodeCLI ? 'Claude Code CLI' : 'Anthropic API'}`);
  console.log('');
  console.log('Open your browser to the Dashboard URL above');
  console.log('='.repeat(60));
}

process.on('unhandledRejection', (err) => {
  console.error(err);
  process.exit(1);
});

init();
