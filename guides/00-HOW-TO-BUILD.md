# How to Build This System (In Order)

This document defines the only supported build sequence.

---

## Phase 1 — Contracts First (No Code)

1. Implement:
   - `context-graph.schema.json`
   - AAT JSON specs
   - PROV trace schema
2. Validate golden-path JSON against schemas
3. Write SHACL safety shapes

**Stop if schemas are unstable.**

---

## Phase 2 — Context Broker (Read-Only)

1. Implement `/context` endpoint
2. Verify DID proof-of-control (stub allowed)
3. Verify VCs (stub allowed)
4. Return golden-path Context Graph fragment

**No execution yet.**

---

## Phase 3 — Traversal + Trace

1. Implement `/traverse`
2. Validate:
   - affordance exists
   - parameters conform
   - credentials match
3. Emit PROV trace
4. Forward to mock target

---

## Phase 4 — Negative Cases

- Missing VC
- Stale context
- Forbidden action type
- Missing trace

System must fail safely.

---

## Phase 5 — Causal & Policy Hooks

- Wire `ICausalEvaluator`
- Wire `IPolicyEngine`
- Block traversal on policy violation

---

## Phase 6 — Telemetry for Semiotics

- Log affordance usage
- Log outcomes
- Log label versions

No learning required yet — just observability.

---

## Success Criteria

- System never executes an unafforded action
- System never acts without trace
- System behavior is explainable via graphs
