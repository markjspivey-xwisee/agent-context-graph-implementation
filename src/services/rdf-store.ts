import { Store, DataFactory, Writer, Parser, Quad } from 'n3';
import type { ProvTrace, TraceQuery, ITraceStore, StoreResult, TraceOutputs, Outcome } from '../interfaces/index.js';

const { namedNode, literal, quad } = DataFactory;

// RDF namespace prefixes
const PREFIXES = {
  rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
  rdfs: 'http://www.w3.org/2000/01/rdf-schema#',
  xsd: 'http://www.w3.org/2001/XMLSchema#',
  prov: 'http://www.w3.org/ns/prov#',
  acg: 'https://agentcontextgraph.dev/ontology#',
  aat: 'https://agentcontextgraph.dev/aat#',
  trace: 'https://agentcontextgraph.dev/trace/',
  did: 'https://w3id.org/did#'
};

/**
 * RDF-native triplestore using N3.js
 * Stores PROV traces as actual RDF quads, not JSON blobs
 */
export class RDFStore implements ITraceStore {
  private n3Store: Store;
  private traceIds: Set<string> = new Set();

  constructor() {
    this.n3Store = new Store();
  }

  /**
   * Store a PROV trace as RDF quads
   */
  async store(trace: ProvTrace): Promise<StoreResult> {
    if (!trace.id) {
      return { success: false, traceId: '', error: 'Trace must have an ID' };
    }

    // Check for duplicate (append-only)
    if (this.traceIds.has(trace.id)) {
      return { success: false, traceId: trace.id, error: 'Trace already exists (append-only)' };
    }

    try {
      const traceNode = namedNode(trace.id);
      const graph = namedNode(`${PREFIXES.trace}${trace.id.replace(/[^a-zA-Z0-9]/g, '_')}`);

      // Type assertions
      this.addQuad(traceNode, 'rdf:type', 'prov:Activity', graph);
      this.addQuad(traceNode, 'rdf:type', 'acg:AgentAction', graph);

      // Core PROV properties
      this.addQuadLiteral(traceNode, 'prov:startedAtTime', trace.startedAtTime, 'xsd:dateTime', graph);
      if (trace.endedAtTime) {
        this.addQuadLiteral(traceNode, 'prov:endedAtTime', trace.endedAtTime, 'xsd:dateTime', graph);
      }

      // Agent association (prov:wasAssociatedWith)
      const agentNode = namedNode(trace.wasAssociatedWith.agentDID);
      this.addQuad(traceNode, 'prov:wasAssociatedWith', agentNode, graph);
      this.addQuad(agentNode, 'rdf:type', 'prov:Agent', graph);
      this.addQuadLiteral(agentNode, 'acg:agentDID', trace.wasAssociatedWith.agentDID, 'xsd:string', graph);
      this.addQuadLiteral(agentNode, 'acg:agentType', trace.wasAssociatedWith.agentType, 'xsd:string', graph);

      // Used context (prov:used)
      const usedNode = namedNode(`${trace.id}#used`);
      this.addQuad(traceNode, 'prov:used', usedNode, graph);

      // Context snapshot
      if (trace.used.contextSnapshot) {
        this.addQuadLiteral(usedNode, 'acg:contextId', trace.used.contextSnapshot.contextId, 'xsd:string', graph);
        this.addQuadLiteral(usedNode, 'acg:timestamp', trace.used.contextSnapshot.timestamp, 'xsd:dateTime', graph);
      }

      // Affordance reference
      const affNode = namedNode(`${trace.id}#affordance`);
      this.addQuad(usedNode, 'acg:affordance', affNode, graph);
      this.addQuadLiteral(affNode, 'acg:id', trace.used.affordance.id, 'xsd:string', graph);
      this.addQuadLiteral(affNode, 'acg:actionType', trace.used.affordance.actionType, 'xsd:string', graph);
      this.addQuadLiteral(affNode, 'acg:rel', trace.used.affordance.rel, 'xsd:string', graph);
      this.addQuadLiteral(affNode, 'acg:targetType', trace.used.affordance.targetType, 'xsd:string', graph);

      // Generated outcome (prov:generated)
      if (trace.generated) {
        const genNode = namedNode(`${trace.id}#generated`);
        this.addQuad(traceNode, 'prov:generated', genNode, graph);

        if (trace.generated.outcome) {
          this.addQuadLiteral(genNode, 'acg:outcomeStatus', trace.generated.outcome.status, 'xsd:string', graph);
          if (trace.generated.outcome.resultType) {
            this.addQuadLiteral(genNode, 'acg:resultType', trace.generated.outcome.resultType, 'xsd:string', graph);
          }
        }

        if (trace.generated.stateChanges) {
          for (const change of trace.generated.stateChanges) {
            this.addQuadLiteral(genNode, 'acg:stateChange', JSON.stringify(change), 'xsd:string', graph);
          }
        }

        if (trace.generated.eventsEmitted) {
          for (const event of trace.generated.eventsEmitted) {
            this.addQuadLiteral(genNode, 'acg:eventEmitted', JSON.stringify(event), 'xsd:string', graph);
          }
        }
      }

      // Usage telemetry (emergent semiotics)
      if (trace.usageEvent) {
        const usageNode = namedNode(`${trace.id}#usage`);
        this.addQuad(traceNode, 'acg:hasUsageEvent', usageNode, graph);
        this.addQuadLiteral(usageNode, 'acg:usageRel', trace.usageEvent.usageRel, 'xsd:string', graph);
        if (trace.usageEvent.usageRelVersion) {
          this.addQuadLiteral(usageNode, 'acg:usageRelVersion', trace.usageEvent.usageRelVersion, 'xsd:string', graph);
        }
        if (trace.usageEvent.usageActionType) {
          this.addQuadLiteral(usageNode, 'acg:usageActionType', trace.usageEvent.usageActionType, 'xsd:string', graph);
        }
        if (trace.usageEvent.usageOutcomeStatus) {
          this.addQuadLiteral(usageNode, 'acg:usageOutcomeStatus', trace.usageEvent.usageOutcomeStatus, 'xsd:string', graph);
        }
        if (trace.usageEvent.usageTimestamp) {
          this.addQuadLiteral(usageNode, 'acg:usageTimestamp', trace.usageEvent.usageTimestamp, 'xsd:dateTime', graph);
        }
        if (trace.usageEvent.contextId) {
          this.addQuadLiteral(usageNode, 'acg:contextId', trace.usageEvent.contextId, 'xsd:string', graph);
        }
      }

      // Intervention label (causal do())
      if (trace.interventionLabel) {
        this.addQuadLiteral(traceNode, 'acg:interventionLabel', trace.interventionLabel, 'xsd:string', graph);
      }

      this.traceIds.add(trace.id);
      return { success: true, traceId: trace.id };

    } catch (error) {
      return {
        success: false,
        traceId: trace.id,
        error: `Failed to store trace: ${(error as Error).message}`
      };
    }
  }

  /**
   * Query traces using SPARQL-like patterns
   */
  async query(query: TraceQuery): Promise<ProvTrace[]> {
    const limit = query.limit ?? 100;
    const offset = query.offset ?? 0;

    // Get all trace IDs and filter
    const matchingTraces: ProvTrace[] = [];

    for (const traceId of this.traceIds) {
      const trace = await this.getById(traceId);
      if (!trace) continue;

      // Filter by agentDID
      if (query.agentDID && trace.wasAssociatedWith.agentDID !== query.agentDID) {
        continue;
      }

      // Filter by actionType
      if (query.actionType && trace.used.affordance.actionType !== query.actionType) {
        continue;
      }

      // Filter by time range
      if (query.fromTime && trace.startedAtTime < query.fromTime) {
        continue;
      }
      if (query.toTime && trace.startedAtTime > query.toTime) {
        continue;
      }

      matchingTraces.push(trace);
    }

    // Sort by startedAtTime descending and apply pagination
    matchingTraces.sort((a, b) =>
      new Date(b.startedAtTime).getTime() - new Date(a.startedAtTime).getTime()
    );

    return matchingTraces.slice(offset, offset + limit);
  }

  /**
   * Get a trace by ID
   */
  async getById(traceId: string): Promise<ProvTrace | null> {
    if (!this.traceIds.has(traceId)) {
      return null;
    }
    return this.reconstructTrace(traceId);
  }

  /**
   * Execute a SPARQL query
   */
  sparqlQuery(sparqlQuery: string): SparqlResult {
    // Parse the SPARQL query to extract patterns
    const selectMatch = sparqlQuery.match(/SELECT\s+([\s\S]*?)\s+WHERE/i);
    const whereMatch = sparqlQuery.match(/WHERE\s*\{([\s\S]*?)\}/i);
    const limitMatch = sparqlQuery.match(/LIMIT\s+(\d+)/i);
    const offsetMatch = sparqlQuery.match(/OFFSET\s+(\d+)/i);

    if (!selectMatch || !whereMatch) {
      return { success: false, error: 'Invalid SPARQL query', bindings: [] };
    }

    const variables = selectMatch[1].trim().split(/\s+/).map(v => v.replace('?', ''));
    const patterns = this.parseWhereClause(whereMatch[1]);
    const limit = limitMatch ? parseInt(limitMatch[1]) : 100;
    const offset = offsetMatch ? parseInt(offsetMatch[1]) : 0;

    // Execute pattern matching
    const bindings = this.matchPatterns(patterns, variables);

    // Apply pagination
    const paginatedBindings = bindings.slice(offset, offset + limit);

    return {
      success: true,
      variables,
      bindings: paginatedBindings
    };
  }

  /**
   * Get all quads (for export/debugging)
   */
  getAllQuads(): Quad[] {
    return this.n3Store.getQuads(null, null, null, null);
  }

  /**
   * Export all traces as Turtle
   */
  exportTurtle(): string {
    const writer = new Writer({ prefixes: PREFIXES });

    for (const quadItem of this.n3Store.getQuads(null, null, null, null)) {
      writer.addQuad(quadItem);
    }

    let result = '';
    writer.end((_error, output) => {
      result = output;
    });

    return result;
  }

  /**
   * Import traces from Turtle
   */
  async importTurtle(turtle: string): Promise<{ imported: number; errors: string[] }> {
    const parser = new Parser({ baseIRI: PREFIXES.trace });
    const errors: string[] = [];
    let imported = 0;

    return new Promise((resolve) => {
      parser.parse(turtle, (error, quadItem) => {
        if (error) {
          errors.push(error.message);
          return;
        }
        if (quadItem) {
          this.n3Store.addQuad(quadItem);
          imported++;
        } else {
          // End of parsing - extract trace IDs
          this.extractTraceIds();
          resolve({ imported, errors });
        }
      });
    });
  }

  /**
   * Get store statistics
   */
  getStats(): { quads: number; traces: number; agents: number; graphs: number } {
    const graphs = new Set<string>();
    const agents = new Set<string>();

    for (const quadItem of this.n3Store.getQuads(null, null, null, null)) {
      if (quadItem.graph.value) {
        graphs.add(quadItem.graph.value);
      }
    }

    // Count unique agents
    for (const quadItem of this.n3Store.getQuads(null, namedNode(PREFIXES.prov + 'wasAssociatedWith'), null, null)) {
      agents.add(quadItem.object.value);
    }

    return {
      quads: this.n3Store.size,
      traces: this.traceIds.size,
      agents: agents.size,
      graphs: graphs.size
    };
  }

  /**
   * Clear all data
   */
  clear(): void {
    this.n3Store = new Store();
    this.traceIds.clear();
  }

  // ===========================================
  // Private helper methods
  // ===========================================

  private addQuad(
    subject: ReturnType<typeof namedNode>,
    predicateUri: string,
    objectUri: string | ReturnType<typeof namedNode>,
    graph: ReturnType<typeof namedNode>
  ): void {
    const predicate = this.expandUri(predicateUri);
    const object = typeof objectUri === 'string' ? namedNode(this.expandUri(objectUri)) : objectUri;
    this.n3Store.addQuad(quad(subject, namedNode(predicate), object, graph));
  }

  private addQuadLiteral(
    subject: ReturnType<typeof namedNode>,
    predicateUri: string,
    value: string,
    datatype: string,
    graph: ReturnType<typeof namedNode>
  ): void {
    const predicate = this.expandUri(predicateUri);
    const datatypeNode = namedNode(this.expandUri(datatype));
    this.n3Store.addQuad(quad(subject, namedNode(predicate), literal(value, datatypeNode), graph));
  }

  private expandUri(prefixedUri: string): string {
    const [prefix, localName] = prefixedUri.split(':');
    if (PREFIXES[prefix as keyof typeof PREFIXES]) {
      return PREFIXES[prefix as keyof typeof PREFIXES] + localName;
    }
    return prefixedUri;
  }

  private reconstructTrace(traceId: string): ProvTrace | null {
    const traceNode = namedNode(traceId);

    // Find the graph for this trace
    const graphs = this.n3Store.getQuads(traceNode, null, null, null);
    if (graphs.length === 0) return null;

    const graph = graphs[0].graph;

    // Get startedAtTime
    const startedQuads = this.n3Store.getQuads(
      traceNode,
      namedNode(PREFIXES.prov + 'startedAtTime'),
      null,
      graph
    );
    if (startedQuads.length === 0) return null;
    const startedAtTime = startedQuads[0].object.value;

    // Get endedAtTime
    const endedQuads = this.n3Store.getQuads(
      traceNode,
      namedNode(PREFIXES.prov + 'endedAtTime'),
      null,
      graph
    );
    const endedAtTime = endedQuads.length > 0 ? endedQuads[0].object.value : startedAtTime;

    // Get agent association
    const agentQuads = this.n3Store.getQuads(
      traceNode,
      namedNode(PREFIXES.prov + 'wasAssociatedWith'),
      null,
      graph
    );
    if (agentQuads.length === 0) return null;
    const agentNode = agentQuads[0].object;

    const agentDIDQuads = this.n3Store.getQuads(
      agentNode,
      namedNode(PREFIXES.acg + 'agentDID'),
      null,
      graph
    );
    const agentTypeQuads = this.n3Store.getQuads(
      agentNode,
      namedNode(PREFIXES.acg + 'agentType'),
      null,
      graph
    );

    // Get used context
    const usedQuads = this.n3Store.getQuads(
      traceNode,
      namedNode(PREFIXES.prov + 'used'),
      null,
      graph
    );
    if (usedQuads.length === 0) return null;
    const usedNode = usedQuads[0].object;

    const contextIdQuads = this.n3Store.getQuads(
      usedNode,
      namedNode(PREFIXES.acg + 'contextId'),
      null,
      graph
    );
    const timestampQuads = this.n3Store.getQuads(
      usedNode,
      namedNode(PREFIXES.acg + 'timestamp'),
      null,
      graph
    );

    // Get affordance
    const affQuads = this.n3Store.getQuads(
      usedNode,
      namedNode(PREFIXES.acg + 'affordance'),
      null,
      graph
    );
    const affNode = affQuads.length > 0 ? affQuads[0].object : null;

    let affordanceId = '';
    let actionType = '';
    let rel = '';
    let targetType = '';

    if (affNode) {
      const affIdQuads = this.n3Store.getQuads(affNode, namedNode(PREFIXES.acg + 'id'), null, graph);
      const actionTypeQuads = this.n3Store.getQuads(affNode, namedNode(PREFIXES.acg + 'actionType'), null, graph);
      const relQuads = this.n3Store.getQuads(affNode, namedNode(PREFIXES.acg + 'rel'), null, graph);
      const targetTypeQuads = this.n3Store.getQuads(affNode, namedNode(PREFIXES.acg + 'targetType'), null, graph);
      affordanceId = affIdQuads.length > 0 ? affIdQuads[0].object.value : '';
      actionType = actionTypeQuads.length > 0 ? actionTypeQuads[0].object.value : '';
      rel = relQuads.length > 0 ? relQuads[0].object.value : 'self';
      targetType = targetTypeQuads.length > 0 ? targetTypeQuads[0].object.value : 'Internal';
    }

    // Get generated outcome
    const genQuads = this.n3Store.getQuads(
      traceNode,
      namedNode(PREFIXES.prov + 'generated'),
      null,
      graph
    );

    let generated: TraceOutputs = {
      outcome: { status: 'success' }
    };

    if (genQuads.length > 0) {
      const genNode = genQuads[0].object;
      const outcomeStatusQuads = this.n3Store.getQuads(genNode, namedNode(PREFIXES.acg + 'outcomeStatus'), null, graph);
      const resultTypeQuads = this.n3Store.getQuads(genNode, namedNode(PREFIXES.acg + 'resultType'), null, graph);

      const outcome: Outcome = {
        status: (outcomeStatusQuads.length > 0 ? outcomeStatusQuads[0].object.value : 'success') as Outcome['status']
      };
      if (resultTypeQuads.length > 0) {
        outcome.resultType = resultTypeQuads[0].object.value;
      }

      generated = { outcome };
    }

    // Get intervention label
    const interventionQuads = this.n3Store.getQuads(
      traceNode,
      namedNode(PREFIXES.acg + 'interventionLabel'),
      null,
      graph
    );
    const interventionLabel = interventionQuads.length > 0 ? interventionQuads[0].object.value : undefined;

    // Get usage telemetry
    let usageEvent;
    const usageQuads = this.n3Store.getQuads(
      traceNode,
      namedNode(PREFIXES.acg + 'hasUsageEvent'),
      null,
      graph
    );
    if (usageQuads.length > 0) {
      const usageNode = usageQuads[0].object;
      const usageRelQuads = this.n3Store.getQuads(usageNode, namedNode(PREFIXES.acg + 'usageRel'), null, graph);
      const usageRelVersionQuads = this.n3Store.getQuads(usageNode, namedNode(PREFIXES.acg + 'usageRelVersion'), null, graph);
      const usageActionTypeQuads = this.n3Store.getQuads(usageNode, namedNode(PREFIXES.acg + 'usageActionType'), null, graph);
      const usageOutcomeStatusQuads = this.n3Store.getQuads(usageNode, namedNode(PREFIXES.acg + 'usageOutcomeStatus'), null, graph);
      const usageTimestampQuads = this.n3Store.getQuads(usageNode, namedNode(PREFIXES.acg + 'usageTimestamp'), null, graph);
      const usageContextIdQuads = this.n3Store.getQuads(usageNode, namedNode(PREFIXES.acg + 'contextId'), null, graph);

      const usageRel = usageRelQuads.length > 0 ? usageRelQuads[0].object.value : '';
      if (usageRel) {
        usageEvent = {
          usageRel,
          usageRelVersion: usageRelVersionQuads.length > 0 ? usageRelVersionQuads[0].object.value : undefined,
          usageActionType: usageActionTypeQuads.length > 0 ? usageActionTypeQuads[0].object.value : undefined,
          usageOutcomeStatus: usageOutcomeStatusQuads.length > 0 ? usageOutcomeStatusQuads[0].object.value : undefined,
          usageTimestamp: usageTimestampQuads.length > 0 ? usageTimestampQuads[0].object.value : undefined,
          contextId: usageContextIdQuads.length > 0 ? usageContextIdQuads[0].object.value : undefined,
          traceId
        };
      }
    }

    const agentDID = agentDIDQuads.length > 0 ? agentDIDQuads[0].object.value : agentNode.value;

    return {
      '@context': ['https://www.w3.org/ns/prov-o', 'https://agentcontextgraph.dev/ontology'],
      '@type': ['prov:Activity', 'acg:AgentAction'],
      id: traceId,
      startedAtTime,
      endedAtTime,
      wasAssociatedWith: {
        agentDID,
        agentType: agentTypeQuads.length > 0 ? agentTypeQuads[0].object.value : 'unknown'
      },
      used: {
        contextSnapshot: {
          contextId: contextIdQuads.length > 0 ? contextIdQuads[0].object.value : '',
          timestamp: timestampQuads.length > 0 ? timestampQuads[0].object.value : startedAtTime,
          nonce: '',
          agentDID,
          affordanceCount: 1
        },
        affordance: {
          id: affordanceId,
          rel,
          relVersion: '1.0',
          actionType,
          targetType
        },
        parameters: {},
        credentials: []
      },
      generated,
      interventionLabel,
      usageEvent
    };
  }

  private parseWhereClause(whereClause: string): TriplePattern[] {
    const patterns: TriplePattern[] = [];
    const tripleRegex = /\?(\w+)\s+(\S+)\s+(\??\S+)\s*\./g;

    let match;
    while ((match = tripleRegex.exec(whereClause)) !== null) {
      patterns.push({
        subject: { variable: match[1] },
        predicate: this.expandUri(match[2]),
        object: match[3].startsWith('?')
          ? { variable: match[3].slice(1) }
          : { value: this.expandUri(match[3]) }
      });
    }

    return patterns;
  }

  private matchPatterns(
    patterns: TriplePattern[],
    variables: string[]
  ): Array<Record<string, string>> {
    if (patterns.length === 0) return [];

    let bindings: Array<Record<string, string>> = [{}];

    for (const pattern of patterns) {
      const newBindings: Array<Record<string, string>> = [];

      for (const binding of bindings) {
        // Resolve subject
        const subject = pattern.subject.variable
          ? (binding[pattern.subject.variable] ?? null)
          : pattern.subject.value;

        // Get matching quads
        const quads = this.n3Store.getQuads(
          subject ? namedNode(subject) : null,
          namedNode(pattern.predicate),
          pattern.object.variable
            ? null
            : namedNode(pattern.object.value!),
          null
        );

        for (const q of quads) {
          const newBinding = { ...binding };

          if (pattern.subject.variable && !binding[pattern.subject.variable]) {
            newBinding[pattern.subject.variable] = q.subject.value;
          }

          if (pattern.object.variable) {
            newBinding[pattern.object.variable] = q.object.value;
          }

          newBindings.push(newBinding);
        }
      }

      bindings = newBindings;
    }

    // Filter to only requested variables
    return bindings.map(b => {
      const filtered: Record<string, string> = {};
      for (const v of variables) {
        if (b[v] !== undefined) {
          filtered[v] = b[v];
        }
      }
      return filtered;
    });
  }

  private extractTraceIds(): void {
    // Find all subjects that are prov:Activity
    const activityQuads = this.n3Store.getQuads(
      null,
      namedNode(PREFIXES.rdf + 'type'),
      namedNode(PREFIXES.prov + 'Activity'),
      null
    );

    for (const q of activityQuads) {
      this.traceIds.add(q.subject.value);
    }
  }
}

interface TriplePattern {
  subject: { variable?: string; value?: string };
  predicate: string;
  object: { variable?: string; value?: string };
}

export interface SparqlResult {
  success: boolean;
  error?: string;
  variables?: string[];
  bindings: Array<Record<string, string>>;
}
