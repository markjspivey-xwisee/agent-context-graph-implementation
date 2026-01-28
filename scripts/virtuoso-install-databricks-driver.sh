#!/usr/bin/env bash
set -euo pipefail

driver_dir="drivers/databricks"

deb_file="$(ls "${driver_dir}"/*.deb 2>/dev/null | head -n 1 || true)"
rpm_file="$(ls "${driver_dir}"/*.rpm 2>/dev/null | head -n 1 || true)"

if [[ -z "${deb_file}" && -z "${rpm_file}" ]]; then
  echo "No Databricks ODBC driver found in ${driver_dir} (.deb or .rpm)." >&2
  exit 1
fi

docker compose exec -T -u root virtuoso sh -lc '
set -e
if ! command -v odbcinst >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update && apt-get install -y unixodbc
  elif command -v apk >/dev/null 2>&1; then
    apk add --no-cache unixodbc
  elif command -v yum >/dev/null 2>&1; then
    yum install -y unixODBC
  else
    echo "No supported package manager found to install unixODBC." >&2
    exit 1
  fi
fi
'

if [[ -n "${deb_file}" ]]; then
  deb_name="$(basename "${deb_file}")"
  if ! docker compose exec -T virtuoso sh -lc "test -f /drivers/databricks/${deb_name}"; then
    echo "Driver not found inside container. Recreate the Virtuoso container to pick up the bind mount." >&2
    echo "Try: docker compose --profile semantic-layer up -d --force-recreate virtuoso" >&2
    exit 1
  fi
  docker compose exec -T -u root virtuoso sh -lc "dpkg -i /drivers/databricks/${deb_name} || apt-get -f install -y"
else
  rpm_name="$(basename "${rpm_file}")"
  if ! docker compose exec -T virtuoso sh -lc "test -f /drivers/databricks/${rpm_name}"; then
    echo "Driver not found inside container. Recreate the Virtuoso container to pick up the bind mount." >&2
    echo "Try: docker compose --profile semantic-layer up -d --force-recreate virtuoso" >&2
    exit 1
  fi
  docker compose exec -T -u root virtuoso sh -lc "rpm -i /drivers/databricks/${rpm_name} || yum install -y /drivers/databricks/${rpm_name}"
fi

echo "Databricks ODBC driver installed inside Virtuoso container."
