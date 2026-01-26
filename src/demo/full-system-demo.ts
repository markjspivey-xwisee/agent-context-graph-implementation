/**
 * Full System Demo
 *
 * Demonstrates the complete Agent Context Graph system:
 * - RDF-native storage with N3.js triplestore
 * - SPARQL endpoint for trace querying
 * - OPA-style policy enforcement
 * - End-to-end workflow: Planner → Arbiter → Executor → Observer → Archivist
 * - PROV-O provenance traces
 * - Causal do() intervention labels
 */

import { EndToEndWorkflowRunner } from '../workflow/end-to-end-runner.js';
import { sparqlToJson } from '../services/sparql-endpoint.js';

async function runDemo() {
  console.log('');
  console.log('═'.repeat(70));
  console.log('  Agent Context Graph - Full System Demo');
  console.log('═'.repeat(70));
  console.log('');

  // Check for API key
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ERROR: ANTHROPIC_API_KEY environment variable is required');
    console.log('');
    console.log('Set it with:');
    console.log('  export ANTHROPIC_API_KEY=your-key-here');
    console.log('');
    process.exit(1);
  }

  console.log('┌─ System Components ─────────────────────────────────────────────┐');
  console.log('│ • RDF Store (N3.js triplestore)                                 │');
  console.log('│ • SPARQL Endpoint                                               │');
  console.log('│ • OPA Policy Engine                                             │');
  console.log('│ • Context Broker                                                │');
  console.log('│ • End-to-End Workflow Runner                                    │');
  console.log('└──────────────────────────────────────────────────────────────────┘');
  console.log('');

  // Initialize the workflow runner
  console.log('Initializing workflow runner...');
  const runner = new EndToEndWorkflowRunner({
    anthropicApiKey: process.env.ANTHROPIC_API_KEY
  });

  // Set up event listeners
  runner.on('workflow:started', (id, goal) => {
    console.log('');
    console.log('┌─ Workflow Started ──────────────────────────────────────────────┐');
    console.log(`│ ID: ${id.slice(0, 50).padEnd(56)} │`);
    console.log(`│ Goal: ${goal.slice(0, 54).padEnd(54)} │`);
    console.log('└──────────────────────────────────────────────────────────────────┘');
    console.log('');
  });

  runner.on('step:started', (stepId, stepType, description) => {
    const icon = getStepIcon(stepType);
    console.log(`${icon} [${stepType.toUpperCase()}] ${description}`);
  });

  runner.on('step:completed', (stepId) => {
    console.log(`   ✓ Completed`);
  });

  runner.on('step:failed', (stepId, error) => {
    console.log(`   ✗ Failed: ${error}`);
  });

  runner.on('trace:stored', (traceId) => {
    console.log(`   📝 Trace stored: ${traceId.slice(0, 40)}...`);
  });

  runner.on('policy:evaluated', (result) => {
    const status = result.allowed ? '✓' : '✗';
    console.log(`   🛡️ Policy: ${status} (${result.appliedRules} rules evaluated)`);
    if (result.denialReasons.length > 0) {
      result.denialReasons.forEach(r => console.log(`      - ${r}`));
    }
  });

  // Get the goal from command line or use default
  const goal = process.argv[2] ?? 'Analyze market trends and create a summary report';

  console.log('');
  console.log('─'.repeat(70));
  console.log(`Running workflow for: "${goal}"`);
  console.log('─'.repeat(70));

  // Run the workflow
  const result = await runner.runWorkflow(goal, {
    constraints: ['no-destructive-actions', 'require-approval'],
    requiresApproval: true,
    enableCausal: true
  });

  // Display results
  console.log('');
  console.log('═'.repeat(70));
  console.log('  Workflow Results');
  console.log('═'.repeat(70));
  console.log('');

  console.log(`Status: ${result.success ? '✓ SUCCESS' : '✗ FAILED'}`);
  console.log(`Duration: ${result.timing.durationMs}ms`);
  console.log(`Steps completed: ${result.steps.filter(s => s.status === 'completed').length}/${result.steps.length}`);
  console.log(`Traces generated: ${result.traces.length}`);

  // Show step summary
  console.log('');
  console.log('┌─ Step Summary ───────────────────────────────────────────────────┐');
  for (const step of result.steps) {
    const icon = step.status === 'completed' ? '✓' : '✗';
    const type = step.type.toUpperCase().padEnd(8);
    console.log(`│ ${icon} ${type} ${step.description.slice(0, 50).padEnd(52)} │`);
  }
  console.log('└──────────────────────────────────────────────────────────────────┘');

  // Demonstrate SPARQL querying
  console.log('');
  console.log('═'.repeat(70));
  console.log('  SPARQL Query Demonstration');
  console.log('═'.repeat(70));
  console.log('');

  const sparql = runner.getSparqlEndpoint();

  // List available named queries
  console.log('Available named queries:');
  for (const q of sparql.getNamedQueries()) {
    console.log(`  • ${q.name}: ${q.description}`);
  }

  // Run sample queries
  console.log('');
  console.log('─ Query: agent-summary ─');
  const agentSummary = sparql.executeNamedQuery('agent-summary');
  console.log(JSON.stringify(sparqlToJson(agentSummary), null, 2));

  console.log('');
  console.log('─ Query: action-distribution ─');
  const actionDist = sparql.executeNamedQuery('action-distribution');
  console.log(JSON.stringify(sparqlToJson(actionDist), null, 2));

  console.log('');
  console.log('─ Query: causal-interventions ─');
  const causal = sparql.executeNamedQuery('causal-interventions');
  console.log(JSON.stringify(sparqlToJson(causal), null, 2));

  // Show RDF store statistics
  console.log('');
  console.log('═'.repeat(70));
  console.log('  RDF Store Statistics');
  console.log('═'.repeat(70));
  console.log('');

  const stats = runner.getStats();
  console.log(`Quads: ${stats.quads}`);
  console.log(`Traces: ${stats.traces}`);
  console.log(`Agents: ${stats.agents}`);
  console.log(`Named Graphs: ${stats.graphs}`);

  // Export sample Turtle
  console.log('');
  console.log('─ Sample Turtle Export (first 1000 chars) ─');
  const turtle = runner.exportTraces();
  console.log(turtle.slice(0, 1000));
  if (turtle.length > 1000) {
    console.log(`... (${turtle.length - 1000} more characters)`);
  }

  console.log('');
  console.log('═'.repeat(70));
  console.log('  Demo Complete');
  console.log('═'.repeat(70));
  console.log('');

  process.exit(0);
}

function getStepIcon(stepType: string): string {
  switch (stepType) {
    case 'plan': return '📋';
    case 'approve': return '⚖️';
    case 'execute': return '⚡';
    case 'observe': return '👁️';
    case 'archive': return '📦';
    default: return '•';
  }
}

// Handle errors
process.on('unhandledRejection', (err) => {
  console.error('Unhandled error:', err);
  process.exit(1);
});

// Run the demo
runDemo();
