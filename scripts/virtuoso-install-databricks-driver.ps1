param(
  [string]$DriverDir = "drivers/databricks"
)

$deb = Get-ChildItem -Path $DriverDir -Filter *.deb -ErrorAction SilentlyContinue | Select-Object -First 1
$rpm = Get-ChildItem -Path $DriverDir -Filter *.rpm -ErrorAction SilentlyContinue | Select-Object -First 1

if (-not $deb -and -not $rpm) {
  Write-Error "No Databricks ODBC driver found in $DriverDir (.deb or .rpm)."
  exit 1
}

docker compose exec -T -u root virtuoso sh -lc @'
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
'@

if ($deb) {
  $name = $deb.Name
  $check = docker compose exec -T virtuoso sh -lc "test -f /drivers/databricks/$name"
  if ($LASTEXITCODE -ne 0) {
    Write-Error "Driver not found inside container. Recreate the Virtuoso container to pick up the bind mount."
    Write-Host "Try: docker compose --profile semantic-layer up -d --force-recreate virtuoso"
    exit 1
  }
  docker compose exec -T -u root virtuoso sh -lc "dpkg -i /drivers/databricks/$name || apt-get -f install -y"
} else {
  $name = $rpm.Name
  $check = docker compose exec -T virtuoso sh -lc "test -f /drivers/databricks/$name"
  if ($LASTEXITCODE -ne 0) {
    Write-Error "Driver not found inside container. Recreate the Virtuoso container to pick up the bind mount."
    Write-Host "Try: docker compose --profile semantic-layer up -d --force-recreate virtuoso"
    exit 1
  }
  docker compose exec -T -u root virtuoso sh -lc "rpm -i /drivers/databricks/$name || yum install -y /drivers/databricks/$name"
}

Write-Host "Databricks ODBC driver installed inside Virtuoso container."
