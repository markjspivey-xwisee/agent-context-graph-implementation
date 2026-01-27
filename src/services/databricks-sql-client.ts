import { setTimeout as delay } from 'timers/promises';

export interface DatabricksSqlClientConfig {
  host: string;
  token: string;
  warehouseId?: string;
  defaultCatalog?: string;
  defaultSchema?: string;
  userAgent?: string;
}

export interface DatabricksSqlQueryRequest {
  statement: string;
  warehouseId?: string;
  catalog?: string;
  schema?: string;
  waitTimeoutSeconds?: number;
  timeoutSeconds?: number;
  maxRows?: number;
}

export interface DatabricksSqlQueryResult {
  statementId: string;
  status: {
    state: string;
    message?: string;
    error?: string;
  };
  manifest?: unknown;
  result?: unknown;
  raw: unknown;
}

export class DatabricksSqlClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly warehouseId?: string;
  private readonly defaultCatalog?: string;
  private readonly defaultSchema?: string;
  private readonly userAgent: string;

  constructor(config: DatabricksSqlClientConfig) {
    const trimmedHost = config.host.trim().replace(/\/+$/, '');
    this.baseUrl = trimmedHost.startsWith('http')
      ? trimmedHost
      : `https://${trimmedHost}`;
    this.token = config.token.trim();
    this.warehouseId = config.warehouseId;
    this.defaultCatalog = config.defaultCatalog;
    this.defaultSchema = config.defaultSchema;
    this.userAgent = config.userAgent ?? 'agent-context-graph';
  }

  async executeStatement(request: DatabricksSqlQueryRequest): Promise<DatabricksSqlQueryResult> {
    const statement = request.statement?.trim();
    if (!statement) {
      throw new Error('Databricks SQL statement is required');
    }

    const warehouseId = request.warehouseId ?? this.warehouseId;
    if (!warehouseId) {
      throw new Error('Databricks warehouseId is required');
    }

    const waitTimeoutSeconds = Math.max(1, request.waitTimeoutSeconds ?? 10);
    const timeoutSeconds = Math.max(1, request.timeoutSeconds ?? 120);
    const deadline = Date.now() + timeoutSeconds * 1000;

    const payload: Record<string, unknown> = {
      statement,
      warehouse_id: warehouseId,
      wait_timeout: `${waitTimeoutSeconds}s`,
      on_wait_timeout: 'CONTINUE'
    };

    const catalog = request.catalog ?? this.defaultCatalog;
    if (catalog) payload.catalog = catalog;
    const schema = request.schema ?? this.defaultSchema;
    if (schema) payload.schema = schema;
    if (request.maxRows) payload.row_limit = request.maxRows;

    const initial = await this.fetchJson(`${this.baseUrl}/api/2.0/sql/statements/`, {
      method: 'POST',
      body: JSON.stringify(payload)
    });

    const statementId = (initial?.statement_id as string) ?? '';
    if (!statementId) {
      throw new Error('Databricks did not return a statement_id');
    }

    let current = initial;
    let state = (current?.status?.state as string | undefined) ?? 'UNKNOWN';

    while (state === 'PENDING' || state === 'RUNNING') {
      if (Date.now() > deadline) {
        break;
      }

      await delay(Math.min(1000, waitTimeoutSeconds * 1000));
      current = await this.fetchJson(
        `${this.baseUrl}/api/2.0/sql/statements/${statementId}?wait_timeout=${waitTimeoutSeconds}s`,
        { method: 'GET' }
      );
      state = (current?.status?.state as string | undefined) ?? 'UNKNOWN';
    }

    return this.buildResult(current, statementId);
  }

  async getStatement(statementId: string, waitTimeoutSeconds?: number): Promise<DatabricksSqlQueryResult> {
    const cleanedId = statementId.trim();
    if (!cleanedId) {
      throw new Error('Databricks statementId is required');
    }

    const waitTimeout = waitTimeoutSeconds ? `?wait_timeout=${waitTimeoutSeconds}s` : '';
    const current = await this.fetchJson(
      `${this.baseUrl}/api/2.0/sql/statements/${cleanedId}${waitTimeout}`,
      { method: 'GET' }
    );

    return this.buildResult(current, cleanedId);
  }

  private buildResult(raw: any, statementIdFallback: string): DatabricksSqlQueryResult {
    const statementId = (raw?.statement_id as string | undefined) ?? statementIdFallback;
    return {
      statementId,
      status: {
        state: (raw?.status?.state as string | undefined) ?? 'UNKNOWN',
        message: (raw?.status?.message as string | undefined),
        error: (raw?.status?.error as string | undefined)
      },
      manifest: raw?.manifest,
      result: raw?.result,
      raw
    };
  }

  private async fetchJson(url: string, init: RequestInit): Promise<any> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.token}`,
      'User-Agent': this.userAgent
    };

    const response = await fetch(url, {
      ...init,
      headers: {
        ...headers,
        ...(init.headers ?? {})
      }
    });

    const text = await response.text();
    if (!response.ok) {
      const detail = text ? `: ${text}` : '';
      throw new Error(`Databricks SQL request failed (${response.status})${detail}`);
    }

    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      return { raw: text };
    }
  }
}
