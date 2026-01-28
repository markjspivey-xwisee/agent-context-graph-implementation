#!/usr/bin/env bash
set -euo pipefail

if [[ -f ".env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

HOST="${DATABRICKS_HOST:-}"
HTTP_PATH="${DATABRICKS_HTTP_PATH:-}"
TOKEN="${DATABRICKS_TOKEN:-}"

if [[ -z "${HOST}" || -z "${HTTP_PATH}" || -z "${TOKEN}" ]]; then
  echo "Missing DATABRICKS_HOST, DATABRICKS_HTTP_PATH, or DATABRICKS_TOKEN in environment or .env." >&2
  exit 1
fi

host_clean="${HOST#http://}"
host_clean="${host_clean#https://}"
host_clean="${host_clean%/}"

jdbc_url="jdbc:databricks://${host_clean}:443/default;transportMode=http;ssl=1;httpPath=${HTTP_PATH};AuthMech=3;UID=token;PWD=${TOKEN}"

echo "DATABRICKS_JDBC_URL=${jdbc_url}"
