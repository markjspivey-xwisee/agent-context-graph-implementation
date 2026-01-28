#!/usr/bin/env bash
set -euo pipefail

VIRTUOSO_PASSWORD="${VIRTUOSO_DBA_PASSWORD:-dba}"

docker compose exec -T virtuoso isql 1111 dba "${VIRTUOSO_PASSWORD}" < scripts/virtuoso-load-r2rml.sql
echo "R2RML mapping loaded into Virtuoso."
