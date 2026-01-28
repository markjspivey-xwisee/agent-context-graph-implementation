-- Load R2RML mappings into Virtuoso and generate quad maps.
-- Expects mapping TTL at /database/mappings/mapping.ttl (mounted via docker-compose).

SPARQL CLEAR GRAPH <urn:acg:r2rml:databricks>;
DB.DBA.TTLP_FILE('/database/mappings/mapping.ttl', '', 'urn:acg:r2rml:databricks');
EXEC ('SPARQL ' || DB.DBA.R2RML_MAKE_QM_FROM_G('urn:acg:r2rml:databricks'));
