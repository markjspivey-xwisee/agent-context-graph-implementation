# Semantic Layer Evals

This guide provides a lightweight eval harness for validating SPARQL mappings against the virtual semantic layer. The goal is to make regression checks repeatable when mappings or ontology terms change.

## Why this exists

- Catch broken mappings early (e.g., table renamed, ontology predicate changes).
- Provide a “golden query” baseline for releases.
- Align with your **zero‑copy** principle by testing *queries*, not materialized data.

## Quick start

1) Ensure your semantic layer endpoint is reachable:

```
SEMANTIC_LAYER_SPARQL_ENDPOINT=http://localhost:8080/sparql
```

2) Run the sample eval suite:

```
npm run semantic-layer:eval
```

3) Use a custom eval file:

```
npm run semantic-layer:eval -- --file examples/semantic-layer/evals/sample.json
```

## Eval file format

```json
{
  "name": "Semantic layer smoke tests",
  "cases": [
    {
      "id": "list-orders",
      "description": "Ensure orders are mapped and queryable",
      "query": "PREFIX dcat: <http://www.w3.org/ns/dcat#> ...",
      "expect": {
        "minRows": 1,
        "maxRows": 5,
        "requiredVars": ["order", "id", "title"]
      }
    }
  ]
}
```

## Extending the harness

The script is intentionally small and opinionated. Extend as needed:

- Add `expect.equalsRows` for deterministic fixtures.
- Add `expect.contains` to check for specific bindings.
- Add `expect.orderBy` if ordering matters.

## Notes

- Evals are best kept in the same repo as the mappings they test.
- Avoid embedding credentials inside eval files.
- Use the **managed Ontop** flow to keep evals aligned with runtime‑registered sources.
