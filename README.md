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

## CI note (foundations spec)

CI clones the foundations repo and sets `ACG_SPEC_DIR` so tests and schema validation can locate the spec files when this repo is checked out alone.

## Examples and validation

npm run cli validate-all

Examples live in examples/golden-path/.

## Related repositories

- Foundations: https://github.com/markjspivey-xwisee/agent-context-graph-foundations
- Implementation: https://github.com/markjspivey-xwisee/agent-context-graph-implementation

## Agent rules

See AGENTS.md for non-negotiable agent constraints.
