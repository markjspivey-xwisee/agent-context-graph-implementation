#!/usr/bin/env bash
set -euo pipefail

VIRTUOSO_PASSWORD="${VIRTUOSO_DBA_PASSWORD:-dba}"
MAPPING_PATH="examples/semantic-layer/mapping.ttl"

if [[ ! -f "$MAPPING_PATH" ]]; then
  echo "Missing mapping file: $MAPPING_PATH" >&2
  exit 1
fi

tmp_sql="$(mktemp)"
python - <<'PY' > "$tmp_sql"
from pathlib import Path

mapping = Path("examples/semantic-layer/mapping.ttl").read_text()
mapping = mapping.replace("'", "''")

print("SPARQL CLEAR GRAPH <urn:acg:r2rml:databricks>;")
print(f"DB.DBA.TTLP('{mapping}', '', 'urn:acg:r2rml:databricks');")
print("EXEC ('SPARQL ' || DB.DBA.R2RML_MAKE_QM_FROM_G('urn:acg:r2rml:databricks'));")
PY

docker compose exec -T virtuoso isql 1111 dba "${VIRTUOSO_PASSWORD}" < "$tmp_sql"
rm -f "$tmp_sql"
echo "R2RML mapping loaded into Virtuoso."
