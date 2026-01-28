param(
  [string]$VirtuosoPassword = $env:VIRTUOSO_DBA_PASSWORD
)

if ([string]::IsNullOrWhiteSpace($VirtuosoPassword)) {
  $VirtuosoPassword = 'dba'
}

$mappingPath = "examples/semantic-layer/mapping.ttl"
if (-not (Test-Path $mappingPath)) {
  Write-Error "Missing mapping file: $mappingPath"
  exit 1
}

$mapping = Get-Content -Raw $mappingPath
$mapping = $mapping -replace "'", "''"

$sql = @"
SPARQL CLEAR GRAPH <urn:acg:r2rml:databricks>;
DB.DBA.TTLP('$mapping', '', 'urn:acg:r2rml:databricks');
EXEC ('SPARQL ' || DB.DBA.R2RML_MAKE_QM_FROM_G('urn:acg:r2rml:databricks'));
"@

$sql | docker compose exec -T virtuoso isql 1111 dba $VirtuosoPassword
Write-Host "R2RML mapping loaded into Virtuoso."
