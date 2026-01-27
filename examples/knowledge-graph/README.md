# Databricks Knowledge Graph Example

This example shows how an agent can introspect a Databricks lakehouse and register a persistent, ontology-aligned Knowledge Graph using DCAT, DPROD, and R2RML.

## Files

- databricks-kg.jsonld
  - KnowledgeGraphRef metadata
  - DCAT catalog, dataset, distribution, and access service
  - DPROD data product node
  - R2RML triples map stub for relational-to-RDF mapping

## Suggested flow

1. Register the knowledge graph metadata:
   - POST /knowledge-graphs
2. Register mapping artifacts (R2RML):
   - POST /knowledge-graphs/{id}/mappings
3. Query the knowledge graph:
   - POST /knowledge-graphs/{id}/query

## Notes

- DCAT namespace: https://www.w3.org/ns/dcat#
- R2RML namespace: http://www.w3.org/ns/r2rml#
- DPROD namespaces are evolving; this example uses https://www.omg.org/spec/DPROD/
- Replace Databricks endpoints and SQL with your workspace details
- In production, register mappings via an affordance traversal so a PROV trace is emitted
