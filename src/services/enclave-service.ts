import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';

const execAsync = promisify(exec);

/**
 * Execution Enclave - Isolated git worktree environment for an agent
 * Inspired by Gas Town's worktree isolation pattern
 */
export interface ExecutionEnclave {
  id: string;                      // urn:enclave:{uuid}
  boundAgentDID: string;           // Agent DID that owns this enclave
  name: string;                    // Human-readable name
  repository: string;              // Base repository URL
  baseBranch: string;              // Branch the worktree is based on
  enclaveBranch: string;           // Unique branch for this enclave
  worktreePath: string;            // Absolute path to the worktree
  status: 'active' | 'sealed' | 'destroyed';
  scope: string[];                 // Resource URNs this enclave can access
  createdAt: string;               // ISO timestamp
  sealedAt?: string;               // ISO timestamp when sealed
  destroyedAt?: string;            // ISO timestamp when destroyed
  createdByTrace?: string;         // PROV trace ID that created it
  ttlSeconds?: number;             // Time-to-live (0 = no expiration)
}

/**
 * Parameters for creating an enclave
 */
export interface CreateEnclaveParams {
  agentDID: string;
  repository: string;
  baseBranch?: string;
  enclaveName?: string;
  scope?: string[];
  ttlSeconds?: number;
}

/**
 * Parameters for sealing an enclave
 */
export interface SealEnclaveParams {
  enclaveId: string;
  preserveState?: boolean;
  reason?: string;
}

/**
 * Parameters for destroying an enclave
 */
export interface DestroyEnclaveParams {
  enclaveId: string;
  force?: boolean;
  archiveFirst?: boolean;
}

/**
 * Result of an enclave operation
 */
export interface EnclaveOperationResult {
  success: boolean;
  enclave?: ExecutionEnclave;
  error?: string;
  traceId?: string;
}

/**
 * EnclaveService manages isolated execution environments (git worktrees)
 * for agents, providing Gas Town-inspired isolation with ACG's principled
 * DID binding and PROV tracing.
 */
export class EnclaveService {
  private enclaves: Map<string, ExecutionEnclave> = new Map();
  private baseDir: string;
  private traceEmitter?: (trace: Record<string, unknown>) => void;

  constructor(baseDir: string = './.enclaves') {
    this.baseDir = path.resolve(baseDir);
  }

  /**
   * Set a trace emitter function for PROV trace generation
   */
  setTraceEmitter(emitter: (trace: Record<string, unknown>) => void): void {
    this.traceEmitter = emitter;
  }

  /**
   * Initialize the enclave service
   */
  async initialize(): Promise<void> {
    await fs.mkdir(this.baseDir, { recursive: true });
  }

  /**
   * Create a new execution enclave for an agent
   */
  async createEnclave(params: CreateEnclaveParams): Promise<EnclaveOperationResult> {
    const enclaveId = `urn:enclave:${crypto.randomUUID()}`;
    const timestamp = new Date().toISOString();
    const baseBranch = params.baseBranch ?? 'main';
    const shortId = enclaveId.split(':').pop()!.slice(0, 8);
    const agentShortId = params.agentDID.split(':').pop()!.slice(0, 8);
    const enclaveBranch = `enclave/${agentShortId}/${shortId}`;
    const enclaveName = params.enclaveName ?? `enclave-${shortId}`;
    const worktreePath = path.join(this.baseDir, shortId);

    try {
      // Create the enclave directory
      await fs.mkdir(worktreePath, { recursive: true });

      // Clone the repository into a bare repo if not exists
      const bareRepoPath = path.join(this.baseDir, '.repos', this.repoHash(params.repository));
      await fs.mkdir(path.dirname(bareRepoPath), { recursive: true });

      const bareRepoExists = await this.pathExists(bareRepoPath);
      if (!bareRepoExists) {
        await execAsync(`git clone --bare "${params.repository}" "${bareRepoPath}"`);
      } else {
        // Fetch latest
        await execAsync(`git -C "${bareRepoPath}" fetch origin`);
      }

      // Create a new branch for this enclave
      await execAsync(
        `git -C "${bareRepoPath}" branch "${enclaveBranch}" "origin/${baseBranch}"`,
        { timeout: 30000 }
      ).catch(() => {
        // Branch might already exist, ignore error
      });

      // Create the worktree
      await execAsync(
        `git -C "${bareRepoPath}" worktree add "${worktreePath}" "${enclaveBranch}"`,
        { timeout: 60000 }
      );

      const enclave: ExecutionEnclave = {
        id: enclaveId,
        boundAgentDID: params.agentDID,
        name: enclaveName,
        repository: params.repository,
        baseBranch,
        enclaveBranch,
        worktreePath,
        status: 'active',
        scope: params.scope ?? [],
        createdAt: timestamp,
        ttlSeconds: params.ttlSeconds,
      };

      this.enclaves.set(enclaveId, enclave);

      // Emit PROV trace
      const traceId = `urn:trace:${crypto.randomUUID()}`;
      enclave.createdByTrace = traceId;

      if (this.traceEmitter) {
        this.traceEmitter({
          '@context': [
            'https://www.w3.org/ns/prov#',
            'https://agentcontextgraph.dev/context/v1'
          ],
          id: traceId,
          type: ['prov:Activity', 'acg:CreateEnclaveActivity'],
          'prov:startedAtTime': timestamp,
          'prov:endedAtTime': new Date().toISOString(),
          'prov:wasAssociatedWith': {
            type: 'acg:Agent',
            'acg:hasDID': params.agentDID
          },
          'prov:generated': {
            type: 'acg:ExecutionEnclave',
            id: enclaveId,
            'acg:enclaveWorktree': worktreePath,
            'acg:enclaveBranch': enclaveBranch
          },
          'prov:used': {
            'params:repository': params.repository,
            'params:baseBranch': baseBranch
          }
        });
      }

      return {
        success: true,
        enclave,
        traceId
      };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        error: `Failed to create enclave: ${errorMessage}`
      };
    }
  }

  /**
   * Seal an enclave (make read-only, preserve work)
   */
  async sealEnclave(params: SealEnclaveParams): Promise<EnclaveOperationResult> {
    const enclave = this.enclaves.get(params.enclaveId);
    if (!enclave) {
      return { success: false, error: `Enclave not found: ${params.enclaveId}` };
    }

    if (enclave.status !== 'active') {
      return { success: false, error: `Enclave is not active: ${enclave.status}` };
    }

    try {
      const timestamp = new Date().toISOString();

      // Commit any uncommitted work if preserveState is true
      if (params.preserveState !== false) {
        try {
          await execAsync(
            `git -C "${enclave.worktreePath}" add -A && git -C "${enclave.worktreePath}" commit -m "Enclave sealed: ${params.reason ?? 'no reason provided'}" --allow-empty`,
            { timeout: 30000 }
          );
        } catch {
          // Ignore commit errors (might be nothing to commit)
        }
      }

      // Make the worktree read-only (on Unix systems)
      if (process.platform !== 'win32') {
        await execAsync(`chmod -R a-w "${enclave.worktreePath}"`);
      }

      enclave.status = 'sealed';
      enclave.sealedAt = timestamp;

      // Emit PROV trace
      const traceId = `urn:trace:${crypto.randomUUID()}`;
      if (this.traceEmitter) {
        this.traceEmitter({
          '@context': [
            'https://www.w3.org/ns/prov#',
            'https://agentcontextgraph.dev/context/v1'
          ],
          id: traceId,
          type: ['prov:Activity', 'acg:SealEnclaveActivity'],
          'prov:startedAtTime': timestamp,
          'prov:endedAtTime': new Date().toISOString(),
          'prov:used': {
            type: 'acg:ExecutionEnclave',
            id: enclave.id
          },
          'acg:sealReason': params.reason
        });
      }

      return {
        success: true,
        enclave,
        traceId
      };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        error: `Failed to seal enclave: ${errorMessage}`
      };
    }
  }

  /**
   * Destroy an enclave (clean up worktree)
   */
  async destroyEnclave(params: DestroyEnclaveParams): Promise<EnclaveOperationResult> {
    const enclave = this.enclaves.get(params.enclaveId);
    if (!enclave) {
      return { success: false, error: `Enclave not found: ${params.enclaveId}` };
    }

    if (enclave.status === 'destroyed') {
      return { success: false, error: 'Enclave already destroyed' };
    }

    try {
      const timestamp = new Date().toISOString();

      // Check for uncommitted work if not forcing
      if (!params.force) {
        const { stdout } = await execAsync(
          `git -C "${enclave.worktreePath}" status --porcelain`,
          { timeout: 10000 }
        );
        if (stdout.trim()) {
          return {
            success: false,
            error: 'Enclave has uncommitted work. Use force=true to destroy anyway.'
          };
        }
      }

      // Archive if requested
      if (params.archiveFirst) {
        const archivePath = path.join(this.baseDir, '.archives', `${enclave.id.split(':').pop()}.tar.gz`);
        await fs.mkdir(path.dirname(archivePath), { recursive: true });
        await execAsync(
          `tar -czf "${archivePath}" -C "${path.dirname(enclave.worktreePath)}" "${path.basename(enclave.worktreePath)}"`,
          { timeout: 120000 }
        );
      }

      // Get the bare repo path
      const bareRepoPath = path.join(this.baseDir, '.repos', this.repoHash(enclave.repository));

      // Remove the worktree
      await execAsync(
        `git -C "${bareRepoPath}" worktree remove "${enclave.worktreePath}" --force`,
        { timeout: 30000 }
      ).catch(() => {
        // Worktree might already be removed
      });

      // Remove the directory if it still exists
      await fs.rm(enclave.worktreePath, { recursive: true, force: true });

      // Delete the branch
      await execAsync(
        `git -C "${bareRepoPath}" branch -D "${enclave.enclaveBranch}"`,
        { timeout: 10000 }
      ).catch(() => {
        // Branch might already be deleted
      });

      enclave.status = 'destroyed';
      enclave.destroyedAt = timestamp;

      // Emit PROV trace
      const traceId = `urn:trace:${crypto.randomUUID()}`;
      if (this.traceEmitter) {
        this.traceEmitter({
          '@context': [
            'https://www.w3.org/ns/prov#',
            'https://agentcontextgraph.dev/context/v1'
          ],
          id: traceId,
          type: ['prov:Activity', 'acg:DestroyEnclaveActivity'],
          'prov:startedAtTime': timestamp,
          'prov:endedAtTime': new Date().toISOString(),
          'prov:invalidated': {
            type: 'acg:ExecutionEnclave',
            id: enclave.id
          },
          'acg:archived': params.archiveFirst ?? false,
          'acg:forced': params.force ?? false
        });
      }

      return {
        success: true,
        enclave,
        traceId
      };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        error: `Failed to destroy enclave: ${errorMessage}`
      };
    }
  }

  /**
   * Get an enclave by ID
   */
  getEnclave(enclaveId: string): ExecutionEnclave | undefined {
    return this.enclaves.get(enclaveId);
  }

  /**
   * Get all enclaves for an agent
   */
  getEnclavesForAgent(agentDID: string): ExecutionEnclave[] {
    return Array.from(this.enclaves.values())
      .filter(e => e.boundAgentDID === agentDID);
  }

  /**
   * Get all active enclaves
   */
  getActiveEnclaves(): ExecutionEnclave[] {
    return Array.from(this.enclaves.values())
      .filter(e => e.status === 'active');
  }

  /**
   * Check if a path exists
   */
  private async pathExists(p: string): Promise<boolean> {
    try {
      await fs.access(p);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Create a hash of a repository URL for directory naming
   */
  private repoHash(repository: string): string {
    return crypto.createHash('sha256').update(repository).digest('hex').slice(0, 12);
  }

  /**
   * Clean up expired enclaves
   */
  async cleanupExpiredEnclaves(): Promise<void> {
    const now = Date.now();
    for (const enclave of this.enclaves.values()) {
      if (
        enclave.status === 'active' &&
        enclave.ttlSeconds &&
        enclave.ttlSeconds > 0
      ) {
        const createdAt = new Date(enclave.createdAt).getTime();
        const expiresAt = createdAt + (enclave.ttlSeconds * 1000);
        if (now > expiresAt) {
          await this.destroyEnclave({
            enclaveId: enclave.id,
            force: true,
            archiveFirst: true
          });
        }
      }
    }
  }
}
