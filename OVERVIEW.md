# Project Overview (Implementation)

This repo is the operational implementation of Agent Context Graph (ACG). It turns the foundations contract into running systems, demos, and tests. It is written for principal engineers and engineering managers who need to understand runtime responsibilities, extension points, and operational posture.

## Executive summary

ACG exposes an ephemeral Context Graph to agents at runtime and references a persistent Knowledge Graph for long-term memory. A HyprCat-aligned Hydra semantic catalog exposes data products and SHACL contracts for semantic queries. The broker generates affordances based on credentials, policies, and current state, and emits PROV traces for every traversal. The implementation respects the foundations contract (schemas, SHACL, ontology, and protocol) and keeps examples and tests aligned with those specs, including tool authoring endpoints.

## Zero-copy semantic layer (Databricks example)

When a data source like Databricks is used, ACG treats it as an **adapter example**, not a protocol primitive. The canonical path is a **virtual zero-copy semantic layer** that:
- Exposes a SPARQL endpoint over the source
- Uses R2RML/OBDA mappings to translate SPARQL to Databricks SQL at query time
- Publishes HyprCat-aligned DCAT/DPROD metadata, Hydra affordances, and SHACL contracts

This preserves Databricks as the source of truth and keeps ACG runtime storage free of copied data.

## Runtime shape (mermaid)

```mermaid
flowchart LR
  Agent -->|/context| Broker
  Broker --> AAT[AAT Registry]
  Broker --> Policy[Policy Engine]
  Broker --> KG[Knowledge Graph Service]
  Broker --> Tools[Tool Registry]
  Broker -->|Context Graph + KG ref| Agent
  Agent -->|/traverse| Broker
  Broker --> Trace[Trace Store]
  Broker --> Outcome[Execution Result]
```

## Request/trace flow (mermaid)

```mermaid
sequenceDiagram
  participant Agent
  participant Broker
  participant Policy
  participant AAT
  participant Trace
  Agent->>Broker: POST /context (credentials)
  Broker->>AAT: Check action space
  Broker->>Policy: Evaluate constraints
  Broker-->>Agent: Context Graph (affordances + KG ref)
  Agent->>Broker: POST /traverse (affordance)
  Broker->>Trace: Emit PROV + usageEvent
  Broker-->>Agent: Outcome
```

## How foundations are consumed

The implementation loads schemas and shapes from the foundations repo. If both repos are cloned side by side, the resolver locates them automatically. Otherwise, set ACG_SPEC_DIR to the foundations spec directory.

CI clones the foundations repo and sets ACG_SPEC_DIR so tests and schema validation can run in isolation.

## Repo map

- src/        Core services, broker, orchestrator, and runtime
- examples/   Golden-path examples and demos
- tests/      Unit and integration tests
- guides/     Build and usage guides

## Key entry points (Implementation)

- src/broker/context-broker.ts
- src/agents/orchestrator.ts
- src/dashboard/server.ts
- examples/golden-path/
- tests/integration/golden-path.test.ts

## Operational considerations

- Validation: SHACL and JSON Schema enforce contract compliance.
- Traceability: All traversals emit PROV traces.
- Policy and credential gating: affordances are filtered by policy and VCs.
- Concurrency: AAT rules restrict parallelism and conflict.
- Security: external actions should be isolated and credential-gated.

## Extension points

- Add new AAT definitions in foundations spec/aat.
- Add affordance types in foundations ontology and protocol docs.
- Extend policy rules or AAT composition rules in code.
- Add new demos/examples that conform to the specs.
- Register tools via /broker/tools and surface them as affordances.
- Add knowledge graph mappings and query endpoints for domain data.
- Extend the semantic catalog with additional data products and contracts.

## Repos

- Foundations: https://github.com/markjspivey-xwisee/agent-context-graph-foundations
- Implementation: https://github.com/markjspivey-xwisee/agent-context-graph-implementation
