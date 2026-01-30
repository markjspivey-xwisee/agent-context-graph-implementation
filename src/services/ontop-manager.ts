import { execFile } from 'child_process';
import { existsSync } from 'fs';
import { createHash } from 'crypto';
import { resolve } from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface OntopManagerConfig {
  image: string;
  jdbcDir: string;
  host: string;
}

export interface OntopContainerInfo {
  containerId: string;
  containerName: string;
  hostPort: string;
  endpoint: string;
  mappingHash: string;
}

function hashFileContents(contents: string): string {
  return createHash('sha256').update(contents).digest('hex');
}

async function runDocker(args: string[], timeoutMs = 60000): Promise<string> {
  const result = await execFileAsync('docker', args, { timeout: timeoutMs });
  return (result.stdout ?? '').toString().trim();
}

async function inspectContainer(name: string): Promise<any | null> {
  try {
    const raw = await runDocker(['inspect', name], 30000);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed[0] : null;
  } catch {
    return null;
  }
}

export class OntopManager {
  private readonly image: string;
  private readonly jdbcDir: string;
  private readonly host: string;

  constructor(config: OntopManagerConfig) {
    this.image = config.image;
    this.jdbcDir = config.jdbcDir;
    this.host = config.host;
  }

  private containerNameFor(sourceId: string) {
    return `acg-ontop-${sourceId}`;
  }

  async ensureRunning(params: {
    sourceId: string;
    mappingPath: string;
    mappingContents: string;
    jdbcUrl: string;
    driverClass: string;
    user: string;
    password: string;
    previousHash?: string;
    jdbcDirOverride?: string;
  }): Promise<OntopContainerInfo> {
    const mappingHash = hashFileContents(params.mappingContents);
    const containerName = this.containerNameFor(params.sourceId);

    const jdbcDir = resolve(params.jdbcDirOverride ?? this.jdbcDir);
    if (!existsSync(jdbcDir)) {
      throw new Error(`Ontop JDBC driver directory not found: ${jdbcDir}`);
    }

    const mappingPath = resolve(params.mappingPath);
    const existing = await inspectContainer(containerName);
    const mappingChanged = params.previousHash && params.previousHash !== mappingHash;

    if (existing && mappingChanged) {
      await runDocker(['rm', '-f', containerName], 60000);
    }

    const afterRemoval = mappingChanged ? null : existing;

    if (!afterRemoval) {
      await runDocker([
        'run', '-d',
        '--name', containerName,
        '-p', '0:8080',
        '-e', 'ONTOP_MAPPING_FILE=/opt/ontop/mapping.ttl',
        '-e', `ONTOP_DB_URL=${params.jdbcUrl}`,
        '-e', `ONTOP_DB_DRIVER=${params.driverClass}`,
        '-e', `ONTOP_DB_USER=${params.user}`,
        '-e', `ONTOP_DB_PASSWORD=${params.password}`,
        '-v', `${mappingPath}:/opt/ontop/mapping.ttl:ro`,
        '-v', `${jdbcDir}:/opt/ontop/jdbc:ro`,
        this.image
      ], 120000);
    } else if (!afterRemoval.State?.Running) {
      await runDocker(['start', containerName], 60000);
    }

    const inspected = await inspectContainer(containerName);
    if (!inspected) {
      throw new Error(`Failed to inspect Ontop container '${containerName}' after start.`);
    }

    const ports = inspected.NetworkSettings?.Ports?.['8080/tcp'];
    const hostPort = Array.isArray(ports) && ports[0]?.HostPort ? ports[0].HostPort : null;
    if (!hostPort) {
      throw new Error(`Ontop container '${containerName}' did not expose a host port.`);
    }

    const endpoint = `http://${this.host}:${hostPort}/sparql`;

    return {
      containerId: inspected.Id,
      containerName,
      hostPort,
      endpoint,
      mappingHash
    };
  }

  async remove(sourceId: string): Promise<boolean> {
    const containerName = this.containerNameFor(sourceId);
    const existing = await inspectContainer(containerName);
    if (!existing) return false;
    await runDocker(['rm', '-f', containerName], 60000);
    return true;
  }
}
