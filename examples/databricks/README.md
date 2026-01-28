# Databricks Adapter Example

This example shows how a Databricks source is accessed via the generalized `QueryData`
affordance and a **virtual zero-copy semantic layer**. Databricks is an adapter example, not a protocol primitive.
The semantic layer publishes HyprCat-aligned DCAT/DPROD metadata, Hydra catalog affordances,
and SHACL data contracts, with **R2RML/OBDA mappings** that translate SPARQL to Databricks SQL at query time.
Ontop is the recommended open-source runtime for this zero-copy mapping.
No data is copied into the ACG runtime.

## Prereqs

Set the following environment variables (or a local `.env` file):

- `SEMANTIC_LAYER_SPARQL_ENDPOINT` (preferred; points to the virtual RDF layer federating Databricks via R2RML/OBDA)
- `DATABRICKS_HOST` (adapter example)
- `DATABRICKS_TOKEN` (adapter example)
- `DATABRICKS_WAREHOUSE_ID` (optional)
- `DATABRICKS_CATALOG` (optional)
- `DATABRICKS_SCHEMA` (optional)

## Direct REST call (generalized)

```bash
curl -X POST http://localhost:3000/data/query ^
  -H "Content-Type: application/json" ^
  -d @examples/databricks/query.json
```

## Affordance traversal

1) Request a context for an executor with an `ExecutorCapability` credential.
2) Traverse the `QueryData` affordance with the same payload shape as `query.json`.

The traversal response includes the query `queryId`, `status`, and any returned results.

## Analyst QueryData affordance (semantic-layer mapped)

1) Request a context using `examples/databricks/analyst-context-request.json`.
2) Find the affordance with `actionType: "QueryData"`.
3) Traverse it with `examples/databricks/analyst-querydata-traverse.json` (replace `contextId` and `affordanceId`).

This uses the same `QueryData` semantics; the Databricks adapter is just one backend.

## CLI quick test

```bash
acg data query --query "SELECT * WHERE { ?s ?p ?o } LIMIT 1" --queryLanguage sparql
acg data status <queryId>
```
