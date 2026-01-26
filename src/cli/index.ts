#!/usr/bin/env node
/**
 * Agent Context Graph CLI
 *
 * Commands:
 *   acg validate <file>        Validate JSON-LD against SHACL shapes
 *   acg validate-all           Validate all examples
 *   acg federate               Show federation status
 *   acg checkpoint list        List checkpoints
 *   acg checkpoint create      Create a checkpoint
 *   acg enclave list           List enclaves
 *   acg enclave create         Create an enclave
 */

import { readFileSync, readdirSync, existsSync } from 'fs';
import { join, resolve, basename } from 'path';
import { SHACLValidatorService } from '../services/shacl-validator.js';
import { FederationService } from '../services/federation-service.js';
import { EnclaveService } from '../services/enclave-service.js';
import { CheckpointStore } from '../services/checkpoint-store.js';
import { resolveSpecPath } from '../utils/spec-path.js';

// ANSI colors for terminal output
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m'
};

function colorize(text: string, color: keyof typeof colors): string {
  return `${colors[color]}${text}${colors.reset}`;
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    printHelp();
    return;
  }

  switch (command) {
    case 'validate':
      await handleValidate(args.slice(1));
      break;
    case 'validate-all':
      await handleValidateAll();
      break;
    case 'federate':
      await handleFederate(args.slice(1));
      break;
    case 'checkpoint':
      await handleCheckpoint(args.slice(1));
      break;
    case 'enclave':
      await handleEnclave(args.slice(1));
      break;
    case 'version':
      console.log('acg version 1.0.0');
      break;
    default:
      console.error(colorize(`Unknown command: ${command}`, 'red'));
      printHelp();
      process.exit(1);
  }
}

function printHelp() {
  console.log(`
${colorize('Agent Context Graph CLI', 'cyan')}

${colorize('USAGE:', 'yellow')}
  acg <command> [options]

${colorize('COMMANDS:', 'yellow')}
  validate <file>          Validate a JSON-LD file against SHACL shapes
  validate-all             Validate all examples in examples/golden-path/
  federate status          Show federation status
  federate trust <did>     Show trust relationship with broker
  checkpoint list          List all checkpoints
  checkpoint info <id>     Show checkpoint details
  enclave list             List all enclaves
  enclave info <id>        Show enclave details
  version                  Show version
  help                     Show this help

${colorize('EXAMPLES:', 'yellow')}
  acg validate examples/golden-path/observer-context.json
  acg validate-all
  acg federate status
  acg checkpoint list

${colorize('ENVIRONMENT:', 'yellow')}
  ACG_SPEC_DIR      Base directory containing spec assets (default: ./spec)
  ACG_SHACL_DIR     Directory containing SHACL shapes (default: ./spec/shacl)
  ACG_EXAMPLES_DIR  Directory containing examples (default: ./examples/golden-path)
`);
}

async function handleValidate(args: string[]) {
  const file = args[0];
  if (!file) {
    console.error(colorize('Error: No file specified', 'red'));
    console.log('Usage: acg validate <file>');
    process.exit(1);
  }

  const filePath = resolve(file);
  if (!existsSync(filePath)) {
    console.error(colorize(`Error: File not found: ${filePath}`, 'red'));
    process.exit(1);
  }

  const shaclDir = process.env.ACG_SHACL_DIR ?? resolveSpecPath('shacl');

  console.log(colorize(`Validating: ${basename(filePath)}`, 'cyan'));
  console.log(colorize(`SHACL shapes: ${shaclDir}`, 'dim'));
  console.log();

  try {
    // Load SHACL shapes
    const validator = new SHACLValidatorService();
    await validator.loadShapesFromDirectory(resolve(shaclDir));

    // Load and parse JSON-LD file
    const content = readFileSync(filePath, 'utf-8');
    const data = JSON.parse(content);

    // Validate
    const result = await validator.validateContextGraph(data);

    if (result.conforms) {
      console.log(colorize('✓ Validation passed', 'green'));
      console.log(colorize(`  Shapes checked: ${validator.getLoadedShapes().length}`, 'dim'));
    } else {
      console.log(colorize('✗ Validation failed', 'red'));
      console.log();
      for (const violation of result.results) {
        console.log(colorize(`  [${violation.resultSeverity}]`, violation.resultSeverity === 'Violation' ? 'red' : 'yellow'));
        console.log(`    Path: ${violation.resultPath ?? 'N/A'}`);
        console.log(`    Message: ${violation.resultMessage}`);
        console.log(`    Shape: ${violation.sourceShape}`);
        if (violation.value) {
          console.log(`    Value: ${violation.value}`);
        }
        console.log();
      }
      process.exit(1);
    }
  } catch (error) {
    console.error(colorize(`Error: ${error instanceof Error ? error.message : String(error)}`, 'red'));
    process.exit(1);
  }
}

async function handleValidateAll() {
  const examplesDir = process.env.ACG_EXAMPLES_DIR ?? './examples/golden-path';
  const shaclDir = process.env.ACG_SHACL_DIR ?? resolveSpecPath('shacl');

  console.log(colorize('Validating all examples', 'cyan'));
  console.log(colorize(`Examples: ${examplesDir}`, 'dim'));
  console.log(colorize(`SHACL shapes: ${shaclDir}`, 'dim'));
  console.log();

  try {
    // Load SHACL shapes
    const validator = new SHACLValidatorService();
    await validator.loadShapesFromDirectory(resolve(shaclDir));
    console.log(colorize(`Loaded ${validator.getLoadedShapes().length} SHACL shapes`, 'dim'));
    console.log();

    // Find all JSON files
    const files = readdirSync(resolve(examplesDir))
      .filter(f => f.endsWith('.json'));

    let passed = 0;
    let failed = 0;
    const failures: Array<{ file: string; violations: number }> = [];

    for (const file of files) {
      const filePath = join(resolve(examplesDir), file);
      const content = readFileSync(filePath, 'utf-8');

      try {
        const data = JSON.parse(content);
        const result = await validator.validateContextGraph(data);

        if (result.conforms) {
          console.log(colorize(`✓ ${file}`, 'green'));
          passed++;
        } else {
          console.log(colorize(`✗ ${file} (${result.results.length} violations)`, 'red'));
          failed++;
          failures.push({ file, violations: result.results.length });
        }
      } catch (parseError) {
        console.log(colorize(`✗ ${file} (parse error)`, 'red'));
        failed++;
        failures.push({ file, violations: -1 });
      }
    }

    console.log();
    console.log(colorize('Summary:', 'cyan'));
    console.log(`  Total: ${files.length}`);
    console.log(colorize(`  Passed: ${passed}`, 'green'));
    if (failed > 0) {
      console.log(colorize(`  Failed: ${failed}`, 'red'));
      console.log();
      console.log(colorize('Failures:', 'yellow'));
      for (const f of failures) {
        console.log(`  - ${f.file}: ${f.violations === -1 ? 'parse error' : `${f.violations} violations`}`);
      }
    }

    if (failed > 0) {
      process.exit(1);
    }
  } catch (error) {
    console.error(colorize(`Error: ${error instanceof Error ? error.message : String(error)}`, 'red'));
    process.exit(1);
  }
}

async function handleFederate(args: string[]) {
  const subcommand = args[0] ?? 'status';

  // Create a federation service instance
  const federation = new FederationService(
    'did:web:broker.example.com',
    'https://broker.example.com/acg/v1'
  );

  switch (subcommand) {
    case 'status': {
      console.log(colorize('Federation Status', 'cyan'));
      console.log();
      const broker = federation.getBrokerInfo();
      console.log(`Broker DID: ${broker.brokerDID}`);
      console.log(`Endpoint: ${broker.serviceEndpoint}`);
      console.log(`Status: ${colorize(broker.status ?? 'Active', 'green')}`);
      console.log(`DID Methods: ${broker.supportedDIDMethods?.join(', ')}`);
      console.log(`Protocols: ${broker.federationProtocols?.join(', ')}`);
      console.log();

      const relationships = federation.getActiveTrustRelationships();
      console.log(colorize(`Trust Relationships: ${relationships.length}`, 'cyan'));
      if (relationships.length === 0) {
        console.log(colorize('  No active trust relationships', 'dim'));
      } else {
        for (const rel of relationships) {
          console.log(`  - ${rel.partnerBrokerDID}`);
          console.log(`    Trust Level: ${rel.trustLevel}`);
          console.log(`    Protocols: ${rel.protocols.join(', ')}`);
          console.log(`    Established: ${rel.establishedAt}`);
        }
      }
      break;
    }

    case 'trust': {
      const did = args[1];
      if (!did) {
        console.error(colorize('Error: No broker DID specified', 'red'));
        console.log('Usage: acg federate trust <broker-did>');
        process.exit(1);
      }

      const trust = federation.getTrustRelationship(did);
      if (!trust) {
        console.log(colorize(`No trust relationship with ${did}`, 'yellow'));
      } else {
        console.log(colorize('Trust Relationship', 'cyan'));
        console.log(`  ID: ${trust.id}`);
        console.log(`  Partner: ${trust.partnerBrokerDID}`);
        console.log(`  Trust Level: ${trust.trustLevel}`);
        console.log(`  Status: ${trust.status === 'active' ? colorize('active', 'green') : colorize(trust.status, 'red')}`);
        console.log(`  Protocols: ${trust.protocols.join(', ')}`);
        console.log(`  Established: ${trust.establishedAt}`);
        if (trust.expiresAt) {
          console.log(`  Expires: ${trust.expiresAt}`);
        }
        console.log(`  Credential Bridges: ${trust.credentialBridges.length}`);
        for (const bridge of trust.credentialBridges) {
          console.log(`    - ${bridge.fromDomain} → ${bridge.toDomain}`);
        }
      }
      break;
    }

    default:
      console.error(colorize(`Unknown federate subcommand: ${subcommand}`, 'red'));
      console.log('Usage: acg federate [status|trust <did>]');
      process.exit(1);
  }
}

async function handleCheckpoint(args: string[]) {
  const subcommand = args[0] ?? 'list';

  const store = new CheckpointStore();
  await store.initialize();

  switch (subcommand) {
    case 'list': {
      console.log(colorize('Checkpoints', 'cyan'));
      console.log();

      // Get all checkpoints (would need to expose this method)
      // For now, show placeholder
      console.log(colorize('  No checkpoints found', 'dim'));
      console.log(colorize('  Use the broker API to create checkpoints', 'dim'));
      break;
    }

    case 'info': {
      const id = args[1];
      if (!id) {
        console.error(colorize('Error: No checkpoint ID specified', 'red'));
        console.log('Usage: acg checkpoint info <id>');
        process.exit(1);
      }

      const checkpoint = store.getCheckpoint(id);
      if (!checkpoint) {
        console.log(colorize(`Checkpoint not found: ${id}`, 'yellow'));
      } else {
        console.log(colorize('Checkpoint', 'cyan'));
        console.log(`  ID: ${checkpoint.id}`);
        console.log(`  Context: ${checkpoint.contextGraphId}`);
        console.log(`  Agent: ${checkpoint.agentDID}`);
        console.log(`  Label: ${checkpoint.label ?? 'N/A'}`);
        console.log(`  Timestamp: ${checkpoint.timestamp}`);
        console.log(`  Hash: ${checkpoint.contentHash}`);
        if (checkpoint.supersedes) {
          console.log(`  Supersedes: ${checkpoint.supersedes}`);
        }
      }
      break;
    }

    default:
      console.error(colorize(`Unknown checkpoint subcommand: ${subcommand}`, 'red'));
      console.log('Usage: acg checkpoint [list|info <id>]');
      process.exit(1);
  }
}

async function handleEnclave(args: string[]) {
  const subcommand = args[0] ?? 'list';

  const service = new EnclaveService();
  await service.initialize();

  switch (subcommand) {
    case 'list': {
      console.log(colorize('Enclaves', 'cyan'));
      console.log();

      const active = service.getActiveEnclaves();
      if (active.length === 0) {
        console.log(colorize('  No active enclaves', 'dim'));
      } else {
        for (const enclave of active) {
          console.log(`  ${enclave.id}`);
          console.log(`    Name: ${enclave.name}`);
          console.log(`    Status: ${colorize(enclave.status, enclave.status === 'active' ? 'green' : 'yellow')}`);
          console.log(`    Agent: ${enclave.boundAgentDID}`);
          console.log(`    Path: ${enclave.worktreePath}`);
          console.log();
        }
      }
      break;
    }

    case 'info': {
      const id = args[1];
      if (!id) {
        console.error(colorize('Error: No enclave ID specified', 'red'));
        console.log('Usage: acg enclave info <id>');
        process.exit(1);
      }

      const enclave = service.getEnclave(id);
      if (!enclave) {
        console.log(colorize(`Enclave not found: ${id}`, 'yellow'));
      } else {
        console.log(colorize('Enclave', 'cyan'));
        console.log(`  ID: ${enclave.id}`);
        console.log(`  Name: ${enclave.name}`);
        console.log(`  Status: ${enclave.status}`);
        console.log(`  Agent: ${enclave.boundAgentDID}`);
        console.log(`  Repository: ${enclave.repository}`);
        console.log(`  Branch: ${enclave.enclaveBranch}`);
        console.log(`  Path: ${enclave.worktreePath}`);
        console.log(`  Created: ${enclave.createdAt}`);
        if (enclave.sealedAt) {
          console.log(`  Sealed: ${enclave.sealedAt}`);
        }
        if (enclave.scope.length > 0) {
          console.log(`  Scope: ${enclave.scope.join(', ')}`);
        }
      }
      break;
    }

    default:
      console.error(colorize(`Unknown enclave subcommand: ${subcommand}`, 'red'));
      console.log('Usage: acg enclave [list|info <id>]');
      process.exit(1);
  }
}

// Run CLI
main().catch(error => {
  console.error(colorize(`Fatal error: ${error.message}`, 'red'));
  process.exit(1);
});
