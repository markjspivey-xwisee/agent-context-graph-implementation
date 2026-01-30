import { readFileSync } from 'fs';
import { resolve } from 'path';

type EvalCase = {
  id: string;
  description?: string;
  query: string;
  expect?: {
    minRows?: number;
    maxRows?: number;
    requiredVars?: string[];
  };
};

type EvalSuite = {
  name?: string;
  cases: EvalCase[];
};

const args = process.argv.slice(2);
const fileArgIndex = args.findIndex(arg => arg === '--file');
const endpointArgIndex = args.findIndex(arg => arg === '--endpoint');

const filePath =
  (fileArgIndex >= 0 ? args[fileArgIndex + 1] : undefined) ??
  process.env.SEMANTIC_LAYER_EVAL_FILE ??
  'examples/semantic-layer/evals/sample.json';

const endpoint =
  (endpointArgIndex >= 0 ? args[endpointArgIndex + 1] : undefined) ??
  process.env.SEMANTIC_LAYER_SPARQL_ENDPOINT ??
  '';

if (!endpoint) {
  console.error('Missing SEMANTIC_LAYER_SPARQL_ENDPOINT or --endpoint.');
  process.exit(1);
}

const suitePath = resolve(filePath);
const suite = JSON.parse(readFileSync(suitePath, 'utf-8')) as EvalSuite;

const failures: string[] = [];

const postQuery = async (query: string) => {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/sparql-query' },
    body: query
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`SPARQL ${res.status}: ${text}`);
  }
  try {
    return JSON.parse(text) as {
      head?: { vars?: string[] };
      results?: { bindings?: Array<Record<string, unknown>> };
    };
  } catch {
    throw new Error(`Invalid JSON response: ${text.slice(0, 200)}`);
  }
};

const run = async () => {
  console.log(`Semantic layer eval: ${suite.name ?? 'unnamed'}`);
  console.log(`Endpoint: ${endpoint}`);
  console.log(`Suite: ${suitePath}`);

  for (const testCase of suite.cases ?? []) {
    const label = testCase.description ? `${testCase.id} (${testCase.description})` : testCase.id;
    try {
      const result = await postQuery(testCase.query);
      const bindings = result.results?.bindings ?? [];
      const vars = result.head?.vars ?? [];

      const minRows = testCase.expect?.minRows ?? 0;
      const maxRows = testCase.expect?.maxRows ?? Number.POSITIVE_INFINITY;
      if (bindings.length < minRows || bindings.length > maxRows) {
        throw new Error(`Row count ${bindings.length} outside ${minRows}-${maxRows}`);
      }

      const requiredVars = testCase.expect?.requiredVars ?? [];
      const missing = requiredVars.filter(v => !vars.includes(v));
      if (missing.length) {
        throw new Error(`Missing variables: ${missing.join(', ')}`);
      }

      console.log(`✔ ${label} (${bindings.length} rows)`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failures.push(`${label}: ${message}`);
      console.error(`✘ ${label}: ${message}`);
    }
  }

  if (failures.length) {
    console.error(`\n${failures.length} failure(s):`);
    failures.forEach(failure => console.error(`- ${failure}`));
    process.exit(1);
  }

  console.log('\nAll semantic layer evals passed.');
};

run().catch(err => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
