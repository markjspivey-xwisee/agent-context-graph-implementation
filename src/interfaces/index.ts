/**
 * Core interfaces for the Agent Context Graph system
 * These interfaces define the contracts between system components
 */

// =============================================================================
// Context Graph Types
// =============================================================================

/** JSON-LD term definition - expanded form with @id, @type, @container, etc. */
export interface JsonLdTermDefinition {
  '@id': string;
  '@type'?: string;
  '@container'?: '@set' | '@list' | '@language' | '@index';
  '@vocab'?: string;
}

/** JSON-LD context entry - can be a URI string or a term mapping object */
export type JsonLdContextEntry = string | Record<string, string | JsonLdTermDefinition>;

export interface ContextGraph {
  /** JSON-LD context - URIs and/or term mappings for Hydra, ACG vocab, etc. */
  '@context': JsonLdContextEntry[];
  id: string;
  agentDID: string;
  agentType: string;
  timestamp: string;
  expiresAt: string;
  nonce: string;
  scope: Scope;
  verifiedCredentials: VerifiedCredentialRef[];
  constraints: Constraint[];
  affordances: Affordance[];
  tracePolicy: TracePolicy;
  /** Federation metadata for cross-broker contexts (maps to fed:* properties) */
  federation?: FederationInfo;
  /** Optional explicit hypergraph representation */
  hypergraph?: Hypergraph;
  /** Optional category-theoretic view */
  category?: ContextCategory;
  /** Reference to persistent knowledge graph */
  knowledgeGraphRef?: KnowledgeGraphRef;
  /** Optional lightweight knowledge graph snapshot */
  knowledgeGraphSnapshot?: KnowledgeGraphSnapshot;
  /**
   * Structural requirements from AAT behavioral invariants
   * Populated by broker based on agent's AAT spec
   */
  structuralRequirements?: {
    /** Action type that must be traversed before task completion */
    requiredOutputAction?: string;
  };
}

/**
 * Federation metadata for decentralized/federated deployments
 * Maps to fed:FederationInfo and related properties in federation.ttl
 */
export interface FederationInfo {
  type?: string;
  /** The broker that materialized this context (maps to fed:originBroker) */
  originBroker?: BrokerRef;
  /** DID of the trust domain this context belongs to (maps to fed:memberOfDomain) */
  trustDomain?: string;
  /** Other brokers whose resources are included (maps to fed:includesBroker) */
  federatedBrokers?: BrokerRef[];
  /** Trust level for remote affordances (maps to fed:hasTrustLevel) */
  trustLevel?: 'FullTrust' | 'LimitedTrust' | 'VerifyAlways';
  /** Maximum hops for cross-broker resolution (maps to fed:maxFederationHops) */
  maxFederationHops?: number;
  /** Credential bridges available for cross-domain auth (maps to fed:hasCredentialBridge) */
  credentialBridges?: CredentialBridge[];
}

/**
 * Credential bridge for cross-domain authentication
 */
export interface CredentialBridge {
  type?: string;
  id?: string;
  fromDomain: string;
  toDomain: string;
}

export interface Scope {
  domain: string;
  resources: string[];
  actions: string[];
}

export interface KnowledgeGraphRef {
  id: string;
  label?: string;
  version?: string;
  ontologyRefs?: string[];
  queryEndpoint?: string;
  updateEndpoint?: string;
  mappingsRef?: string;
}

export interface KnowledgeGraphSnapshot {
  graphId: string;
  version: string;
  lastUpdated: string;
  summary?: KnowledgeGraphSummary;
}

export interface KnowledgeGraphSummary {
  nodes?: number;
  edges?: number;
  datasets?: number;
  dataProducts?: number;
}

export interface VerifiedCredentialRef {
  id: string;
  type: string[];
  issuer: string;
  validUntil: string;
  credentialSubject: {
    id: string;
    capability: string;
    scope?: string[];
  };
}

export interface Constraint {
  type: 'deontic' | 'outcome' | 'temporal' | 'resource';
  rule: string;
  policyRef?: string;
  enforcementLevel: 'strict' | 'advisory' | 'audit-only';
}

export interface Affordance {
  /** JSON-LD type - maps to hydra:Operation + acg:Affordance */
  '@type'?: string[];
  id: string;
  /** Link relation (IANA or custom) */
  rel: string;
  relVersion: string;
  /** ACG action type (acg:actionType) */
  actionType: string;
  /** Target resource/endpoint */
  target: Target;
  /** Parameter schema - shaclRef maps to hydra:expects */
  params?: ParamsSchema;
  /** Required credentials (acg:requiresCredential - ACG extension) */
  requiresCredential?: CredentialRequirement[];
  /** Expected effects (acg:effects - supersets hydra:returns) */
  effects?: Effect[];
  /** Causal semantics (acg:causalSemantics - ACG extension) */
  causalSemantics?: CausalSemantics;
  /** Usage-based semantics (acg:usageSemantics - ACG extension) */
  usageSemantics?: UsageSemantics;
  /** Optional MCP tool mapping for this affordance */
  mcpMapping?: MCPToolMapping;
  preconditions?: string[];
  /** Whether affordance is currently available (acg:enabled) */
  enabled: boolean;
  disabledReason?: string;
}

export interface Target {
  type: 'HTTP' | 'DIDComm' | 'OID4VCI' | 'Internal' | 'EventEmit' | 'Federated' | 'broker';
  href?: string;
  method?: 'GET' | 'HEAD' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  didcommType?: string;
  serviceEndpoint?: string;
  /** For Federated targets: the remote broker hosting this affordance */
  remoteBroker?: BrokerRef;
  /** For Federated targets: whether credential bridging is required */
  requiresCrossdomainAuth?: boolean;
  /** For Federated targets: protocol to use for cross-broker communication */
  federationProtocol?: 'ActivityPub' | 'DIDComm' | 'LDN' | 'HTTP';
}

/**
 * Reference to a broker in the federation network
 */
export interface BrokerRef {
  type?: string;
  brokerDID: string;
  serviceEndpoint?: string;
  status?: 'Active' | 'Degraded' | 'Offline' | 'Untrusted';
  supportedDIDMethods?: ('did:key' | 'did:web' | 'did:dht' | 'did:plc' | 'did:peer')[];
  federationProtocols?: ('ActivityPub' | 'DIDComm' | 'LDN' | 'HTTP')[];
}

export interface ParamsSchema {
  /**
   * SHACL shape reference for parameter validation (maps to hydra:expects)
   * Points to a shape in the ontology, e.g., "https://agentcontextgraph.dev/shacl/params#EmitPlanParamsShape"
   * In JSON-LD, aliased to hydra:expects for Hydra compatibility
   */
  shaclRef: string;
  /**
   * Optional inline shape definition (for dynamic shapes)
   * If provided, this takes precedence over shaclRef
   */
  inlineShape?: string;
}

export interface CredentialRequirement {
  schema: string;
  issuer?: string;
}

/**
 * Effect types aligned with acg ontology (acg:Effect subclasses)
 * TypeScript uses short forms, JSON-LD examples use full RDF types like acg:ResourceCreateEffect
 */
export type EffectType =
  | 'state-change'      // acg:StateChangeEffect
  | 'event-emit'        // acg:EventEmitEffect
  | 'resource-create'   // acg:ResourceCreateEffect
  | 'resource-update'   // acg:ResourceUpdateEffect
  | 'resource-delete'   // acg:ResourceDeleteEffect
  | 'message-send';     // acg:MessageSendEffect

export interface Effect {
  /**
   * Effect type - can be short form (TypeScript) or RDF type (JSON-LD).
   * Short forms: 'state-change', 'event-emit', 'resource-create', etc.
   * RDF forms: 'acg:StateChangeEffect', 'acg:ResourceCreateEffect', etc.
   */
  type: EffectType | string;
  description: string;
  reversible: boolean;
}

export interface CausalSemantics {
  interventionLabel: string;
  outcomeVariables: string[];
  causalModelRef: string;
  evaluatorEndpoint?: string;
}

export interface TracePolicy {
  mustEmitProvActivity: boolean;
  retentionPeriod?: string;
  includeContextSnapshot: boolean;
  includeOutcomes: boolean;
}

// =============================================================================
// Hypergraph + Category Types
// =============================================================================

export interface Hypergraph {
  type?: string;
  nodes: Hypernode[];
  hyperedges: Hyperedge[];
}

export interface Hypernode {
  type?: string;
  id: string;
  kind?: string;
  ref?: string;
}

export interface Hyperedge {
  type?: string;
  id: string;
  relation?: string;
  affordanceRef?: string;
  connects: string[];
  roles?: Record<string, string | string[]>;
}

export interface ContextCategory {
  type?: string;
  objects?: CategoryObject[];
  morphisms?: Morphism[];
  composition?: Composition[];
}

export interface CategoryObject {
  type?: string;
  id: string;
  ref?: string;
}

export interface Morphism {
  type?: string;
  id: string;
  name?: string;
  domain: string[];
  codomain: string[];
  affordanceRef?: string;
  hyperedgeRef?: string;
}

export interface Composition {
  type?: string;
  of: string[];
  composite: string;
}

export interface UsageSemantics {
  type?: string;
  stability?: number;
  drift?: number;
  polysemy?: number;
  evidenceWindow?: string;
  lastObservedAt?: string;
  usageExamples?: string[];
  notes?: string;
}

export interface UsageEvent {
  usageRel: string;
  usageRelVersion?: string;
  usageActionType?: string;
  usageOutcomeStatus?: string;
  usageTimestamp?: string;
  contextId?: string;
  traceId?: string;
}

// =============================================================================
// PROV Trace Types
// =============================================================================

export interface ProvTrace {
  /** JSON-LD context - PROV-O, VC, ACG vocabularies */
  '@context': JsonLdContextEntry[];
  id: string;
  /** JSON-LD type - prov:Activity + ACG decision type */
  '@type': string[];
  /** PROV-O: agent association (prov:wasAssociatedWith) */
  wasAssociatedWith: AgentAssociation;
  /** PROV-O: inputs used by this activity (prov:used) */
  used: TraceInputs;
  /** PROV-O: outputs generated by this activity (prov:generated) */
  generated: TraceOutputs;
  /** ACG: causal intervention label */
  interventionLabel?: string;
  /** PROV-O: activity start time (xsd:dateTime) */
  startedAtTime: string;
  /** PROV-O: activity end time (xsd:dateTime) */
  endedAtTime: string;
  /** ACG: policy evaluation records */
  policyEvaluations?: PolicyEvaluation[];
  /** ACG: causal model evaluation */
  causalEvaluation?: CausalEvaluation;
  /** Usage telemetry event for semiotic analysis */
  usageEvent?: UsageEvent;
  signature?: Signature;
}

export interface AgentAssociation {
  agentDID: string;
  agentType: string;
  agentInstance?: string;
}

export interface TraceInputs {
  contextSnapshot: ContextSnapshot;
  affordance: AffordanceSnapshot;
  parameters: Record<string, unknown>;
  credentials: CredentialSnapshot[];
  knowledgeGraphRef?: KnowledgeGraphRef;
}

export interface ContextSnapshot {
  contextId: string;
  timestamp: string;
  nonce: string;
  agentDID: string;
  affordanceCount: number;
}

export interface AffordanceSnapshot {
  id: string;
  rel: string;
  relVersion: string;
  actionType: string;
  targetType: string;
  targetHref?: string;
}

export interface CredentialSnapshot {
  credentialId: string;
  credentialType: string[];
  issuer: string;
  validAt: string;
}

export interface TraceOutputs {
  outcome: Outcome;
  stateChanges?: StateChange[];
  eventsEmitted?: EventEmitted[];
  newContext?: NewContextRef;
  knowledgeGraphUpdate?: KnowledgeGraphUpdate;
}

export interface KnowledgeGraphUpdate {
  graphId: string;
  updateType: string;
  updateRef?: string;
}

export interface Outcome {
  status: 'success' | 'failure' | 'partial' | 'pending';
  resultType?: string;
  resultRef?: string;
}

export interface StateChange {
  resource: string;
  changeType: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
}

export interface EventEmitted {
  eventType: string;
  eventId: string;
  timestamp: string;
}

export interface NewContextRef {
  contextId: string;
  affordancesDelta: {
    added: string[];
    removed: string[];
  };
}

export interface PolicyEvaluation {
  policyRef: string;
  result: 'permit' | 'deny' | 'escalate';
  reason: string;
}

export interface CausalEvaluation {
  modelRef: string;
  predictedOutcomes: Record<string, unknown>;
  confidence: number;
}

export interface Signature {
  type: string;
  created: string;
  verificationMethod: string;
  proofValue: string;
}

// =============================================================================
// Abstract Agent Type
// =============================================================================

export interface AbstractAgentType {
  id: string;
  name: string;
  version: string;
  description: string;
  perceptSpace: PerceptSpace;
  actionSpace: ActionSpace;
  internalState: InternalStateSpec;
  behavioralInvariants: BehavioralInvariant[];
  traceRequirements: TraceRequirements;
  livenessGuarantees: LivenessGuarantee[];
  compositionRules: CompositionRules;
}

export interface PerceptSpace {
  description: string;
  types: PerceptType[];
}

export interface PerceptType {
  type: string;
  description: string;
}

export interface ActionSpace {
  allowed: ActionSpec[];
  forbidden: ActionSpec[];
}

export interface ActionSpec {
  type: string;
  id?: string;              // AAT action identifier (e.g., 'aat:EmitPlan')
  name?: string;            // Human-readable action name (e.g., 'EmitPlan')
  description: string;
  requiresCapability?: string | null;
  rationale?: string;
}

export interface InternalStateSpec {
  description: string;
  components: StateComponent[];
}

export interface StateComponent {
  name: string;
  description: string;
}

export interface BehavioralInvariant {
  id: string;
  description: string;
  formalRule: string;
  enforcement: 'structural' | 'validation' | 'audit' | 'design' | 'test';
  /**
   * If specified, this action type MUST be traversed before task completion.
   * Used for structural enforcement of output requirements.
   */
  requiredOutputAction?: string;
}

export interface TraceRequirements {
  mustEmitProvActivity: boolean;
  requiredFields: string[];
  retentionPolicy: string;
}

export interface LivenessGuarantee {
  id: string;
  description: string;
  formalRule: string;
}

export interface CompositionRules {
  canComposeBefore: string[];
  canComposeAfter: string[];
  notes: string;
  /**
   * Parallelization settings (Gas Town inspired)
   */
  parallelizable?: boolean;
  maxConcurrent?: number;
  requiresIsolation?: boolean;
  conflictsWith?: string[];
  preferredEnclaveScope?: string;
}

// =============================================================================
// Service Interfaces
// =============================================================================

/**
 * IVerifier - Interface for DID/VC verification
 */
export interface IVerifier {
  /**
   * Verify a DID proof of control
   */
  verifyDIDProof(did: string, proof: unknown): Promise<VerificationResult>;

  /**
   * Verify a Verifiable Credential
   */
  verifyVC(credential: unknown): Promise<VCVerificationResult>;

  /**
   * Verify a Verifiable Presentation
   */
  verifyVP(presentation: unknown): Promise<VPVerificationResult>;
}

export interface VerificationResult {
  valid: boolean;
  error?: string;
}

export interface VCVerificationResult extends VerificationResult {
  credentialType?: string[];
  issuer?: string;
  subject?: string;
  expirationDate?: string;
}

export interface VPVerificationResult extends VerificationResult {
  holder?: string;
  credentials?: VCVerificationResult[];
}

/**
 * ICausalEvaluator - Interface for causal model evaluation
 */
export interface ICausalEvaluator {
  /**
   * Evaluate causal model for predicted outcomes
   */
  evaluate(
    modelRef: string,
    intervention: string,
    context: Record<string, unknown>
  ): Promise<CausalEvaluationResult>;

  /**
   * Check if outcomes meet constraints
   */
  checkConstraints(
    outcomes: Record<string, unknown>,
    constraints: OutcomeConstraint[]
  ): Promise<ConstraintCheckResult>;
}

export interface CausalEvaluationResult {
  success: boolean;
  predictedOutcomes: Record<string, unknown>;
  confidence: number;
  error?: string;
}

export interface OutcomeConstraint {
  variable: string;
  operator: '<' | '>' | '<=' | '>=' | '==' | '!=';
  threshold: number | string;
}

export interface ConstraintCheckResult {
  allSatisfied: boolean;
  violations: ConstraintViolation[];
}

export interface ConstraintViolation {
  constraint: OutcomeConstraint;
  actualValue: unknown;
  message: string;
}

/**
 * IPolicyEngine - Interface for policy evaluation
 */
export interface IPolicyEngine {
  /**
   * Evaluate whether an action is permitted
   */
  evaluateAction(
    agentDID: string,
    actionType: string,
    context: PolicyContext
  ): Promise<PolicyDecision>;

  /**
   * Get active policies for an agent
   */
  getActivePolicies(agentDID: string): Promise<Policy[]>;
}

export interface PolicyContext {
  credentials: VerifiedCredentialRef[];
  constraints: Constraint[];
  targetResource?: string;
  parameters?: Record<string, unknown>;
}

export interface PolicyDecision {
  decision: 'permit' | 'deny' | 'escalate';
  reason: string;
  policyRef: string;
  obligations?: PolicyObligation[];
}

export interface PolicyObligation {
  type: string;
  parameters: Record<string, unknown>;
}

export interface Policy {
  id: string;
  type: 'deontic' | 'outcome';
  rule: string;
  appliesTo: string[];
}

/**
 * ITraceStore - Interface for trace storage
 */
export interface ITraceStore {
  /**
   * Store a PROV trace (append-only)
   */
  store(trace: ProvTrace): Promise<StoreResult>;

  /**
   * Retrieve traces by query
   */
  query(query: TraceQuery): Promise<ProvTrace[]>;

  /**
   * Get a specific trace by ID
   */
  getById(traceId: string): Promise<ProvTrace | null>;
}

export interface StoreResult {
  success: boolean;
  traceId: string;
  error?: string;
}

export interface TraceQuery {
  agentDID?: string;
  actionType?: string;
  fromTime?: string;
  toTime?: string;
  limit?: number;
  offset?: number;
}

/**
 * IAATRegistry - Interface for AAT management
 */
export interface IAATRegistry {
  /**
   * Get an AAT by ID
   */
  getAAT(aatId: string): Promise<AbstractAgentType | null>;

  /**
   * Check if an action type is allowed for an AAT
   */
  isActionAllowed(aatId: string, actionType: string): Promise<boolean>;

  /**
   * Check if an action type is forbidden for an AAT
   */
  isActionForbidden(aatId: string, actionType: string): Promise<boolean>;

  /**
   * Get required capabilities for an action
   */
  getRequiredCapability(aatId: string, actionType: string): Promise<string | null>;

  /**
   * Get required output action from behavioral invariants
   * Returns the action type that must be traversed before task completion
   */
  getRequiredOutputAction(aatId: string): Promise<string | null>;

  /**
   * Get parallelization rules for an AAT
   */
  getParallelizationRules(aatId: string): Promise<ParallelizationRules | null>;
}

// =============================================================================
// Concurrency & Parallelization (Gas Town inspired)
// =============================================================================

/**
 * Parallelization rules from AAT spec
 */
export interface ParallelizationRules {
  parallelizable: boolean;
  maxConcurrent: number;
  requiresIsolation: boolean;
  conflictsWith: string[];
  preferredEnclaveScope?: string;
}

/**
 * Concurrency policy governing parallel agent execution
 */
export interface ConcurrencyPolicy {
  /** Maximum total agents running at once */
  maxTotalAgents: number;
  /** Maximum agents per type */
  maxPerType: Record<string, number>;
  /** Agent types that conflict (can't run together) */
  conflictMatrix: Record<string, string[]>;
  /** Resource limits to prevent Gas Town's $100/hr problem */
  resourceLimits: ResourceLimits;
}

/**
 * Resource limits for cost control
 */
export interface ResourceLimits {
  /** Maximum tokens per minute across all agents */
  maxTokensPerMinute: number;
  /** Maximum cost per hour in dollars */
  maxCostPerHour: number;
  /** Maximum concurrent API calls */
  maxConcurrentAPICalls: number;
}

/**
 * Execution enclave reference in context
 */
export interface EnclaveRef {
  id: string;
  worktreePath: string;
  status: 'active' | 'sealed' | 'destroyed';
  boundAgentDID: string;
}

/**
 * Checkpoint reference in context
 */
export interface CheckpointRef {
  id: string;
  contextGraphId: string;
  timestamp: string;
  label?: string;
}

// =============================================================================
// Identity Types (WebID + DID Bridging)
// =============================================================================

/**
 * Agent Identity - can be either DID-based or WebID-based
 */
export type AgentIdentity = DIDIdentity | WebIDIdentity;

/**
 * DID-based identity
 */
export interface DIDIdentity {
  type: 'DID';
  /** The full DID string (e.g., 'did:web:example.com:agent:123') */
  didString: string;
  /** The DID method (e.g., 'web', 'key', 'dht', 'plc') */
  didMethod: 'web' | 'key' | 'dht' | 'plc' | 'peer' | string;
  /** Verification methods for this identity */
  verificationMethods?: VerificationMethod[];
  /** Reference to the DID Document */
  didDocumentUri?: string;
}

/**
 * WebID-based identity (Solid/Linked Data compatible)
 */
export interface WebIDIdentity {
  type: 'WebID';
  /** The WebID URI (e.g., 'https://example.com/profile/agent#me') */
  webIdUri: string;
  /** Reference to the RDF profile document */
  profileUri?: string;
  /** Solid storage locations (Pods) */
  storage?: string[];
  /** Trusted OIDC issuers */
  oidcIssuers?: string[];
  /** Verification methods for this identity */
  verificationMethods?: VerificationMethod[];
}

/**
 * Verification method for cryptographic proofs
 */
export interface VerificationMethod {
  id: string;
  type: 'Ed25519VerificationKey2020' | 'JsonWebKey2020' | 'RSAPublicKey' | string;
  controller: string;
  publicKeyPem?: string;
  publicKeyJwk?: Record<string, unknown>;
  publicKeyMultibase?: string;
}

/**
 * Identity bridge linking DID and WebID identities
 */
export interface IdentityBridge {
  id: string;
  /** The DID identity */
  didIdentity: DIDIdentity;
  /** The WebID identity */
  webIdIdentity: WebIDIdentity;
  /** Type of proof linking the identities */
  proofType: 'LinkedDataSignature' | 'JWTProof' | string;
  /** The cryptographic proof value */
  proofValue: string;
  /** When the bridge was created */
  created: string;
  /** When the bridge expires (optional) */
  expires?: string;
}

// =============================================================================
// Data Space Types
// =============================================================================

/**
 * Data Space - user/agent-controlled storage location
 */
export interface DataSpace {
  id: string;
  /** The identity that owns this data space */
  owner: string;
  /** Type of data space */
  type: 'Personal' | 'Agent' | 'Organizational' | 'Shared';
  /** HTTP endpoint for accessing this data space */
  storageEndpoint: string;
  /** Optional SPARQL endpoint for queries */
  sparqlEndpoint?: string;
  /** Type of access control */
  accessControl: 'WebACL' | 'ODRL' | 'ACG-Policy' | 'Capability';
  /** Container paths within the data space */
  containers?: DataSpaceContainers;
  /** Storage quota in bytes */
  quotaBytes?: number;
  /** Current usage in bytes */
  usedBytes?: number;
  /** Data retention policy */
  retentionPolicy?: string;
  /** Whether encryption at rest is enabled */
  encryptionEnabled?: boolean;
  /** Storage provider info */
  provider?: StorageProvider;
}

/**
 * Standard container paths in a data space
 */
export interface DataSpaceContainers {
  /** Container for context graphs */
  contexts?: string;
  /** Container for provenance traces */
  traces?: string;
  /** Container for credentials */
  credentials?: string;
  /** Container for policies */
  policies?: string;
  /** Container for agent state */
  state?: string;
}

/**
 * Storage provider hosting data spaces
 */
export interface StorageProvider {
  name: string;
  endpoint: string;
  type: 'SelfHosted' | 'CloudHosted' | 'Federated' | 'SolidPod';
}

// =============================================================================
// Protocol Interoperability Types (MCP, A2A, ODRL)
// =============================================================================

/**
 * MCP (Model Context Protocol) tool mapping for an affordance
 */
export interface MCPToolMapping {
  /** MCP tool name */
  toolName: string;
  /** Human-readable description for LLM understanding */
  description: string;
  /** JSON Schema for input parameters */
  inputSchema?: Record<string, unknown>;
  /** JSON Schema for output */
  outputSchema?: Record<string, unknown>;
}

/**
 * A2A (Agent-to-Agent) capability mapping for an affordance
 */
export interface A2ACapabilityMapping {
  /** A2A capability identifier */
  capabilityId: string;
  /** Human-readable name */
  name: string;
  /** Supported input modes */
  inputModes?: ('text' | 'file' | 'data')[];
  /** Supported output modes */
  outputModes?: ('text' | 'file' | 'data')[];
}

/**
 * ODRL-aligned policy for ACG
 */
export interface ODRLPolicy {
  '@context'?: string | string[];
  '@type': 'odrl:Policy' | 'odrl:Set' | 'odrl:Offer' | 'odrl:Agreement';
  uid: string;
  /** Permissions granted by this policy */
  permissions?: ODRLPermission[];
  /** Prohibitions defined by this policy */
  prohibitions?: ODRLProhibition[];
  /** Obligations/duties required by this policy */
  obligations?: ODRLObligation[];
}

/**
 * ODRL Permission
 */
export interface ODRLPermission {
  target: string;
  action: string | string[];
  assignee?: string;
  assigner?: string;
  constraints?: ODRLConstraint[];
  duties?: ODRLObligation[];
}

/**
 * ODRL Prohibition
 */
export interface ODRLProhibition {
  target: string;
  action: string | string[];
  assignee?: string;
  assigner?: string;
  constraints?: ODRLConstraint[];
  remedy?: ODRLObligation[];
}

/**
 * ODRL Obligation/Duty
 */
export interface ODRLObligation {
  action: string | string[];
  target?: string;
  assignee?: string;
  assigner?: string;
  constraints?: ODRLConstraint[];
  consequence?: ODRLObligation[];
}

/**
 * ODRL Constraint
 */
export interface ODRLConstraint {
  leftOperand: string;
  operator: 'eq' | 'neq' | 'lt' | 'lteq' | 'gt' | 'gteq' | 'isA' | 'isPartOf' | 'isAllOf' | 'isAnyOf' | 'isNoneOf' | string;
  rightOperand: string | number | boolean;
  unit?: string;
}

/**
 * ACG Causal Constraint extension for ODRL
 */
export interface CausalConstraint extends ODRLConstraint {
  leftOperand: 'causalModel' | 'predictedOutcome';
  /** Reference to the causal model */
  causalModelRef?: string;
  /** Minimum confidence required */
  confidenceThreshold?: number;
}

/**
 * Interoperability configuration for a context or broker
 */
export interface InteropConfig {
  /** MCP protocol configuration */
  mcp?: {
    enabled: boolean;
    serverEndpoint?: string;
  };
  /** A2A protocol configuration */
  a2a?: {
    enabled: boolean;
    agentCardEndpoint?: string;
  };
  /** ODRL policy configuration */
  odrl?: {
    enabled: boolean;
    enforcement: 'strict' | 'advisory' | 'audit';
  };
}

// =============================================================================
// Extended Affordance with Interop Mappings
// =============================================================================

/**
 * Extended affordance interface with interop mappings
 */
export interface AffordanceWithInterop extends Affordance {
  /** MCP tool mapping for this affordance */
  mcpMapping?: MCPToolMapping;
  /** A2A capability mapping for this affordance */
  a2aMapping?: A2ACapabilityMapping;
  /** Schema.org action type alignment */
  schemaActionType?: string;
}

// =============================================================================
// Extended Context Graph with New Features
// =============================================================================

/**
 * Extended context graph with identity, data space, and interop support
 */
export interface ExtendedContextGraph extends ContextGraph {
  /** Agent identities (supports both DID and WebID) */
  agentIdentities?: AgentIdentity[];
  /** Primary data space for this agent */
  dataSpace?: DataSpace;
  /** Interoperability configuration */
  interop?: InteropConfig;
  /** ODRL policies governing this context */
  odrlPolicies?: ODRLPolicy[];
}

// =============================================================================
// Personal Broker Types (re-exported from service)
// =============================================================================

export type {
  MessageRole,
  ConversationStatus,
  ChannelType,
  ChannelStatus,
  MemoryType,
  RoutineTrigger,
  ToolCategory,
  ContactStatus,
  ContactTrustLevel,
  ParticipantRole,
  PresenceStatus,
  Message as PBMessage,
  Conversation as PBConversation,
  Channel as PBChannel,
  MemoryEntry,
  Routine,
  Tool as PBTool,
  Contact,
  Group,
  SharedWorkflow,
  WorkflowParticipant,
  Presence,
  PersonalBrokerConfig
} from '../services/personal-broker.js';

// =============================================================================
// Channel Bridge Types (re-exported from service)
// =============================================================================

export type {
  PlatformCapability,
  AuthenticationMethod,
  ConnectionStatus,
  PlatformDefinition,
  BridgeConnection,
  InboundPlatformMessage,
  OutboundPlatformMessage,
  PlatformAttachment,
  MessageTransform,
  RateLimiterConfig
} from '../services/channel-bridge.js';

// =============================================================================
// Social Federation Types (re-exported from service)
// =============================================================================

export type {
  ConnectionState,
  ProfileVisibility,
  FederationProtocol,
  DiscoveryMethod,
  GroupRole,
  NotificationType,
  SocialConnection,
  ConnectionRequest,
  SocialProfile,
  InviteLink,
  SocialNotification,
  Presence as SocialPresence,
  SocialGroup,
  GroupMembership,
  WorkflowInvitation,
  FederationMessage
} from '../services/social-federation.js';

// =============================================================================
// Shared Context Types (re-exported from service)
// =============================================================================

export type {
  SyncStrategy,
  ConflictResolution,
  ChangeType,
  ConflictStatus,
  AccessLevel,
  PresenceState,
  SharedContext,
  VectorClock,
  AccessEntry,
  ContextGraph as SharedContextGraph,
  ContextNode,
  ContextEdge,
  ContextReplica,
  ReplicaPresence,
  CursorPosition,
  SelectionRange,
  ViewportBounds,
  ContextChange,
  CRDTOperation,
  ContextConflict,
  ConflictResolutionResult,
  SharedContextConfig,
  SyncMessage
} from '../services/shared-context.js';

// =============================================================================
// Real-time Sync Types (re-exported from service)
// =============================================================================

export type {
  MessageType as WSMessageType,
  WSMessage,
  AuthPayload,
  SubscribePayload,
  ContextChangePayload,
  PresenceUpdatePayload,
  NotificationPayload,
  ClientInfo
} from '../services/realtime-sync.js';
