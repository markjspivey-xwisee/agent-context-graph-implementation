import Hapi from '@hapi/hapi';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { ContextBroker, type ContextRequest, type TraverseRequest } from './broker/context-broker.js';
import { AATRegistry } from './services/aat-registry.js';
import { StubVerifier, RealVerifier } from './services/verifier.js';
import { PolicyEngine } from './services/policy-engine.js';
import { OPAPolicyEngine } from './services/opa-policy-engine.js';
import { StubCausalEvaluator, RealCausalEvaluator } from './services/causal-evaluator.js';
import { InMemoryTraceStore } from './services/trace-store.js';
import { RDFStore } from './services/rdf-store.js';
import type { ITraceStore, StoreResult, TraceQuery, ProvTrace } from './interfaces/index.js';
import { SPARQLEndpoint, sparqlToJson, type SPARQLResponse } from './services/sparql-endpoint.js';
import { PersonalBroker, PersonalBrokerRegistry, type PersonalBrokerConfig, type MessageRole } from './services/personal-broker.js';
import { ChannelBridgeService, PLATFORMS } from './services/channel-bridge.js';
import { SocialFederationService, type ProfileVisibility, type ConnectionState, type GroupRole } from './services/social-federation.js';
import { SharedContextService, type SyncStrategy, type ConflictResolution, type AccessLevel } from './services/shared-context.js';
import { RealtimeSyncService } from './services/realtime-sync.js';
import { KnowledgeGraphService } from './services/knowledge-graph-service.js';
import { SemanticQueryClient } from './services/semantic-query-client.js';
import { DatabricksSqlClient } from './services/databricks-sql-client.js';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { resolveSpecPath } from './utils/spec-path.js';

/**
 * Load all Turtle files from a directory and concatenate them
 */
function loadTurtleFiles(dir: string): string {
  if (!existsSync(dir)) return '';
  const files = readdirSync(dir).filter(f => f.endsWith('.ttl'));
  return files.map(f => readFileSync(join(dir, f), 'utf-8')).join('\n\n');
}

type JsonObject = Record<string, unknown>;

function loadJsonFile(filePath: string, fallback: JsonObject): JsonObject {
  if (!existsSync(filePath)) return fallback;
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8')) as JsonObject;
  } catch (error) {
    console.warn(`Could not parse JSON-LD file at ${filePath}:`, error);
    return fallback;
  }
}

function loadTextFile(filePath: string): string {
  if (!existsSync(filePath)) return '';
  return readFileSync(filePath, 'utf-8');
}

const __dirname = dirname(fileURLToPath(import.meta.url));

async function init() {
  // Initialize services
  const aatRegistry = new AATRegistry();

  // Load AAT specs from the spec directory
  const specDir = resolveSpecPath('aat');
  try {
    aatRegistry.loadFromDirectory(specDir);
    console.log(`Loaded AATs: ${aatRegistry.getRegisteredAATs().join(', ')}`);
  } catch (error) {
    console.warn('Could not load AAT specs from directory, using built-in definitions');
  }

  // Use RealVerifier when available, StubVerifier as fallback
  const verifier = new RealVerifier({
    trustedIssuers: [
      'did:web:authority.example.com',
      'did:web:issuer.example.com'
    ]
  });

  const policyEngine = new PolicyEngine();
  const opaPolicyEngine = new OPAPolicyEngine();
  const causalEvaluator = new RealCausalEvaluator();

  // Use RDF store for native triplestore (PROV traces as actual RDF)
  const rdfStore = new RDFStore();

  // Create trace store adapter for backward compatibility
  const traceStore: ITraceStore = {
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

  // Knowledge Graph registry (in-memory for now)
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

  // Initialize SPARQL endpoint
  const sparqlEndpoint = new SPARQLEndpoint(rdfStore);

  // Create the Context Broker
  const broker = new ContextBroker(
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

  // In-memory workflow store for dashboard demo
  interface WorkflowTask {
    id: string;
    type: 'plan' | 'approve' | 'execute' | 'observe' | 'archive';
    status: 'pending' | 'running' | 'completed' | 'failed';
    description: string;
    startTime?: string;
    endTime?: string;
  }

  interface Workflow {
    id: string;
    goal: string;
    priority: string;
    status: 'pending' | 'running' | 'completed' | 'failed';
    timing: {
      startTime: string;
      durationMs: number;
    };
    taskDetails: WorkflowTask[];
    tasks: WorkflowTask[]; // Alias for dashboard compatibility
  }

  interface Agent {
    id: string;
    did: string;
    type: string;
    status: 'active' | 'idle' | 'terminated';
    workflowId: string;
    createdAt: string;
  }

  const workflows: Map<string, Workflow> = new Map();
  const agents: Map<string, Agent> = new Map();

  // Initialize SHACL validator
  const shaclDir = resolveSpecPath('shacl');
  try {
    await broker.initializeSHACL(shaclDir);
    console.log('SHACL validator initialized');
  } catch (error) {
    console.warn('Could not initialize SHACL validator:', error);
  }

  // Initialize Personal Broker Registry and Channel Bridge Service
  const personalBrokerRegistry = new PersonalBrokerRegistry();
  const channelBridgeService = new ChannelBridgeService();

  // Initialize Social Federation and Shared Context Services
  const socialFederationService = new SocialFederationService();
  const sharedContextService = new SharedContextService();

  // Initialize Real-time Sync Service
  const realtimeSyncService = new RealtimeSyncService();
  realtimeSyncService.setServices(sharedContextService, socialFederationService);

  // Create a demo personal broker for development
  const demoBroker = personalBrokerRegistry.createBroker({
    displayName: 'Demo Personal Assistant',
    ownerDID: 'did:web:demo.acg.example:user:1',
    timezone: 'America/New_York',
    locale: 'en-US'
  });
  demoBroker.setContextBroker(broker);
  console.log(`Personal Broker initialized: ${demoBroker.id}`);

  // Load ontology files for serving
  const ontologyDir = resolveSpecPath('ontology');
  const hydraDir = resolveSpecPath('hydra');
  const ontologyContent = loadTurtleFiles(ontologyDir);
  const hydraContent = loadTurtleFiles(hydraDir);
  const shaclContent = loadTurtleFiles(shaclDir);

  const semanticExamplesDir = join(__dirname, '..', '..', 'examples', 'semantic-layer');
  const catalogDoc = loadJsonFile(join(semanticExamplesDir, 'catalog.jsonld'), {
    '@context': 'http://www.w3.org/ns/hydra/core',
    '@id': '/data/catalog',
    '@type': 'hydra:Resource'
  });
  const dataProductsDoc = loadJsonFile(join(semanticExamplesDir, 'data-products.jsonld'), {
    '@context': 'http://www.w3.org/ns/hydra/core',
    '@id': '/data/products',
    '@type': 'hydra:Collection',
    'hydra:member': []
  });
  const dataContractsDoc = loadJsonFile(join(semanticExamplesDir, 'contracts.jsonld'), {
    '@context': 'http://www.w3.org/ns/hydra/core',
    '@id': '/data/contracts',
    '@type': 'hydra:Collection',
    'hydra:member': []
  });
  const contractShapeTurtle = loadTextFile(join(semanticExamplesDir, 'contract-shape.ttl'));

  const getHydraMembers = (doc: JsonObject): JsonObject[] => {
    const members = doc['hydra:member'];
    if (!Array.isArray(members)) return [];
    return members.filter((member): member is JsonObject => typeof member === 'object' && member !== null);
  };

  const buildIndex = (members: JsonObject[]): Map<string, JsonObject> => {
    const index = new Map<string, JsonObject>();
    for (const member of members) {
      const id = typeof member['@id'] === 'string' ? member['@id'] : null;
      if (id) index.set(id, member);
    }
    return index;
  };

  const dataProductIndex = buildIndex(getHydraMembers(dataProductsDoc));
  const dataContractIndex = buildIndex(getHydraMembers(dataContractsDoc));

  const normalizeProductId = (id: string): string => {
    if (id.startsWith('urn:')) return id;
    return `urn:acg:data-product:${id}`;
  };

  const normalizeContractId = (id: string): string => {
    if (id.startsWith('urn:')) return id;
    return `urn:acg:data-contract:${id}`;
  };

  // Create Hapi server
  const server = Hapi.server({
    port: process.env.PORT ?? 3000,
    host: '0.0.0.0',
    routes: {
      cors: true
    }
  });

  const defaultSparqlEndpoint = `http://localhost:${process.env.PORT ?? 3000}/sparql`;
  let semanticQueryClient: SemanticQueryClient | null = null;
  const getSemanticQueryClient = (overrideEndpoint?: string) => {
    const endpoint =
      overrideEndpoint ?? process.env.SEMANTIC_LAYER_SPARQL_ENDPOINT ?? defaultSparqlEndpoint;
    if (!endpoint) {
      throw new Error('Semantic layer endpoint missing. Set SEMANTIC_LAYER_SPARQL_ENDPOINT or provide semanticLayerRef.');
    }
    if (!semanticQueryClient || semanticQueryClient.endpoint !== endpoint) {
      semanticQueryClient = new SemanticQueryClient({ endpoint });
    }
    return semanticQueryClient;
  };

  let databricksClient: DatabricksSqlClient | null = null;
  const getDatabricksClient = () => {
    if (databricksClient) return databricksClient;

    const host = process.env.DATABRICKS_HOST ?? '';
    const token = process.env.DATABRICKS_TOKEN ?? '';
    if (!host || !token) {
      throw new Error('Databricks configuration missing. Set DATABRICKS_HOST and DATABRICKS_TOKEN.');
    }

    databricksClient = new DatabricksSqlClient({
      host,
      token,
      warehouseId: process.env.DATABRICKS_WAREHOUSE_ID,
      defaultCatalog: process.env.DATABRICKS_CATALOG,
      defaultSchema: process.env.DATABRICKS_SCHEMA,
      userAgent: 'agent-context-graph'
    });

    return databricksClient;
  };

  // Health check endpoint
  server.route({
    method: 'GET',
    path: '/health',
    handler: () => {
      return { status: 'healthy', timestamp: new Date().toISOString() };
    }
  });

  // ===========================================
  // Dashboard Endpoints
  // ===========================================

  // GET /stats - Dashboard statistics
  server.route({
    method: 'GET',
    path: '/stats',
    handler: () => {
      const rdfStats = rdfStore.getStats();
      const workflowList = Array.from(workflows.values());
      const allTasks = workflowList.flatMap(w => w.taskDetails);
      return {
        connected: true,
        uptime: process.uptime(),
        traces: rdfStats.traces,
        quads: rdfStats.quads,
        workflows: {
          total: workflowList.length,
          active: workflowList.filter(w => w.status === 'running').length,
          completed: workflowList.filter(w => w.status === 'completed').length
        },
        tasks: {
          total: allTasks.length,
          pending: allTasks.filter(t => t.status === 'pending').length,
          completed: allTasks.filter(t => t.status === 'completed').length
        },
        agents: {
          total: agents.size,
          active: Array.from(agents.values()).filter(a => a.status === 'active').length
        },
        timestamp: new Date().toISOString()
      };
    }
  });

  // GET /agents - List active agents
  server.route({
    method: 'GET',
    path: '/agents',
    handler: () => {
      return { agents: Array.from(agents.values()) };
    }
  });

  // GET /workflows - List workflows
  server.route({
    method: 'GET',
    path: '/workflows',
    handler: () => {
      return { workflows: Array.from(workflows.values()) };
    }
  });

  // POST /goals - Create a new workflow from a goal
  server.route({
    method: 'POST',
    path: '/goals',
    handler: async (request, h) => {
      const { goal, priority } = request.payload as { goal: string; priority: string };
      const workflowId = `wf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const startTime = new Date().toISOString();

      // Create initial workflow with AAT pipeline tasks
      const taskDetails: WorkflowTask[] = [
        { id: `${workflowId}-plan`, type: 'plan', status: 'running', description: 'Planning goal execution strategy', startTime },
        { id: `${workflowId}-approve`, type: 'approve', status: 'pending', description: 'Awaiting plan approval' },
        { id: `${workflowId}-execute`, type: 'execute', status: 'pending', description: 'Execute approved plan' },
        { id: `${workflowId}-observe`, type: 'observe', status: 'pending', description: 'Monitor execution progress' },
        { id: `${workflowId}-archive`, type: 'archive', status: 'pending', description: 'Archive results and traces' }
      ];

      const workflow: Workflow = {
        id: workflowId,
        goal,
        priority: priority || 'normal',
        status: 'running',
        timing: {
          startTime,
          durationMs: 0
        },
        taskDetails,
        tasks: taskDetails // Alias for dashboard compatibility
      };

      workflows.set(workflowId, workflow);

      // Create agents for the AAT pipeline
      const agentTypes = ['planner', 'arbiter', 'executor', 'observer', 'archivist'];
      agentTypes.forEach((type, idx) => {
        const agentId = `agent-${workflowId}-${type}`;
        const agent: Agent = {
          id: agentId,
          did: `did:web:acg.example/${type}/${workflowId.slice(3, 11)}`,
          type,
          status: idx === 0 ? 'active' : 'idle',
          workflowId,
          createdAt: startTime
        };
        agents.set(agentId, agent);
      });

      // Simulate async workflow progression
      simulateWorkflow(workflowId);

      return { workflowId, status: 'created' };
    }
  });

  // GET /workflows/{id}/detail - Get workflow details
  server.route({
    method: 'GET',
    path: '/workflows/{id}/detail',
    handler: (request, h) => {
      const workflow = workflows.get(request.params.id);
      if (!workflow) {
        return h.response({ error: 'Workflow not found' }).code(404);
      }
      // Update duration
      workflow.timing.durationMs = Date.now() - new Date(workflow.timing.startTime).getTime();
      return workflow;
    }
  });

  // Simulate workflow progression through AAT pipeline
  function simulateWorkflow(workflowId: string) {
    const stages = ['plan', 'approve', 'execute', 'observe', 'archive'] as const;
    const agentTypes = ['planner', 'arbiter', 'executor', 'observer', 'archivist'];
    let currentStage = 0;

    const advanceStage = () => {
      const workflow = workflows.get(workflowId);
      if (!workflow) return;

      // Complete current stage and update agent
      const currentTask = workflow.taskDetails.find(t => t.type === stages[currentStage]);
      if (currentTask) {
        currentTask.status = 'completed';
        currentTask.endTime = new Date().toISOString();
      }

      // Update current agent to idle
      const currentAgentId = `agent-${workflowId}-${agentTypes[currentStage]}`;
      const currentAgent = agents.get(currentAgentId);
      if (currentAgent) {
        currentAgent.status = 'idle';
      }

      currentStage++;

      if (currentStage < stages.length) {
        // Start next stage
        const nextTask = workflow.taskDetails.find(t => t.type === stages[currentStage]);
        if (nextTask) {
          nextTask.status = 'running';
          nextTask.startTime = new Date().toISOString();
        }

        // Activate next agent
        const nextAgentId = `agent-${workflowId}-${agentTypes[currentStage]}`;
        const nextAgent = agents.get(nextAgentId);
        if (nextAgent) {
          nextAgent.status = 'active';
        }

        // Schedule next advancement (1-3 seconds per stage for demo)
        setTimeout(advanceStage, 1000 + Math.random() * 2000);
      } else {
        // Workflow complete - terminate all agents
        workflow.status = 'completed';
        workflow.timing.durationMs = Date.now() - new Date(workflow.timing.startTime).getTime();

        agentTypes.forEach(type => {
          const agentId = `agent-${workflowId}-${type}`;
          const agent = agents.get(agentId);
          if (agent) {
            agent.status = 'terminated';
          }
        });
      }

      // Keep tasks array in sync
      workflow.tasks = workflow.taskDetails;
    };

    // Start first stage after a short delay
    setTimeout(advanceStage, 1500);
  }

  // GET /tasks - List tasks
  server.route({
    method: 'GET',
    path: '/tasks',
    handler: () => {
      const allTasks = Array.from(workflows.values()).flatMap(w =>
        w.taskDetails.map(t => ({ ...t, workflowId: w.id, goal: w.goal }))
      );
      return { tasks: allTasks };
    }
  });

  // GET /federation/status - Federation status
  server.route({
    method: 'GET',
    path: '/federation/status',
    handler: () => {
      return {
        enabled: false,
        connectedBrokers: [],
        trustDomains: []
      };
    }
  });

  // GET /credentials - List credentials (stub for dashboard)
  server.route({
    method: 'GET',
    path: '/credentials',
    handler: () => {
      // Return simulated credentials for demo
      const workflowList = Array.from(workflows.values());
      const credentials = workflowList.flatMap(w => {
        return [
          {
            id: `cred-${w.id}-planner`,
            type: 'PlannerCapability',
            issuer: 'did:web:authority.example.com',
            subject: `did:web:acg.example/planner/${w.id.slice(3, 11)}`,
            issuedAt: w.timing.startTime,
            expiresAt: new Date(Date.now() + 3600000).toISOString()
          }
        ];
      });
      return { credentials };
    }
  });

  // GET /workflow/{id}/graph - Get workflow DAG
  server.route({
    method: 'GET',
    path: '/workflow/{id}/graph',
    handler: (request, h) => {
      const workflow = workflows.get(request.params.id);
      if (!workflow) {
        return h.response({ error: 'Workflow not found' }).code(404);
      }
      // Return DAG representation of workflow
      const nodes = workflow.taskDetails.map((t, idx) => ({
        id: t.id,
        label: t.type,
        status: t.status,
        x: 100 + idx * 150,
        y: 200
      }));
      const edges = workflow.taskDetails.slice(0, -1).map((t, idx) => ({
        source: t.id,
        target: workflow.taskDetails[idx + 1].id
      }));
      return { nodes, edges, workflowId: workflow.id, goal: workflow.goal };
    }
  });

  // GET /logs - Get system logs (stub for dashboard)
  server.route({
    method: 'GET',
    path: '/logs',
    handler: () => {
      const workflowList = Array.from(workflows.values());
      const logs = workflowList.flatMap(w => {
        return w.taskDetails
          .filter(t => t.startTime)
          .map(t => ({
            timestamp: t.startTime,
            level: 'info',
            message: `Task ${t.type} ${t.status}`,
            workflowId: w.id,
            taskId: t.id
          }));
      });
      // Sort by timestamp descending
      logs.sort((a, b) => new Date(b.timestamp!).getTime() - new Date(a.timestamp!).getTime());
      return { logs: logs.slice(0, 100) };
    }
  });

  // ===========================================
  // Personal Broker Endpoints
  // ===========================================

  // GET /broker - Get the demo personal broker info
  server.route({
    method: 'GET',
    path: '/broker',
    handler: () => {
      return demoBroker.toJSON();
    }
  });

  // GET /broker/conversations - List conversations
  server.route({
    method: 'GET',
    path: '/broker/conversations',
    handler: (request) => {
      const status = request.query.status as string | undefined;
      const limit = request.query.limit ? parseInt(request.query.limit as string) : undefined;
      const conversations = demoBroker.listConversations({
        status: status as any,
        limit
      });
      return { conversations };
    }
  });

  // POST /broker/conversations - Start a new conversation
  server.route({
    method: 'POST',
    path: '/broker/conversations',
    handler: (request) => {
      const payload = request.payload as { title?: string; channelId?: string };
      const conversation = demoBroker.startConversation({
        title: payload?.title,
        channelId: payload?.channelId
      });
      return conversation;
    }
  });

  // GET /broker/conversations/{id} - Get conversation details
  server.route({
    method: 'GET',
    path: '/broker/conversations/{id}',
    handler: (request, h) => {
      const conversation = demoBroker.getConversation(request.params.id);
      if (!conversation) {
        return h.response({ error: 'Conversation not found' }).code(404);
      }
      return conversation;
    }
  });

  // GET /broker/conversations/{id}/messages - Get messages in a conversation
  server.route({
    method: 'GET',
    path: '/broker/conversations/{id}/messages',
    handler: (request, h) => {
      const conversation = demoBroker.getConversation(request.params.id);
      if (!conversation) {
        return h.response({ error: 'Conversation not found' }).code(404);
      }
      const limit = request.query.limit ? parseInt(request.query.limit as string) : undefined;
      const offset = request.query.offset ? parseInt(request.query.offset as string) : undefined;
      const messages = demoBroker.getMessages(request.params.id, { limit, offset });
      return { messages, conversationId: request.params.id };
    }
  });

  // POST /broker/conversations/{id}/messages - Send a message
  server.route({
    method: 'POST',
    path: '/broker/conversations/{id}/messages',
    handler: async (request, h) => {
      const conversation = demoBroker.getConversation(request.params.id);
      if (!conversation) {
        return h.response({ error: 'Conversation not found' }).code(404);
      }
      const payload = request.payload as {
        content: string;
        role?: MessageRole;
        attachments?: string[];
      };
      if (!payload?.content) {
        return h.response({ error: 'content is required' }).code(400);
      }
      try {
        const message = await demoBroker.sendMessage(request.params.id, payload.content, {
          role: payload.role,
          attachments: payload.attachments
        });
        return message;
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Unknown error';
        return h.response({ error: msg }).code(400);
      }
    }
  });

  // DELETE /broker/conversations/{id} - End a conversation
  server.route({
    method: 'DELETE',
    path: '/broker/conversations/{id}',
    handler: (request, h) => {
      const conversation = demoBroker.getConversation(request.params.id);
      if (!conversation) {
        return h.response({ error: 'Conversation not found' }).code(404);
      }
      demoBroker.endConversation(request.params.id);
      return { success: true, conversationId: request.params.id };
    }
  });

  // GET /broker/channels - List connected channels
  server.route({
    method: 'GET',
    path: '/broker/channels',
    handler: () => {
      const channels = demoBroker.listChannels();
      return { channels };
    }
  });

  // GET /broker/memory - Query memory
  server.route({
    method: 'GET',
    path: '/broker/memory',
    handler: (request) => {
      const type = request.query.type as string | undefined;
      const limit = request.query.limit ? parseInt(request.query.limit as string) : 50;
      const minImportance = request.query.minImportance
        ? parseFloat(request.query.minImportance as string)
        : undefined;
      const entries = demoBroker.recallMemory({
        type: type as any,
        limit,
        minImportance
      });
      return { entries };
    }
  });

  // POST /broker/memory - Store a memory
  server.route({
    method: 'POST',
    path: '/broker/memory',
    handler: (request) => {
      const payload = request.payload as {
        type: 'episodic' | 'semantic' | 'procedural' | 'preference';
        content: string;
        importance?: number;
        tags?: string[];
      };
      const entry = demoBroker.storeMemory({
        type: payload.type,
        content: payload.content,
        importance: payload.importance,
        tags: payload.tags
      });
      return entry;
    }
  });

  // GET /broker/contacts - List contacts
  server.route({
    method: 'GET',
    path: '/broker/contacts',
    handler: (request) => {
      const status = request.query.status as string | undefined;
      const contacts = demoBroker.listContacts({
        status: status as any
      });
      return { contacts };
    }
  });

  // GET /broker/routines - List routines
  server.route({
    method: 'GET',
    path: '/broker/routines',
    handler: () => {
      const routines = demoBroker.listRoutines();
      return { routines };
    }
  });

  // GET /broker/tools - List available tools
  server.route({
    method: 'GET',
    path: '/broker/tools',
    handler: () => {
      const tools = demoBroker.listTools();
      return { tools };
    }
  });

  // POST /broker/tools - Register a new tool
  server.route({
    method: 'POST',
    path: '/broker/tools',
    handler: (request, h) => {
      const payload = request.payload as {
        name: string;
        description?: string;
        category: string;
        endpoint?: string;
        requiredCredentialIds?: string[];
        schema?: unknown;
        enabled?: boolean;
      };

      if (!payload?.name || !payload?.category) {
        return h.response({ error: 'name and category are required' }).code(400);
      }

      const tool = demoBroker.registerTool({
        name: payload.name,
        description: payload.description,
        category: payload.category as any,
        endpoint: payload.endpoint,
        requiredCredentialIds: payload.requiredCredentialIds,
        schema: payload.schema,
        enabled: payload.enabled
      });

      return h.response(tool).code(201);
    }
  });

  // GET /broker/presence - Get presence status
  server.route({
    method: 'GET',
    path: '/broker/presence',
    handler: () => {
      return demoBroker.getPresence();
    }
  });

  // PUT /broker/presence - Update presence status
  server.route({
    method: 'PUT',
    path: '/broker/presence',
    handler: (request) => {
      const payload = request.payload as {
        status?: 'online' | 'away' | 'busy' | 'dnd' | 'offline' | 'invisible';
        statusMessage?: string;
        visibleTo?: 'public' | 'connections' | 'close' | 'private';
      };
      const presence = demoBroker.updatePresence(payload);
      return presence;
    }
  });

  // GET /platforms - List available channel platforms
  server.route({
    method: 'GET',
    path: '/platforms',
    handler: () => {
      return { platforms: Object.values(PLATFORMS) };
    }
  });

  // ===========================================
  // Social Federation Endpoints
  // ===========================================

  // Create profile for demo broker
  const demoProfile = socialFederationService.createProfile(demoBroker);
  console.log(`Social profile created: ${demoProfile.displayName}`);

  // GET /social/profile - Get current profile
  server.route({
    method: 'GET',
    path: '/social/profile',
    handler: () => {
      const profile = socialFederationService.getProfile(demoBroker.id);
      return profile ?? { error: 'Profile not found' };
    }
  });

  // PUT /social/profile - Update profile
  server.route({
    method: 'PUT',
    path: '/social/profile',
    handler: (request, h) => {
      const payload = request.payload as {
        displayName?: string;
        bio?: string;
        avatar?: string;
        visibility?: ProfileVisibility;
        discoverableMethods?: string[];
      };
      const profile = socialFederationService.updateProfile(demoBroker.id, payload);
      if (!profile) {
        return h.response({ error: 'Profile not found' }).code(404);
      }
      return profile;
    }
  });

  // GET /social/connections - List connections
  server.route({
    method: 'GET',
    path: '/social/connections',
    handler: (request) => {
      const state = request.query.state as ConnectionState | undefined;
      let connections = socialFederationService.getConnectionsForBroker(demoBroker.id);
      if (state) {
        connections = connections.filter(c => c.state === state);
      }
      return { connections };
    }
  });

  // POST /social/connections/request - Request a connection
  server.route({
    method: 'POST',
    path: '/social/connections/request',
    handler: async (request, h) => {
      const payload = request.payload as {
        toBrokerId: string;
        message?: string;
      };
      if (!payload?.toBrokerId) {
        return h.response({ error: 'toBrokerId is required' }).code(400);
      }
      try {
        const request_result = await socialFederationService.requestConnection(
          demoBroker,
          payload.toBrokerId,
          { message: payload.message }
        );
        return request_result;
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Unknown error';
        return h.response({ error: msg }).code(400);
      }
    }
  });

  // POST /social/connections/{id}/accept - Accept a connection request
  server.route({
    method: 'POST',
    path: '/social/connections/{id}/accept',
    handler: async (request, h) => {
      const requestId = request.params.id;
      const pendingRequests = socialFederationService.getPendingRequests(demoBroker.id);
      const pendingRequest = pendingRequests.find(r => r.id === requestId);
      if (!pendingRequest) {
        return h.response({ error: 'Request not found' }).code(404);
      }
      try {
        const connection = await socialFederationService.acceptConnection(pendingRequest, demoBroker);
        return connection;
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Unknown error';
        return h.response({ error: msg }).code(400);
      }
    }
  });

  // POST /social/connections/{id}/reject - Reject a connection request
  server.route({
    method: 'POST',
    path: '/social/connections/{id}/reject',
    handler: async (request, h) => {
      const requestId = request.params.id;
      try {
        await socialFederationService.rejectConnection(requestId);
        return { success: true, requestId };
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Unknown error';
        return h.response({ error: msg }).code(400);
      }
    }
  });

  // GET /social/invites - List invite links (stub - would need to add method to service)
  server.route({
    method: 'GET',
    path: '/social/invites',
    handler: () => {
      // Return empty for now - would need getInviteLinksForBroker method
      return { invites: [] };
    }
  });

  // POST /social/invites - Create an invite link
  server.route({
    method: 'POST',
    path: '/social/invites',
    handler: (request) => {
      const payload = request.payload as {
        maxUses?: number;
        expiresInHours?: number;
        label?: string;
      };
      const invite = socialFederationService.createInviteLink(demoBroker.id, {
        maxUses: payload?.maxUses,
        expiresInHours: payload?.expiresInHours
      });
      return invite;
    }
  });

  // POST /social/invites/{code}/use - Use an invite link
  server.route({
    method: 'POST',
    path: '/social/invites/{code}/use',
    handler: async (request, h) => {
      const code = request.params.code;
      try {
        const result = await socialFederationService.useInviteLink(code, demoBroker);
        return result;
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Unknown error';
        return h.response({ error: msg }).code(400);
      }
    }
  });

  // GET /social/notifications - Get notifications
  server.route({
    method: 'GET',
    path: '/social/notifications',
    handler: (request) => {
      const unreadOnly = request.query.unreadOnly === 'true';
      const limit = request.query.limit ? parseInt(request.query.limit as string) : 50;
      const notifications = socialFederationService.getNotifications(demoBroker.id, { unreadOnly, limit });
      return { notifications };
    }
  });

  // PUT /social/notifications/{id}/read - Mark notification as read
  server.route({
    method: 'PUT',
    path: '/social/notifications/{id}/read',
    handler: (request) => {
      const notificationId = request.params.id;
      socialFederationService.markNotificationRead(notificationId);
      return { success: true, notificationId };
    }
  });

  // GET /social/groups - List groups
  server.route({
    method: 'GET',
    path: '/social/groups',
    handler: () => {
      const groups = socialFederationService.getGroupsForBroker(demoBroker.id);
      return { groups };
    }
  });

  // POST /social/groups - Create a group
  server.route({
    method: 'POST',
    path: '/social/groups',
    handler: (request, h) => {
      const payload = request.payload as {
        name: string;
        description?: string;
        isPublic?: boolean;
      };
      if (!payload?.name) {
        return h.response({ error: 'name is required' }).code(400);
      }
      const group = socialFederationService.createGroup(demoBroker.id, {
        name: payload.name,
        description: payload.description,
        isPublic: payload.isPublic
      });
      return group;
    }
  });

  // POST /social/groups/{id}/members - Add member to group
  server.route({
    method: 'POST',
    path: '/social/groups/{id}/members',
    handler: async (request, h) => {
      const groupId = request.params.id;
      const payload = request.payload as {
        brokerId: string;
        role?: GroupRole;
      };
      if (!payload?.brokerId) {
        return h.response({ error: 'brokerId is required' }).code(400);
      }
      try {
        const membership = await socialFederationService.addToGroup(
          groupId,
          payload.brokerId,
          payload.role ?? 'member'
        );
        return membership;
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Unknown error';
        return h.response({ error: msg }).code(400);
      }
    }
  });

  // GET /social/discovery - Discover brokers
  server.route({
    method: 'GET',
    path: '/social/discovery',
    handler: async (request, h) => {
      const method = request.query.method as string;
      const query = request.query.query as string;
      if (!method || !query) {
        return h.response({ error: 'method and query are required' }).code(400);
      }
      try {
        let result;
        if (method === 'did') {
          result = await socialFederationService.discoverByDID(query);
        } else if (method === 'webid') {
          result = await socialFederationService.discoverByWebID(query);
        } else if (method === 'search') {
          result = await socialFederationService.searchProfiles(query);
        } else {
          return h.response({ error: 'Invalid method. Use: did, webid, or search' }).code(400);
        }
        return { results: result };
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Unknown error';
        return h.response({ error: msg }).code(400);
      }
    }
  });

  // GET /social/stats - Get federation stats
  server.route({
    method: 'GET',
    path: '/social/stats',
    handler: () => {
      // Compute stats from service internals
      return {
        totalConnections: socialFederationService.getConnectionsForBroker(demoBroker.id).length,
        pendingRequests: socialFederationService.getPendingRequests(demoBroker.id).length,
        groups: socialFederationService.getGroupsForBroker(demoBroker.id).length,
        pendingWorkflowInvites: socialFederationService.getPendingWorkflowInvitations(demoBroker.id).length
      };
    }
  });

  // ===========================================
  // Shared Context Endpoints
  // ===========================================

  // GET /contexts - List shared contexts for the broker
  server.route({
    method: 'GET',
    path: '/contexts',
    handler: () => {
      const contexts = sharedContextService.getContextsForBroker(demoBroker.id);
      return { contexts: contexts.map(c => sharedContextService.exportContextAsJSON(c.id)) };
    }
  });

  // POST /contexts - Create a shared context
  server.route({
    method: 'POST',
    path: '/contexts',
    handler: (request, h) => {
      const payload = request.payload as {
        name: string;
        description?: string;
        syncStrategy?: SyncStrategy;
        conflictResolution?: ConflictResolution;
        isPublic?: boolean;
      };
      if (!payload?.name) {
        return h.response({ error: 'name is required' }).code(400);
      }
      const context = sharedContextService.createContext(demoBroker.id, {
        name: payload.name,
        description: payload.description,
        syncStrategy: payload.syncStrategy,
        conflictResolution: payload.conflictResolution,
        isPublic: payload.isPublic
      });
      return sharedContextService.exportContextAsJSON(context.id);
    }
  });

  // GET /contexts/{id} - Get a shared context
  server.route({
    method: 'GET',
    path: '/contexts/{id}',
    handler: (request, h) => {
      const context = sharedContextService.getContext(request.params.id);
      if (!context) {
        return h.response({ error: 'Context not found' }).code(404);
      }
      return sharedContextService.exportContextAsJSON(context.id);
    }
  });

  // DELETE /contexts/{id} - Delete a shared context
  server.route({
    method: 'DELETE',
    path: '/contexts/{id}',
    handler: (request, h) => {
      const success = sharedContextService.deleteContext(request.params.id, demoBroker.id);
      if (!success) {
        return h.response({ error: 'Context not found or not authorized' }).code(404);
      }
      return { success: true, contextId: request.params.id };
    }
  });

  // POST /contexts/{id}/join - Join a shared context
  server.route({
    method: 'POST',
    path: '/contexts/{id}/join',
    handler: (request, h) => {
      const replica = sharedContextService.joinContext(request.params.id, demoBroker.id);
      if (!replica) {
        return h.response({ error: 'Context not found or not authorized' }).code(404);
      }
      return replica;
    }
  });

  // POST /contexts/{id}/leave - Leave a shared context
  server.route({
    method: 'POST',
    path: '/contexts/{id}/leave',
    handler: (request, h) => {
      const success = sharedContextService.leaveContext(request.params.id, demoBroker.id);
      if (!success) {
        return h.response({ error: 'Not a member of this context' }).code(404);
      }
      return { success: true, contextId: request.params.id };
    }
  });

  // POST /contexts/{id}/access - Grant access to a context
  server.route({
    method: 'POST',
    path: '/contexts/{id}/access',
    handler: (request, h) => {
      const payload = request.payload as {
        brokerId: string;
        level: AccessLevel;
      };
      if (!payload?.brokerId || !payload?.level) {
        return h.response({ error: 'brokerId and level are required' }).code(400);
      }
      const success = sharedContextService.grantAccess(
        request.params.id,
        demoBroker.id,
        payload.brokerId,
        payload.level
      );
      if (!success) {
        return h.response({ error: 'Context not found or not authorized' }).code(404);
      }
      return { success: true, brokerId: payload.brokerId, level: payload.level };
    }
  });

  // DELETE /contexts/{id}/access/{brokerId} - Revoke access
  server.route({
    method: 'DELETE',
    path: '/contexts/{id}/access/{brokerId}',
    handler: (request, h) => {
      const success = sharedContextService.revokeAccess(
        request.params.id,
        demoBroker.id,
        request.params.brokerId
      );
      if (!success) {
        return h.response({ error: 'Context not found or not authorized' }).code(404);
      }
      return { success: true, brokerId: request.params.brokerId };
    }
  });

  // GET /contexts/{id}/nodes - Get nodes in context
  server.route({
    method: 'GET',
    path: '/contexts/{id}/nodes',
    handler: (request, h) => {
      const context = sharedContextService.getContext(request.params.id);
      if (!context) {
        return h.response({ error: 'Context not found' }).code(404);
      }
      const type = request.query.type as string | undefined;
      const nodes = sharedContextService.getNodes(request.params.id, { type });
      return { nodes };
    }
  });

  // POST /contexts/{id}/nodes - Add a node
  server.route({
    method: 'POST',
    path: '/contexts/{id}/nodes',
    handler: (request, h) => {
      const payload = request.payload as {
        type: string;
        data: Record<string, unknown>;
      };
      if (!payload?.type) {
        return h.response({ error: 'type is required' }).code(400);
      }
      const node = sharedContextService.addNode(
        request.params.id,
        demoBroker.id,
        payload.type,
        payload.data ?? {}
      );
      if (!node) {
        return h.response({ error: 'Context not found or not authorized' }).code(404);
      }
      return node;
    }
  });

  // PUT /contexts/{id}/nodes/{nodeId} - Update a node
  server.route({
    method: 'PUT',
    path: '/contexts/{id}/nodes/{nodeId}',
    handler: (request, h) => {
      const payload = request.payload as Record<string, unknown>;
      const node = sharedContextService.updateNode(
        request.params.id,
        demoBroker.id,
        request.params.nodeId,
        payload ?? {}
      );
      if (!node) {
        return h.response({ error: 'Node not found or not authorized' }).code(404);
      }
      return node;
    }
  });

  // DELETE /contexts/{id}/nodes/{nodeId} - Delete a node
  server.route({
    method: 'DELETE',
    path: '/contexts/{id}/nodes/{nodeId}',
    handler: (request, h) => {
      const success = sharedContextService.deleteNode(
        request.params.id,
        demoBroker.id,
        request.params.nodeId
      );
      if (!success) {
        return h.response({ error: 'Node not found or not authorized' }).code(404);
      }
      return { success: true, nodeId: request.params.nodeId };
    }
  });

  // GET /contexts/{id}/edges - Get edges in context
  server.route({
    method: 'GET',
    path: '/contexts/{id}/edges',
    handler: (request, h) => {
      const context = sharedContextService.getContext(request.params.id);
      if (!context) {
        return h.response({ error: 'Context not found' }).code(404);
      }
      const type = request.query.type as string | undefined;
      const sourceId = request.query.sourceId as string | undefined;
      const targetId = request.query.targetId as string | undefined;
      const edges = sharedContextService.getEdges(request.params.id, { type, sourceId, targetId });
      return { edges };
    }
  });

  // POST /contexts/{id}/edges - Add an edge
  server.route({
    method: 'POST',
    path: '/contexts/{id}/edges',
    handler: (request, h) => {
      const payload = request.payload as {
        sourceId: string;
        targetId: string;
        type: string;
        data?: Record<string, unknown>;
      };
      if (!payload?.sourceId || !payload?.targetId || !payload?.type) {
        return h.response({ error: 'sourceId, targetId, and type are required' }).code(400);
      }
      const edge = sharedContextService.addEdge(
        request.params.id,
        demoBroker.id,
        payload.sourceId,
        payload.targetId,
        payload.type,
        payload.data
      );
      if (!edge) {
        return h.response({ error: 'Context/nodes not found or not authorized' }).code(404);
      }
      return edge;
    }
  });

  // DELETE /contexts/{id}/edges/{edgeId} - Delete an edge
  server.route({
    method: 'DELETE',
    path: '/contexts/{id}/edges/{edgeId}',
    handler: (request, h) => {
      const success = sharedContextService.deleteEdge(
        request.params.id,
        demoBroker.id,
        request.params.edgeId
      );
      if (!success) {
        return h.response({ error: 'Edge not found or not authorized' }).code(404);
      }
      return { success: true, edgeId: request.params.edgeId };
    }
  });

  // GET /contexts/{id}/participants - Get active participants
  server.route({
    method: 'GET',
    path: '/contexts/{id}/participants',
    handler: (request, h) => {
      const context = sharedContextService.getContext(request.params.id);
      if (!context) {
        return h.response({ error: 'Context not found' }).code(404);
      }
      const participants = sharedContextService.getActiveParticipants(request.params.id);
      return { participants };
    }
  });

  // PUT /contexts/{id}/presence - Update presence in context
  server.route({
    method: 'PUT',
    path: '/contexts/{id}/presence',
    handler: (request, h) => {
      const payload = request.payload as {
        state?: 'active' | 'idle' | 'away' | 'offline';
        cursor?: { nodeId: string; field?: string; offset?: number };
        selection?: { startNodeId: string; endNodeId: string };
      };
      const success = sharedContextService.updatePresence(
        request.params.id,
        demoBroker.id,
        payload ?? {}
      );
      if (!success) {
        return h.response({ error: 'Not a member of this context' }).code(404);
      }
      return { success: true };
    }
  });

  // GET /contexts/stats - Get shared context stats
  server.route({
    method: 'GET',
    path: '/contexts/stats',
    handler: () => {
      return sharedContextService.getStats();
    }
  });

  // ===========================================
  // WebSocket Stats Endpoint
  // ===========================================

  // GET /ws/stats - Get WebSocket server stats
  server.route({
    method: 'GET',
    path: '/ws/stats',
    handler: () => {
      return realtimeSyncService.getStats();
    }
  });

  // ===========================================
  // Core ACG Endpoints
  // ===========================================

  // GET /context - Generate a Context Graph for an agent
  server.route({
    method: 'POST',
    path: '/context',
    handler: async (request, h) => {
      try {
        const payload = request.payload as ContextRequest;

        if (!payload.agentDID) {
          return h.response({ error: 'agentDID is required' }).code(400);
        }

        const context = await broker.getContext(payload);
        return h.response(context).code(200);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return h.response({ error: message }).code(400);
      }
    }
  });

  // POST /traverse - Execute an affordance
  server.route({
    method: 'POST',
    path: '/traverse',
    handler: async (request, h) => {
      try {
        const payload = request.payload as TraverseRequest;

        if (!payload.contextId || !payload.affordanceId) {
          return h.response({
            error: 'contextId and affordanceId are required'
          }).code(400);
        }

        const result = await broker.traverse(payload);
        return h.response(result).code(200);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return h.response({ error: message }).code(400);
      }
    }
  });

  // GET /traces - Query PROV traces
  server.route({
    method: 'GET',
    path: '/traces',
    handler: async (request, h) => {
      try {
        const query = {
          agentDID: request.query.agentDID as string | undefined,
          actionType: request.query.actionType as string | undefined,
          fromTime: request.query.fromTime as string | undefined,
          toTime: request.query.toTime as string | undefined,
          limit: request.query.limit ? parseInt(request.query.limit as string) : 100,
          offset: request.query.offset ? parseInt(request.query.offset as string) : 0
        };

        const traces = await traceStore.query(query);
        return h.response({ traces, count: traces.length }).code(200);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return h.response({ error: message }).code(400);
      }
    }
  });

  // GET /traces/{id} - Get a specific trace
  server.route({
    method: 'GET',
    path: '/traces/{id}',
    handler: async (request, h) => {
      try {
        const trace = await traceStore.getById(request.params.id);
        if (!trace) {
          return h.response({ error: 'Trace not found' }).code(404);
        }
        return h.response(trace).code(200);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return h.response({ error: message }).code(400);
      }
    }
  });

  // GET /aat - List registered AATs
  server.route({
    method: 'GET',
    path: '/aat',
    handler: () => {
      return { aats: aatRegistry.getRegisteredAATs() };
    }
  });

  // GET /aat/{id} - Get a specific AAT
  server.route({
    method: 'GET',
    path: '/aat/{id}',
    handler: async (request, h) => {
      const aat = await aatRegistry.getAAT(request.params.id);
      if (!aat) {
        return h.response({ error: 'AAT not found' }).code(404);
      }
      return h.response(aat).code(200);
    }
  });

  // GET /ontology - Get the system ontology (Turtle format)
  server.route({
    method: 'GET',
    path: '/ontology',
    handler: (request, h) => {
      const accept = request.headers.accept ?? '';
      if (accept.includes('text/turtle') || accept.includes('application/n-triples')) {
        return h.response(ontologyContent)
          .type('text/turtle')
          .code(200);
      }
      // Return JSON-LD context for JSON clients
      return h.response({
        '@context': [
          'https://agentcontextgraph.dev/ontology',
          'https://agentcontextgraph.dev/aat',
          'https://agentcontextgraph.dev/actions'
        ],
        description: 'Agent Context Graph Ontology',
        files: ['acg-core.ttl', 'aat-types.ttl', 'actions.ttl'],
        turtleEndpoint: '/ontology (Accept: text/turtle)'
      }).code(200);
    }
  });

  // GET /hydra - Get the Hydra API documentation
  server.route({
    method: 'GET',
    path: '/hydra',
    handler: (request, h) => {
      const accept = request.headers.accept ?? '';
      if (accept.includes('text/turtle') || accept.includes('application/n-triples')) {
        return h.response(hydraContent)
          .type('text/turtle')
          .code(200);
      }
      return h.response({
        '@context': 'http://www.w3.org/ns/hydra/core',
        '@type': 'ApiDocumentation',
        title: 'Agent Context Graph API',
        description: 'Hypermedia-driven API for agent context management',
        entrypoint: '/',
        turtleEndpoint: '/hydra (Accept: text/turtle)'
      }).code(200);
    }
  });

  // GET /shacl - Get the SHACL shapes
  server.route({
    method: 'GET',
    path: '/shacl',
    handler: (request, h) => {
      const accept = request.headers.accept ?? '';
      if (accept.includes('text/turtle') || accept.includes('application/n-triples')) {
        return h.response(shaclContent)
          .type('text/turtle')
          .code(200);
      }
      return h.response({
        '@context': 'http://www.w3.org/ns/shacl#',
        description: 'SHACL shapes for Agent Context Graph validation',
        files: ['context.ttl', 'aat-safety.ttl', 'params.ttl'],
        turtleEndpoint: '/shacl (Accept: text/turtle)'
      }).code(200);
    }
  });

  // ===========================================
  // Semantic Catalog Endpoints (Hydra)
  // ===========================================

  // GET /data/catalog - Retrieve semantic catalog
  server.route({
    method: 'GET',
    path: '/data/catalog',
    handler: (_request, h) => {
      return h.response(catalogDoc).type('application/ld+json');
    }
  });

  // GET /data/products - List data products
  server.route({
    method: 'GET',
    path: '/data/products',
    handler: (_request, h) => {
      return h.response(dataProductsDoc).type('application/ld+json');
    }
  });

  // GET /data/products/{id} - Get specific data product
  server.route({
    method: 'GET',
    path: '/data/products/{id}',
    handler: (request, h) => {
      const productId = normalizeProductId(request.params.id);
      const product = dataProductIndex.get(productId);
      if (!product) {
        return h.response({ error: 'Data product not found' }).code(404);
      }
      return h.response(product).type('application/ld+json');
    }
  });

  // GET /data/contracts - List data contracts
  server.route({
    method: 'GET',
    path: '/data/contracts',
    handler: (_request, h) => {
      return h.response(dataContractsDoc).type('application/ld+json');
    }
  });

  // GET /data/contracts/{id} - Get specific data contract
  server.route({
    method: 'GET',
    path: '/data/contracts/{id}',
    handler: (request, h) => {
      const contractId = normalizeContractId(request.params.id);
      const contract = dataContractIndex.get(contractId);
      if (!contract) {
        return h.response({ error: 'Data contract not found' }).code(404);
      }
      return h.response(contract).type('application/ld+json');
    }
  });

  // GET /data/contracts/{id}/shape - Get SHACL shape for contract
  server.route({
    method: 'GET',
    path: '/data/contracts/{id}/shape',
    handler: (request, h) => {
      const contractId = normalizeContractId(request.params.id);
      const contract = dataContractIndex.get(contractId);
      if (!contract) {
        return h.response({ error: 'Data contract not found' }).code(404);
      }
      if (!contractShapeTurtle) {
        return h.response({ error: 'Contract shape not available' }).code(404);
      }
      return h.response(contractShapeTurtle).type('text/turtle');
    }
  });

  // ===========================================
  // Data Query Endpoints (Semantic Layer)
  // ===========================================

  // POST /data/query - Execute a semantic query (SPARQL canonical)
  server.route({
    method: 'POST',
    path: '/data/query',
    handler: async (request, h) => {
      try {
        const payload = request.payload as {
          query?: string;
          sparql?: string;
          statement?: string;
          queryLanguage?: string;
          semanticLayerRef?: string;
          sourceRef?: string;
          mappingRef?: string;
          federationProfileRef?: string;
          resultFormat?: string;
          timeoutSeconds?: number;
          warehouseId?: string;
          catalog?: string;
          schema?: string;
          waitTimeoutSeconds?: number;
          maxRows?: number;
        };

        const query = (payload?.query ?? payload?.sparql ?? payload?.statement)?.toString();
        if (!query) {
          return h.response({ error: 'query is required' }).code(400);
        }

        const queryLanguage = (payload?.queryLanguage ??
          (payload?.sparql ? 'sparql' : payload?.statement ? 'sql' : 'sparql')).toLowerCase();

        if (queryLanguage === 'sparql') {
          const semanticClient = getSemanticQueryClient(payload.semanticLayerRef);
          const result = await semanticClient.query({
            query,
            endpoint: payload.semanticLayerRef,
            resultFormat: payload.resultFormat,
            timeoutSeconds: payload.timeoutSeconds
          });

          return h.response({
            queryId: result.queryId,
            status: { state: 'SUCCEEDED' },
            results: result.results,
            contentType: result.contentType
          }).code(200);
        }

        if (queryLanguage === 'sql') {
          const result = await getDatabricksClient().executeStatement({
            statement: query,
            warehouseId: payload.warehouseId,
            catalog: payload.catalog,
            schema: payload.schema,
            waitTimeoutSeconds: payload.waitTimeoutSeconds,
            timeoutSeconds: payload.timeoutSeconds,
            maxRows: payload.maxRows
          });

          if (result.status.state === 'FAILED' || result.status.state === 'CANCELED') {
            return h.response({
              error: result.status.error ?? result.status.message ?? 'SQL query failed',
              queryId: result.statementId,
              status: result.status
            }).code(400);
          }

          return h.response({
            queryId: result.statementId,
            status: result.status,
            manifest: result.manifest,
            results: result.result
          }).code(200);
        }

        return h.response({ error: `Unsupported queryLanguage: ${payload.queryLanguage ?? 'unknown'}` }).code(400);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return h.response({ error: message }).code(400);
      }
    }
  });

  // GET /data/query/{queryId} - Fetch status/result for async SQL providers
  server.route({
    method: 'GET',
    path: '/data/query/{queryId}',
    handler: async (request, h) => {
      try {
        const queryId = request.params.queryId as string;
        const waitTimeoutSeconds = request.query.waitTimeoutSeconds
          ? parseInt(request.query.waitTimeoutSeconds as string)
          : undefined;
        const provider = (request.query.provider as string | undefined)?.toLowerCase() ?? 'sql';

        if (!queryId) {
          return h.response({ error: 'queryId is required' }).code(400);
        }

        if (provider !== 'sql') {
          return h.response({ error: 'Query status is only supported for async SQL providers' }).code(400);
        }

        const result = await getDatabricksClient().getStatement(queryId, waitTimeoutSeconds);
        return h.response({
          queryId: result.statementId,
          status: result.status,
          manifest: result.manifest,
          results: result.result
        }).code(200);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return h.response({ error: message }).code(400);
      }
    }
  });

  // ===========================================
  // Knowledge Graph Endpoints
  // ===========================================

  // GET /knowledge-graphs - List knowledge graphs
  server.route({
    method: 'GET',
    path: '/knowledge-graphs',
    handler: () => {
      return { knowledgeGraphs: knowledgeGraphService.listGraphs() };
    }
  });

  // POST /knowledge-graphs - Register a knowledge graph
  server.route({
    method: 'POST',
    path: '/knowledge-graphs',
    handler: (request, h) => {
      const payload = request.payload as Record<string, unknown>;
      if (!payload?.id) {
        return h.response({ error: 'id is required' }).code(400);
      }
      const graph = knowledgeGraphService.registerGraph(payload as any);
      return h.response(graph).code(201);
    }
  });

  // POST /knowledge-graphs/{id}/query - Query a knowledge graph
  server.route({
    method: 'POST',
    path: '/knowledge-graphs/{id}/query',
    handler: (request, h) => {
      const payload = request.payload as { query: string; language?: 'sparql' | 'dsl' };
      if (!payload?.query) {
        return h.response({ error: 'query is required' }).code(400);
      }
      const result = knowledgeGraphService.queryGraph(request.params.id, payload);
      return h.response(result).code(200);
    }
  });

  // POST /knowledge-graphs/{id}/mappings - Register mappings (stub)
  server.route({
    method: 'POST',
    path: '/knowledge-graphs/{id}/mappings',
    handler: (request, h) => {
      const payload = request.payload as { mappingRef?: string };
      if (!payload?.mappingRef) {
        return h.response({ error: 'mappingRef is required' }).code(400);
      }

      const update = knowledgeGraphService.registerMapping(request.params.id, payload.mappingRef);
      if (!update) {
        return h.response({ error: 'Knowledge graph not found' }).code(404);
      }

      return h.response({
        status: 'accepted',
        update
      }).code(202);
    }
  });

  // ===========================================
  // SPARQL Endpoints
  // ===========================================

  // POST /sparql - Execute a SPARQL query
  server.route({
    method: 'POST',
    path: '/sparql',
    handler: (request, h) => {
      try {
        const payload = request.payload as { query: string };
        if (!payload.query) {
          return h.response({ error: 'query is required' }).code(400);
        }

        const result = sparqlEndpoint.query(payload.query);
        if (!result.success) {
          return h.response({ error: result.error }).code(400);
        }

        return h.response(result).code(200);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return h.response({ error: message }).code(400);
      }
    }
  });

  // GET /sparql/queries - List available named queries
  server.route({
    method: 'GET',
    path: '/sparql/queries',
    handler: () => {
      return { queries: sparqlEndpoint.getNamedQueries() };
    }
  });

  // POST /sparql/queries/{name} - Execute a named query
  server.route({
    method: 'POST',
    path: '/sparql/queries/{name}',
    handler: (request, h) => {
      try {
        const name = request.params.name as string;
        const params = (request.payload as Record<string, string>) ?? {};

        const result = sparqlEndpoint.executeNamedQuery(name, params);
        if (!result.success) {
          return h.response({ error: result.error }).code(400);
        }

        return h.response(sparqlToJson(result) as object).code(200);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return h.response({ error: message }).code(400);
      }
    }
  });

  // GET /rdf - Export all traces as Turtle
  server.route({
    method: 'GET',
    path: '/rdf',
    handler: (request, h) => {
      const accept = request.headers.accept ?? '';
      const turtle = rdfStore.exportTurtle();

      if (accept.includes('text/turtle') || accept.includes('application/n-triples')) {
        return h.response(turtle).type('text/turtle').code(200);
      }

      return h.response({
        format: 'text/turtle',
        size: turtle.length,
        stats: rdfStore.getStats(),
        turtleEndpoint: '/rdf (Accept: text/turtle)'
      }).code(200);
    }
  });

  // GET /rdf/stats - Get RDF store statistics
  server.route({
    method: 'GET',
    path: '/rdf/stats',
    handler: () => {
      return rdfStore.getStats();
    }
  });

  // ===========================================
  // Policy Endpoints
  // ===========================================

  // POST /policy/evaluate - Evaluate a policy decision
  server.route({
    method: 'POST',
    path: '/policy/evaluate',
    handler: (request, h) => {
      try {
        const payload = request.payload as {
          policies: string[];
          action: string;
          context: Record<string, unknown>;
        };

        if (!payload.policies || !payload.action) {
          return h.response({ error: 'policies and action are required' }).code(400);
        }

        const result = opaPolicyEngine.evaluatePolicies(
          payload.policies,
          payload.action,
          payload.context ?? {}
        );

        return h.response(result).code(200);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return h.response({ error: message }).code(400);
      }
    }
  });

  // GET /policy/rules - List available policy rules
  server.route({
    method: 'GET',
    path: '/policy/rules',
    handler: () => {
      return { rules: opaPolicyEngine.listRules() };
    }
  });

  // GET / - API entry point (Hydra-style)
  server.route({
    method: 'GET',
    path: '/',
    handler: () => {
      return {
        '@context': 'http://www.w3.org/ns/hydra/core',
        '@type': 'EntryPoint',
        '@id': '/',
        'contexts': '/context',
        'traverse': '/traverse',
        'traces': '/traces',
        'aat': '/aat',
        'broker': '/broker',
        'platforms': '/platforms',
        'social': {
          'profile': '/social/profile',
          'connections': '/social/connections',
          'invites': '/social/invites',
          'notifications': '/social/notifications',
          'groups': '/social/groups',
          'discovery': '/social/discovery',
          'stats': '/social/stats'
        },
        'sharedContexts': '/contexts',
        'ontology': '/ontology',
        'hydra': '/hydra',
        'shacl': '/shacl',
        'sparql': '/sparql',
        'sparqlQueries': '/sparql/queries',
        'rdf': '/rdf',
        'rdfStats': '/rdf/stats',
        'dataCatalog': '/data/catalog',
        'dataProducts': '/data/products',
        'dataContracts': '/data/contracts',
        'dataQuery': '/data/query',
        'knowledgeGraphs': '/knowledge-graphs',
        'tools': '/broker/tools',
        'policyEvaluate': '/policy/evaluate',
        'policyRules': '/policy/rules',
        'health': '/health'
      };
    }
  });

  await server.start();

  // Attach WebSocket server for real-time sync
  realtimeSyncService.attach(server.listener, '/ws');

  console.log('Agent Context Graph server running at:', server.info.uri);
  console.log('\nCore Endpoints:');
  console.log('  GET  /              - API entry point (Hydra)');
  console.log('  POST /context       - Generate a Context Graph');
  console.log('  POST /traverse      - Execute an affordance');
  console.log('  GET  /traces        - Query PROV traces');
  console.log('  GET  /traces/{id}   - Get a specific trace');
  console.log('  GET  /aat           - List registered AATs');
  console.log('  GET  /aat/{id}      - Get a specific AAT');
  console.log('\nPersonal Broker Endpoints:');
  console.log('  GET  /broker             - Personal broker info');
  console.log('  GET  /broker/conversations - List conversations');
  console.log('  POST /broker/conversations - Start conversation');
  console.log('  POST /broker/conversations/{id}/messages - Send message');
  console.log('  GET  /broker/channels    - List channels');
  console.log('  GET  /broker/memory      - Query memory');
  console.log('  GET  /broker/contacts    - List contacts');
  console.log('  GET  /broker/presence    - Get presence');
  console.log('  GET  /platforms          - List channel platforms');
  console.log('\nSocial Federation Endpoints:');
  console.log('  GET  /social/profile       - Get profile');
  console.log('  PUT  /social/profile       - Update profile');
  console.log('  GET  /social/connections   - List connections');
  console.log('  POST /social/connections/request - Request connection');
  console.log('  GET  /social/invites       - List invite links');
  console.log('  POST /social/invites       - Create invite link');
  console.log('  GET  /social/notifications - Get notifications');
  console.log('  GET  /social/groups        - List groups');
  console.log('  POST /social/groups        - Create group');
  console.log('  GET  /social/discovery     - Discover brokers');
  console.log('  GET  /social/stats         - Federation stats');
  console.log('\nShared Context Endpoints:');
  console.log('  GET  /contexts             - List shared contexts');
  console.log('  POST /contexts             - Create shared context');
  console.log('  GET  /contexts/{id}        - Get context details');
  console.log('  POST /contexts/{id}/join   - Join context');
  console.log('  POST /contexts/{id}/nodes  - Add node');
  console.log('  POST /contexts/{id}/edges  - Add edge');
  console.log('  GET  /contexts/{id}/participants - Active participants');
  console.log('  GET  /contexts/stats       - Context stats');
  console.log('\nReal-time Sync:');
  console.log('  WS   /ws                   - WebSocket endpoint');
  console.log('  GET  /ws/stats             - WebSocket stats');
  console.log('\nSPARQL Endpoints:');
  console.log('  POST /sparql           - Execute a SPARQL query');
  console.log('  GET  /sparql/queries   - List named queries');
  console.log('  POST /sparql/queries/{name} - Execute named query');
  console.log('\nSemantic Catalog Endpoints:');
  console.log('  GET  /data/catalog     - Hydra semantic catalog');
  console.log('  GET  /data/products    - List data products');
  console.log('  GET  /data/products/{id} - Get data product');
  console.log('  GET  /data/contracts   - List data contracts');
  console.log('  GET  /data/contracts/{id} - Get data contract');
  console.log('  GET  /data/contracts/{id}/shape - Get contract SHACL shape');
  console.log('\nData Query Endpoints:');
  console.log('  POST /data/query   - Execute a semantic query (SPARQL canonical; SQL adapter supported)');
  console.log('  GET  /data/query/{queryId} - Fetch status for SQL adapters');
  console.log('\nRDF Endpoints:');
  console.log('  GET  /rdf           - Export all traces as Turtle');
  console.log('  GET  /rdf/stats     - RDF store statistics');
  console.log('\nPolicy Endpoints:');
  console.log('  POST /policy/evaluate - Evaluate policy decision');
  console.log('  GET  /policy/rules    - List policy rules');
  console.log('\nSpecification Endpoints:');
  console.log('  GET  /ontology      - System ontology (OWL/RDF)');
  console.log('  GET  /hydra         - Hydra API documentation');
  console.log('  GET  /shacl         - SHACL shapes');
  console.log('  GET  /health        - Health check');
}

process.on('unhandledRejection', (err) => {
  console.error(err);
  process.exit(1);
});

init();
