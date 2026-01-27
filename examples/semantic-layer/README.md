# Semantic Layer Catalog Example

This folder provides a minimal, generic example of a **HyprCat-aligned, Hydra-enabled semantic catalog**
using **HyprCat-aligned DCAT + DPROD** metadata and **SHACL-based data contracts**. It is intentionally
source-agnostic; concrete adapters belong in examples that target specific systems.

## Files

- `catalog.jsonld` — Hydra-enabled DCAT/DPROD catalog (HyprCat-aligned)
- `data-products.jsonld` — Hydra collection of data products
- `contracts.jsonld` — Hydra collection of SHACL-based data contracts
- `contract-shape.ttl` — Example SHACL shape referenced by a contract
- `mapping.ttl` — Example R2RML mapping (generic)

These files are served by the dev API:
- `GET /data/catalog`
- `GET /data/products`
- `GET /data/contracts`
- `GET /data/contracts/{id}/shape`
