param(
  [string]$Host = $env:DATABRICKS_HOST,
  [string]$HttpPath = $env:DATABRICKS_HTTP_PATH,
  [string]$Token = $env:DATABRICKS_TOKEN
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

  if (-not $Host) { $Host = $env:DATABRICKS_HOST }
  if (-not $HttpPath) { $HttpPath = $env:DATABRICKS_HTTP_PATH }
  if (-not $Token) { $Token = $env:DATABRICKS_TOKEN }
}

if ([string]::IsNullOrWhiteSpace($Host) -or [string]::IsNullOrWhiteSpace($HttpPath) -or [string]::IsNullOrWhiteSpace($Token)) {
  Write-Error "Missing DATABRICKS_HOST, DATABRICKS_HTTP_PATH, or DATABRICKS_TOKEN in environment or .env."
  exit 1
}

$hostClean = $Host -replace '^https?://', ''
$hostClean = $hostClean.TrimEnd('/')

$jdbcUrl = "jdbc:databricks://$hostClean:443/default;transportMode=http;ssl=1;httpPath=$HttpPath;AuthMech=3;UID=token;PWD=$Token"

Write-Output "DATABRICKS_JDBC_URL='$jdbcUrl'"
