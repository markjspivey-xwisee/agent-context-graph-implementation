import type { RDFStore, SparqlResult } from './rdf-store.js';

/**
 * SPARQL Endpoint Service
 * Provides HTTP-compatible SPARQL query interface over the RDF store
 */
export class SPARQLEndpoint {
  private store: RDFStore;

  constructor(store: RDFStore) {
    this.store = store;
  }

  /**
   * Execute a SPARQL query
   */
  query(sparql: string): SPARQLResponse {
    try {
      // Validate basic query structure
      const queryType = this.detectQueryType(sparql);

      switch (queryType) {
        case 'SELECT':
          return this.executeSelect(sparql);
        case 'CONSTRUCT':
          return this.executeConstruct(sparql);
        case 'ASK':
          return this.executeAsk(sparql);
        case 'DESCRIBE':
          return this.executeDescribe(sparql);
        default:
          return {
            success: false,
            error: 'Unsupported query type. Supported: SELECT, CONSTRUCT, ASK, DESCRIBE'
          };
      }
    } catch (error) {
      return {
        success: false,
        error: `Query execution failed: ${(error as Error).message}`
      };
    }
  }

  /**
   * Execute predefined queries for common trace patterns
   */
  executeNamedQuery(queryName: string, params: Record<string, string> = {}): SPARQLResponse {
    const namedQueries: Record<string, string> = {
      // Get all traces for an agent
      'traces-by-agent': `
        SELECT ?trace ?actionType ?startTime ?outcome
        WHERE {
          ?trace a prov:Activity .
          ?trace prov:wasAssociatedWith ?agent .
          ?agent acg:agentDID "${params.agentDID ?? ''}" .
          ?trace prov:used ?used .
          ?used acg:affordance ?aff .
          ?aff acg:actionType ?actionType .
          ?trace prov:startedAtTime ?startTime .
          OPTIONAL {
            ?trace prov:generated ?gen .
            ?gen acg:outcome ?outcome .
          }
        }
        ORDER BY DESC(?startTime)
        LIMIT ${params.limit ?? '100'}
      `,

      // Get trace lineage (what informed what)
      'trace-lineage': `
        SELECT ?trace ?priorTrace ?actionType ?priorActionType
        WHERE {
          ?trace prov:wasInformedBy ?priorTrace .
          ?trace prov:used ?used1 .
          ?used1 acg:affordance ?aff1 .
          ?aff1 acg:actionType ?actionType .
          ?priorTrace prov:used ?used2 .
          ?used2 acg:affordance ?aff2 .
          ?aff2 acg:actionType ?priorActionType .
        }
        LIMIT ${params.limit ?? '100'}
      `,

      // Get all causal interventions
      'causal-interventions': `
        SELECT ?trace ?agentDID ?causalLabel ?outcome
        WHERE {
          ?trace acg:causalLabel ?causalLabel .
          ?trace prov:wasAssociatedWith ?agent .
          ?agent acg:agentDID ?agentDID .
          OPTIONAL {
            ?trace prov:generated ?gen .
            ?gen acg:outcome ?outcome .
          }
        }
        LIMIT ${params.limit ?? '100'}
      `,

      // Get action type distribution
      'action-distribution': `
        SELECT ?actionType (COUNT(?trace) as ?count)
        WHERE {
          ?trace a prov:Activity .
          ?trace prov:used ?used .
          ?used acg:affordance ?aff .
          ?aff acg:actionType ?actionType .
        }
        GROUP BY ?actionType
        ORDER BY DESC(?count)
      `,

      // Get agent activity summary
      'agent-summary': `
        SELECT ?agentDID ?agentType (COUNT(?trace) as ?traceCount)
        WHERE {
          ?trace a prov:Activity .
          ?trace prov:wasAssociatedWith ?agent .
          ?agent acg:agentDID ?agentDID .
          ?agent acg:agentType ?agentType .
        }
        GROUP BY ?agentDID ?agentType
      `,

      // Get failed actions
      'failed-actions': `
        SELECT ?trace ?agentDID ?actionType ?error ?startTime
        WHERE {
          ?trace a prov:Activity .
          ?trace prov:generated ?gen .
          ?gen acg:outcome "failure" .
          ?gen acg:error ?error .
          ?trace prov:wasAssociatedWith ?agent .
          ?agent acg:agentDID ?agentDID .
          ?trace prov:used ?used .
          ?used acg:affordance ?aff .
          ?aff acg:actionType ?actionType .
          ?trace prov:startedAtTime ?startTime .
        }
        ORDER BY DESC(?startTime)
        LIMIT ${params.limit ?? '100'}
      `,

      // Get traces in time range
      'traces-in-range': `
        SELECT ?trace ?agentDID ?actionType ?startTime
        WHERE {
          ?trace a prov:Activity .
          ?trace prov:startedAtTime ?startTime .
          FILTER(?startTime >= "${params.fromTime ?? '2000-01-01T00:00:00Z'}"^^xsd:dateTime)
          FILTER(?startTime <= "${params.toTime ?? '2100-01-01T00:00:00Z'}"^^xsd:dateTime)
          ?trace prov:wasAssociatedWith ?agent .
          ?agent acg:agentDID ?agentDID .
          ?trace prov:used ?used .
          ?used acg:affordance ?aff .
          ?aff acg:actionType ?actionType .
        }
        ORDER BY DESC(?startTime)
        LIMIT ${params.limit ?? '100'}
      `
    };

    const queryTemplate = namedQueries[queryName];
    if (!queryTemplate) {
      return {
        success: false,
        error: `Unknown named query: ${queryName}. Available: ${Object.keys(namedQueries).join(', ')}`
      };
    }

    // Add prefixes
    const fullQuery = this.addPrefixes(queryTemplate);
    return this.query(fullQuery);
  }

  /**
   * Get available named queries
   */
  getNamedQueries(): Array<{ name: string; description: string; requiredParams: string[] }> {
    return [
      {
        name: 'traces-by-agent',
        description: 'Get all traces for a specific agent',
        requiredParams: ['agentDID']
      },
      {
        name: 'trace-lineage',
        description: 'Get trace provenance chain (what informed what)',
        requiredParams: []
      },
      {
        name: 'causal-interventions',
        description: 'Get all traces with do() causal labels',
        requiredParams: []
      },
      {
        name: 'action-distribution',
        description: 'Get count of traces by action type',
        requiredParams: []
      },
      {
        name: 'agent-summary',
        description: 'Get activity summary per agent',
        requiredParams: []
      },
      {
        name: 'failed-actions',
        description: 'Get all failed actions with error details',
        requiredParams: []
      },
      {
        name: 'traces-in-range',
        description: 'Get traces within a time range',
        requiredParams: ['fromTime', 'toTime']
      }
    ];
  }

  // ===========================================
  // Private methods
  // ===========================================

  private detectQueryType(sparql: string): string {
    const normalized = sparql.trim().toUpperCase();

    if (normalized.startsWith('SELECT') || normalized.match(/^PREFIX[\s\S]*SELECT/)) {
      return 'SELECT';
    }
    if (normalized.startsWith('CONSTRUCT') || normalized.match(/^PREFIX[\s\S]*CONSTRUCT/)) {
      return 'CONSTRUCT';
    }
    if (normalized.startsWith('ASK') || normalized.match(/^PREFIX[\s\S]*ASK/)) {
      return 'ASK';
    }
    if (normalized.startsWith('DESCRIBE') || normalized.match(/^PREFIX[\s\S]*DESCRIBE/)) {
      return 'DESCRIBE';
    }

    return 'UNKNOWN';
  }

  private executeSelect(sparql: string): SPARQLResponse {
    const result = this.store.sparqlQuery(sparql);

    if (!result.success) {
      return { success: false, error: result.error };
    }

    return {
      success: true,
      type: 'SELECT',
      head: { vars: result.variables ?? [] },
      results: {
        bindings: result.bindings.map(binding => {
          const row: Record<string, { type: string; value: string }> = {};
          for (const [key, value] of Object.entries(binding)) {
            row[key] = {
              type: value.startsWith('http') ? 'uri' : 'literal',
              value
            };
          }
          return row;
        })
      }
    };
  }

  private executeConstruct(sparql: string): SPARQLResponse {
    // CONSTRUCT returns RDF triples
    // For now, return Turtle format
    const turtle = this.store.exportTurtle();

    return {
      success: true,
      type: 'CONSTRUCT',
      format: 'text/turtle',
      data: turtle
    };
  }

  private executeAsk(sparql: string): SPARQLResponse {
    // ASK returns boolean
    const result = this.store.sparqlQuery(sparql.replace(/ASK/i, 'SELECT *'));

    return {
      success: true,
      type: 'ASK',
      boolean: result.bindings.length > 0
    };
  }

  private executeDescribe(sparql: string): SPARQLResponse {
    // DESCRIBE returns triples about a resource
    const uriMatch = sparql.match(/DESCRIBE\s+<([^>]+)>/i);
    if (!uriMatch) {
      return { success: false, error: 'DESCRIBE requires a URI' };
    }

    const turtle = this.store.exportTurtle();

    return {
      success: true,
      type: 'DESCRIBE',
      format: 'text/turtle',
      data: turtle
    };
  }

  private addPrefixes(query: string): string {
    const prefixes = `
      PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
      PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
      PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
      PREFIX prov: <http://www.w3.org/ns/prov#>
      PREFIX acg: <https://agentcontextgraph.dev/ontology#>
      PREFIX aat: <https://agentcontextgraph.dev/aat#>
    `;
    return prefixes + query;
  }
}

/**
 * SPARQL Response types (W3C SPARQL Results JSON Format)
 */
export interface SPARQLResponse {
  success: boolean;
  error?: string;
  type?: 'SELECT' | 'CONSTRUCT' | 'ASK' | 'DESCRIBE';

  // SELECT results
  head?: { vars: string[] };
  results?: {
    bindings: Array<Record<string, { type: string; value: string; datatype?: string }>>;
  };

  // ASK result
  boolean?: boolean;

  // CONSTRUCT/DESCRIBE results
  format?: string;
  data?: string;
}

/**
 * Convert SPARQL response to simplified JSON
 */
export function sparqlToJson(response: SPARQLResponse): unknown {
  if (!response.success) {
    return { error: response.error };
  }

  if (response.type === 'SELECT' && response.results) {
    return response.results.bindings.map(binding => {
      const row: Record<string, string> = {};
      for (const [key, val] of Object.entries(binding)) {
        row[key] = val.value;
      }
      return row;
    });
  }

  if (response.type === 'ASK') {
    return { result: response.boolean };
  }

  if (response.type === 'CONSTRUCT' || response.type === 'DESCRIBE') {
    return { format: response.format, data: response.data };
  }

  return response;
}
