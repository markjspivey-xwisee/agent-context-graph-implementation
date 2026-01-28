# Ontop Semantic Layer (Zero-copy SPARQL)

This guide wires a **real zero-copy semantic layer** using Ontop. Ontop translates SPARQL
to Databricks SQL using R2RML mappings and the Databricks JDBC driver.

## Architecture (Mermaid)

```mermaid
flowchart LR
  Agent -->|QueryData: SPARQL| ACG[ACG Broker]
  ACG -->|SPARQL| ONTOP[Ontop SPARQL Endpoint]
  ONTOP -->|R2RML Mapping| MAP[Mapping Graph]
  ONTOP -->|JDBC| DB[Databricks SQL Warehouse]
  ONTOP -->|SPARQL Results| ACG
  ACG -->|Results + PROV Trace| Agent
```

## Prereqs

1) Download the Databricks JDBC driver (.jar) and place it in:

```
drivers/databricks-jdbc/
```

2) Set these in `.env`:

```
DATABRICKS_HOST=...
DATABRICKS_HTTP_PATH=...
DATABRICKS_TOKEN=...
DATABRICKS_JDBC_DRIVER_CLASS=com.databricks.client.jdbc.Driver
DATABRICKS_JDBC_USER=token
SEMANTIC_LAYER_SPARQL_ENDPOINT=http://localhost:8080/sparql
```

3) Generate and add `DATABRICKS_JDBC_URL`:

```bash
./scripts/ontop-build-jdbc-url.sh
```

PowerShell:

```powershell
.\scripts\ontop-build-jdbc-url.ps1
```

Copy the printed `DATABRICKS_JDBC_URL='...'` into your `.env`. If you **do not** `source .env`,
remove the outer quotes so the value is plain text.

If you see `bash: UID: readonly variable` when sourcing `.env`, remove any `UID=...` line and use
`DATABRICKS_JDBC_USER=token` instead.

If you are only using Docker Compose, you do **not** need to `source .env` — Compose reads it automatically.

## Start Ontop

```
docker compose --profile semantic-layer up -d ontop
```

Default SPARQL endpoint:

```
http://localhost:8080/sparql
```

## Load mappings

Ontop reads the mapping from:

```
examples/semantic-layer/mapping.ttl
```

If you want a different Databricks table, update that mapping file
and restart the Ontop container. The default mapping uses Databricks sample data:

```
SELECT o_orderkey AS order_id, o_orderpriority AS order_name
FROM samples.tpch.orders
```

## Quick SPARQL test

```
curl -X POST http://localhost:8080/sparql \
  -H "Content-Type: application/sparql-query" \
  --data "SELECT * WHERE { ?s ?p ?o } LIMIT 5"
```

## Notes

- Ontop uses environment variables to configure the JDBC connection and mapping file.
- The JDBC URL for Databricks includes `httpPath` and token auth.
