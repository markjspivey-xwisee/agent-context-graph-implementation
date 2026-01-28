#!/usr/bin/env bash
set -euo pipefail

VIRTUOSO_PASSWORD="${VIRTUOSO_DBA_PASSWORD:-dba}"
MAPPING_PATH="examples/semantic-layer/mapping.ttl"

if [[ ! -f "$MAPPING_PATH" ]]; then
  echo "Missing mapping file: $MAPPING_PATH" >&2
  exit 1
fi

tmp_sql="$(mktemp)"
node - <<'NODE' > "$tmp_sql"
const fs = require('fs');

let mapping = fs.readFileSync('examples/semantic-layer/mapping.ttl', 'utf8');
mapping = mapping.replace(/'/g, "''");

console.log('SPARQL CLEAR GRAPH <urn:acg:r2rml:databricks>;');
console.log(`DB.DBA.TTLP('${mapping}', '', 'urn:acg:r2rml:databricks');`);
console.log("EXEC ('SPARQL ' || DB.DBA.R2RML_MAKE_QM_FROM_G('urn:acg:r2rml:databricks'));");
NODE

docker compose exec -T virtuoso isql 1111 dba "${VIRTUOSO_PASSWORD}" < "$tmp_sql"
rm -f "$tmp_sql"
echo "R2RML mapping loaded into Virtuoso."
