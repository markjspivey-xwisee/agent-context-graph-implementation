import Hapi, { type Request, type ResponseToolkit } from '@hapi/hapi';
import inert from '@hapi/inert';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync, existsSync, appendFileSync } from 'fs';
import { WebSocketServer, WebSocket } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import { Orchestrator } from '../agents/orchestrator.js';
import { ContextBroker } from '../broker/context-broker.js';
import { AATRegistry } from '../services/aat-registry.js';
import { StubVerifier } from '../services/verifier.js';
import { PolicyEngine } from '../services/policy-engine.js';
import { InMemoryTraceStore } from '../services/trace-store.js';
import { StubCausalEvaluator } from '../services/causal-evaluator.js';
import { resolveSpecPath } from '../utils/spec-path.js';
import { KnowledgeGraphService } from '../services/knowledge-graph-service.js';
import { createReasoningClient } from '../agents/reasoning-client.js';
import { resolveReasoningConfigFromEnv } from '../utils/reasoning-env.js';

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
      id: 'urn:uuid:cred-analyst-001',
      type: ['VerifiableCredential', 'AnalystCapability'],
      issuer: 'did:web:authority.example.com',
      issuanceDate: new Date().toISOString(),
      expirationDate: '2030-01-01T00:00:00Z',
      credentialSubject: { capability: 'AnalystCapability', scope: 'data:read' }
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

// ============================================================
// Conversational Chat (in-memory)
// ============================================================
interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  workflowId?: string;
}

interface ChatConversation {
  id: string;
  messages: ChatMessage[];
  createdAt: string;
  updatedAt: string;
}

const chatConversations = new Map<string, ChatConversation>();
const chatWorkflowIndex = new Map<string, { conversationId: string; userMessageId: string }>();

function getOrCreateConversation(conversationId?: string): ChatConversation {
  if (conversationId && chatConversations.has(conversationId)) {
    return chatConversations.get(conversationId)!;
  }

  const id = conversationId ?? uuidv4();
  const now = new Date().toISOString();
  const convo: ChatConversation = {
    id,
    messages: [],
    createdAt: now,
    updatedAt: now
  };
  chatConversations.set(id, convo);
  return convo;
}

function extractChatResponse(result: unknown): string {
  if (!result || typeof result !== 'object') {
    return 'Completed. (No structured response found)';
  }

  const tasks = (result as { tasks?: Array<{ type?: string; output?: unknown }> }).tasks ?? [];
  const taskByType = (type: string) => tasks.filter(t => t.type === type);

  const analyzeTask = taskByType('analyze').slice(-1)[0];
  const observeTask = taskByType('observe').slice(-1)[0];
  const archiveTask = taskByType('archive').slice(-1)[0];
  const candidate = analyzeTask?.output ?? observeTask?.output ?? archiveTask?.output;

  if (candidate && typeof candidate === 'object') {
    const obj = candidate as Record<string, unknown>;
    const insight = obj.insight as Record<string, unknown> | undefined;
    const report = obj.report as Record<string, unknown> | undefined;
    const message = obj.message as string | undefined;
    const reasoning = obj.reasoning as string | undefined;

    const insightText =
      (insight?.summary as string | undefined) ??
      (insight?.message as string | undefined) ??
      (insight?.content as string | undefined);

    if (insightText) return insightText;

    const reportText =
      (report?.summary as string | undefined) ??
      (report?.message as string | undefined) ??
      (report?.content as string | undefined);

    if (reportText) return reportText;

    if (message) return message;
    if (reasoning) return reasoning;

    const queries = obj.queries as Array<{ output?: unknown }> | undefined;
    if (queries && queries.length > 0) {
      const results = queries[0]?.output as Record<string, unknown> | undefined;
      if (results?.results) {
        return `Query returned ${Array.isArray(results.results) ? results.results.length : 'results'}. See raw output.`;
      }
    }
  }

  return 'Completed. (No conversational summary available)';
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function init() {
  // Get configuration from environment
  // Default broker URL is the dashboard server itself (self-contained)
  const brokerUrl = process.env.BROKER_URL ?? `http://localhost:${process.env.DASHBOARD_PORT ?? 3001}`;
  const backendUrl = process.env.ACG_BACKEND_URL ?? 'http://localhost:3000';
  const port = process.env.DASHBOARD_PORT ?? 3001;
  let reasoningLabel = 'Anthropic API';
  let reasoningClient;
  try {
    const resolved = resolveReasoningConfigFromEnv();
    reasoningLabel = resolved.label;
    reasoningClient = await createReasoningClient(resolved.clientConfig);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exit(1);
  }

  // Create orchestrator with appropriate backend
  const orchestrator = new Orchestrator({
    brokerUrl,
    maxConcurrentAgents: 10,
    reasoningClient
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

    const chatMeta = chatWorkflowIndex.get(id);
    if (chatMeta) {
      const convo = chatConversations.get(chatMeta.conversationId);
      if (convo) {
        const responseText = extractChatResponse(result);
        const message: ChatMessage = {
          id: uuidv4(),
          role: 'assistant',
          content: responseText,
          createdAt: new Date().toISOString(),
          workflowId: id
        };
        convo.messages.push(message);
        convo.updatedAt = message.createdAt;
        broadcast({ type: 'chat-update', payload: { conversationId: convo.id, message } });
      }
      chatWorkflowIndex.delete(id);
    }
  });

  orchestrator.on('workflow-failed', (id, error) => {
    log('error', 'workflow', `Workflow failed: ${error}`, { workflowId: id, error });
    broadcast({ type: 'workflow-failed', payload: { id, error, timestamp: new Date().toISOString() } });

    const chatMeta = chatWorkflowIndex.get(id);
    if (chatMeta) {
      const convo = chatConversations.get(chatMeta.conversationId);
      if (convo) {
        const message: ChatMessage = {
          id: uuidv4(),
          role: 'assistant',
          content: `Workflow failed: ${error}`,
          createdAt: new Date().toISOString(),
          workflowId: id
        };
        convo.messages.push(message);
        convo.updatedAt = message.createdAt;
        broadcast({ type: 'chat-update', payload: { conversationId: convo.id, message } });
      }
      chatWorkflowIndex.delete(id);
    }
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
        'https://hyprcat.io/vocab#',
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

  const proxyToBackend = async (request: Request, h: ResponseToolkit, pathOverride?: string) => {
    const target = new URL(pathOverride ?? request.path, backendUrl);
    for (const [key, value] of Object.entries(request.query ?? {})) {
      if (Array.isArray(value)) {
        value.forEach(item => target.searchParams.append(key, String(item)));
      } else if (value !== undefined) {
        target.searchParams.append(key, String(value));
      }
    }

    const method = request.method.toUpperCase();
    const headers: Record<string, string> = {};
    const contentType = request.headers['content-type'];
    if (contentType) {
      headers['content-type'] = contentType;
    }

    let body: string | Buffer | undefined;
    if (!['GET', 'HEAD'].includes(method)) {
      if (typeof request.payload === 'string' || Buffer.isBuffer(request.payload)) {
        body = request.payload as string | Buffer;
      } else if (request.payload !== null && request.payload !== undefined) {
        body = JSON.stringify(request.payload);
        headers['content-type'] = 'application/json';
      }
    }

    const response = await fetch(target.toString(), {
      method,
      headers,
      body
    });

    const text = await response.text();
    const responseType = response.headers.get('content-type') ?? 'application/json';
    return h.response(text).type(responseType).code(response.status);
  };

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
        return await proxyToBackend(request, h, '/goals');
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return h.response({ error: message }).code(500);
      }
    }
  });

  // Conversational chat (proxy to unified backend)
  server.route({
    method: 'POST',
    path: '/chat',
    handler: async (request, h) => {
      try {
        const payload = request.payload ?? {};
        const response = await fetch(`${backendUrl}/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const text = await response.text();
        const contentType = response.headers.get('content-type') ?? 'application/json';
        return h.response(text).type(contentType).code(response.status);

      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return h.response({ error: message }).code(500);
      }
    }
  });

  // Get conversation messages (proxy to unified backend)
  server.route({
    method: 'GET',
    path: '/chat/{id}',
    handler: async (request, h) => {
      try {
        const conversationId = request.params.id;
        const response = await fetch(`${backendUrl}/chat/${encodeURIComponent(conversationId)}`);
        const text = await response.text();
        const contentType = response.headers.get('content-type') ?? 'application/json';
        return h.response(text).type(contentType).code(response.status);
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
    handler: async (request, h) => {
      try {
        return await proxyToBackend(request, h);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return h.response({ error: message }).code(500);
      }
    }
  });

  // List all workflows
  server.route({
    method: 'GET',
    path: '/workflows',
    handler: async (request, h) => {
      try {
        return await proxyToBackend(request, h);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return h.response({ error: message }).code(500);
      }
    }
  });

  // Get orchestrator stats
  server.route({
    method: 'GET',
    path: '/stats',
    handler: async (request, h) => {
      try {
        return await proxyToBackend(request, h);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return h.response({ error: message }).code(500);
      }
    }
  });

  // Get detailed workflow info
  server.route({
    method: 'GET',
    path: '/workflows/{id}/detail',
    handler: async (request, h) => {
      try {
        return await proxyToBackend(request, h);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return h.response({ error: message }).code(500);
      }
    }
  });

  // Get all agents
  server.route({
    method: 'GET',
    path: '/agents',
    handler: async (request, h) => {
      try {
        return await proxyToBackend(request, h);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return h.response({ error: message }).code(500);
      }
    }
  });

  // Get all tasks
  server.route({
    method: 'GET',
    path: '/tasks',
    handler: async (request, h) => {
      try {
        return await proxyToBackend(request, h);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return h.response({ error: message }).code(500);
      }
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
    handler: async (request, h) => {
      try {
        return await proxyToBackend(request, h);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return h.response({ error: message }).code(500);
      }
    }
  });

  // ============================================================
  // Workflow Cancellation API
  // ============================================================
  server.route({
    method: 'POST',
    path: '/workflows/{id}/cancel',
    handler: async (request, h) => {
      try {
        return await proxyToBackend(request, h);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
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
    handler: async (request, h) => {
      try {
        const workflowId = request.params.id;
        return await proxyToBackend(request, h, `/workflow/${encodeURIComponent(workflowId)}/graph`);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return h.response({ error: message }).code(500);
      }
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
  console.log('Agent Context Graph - Dashboard Server');
  console.log('='.repeat(60));
  console.log(`Dashboard:        ${server.info.uri}`);
  console.log(`WebSocket:        ws://localhost:${wsPort}`);
  console.log(`Broker URL:       ${brokerUrl}`);
  console.log(`Reasoning:        ${reasoningLabel}`);
  console.log('');
  console.log('Open your browser to the Dashboard URL above');
  console.log('='.repeat(60));
}

process.on('unhandledRejection', (err) => {
  console.error(err);
  process.exit(1);
});

init();
