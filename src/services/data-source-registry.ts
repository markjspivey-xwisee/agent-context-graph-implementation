import { existsSync, readFileSync, writeFileSync } from 'fs';

export type DataSourceType = 'databricks' | 'sparql' | 'lrs' | 'custom';

export interface DatabricksSourceConfig {
  host: string;
  token: string;
  warehouseId?: string;
  catalog?: string;
  schema?: string;
  httpPath?: string;
  jdbcUrl?: string;
  driverClass?: string;
}

export interface SemanticLayerConfig {
  sparqlEndpoint?: string;
  planEndpoint?: string;
  mappingPath?: string;
  baseIri?: string;
  jdbcDriverPath?: string;
  managed?: {
    provider?: 'ontop';
    enabled?: boolean;
    containerId?: string;
    containerName?: string;
    hostPort?: string;
    mappingHash?: string;
  };
}

export interface DataSourcePaths {
  runtimeDir?: string;
  catalogPath?: string;
  productsPath?: string;
  introspectionPath?: string;
  mappingPath?: string;
}

export interface DataSourceStatus {
  lastRefreshAt?: string;
  lastError?: string;
  tablesMapped?: number;
  warnings?: string[];
}

export interface DataSourceRegistration {
  id: string;
  name: string;
  type: DataSourceType;
  description?: string;
  createdAt: string;
  updatedAt: string;
  databricks?: DatabricksSourceConfig;
  semanticLayer?: SemanticLayerConfig;
  paths?: DataSourcePaths;
  status?: DataSourceStatus;
}

interface RegistryFile {
  sources: DataSourceRegistration[];
}

export class DataSourceRegistry {
  private readonly filePath: string;
  private sources: DataSourceRegistration[] = [];

  constructor(filePath: string) {
    this.filePath = filePath;
    this.load();
  }

  load() {
    if (!existsSync(this.filePath)) {
      this.sources = [];
      return;
    }
    try {
      const raw = JSON.parse(readFileSync(this.filePath, 'utf-8')) as RegistryFile;
      this.sources = Array.isArray(raw.sources) ? raw.sources : [];
    } catch {
      this.sources = [];
    }
  }

  save() {
    const payload: RegistryFile = { sources: this.sources };
    writeFileSync(this.filePath, JSON.stringify(payload, null, 2), 'utf-8');
  }

  list(): DataSourceRegistration[] {
    return [...this.sources];
  }

  get(id: string): DataSourceRegistration | undefined {
    return this.sources.find(source => source.id === id);
  }

  register(input: Omit<DataSourceRegistration, 'createdAt' | 'updatedAt'>): DataSourceRegistration {
    const now = new Date().toISOString();
    const existing = this.get(input.id);
    if (existing) {
      throw new Error(`Data source '${input.id}' already exists`);
    }
    const source: DataSourceRegistration = {
      ...input,
      createdAt: now,
      updatedAt: now
    };
    this.sources.push(source);
    this.save();
    return source;
  }

  update(id: string, patch: Partial<DataSourceRegistration>): DataSourceRegistration {
    const source = this.get(id);
    if (!source) {
      throw new Error(`Data source '${id}' not found`);
    }
    const updated: DataSourceRegistration = {
      ...source,
      ...patch,
      updatedAt: new Date().toISOString()
    };
    this.sources = this.sources.map(item => item.id === id ? updated : item);
    this.save();
    return updated;
  }

  remove(id: string): boolean {
    const before = this.sources.length;
    this.sources = this.sources.filter(source => source.id !== id);
    if (this.sources.length !== before) {
      this.save();
      return true;
    }
    return false;
  }
}
