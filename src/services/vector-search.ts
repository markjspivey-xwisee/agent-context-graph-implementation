/**
 * Vector Search Service
 *
 * Provides semantic similarity search for memory queries using vector embeddings.
 * Supports multiple embedding providers and efficient nearest-neighbor search.
 */

import { EventEmitter } from 'events';

// =============================================================================
// Types
// =============================================================================

export interface VectorDocument {
  id: string;
  content: string;
  embedding?: number[];
  metadata: {
    type: 'semantic' | 'episodic' | 'procedural' | 'preference';
    brokerId: string;
    importance?: number;
    tags?: string[];
    createdAt: Date;
    source?: string;
  };
}

export interface SearchResult {
  document: VectorDocument;
  score: number;
  distance: number;
}

export interface VectorSearchConfig {
  dimensions: number;
  embeddingProvider: 'local' | 'openai' | 'cohere' | 'custom';
  similarityMetric: 'cosine' | 'euclidean' | 'dotProduct';
  maxResults: number;
  minScore: number;
}

export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
}

// =============================================================================
// Local Embedding (Simple TF-IDF-like for demo)
// =============================================================================

class LocalEmbedding implements EmbeddingProvider {
  private vocabulary: Map<string, number> = new Map();
  private idf: Map<string, number> = new Map();
  private documentCount = 0;
  private dimensions: number;

  constructor(dimensions: number = 384) {
    this.dimensions = dimensions;
  }

  async embed(text: string): Promise<number[]> {
    const tokens = this.tokenize(text);
    const vector = new Array(this.dimensions).fill(0);

    // Simple hash-based embedding
    for (const token of tokens) {
      const hash = this.hashString(token);
      const idx = Math.abs(hash) % this.dimensions;
      vector[idx] += 1 * (this.idf.get(token) || 1);
    }

    return this.normalize(vector);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map(t => this.embed(t)));
  }

  updateVocabulary(documents: string[]): void {
    this.documentCount = documents.length;
    const termDocFreq = new Map<string, number>();

    for (const doc of documents) {
      const tokens = new Set(this.tokenize(doc));
      for (const token of tokens) {
        termDocFreq.set(token, (termDocFreq.get(token) || 0) + 1);
      }
    }

    for (const [term, docFreq] of termDocFreq) {
      this.idf.set(term, Math.log(this.documentCount / (docFreq + 1)) + 1);
    }
  }

  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length > 2);
  }

  private hashString(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return hash;
  }

  private normalize(vector: number[]): number[] {
    const magnitude = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
    if (magnitude === 0) return vector;
    return vector.map(v => v / magnitude);
  }
}

// =============================================================================
// Vector Index (HNSW-inspired for approximate nearest neighbor)
// =============================================================================

interface IndexNode {
  id: string;
  vector: number[];
  neighbors: Map<number, string[]>; // level -> neighbor ids
  level: number;
}

class VectorIndex {
  private nodes: Map<string, IndexNode> = new Map();
  private entryPoint: string | null = null;
  private maxLevel = 0;
  private readonly levelMult = 1 / Math.log(16);
  private readonly efConstruction = 200;
  private readonly maxConnections = 16;
  private similarityMetric: 'cosine' | 'euclidean' | 'dotProduct';

  constructor(similarityMetric: 'cosine' | 'euclidean' | 'dotProduct' = 'cosine') {
    this.similarityMetric = similarityMetric;
  }

  insert(id: string, vector: number[]): void {
    const level = this.randomLevel();
    const node: IndexNode = {
      id,
      vector,
      neighbors: new Map(),
      level
    };

    if (!this.entryPoint) {
      this.entryPoint = id;
      this.maxLevel = level;
      this.nodes.set(id, node);
      return;
    }

    // Find entry point at top level
    let currId = this.entryPoint;
    let currDist = this.distance(vector, this.nodes.get(currId)!.vector);

    // Traverse from top to insertion level
    for (let lc = this.maxLevel; lc > level; lc--) {
      let changed = true;
      while (changed) {
        changed = false;
        const currNode = this.nodes.get(currId)!;
        const neighbors = currNode.neighbors.get(lc) || [];

        for (const neighborId of neighbors) {
          const neighborNode = this.nodes.get(neighborId);
          if (!neighborNode) continue;

          const dist = this.distance(vector, neighborNode.vector);
          if (dist < currDist) {
            currDist = dist;
            currId = neighborId;
            changed = true;
          }
        }
      }
    }

    // Insert at each level from min(level, maxLevel) to 0
    for (let lc = Math.min(level, this.maxLevel); lc >= 0; lc--) {
      const neighbors = this.searchLayer(vector, currId, this.efConstruction, lc);
      const selectedNeighbors = neighbors.slice(0, this.maxConnections);

      node.neighbors.set(lc, selectedNeighbors.map(n => n.id));

      // Bidirectional connections
      for (const neighbor of selectedNeighbors) {
        const neighborNode = this.nodes.get(neighbor.id);
        if (!neighborNode) continue;

        const neighborNeighbors = neighborNode.neighbors.get(lc) || [];
        neighborNeighbors.push(id);

        // Prune if too many connections
        if (neighborNeighbors.length > this.maxConnections) {
          const sorted = neighborNeighbors
            .map(nid => ({
              id: nid,
              dist: this.distance(neighborNode.vector, this.nodes.get(nid)!.vector)
            }))
            .sort((a, b) => a.dist - b.dist)
            .slice(0, this.maxConnections);

          neighborNode.neighbors.set(lc, sorted.map(n => n.id));
        } else {
          neighborNode.neighbors.set(lc, neighborNeighbors);
        }
      }

      if (neighbors.length > 0) {
        currId = neighbors[0].id;
      }
    }

    this.nodes.set(id, node);

    if (level > this.maxLevel) {
      this.maxLevel = level;
      this.entryPoint = id;
    }
  }

  search(vector: number[], k: number): Array<{ id: string; distance: number }> {
    if (!this.entryPoint) return [];

    let currId = this.entryPoint;
    let currDist = this.distance(vector, this.nodes.get(currId)!.vector);

    // Traverse from top level to level 1
    for (let lc = this.maxLevel; lc > 0; lc--) {
      let changed = true;
      while (changed) {
        changed = false;
        const currNode = this.nodes.get(currId);
        if (!currNode) break;

        const neighbors = currNode.neighbors.get(lc) || [];

        for (const neighborId of neighbors) {
          const neighborNode = this.nodes.get(neighborId);
          if (!neighborNode) continue;

          const dist = this.distance(vector, neighborNode.vector);
          if (dist < currDist) {
            currDist = dist;
            currId = neighborId;
            changed = true;
          }
        }
      }
    }

    // Search at level 0
    const results = this.searchLayer(vector, currId, Math.max(k, this.efConstruction), 0);
    return results.slice(0, k).map(r => ({ id: r.id, distance: r.dist }));
  }

  delete(id: string): boolean {
    const node = this.nodes.get(id);
    if (!node) return false;

    // Remove from neighbors' neighbor lists
    for (let lc = 0; lc <= node.level; lc++) {
      const neighbors = node.neighbors.get(lc) || [];
      for (const neighborId of neighbors) {
        const neighborNode = this.nodes.get(neighborId);
        if (!neighborNode) continue;

        const neighborNeighbors = neighborNode.neighbors.get(lc) || [];
        neighborNode.neighbors.set(
          lc,
          neighborNeighbors.filter(nid => nid !== id)
        );
      }
    }

    this.nodes.delete(id);

    // Update entry point if needed
    if (this.entryPoint === id) {
      if (this.nodes.size === 0) {
        this.entryPoint = null;
        this.maxLevel = 0;
      } else {
        // Find new entry point (node with highest level)
        let maxLevel = 0;
        let newEntry: string | null = null;
        for (const [nodeId, nodeData] of this.nodes) {
          if (nodeData.level >= maxLevel) {
            maxLevel = nodeData.level;
            newEntry = nodeId;
          }
        }
        this.entryPoint = newEntry;
        this.maxLevel = maxLevel;
      }
    }

    return true;
  }

  private searchLayer(
    vector: number[],
    entryId: string,
    ef: number,
    level: number
  ): Array<{ id: string; dist: number }> {
    const visited = new Set<string>([entryId]);
    const candidates: Array<{ id: string; dist: number }> = [{
      id: entryId,
      dist: this.distance(vector, this.nodes.get(entryId)!.vector)
    }];
    const results = [...candidates];

    while (candidates.length > 0) {
      // Get closest candidate
      candidates.sort((a, b) => a.dist - b.dist);
      const current = candidates.shift()!;

      // Get furthest result
      results.sort((a, b) => a.dist - b.dist);
      if (results.length >= ef && current.dist > results[ef - 1].dist) {
        break;
      }

      const currentNode = this.nodes.get(current.id);
      if (!currentNode) continue;

      const neighbors = currentNode.neighbors.get(level) || [];

      for (const neighborId of neighbors) {
        if (visited.has(neighborId)) continue;
        visited.add(neighborId);

        const neighborNode = this.nodes.get(neighborId);
        if (!neighborNode) continue;

        const dist = this.distance(vector, neighborNode.vector);

        if (results.length < ef || dist < results[results.length - 1].dist) {
          candidates.push({ id: neighborId, dist });
          results.push({ id: neighborId, dist });
          results.sort((a, b) => a.dist - b.dist);
          if (results.length > ef) {
            results.pop();
          }
        }
      }
    }

    return results.sort((a, b) => a.dist - b.dist);
  }

  private distance(a: number[], b: number[]): number {
    switch (this.similarityMetric) {
      case 'cosine':
        return 1 - this.cosineSimilarity(a, b);
      case 'euclidean':
        return this.euclideanDistance(a, b);
      case 'dotProduct':
        return -this.dotProduct(a, b);
      default:
        return 1 - this.cosineSimilarity(a, b);
    }
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    let dot = 0, magA = 0, magB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      magA += a[i] * a[i];
      magB += b[i] * b[i];
    }
    return dot / (Math.sqrt(magA) * Math.sqrt(magB) || 1);
  }

  private euclideanDistance(a: number[], b: number[]): number {
    let sum = 0;
    for (let i = 0; i < a.length; i++) {
      const diff = a[i] - b[i];
      sum += diff * diff;
    }
    return Math.sqrt(sum);
  }

  private dotProduct(a: number[], b: number[]): number {
    let sum = 0;
    for (let i = 0; i < a.length; i++) {
      sum += a[i] * b[i];
    }
    return sum;
  }

  private randomLevel(): number {
    let level = 0;
    while (Math.random() < 0.5 && level < 16) {
      level++;
    }
    return level;
  }

  get size(): number {
    return this.nodes.size;
  }
}

// =============================================================================
// Vector Search Service
// =============================================================================

export class VectorSearchService extends EventEmitter {
  private config: VectorSearchConfig;
  private embeddingProvider: EmbeddingProvider;
  private index: VectorIndex;
  private documents: Map<string, VectorDocument> = new Map();

  constructor(config?: Partial<VectorSearchConfig>) {
    super();
    this.config = {
      dimensions: 384,
      embeddingProvider: 'local',
      similarityMetric: 'cosine',
      maxResults: 10,
      minScore: 0.5,
      ...config
    };

    this.index = new VectorIndex(this.config.similarityMetric);
    this.embeddingProvider = new LocalEmbedding(this.config.dimensions);
  }

  /**
   * Add a document to the search index
   */
  async addDocument(doc: Omit<VectorDocument, 'embedding'>): Promise<VectorDocument> {
    const embedding = await this.embeddingProvider.embed(doc.content);
    const fullDoc: VectorDocument = { ...doc, embedding };

    this.documents.set(doc.id, fullDoc);
    this.index.insert(doc.id, embedding);

    this.emit('document:added', { id: doc.id });
    return fullDoc;
  }

  /**
   * Add multiple documents in batch
   */
  async addDocuments(docs: Array<Omit<VectorDocument, 'embedding'>>): Promise<VectorDocument[]> {
    const contents = docs.map(d => d.content);
    const embeddings = await this.embeddingProvider.embedBatch(contents);

    const results: VectorDocument[] = [];
    for (let i = 0; i < docs.length; i++) {
      const fullDoc: VectorDocument = { ...docs[i], embedding: embeddings[i] };
      this.documents.set(docs[i].id, fullDoc);
      this.index.insert(docs[i].id, embeddings[i]);
      results.push(fullDoc);
    }

    this.emit('documents:added', { count: docs.length });
    return results;
  }

  /**
   * Remove a document from the index
   */
  removeDocument(id: string): boolean {
    const deleted = this.index.delete(id);
    if (deleted) {
      this.documents.delete(id);
      this.emit('document:removed', { id });
    }
    return deleted;
  }

  /**
   * Search for similar documents
   */
  async search(query: string, options?: {
    limit?: number;
    minScore?: number;
    type?: VectorDocument['metadata']['type'];
    brokerId?: string;
    tags?: string[];
  }): Promise<SearchResult[]> {
    const limit = options?.limit || this.config.maxResults;
    const minScore = options?.minScore || this.config.minScore;

    const queryEmbedding = await this.embeddingProvider.embed(query);
    const indexResults = this.index.search(queryEmbedding, limit * 2);

    const results: SearchResult[] = [];

    for (const result of indexResults) {
      const doc = this.documents.get(result.id);
      if (!doc) continue;

      // Apply filters
      if (options?.type && doc.metadata.type !== options.type) continue;
      if (options?.brokerId && doc.metadata.brokerId !== options.brokerId) continue;
      if (options?.tags && options.tags.length > 0) {
        const docTags = doc.metadata.tags || [];
        if (!options.tags.some(t => docTags.includes(t))) continue;
      }

      const score = 1 - result.distance;
      if (score < minScore) continue;

      results.push({
        document: doc,
        score,
        distance: result.distance
      });
    }

    return results.slice(0, limit);
  }

  /**
   * Find documents similar to an existing document
   */
  async findSimilar(docId: string, options?: {
    limit?: number;
    minScore?: number;
  }): Promise<SearchResult[]> {
    const doc = this.documents.get(docId);
    if (!doc || !doc.embedding) {
      return [];
    }

    const limit = options?.limit || this.config.maxResults;
    const minScore = options?.minScore || this.config.minScore;

    const indexResults = this.index.search(doc.embedding, limit + 1);

    const results: SearchResult[] = [];
    for (const result of indexResults) {
      if (result.id === docId) continue;

      const similarDoc = this.documents.get(result.id);
      if (!similarDoc) continue;

      const score = 1 - result.distance;
      if (score < minScore) continue;

      results.push({
        document: similarDoc,
        score,
        distance: result.distance
      });
    }

    return results.slice(0, limit);
  }

  /**
   * Get statistics about the index
   */
  getStats(): {
    documentCount: number;
    dimensions: number;
    similarityMetric: string;
    byType: Record<string, number>;
    byBroker: Record<string, number>;
  } {
    const byType: Record<string, number> = {};
    const byBroker: Record<string, number> = {};

    for (const doc of this.documents.values()) {
      byType[doc.metadata.type] = (byType[doc.metadata.type] || 0) + 1;
      byBroker[doc.metadata.brokerId] = (byBroker[doc.metadata.brokerId] || 0) + 1;
    }

    return {
      documentCount: this.documents.size,
      dimensions: this.config.dimensions,
      similarityMetric: this.config.similarityMetric,
      byType,
      byBroker
    };
  }

  /**
   * Export all documents
   */
  exportDocuments(): VectorDocument[] {
    return Array.from(this.documents.values());
  }

  /**
   * Import documents (rebuilds index)
   */
  async importDocuments(docs: VectorDocument[]): Promise<void> {
    this.documents.clear();
    this.index = new VectorIndex(this.config.similarityMetric);

    for (const doc of docs) {
      if (doc.embedding) {
        this.documents.set(doc.id, doc);
        this.index.insert(doc.id, doc.embedding);
      } else {
        await this.addDocument(doc);
      }
    }

    this.emit('documents:imported', { count: docs.length });
  }
}

// Export singleton instance
export const vectorSearch = new VectorSearchService();
