import type { DatabricksIntrospectionResult, DatabricksTableInfo } from './databricks-introspector.js';

export type JsonObject = Record<string, unknown>;

export interface SemanticCatalogOptions {
  semanticEndpoint: string;
  title?: string;
  description?: string;
  baseIri?: string;
}

export interface SemanticCatalogBundle {
  catalog: JsonObject;
  products: JsonObject;
}

const DEFAULT_CONTEXT = {
  dcat: 'http://www.w3.org/ns/dcat#',
  dcterms: 'http://purl.org/dc/terms/',
  dprod: 'https://ekgf.github.io/data-product-spec/dprod#',
  hydra: 'http://www.w3.org/ns/hydra/core#',
  hyprcat: 'https://hyprcat.io/vocab#',
  sl: 'https://agentcontextgraph.dev/semantic-layer#'
};

export function buildSemanticCatalogBundle(
  introspection: DatabricksIntrospectionResult,
  options: SemanticCatalogOptions
): SemanticCatalogBundle {
  const baseIri = normalizeBase(options.baseIri ?? 'urn:acg:');
  const datasets = introspection.tables.map(table => ({
    '@id': `${baseIri}dataset:${slugify(tableKey(table))}`
  }));

  const products = introspection.tables.map(table => buildDataProduct(table, baseIri));
  const productRefs = products.map(product => ({ '@id': product['@id'] as string }));

  const catalog: JsonObject = {
    '@context': DEFAULT_CONTEXT,
    '@id': '/data/catalog',
    '@type': ['dcat:Catalog', 'hyprcat:Catalog', 'sl:SemanticCatalog'],
    'dcterms:title': options.title ?? 'Runtime Semantic Catalog',
    'dcterms:description': options.description ??
      'Auto-generated catalog from runtime introspection of the connected data source.',
    'dcat:dataset': datasets,
    'dcat:service': [
      {
        '@id': `${baseIri}service:semantic-layer`,
        '@type': 'dcat:DataService',
        'dcterms:title': 'Semantic Layer SPARQL Service',
        'dcat:endpointURL': options.semanticEndpoint,
        'dcat:servesDataset': datasets,
        'sl:servesProduct': productRefs
      }
    ],
    'sl:hasDataProduct': productRefs,
    'hydra:operation': [
      {
        '@type': 'hydra:Operation',
        'hydra:method': 'GET',
        'hydra:title': 'List data products',
        'hydra:entrypoint': '/data/products',
        'hydra:returns': 'application/ld+json'
      },
      {
        '@type': 'hydra:Operation',
        'hydra:method': 'GET',
        'hydra:title': 'List data contracts',
        'hydra:entrypoint': '/data/contracts',
        'hydra:returns': 'application/ld+json'
      }
    ]
  };

  const productsDoc: JsonObject = {
    '@context': DEFAULT_CONTEXT,
    '@id': '/data/products',
    '@type': 'hydra:Collection',
    'hydra:member': products,
    'hydra:totalItems': products.length
  };

  return { catalog, products: productsDoc };
}

function buildDataProduct(table: DatabricksTableInfo, baseIri: string): JsonObject {
  const datasetId = `${baseIri}dataset:${slugify(tableKey(table))}`;
  const productId = `${baseIri}data-product:${slugify(tableKey(table))}`;
  const title = `${table.name} (${table.schema})`;

  return {
    '@id': productId,
    '@type': ['dprod:DataProduct', 'hyprcat:DataProduct', 'sl:DataProduct'],
    'dcterms:title': title,
    'dcterms:description': `Auto-generated data product for ${table.catalog}.${table.schema}.${table.name}.`,
    'dprod:domain': table.schema,
    'dprod:hasPort': [
      {
        '@type': 'dprod:OutputPort',
        'dcterms:title': 'SPARQL Output',
        'dprod:protocol': 'SPARQL',
        'dcat:dataset': { '@id': datasetId }
      }
    ],
    'sl:hasDataContract': [],
    'hydra:operation': [
      {
        '@type': 'hydra:Operation',
        'hydra:method': 'POST',
        'hydra:title': 'Query data product',
        'hydra:entrypoint': '/data/query',
        'hydra:expects': 'application/sparql-query',
        'hydra:returns': 'application/sparql-results+json'
      }
    ]
  };
}

function normalizeBase(base: string): string {
  if (base.endsWith(':') || base.endsWith('/') || base.endsWith('#')) return base;
  return `${base}/`;
}

function tableKey(table: DatabricksTableInfo): string {
  return `${table.catalog}.${table.schema}.${table.name}`;
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
