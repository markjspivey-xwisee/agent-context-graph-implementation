#!/usr/bin/env bash
set -euo pipefail

if [[ -f ".env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

DSN_NAME="${DATABRICKS_ODBC_DSN:-Databricks}"
HOST="${DATABRICKS_HOST:-}"
HTTP_PATH="${DATABRICKS_HTTP_PATH:-}"
TOKEN="${DATABRICKS_TOKEN:-}"
DRIVER_PATH="${DATABRICKS_ODBC_DRIVER_PATH:-/opt/simba/spark/lib/64/libSparkODBC_sb64.so}"

if [[ -z "${HOST}" || -z "${HTTP_PATH}" || -z "${TOKEN}" ]]; then
  echo "Missing DATABRICKS_HOST, DATABRICKS_HTTP_PATH, or DATABRICKS_TOKEN in environment or .env." >&2
  exit 1
fi

docker compose exec -T -u root virtuoso sh -lc "cat > /etc/odbcinst.ini <<'EOF'
[Databricks]
Description=Databricks Simba ODBC Driver
Driver=${DRIVER_PATH}
EOF"

docker compose exec -T -u root virtuoso sh -lc "cat > /etc/odbc.ini <<'EOF'
[${DSN_NAME}]
Driver=Databricks
Host=${HOST}
Port=443
HTTPPath=${HTTP_PATH}
AuthMech=3
UID=token
PWD=${TOKEN}
SSL=1
ThriftTransport=2
SparkServerType=3
EOF"

echo "Databricks ODBC DSN '${DSN_NAME}' configured in Virtuoso container."
