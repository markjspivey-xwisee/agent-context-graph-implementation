#!/usr/bin/env bash
set -euo pipefail

if [[ -f ".env" ]]; then
  while IFS= read -r raw_line; do
    line="${raw_line%%#*}"
    line="$(echo "$line" | xargs)"
    [[ -z "$line" ]] && continue
    [[ "$line" == export* ]] && line="${line#export }"
    key="${line%%=*}"
    value="${line#*=}"
    value="${value%\"}"
    value="${value#\"}"
    value="${value%\'}"
    value="${value#\'}"
    case "$key" in
      DATABRICKS_HOST) DATABRICKS_HOST="$value" ;;
      DATABRICKS_HTTP_PATH) DATABRICKS_HTTP_PATH="$value" ;;
      DATABRICKS_TOKEN) DATABRICKS_TOKEN="$value" ;;
    esac
  done < .env
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

echo "DATABRICKS_JDBC_URL='${jdbc_url}'"
