import { v4 as uuidv4 } from 'uuid';
import type {
  ContextGraph,
  Affordance,
  VerifiedCredentialRef,
  Constraint,
  TracePolicy,
  ProvTrace,
  IVerifier,
  IPolicyEngine,
  IAATRegistry,
  ITraceStore,
  ICausalEvaluator,
  EnclaveRef,
  CheckpointRef
} from '../interfaces/index.js';
import { SHACLValidatorService, getSHACLValidator } from '../services/shacl-validator.js';
import { EnclaveService, type CreateEnclaveParams, type SealEnclaveParams, type DestroyEnclaveParams } from '../services/enclave-service.js';
import { CheckpointStore, type CreateCheckpointParams, type ResumeCheckpointParams, type AgentCheckpointState } from '../services/checkpoint-store.js';
import { UsageSemanticsService } from '../services/usage-semantics.js';
import { KnowledgeGraphService } from '../services/knowledge-graph-service.js';
import { SemanticQueryClient } from '../services/semantic-query-client.js';
import { DatabricksSqlClient, type DatabricksSqlQueryRequest } from '../services/databricks-sql-client.js';

export interface ContextRequest {
  agentDID: string;
  proof?: unknown;
  credentials?: unknown[];
  scope?: {
    domain?: string;
    resources?: string[];
  };
}

export interface TraverseRequest {
  contextId: string;
  affordanceId: string;
  parameters: Record<string, unknown>;
  credentials?: unknown[];
}

export interface TraverseResult {
  success: boolean;
  trace: ProvTrace;
  result?: unknown;
  error?: string;
  newContext?: ContextGraph;
}

/**
 * Context Broker - Core component that generates and manages Context Graphs
 *
 * Key responsibilities:
 * 1. Generate Context Graphs based on agent identity and credentials
 * 2. Enforce AAT constraints (no forbidden actions in affordances)
 * 3. Handle affordance traversal with PROV trace generation
 * 4. Gate affordances based on VC requirements
 */
export class ContextBroker {
  private contexts: Map<string, ContextGraph> = new Map();
  private verifier: IVerifier;
  private policyEngine: IPolicyEngine;
  private aatRegistry: IAATRegistry;
  private traceStore: ITraceStore;
  private causalEvaluator: ICausalEvaluator;
  private shaclValidator: SHACLValidatorService;
  private shaclInitialized: boolean = false;
  private usageSemanticsService: UsageSemanticsService;
  private knowledgeGraphService?: KnowledgeGraphService;
  private semanticQueryClient: SemanticQueryClient | null = null;
  private databricksClient?: DatabricksSqlClient;

  // Infrastructure services (Gas Town inspired)
  private enclaveService: EnclaveService;
  private checkpointStore: CheckpointStore;

  // Default context expiration (5 minutes)
  private readonly CONTEXT_TTL_MS = 5 * 60 * 1000;

  constructor(
    verifier: IVerifier,
    policyEngine: IPolicyEngine,
    aatRegistry: IAATRegistry,
    traceStore: ITraceStore,
    causalEvaluator: ICausalEvaluator,
    enclaveService?: EnclaveService,
    checkpointStore?: CheckpointStore,
    usageSemanticsService?: UsageSemanticsService,
    knowledgeGraphService?: KnowledgeGraphService
  ) {
    this.verifier = verifier;
    this.policyEngine = policyEngine;
    this.aatRegistry = aatRegistry;
    this.traceStore = traceStore;
    this.causalEvaluator = causalEvaluator;
    this.shaclValidator = getSHACLValidator();
    this.usageSemanticsService = usageSemanticsService ?? new UsageSemanticsService(this.traceStore);
    this.knowledgeGraphService = knowledgeGraphService;

    // Initialize infrastructure services (use defaults if not provided)
    this.enclaveService = enclaveService ?? new EnclaveService();
    this.checkpointStore = checkpointStore ?? new CheckpointStore();

    // Wire trace emitters for PROV tracking
    this.enclaveService.setTraceEmitter(async (trace) => {
      await this.traceStore.store(trace as unknown as ProvTrace);
    });
    this.checkpointStore.setTraceEmitter(async (trace) => {
      await this.traceStore.store(trace as unknown as ProvTrace);
    });
  }

  /**
   * Initialize infrastructure services
   */
  async initializeInfrastructure(): Promise<void> {
    await this.enclaveService.initialize();
    await this.checkpointStore.initialize();
  }

  /**
   * Initialize SHACL validator with shapes from directory
   */
  async initializeSHACL(shaclDir: string): Promise<void> {
    if (!this.shaclInitialized) {
      await this.shaclValidator.loadShapesFromDirectory(shaclDir);
      this.shaclInitialized = true;
    }
  }

  private getSemanticQueryClient(overrideEndpoint?: string): SemanticQueryClient {
    const endpoint = overrideEndpoint ?? process.env.SEMANTIC_LAYER_SPARQL_ENDPOINT ?? '';
    if (!endpoint) {
      throw new Error('Semantic layer endpoint missing. Set SEMANTIC_LAYER_SPARQL_ENDPOINT or provide semanticLayerRef.');
    }
    if (!this.semanticQueryClient || this.semanticQueryClient.endpoint !== endpoint) {
      this.semanticQueryClient = new SemanticQueryClient({ endpoint });
    }
    return this.semanticQueryClient;
  }

  private getDatabricksClient(): DatabricksSqlClient {
    if (this.databricksClient) {
      return this.databricksClient;
    }

    const host = process.env.DATABRICKS_HOST ?? '';
    const token = process.env.DATABRICKS_TOKEN ?? '';
    if (!host || !token) {
      throw new Error('Databricks configuration missing. Set DATABRICKS_HOST and DATABRICKS_TOKEN.');
    }

    this.databricksClient = new DatabricksSqlClient({
      host,
      token,
      warehouseId: process.env.DATABRICKS_WAREHOUSE_ID,
      defaultCatalog: process.env.DATABRICKS_CATALOG,
      defaultSchema: process.env.DATABRICKS_SCHEMA,
      userAgent: 'agent-context-graph'
    });

    return this.databricksClient;
  }

  /**
   * GET /context - Generate a Context Graph for an agent
   */
  async getContext(request: ContextRequest): Promise<ContextGraph> {
    // 1. Verify DID proof of control
    if (request.proof) {
      const proofResult = await this.verifier.verifyDIDProof(request.agentDID, request.proof);
      if (!proofResult.valid) {
        throw new Error(`DID verification failed: ${proofResult.error}`);
      }
    }

    // 2. Verify credentials
    const verifiedCredentials: VerifiedCredentialRef[] = [];
    if (request.credentials) {
      for (const cred of request.credentials) {
        const vcResult = await this.verifier.verifyVC(cred);
        if (vcResult.valid) {
          verifiedCredentials.push(this.toVerifiedCredentialRef(cred, vcResult));
        }
      }
    }

    // 3. Determine agent type (from credentials or default)
    const agentType = this.determineAgentType(verifiedCredentials);

    // 4. Get AAT to determine allowed/forbidden actions
    const aat = await this.aatRegistry.getAAT(agentType);

    // 5. Build affordances based on:
    //    - AAT allowed actions (MUST be subset)
    //    - Verified credentials (gate specific affordances)
    //    - Policy constraints
    const affordances = await this.buildAffordances(
      request.agentDID,
      agentType,
      verifiedCredentials,
      request.scope
    );

    // 5.5. Attach usage-based semantics to affordances (meaning from usage)
    await this.usageSemanticsService.attachUsageSemantics(affordances);

    // 6. Get constraints from policy engine
    const constraints = await this.buildConstraints(request.agentDID, agentType);

    // 7. Get structural requirements from AAT behavioral invariants
    const requiredOutputAction = await this.aatRegistry.getRequiredOutputAction(agentType);

    // 8. Build the Context Graph
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.CONTEXT_TTL_MS);
    const nonce = uuidv4();

    const knowledgeGraphRef = this.knowledgeGraphService?.getDefaultGraph() ?? undefined;
    const knowledgeGraphSnapshot = knowledgeGraphRef
      ? this.knowledgeGraphService?.getSnapshot(knowledgeGraphRef.id) ?? undefined
      : undefined;

    const context: ContextGraph = {
      '@context': [
        // W3C Standards
        'https://www.w3.org/ns/did/v1',
        'https://www.w3.org/2018/credentials/v1',
        'https://www.w3.org/ns/prov#',
        'https://www.w3.org/ns/hydra/core#',
        'https://www.w3.org/ns/odrl/2/',
        {
          // Standard vocabulary prefixes
          'xsd': 'http://www.w3.org/2001/XMLSchema#',
          'rdfs': 'http://www.w3.org/2000/01/rdf-schema#',
          'owl': 'http://www.w3.org/2002/07/owl#',
          'sh': 'http://www.w3.org/ns/shacl#',
          'prov': 'http://www.w3.org/ns/prov#',
          'odrl': 'http://www.w3.org/ns/odrl/2/',
          'hydra': 'http://www.w3.org/ns/hydra/core#',
          'dcterms': 'http://purl.org/dc/terms/',

          // ACG Ontology (https://agentcontextgraph.dev/ontology#)
          'acg': 'https://agentcontextgraph.dev/ontology#',
          'aat': 'https://agentcontextgraph.dev/aat#',

          // ContextGraph class and properties (from acg-core.ttl)
          'ContextGraph': 'acg:ContextGraph',
          'forAgent': { '@id': 'acg:forAgent', '@type': '@id' },
          'agentDID': { '@id': 'acg:hasDID', '@type': '@id' },
          'agentType': { '@id': 'acg:hasAgentType', '@type': '@id' },
          'timestamp': { '@id': 'acg:hasTimestamp', '@type': 'xsd:dateTime' },
          'expiresAt': { '@id': 'acg:expiresAt', '@type': 'xsd:dateTime' },
          'nonce': 'acg:hasNonce',

          // Affordance class and properties (subclass of hydra:Operation)
          'Affordance': 'acg:Affordance',
          'affordances': { '@id': 'acg:hasAffordance', '@container': '@set' },
          'actionType': { '@id': 'acg:hasActionType', '@type': '@id' },
          'target': 'acg:hasTarget',
          'enabled': 'acg:isEnabled',
          'disabledReason': 'acg:disabledReason',
          'effects': { '@id': 'acg:hasEffect', '@container': '@set' },
          'causalSemantics': 'acg:hasCausalSemantics',
          'usageSemantics': 'acg:hasUsageSemantics',
          'stability': { '@id': 'acg:usageStability', '@type': 'xsd:decimal' },
          'drift': { '@id': 'acg:usageDrift', '@type': 'xsd:decimal' },
          'polysemy': { '@id': 'acg:usagePolysemy', '@type': 'xsd:decimal' },
          'evidenceWindow': { '@id': 'acg:usageEvidenceWindow', '@type': 'xsd:duration' },
          'lastObservedAt': { '@id': 'acg:usageLastObservedAt', '@type': 'xsd:dateTime' },
          'usageExamples': { '@id': 'acg:usageExampleTrace', '@container': '@set' },
          'notes': 'acg:usageNotes',
          'preconditions': { '@id': 'acg:hasPrecondition', '@container': '@list' },

          // Target properties (map to Hydra where applicable)
          'Target': 'acg:Target',
          'href': { '@id': 'hydra:entrypoint', '@type': '@id' },
          'method': 'hydra:method',

          // Credential properties
          'verifiedCredentials': { '@id': 'acg:hasCredential', '@container': '@set' },
          'requiresCredential': { '@id': 'acg:requiresCredential', '@container': '@set' },

          // Constraint properties (align with ODRL)
          'Constraint': 'acg:Constraint',
          'constraints': { '@id': 'acg:hasConstraint', '@container': '@set' },
          'rule': 'acg:hasRule',
          'enforcementLevel': 'acg:hasEnforcementLevel',
          'policyRef': { '@id': 'odrl:policy', '@type': '@id' },

          // Effect properties
          'Effect': 'acg:Effect',
          'reversible': 'acg:isReversible',

          // Scope properties
          'scope': 'acg:hasScope',
          'domain': 'acg:scopeDomain',
          'resources': { '@id': 'acg:scopeResource', '@container': '@set' },
          'actions': { '@id': 'acg:scopeAction', '@container': '@set' },

          // Trace policy
          'tracePolicy': 'acg:hasTracePolicy',
          'knowledgeGraphRef': 'acg:knowledgeGraphRef',
          'knowledgeGraphSnapshot': 'acg:knowledgeGraphSnapshot',
          'ontologyRefs': { '@id': 'acg:knowledgeGraphOntologyRef', '@container': '@set' },
          'queryEndpoint': { '@id': 'acg:knowledgeGraphQueryEndpoint', '@type': '@id' },
          'updateEndpoint': { '@id': 'acg:knowledgeGraphUpdateEndpoint', '@type': '@id' },
          'mappingsRef': { '@id': 'acg:knowledgeGraphMappingsRef', '@type': '@id' },
          'graphId': { '@id': 'acg:knowledgeGraphId', '@type': '@id' },
          'lastUpdated': { '@id': 'acg:knowledgeGraphLastUpdated', '@type': 'xsd:dateTime' },
          'summary': 'acg:knowledgeGraphSummary',
          'nodes': 'acg:knowledgeGraphNodes',
          'edges': 'acg:knowledgeGraphEdges',
          'datasets': 'acg:knowledgeGraphDatasets',
          'dataProducts': 'acg:knowledgeGraphDataProducts',

          // SHACL reference
          'shaclRef': { '@id': 'sh:shapesGraph', '@type': '@id' },
          'params': 'acg:hasParams',

          // Link relation (IANA registry compatible)
          'rel': { '@id': 'hydra:supportedOperation', '@type': '@vocab' },
          'relVersion': 'acg:relVersion'
        }
      ],
      id: `urn:uuid:${uuidv4()}`,
      agentDID: request.agentDID,
      agentType,
      timestamp: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      nonce,
      scope: {
        domain: request.scope?.domain ?? 'default',
        resources: request.scope?.resources ?? [],
        actions: affordances.map(a => a.actionType)
      },
      verifiedCredentials,
      constraints,
      affordances,
      tracePolicy: this.getDefaultTracePolicy(),
      knowledgeGraphRef,
      knowledgeGraphSnapshot,
      // Include structural requirements from AAT spec
      structuralRequirements: requiredOutputAction ? { requiredOutputAction } : undefined
    };

    // 8. Store context for later validation
    this.contexts.set(context.id, context);

    // Clean up expired contexts periodically
    this.cleanupExpiredContexts();

    return context;
  }

  /**
   * POST /traverse - Execute an affordance and emit PROV trace
   */
  async traverse(request: TraverseRequest): Promise<TraverseResult> {
    const startTime = new Date();

    // 1. Validate context exists and is not expired
    const context = this.contexts.get(request.contextId);
    if (!context) {
      throw new Error('Context not found');
    }

    if (new Date(context.expiresAt) < startTime) {
      throw new Error('Context has expired');
    }

    // 2. Validate affordance exists in context
    const affordance = context.affordances.find(a => a.id === request.affordanceId);
    if (!affordance) {
      throw new Error('Affordance not found in context');
    }

    if (!affordance.enabled) {
      throw new Error(`Affordance is disabled: ${affordance.disabledReason}`);
    }

    // 2.5. Validate parameters against SHACL shape (if defined)
    if (affordance.params?.shaclRef && this.shaclInitialized) {
      const validationResult = await this.shaclValidator.validateParams(
        affordance.actionType,
        request.parameters
      );

      if (!validationResult.conforms) {
        const violations = validationResult.results
          .map(r => `${r.resultPath ?? 'unknown'}: ${r.resultMessage}`)
          .join('; ');
        throw new Error(`Parameter validation failed (SHACL): ${violations}`);
      }
    }

    // 3. Check credential requirements
    const credentialSnapshots = [];
    if (affordance.requiresCredential && affordance.requiresCredential.length > 0) {
      for (const req of affordance.requiresCredential) {
        const hasCredential = context.verifiedCredentials.some(vc =>
          vc.type.includes(req.schema) &&
          (!req.issuer || vc.issuer === req.issuer)
        );
        if (!hasCredential) {
          throw new Error(`Missing required credential: ${req.schema}`);
        }
      }
      // Build credential snapshots for trace
      for (const vc of context.verifiedCredentials) {
        credentialSnapshots.push({
          credentialId: vc.id,
          credentialType: vc.type,
          issuer: vc.issuer,
          validAt: startTime.toISOString()
        });
      }
    }

    // 4. Evaluate policy
    const policyDecision = await this.policyEngine.evaluateAction(
      context.agentDID,
      affordance.actionType,
      {
        credentials: context.verifiedCredentials,
        constraints: context.constraints,
        targetResource: affordance.target.href,
        parameters: request.parameters
      }
    );

    if (policyDecision.decision === 'deny') {
      throw new Error(`Policy denied: ${policyDecision.reason}`);
    }

    // 5. If causal semantics present, evaluate predicted outcomes
    let causalEvaluation;
    if (affordance.causalSemantics) {
      const evalResult = await this.causalEvaluator.evaluate(
        affordance.causalSemantics.causalModelRef,
        affordance.causalSemantics.interventionLabel,
        request.parameters
      );

      if (evalResult.success) {
        // Check outcome constraints
        const outcomeConstraints = context.constraints
          .filter(c => c.type === 'outcome' && c.enforcementLevel === 'strict')
          .map(c => this.parseOutcomeConstraint(c.rule))
          .filter((c): c is NonNullable<typeof c> => c !== null);

        if (outcomeConstraints.length > 0) {
          const constraintResult = await this.causalEvaluator.checkConstraints(
            evalResult.predictedOutcomes,
            outcomeConstraints
          );

          if (!constraintResult.allSatisfied) {
            const violations = constraintResult.violations
              .map(v => v.message)
              .join('; ');
            throw new Error(`Outcome constraints not satisfied: ${violations}`);
          }
        }

        causalEvaluation = {
          modelRef: affordance.causalSemantics.causalModelRef,
          predictedOutcomes: evalResult.predictedOutcomes,
          confidence: evalResult.confidence
        };
      }
    }

    // 6. Execute the action (infrastructure actions handled directly, others forwarded)
    const result = await this.executeAction(affordance, request.parameters, context);
    const endTime = new Date();

    // 7. Generate PROV trace
    const trace: ProvTrace = {
      '@context': [
        // W3C Standards
        'https://www.w3.org/ns/prov#',
        'https://www.w3.org/2018/credentials/v1',
        {
          // Standard vocabulary prefixes
          'xsd': 'http://www.w3.org/2001/XMLSchema#',
          'rdfs': 'http://www.w3.org/2000/01/rdf-schema#',
          'prov': 'http://www.w3.org/ns/prov#',

          // ACG Ontology (https://agentcontextgraph.dev/ontology#)
          'acg': 'https://agentcontextgraph.dev/ontology#',
          'aat': 'https://agentcontextgraph.dev/aat#',

          // ProvTrace class (subclass of prov:Activity, from acg-core.ttl)
          'ProvTrace': 'acg:ProvTrace',

          // PROV-O mappings
          'wasAssociatedWith': 'prov:wasAssociatedWith',
          'used': 'prov:used',
          'generated': 'prov:generated',
          'startedAtTime': { '@id': 'prov:startedAtTime', '@type': 'xsd:dateTime' },
          'endedAtTime': { '@id': 'prov:endedAtTime', '@type': 'xsd:dateTime' },

          // Agent association properties
          'agentDID': { '@id': 'acg:hasDID', '@type': '@id' },
          'agentType': { '@id': 'acg:hasAgentType', '@type': '@id' },

          // Trace input properties (prov:used details)
          'contextSnapshot': 'acg:usedContext',
          'affordance': 'acg:usedAffordance',
          'parameters': 'acg:usedParameters',
          'credentials': { '@id': 'acg:usedCredentials', '@container': '@set' },

          // Trace output properties (prov:generated details)
          'outcome': 'acg:generatedOutcome',
          'stateChanges': { '@id': 'acg:stateChanges', '@container': '@set' },
          'eventsEmitted': { '@id': 'acg:eventsEmitted', '@container': '@set' },
          'newContext': 'acg:generatedNewContext',

          // ACG trace extensions
          'interventionLabel': 'acg:interventionLabel',
          'policyEvaluations': { '@id': 'acg:policyEvaluations', '@container': '@set' },
          'causalEvaluation': 'acg:causalEvaluation',
          'usageEvent': 'acg:hasUsageEvent',
          'usageRel': 'acg:usageRel',
          'usageRelVersion': 'acg:usageRelVersion',
          'usageActionType': 'acg:usageActionType',
          'usageOutcomeStatus': 'acg:usageOutcomeStatus',
          'usageTimestamp': { '@id': 'acg:usageTimestamp', '@type': 'xsd:dateTime' },
          'knowledgeGraphRef': 'acg:knowledgeGraphRef',
          'knowledgeGraphUpdate': 'acg:knowledgeGraphUpdate'
        }
      ],
      id: `urn:uuid:${uuidv4()}`,
      '@type': ['prov:Activity', 'aat:Decision'],
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
          id: affordance.id,
          rel: affordance.rel,
          relVersion: affordance.relVersion,
          actionType: affordance.actionType,
          targetType: affordance.target.type,
          targetHref: affordance.target.href
        },
        parameters: request.parameters,
        credentials: credentialSnapshots,
        knowledgeGraphRef: context.knowledgeGraphRef
      },
      generated: {
        outcome: {
          status: result.success ? 'success' : 'failure',
          resultType: result.resultType,
          resultRef: result.resultRef
        },
        stateChanges: result.stateChanges ?? [],
        eventsEmitted: result.eventsEmitted ?? []
      },
      interventionLabel: affordance.causalSemantics?.interventionLabel,
      startedAtTime: startTime.toISOString(),
      endedAtTime: endTime.toISOString(),
      policyEvaluations: [
        {
          policyRef: policyDecision.policyRef,
          result: policyDecision.decision,
          reason: policyDecision.reason
        }
      ],
      causalEvaluation
    };

    trace.usageEvent = {
      usageRel: affordance.rel,
      usageRelVersion: affordance.relVersion,
      usageActionType: affordance.actionType,
      usageOutcomeStatus: result.success ? 'success' : 'failure',
      usageTimestamp: endTime.toISOString(),
      contextId: context.id,
      traceId: trace.id
    };

    // 8. Store trace (append-only)
    await this.traceStore.store(trace);

    // 9. Generate new context if needed
    let newContext: ContextGraph | undefined;
    if (result.contextChanged) {
      newContext = await this.getContext({
        agentDID: context.agentDID,
        credentials: request.credentials,
        scope: { domain: context.scope.domain, resources: context.scope.resources }
      });
      trace.generated.newContext = {
        contextId: newContext.id,
        affordancesDelta: {
          added: newContext.affordances
            .filter(a => !context.affordances.some(ca => ca.id === a.id))
            .map(a => a.id),
          removed: context.affordances
            .filter(a => !newContext!.affordances.some(na => na.id === a.id))
            .map(a => a.id)
        }
      };
    }

    return {
      success: result.success,
      trace,
      result: result.data,
      newContext
    };
  }

  /**
   * Build affordances based on AAT, credentials, and policy
   */
  private async buildAffordances(
    agentDID: string,
    agentType: string,
    credentials: VerifiedCredentialRef[],
    scope?: { domain?: string; resources?: string[] }
  ): Promise<Affordance[]> {
    const affordances: Affordance[] = [];
    const aat = await this.aatRegistry.getAAT(agentType);

    if (!aat) {
      // Unknown agent type - only allow request-credential
      return [this.buildRequestCredentialAffordance()];
    }

    // Build affordances for each allowed action
    for (const allowedAction of aat.actionSpace.allowed) {
      // Get the action name (in JSON-LD, 'name' is the action name, 'type' is the RDF type)
      const actionName = allowedAction.name ?? allowedAction.id?.replace('aat:', '') ?? allowedAction.type;

      // Check if agent has required capability
      // Handle both prefixed (acg:PlannerCapability) and unprefixed (PlannerCapability) formats
      const requiredCap = allowedAction.requiresCapability;
      const requiredCapUnprefixed = requiredCap?.replace(/^acg:|^aat:/, '') ?? null;
      const hasCapability = !requiredCap ||
        credentials.some(c =>
          c.credentialSubject.capability === requiredCap ||
          c.credentialSubject.capability === requiredCapUnprefixed
        );

      if (!hasCapability) {
        // Agent lacks capability - don't include this affordance
        // Instead, offer request-credential affordance if not already present
        continue;
      }

      const affordance = this.buildAffordanceForAction(
        actionName,
        agentType,
        requiredCapUnprefixed
      );

      if (affordance) {
        affordances.push(affordance);
      }
    }

    // If no affordances due to missing credentials, add request-credential
    if (affordances.length === 0) {
      affordances.push(this.buildRequestCredentialAffordance());
    }

    // Always add RequestInfo if it's an allowed action (no credential required)
    const requestInfoAction = aat.actionSpace.allowed.find(a =>
      (a.name === 'RequestInfo' || a.id === 'aat:RequestInfo') && !a.requiresCapability
    );
    if (requestInfoAction && !affordances.some(a => a.actionType === 'RequestInfo')) {
      const requestInfoAff = this.buildAffordanceForAction('RequestInfo', agentType, null);
      if (requestInfoAff) {
        affordances.push(requestInfoAff);
      }
    }

    return affordances;
  }

  /**
   * Build a specific affordance for an action type
   */
  private buildAffordanceForAction(
    actionType: string,
    agentType: string,
    requiredCapability: string | null | undefined
  ): Affordance | null {
    const baseAffordance: Partial<Affordance> = {
      '@type': ['hydra:Operation', 'acg:Affordance'],  // Hydra-compatible typing
      id: `aff-${actionType.toLowerCase()}-${uuidv4().slice(0, 8)}`,
      rel: actionType.replace(/([A-Z])/g, '-$1').toLowerCase().replace(/^-/, ''),
      relVersion: '1.0.0',
      actionType,
      enabled: true
    };

    // SHACL shape base URI (used as hydra:expects value)
    const shaclBase = 'https://agentcontextgraph.dev/shacl/params#';

    // Build target and params based on action type
    switch (actionType) {
      case 'EmitPlan':
        return {
          ...baseAffordance,
          target: {
            type: 'HTTP',
            href: 'https://broker.example.com/plans',
            method: 'POST'
          },
          params: {
            shaclRef: `${shaclBase}EmitPlanParamsShape`
          },
          requiresCredential: requiredCapability ? [{ schema: requiredCapability }] : undefined,
          effects: [
            { type: 'resource-create', description: 'Creates a plan', reversible: false }
          ]
        } as Affordance;

      case 'RequestInfo':
        return {
          ...baseAffordance,
          target: {
            type: 'HTTP',
            href: 'https://broker.example.com/info',
            method: 'POST'
          },
          params: {
            shaclRef: `${shaclBase}RequestInfoParamsShape`
          },
          effects: [
            { type: 'event-emit', description: 'Emits info request', reversible: false }
          ]
        } as Affordance;

      case 'Act':
        return {
          ...baseAffordance,
          target: {
            type: 'HTTP',
            href: 'https://executor.example.com/actions',
            method: 'POST'
          },
          params: {
            shaclRef: `${shaclBase}ActParamsShape`
          },
          requiresCredential: requiredCapability ? [{ schema: requiredCapability }] : undefined,
          effects: [
            { type: 'state-change', description: 'Executes action', reversible: false }
          ]
        } as Affordance;

      case 'Report':
        return {
          ...baseAffordance,
          target: {
            type: 'HTTP',
            href: 'https://broker.example.com/reports',
            method: 'POST'
          },
          params: {
            shaclRef: `${shaclBase}ReportParamsShape`
          },
          requiresCredential: requiredCapability ? [{ schema: requiredCapability }] : undefined,
          effects: [
            { type: 'event-emit', description: 'Emits observation', reversible: false }
          ]
        } as Affordance;

      case 'Approve':
        return {
          ...baseAffordance,
          target: {
            type: 'HTTP',
            href: 'https://arbiter.example.com/decisions',
            method: 'POST'
          },
          params: {
            shaclRef: `${shaclBase}ApproveParamsShape`
          },
          requiresCredential: requiredCapability ? [{ schema: requiredCapability }] : undefined,
          effects: [
            { type: 'event-emit', description: 'Emits Approve decision', reversible: false }
          ]
        } as Affordance;

      case 'Deny':
        return {
          ...baseAffordance,
          target: {
            type: 'HTTP',
            href: 'https://arbiter.example.com/decisions',
            method: 'POST'
          },
          params: {
            shaclRef: `${shaclBase}DenyParamsShape`
          },
          requiresCredential: requiredCapability ? [{ schema: requiredCapability }] : undefined,
          effects: [
            { type: 'event-emit', description: 'Emits Deny decision', reversible: false }
          ]
        } as Affordance;

      case 'Store':
        return {
          ...baseAffordance,
          target: {
            type: 'HTTP',
            href: 'https://archivist.example.com/records',
            method: 'POST'
          },
          params: {
            shaclRef: `${shaclBase}StoreParamsShape`
          },
          requiresCredential: requiredCapability ? [{ schema: requiredCapability }] : undefined,
          effects: [
            { type: 'resource-create', description: 'Stores record', reversible: false }
          ]
        } as Affordance;

      case 'Observe':
        return {
          ...baseAffordance,
          target: {
            type: 'HTTP',
            href: 'https://broker.example.com/observe',
            method: 'POST'
          },
          params: {
            shaclRef: `${shaclBase}ObserveParamsShape`
          },
          requiresCredential: requiredCapability ? [{ schema: requiredCapability }] : undefined,
          effects: [
            { type: 'event-emit', description: 'Emits observation', reversible: false }
          ]
        } as Affordance;

      case 'QueryData':
        return {
          ...baseAffordance,
          target: {
            type: 'broker',
            href: 'broker://data/query'
          },
          params: {
            shaclRef: `${shaclBase}QueryDataParamsShape`
          },
          requiresCredential: requiredCapability ? [{ schema: requiredCapability }] : undefined,
          effects: [
            { type: 'resource-read', description: 'Queries data via the semantic layer', reversible: true }
          ]
        } as Affordance;

      // =========================================================================
      // Infrastructure Actions (Gas Town inspired)
      // =========================================================================

      case 'CreateEnclave':
        return {
          ...baseAffordance,
          target: {
            type: 'broker',
            href: 'broker://infrastructure/enclave/create'
          },
          params: {
            shaclRef: `${shaclBase}CreateEnclaveParamsShape`
          },
          requiresCredential: requiredCapability ? [{ schema: requiredCapability }] : [{ schema: 'EnclaveCapability' }],
          effects: [
            { type: 'resource-create', description: 'Creates isolated git worktree enclave', reversible: true }
          ]
        } as Affordance;

      case 'SealEnclave':
        return {
          ...baseAffordance,
          target: {
            type: 'broker',
            href: 'broker://infrastructure/enclave/seal'
          },
          params: {
            shaclRef: `${shaclBase}SealEnclaveParamsShape`
          },
          requiresCredential: requiredCapability ? [{ schema: requiredCapability }] : [{ schema: 'EnclaveCapability' }],
          effects: [
            { type: 'state-change', description: 'Seals enclave (makes read-only)', reversible: false }
          ]
        } as Affordance;

      case 'DestroyEnclave':
        return {
          ...baseAffordance,
          target: {
            type: 'broker',
            href: 'broker://infrastructure/enclave/destroy'
          },
          params: {
            shaclRef: `${shaclBase}DestroyEnclaveParamsShape`
          },
          requiresCredential: requiredCapability ? [{ schema: requiredCapability }] : [{ schema: 'EnclaveCapability' }],
          effects: [
            { type: 'resource-delete', description: 'Destroys enclave and cleans up worktree', reversible: false }
          ]
        } as Affordance;

      case 'Checkpoint':
        return {
          ...baseAffordance,
          target: {
            type: 'broker',
            href: 'broker://infrastructure/checkpoint/create'
          },
          params: {
            shaclRef: `${shaclBase}CheckpointParamsShape`
          },
          effects: [
            { type: 'resource-create', description: 'Creates immutable context checkpoint', reversible: false }
          ]
        } as Affordance;

      case 'Resume':
        return {
          ...baseAffordance,
          target: {
            type: 'broker',
            href: 'broker://infrastructure/checkpoint/resume'
          },
          params: {
            shaclRef: `${shaclBase}ResumeParamsShape`
          },
          effects: [
            { type: 'state-change', description: 'Resumes from checkpoint', reversible: false }
          ]
        } as Affordance;

      default:
        return {
          ...baseAffordance,
          target: {
            type: 'HTTP',
            href: `https://broker.example.com/${actionType.toLowerCase()}`,
            method: 'POST'
          },
          // Use a generic shape ref based on action type
          params: {
            shaclRef: `${shaclBase}${actionType}ParamsShape`
          },
          requiresCredential: requiredCapability ? [{ schema: requiredCapability }] : undefined
        } as Affordance;
    }
  }

  /**
   * Build request-credential affordance for agents without required credentials
   */
  private buildRequestCredentialAffordance(): Affordance {
    return {
      '@type': ['hydra:Operation', 'acg:Affordance'],
      id: `aff-request-credential-${uuidv4().slice(0, 8)}`,
      rel: 'request-credential',
      relVersion: '1.0.0',
      actionType: 'RequestCredential',
      target: {
        type: 'OID4VCI',
        href: 'https://issuer.example.com/.well-known/openid-credential-issuer',
        serviceEndpoint: 'https://issuer.example.com/credential'
      },
      params: {
        shaclRef: 'https://agentcontextgraph.dev/shacl/params#RequestCredentialParamsShape'
      },
      effects: [
        { type: 'event-emit', description: 'Requests credential', reversible: false }
      ],
      enabled: true
    };
  }

  /**
   * Build constraints from policy engine
   */
  private async buildConstraints(
    agentDID: string,
    agentType: string
  ): Promise<Constraint[]> {
    const policies = await this.policyEngine.getActivePolicies(agentDID);
    return policies.map(p => ({
      type: p.type,
      rule: p.rule,
      policyRef: p.id,
      enforcementLevel: 'strict' as const
    }));
  }

  /**
   * Determine agent type from credentials
   */
  private determineAgentType(credentials: VerifiedCredentialRef[]): string {
    // Check for capability credentials that indicate agent type
    for (const cred of credentials) {
      if (cred.type.includes('PlannerCapability')) {
        return 'aat:PlannerAgentType';
      }
      if (cred.type.includes('ExecutorCapability')) {
        return 'aat:ExecutorAgentType';
      }
      if (cred.type.includes('ObserverCapability')) {
        return 'aat:ObserverAgentType';
      }
      if (cred.type.includes('ArbiterCapability')) {
        return 'aat:ArbiterAgentType';
      }
      if (cred.type.includes('ArchivistCapability')) {
        return 'aat:ArchivistAgentType';
      }
      if (cred.type.includes('AnalystCapability')) {
        return 'aat:AnalystAgentType';
      }
    }

    // Default to unknown
    return 'aat:UnknownAgentType';
  }

  /**
   * Convert credential to VerifiedCredentialRef
   */
  private toVerifiedCredentialRef(
    cred: unknown,
    vcResult: { credentialType?: string[]; issuer?: string; subject?: string; expirationDate?: string }
  ): VerifiedCredentialRef {
    const credential = cred as Record<string, unknown>;
    const subject = credential.credentialSubject as Record<string, unknown> | undefined;

    return {
      id: (credential.id as string) ?? `urn:uuid:${uuidv4()}`,
      type: vcResult.credentialType ?? [],
      issuer: vcResult.issuer ?? 'unknown',
      validUntil: vcResult.expirationDate ?? new Date(Date.now() + 86400000).toISOString(),
      credentialSubject: {
        id: vcResult.subject ?? '',
        capability: (subject?.capability as string) ?? ''
      }
    };
  }

  /**
   * Get default trace policy
   */
  private getDefaultTracePolicy(): TracePolicy {
    return {
      mustEmitProvActivity: true,
      retentionPeriod: 'P1Y',
      includeContextSnapshot: true,
      includeOutcomes: true
    };
  }

  /**
   * Parse outcome constraint from rule string
   */
  private parseOutcomeConstraint(rule: string): { variable: string; operator: '<' | '>' | '<=' | '>=' | '==' | '!='; threshold: number } | null {
    // Parse rules like "downtime must be less than 5 minutes"
    const patterns = [
      { regex: /(\w+)\s+must be less than\s+([\d.]+)/i, op: '<' as const },
      { regex: /(\w+)\s+must be below\s+([\d.]+)/i, op: '<' as const },
      { regex: /(\w+)\s+<\s+([\d.]+)/, op: '<' as const },
      { regex: /(\w+)\s+must be greater than\s+([\d.]+)/i, op: '>' as const },
      { regex: /(\w+)\s+>\s+([\d.]+)/, op: '>' as const }
    ];

    for (const { regex, op } of patterns) {
      const match = rule.match(regex);
      if (match) {
        return {
          variable: match[1].toLowerCase().replace(/\s+/g, '_'),
          operator: op,
          threshold: parseFloat(match[2])
        };
      }
    }

    return null;
  }

  /**
   * Execute action - handles infrastructure actions directly, stubs others
   */
  private async executeAction(
    affordance: Affordance,
    parameters: Record<string, unknown>,
    context?: ContextGraph
  ): Promise<{
    success: boolean;
    resultType?: string;
    resultRef?: string;
    data?: unknown;
    stateChanges?: Array<{ resource: string; changeType: string }>;
    eventsEmitted?: Array<{ eventType: string; eventId: string; timestamp: string }>;
    contextChanged?: boolean;
  }> {
    const now = new Date().toISOString();

    // Handle infrastructure actions (broker:// targets)
    if (affordance.target.type === 'broker') {
      return this.executeInfrastructureAction(affordance, parameters, context);
    }

    // Stub implementation for HTTP/DIDComm - in production would make actual calls
    const resultId = `urn:uuid:${uuidv4()}`;

    return {
      success: true,
      resultType: affordance.actionType,
      resultRef: resultId,
      data: { actionType: affordance.actionType, parameters },
      eventsEmitted: [
        {
          eventType: `${affordance.actionType}Completed`,
          eventId: `urn:uuid:${uuidv4()}`,
          timestamp: now
        }
      ],
      contextChanged: false
    };
  }

  /**
   * Execute infrastructure actions (enclave, checkpoint)
   */
  private async executeInfrastructureAction(
    affordance: Affordance,
    parameters: Record<string, unknown>,
    context?: ContextGraph
  ): Promise<{
    success: boolean;
    resultType?: string;
    resultRef?: string;
    data?: unknown;
    stateChanges?: Array<{ resource: string; changeType: string }>;
    eventsEmitted?: Array<{ eventType: string; eventId: string; timestamp: string }>;
    contextChanged?: boolean;
  }> {
    const now = new Date().toISOString();

    switch (affordance.actionType) {
      // =========================================================================
      // Enclave Actions
      // =========================================================================

      case 'CreateEnclave': {
        const params: CreateEnclaveParams = {
          agentDID: context?.agentDID ?? parameters.agentDID as string,
          repository: parameters.repository as string,
          baseBranch: parameters.baseBranch as string | undefined,
          enclaveName: parameters.enclaveName as string | undefined,
          scope: parameters.scope as string[] | undefined,
          ttlSeconds: parameters.ttlSeconds as number | undefined
        };

        const result = await this.enclaveService.createEnclave(params);

        if (!result.success) {
          return {
            success: false,
            resultType: 'CreateEnclave',
            data: { error: result.error }
          };
        }

        return {
          success: true,
          resultType: 'CreateEnclave',
          resultRef: result.enclave!.id,
          data: {
            enclave: {
              id: result.enclave!.id,
              worktreePath: result.enclave!.worktreePath,
              status: result.enclave!.status,
              boundAgentDID: result.enclave!.boundAgentDID
            } as EnclaveRef
          },
          stateChanges: [
            { resource: result.enclave!.id, changeType: 'created' }
          ],
          eventsEmitted: [
            { eventType: 'EnclaveCreated', eventId: result.traceId!, timestamp: now }
          ],
          contextChanged: true // New enclave means new affordances available
        };
      }

      case 'SealEnclave': {
        const params: SealEnclaveParams = {
          enclaveId: parameters.enclaveId as string,
          preserveState: parameters.preserveState as boolean | undefined,
          reason: parameters.reason as string | undefined
        };

        const result = await this.enclaveService.sealEnclave(params);

        if (!result.success) {
          return {
            success: false,
            resultType: 'SealEnclave',
            data: { error: result.error }
          };
        }

        return {
          success: true,
          resultType: 'SealEnclave',
          resultRef: result.enclave!.id,
          data: {
            enclave: {
              id: result.enclave!.id,
              worktreePath: result.enclave!.worktreePath,
              status: result.enclave!.status,
              boundAgentDID: result.enclave!.boundAgentDID
            } as EnclaveRef
          },
          stateChanges: [
            { resource: result.enclave!.id, changeType: 'sealed' }
          ],
          eventsEmitted: [
            { eventType: 'EnclaveSealed', eventId: result.traceId!, timestamp: now }
          ]
        };
      }

      case 'DestroyEnclave': {
        const params: DestroyEnclaveParams = {
          enclaveId: parameters.enclaveId as string,
          force: parameters.force as boolean | undefined,
          archiveFirst: parameters.archiveFirst as boolean | undefined
        };

        const result = await this.enclaveService.destroyEnclave(params);

        if (!result.success) {
          return {
            success: false,
            resultType: 'DestroyEnclave',
            data: { error: result.error }
          };
        }

        return {
          success: true,
          resultType: 'DestroyEnclave',
          resultRef: result.enclave!.id,
          data: { destroyedEnclaveId: result.enclave!.id },
          stateChanges: [
            { resource: result.enclave!.id, changeType: 'destroyed' }
          ],
          eventsEmitted: [
            { eventType: 'EnclaveDestroyed', eventId: result.traceId!, timestamp: now }
          ],
          contextChanged: true // Enclave gone means affordances changed
        };
      }

      case 'QueryData': {
        const query = (parameters.query ?? parameters.sparql ?? parameters.statement) as string | undefined;
        const queryLanguageRaw = (parameters.queryLanguage ??
          (parameters.sparql ? 'sparql' : parameters.statement ? 'sql' : 'sparql')) as string | undefined;
        const queryLanguage = queryLanguageRaw?.toLowerCase() ?? 'sparql';
        if (!query) {
          return {
            success: false,
            resultType: 'QueryData',
            data: { error: 'QueryData requires a query string' }
          };
        }
        if (queryLanguage === 'sparql') {
          const semanticClient = this.getSemanticQueryClient(parameters.semanticLayerRef as string | undefined);
          const result = await semanticClient.query({
            query,
            endpoint: parameters.semanticLayerRef as string | undefined,
            resultFormat: parameters.resultFormat as string | undefined,
            timeoutSeconds: parameters.timeoutSeconds as number | undefined
          });

          return {
            success: true,
            resultType: 'QueryData',
            resultRef: result.queryId,
            data: {
              queryId: result.queryId,
              status: { state: 'SUCCEEDED' },
              results: result.results,
              contentType: result.contentType
            },
            eventsEmitted: [
              { eventType: 'DataQueryExecuted', eventId: result.queryId, timestamp: now }
            ],
            contextChanged: false
          };
        }

        if (queryLanguage === 'sql') {
          const client = this.getDatabricksClient();
          const params: DatabricksSqlQueryRequest = {
            statement: query,
            warehouseId: parameters.warehouseId as string | undefined,
            catalog: parameters.catalog as string | undefined,
            schema: parameters.schema as string | undefined,
            waitTimeoutSeconds: parameters.waitTimeoutSeconds as number | undefined,
            timeoutSeconds: parameters.timeoutSeconds as number | undefined,
            maxRows: parameters.maxRows as number | undefined
          };

          const result = await client.executeStatement(params);
          const isFailure = result.status.state === 'FAILED' || result.status.state === 'CANCELED';
          const queryId = result.statementId;

          return {
            success: !isFailure,
            resultType: 'QueryData',
            resultRef: queryId,
            data: {
              queryId,
              status: result.status,
              manifest: result.manifest,
              results: result.result
            },
            eventsEmitted: [
              { eventType: 'DataQueryExecuted', eventId: queryId, timestamp: now }
            ],
            contextChanged: false
          };
        }

        return {
          success: false,
          resultType: 'QueryData',
          data: { error: `Unsupported queryLanguage: ${queryLanguageRaw ?? 'unknown'}` }
        };
      }

      // =========================================================================
      // Checkpoint Actions
      // =========================================================================

      case 'Checkpoint': {
        if (!context) {
          return {
            success: false,
            resultType: 'Checkpoint',
            data: { error: 'Context required for checkpoint' }
          };
        }

        const params: CreateCheckpointParams = {
          contextId: context.id,
          agentDID: context.agentDID,
          context: context,
          agentState: parameters.agentState as AgentCheckpointState ?? {
            taskQueue: [],
            completedTasks: [],
            workingMemory: parameters.workingMemory as Record<string, unknown> ?? {}
          },
          label: parameters.label as string | undefined,
          sign: parameters.sign as boolean | undefined,
          previousCheckpointId: parameters.previousCheckpointId as string | undefined
        };

        const result = await this.checkpointStore.createCheckpoint(params);

        if (!result.success) {
          return {
            success: false,
            resultType: 'Checkpoint',
            data: { error: result.error }
          };
        }

        return {
          success: true,
          resultType: 'Checkpoint',
          resultRef: result.checkpoint!.id,
          data: {
            checkpoint: {
              id: result.checkpoint!.id,
              contextGraphId: result.checkpoint!.contextGraphId,
              timestamp: result.checkpoint!.timestamp,
              label: result.checkpoint!.label
            } as CheckpointRef
          },
          stateChanges: [
            { resource: result.checkpoint!.id, changeType: 'created' }
          ],
          eventsEmitted: [
            { eventType: 'CheckpointCreated', eventId: result.traceId!, timestamp: now }
          ]
        };
      }

      case 'Resume': {
        const params: ResumeCheckpointParams = {
          checkpointId: parameters.checkpointId as string,
          verifyIntegrity: parameters.verifyIntegrity as boolean | undefined,
          verifySignature: parameters.verifySignature as boolean | undefined,
          mergeCurrentState: parameters.mergeCurrentState as AgentCheckpointState | undefined
        };

        const result = await this.checkpointStore.resumeFromCheckpoint(params);

        if (!result.success) {
          return {
            success: false,
            resultType: 'Resume',
            data: { error: result.error }
          };
        }

        // Store the resumed context
        if (result.context) {
          this.contexts.set(result.context.id, result.context);
        }

        return {
          success: true,
          resultType: 'Resume',
          resultRef: result.checkpoint!.id,
          data: {
            resumedContext: result.context,
            resumedAgentState: result.agentState,
            checkpointId: result.checkpoint!.id
          },
          stateChanges: [
            { resource: result.checkpoint!.id, changeType: 'resumed' }
          ],
          eventsEmitted: [
            { eventType: 'CheckpointResumed', eventId: result.traceId!, timestamp: now }
          ],
          contextChanged: true // Resume produces a new context
        };
      }

      default:
        return {
          success: false,
          resultType: affordance.actionType,
          data: { error: `Unknown infrastructure action: ${affordance.actionType}` }
        };
    }
  }

  /**
   * Clean up expired contexts
   */
  private cleanupExpiredContexts(): void {
    const now = new Date();
    for (const [id, context] of this.contexts.entries()) {
      if (new Date(context.expiresAt) < now) {
        this.contexts.delete(id);
      }
    }
  }

  /**
   * Get a stored context by ID (for testing)
   */
  getStoredContext(contextId: string): ContextGraph | undefined {
    return this.contexts.get(contextId);
  }
}
