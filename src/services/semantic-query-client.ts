import { randomUUID } from 'crypto';

export interface SemanticQueryClientConfig {
  endpoint: string;
  defaultAccept?: string;
  userAgent?: string;
}

export interface SemanticQueryRequest {
  query: string;
  endpoint?: string;
  resultFormat?: string;
  timeoutSeconds?: number;
  pollIntervalMs?: number;
}

export interface SemanticQueryResult {
  queryId: string;
  results: unknown;
  contentType?: string;
}

export class SemanticQueryClient {
  readonly endpoint: string;
  private readonly defaultAccept: string;
  private readonly userAgent: string;

  constructor(config: SemanticQueryClientConfig) {
    this.endpoint = config.endpoint.trim();
    this.defaultAccept = config.defaultAccept ?? 'application/sparql-results+json';
    this.userAgent = config.userAgent ?? 'agent-context-graph';
  }

  async query(request: SemanticQueryRequest): Promise<SemanticQueryResult> {
    const query = request.query?.trim();
    if (!query) {
      throw new Error('SPARQL query is required');
    }

    const endpoint = (request.endpoint ?? this.endpoint).trim();
    if (!endpoint) {
      throw new Error('SPARQL endpoint is required');
    }

    const accept = request.resultFormat ?? this.defaultAccept;
    const timeoutMs = Math.max(1, (request.timeoutSeconds ?? 60) * 1000);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/sparql-query',
          'Accept': accept,
          'User-Agent': this.userAgent
        },
        body: query,
        signal: controller.signal
      });

      const contentType = response.headers.get('content-type') ?? undefined;
      const raw = await response.text();

      if (!response.ok) {
        const detail = raw ? `: ${raw}` : '';
        throw new Error(`SPARQL query failed (${response.status})${detail}`);
      }

      const results = this.parseResults(raw, contentType);

      return {
        queryId: `urn:uuid:${randomUUID()}`,
        results,
        contentType
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private parseResults(raw: string, contentType?: string): unknown {
    if (contentType?.includes('json')) {
      try {
        return JSON.parse(raw);
      } catch {
        return { raw };
      }
    }
    return { raw };
  }
}
