import { DatabricksSqlClient, type DatabricksSqlQueryResult } from './databricks-sql-client.js';

export interface DatabricksIntrospectionOptions {
  catalog?: string;
  schema?: string;
  tables?: string[];
  maxTables?: number;
  includeViews?: boolean;
}

export interface DatabricksColumnInfo {
  name: string;
  dataType?: string;
  ordinalPosition?: number;
  nullable?: boolean;
}

export interface DatabricksTableInfo {
  catalog: string;
  schema: string;
  name: string;
  columns: DatabricksColumnInfo[];
  primaryKey?: string[];
}

export interface DatabricksIntrospectionResult {
  generatedAt: string;
  filters: {
    catalog?: string;
    schema?: string;
    tables?: string[];
    maxTables?: number;
  };
  tables: DatabricksTableInfo[];
  warnings: string[];
}

interface QueryRowsResult {
  columns: string[];
  rows: Array<Record<string, unknown>>;
}

export class DatabricksIntrospector {
  private readonly client: DatabricksSqlClient;

  constructor(client: DatabricksSqlClient) {
    this.client = client;
  }

  async introspect(options: DatabricksIntrospectionOptions = {}): Promise<DatabricksIntrospectionResult> {
    const warnings: string[] = [];
    const maxTables = options.maxTables && options.maxTables > 0 ? options.maxTables : undefined;
    const includeViews = options.includeViews ?? false;

    const tableFilters = this.buildTableFilters(options);
    const viewClause = includeViews ? "('MANAGED','EXTERNAL','VIEW')" : "('MANAGED','EXTERNAL')";
    const limitClause = maxTables ? `LIMIT ${maxTables}` : '';

    const tablesQuery = `
      SELECT table_catalog AS catalog,
             table_schema AS schema,
             table_name AS name
      FROM system.information_schema.tables
      WHERE table_type IN ${viewClause}
      ${tableFilters}
      ORDER BY table_catalog, table_schema, table_name
      ${limitClause}
    `;

    const tableRows = await this.queryRows(tablesQuery);
    const tables: DatabricksTableInfo[] = tableRows.rows.map(row => ({
      catalog: String(row.catalog ?? ''),
      schema: String(row.schema ?? ''),
      name: String(row.name ?? ''),
      columns: []
    })).filter(t => t.catalog && t.schema && t.name);

    if (tables.length === 0) {
      return {
        generatedAt: new Date().toISOString(),
        filters: {
          catalog: options.catalog,
          schema: options.schema,
          tables: options.tables,
          maxTables
        },
        tables: [],
        warnings: ['No tables discovered from information_schema.']
      };
    }

    const primaryKeys = await this.fetchPrimaryKeys(options).catch(error => {
      warnings.push(`Primary key discovery failed: ${error instanceof Error ? error.message : String(error)}`);
      return new Map<string, string[]>();
    });

    for (const table of tables) {
      const columnQuery = `
        SELECT column_name AS name,
               data_type AS data_type,
               ordinal_position AS ordinal_position,
               is_nullable AS is_nullable
        FROM system.information_schema.columns
        WHERE table_catalog = ${this.sqlLiteral(table.catalog)}
          AND table_schema = ${this.sqlLiteral(table.schema)}
          AND table_name = ${this.sqlLiteral(table.name)}
        ORDER BY ordinal_position
      `;

      const columnsResult = await this.queryRows(columnQuery);
      table.columns = columnsResult.rows.map(row => ({
        name: String(row.name ?? ''),
        dataType: row.data_type ? String(row.data_type) : undefined,
        ordinalPosition: row.ordinal_position ? Number(row.ordinal_position) : undefined,
        nullable: typeof row.is_nullable === 'string' ? row.is_nullable === 'YES' : undefined
      })).filter(col => col.name);

      const pkKey = this.tableKey(table.catalog, table.schema, table.name);
      const pk = primaryKeys.get(pkKey);
      if (pk && pk.length > 0) {
        table.primaryKey = pk;
      }
    }

    return {
      generatedAt: new Date().toISOString(),
      filters: {
        catalog: options.catalog,
        schema: options.schema,
        tables: options.tables,
        maxTables
      },
      tables,
      warnings
    };
  }

  private buildTableFilters(options: DatabricksIntrospectionOptions): string {
    const filters: string[] = [];
    if (options.catalog) {
      filters.push(`table_catalog = ${this.sqlLiteral(options.catalog)}`);
    }
    if (options.schema) {
      filters.push(`table_schema = ${this.sqlLiteral(options.schema)}`);
    }
    if (options.tables && options.tables.length > 0) {
      const list = options.tables.map(t => this.sqlLiteral(t)).join(', ');
      filters.push(`table_name IN (${list})`);
    }
    if (filters.length === 0) return '';
    return `AND ${filters.join(' AND ')}`;
  }

  private async fetchPrimaryKeys(options: DatabricksIntrospectionOptions): Promise<Map<string, string[]>> {
    const filters = this.buildTableFilters(options);
    const pkQuery = `
      SELECT kcu.table_catalog AS catalog,
             kcu.table_schema AS schema,
             kcu.table_name AS name,
             kcu.column_name AS column_name,
             kcu.ordinal_position AS ordinal_position
      FROM system.information_schema.table_constraints tc
      JOIN system.information_schema.key_column_usage kcu
        ON tc.table_catalog = kcu.table_catalog
       AND tc.table_schema = kcu.table_schema
       AND tc.table_name = kcu.table_name
       AND tc.constraint_name = kcu.constraint_name
      WHERE tc.constraint_type = 'PRIMARY KEY'
      ${filters}
      ORDER BY kcu.table_catalog, kcu.table_schema, kcu.table_name, kcu.ordinal_position
    `;

    const rows = await this.queryRows(pkQuery);
    const map = new Map<string, string[]>();
    for (const row of rows.rows) {
      const catalog = String(row.catalog ?? '');
      const schema = String(row.schema ?? '');
      const name = String(row.name ?? '');
      const column = String(row.column_name ?? '');
      if (!catalog || !schema || !name || !column) continue;
      const key = this.tableKey(catalog, schema, name);
      const list = map.get(key) ?? [];
      list.push(column);
      map.set(key, list);
    }
    return map;
  }

  private tableKey(catalog: string, schema: string, name: string): string {
    return `${catalog}.${schema}.${name}`;
  }

  private sqlLiteral(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
  }

  private async queryRows(statement: string): Promise<QueryRowsResult> {
    const result = await this.client.executeStatement({
      statement,
      maxRows: 10000
    });

    if (result.status.state !== 'SUCCEEDED') {
      const message = result.status.error ?? result.status.message ?? 'Databricks query failed';
      throw new Error(message);
    }

    const columns = this.extractColumns(result);
    const dataArray = this.extractDataArray(result);
    const rows = dataArray.map(row => {
      const record: Record<string, unknown> = {};
      columns.forEach((col, idx) => {
        record[col] = row[idx];
      });
      return record;
    });

    return { columns, rows };
  }

  private extractColumns(result: DatabricksSqlQueryResult): string[] {
    const schema =
      (result.manifest as any)?.schema ??
      (result.result as any)?.schema ??
      (result.raw as any)?.manifest?.schema ??
      (result.raw as any)?.result?.schema;

    const cols = schema?.columns ?? schema?.column_names ?? [];
    if (Array.isArray(cols)) {
      return cols.map((col: any) => String(col?.name ?? col?.column_name ?? col)).filter(Boolean);
    }
    return [];
  }

  private extractDataArray(result: DatabricksSqlQueryResult): Array<Array<unknown>> {
    const res = result.result as any;
    const raw = result.raw as any;
    const candidates = [
      res?.data_array,
      res?.chunks?.[0]?.data_array,
      raw?.result?.data_array,
      raw?.result?.chunks?.[0]?.data_array,
      raw?.data_array
    ];
    for (const candidate of candidates) {
      if (Array.isArray(candidate)) {
        return candidate as Array<Array<unknown>>;
      }
    }
    return [];
  }
}
