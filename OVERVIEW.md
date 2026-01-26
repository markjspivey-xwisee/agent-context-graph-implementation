# Project Overview

Agent Context Graph (ACG) is split into two repos to separate foundations (principles/specs) from implementation (code/tests).

## Navigation map

  [Foundations]
    principles/ -> concepts and invariants
    architecture/ -> system structure and boundaries
    protocol/ -> API-level semantics
    spec/ -> JSON Schema, SHACL, Hydra, ontology

  [Implementation]
    src/ -> broker, orchestrator, services
    examples/ -> golden-path examples
    tests/ -> validation and integration
    guides/ -> build and usage

## How the pieces fit

  Foundations spec/  --->  Implementation runtime
  (schemas, SHACL,         (validation, RDF/JSON-LD,
   ontology, protocol)      broker behavior)

The implementation repo loads specs from the foundations repo. When both repos are cloned side by side, no extra configuration is needed. Otherwise, set ACG_SPEC_DIR to point at the foundations spec directory.

## Key entry points (Foundations)

- principles/README.md
- architecture/ARCHITECTURE_INDEX.md
- protocol/API.md
- spec/context-graph.schema.json
- spec/prov-trace.schema.json
- spec/ontology/acg-core.ttl
- spec/shacl/context.ttl

## Key entry points (Implementation)

- src/broker/context-broker.ts
- src/agents/orchestrator.ts
- src/dashboard/server.ts
- examples/golden-path/
- tests/integration/golden-path.test.ts

## Repos

- Foundations: https://github.com/markjspivey-xwisee/agent-context-graph-foundations
- Implementation: https://github.com/markjspivey-xwisee/agent-context-graph-implementation
