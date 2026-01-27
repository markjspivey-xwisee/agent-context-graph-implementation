# Databricks Adapter (Example Implementation)

This adapter is **implementation-specific**. The protocol/spec layer is **SPARQL-first**
and does **not** require Databricks.

## Preferred Path: Zero-Copy Semantic Layer

Configure a **virtual zero-copy semantic layer** (e.g., Ontop, Stardog, GraphDB, or similar) that:

- Exposes a **SPARQL endpoint**
- Uses **R2RML/OBDA** mappings over Databricks
- Translates **SPARQL to SQL** at query time (no data replication)
- Publishes **HyprCat-aligned** DCAT/DPROD metadata, Hydra affordances, and SHACL contracts

Set:

- `SEMANTIC_LAYER_SPARQL_ENDPOINT`

Then use `QueryData` with `queryLanguage: "sparql"`.

### Zero-copy guarantee

The semantic layer is a **virtual RDF overlay**. Databricks remains the source of truth, and
all SPARQL queries are **federated/mapped** to SQL against Databricks at runtime via R2RML.
No data is copied or persisted into the ACG runtime.

## SQL Adapter (Fallback / Dev)

If you want direct SQL execution (adapter extension), configure:

- `DATABRICKS_HOST`
- `DATABRICKS_TOKEN`
- `DATABRICKS_WAREHOUSE_ID` (optional)
- `DATABRICKS_CATALOG` (optional)
- `DATABRICKS_SCHEMA` (optional)

Then use `QueryData` with `queryLanguage: "sql"` (implementation extension).

## Notes

Databricks is only one possible adapter. Any SQL warehouse or data system can be integrated
so long as the semantic layer exposes a SPARQL endpoint and mappings are explicit.
