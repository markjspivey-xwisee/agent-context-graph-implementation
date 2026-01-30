# Databricks Adapter Example

This example shows how a Databricks source is accessed via the generalized `QueryData`
affordance and a **virtual zero-copy semantic layer**. Databricks is an adapter example, not a protocol primitive.
The semantic layer publishes HyprCat-aligned DCAT/DPROD metadata, Hydra catalog affordances,
and SHACL data contracts, with **R2RML/OBDA mappings** that translate SPARQL to Databricks SQL at query time.
Ontop is the recommended open-source runtime for this zero-copy mapping.
No data is copied into the ACG runtime.

## Prereqs

Set the semantic layer endpoint and register Databricks at runtime (recommended):

- `SEMANTIC_LAYER_SPARQL_ENDPOINT` (points to the virtual RDF layer federating Databricks via R2RML/OBDA)
- Register a Databricks data source via `POST /data-sources` (do not store tokens in repo `.env`)

If you want the system to spin up Ontop per data source automatically, set:

```
SEMANTIC_LAYER_MANAGED_ONTOP=true
```

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
