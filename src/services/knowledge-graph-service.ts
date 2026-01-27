import type { KnowledgeGraphRef, KnowledgeGraphSnapshot, KnowledgeGraphUpdate } from '../interfaces/index.js';

export interface KnowledgeGraphQuery {
  query: string;
  language?: 'sparql' | 'dsl';
}

/**
 * KnowledgeGraphService
 *
 * Minimal in-memory registry for knowledge graph metadata. Intended to be
 * replaced by a persistent RDF store and query engine.
 */
export class KnowledgeGraphService {
  private graphs: Map<string, KnowledgeGraphRef> = new Map();

  constructor(initialGraphs?: KnowledgeGraphRef[]) {
    if (initialGraphs) {
      for (const graph of initialGraphs) {
        this.registerGraph(graph);
      }
    }
  }

  listGraphs(): KnowledgeGraphRef[] {
    return Array.from(this.graphs.values());
  }

  registerGraph(graph: KnowledgeGraphRef): KnowledgeGraphRef {
    this.graphs.set(graph.id, graph);
    return graph;
  }

  getGraph(id: string): KnowledgeGraphRef | null {
    return this.graphs.get(id) ?? null;
  }

  getDefaultGraph(): KnowledgeGraphRef | null {
    return this.listGraphs()[0] ?? null;
  }

  getSnapshot(id: string): KnowledgeGraphSnapshot | null {
    const graph = this.graphs.get(id);
    if (!graph) return null;

    return {
      graphId: graph.id,
      version: graph.version ?? 'unknown',
      lastUpdated: new Date().toISOString(),
      summary: {
        nodes: 0,
        edges: 0,
        datasets: 0,
        dataProducts: 0
      }
    };
  }

  queryGraph(id: string, _query: KnowledgeGraphQuery): Record<string, unknown> {
    if (!this.graphs.has(id)) {
      return { error: 'Knowledge graph not found' };
    }

    return {
      results: [],
      metadata: { graphId: id }
    };
  }

  registerMapping(id: string, mappingRef: string): KnowledgeGraphUpdate | null {
    const graph = this.graphs.get(id);
    if (!graph) return null;

    graph.mappingsRef = mappingRef;
    this.graphs.set(id, graph);

    return {
      graphId: id,
      updateType: 'mapping',
      updateRef: mappingRef
    };
  }

  recordUpdate(update: KnowledgeGraphUpdate): KnowledgeGraphUpdate {
    return update;
  }
}
