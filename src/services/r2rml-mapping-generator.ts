import type { DatabricksIntrospectionResult, DatabricksTableInfo } from './databricks-introspector.js';

export interface MappingGenerationOptions {
  baseIri?: string;
  includeGenericColumns?: boolean;
  datasetClassIri?: string;
}

export interface MappingGenerationResult {
  ttl: string;
  tablesMapped: number;
  warnings: string[];
}

const DEFAULT_BASE_IRI = 'urn:acg:';
const DEFAULT_DATASET_CLASS = 'http://www.w3.org/ns/dcat#Dataset';

export function generateR2RmlMapping(
  introspection: DatabricksIntrospectionResult,
  options: MappingGenerationOptions = {}
): MappingGenerationResult {
  const warnings: string[] = [];
  const baseIri = normalizeBase(options.baseIri ?? DEFAULT_BASE_IRI);
  const includeGenericColumns = options.includeGenericColumns ?? true;
  const datasetClassIri = options.datasetClassIri ?? DEFAULT_DATASET_CLASS;
  const fieldBase = `${baseIri}field/`;

  const lines: string[] = [];
  lines.push('@prefix rr: <http://www.w3.org/ns/r2rml#> .');
  lines.push('@prefix dcat: <http://www.w3.org/ns/dcat#> .');
  lines.push('@prefix dcterms: <http://purl.org/dc/terms/> .');
  lines.push('@prefix sl: <https://agentcontextgraph.dev/semantic-layer#> .');
  lines.push('@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .');
  lines.push('');

  let tablesMapped = 0;
  for (const table of introspection.tables) {
    if (!table.columns.length) {
      warnings.push(`Skipping ${tableKey(table)}: no columns found.`);
      continue;
    }
    const mapping = buildTableMapping(table, {
      baseIri,
      datasetClassIri,
      includeGenericColumns,
      fieldBase
    });
    lines.push(mapping, '');
    tablesMapped += 1;
  }

  return {
    ttl: lines.join('\n').trim() + '\n',
    tablesMapped,
    warnings
  };
}

interface TableMappingOptions {
  baseIri: string;
  datasetClassIri: string;
  includeGenericColumns: boolean;
  fieldBase: string;
}

function buildTableMapping(table: DatabricksTableInfo, options: TableMappingOptions): string {
  const aliases = new Map<string, string>();
  table.columns.forEach((col, index) => {
    aliases.set(col.name, `c${index + 1}`);
  });

  const idColumns = resolveIdentifierColumns(table);
  const titleColumn = resolveTitleColumn(table);
  const revenueColumn = resolveRevenueColumn(table);

  const sqlSelect = table.columns.map(col => {
    const alias = aliases.get(col.name) ?? col.name;
    return `${quoteIdentifier(col.name)} AS ${alias}`;
  }).join(', ');

  const sqlQuery = `SELECT ${sqlSelect} FROM ${tableReference(table)}`;
  const mappingId = `${options.baseIri}mapping:${slugify(tableKey(table))}`;
  const datasetId = `${options.baseIri}dataset:${slugify(tableKey(table))}`;
  const rowBase = `${options.baseIri}row/${slugify(tableKey(table))}/`;

  const subjectTemplate = `${rowBase}${idColumns.map(col => `{${aliases.get(col) ?? col}}`).join('-')}`;

  const blocks: string[] = [];
  blocks.push(`<${mappingId}>`);
  blocks.push('    a rr:TriplesMap ;');
  blocks.push(`    rr:logicalTable [ rr:sqlQuery "${escapeTtl(sqlQuery)}" ] ;`);
  blocks.push(`    rr:subjectMap [ rr:template "${escapeTtl(subjectTemplate)}" ; rr:class <${options.datasetClassIri}> ] ;`);

  const poMaps: string[] = [];
  for (const col of idColumns) {
    poMaps.push(
      `    rr:predicateObjectMap [ rr:predicate dcterms:identifier ; rr:objectMap [ rr:column "${aliases.get(col) ?? col}" ] ]`
    );
  }
  if (titleColumn) {
    poMaps.push(
      `    rr:predicateObjectMap [ rr:predicate dcterms:title ; rr:objectMap [ rr:column "${aliases.get(titleColumn) ?? titleColumn}" ] ]`
    );
  }
  if (revenueColumn) {
    poMaps.push(
      `    rr:predicateObjectMap [ rr:predicate sl:revenue ; rr:objectMap [ rr:column "${aliases.get(revenueColumn) ?? revenueColumn}" ; rr:datatype xsd:decimal ] ]`
    );
  }

  if (options.includeGenericColumns) {
    for (const col of table.columns) {
      const predicateIri = `${options.fieldBase}${encodeIriSegment(col.name)}`;
      poMaps.push(
        `    rr:predicateObjectMap [ rr:predicate <${predicateIri}> ; rr:objectMap [ rr:column "${aliases.get(col.name) ?? col.name}" ] ]`
      );
    }
  }

  blocks.push(poMaps.map((line, index) => {
    const suffix = index === poMaps.length - 1 ? ' .' : ' ;';
    return `${line}${suffix}`;
  }).join('\n'));

  blocks.push('');
  blocks.push(`<${datasetId}>`);
  blocks.push('    a dcat:Dataset ;');
  blocks.push(`    dcterms:title "${escapeTtl(table.name)}" ;`);
  blocks.push(`    dcterms:identifier "${escapeTtl(tableKey(table))}" ;`);
  blocks.push(`    sl:hasMapping <${mappingId}> .`);

  return blocks.join('\n');
}

function resolveIdentifierColumns(table: DatabricksTableInfo): string[] {
  if (table.primaryKey && table.primaryKey.length > 0) {
    return table.primaryKey;
  }

  const candidates = table.columns.filter(col => /(^id$|_id$|id$|_key$|key$)/i.test(col.name));
  if (candidates.length > 0) {
    return [candidates[0].name];
  }

  return [table.columns[0].name];
}

function resolveTitleColumn(table: DatabricksTableInfo): string | null {
  const candidates = table.columns.filter(col => /(name|title|label)/i.test(col.name));
  return candidates[0]?.name ?? null;
}

function resolveRevenueColumn(table: DatabricksTableInfo): string | null {
  const candidates = table.columns.filter(col => /(revenue|totalprice|total_price|amount|price|sales)/i.test(col.name));
  return candidates[0]?.name ?? null;
}

function tableReference(table: DatabricksTableInfo): string {
  const parts = [table.catalog, table.schema, table.name].filter(Boolean).map(quoteIdentifier);
  return parts.join('.');
}

function tableKey(table: DatabricksTableInfo): string {
  return `${table.catalog}.${table.schema}.${table.name}`;
}

function normalizeBase(base: string): string {
  if (base.endsWith(':') || base.endsWith('/') || base.endsWith('#')) return base;
  return `${base}/`;
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function quoteIdentifier(value: string): string {
  return `\`${value.replace(/`/g, '``')}\``;
}

function escapeTtl(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function encodeIriSegment(value: string): string {
  return encodeURIComponent(value.trim().toLowerCase());
}
