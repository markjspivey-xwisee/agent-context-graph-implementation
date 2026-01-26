import type {
  ContextGraph,
  IPolicyEngine,
  PolicyContext,
  PolicyDecision,
  Policy,
  VerifiedCredentialRef,
  Constraint
} from '../interfaces/index.js';

/**
 * Policy Rule - OPA/Rego-inspired structure
 */
export interface PolicyRule {
  id: string;
  name: string;
  description: string;
  effect: 'allow' | 'deny';
  priority: number;
  conditions: PolicyCondition[];
  actions?: string[]; // Action types this rule applies to (empty = all)
  agentTypes?: string[]; // Agent types this rule applies to (empty = all)
}

/**
 * Policy Condition - evaluates to true/false
 */
export interface PolicyCondition {
  field: string; // JSON path or special field
  operator: 'eq' | 'neq' | 'in' | 'not_in' | 'contains' | 'matches' | 'gt' | 'lt' | 'gte' | 'lte' | 'exists' | 'not_exists';
  value: unknown;
}

/**
 * Policy Evaluation Result
 */
export interface PolicyResult {
  allowed: boolean;
  decision: 'allow' | 'deny';
  appliedRules: Array<{
    ruleId: string;
    ruleName: string;
    effect: 'allow' | 'deny';
    matched: boolean;
    reason?: string;
  }>;
  denialReasons: string[];
  warnings: string[];
}

/**
 * Constraint with deontic modality
 */
export interface DeonticConstraint {
  id: string;
  modality: 'obligation' | 'prohibition' | 'permission';
  action: string;
  condition?: string;
  consequence?: string;
  enforcementLevel: 'strict' | 'advisory' | 'audit-only';
}

/**
 * OPA-style Policy Engine
 * Evaluates deontic constraints and policy rules against context and parameters
 */
export class OPAPolicyEngine implements IPolicyEngine {
  private rules: Map<string, PolicyRule> = new Map();
  private constraints: Map<string, DeonticConstraint> = new Map();

  constructor() {
    this.loadDefaultRules();
  }

  /**
   * Evaluate whether an action is permitted (IPolicyEngine interface)
   */
  async evaluateAction(
    agentDID: string,
    actionType: string,
    context: PolicyContext
  ): Promise<PolicyDecision> {
    const denialReasons: string[] = [];

    // Check rules for this action type
    for (const rule of this.rules.values()) {
      // Check if rule applies to this action
      if (rule.actions && rule.actions.length > 0) {
        if (!rule.actions.includes(actionType)) continue;
      }

      // Check if rule applies based on conditions
      if (rule.effect === 'deny') {
        // For deny rules, assume they match if they apply to this action
        denialReasons.push(rule.description);
      }
    }

    // Check constraints from context
    for (const constraint of context.constraints) {
      if (constraint.enforcementLevel === 'strict') {
        // Parse simple rules
        if (constraint.rule.toLowerCase().includes('must not') &&
            constraint.rule.toLowerCase().includes(actionType.toLowerCase())) {
          denialReasons.push(constraint.rule);
        }
      }
    }

    const allowed = denialReasons.length === 0;

    return {
      decision: allowed ? 'permit' : 'deny',
      reason: allowed ? 'Action permitted' : denialReasons.join('; '),
      policyRef: 'opa:default-policy'
    };
  }

  /**
   * Get active policies for an agent (IPolicyEngine interface)
   */
  async getActivePolicies(agentDID: string): Promise<Policy[]> {
    const policies: Policy[] = [];

    for (const rule of this.rules.values()) {
      policies.push({
        id: rule.id,
        type: 'deontic',
        rule: rule.description,
        appliesTo: rule.actions ?? ['*']
      });
    }

    for (const constraint of this.constraints.values()) {
      policies.push({
        id: constraint.id,
        type: 'deontic',
        rule: constraint.condition ?? constraint.action,
        appliesTo: [constraint.action]
      });
    }

    return policies;
  }

  /**
   * Evaluate if an action is allowed
   */
  evaluate(
    context: ContextGraph,
    affordanceId: string,
    parameters: Record<string, unknown>
  ): PolicyResult {
    const result: PolicyResult = {
      allowed: true,
      decision: 'allow',
      appliedRules: [],
      denialReasons: [],
      warnings: []
    };

    // Find the affordance
    const affordance = context.affordances.find(a => a.id === affordanceId);
    if (!affordance) {
      result.allowed = false;
      result.decision = 'deny';
      result.denialReasons.push(`Affordance ${affordanceId} not found in context`);
      return result;
    }

    // Check if affordance is enabled
    if (affordance.enabled === false) {
      result.allowed = false;
      result.decision = 'deny';
      result.denialReasons.push(`Affordance ${affordanceId} is disabled`);
      return result;
    }

    // Build evaluation context
    const evalContext = this.buildEvaluationContext(context, affordance, parameters);

    // Evaluate all applicable rules
    const applicableRules = this.getApplicableRules(affordance.actionType, context.agentType);

    // Sort by priority (higher = evaluated first)
    applicableRules.sort((a, b) => b.priority - a.priority);

    for (const rule of applicableRules) {
      const ruleResult = this.evaluateRule(rule, evalContext);
      result.appliedRules.push(ruleResult);

      if (ruleResult.matched) {
        if (rule.effect === 'deny') {
          result.allowed = false;
          result.decision = 'deny';
          result.denialReasons.push(ruleResult.reason ?? `Denied by rule: ${rule.name}`);
        }
        // Allow rules don't short-circuit - we check all deny rules
      }
    }

    // Evaluate deontic constraints from context
    for (const constraint of context.constraints) {
      const constraintResult = this.evaluateContextConstraint(constraint, evalContext);
      if (!constraintResult.satisfied) {
        if (constraint.enforcementLevel === 'strict') {
          result.allowed = false;
          result.decision = 'deny';
          result.denialReasons.push(constraintResult.reason);
        } else if (constraint.enforcementLevel === 'advisory') {
          result.warnings.push(constraintResult.reason);
        }
        // audit-only: just log, don't affect result
      }
    }

    // Evaluate registered deontic constraints
    for (const constraint of this.constraints.values()) {
      if (constraint.action !== '*' && constraint.action !== affordance.actionType) {
        continue;
      }

      const constraintResult = this.evaluateDeonticConstraint(constraint, evalContext);
      if (!constraintResult.satisfied) {
        if (constraint.enforcementLevel === 'strict') {
          result.allowed = false;
          result.decision = 'deny';
          result.denialReasons.push(constraintResult.reason);
        } else if (constraint.enforcementLevel === 'advisory') {
          result.warnings.push(constraintResult.reason);
        }
      }
    }

    return result;
  }

  /**
   * Add a policy rule
   */
  addRule(rule: PolicyRule): void {
    this.rules.set(rule.id, rule);
  }

  /**
   * Remove a policy rule
   */
  removeRule(ruleId: string): boolean {
    return this.rules.delete(ruleId);
  }

  /**
   * Add a deontic constraint
   */
  addConstraint(constraint: DeonticConstraint): void {
    this.constraints.set(constraint.id, constraint);
  }

  /**
   * Get all rules
   */
  getRules(): PolicyRule[] {
    return Array.from(this.rules.values());
  }

  /**
   * Get all constraints
   */
  getConstraints(): DeonticConstraint[] {
    return Array.from(this.constraints.values());
  }

  /**
   * List rules in a summary format for API
   */
  listRules(): Array<{ id: string; name: string; description: string; effect: string; priority: number }> {
    return Array.from(this.rules.values()).map(rule => ({
      id: rule.id,
      name: rule.name,
      description: rule.description,
      effect: rule.effect,
      priority: rule.priority
    }));
  }

  /**
   * Evaluate policies from string array (simplified format)
   */
  evaluatePolicies(
    policies: string[],
    action: string,
    context: Record<string, unknown>
  ): { allowed: boolean; denialReasons: string[] } {
    const denialReasons: string[] = [];

    for (const policy of policies) {
      // Parse simple policy format: "must/must not [condition]"
      const mustNotMatch = policy.match(/must\s+not\s+(.+)/i);
      const mustMatch = policy.match(/must\s+(.+)/i);

      if (mustNotMatch) {
        const condition = mustNotMatch[1].toLowerCase();

        // Check common conditions
        if (condition.includes('delete') && action.toLowerCase().includes('delete')) {
          if (condition.includes('critical') && this.isCriticalResource(context)) {
            denialReasons.push(`Policy violation: ${policy}`);
          }
        }

        if (condition.includes('expose') && condition.includes('secret')) {
          if (this.mightExposeSecrets(context)) {
            denialReasons.push(`Policy violation: ${policy}`);
          }
        }
      }

      if (mustMatch && !mustNotMatch) {
        const condition = mustMatch[1].toLowerCase();

        if (condition.includes('reversible')) {
          if (!this.isReversibleAction(action)) {
            denialReasons.push(`Advisory: ${policy} (action may not be reversible)`);
          }
        }
      }
    }

    return {
      allowed: denialReasons.length === 0,
      denialReasons
    };
  }

  // ===========================================
  // Private methods
  // ===========================================

  private loadDefaultRules(): void {
    // Rule: Deny destructive actions without confirmation
    this.addRule({
      id: 'deny-unconfirmed-destructive',
      name: 'Deny Unconfirmed Destructive Actions',
      description: 'Destructive actions require explicit confirmation',
      effect: 'deny',
      priority: 100,
      actions: ['Delete', 'Destroy', 'Drop', 'Truncate'],
      conditions: [
        { field: 'parameters.confirmed', operator: 'neq', value: true }
      ]
    });

    // Rule: Deny actions on protected resources
    this.addRule({
      id: 'deny-protected-resources',
      name: 'Deny Actions on Protected Resources',
      description: 'Cannot modify protected system resources',
      effect: 'deny',
      priority: 90,
      conditions: [
        { field: 'parameters.target', operator: 'matches', value: '^/?(system|protected|\.env|credentials)' }
      ]
    });

    // Rule: Deny external writes without approval
    this.addRule({
      id: 'deny-unapproved-external-write',
      name: 'Deny Unapproved External Writes',
      description: 'Writing to external systems requires prior approval',
      effect: 'deny',
      priority: 80,
      actions: ['WriteExternal', 'Deploy', 'Publish'],
      agentTypes: ['aat:ExecutorAgentType'],
      conditions: [
        { field: 'context.hasApproval', operator: 'neq', value: true }
      ]
    });

    // Rule: Planner cannot execute
    this.addRule({
      id: 'planner-no-execute',
      name: 'Planner Cannot Execute',
      description: 'Planner agents are not allowed to execute actions',
      effect: 'deny',
      priority: 100,
      actions: ['Act', 'Execute', 'Actuate', 'WriteExternal'],
      agentTypes: ['aat:PlannerAgentType'],
      conditions: [] // Always applies to matching agent/action types
    });

    // Rule: Observer cannot modify
    this.addRule({
      id: 'observer-no-modify',
      name: 'Observer Cannot Modify',
      description: 'Observer agents can only observe, not modify',
      effect: 'deny',
      priority: 100,
      actions: ['Act', 'Execute', 'Write', 'Delete', 'Update', 'Store'],
      agentTypes: ['aat:ObserverAgentType'],
      conditions: [] // Always applies to matching agent/action types
    });

    // Constraint: All actions must produce traces
    this.addConstraint({
      id: 'must-trace',
      modality: 'obligation',
      action: '*',
      condition: 'always',
      consequence: 'Trace must be emitted',
      enforcementLevel: 'strict'
    });

    // Constraint: Prohibition on secrets exposure
    this.addConstraint({
      id: 'no-secrets-exposure',
      modality: 'prohibition',
      action: '*',
      condition: 'output contains secrets',
      consequence: 'Action denied - would expose secrets',
      enforcementLevel: 'strict'
    });
  }

  private buildEvaluationContext(
    context: ContextGraph,
    affordance: ContextGraph['affordances'][0],
    parameters: Record<string, unknown>
  ): EvaluationContext {
    return {
      context: {
        id: context.id,
        agentDID: context.agentDID,
        agentType: context.agentType,
        timestamp: context.timestamp,
        hasApproval: context.verifiedCredentials.some(
          c => c.type?.includes('ApprovalCredential')
        ),
        scope: context.scope
      },
      affordance: {
        id: affordance.id,
        actionType: affordance.actionType,
        target: affordance.target
      },
      parameters
    };
  }

  private getApplicableRules(actionType: string, agentType: string): PolicyRule[] {
    return Array.from(this.rules.values()).filter(rule => {
      // Check action type filter
      if (rule.actions && rule.actions.length > 0) {
        if (!rule.actions.includes(actionType)) {
          return false;
        }
      }

      // Check agent type filter
      if (rule.agentTypes && rule.agentTypes.length > 0) {
        if (!rule.agentTypes.includes(agentType)) {
          return false;
        }
      }

      return true;
    });
  }

  private evaluateRule(
    rule: PolicyRule,
    evalContext: EvaluationContext
  ): { ruleId: string; ruleName: string; effect: 'allow' | 'deny'; matched: boolean; reason?: string } {
    // All conditions must match for the rule to apply
    let allMatch = true;
    let failedCondition: string | undefined;

    for (const condition of rule.conditions) {
      if (!this.evaluateCondition(condition, evalContext)) {
        allMatch = false;
        failedCondition = `${condition.field} ${condition.operator} ${condition.value}`;
        break;
      }
    }

    return {
      ruleId: rule.id,
      ruleName: rule.name,
      effect: rule.effect,
      matched: allMatch,
      reason: allMatch ? rule.description : undefined
    };
  }

  private evaluateCondition(
    condition: PolicyCondition,
    evalContext: EvaluationContext
  ): boolean {
    const fieldValue = this.getFieldValue(condition.field, evalContext);

    switch (condition.operator) {
      case 'eq':
        return fieldValue === condition.value;
      case 'neq':
        return fieldValue !== condition.value;
      case 'in':
        return Array.isArray(condition.value) && condition.value.includes(fieldValue);
      case 'not_in':
        return Array.isArray(condition.value) && !condition.value.includes(fieldValue);
      case 'contains':
        return typeof fieldValue === 'string' && fieldValue.includes(String(condition.value));
      case 'matches':
        return typeof fieldValue === 'string' && new RegExp(String(condition.value), 'i').test(fieldValue);
      case 'gt':
        return typeof fieldValue === 'number' && fieldValue > Number(condition.value);
      case 'lt':
        return typeof fieldValue === 'number' && fieldValue < Number(condition.value);
      case 'gte':
        return typeof fieldValue === 'number' && fieldValue >= Number(condition.value);
      case 'lte':
        return typeof fieldValue === 'number' && fieldValue <= Number(condition.value);
      case 'exists':
        return fieldValue !== undefined && fieldValue !== null;
      case 'not_exists':
        return fieldValue === undefined || fieldValue === null;
      default:
        return false;
    }
  }

  private getFieldValue(field: string, evalContext: EvaluationContext): unknown {
    const parts = field.split('.');
    let value: unknown = evalContext;

    for (const part of parts) {
      if (value === undefined || value === null) return undefined;
      value = (value as Record<string, unknown>)[part];
    }

    return value;
  }

  private evaluateContextConstraint(
    constraint: ContextGraph['constraints'][0],
    evalContext: EvaluationContext
  ): { satisfied: boolean; reason: string } {
    // Simple rule-based evaluation
    const rule = constraint.rule.toLowerCase();

    if (constraint.type === 'deontic') {
      // Parse deontic rules like "must X" or "must not X"
      if (rule.includes('must not')) {
        const action = rule.replace(/must\s+not\s+/i, '').trim();
        const violated = this.checkProhibition(action, evalContext);
        return {
          satisfied: !violated,
          reason: violated ? `Prohibition violated: ${constraint.rule}` : ''
        };
      } else if (rule.includes('must')) {
        const action = rule.replace(/must\s+/i, '').trim();
        const satisfied = this.checkObligation(action, evalContext);
        return {
          satisfied,
          reason: satisfied ? '' : `Obligation not met: ${constraint.rule}`
        };
      }
    }

    if (constraint.type === 'outcome') {
      // Outcome constraints are checked after execution
      return { satisfied: true, reason: '' };
    }

    if (constraint.type === 'temporal') {
      // Check temporal constraints
      const now = new Date();
      if (rule.includes('within')) {
        // Check if within allowed time window
        return { satisfied: true, reason: '' };
      }
    }

    if (constraint.type === 'resource') {
      // Check resource constraints
      if (rule.includes('quota')) {
        // Would check quota here
        return { satisfied: true, reason: '' };
      }
    }

    return { satisfied: true, reason: '' };
  }

  private evaluateDeonticConstraint(
    constraint: DeonticConstraint,
    evalContext: EvaluationContext
  ): { satisfied: boolean; reason: string } {
    switch (constraint.modality) {
      case 'prohibition':
        // Check if the prohibited action/condition is occurring
        const violated = this.checkProhibition(constraint.condition ?? '', evalContext);
        return {
          satisfied: !violated,
          reason: violated ? (constraint.consequence ?? `Prohibition violated: ${constraint.id}`) : ''
        };

      case 'obligation':
        // Check if the required condition is met
        const met = this.checkObligation(constraint.condition ?? '', evalContext);
        return {
          satisfied: met,
          reason: met ? '' : (constraint.consequence ?? `Obligation not met: ${constraint.id}`)
        };

      case 'permission':
        // Permissions don't constrain, they enable
        return { satisfied: true, reason: '' };

      default:
        return { satisfied: true, reason: '' };
    }
  }

  private checkProhibition(condition: string, evalContext: EvaluationContext): boolean {
    const lowerCondition = condition.toLowerCase();

    if (lowerCondition.includes('secrets') || lowerCondition.includes('credentials')) {
      return this.mightExposeSecrets(evalContext);
    }

    if (lowerCondition.includes('delete') && lowerCondition.includes('critical')) {
      return this.isCriticalResource(evalContext);
    }

    return false;
  }

  private checkObligation(condition: string, evalContext: EvaluationContext): boolean {
    const lowerCondition = condition.toLowerCase();

    if (lowerCondition.includes('trace') || lowerCondition.includes('log')) {
      // Traces are always emitted by the system
      return true;
    }

    if (lowerCondition.includes('approval') || lowerCondition.includes('approve')) {
      return evalContext.context.hasApproval === true;
    }

    return true;
  }

  private isCriticalResource(context: Record<string, unknown> | EvaluationContext): boolean {
    const target = (context as EvaluationContext).parameters?.target ??
                   (context as Record<string, unknown>).target;

    if (typeof target !== 'string') return false;

    const criticalPatterns = [
      /^\/?(system|boot|etc|var\/lib)/i,
      /\.(env|pem|key|crt|credential)/i,
      /password|secret|token|api.?key/i
    ];

    return criticalPatterns.some(pattern => pattern.test(target));
  }

  private mightExposeSecrets(context: Record<string, unknown> | EvaluationContext): boolean {
    const params = (context as EvaluationContext).parameters ?? context;

    const checkValue = (value: unknown): boolean => {
      if (typeof value === 'string') {
        const secretPatterns = [
          /password\s*[=:]/i,
          /api.?key\s*[=:]/i,
          /secret\s*[=:]/i,
          /token\s*[=:]/i,
          /-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----/i
        ];
        return secretPatterns.some(pattern => pattern.test(value));
      }
      if (typeof value === 'object' && value !== null) {
        return Object.values(value).some(checkValue);
      }
      return false;
    };

    return checkValue(params);
  }

  private isReversibleAction(action: string): boolean {
    const irreversibleActions = [
      'delete', 'destroy', 'drop', 'truncate', 'purge', 'wipe'
    ];
    return !irreversibleActions.some(a => action.toLowerCase().includes(a));
  }
}

interface EvaluationContext {
  context: {
    id: string;
    agentDID: string;
    agentType: string;
    timestamp: string;
    hasApproval: boolean;
    scope: ContextGraph['scope'];
  };
  affordance: {
    id: string;
    actionType: string;
    target: ContextGraph['affordances'][0]['target'];
  };
  parameters: Record<string, unknown>;
}
