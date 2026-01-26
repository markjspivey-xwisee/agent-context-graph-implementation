import type {
  ICausalEvaluator,
  CausalEvaluationResult,
  OutcomeConstraint,
  ConstraintCheckResult,
  ConstraintViolation,
  CausalSemantics
} from '../interfaces/index.js';

/**
 * Structural Causal Model (SCM) representation
 * Supports Pearl's do-calculus notation for interventions
 */
export interface StructuralCausalModel {
  /** Model identifier (URN) */
  id: string;
  /** Human-readable name */
  name: string;
  /** Endogenous variables (determined by model) */
  endogenousVars: string[];
  /** Exogenous variables (external inputs) */
  exogenousVars: string[];
  /** Structural equations mapping parents to child values */
  equations: CausalEquation[];
  /** Default predictions for quick evaluation */
  defaultPredictions: Record<string, unknown>;
}

/**
 * A causal equation in the SCM
 * Format: Y := f(X1, X2, ..., U) where U is noise/exogenous
 */
export interface CausalEquation {
  /** The variable being computed */
  target: string;
  /** Parent variables that influence this variable */
  parents: string[];
  /** Function type: 'linear', 'threshold', 'multiplicative', 'custom' */
  functionType: 'linear' | 'threshold' | 'multiplicative' | 'custom';
  /** Coefficients for linear models */
  coefficients?: Record<string, number>;
  /** Intercept/bias term */
  intercept?: number;
  /** Threshold value for threshold functions */
  threshold?: number;
  /** Custom function expression (evaluated safely) */
  customExpr?: string;
}

/**
 * Intervention representation using do() notation
 * do(X = x) means forcibly set X to value x, breaking causal links
 */
export interface DoIntervention {
  /** The variable being intervened upon */
  variable: string;
  /** The value being set */
  value: unknown;
  /** Human-readable label for the intervention */
  label: string;
}

/**
 * Result of a counterfactual query
 */
export interface CounterfactualResult {
  /** The counterfactual query in natural language */
  query: string;
  /** What would Y have been if we had done do(X=x)? */
  interventions: DoIntervention[];
  /** Predicted outcomes under the intervention */
  predictedOutcomes: Record<string, unknown>;
  /** Actual outcomes (if available) */
  actualOutcomes?: Record<string, unknown>;
  /** Causal effect = predicted - actual */
  causalEffect?: Record<string, number>;
  /** Confidence in the counterfactual estimate */
  confidence: number;
}

/**
 * Real Causal Evaluator with do() intervention support
 * Implements Pearl's do-calculus for causal inference
 */
export class RealCausalEvaluator implements ICausalEvaluator {
  private models: Map<string, StructuralCausalModel> = new Map();
  private interventionHistory: DoIntervention[] = [];
  private traceEmitter?: (trace: Record<string, unknown>) => void;

  constructor() {
    // Register built-in causal models
    this.registerDefaultModels();
  }

  /**
   * Register default causal models for common scenarios
   */
  private registerDefaultModels(): void {
    // Database Migration Model
    this.registerModel({
      id: 'urn:causal-model:db-migration-v2',
      name: 'Database Migration Causal Model',
      endogenousVars: ['downtime_minutes', 'data_loss_probability', 'rollback_complexity', 'success'],
      exogenousVars: ['database_size', 'concurrent_connections', 'backup_available', 'dry_run'],
      equations: [
        {
          target: 'downtime_minutes',
          parents: ['database_size', 'concurrent_connections'],
          functionType: 'linear',
          coefficients: { database_size: 0.001, concurrent_connections: 0.05 },
          intercept: 1.0
        },
        {
          target: 'data_loss_probability',
          parents: ['backup_available', 'dry_run'],
          functionType: 'threshold',
          threshold: 0.5
        },
        {
          target: 'rollback_complexity',
          parents: ['database_size', 'downtime_minutes'],
          functionType: 'linear',
          coefficients: { database_size: 0.0001, downtime_minutes: 0.1 },
          intercept: 0.1
        },
        {
          target: 'success',
          parents: ['data_loss_probability', 'downtime_minutes'],
          functionType: 'threshold',
          threshold: 5.0
        }
      ],
      defaultPredictions: {
        downtime_minutes: 2.5,
        data_loss_probability: 0.001,
        rollback_complexity: 0.3,
        success: 0.95
      }
    });

    // Deployment Model
    this.registerModel({
      id: 'urn:causal-model:deployment-v1',
      name: 'Deployment Causal Model',
      endogenousVars: ['deployment_success', 'rollback_needed', 'user_impact', 'mttr'],
      exogenousVars: ['test_coverage', 'canary_percentage', 'feature_flags_enabled', 'monitoring_active'],
      equations: [
        {
          target: 'deployment_success',
          parents: ['test_coverage', 'canary_percentage'],
          functionType: 'multiplicative',
          coefficients: { test_coverage: 0.6, canary_percentage: 0.4 }
        },
        {
          target: 'rollback_needed',
          parents: ['deployment_success'],
          functionType: 'threshold',
          threshold: 0.9
        },
        {
          target: 'user_impact',
          parents: ['rollback_needed', 'feature_flags_enabled'],
          functionType: 'linear',
          coefficients: { rollback_needed: 50, feature_flags_enabled: -30 },
          intercept: 10
        },
        {
          target: 'mttr',
          parents: ['monitoring_active', 'rollback_needed'],
          functionType: 'linear',
          coefficients: { monitoring_active: -10, rollback_needed: 15 },
          intercept: 5
        }
      ],
      defaultPredictions: {
        deployment_success: 0.95,
        rollback_needed: 0.05,
        user_impact: 5,
        mttr: 10
      }
    });

    // Code Review Model
    this.registerModel({
      id: 'urn:causal-model:code-review-v1',
      name: 'Code Review Causal Model',
      endogenousVars: ['bug_escape_rate', 'review_time', 'merge_confidence', 'tech_debt_delta'],
      exogenousVars: ['code_complexity', 'test_coverage', 'reviewer_expertise', 'change_size'],
      equations: [
        {
          target: 'bug_escape_rate',
          parents: ['code_complexity', 'test_coverage', 'reviewer_expertise'],
          functionType: 'linear',
          coefficients: { code_complexity: 0.3, test_coverage: -0.5, reviewer_expertise: -0.2 },
          intercept: 0.5
        },
        {
          target: 'review_time',
          parents: ['code_complexity', 'change_size'],
          functionType: 'linear',
          coefficients: { code_complexity: 10, change_size: 0.5 },
          intercept: 5
        },
        {
          target: 'merge_confidence',
          parents: ['bug_escape_rate', 'test_coverage'],
          functionType: 'multiplicative',
          coefficients: { bug_escape_rate: -0.5, test_coverage: 0.5 }
        },
        {
          target: 'tech_debt_delta',
          parents: ['code_complexity', 'reviewer_expertise'],
          functionType: 'linear',
          coefficients: { code_complexity: 5, reviewer_expertise: -3 },
          intercept: 0
        }
      ],
      defaultPredictions: {
        bug_escape_rate: 0.1,
        review_time: 30,
        merge_confidence: 0.85,
        tech_debt_delta: 0
      }
    });
  }

  /**
   * Register a causal model
   */
  registerModel(model: StructuralCausalModel): void {
    this.models.set(model.id, model);
  }

  /**
   * Set trace emitter for PROV tracking
   */
  setTraceEmitter(emitter: (trace: Record<string, unknown>) => void): void {
    this.traceEmitter = emitter;
  }

  /**
   * Parse a do() intervention label
   * Format: "do(variable=value)" or "do(var1=val1, var2=val2)"
   */
  parseDoLabel(label: string): DoIntervention[] {
    const interventions: DoIntervention[] = [];
    const doMatch = label.match(/do\(([^)]+)\)/g);

    if (!doMatch) return interventions;

    for (const doExpr of doMatch) {
      const inner = doExpr.slice(3, -1); // Remove "do(" and ")"
      const assignments = inner.split(',').map(s => s.trim());

      for (const assignment of assignments) {
        const [variable, valueStr] = assignment.split('=').map(s => s.trim());
        if (variable && valueStr !== undefined) {
          // Parse value: number, boolean, or string
          let value: unknown = valueStr;
          if (valueStr === 'true') value = true;
          else if (valueStr === 'false') value = false;
          else if (!isNaN(parseFloat(valueStr))) value = parseFloat(valueStr);

          interventions.push({ variable, value, label: `do(${variable}=${valueStr})` });
        }
      }
    }

    return interventions;
  }

  /**
   * Evaluate causal model with do() intervention
   */
  async evaluate(
    modelRef: string,
    intervention: string,
    context: Record<string, unknown>
  ): Promise<CausalEvaluationResult> {
    const model = this.models.get(modelRef);

    if (!model) {
      return {
        success: false,
        predictedOutcomes: {},
        confidence: 0,
        error: `Unknown causal model: ${modelRef}`
      };
    }

    // Parse do() interventions from the intervention string
    const doInterventions = this.parseDoLabel(intervention);

    // Track interventions
    this.interventionHistory.push(...doInterventions);

    // Compute predictions using SCM
    const predictions = this.computeSCMPredictions(model, doInterventions, context);

    // Compute confidence based on model complexity and data availability
    const confidence = this.computeConfidence(model, doInterventions, context);

    // Emit PROV trace
    if (this.traceEmitter) {
      this.emitCausalTrace(model, doInterventions, context, predictions, confidence);
    }

    return {
      success: true,
      predictedOutcomes: predictions,
      confidence
    };
  }

  /**
   * Compute predictions using Structural Causal Model equations
   */
  private computeSCMPredictions(
    model: StructuralCausalModel,
    interventions: DoIntervention[],
    context: Record<string, unknown>
  ): Record<string, unknown> {
    // Start with exogenous variables from context
    const values: Record<string, unknown> = {};

    // Initialize exogenous variables
    for (const exoVar of model.exogenousVars) {
      values[exoVar] = context[exoVar] ?? 0;
    }

    // Apply interventions (do() operations break causal links)
    const interventedVars = new Set(interventions.map(i => i.variable));
    for (const intervention of interventions) {
      values[intervention.variable] = intervention.value;
    }

    // Topologically sort equations and compute endogenous variables
    // (simplified: assumes equations are already in causal order)
    for (const equation of model.equations) {
      // Skip if this variable was intervened upon
      if (interventedVars.has(equation.target)) continue;

      values[equation.target] = this.evaluateEquation(equation, values);
    }

    // Return only endogenous variables as predictions
    const predictions: Record<string, unknown> = {};
    for (const endoVar of model.endogenousVars) {
      predictions[endoVar] = values[endoVar] ?? model.defaultPredictions[endoVar];
    }

    return predictions;
  }

  /**
   * Evaluate a single structural equation
   */
  private evaluateEquation(equation: CausalEquation, values: Record<string, unknown>): number {
    switch (equation.functionType) {
      case 'linear': {
        let result = equation.intercept ?? 0;
        for (const parent of equation.parents) {
          const coeff = equation.coefficients?.[parent] ?? 0;
          const parentVal = typeof values[parent] === 'number' ? values[parent] as number : 0;
          result += coeff * parentVal;
        }
        return Math.max(0, result); // Clamp to non-negative
      }

      case 'threshold': {
        const threshold = equation.threshold ?? 0.5;
        // For threshold: if any parent exceeds threshold, return 1, else 0
        for (const parent of equation.parents) {
          const parentVal = typeof values[parent] === 'number' ? values[parent] as number : 0;
          if (parentVal > threshold) return 1;
        }
        return 0;
      }

      case 'multiplicative': {
        let result = 1;
        for (const parent of equation.parents) {
          const coeff = equation.coefficients?.[parent] ?? 1;
          const parentVal = typeof values[parent] === 'number' ? values[parent] as number : 1;
          result *= Math.pow(parentVal, coeff);
        }
        return result;
      }

      case 'custom':
        // Custom expressions would be evaluated here (safely)
        return 0;

      default:
        return 0;
    }
  }

  /**
   * Compute confidence score for the causal estimate
   */
  private computeConfidence(
    model: StructuralCausalModel,
    interventions: DoIntervention[],
    context: Record<string, unknown>
  ): number {
    let confidence = 0.9; // Base confidence

    // Reduce confidence if many interventions
    confidence -= interventions.length * 0.05;

    // Reduce confidence if missing exogenous variables
    for (const exoVar of model.exogenousVars) {
      if (context[exoVar] === undefined) {
        confidence -= 0.05;
      }
    }

    // Clamp to [0.1, 1.0]
    return Math.max(0.1, Math.min(1.0, confidence));
  }

  /**
   * Emit PROV trace for causal evaluation
   */
  private emitCausalTrace(
    model: StructuralCausalModel,
    interventions: DoIntervention[],
    context: Record<string, unknown>,
    predictions: Record<string, unknown>,
    confidence: number
  ): void {
    if (!this.traceEmitter) return;

    this.traceEmitter({
      '@context': [
        'https://www.w3.org/ns/prov#',
        'https://agentcontextgraph.dev/causal#'
      ],
      '@type': ['prov:Activity', 'causal:CausalEvaluation'],
      id: `urn:trace:causal-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      'prov:startedAtTime': new Date().toISOString(),
      'prov:endedAtTime': new Date().toISOString(),
      'prov:used': {
        'causal:model': model.id,
        'causal:modelName': model.name,
        'causal:interventions': interventions.map(i => i.label),
        'causal:context': context
      },
      'prov:generated': {
        'causal:predictions': predictions,
        'causal:confidence': confidence
      }
    });
  }

  /**
   * Query counterfactual: What would Y have been if we had done do(X=x)?
   */
  async queryCounterfactual(
    modelRef: string,
    actualOutcomes: Record<string, unknown>,
    hypotheticalInterventions: DoIntervention[]
  ): Promise<CounterfactualResult> {
    const result = await this.evaluate(
      modelRef,
      hypotheticalInterventions.map(i => i.label).join(', '),
      actualOutcomes
    );

    const causalEffect: Record<string, number> = {};
    for (const [key, predicted] of Object.entries(result.predictedOutcomes)) {
      const actual = actualOutcomes[key];
      if (typeof predicted === 'number' && typeof actual === 'number') {
        causalEffect[key] = predicted - actual;
      }
    }

    return {
      query: `What would outcomes have been if ${hypotheticalInterventions.map(i => i.label).join(' and ')}?`,
      interventions: hypotheticalInterventions,
      predictedOutcomes: result.predictedOutcomes,
      actualOutcomes,
      causalEffect,
      confidence: result.confidence
    };
  }

  /**
   * Build causal semantics for an affordance
   */
  buildCausalSemantics(
    interventionLabel: string,
    outcomeVariables: string[],
    causalModelRef: string,
    evaluatorEndpoint?: string
  ): CausalSemantics {
    return {
      interventionLabel,
      outcomeVariables,
      causalModelRef,
      evaluatorEndpoint
    };
  }

  /**
   * Check if outcomes meet constraints
   */
  async checkConstraints(
    outcomes: Record<string, unknown>,
    constraints: OutcomeConstraint[]
  ): Promise<ConstraintCheckResult> {
    const violations: ConstraintViolation[] = [];

    for (const constraint of constraints) {
      const actualValue = outcomes[constraint.variable];

      if (actualValue === undefined) {
        violations.push({
          constraint,
          actualValue: undefined,
          message: `Missing outcome variable: ${constraint.variable}`
        });
        continue;
      }

      const satisfied = this.evaluateConstraint(actualValue, constraint);
      if (!satisfied) {
        violations.push({
          constraint,
          actualValue,
          message: `Constraint violation: ${constraint.variable} ${constraint.operator} ${constraint.threshold} (actual: ${actualValue})`
        });
      }
    }

    return {
      allSatisfied: violations.length === 0,
      violations
    };
  }

  /**
   * Evaluate a single constraint
   */
  private evaluateConstraint(
    actualValue: unknown,
    constraint: OutcomeConstraint
  ): boolean {
    const actual = typeof actualValue === 'number' ? actualValue : parseFloat(String(actualValue));
    const threshold = typeof constraint.threshold === 'number'
      ? constraint.threshold
      : parseFloat(String(constraint.threshold));

    if (isNaN(actual) || isNaN(threshold)) {
      return false;
    }

    switch (constraint.operator) {
      case '<': return actual < threshold;
      case '>': return actual > threshold;
      case '<=': return actual <= threshold;
      case '>=': return actual >= threshold;
      case '==': return actual === threshold;
      case '!=': return actual !== threshold;
      default: return false;
    }
  }

  /**
   * Get all registered models
   */
  getModels(): StructuralCausalModel[] {
    return Array.from(this.models.values());
  }

  /**
   * Get intervention history
   */
  getInterventionHistory(): DoIntervention[] {
    return [...this.interventionHistory];
  }

  /**
   * Clear intervention history
   */
  clearInterventionHistory(): void {
    this.interventionHistory = [];
  }
}

/**
 * Stub Causal Evaluator - simplified version for testing
 * @deprecated Use RealCausalEvaluator for production
 */
export class StubCausalEvaluator implements ICausalEvaluator {
  private models: Map<string, CausalModel> = new Map();

  constructor() {
    // Register some example causal models
    this.registerModel({
      id: 'urn:causal-model:db-migration-v2',
      name: 'Database Migration Model',
      outcomeVariables: ['downtime_minutes', 'data_loss_probability', 'rollback_complexity'],
      defaultPredictions: {
        downtime_minutes: 2.5,
        data_loss_probability: 0.001,
        rollback_complexity: 0.3
      }
    });

    this.registerModel({
      id: 'urn:causal-model:db-rollback-v1',
      name: 'Database Rollback Model',
      outcomeVariables: ['downtime_minutes', 'data_integrity_preserved'],
      defaultPredictions: {
        downtime_minutes: 1.0,
        data_integrity_preserved: 0.99
      }
    });
  }

  /**
   * Register a causal model
   */
  registerModel(model: CausalModel): void {
    this.models.set(model.id, model);
  }

  /**
   * Evaluate causal model for predicted outcomes
   */
  async evaluate(
    modelRef: string,
    intervention: string,
    context: Record<string, unknown>
  ): Promise<CausalEvaluationResult> {
    const model = this.models.get(modelRef);

    if (!model) {
      return {
        success: false,
        predictedOutcomes: {},
        confidence: 0,
        error: `Unknown causal model: ${modelRef}`
      };
    }

    // In production: would run actual causal inference
    // For now, return default predictions adjusted by context
    const predictions = this.computePredictions(model, intervention, context);

    return {
      success: true,
      predictedOutcomes: predictions,
      confidence: 0.85 // Stub confidence value
    };
  }

  /**
   * Check if outcomes meet constraints
   */
  async checkConstraints(
    outcomes: Record<string, unknown>,
    constraints: OutcomeConstraint[]
  ): Promise<ConstraintCheckResult> {
    const violations: ConstraintViolation[] = [];

    for (const constraint of constraints) {
      const actualValue = outcomes[constraint.variable];

      if (actualValue === undefined) {
        violations.push({
          constraint,
          actualValue: undefined,
          message: `Missing outcome variable: ${constraint.variable}`
        });
        continue;
      }

      const satisfied = this.evaluateConstraint(actualValue, constraint);
      if (!satisfied) {
        violations.push({
          constraint,
          actualValue,
          message: `Constraint violation: ${constraint.variable} ${constraint.operator} ${constraint.threshold} (actual: ${actualValue})`
        });
      }
    }

    return {
      allSatisfied: violations.length === 0,
      violations
    };
  }

  /**
   * Compute predictions based on model and context
   */
  private computePredictions(
    model: CausalModel,
    _intervention: string,
    context: Record<string, unknown>
  ): Record<string, unknown> {
    const predictions = { ...model.defaultPredictions };

    // Adjust predictions based on context (stub logic)
    if (context.dryRun === true) {
      predictions.downtime_minutes = 0;
      predictions.data_loss_probability = 0;
    }

    if (context.highLoad === true) {
      if (typeof predictions.downtime_minutes === 'number') {
        predictions.downtime_minutes *= 1.5;
      }
    }

    return predictions;
  }

  /**
   * Evaluate a single constraint
   */
  private evaluateConstraint(
    actualValue: unknown,
    constraint: OutcomeConstraint
  ): boolean {
    const actual = typeof actualValue === 'number' ? actualValue : parseFloat(String(actualValue));
    const threshold = typeof constraint.threshold === 'number'
      ? constraint.threshold
      : parseFloat(String(constraint.threshold));

    if (isNaN(actual) || isNaN(threshold)) {
      return false;
    }

    switch (constraint.operator) {
      case '<': return actual < threshold;
      case '>': return actual > threshold;
      case '<=': return actual <= threshold;
      case '>=': return actual >= threshold;
      case '==': return actual === threshold;
      case '!=': return actual !== threshold;
      default: return false;
    }
  }
}

interface CausalModel {
  id: string;
  name: string;
  outcomeVariables: string[];
  defaultPredictions: Record<string, unknown>;
}
