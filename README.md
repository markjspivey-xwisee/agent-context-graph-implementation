# Agent Context Graph Implementation

Reference implementation, demos, tests, and examples for Agent Context Graph (ACG).

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

## Quick start

npm install
npm run build
npm run dashboard

## CI note (foundations spec)

CI clones the foundations repo and sets `ACG_SPEC_DIR` so tests and schema validation can locate the spec files when this repo is checked out alone.

## Examples and validation

npm run cli validate-all

Examples live in examples/golden-path/.

## Agent rules

See AGENTS.md for non-negotiable agent constraints.
