param(
  [string]$VirtuosoPassword = $env:VIRTUOSO_DBA_PASSWORD
)

if ([string]::IsNullOrWhiteSpace($VirtuosoPassword)) {
  $VirtuosoPassword = 'dba'
}

docker compose exec -T virtuoso isql 1111 dba $VirtuosoPassword < scripts/virtuoso-load-r2rml.sql
Write-Host "R2RML mapping loaded into Virtuoso."
