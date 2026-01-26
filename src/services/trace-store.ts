import type {
  ITraceStore,
  ProvTrace,
  StoreResult,
  TraceQuery
} from '../interfaces/index.js';

/**
 * In-memory Trace Store implementation
 * In production, this would be backed by a persistent, append-only store
 */
export class InMemoryTraceStore implements ITraceStore {
  private traces: Map<string, ProvTrace> = new Map();
  private tracesByAgent: Map<string, string[]> = new Map();
  private tracesByAction: Map<string, string[]> = new Map();

  /**
   * Store a PROV trace (append-only)
   */
  async store(trace: ProvTrace): Promise<StoreResult> {
    // Validate trace has required fields
    if (!trace.id) {
      return { success: false, traceId: '', error: 'Trace must have an ID' };
    }

    // Check for duplicate (append-only means no overwrites)
    if (this.traces.has(trace.id)) {
      return { success: false, traceId: trace.id, error: 'Trace already exists (append-only)' };
    }

    // Store the trace
    this.traces.set(trace.id, trace);

    // Index by agent
    const agentDID = trace.wasAssociatedWith.agentDID;
    const agentTraces = this.tracesByAgent.get(agentDID) ?? [];
    agentTraces.push(trace.id);
    this.tracesByAgent.set(agentDID, agentTraces);

    // Index by action type
    const actionType = trace.used.affordance.actionType;
    const actionTraces = this.tracesByAction.get(actionType) ?? [];
    actionTraces.push(trace.id);
    this.tracesByAction.set(actionType, actionTraces);

    return { success: true, traceId: trace.id };
  }

  /**
   * Retrieve traces by query
   */
  async query(query: TraceQuery): Promise<ProvTrace[]> {
    let candidates: Set<string>;

    // Start with all traces or filtered set
    if (query.agentDID) {
      candidates = new Set(this.tracesByAgent.get(query.agentDID) ?? []);
    } else if (query.actionType) {
      candidates = new Set(this.tracesByAction.get(query.actionType) ?? []);
    } else {
      candidates = new Set(this.traces.keys());
    }

    // Filter by additional criteria
    let results: ProvTrace[] = [];
    for (const traceId of candidates) {
      const trace = this.traces.get(traceId);
      if (!trace) continue;

      // Filter by action type (if not already filtered)
      if (query.actionType && trace.used.affordance.actionType !== query.actionType) {
        continue;
      }

      // Filter by agent DID (if not already filtered)
      if (query.agentDID && trace.wasAssociatedWith.agentDID !== query.agentDID) {
        continue;
      }

      // Filter by time range
      if (query.fromTime) {
        const traceTime = new Date(trace.startedAtTime);
        const fromTime = new Date(query.fromTime);
        if (traceTime < fromTime) continue;
      }

      if (query.toTime) {
        const traceTime = new Date(trace.startedAtTime);
        const toTime = new Date(query.toTime);
        if (traceTime > toTime) continue;
      }

      results.push(trace);
    }

    // Sort by time (newest first)
    results.sort((a, b) =>
      new Date(b.startedAtTime).getTime() - new Date(a.startedAtTime).getTime()
    );

    // Apply offset and limit
    const offset = query.offset ?? 0;
    const limit = query.limit ?? 100;
    results = results.slice(offset, offset + limit);

    return results;
  }

  /**
   * Get a specific trace by ID
   */
  async getById(traceId: string): Promise<ProvTrace | null> {
    return this.traces.get(traceId) ?? null;
  }

  /**
   * Get total trace count
   */
  getCount(): number {
    return this.traces.size;
  }

  /**
   * Get traces for a specific agent (for debugging/testing)
   */
  getTracesForAgent(agentDID: string): ProvTrace[] {
    const traceIds = this.tracesByAgent.get(agentDID) ?? [];
    return traceIds
      .map(id => this.traces.get(id))
      .filter((t): t is ProvTrace => t !== undefined);
  }
}
