import type {
  IPolicyEngine,
  PolicyContext,
  PolicyDecision,
  Policy,
  Constraint,
  ConcurrencyPolicy,
  ResourceLimits
} from '../interfaces/index.js';

/**
 * Concurrency evaluation context
 */
export interface ConcurrencyContext {
  agentType: string;
  activeAgentsByType: Record<string, number>;
  totalActiveAgents: number;
  currentResourceUsage: {
    tokensThisMinute: number;
    costThisHour: number;
    activeAPICalls: number;
  };
}

/**
 * Concurrency evaluation result
 */
export interface ConcurrencyDecision {
  allowed: boolean;
  reason: string;
  limitType?: 'max_total' | 'max_per_type' | 'conflict' | 'resource';
  suggestedWaitMs?: number;
}

/**
 * Policy Engine - Evaluates deontic, outcome, and concurrency policies
 *
 * Extended with Gas Town-inspired concurrency controls:
 * - Agent type limits (parallelization rules)
 * - Conflict detection
 * - Resource usage limits
 */
export class PolicyEngine implements IPolicyEngine {
  private policies: Map<string, Policy[]> = new Map();
  private globalPolicies: Policy[] = [];

  // Concurrency policy (Gas Town inspired)
  private concurrencyPolicy: ConcurrencyPolicy;

  constructor(concurrencyPolicy?: ConcurrencyPolicy) {
    // Set default or provided concurrency policy
    this.concurrencyPolicy = concurrencyPolicy ?? this.getDefaultConcurrencyPolicy();

    // Register default global policies
    this.registerGlobalPolicy({
      id: 'policy:trace-required',
      type: 'deontic',
      rule: 'All actions must emit PROV trace',
      appliesTo: ['*']
    });
  }

  /**
   * Register a policy for a specific agent or agent type
   */
  registerPolicy(agentOrType: string, policy: Policy): void {
    const existing = this.policies.get(agentOrType) ?? [];
    existing.push(policy);
    this.policies.set(agentOrType, existing);
  }

  /**
   * Register a global policy that applies to all agents
   */
  registerGlobalPolicy(policy: Policy): void {
    this.globalPolicies.push(policy);
  }

  /**
   * Evaluate whether an action is permitted
   */
  async evaluateAction(
    agentDID: string,
    actionType: string,
    context: PolicyContext
  ): Promise<PolicyDecision> {
    // Get applicable policies
    const policies = await this.getActivePolicies(agentDID);

    // Check each policy
    for (const policy of policies) {
      // Check if policy applies to this action
      if (!policy.appliesTo.includes('*') && !policy.appliesTo.includes(actionType)) {
        continue;
      }

      // Evaluate deontic policies
      if (policy.type === 'deontic') {
        const decision = this.evaluateDeonticPolicy(policy, context);
        if (decision.decision === 'deny') {
          return decision;
        }
      }

      // Evaluate outcome policies (require causal evaluation)
      if (policy.type === 'outcome') {
        const hasOutcomeConstraints = context.constraints.some(c => c.type === 'outcome');
        if (hasOutcomeConstraints) {
          // In production: would call ICausalEvaluator here
          const decision = this.evaluateOutcomePolicy(policy, context);
          if (decision.decision === 'deny') {
            return decision;
          }
        }
      }
    }

    // Check context constraints
    for (const constraint of context.constraints) {
      if (constraint.enforcementLevel === 'strict') {
        const constraintCheck = this.checkConstraint(constraint, context);
        if (!constraintCheck.satisfied) {
          return {
            decision: 'deny',
            reason: constraintCheck.reason,
            policyRef: constraint.policyRef ?? 'inline-constraint'
          };
        }
      }
    }

    return {
      decision: 'permit',
      reason: 'All policies satisfied',
      policyRef: 'policy:default-permit'
    };
  }

  /**
   * Get active policies for an agent
   */
  async getActivePolicies(agentDID: string): Promise<Policy[]> {
    const agentPolicies = this.policies.get(agentDID) ?? [];
    return [...this.globalPolicies, ...agentPolicies];
  }

  /**
   * Evaluate a deontic policy
   */
  private evaluateDeonticPolicy(policy: Policy, context: PolicyContext): PolicyDecision {
    // Check if required credentials are present
    if (policy.rule.includes('requires credential')) {
      const requiredType = this.extractCredentialType(policy.rule);
      if (requiredType) {
        const hasCredential = context.credentials.some(c =>
          c.type.includes(requiredType)
        );
        if (!hasCredential) {
          return {
            decision: 'deny',
            reason: `Missing required credential: ${requiredType}`,
            policyRef: policy.id
          };
        }
      }
    }

    return {
      decision: 'permit',
      reason: 'Deontic policy satisfied',
      policyRef: policy.id
    };
  }

  /**
   * Evaluate an outcome policy
   */
  private evaluateOutcomePolicy(policy: Policy, _context: PolicyContext): PolicyDecision {
    // In production: would check predicted outcomes against thresholds
    // For now, this is a stub that permits
    return {
      decision: 'permit',
      reason: 'Outcome policy evaluation stub - permitted',
      policyRef: policy.id
    };
  }

  /**
   * Check a specific constraint
   */
  private checkConstraint(
    constraint: Constraint,
    _context: PolicyContext
  ): { satisfied: boolean; reason: string } {
    // Basic constraint checking - in production would be more sophisticated
    switch (constraint.type) {
      case 'temporal':
        // Check time-based constraints
        return { satisfied: true, reason: 'Temporal constraint satisfied' };

      case 'resource':
        // Check resource-based constraints
        return { satisfied: true, reason: 'Resource constraint satisfied' };

      case 'deontic':
        // Deontic constraints handled by policy evaluation
        return { satisfied: true, reason: 'Deontic constraint satisfied' };

      case 'outcome':
        // Outcome constraints require causal evaluation
        return { satisfied: true, reason: 'Outcome constraint - requires causal eval' };

      default:
        return { satisfied: true, reason: 'Unknown constraint type - permitted' };
    }
  }

  /**
   * Extract credential type from policy rule
   */
  private extractCredentialType(rule: string): string | null {
    const match = rule.match(/requires credential[:\s]+(\w+)/i);
    return match ? match[1] : null;
  }

  // ===========================================================================
  // Concurrency Policy Methods (Gas Town inspired)
  // ===========================================================================

  /**
   * Get the current concurrency policy
   */
  getConcurrencyPolicy(): ConcurrencyPolicy {
    return { ...this.concurrencyPolicy };
  }

  /**
   * Update the concurrency policy
   */
  setConcurrencyPolicy(policy: ConcurrencyPolicy): void {
    this.concurrencyPolicy = policy;
  }

  /**
   * Update resource limits within the concurrency policy
   */
  setResourceLimits(limits: Partial<ResourceLimits>): void {
    this.concurrencyPolicy.resourceLimits = {
      ...this.concurrencyPolicy.resourceLimits,
      ...limits
    };
  }

  /**
   * Evaluate whether a new agent can be spawned
   * Considers type limits, conflicts, and resource constraints
   */
  evaluateConcurrency(context: ConcurrencyContext): ConcurrencyDecision {
    // 1. Check total agent limit
    if (context.totalActiveAgents >= this.concurrencyPolicy.maxTotalAgents) {
      return {
        allowed: false,
        reason: `Maximum total agents (${this.concurrencyPolicy.maxTotalAgents}) reached`,
        limitType: 'max_total',
        suggestedWaitMs: 5000
      };
    }

    // 2. Check per-type limit
    const maxForType = this.concurrencyPolicy.maxPerType[context.agentType];
    if (maxForType !== undefined) {
      const currentCount = context.activeAgentsByType[context.agentType] ?? 0;
      if (currentCount >= maxForType) {
        return {
          allowed: false,
          reason: `Maximum agents of type ${context.agentType} (${maxForType}) reached`,
          limitType: 'max_per_type',
          suggestedWaitMs: 3000
        };
      }
    }

    // 3. Check conflict rules
    const conflicts = this.concurrencyPolicy.conflictMatrix[context.agentType] ?? [];
    for (const conflictType of conflicts) {
      const conflictCount = context.activeAgentsByType[conflictType] ?? 0;
      if (conflictCount > 0) {
        return {
          allowed: false,
          reason: `Agent type ${context.agentType} conflicts with active ${conflictType}`,
          limitType: 'conflict',
          suggestedWaitMs: 10000
        };
      }
    }

    // 4. Check resource limits
    const resourceCheck = this.checkResourceLimits(context.currentResourceUsage);
    if (!resourceCheck.allowed) {
      return resourceCheck;
    }

    return {
      allowed: true,
      reason: 'Concurrency policy permits new agent'
    };
  }

  /**
   * Check if resource limits allow new agent spawning
   */
  checkResourceLimits(usage: ConcurrencyContext['currentResourceUsage']): ConcurrencyDecision {
    const limits = this.concurrencyPolicy.resourceLimits;

    // Token limit
    if (usage.tokensThisMinute >= limits.maxTokensPerMinute) {
      return {
        allowed: false,
        reason: `Token limit reached (${usage.tokensThisMinute}/${limits.maxTokensPerMinute} per minute)`,
        limitType: 'resource',
        suggestedWaitMs: 60000 - (Date.now() % 60000) // Wait until next minute
      };
    }

    // Cost limit
    if (usage.costThisHour >= limits.maxCostPerHour) {
      return {
        allowed: false,
        reason: `Cost limit reached ($${usage.costThisHour.toFixed(2)}/$${limits.maxCostPerHour} per hour)`,
        limitType: 'resource',
        suggestedWaitMs: 3600000 - (Date.now() % 3600000) // Wait until next hour
      };
    }

    // API call limit
    if (usage.activeAPICalls >= limits.maxConcurrentAPICalls) {
      return {
        allowed: false,
        reason: `API call limit reached (${usage.activeAPICalls}/${limits.maxConcurrentAPICalls} concurrent)`,
        limitType: 'resource',
        suggestedWaitMs: 1000
      };
    }

    return {
      allowed: true,
      reason: 'Resource limits permit operation'
    };
  }

  /**
   * Check if a specific agent type can be spawned given current state
   */
  canSpawnAgentType(
    agentType: string,
    activeByType: Record<string, number>,
    totalActive: number
  ): ConcurrencyDecision {
    return this.evaluateConcurrency({
      agentType,
      activeAgentsByType: activeByType,
      totalActiveAgents: totalActive,
      currentResourceUsage: {
        tokensThisMinute: 0,
        costThisHour: 0,
        activeAPICalls: 0
      }
    });
  }

  /**
   * Get conflict matrix for display/debugging
   */
  getConflictMatrix(): Record<string, string[]> {
    return { ...this.concurrencyPolicy.conflictMatrix };
  }

  /**
   * Add a conflict rule between agent types
   */
  addConflict(agentType1: string, agentType2: string): void {
    // Add bidirectional conflict
    if (!this.concurrencyPolicy.conflictMatrix[agentType1]) {
      this.concurrencyPolicy.conflictMatrix[agentType1] = [];
    }
    if (!this.concurrencyPolicy.conflictMatrix[agentType1].includes(agentType2)) {
      this.concurrencyPolicy.conflictMatrix[agentType1].push(agentType2);
    }

    if (!this.concurrencyPolicy.conflictMatrix[agentType2]) {
      this.concurrencyPolicy.conflictMatrix[agentType2] = [];
    }
    if (!this.concurrencyPolicy.conflictMatrix[agentType2].includes(agentType1)) {
      this.concurrencyPolicy.conflictMatrix[agentType2].push(agentType1);
    }
  }

  /**
   * Remove a conflict rule between agent types
   */
  removeConflict(agentType1: string, agentType2: string): void {
    if (this.concurrencyPolicy.conflictMatrix[agentType1]) {
      this.concurrencyPolicy.conflictMatrix[agentType1] =
        this.concurrencyPolicy.conflictMatrix[agentType1].filter(t => t !== agentType2);
    }
    if (this.concurrencyPolicy.conflictMatrix[agentType2]) {
      this.concurrencyPolicy.conflictMatrix[agentType2] =
        this.concurrencyPolicy.conflictMatrix[agentType2].filter(t => t !== agentType1);
    }
  }

  /**
   * Set maximum concurrent agents for a type
   */
  setMaxConcurrentForType(agentType: string, max: number): void {
    this.concurrencyPolicy.maxPerType[agentType] = max;
  }

  /**
   * Get default concurrency policy
   * Based on AAT defaults from the ontology
   */
  private getDefaultConcurrencyPolicy(): ConcurrencyPolicy {
    return {
      maxTotalAgents: 10,
      maxPerType: {
        'aat:PlannerAgentType': 3,
        'aat:ExecutorAgentType': 20,
        'aat:ObserverAgentType': 10,
        'aat:ArbiterAgentType': 1,
        'aat:ArchivistAgentType': 2
      },
      conflictMatrix: {
        // Arbiter is singleton - conflicts with itself
        'aat:ArbiterAgentType': ['aat:ArbiterAgentType'],
        // Planners conflict with each other (avoid conflicting plans for same goal)
        'aat:PlannerAgentType': ['aat:PlannerAgentType'],
        // Archivists conflict (avoid write conflicts)
        'aat:ArchivistAgentType': ['aat:ArchivistAgentType']
      },
      resourceLimits: {
        maxTokensPerMinute: 100000,
        maxCostPerHour: 10, // $10/hour - prevent Gas Town's $100/hr burn rate
        maxConcurrentAPICalls: 10
      }
    };
  }
}
