import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import type { ContextGraph } from '../interfaces/index.js';

/**
 * Context Checkpoint - Immutable snapshot for crash recovery
 * Inspired by Gas Town's Beads/Hooks pattern
 */
export interface ContextCheckpoint {
  id: string;                      // urn:checkpoint:{uuid}
  contextGraphId: string;          // The context this checkpoints
  agentDID: string;                // Who created this checkpoint
  label?: string;                  // Human-readable label
  timestamp: string;               // When created

  // Serialized state
  contextSnapshot: ContextGraph;   // Full context at checkpoint time
  agentState: AgentCheckpointState; // Agent-specific resumable state

  // PROV metadata
  createdByActivity: string;       // Trace ID of the checkpoint action
  supersedes?: string;             // Previous checkpoint (if any)
  resumedBy?: string[];            // Contexts that resumed from this

  // Integrity
  contentHash: string;             // SHA-256 of serialized state
  signature?: string;              // Agent's signature (optional)
}

/**
 * Agent state that can be checkpointed and resumed
 */
export interface AgentCheckpointState {
  taskQueue: CheckpointTask[];
  completedTasks: string[];
  workingMemory: Record<string, unknown>;
  currentGoal?: string;
  planInProgress?: Record<string, unknown>;
  enclaveId?: string;              // Associated enclave if any
}

/**
 * Minimal task representation for checkpoints
 */
export interface CheckpointTask {
  id: string;
  type: string;
  description: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  input?: Record<string, unknown>;
  output?: unknown;
}

/**
 * Parameters for creating a checkpoint
 */
export interface CreateCheckpointParams {
  contextId: string;
  agentDID: string;
  context: ContextGraph;
  agentState: AgentCheckpointState;
  label?: string;
  sign?: boolean;
  previousCheckpointId?: string;
}

/**
 * Parameters for resuming from a checkpoint
 */
export interface ResumeCheckpointParams {
  checkpointId: string;
  verifyIntegrity?: boolean;
  verifySignature?: boolean;
  mergeCurrentState?: AgentCheckpointState;
}

/**
 * Result of a checkpoint operation
 */
export interface CheckpointOperationResult {
  success: boolean;
  checkpoint?: ContextCheckpoint;
  context?: ContextGraph;
  agentState?: AgentCheckpointState;
  error?: string;
  traceId?: string;
}

/**
 * CheckpointStore manages context checkpoints for crash recovery
 * with full PROV derivation chains.
 */
export class CheckpointStore {
  private checkpoints: Map<string, ContextCheckpoint> = new Map();
  private baseDir: string;
  private traceEmitter?: (trace: Record<string, unknown>) => void;

  constructor(baseDir: string = './.checkpoints') {
    this.baseDir = path.resolve(baseDir);
  }

  /**
   * Set a trace emitter function for PROV trace generation
   */
  setTraceEmitter(emitter: (trace: Record<string, unknown>) => void): void {
    this.traceEmitter = emitter;
  }

  /**
   * Initialize the checkpoint store
   */
  async initialize(): Promise<void> {
    await fs.mkdir(this.baseDir, { recursive: true });
    await this.loadCheckpoints();
  }

  /**
   * Create a new checkpoint
   */
  async createCheckpoint(params: CreateCheckpointParams): Promise<CheckpointOperationResult> {
    const checkpointId = `urn:checkpoint:${crypto.randomUUID()}`;
    const timestamp = new Date().toISOString();
    const traceId = `urn:trace:${crypto.randomUUID()}`;

    try {
      // Serialize the state for hashing
      const stateToHash = {
        contextSnapshot: params.context,
        agentState: params.agentState,
        timestamp
      };
      const contentHash = crypto
        .createHash('sha256')
        .update(JSON.stringify(stateToHash))
        .digest('hex');

      const checkpoint: ContextCheckpoint = {
        id: checkpointId,
        contextGraphId: params.contextId,
        agentDID: params.agentDID,
        label: params.label,
        timestamp,
        contextSnapshot: params.context,
        agentState: params.agentState,
        createdByActivity: traceId,
        supersedes: params.previousCheckpointId,
        contentHash
      };

      // Update the superseded checkpoint
      if (params.previousCheckpointId) {
        const previous = this.checkpoints.get(params.previousCheckpointId);
        if (previous && !previous.resumedBy) {
          previous.resumedBy = [];
        }
      }

      this.checkpoints.set(checkpointId, checkpoint);

      // Persist to disk
      await this.saveCheckpoint(checkpoint);

      // Emit PROV trace
      if (this.traceEmitter) {
        this.traceEmitter({
          '@context': [
            'https://www.w3.org/ns/prov#',
            'https://agentcontextgraph.dev/context/v1'
          ],
          id: traceId,
          type: ['prov:Activity', 'acg:CheckpointActivity'],
          'prov:startedAtTime': timestamp,
          'prov:endedAtTime': new Date().toISOString(),
          'prov:wasAssociatedWith': {
            type: 'acg:Agent',
            'acg:hasDID': params.agentDID
          },
          'prov:used': {
            type: 'acg:ContextGraph',
            id: params.contextId
          },
          'prov:generated': {
            type: 'acg:ContextCheckpoint',
            id: checkpointId,
            'acg:checkpointHash': contentHash,
            'acg:checkpointLabel': params.label
          },
          ...(params.previousCheckpointId && {
            'prov:wasRevisionOf': params.previousCheckpointId
          })
        });
      }

      return {
        success: true,
        checkpoint,
        traceId
      };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        error: `Failed to create checkpoint: ${errorMessage}`
      };
    }
  }

  /**
   * Resume from a checkpoint
   */
  async resumeFromCheckpoint(params: ResumeCheckpointParams): Promise<CheckpointOperationResult> {
    const checkpoint = this.checkpoints.get(params.checkpointId);
    if (!checkpoint) {
      return { success: false, error: `Checkpoint not found: ${params.checkpointId}` };
    }

    const timestamp = new Date().toISOString();
    const traceId = `urn:trace:${crypto.randomUUID()}`;

    try {
      // Verify integrity if requested
      if (params.verifyIntegrity) {
        const stateToHash = {
          contextSnapshot: checkpoint.contextSnapshot,
          agentState: checkpoint.agentState,
          timestamp: checkpoint.timestamp
        };
        const computedHash = crypto
          .createHash('sha256')
          .update(JSON.stringify(stateToHash))
          .digest('hex');

        if (computedHash !== checkpoint.contentHash) {
          return {
            success: false,
            error: 'Checkpoint integrity verification failed: hash mismatch'
          };
        }
      }

      // Verify signature if requested (placeholder - would need actual crypto)
      if (params.verifySignature && checkpoint.signature) {
        // TODO: Implement actual signature verification using agent's DID
        console.warn('Signature verification not yet implemented');
      }

      // Prepare restored state
      let restoredAgentState = { ...checkpoint.agentState };

      // Merge with current state if requested
      if (params.mergeCurrentState) {
        restoredAgentState = {
          ...restoredAgentState,
          workingMemory: {
            ...restoredAgentState.workingMemory,
            ...params.mergeCurrentState.workingMemory
          },
          // Keep completed tasks from both
          completedTasks: [
            ...new Set([
              ...restoredAgentState.completedTasks,
              ...params.mergeCurrentState.completedTasks
            ])
          ]
        };
      }

      // Track that this checkpoint was resumed
      if (!checkpoint.resumedBy) {
        checkpoint.resumedBy = [];
      }
      checkpoint.resumedBy.push(traceId);

      // Emit PROV trace
      if (this.traceEmitter) {
        this.traceEmitter({
          '@context': [
            'https://www.w3.org/ns/prov#',
            'https://agentcontextgraph.dev/context/v1'
          ],
          id: traceId,
          type: ['prov:Activity', 'acg:ResumeActivity'],
          'prov:startedAtTime': timestamp,
          'prov:endedAtTime': new Date().toISOString(),
          'prov:used': {
            type: 'acg:ContextCheckpoint',
            id: checkpoint.id
          },
          'prov:generated': {
            type: 'acg:ContextGraph',
            'prov:wasDerivedFrom': checkpoint.id,
            'acg:resumedFrom': checkpoint.id
          },
          'acg:integrityVerified': params.verifyIntegrity ?? false,
          'acg:mergedWithCurrent': !!params.mergeCurrentState
        });
      }

      return {
        success: true,
        checkpoint,
        context: checkpoint.contextSnapshot,
        agentState: restoredAgentState,
        traceId
      };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        error: `Failed to resume from checkpoint: ${errorMessage}`
      };
    }
  }

  /**
   * Get a checkpoint by ID
   */
  getCheckpoint(checkpointId: string): ContextCheckpoint | undefined {
    return this.checkpoints.get(checkpointId);
  }

  /**
   * Get all checkpoints for an agent
   */
  getCheckpointsForAgent(agentDID: string): ContextCheckpoint[] {
    return Array.from(this.checkpoints.values())
      .filter(c => c.agentDID === agentDID)
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  }

  /**
   * Get the latest checkpoint for a context
   */
  getLatestCheckpointForContext(contextId: string): ContextCheckpoint | undefined {
    const checkpoints = Array.from(this.checkpoints.values())
      .filter(c => c.contextGraphId === contextId)
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    return checkpoints[0];
  }

  /**
   * Get checkpoint derivation chain
   */
  getDerivationChain(checkpointId: string): ContextCheckpoint[] {
    const chain: ContextCheckpoint[] = [];
    let current = this.checkpoints.get(checkpointId);

    while (current) {
      chain.push(current);
      current = current.supersedes
        ? this.checkpoints.get(current.supersedes)
        : undefined;
    }

    return chain;
  }

  /**
   * Delete old checkpoints (keeping latest N per context)
   */
  async pruneCheckpoints(keepLatestN: number = 5): Promise<number> {
    const byContext = new Map<string, ContextCheckpoint[]>();

    // Group by context
    for (const checkpoint of this.checkpoints.values()) {
      const existing = byContext.get(checkpoint.contextGraphId) ?? [];
      existing.push(checkpoint);
      byContext.set(checkpoint.contextGraphId, existing);
    }

    let pruned = 0;

    // For each context, keep only the latest N
    for (const [contextId, checkpoints] of byContext) {
      const sorted = checkpoints.sort(
        (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
      );

      const toDelete = sorted.slice(keepLatestN);
      for (const checkpoint of toDelete) {
        this.checkpoints.delete(checkpoint.id);
        await this.deleteCheckpointFile(checkpoint.id);
        pruned++;
      }
    }

    return pruned;
  }

  /**
   * Save a checkpoint to disk
   */
  private async saveCheckpoint(checkpoint: ContextCheckpoint): Promise<void> {
    const filename = `${checkpoint.id.split(':').pop()}.json`;
    const filepath = path.join(this.baseDir, filename);
    await fs.writeFile(filepath, JSON.stringify(checkpoint, null, 2));
  }

  /**
   * Delete a checkpoint file from disk
   */
  private async deleteCheckpointFile(checkpointId: string): Promise<void> {
    const filename = `${checkpointId.split(':').pop()}.json`;
    const filepath = path.join(this.baseDir, filename);
    await fs.unlink(filepath).catch(() => {});
  }

  /**
   * Load all checkpoints from disk
   */
  private async loadCheckpoints(): Promise<void> {
    try {
      const files = await fs.readdir(this.baseDir);
      for (const file of files) {
        if (file.endsWith('.json')) {
          const filepath = path.join(this.baseDir, file);
          const content = await fs.readFile(filepath, 'utf-8');
          const checkpoint: ContextCheckpoint = JSON.parse(content);
          this.checkpoints.set(checkpoint.id, checkpoint);
        }
      }
    } catch {
      // Directory might not exist yet
    }
  }
}
