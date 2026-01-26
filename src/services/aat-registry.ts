import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import type { AbstractAgentType, IAATRegistry, ParallelizationRules } from '../interfaces/index.js';

/**
 * AAT Registry - Manages Abstract Agent Type definitions
 * Loads AAT specs from the spec/aat directory
 */
export class AATRegistry implements IAATRegistry {
  private aats: Map<string, AbstractAgentType> = new Map();

  constructor(specDir?: string) {
    if (specDir) {
      this.loadFromDirectory(specDir);
    }
  }

  /**
   * Load AAT definitions from a directory
   */
  loadFromDirectory(dir: string): void {
    const files = readdirSync(dir).filter(f => f.endsWith('.json'));
    for (const file of files) {
      const content = readFileSync(join(dir, file), 'utf-8');
      const aat = JSON.parse(content) as AbstractAgentType;
      this.register(aat);
    }
  }

  /**
   * Register an AAT
   */
  register(aat: AbstractAgentType): void {
    this.aats.set(aat.id, aat);
  }

  /**
   * Get an AAT by ID
   */
  async getAAT(aatId: string): Promise<AbstractAgentType | null> {
    return this.aats.get(aatId) ?? null;
  }

  /**
   * Check if an action type is allowed for an AAT
   */
  async isActionAllowed(aatId: string, actionType: string): Promise<boolean> {
    const aat = this.aats.get(aatId);
    if (!aat) return false;
    return aat.actionSpace.allowed.some(a => a.type === actionType);
  }

  /**
   * Check if an action type is forbidden for an AAT
   */
  async isActionForbidden(aatId: string, actionType: string): Promise<boolean> {
    const aat = this.aats.get(aatId);
    if (!aat) return true; // Unknown AAT = forbidden by default
    return aat.actionSpace.forbidden.some(a => a.type === actionType);
  }

  /**
   * Get required capability for an action
   */
  async getRequiredCapability(aatId: string, actionType: string): Promise<string | null> {
    const aat = this.aats.get(aatId);
    if (!aat) return null;
    const action = aat.actionSpace.allowed.find(a => a.type === actionType);
    return action?.requiresCapability ?? null;
  }

  /**
   * Get required output action from behavioral invariants
   * Looks for invariants with enforcement='structural' that have requiredOutputAction
   */
  async getRequiredOutputAction(aatId: string): Promise<string | null> {
    const aat = this.aats.get(aatId);
    if (!aat) return null;

    // Find structural invariants that specify a required output action
    const outputInvariant = aat.behavioralInvariants.find(
      inv => inv.enforcement === 'structural' &&
             (inv as { requiredOutputAction?: string }).requiredOutputAction
    );

    return (outputInvariant as { requiredOutputAction?: string })?.requiredOutputAction ?? null;
  }

  /**
   * Get parallelization rules for an AAT (Gas Town inspired)
   * Returns rules from compositionRules if defined, otherwise defaults
   */
  async getParallelizationRules(aatId: string): Promise<ParallelizationRules | null> {
    const aat = this.aats.get(aatId);
    if (!aat) return null;

    const rules = aat.compositionRules;

    // Return explicit rules if defined
    if (rules.parallelizable !== undefined) {
      return {
        parallelizable: rules.parallelizable ?? false,
        maxConcurrent: rules.maxConcurrent ?? 1,
        requiresIsolation: rules.requiresIsolation ?? false,
        conflictsWith: rules.conflictsWith ?? [],
        preferredEnclaveScope: rules.preferredEnclaveScope
      };
    }

    // Default rules based on agent type pattern
    const typeDefaults: Record<string, ParallelizationRules> = {
      'aat:PlannerAgentType': {
        parallelizable: true,
        maxConcurrent: 3,
        requiresIsolation: false,
        conflictsWith: ['aat:PlannerAgentType']
      },
      'aat:ExecutorAgentType': {
        parallelizable: true,
        maxConcurrent: 20,
        requiresIsolation: true,
        conflictsWith: [],
        preferredEnclaveScope: 'file:*,api:read,api:write'
      },
      'aat:ArbiterAgentType': {
        parallelizable: false,
        maxConcurrent: 1,
        requiresIsolation: false,
        conflictsWith: ['aat:ArbiterAgentType']
      },
      'aat:ObserverAgentType': {
        parallelizable: true,
        maxConcurrent: 10,
        requiresIsolation: false,
        conflictsWith: []
      },
      'aat:ArchivistAgentType': {
        parallelizable: true,
        maxConcurrent: 2,
        requiresIsolation: false,
        conflictsWith: ['aat:ArchivistAgentType']
      }
    };

    return typeDefaults[aatId] ?? {
      parallelizable: false,
      maxConcurrent: 1,
      requiresIsolation: false,
      conflictsWith: []
    };
  }

  /**
   * Get all registered AAT IDs
   */
  getRegisteredAATs(): string[] {
    return Array.from(this.aats.keys());
  }

  /**
   * Validate that an affordance conforms to AAT constraints
   */
  async validateAffordanceForAAT(
    aatId: string,
    actionType: string
  ): Promise<{ valid: boolean; error?: string }> {
    const aat = this.aats.get(aatId);
    if (!aat) {
      return { valid: false, error: `Unknown AAT: ${aatId}` };
    }

    // Check if action is forbidden
    if (aat.actionSpace.forbidden.some(a => a.type === actionType)) {
      const forbidden = aat.actionSpace.forbidden.find(a => a.type === actionType);
      return {
        valid: false,
        error: `Action '${actionType}' is forbidden for ${aatId}: ${forbidden?.rationale}`
      };
    }

    // Check if action is allowed
    if (!aat.actionSpace.allowed.some(a => a.type === actionType)) {
      return {
        valid: false,
        error: `Action '${actionType}' is not in the allowed action space for ${aatId}`
      };
    }

    return { valid: true };
  }
}
