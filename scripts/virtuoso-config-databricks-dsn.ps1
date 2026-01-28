param(
  [string]$DsnName = $env:DATABRICKS_ODBC_DSN,
  [string]$Host = $env:DATABRICKS_HOST,
  [string]$HttpPath = $env:DATABRICKS_HTTP_PATH,
  [string]$Token = $env:DATABRICKS_TOKEN,
  [string]$DriverPath = $env:DATABRICKS_ODBC_DRIVER_PATH
)

if (Test-Path ".env") {
  Get-Content ".env" | ForEach-Object {
    if ($_ -match '^\s*#') { return }
    if ($_ -match '^\s*$') { return }
    $parts = $_.Split('=', 2)
    if ($parts.Length -ne 2) { return }
    $key = $parts[0].Trim()
    $val = $parts[1].Trim().Trim('"').Trim("'")
    if (-not $env:$key) { $env:$key = $val }
  }
}

if ([string]::IsNullOrWhiteSpace($DsnName)) { $DsnName = "Databricks" }
if ([string]::IsNullOrWhiteSpace($DriverPath)) { $DriverPath = "/opt/simba/spark/lib/64/libSparkODBC_sb64.so" }

if ([string]::IsNullOrWhiteSpace($Host) -or [string]::IsNullOrWhiteSpace($HttpPath) -or [string]::IsNullOrWhiteSpace($Token)) {
  Write-Error "Missing DATABRICKS_HOST, DATABRICKS_HTTP_PATH, or DATABRICKS_TOKEN in environment or .env."
  exit 1
}

$odbcinst = @"
[Databricks]
Description=Databricks Simba ODBC Driver
Driver=$DriverPath
"@

$odbc = @"
[$DsnName]
Driver=Databricks
Host=$Host
Port=443
HTTPPath=$HttpPath
AuthMech=3
UID=token
PWD=$Token
SSL=1
ThriftTransport=2
SparkServerType=3
"@

$odbcinst | docker compose exec -T -u root virtuoso sh -lc "cat > /etc/odbcinst.ini"
$odbc | docker compose exec -T -u root virtuoso sh -lc "cat > /etc/odbc.ini"

Write-Host "Databricks ODBC DSN '$DsnName' configured in Virtuoso container."
