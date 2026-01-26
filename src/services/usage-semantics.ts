import type { Affordance, UsageSemantics, ITraceStore, ProvTrace } from '../interfaces/index.js';

export interface UsageSemanticsConfig {
  evidenceWindowDays?: number;
  maxExamples?: number;
  maxSamples?: number;
}

/**
 * UsageSemanticsService
 * Minimal stub that derives usage-based semantics from stored traces.
 */
export class UsageSemanticsService {
  private traceStore: ITraceStore;
  private evidenceWindowDays: number;
  private maxExamples: number;
  private maxSamples: number;

  constructor(traceStore: ITraceStore, config?: UsageSemanticsConfig) {
    this.traceStore = traceStore;
    this.evidenceWindowDays = config?.evidenceWindowDays ?? 30;
    this.maxExamples = config?.maxExamples ?? 5;
    this.maxSamples = config?.maxSamples ?? 50;
  }

  async getUsageSemantics(affordance: Affordance): Promise<UsageSemantics> {
    const now = new Date();
    const fromTime = new Date(now.getTime() - this.evidenceWindowDays * 24 * 60 * 60 * 1000);

    const traces = await this.traceStore.query({
      actionType: affordance.actionType,
      fromTime: fromTime.toISOString(),
      toTime: now.toISOString(),
      limit: this.maxSamples
    });

    if (traces.length === 0) {
      return {
        stability: 0,
        drift: 0,
        polysemy: 0,
        evidenceWindow: `P${this.evidenceWindowDays}D`,
        usageExamples: []
      };
    }

    const outcomes = traces
      .map(t => t.generated?.outcome?.status)
      .filter((v): v is NonNullable<ProvTrace['generated']['outcome']>['status'] => Boolean(v));

    const distinctOutcomes = new Set(outcomes).size;
    const uniqueRelVersions = new Set(traces.map(t => t.used.affordance.relVersion).filter(Boolean)).size;

    const stability = Math.min(1, traces.length / Math.max(1, this.maxSamples / 2));
    const drift = Math.min(1, Math.max(0, uniqueRelVersions - 1) / 3);
    const polysemy = Math.min(1, Math.max(0, distinctOutcomes - 1) / 3);

    const lastObservedAt = traces[0].startedAtTime;
    const usageExamples = traces.slice(0, this.maxExamples).map(t => t.id);

    return {
      stability,
      drift,
      polysemy,
      evidenceWindow: `P${this.evidenceWindowDays}D`,
      lastObservedAt,
      usageExamples
    };
  }

  async attachUsageSemantics(affordances: Affordance[]): Promise<void> {
    for (const affordance of affordances) {
      if (!affordance.usageSemantics) {
        affordance.usageSemantics = await this.getUsageSemantics(affordance);
      }
    }
  }
}
