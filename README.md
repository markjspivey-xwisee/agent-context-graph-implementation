# Agent Context Graph Implementation

Reference implementation, demos, tests, and examples for Agent Context Graph (ACG).

This repo operationalizes the foundations layer and keeps executable code, examples, and tests in sync with the specs.

It includes persistent Knowledge Graph plumbing, a HyprCat-aligned Hydra semantic catalog, and tool authoring endpoints so agents can consult long-term memory, browse data products, and register new tools through explicit affordances.
## Foundations dependency

This repo expects the foundations repo for specs and ontologies.

Default lookup order:
- ACG_SPEC_DIR (if set)
- ./spec (if present)
- ../agent-context-graph-foundations/spec (sibling checkout)

Recommended layout:

  devstuff/
    agent-context-graph-foundations/
    agent-context-graph-implementation/

If your foundations repo lives elsewhere, set ACG_SPEC_DIR to its spec directory.

## Start here

- OVERVIEW.md
- src/broker/context-broker.ts
- src/agents/orchestrator.ts
- src/dashboard/server.ts
- examples/golden-path/
- examples/knowledge-graph/
- examples/semantic-layer/
- examples/databricks/
- examples/tool-authoring/
- tests/integration/golden-path.test.ts

## Repo map

- src/        Core services, broker, orchestrator, and runtime
- examples/   Golden-path examples and demos
- tests/      Unit and integration tests
- guides/     Build and usage guides

## Quick start

npm install
npm run build
npm run dashboard

## Conversational agent team (chat with Databricks)

The chat flow routes through the agent team (Planner → Arbiter → Analyst → Observer → Archivist)
and uses `QueryData` (SPARQL) against the semantic layer.

1) Ensure a SPARQL endpoint is running (Ontop or Virtuoso) and set:
   - `SEMANTIC_LAYER_SPARQL_ENDPOINT`
2) (Recommended) Generate a runtime mapping + catalog from Databricks:
   - `POST /semantic-layer/refresh`
3) Start the core API (for full dashboard functionality):
   - `npm run dev` (port 3000)
4) Start the dashboard server:
   - `npm run dashboard` (port 3001)

All workflows (goals, chat, CLI) run through the core API on port 3000; the dashboard server
serves the UI and proxies workflow/chat requests so every interface uses the same orchestration pipeline.

Open the dashboard and use the **Chat** tab, or call the API directly:

```bash
curl -X POST http://localhost:3000/chat \
  -H "Content-Type: application/json" \
  -d '{"message":"Summarize top 5 orders by revenue"}'
```

Target a specific registered source:

```bash
curl -X POST http://localhost:3000/chat \
  -H "Content-Type: application/json" \
  -d '{"message":"Summarize top 5 orders by revenue","dataSourceId":"databricks-secondary"}'
```

## Register data sources at runtime

You can register additional data sources (Databricks, SPARQL services, LRS) without code changes.

Data sources are runtime resources. Avoid storing source credentials in `.env` or committing them.
Prefer runtime registration + a registry path outside the repo, for example:

```
DATA_SOURCE_REGISTRY_PATH=/home/codespace/.acg/data-sources.json
```

Register:

```bash
curl -X POST http://localhost:3000/data-sources \
  -H "Content-Type: application/json" \
  -d '{
    "name": "databricks-secondary",
    "type": "databricks",
    "databricks": {
      "host": "dbc-....cloud.databricks.com",
      "token": "dapi....",
      "warehouseId": "abc123",
      "catalog": "samples",
      "schema": "tpch"
    },
    "semanticLayer": {
      "sparqlEndpoint": "http://localhost:8080/sparql"
    }
  }'
```

Refresh (introspect + mapping):

```bash
curl -X POST http://localhost:3000/data-sources/databricks-secondary/refresh
```

Update (rotate tokens / metadata):

```bash
curl -X PUT http://localhost:3000/data-sources/databricks-secondary \
  -H "Content-Type: application/json" \
  -d '{
    "description": "Updated description",
    "databricks": { "token": "dapi-rotated" },
    "refresh": true
  }'
```

The refresh will:
- Introspect the source tables
- Generate an R2RML mapping
- Emit Hydra/HyprCat catalog + data products
- Merge into `/data/catalog` and `/data/products`

## Codespaces helper

In Codespaces, you can run:

```bash
source scripts/codespaces-start.sh claude-cli
# or
source scripts/codespaces-start.sh codex-cli
```

This clones the foundations repo, sets `ACG_SPEC_DIR`, installs dependencies, and
sets `REASONING_BACKEND` for the current shell session.

To start API + dashboard in a tmux split:

```bash
source scripts/codespaces-start.sh claude-cli --tmux
```

## Reasoning backends

The orchestrator and dashboard can use multiple reasoning backends:

- `REASONING_BACKEND=anthropic` (default) — Anthropic API (`ANTHROPIC_API_KEY`)
- `REASONING_BACKEND=openai` — OpenAI API (`OPENAI_API_KEY`)
- `REASONING_BACKEND=claude-cli` — Claude Code CLI (`CLAUDE_CLI_PATH`)
- `REASONING_BACKEND=codex-cli` — OpenAI Codex CLI (`CODEX_CLI_PATH`)

Optional model/env overrides:
- `ANTHROPIC_MODEL`
- `OPENAI_MODEL` (default `gpt-5`)
- `CLAUDE_CLI_MODEL`
- `CODEX_CLI_MODEL`

CLI flags can be passed via:
- `CLAUDE_CLI_FLAGS` (comma-separated)
- `CODEX_CLI_FLAGS` (comma-separated)

Codex CLI can also set a sandbox with `CODEX_CLI_SANDBOX`.

## CI note (foundations spec)

CI clones the foundations repo and sets `ACG_SPEC_DIR` so tests and schema validation can locate the spec files when this repo is checked out alone.

## Examples and validation

npm run cli validate-all

Examples live in examples/golden-path/.

## Semantic layer (Virtuoso)

Use Virtuoso as a real zero-copy semantic layer. See `guides/SEMANTIC_LAYER_VIRTUOSO.md`.

## Semantic layer (Ontop)

Use Ontop for an open-source zero-copy semantic layer. See `guides/SEMANTIC_LAYER_ONTOP.md`.

## Related repositories

- Foundations: https://github.com/markjspivey-xwisee/agent-context-graph-foundations
- Implementation: https://github.com/markjspivey-xwisee/agent-context-graph-implementation

## Agent rules

See AGENTS.md for non-negotiable agent constraints.
