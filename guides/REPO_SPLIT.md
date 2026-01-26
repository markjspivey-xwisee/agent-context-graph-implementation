# Repository Split Guide

This project can be split into two repositories for clarity:

## 1) `agent-context-graph-foundations`
**Contents:** principles, architecture, protocol, and spec layers.

Suggested paths:
- `principles/`
- `architecture/`
- `protocol/`
- `spec/`
- `AGENTS.md`
- `README.md` (foundations-focused)

## 2) `agent-context-graph-implementation`
**Contents:** reference implementation, demos, tests, and examples.

Suggested paths:
- `src/`
- `examples/`
- `tests/`
- `dist/` (optional)
- `package.json`, `package-lock.json`, `tsconfig.json`, `vitest.config.ts`
- `README.md` (implementation-focused)

## Recommended Split (git subtree)

From the current repo root:

```bash
# Foundations
mkdir -p /tmp/acg-foundations

git subtree split --prefix principles -b split/principles

git subtree split --prefix architecture -b split/architecture

git subtree split --prefix protocol -b split/protocol

git subtree split --prefix spec -b split/spec

# Create a new repo and merge subtrees (example)
# git init /tmp/acg-foundations
# cd /tmp/acg-foundations
# git remote add origin <foundations-repo-url>
# git merge ../agentcontextgraph split/principles
# git merge ../agentcontextgraph split/architecture
# git merge ../agentcontextgraph split/protocol
# git merge ../agentcontextgraph split/spec
```

## Alternative (keep monorepo)

If you prefer a single repo, keep the layered directories and add:
- `implementations/README.md` (already present)
- `docs/README.md` (legacy pointer)

## Notes

- Ensure `.env` is never committed (already in `.gitignore`).
- Keep examples in the implementation repo so agents can validate the foundations.
- If you want me to execute the split, provide the repo URLs; I will not use tokens from chat.
