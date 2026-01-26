import Database, { type Database as DatabaseType } from 'better-sqlite3';
import type {
  ITraceStore,
  ProvTrace,
  StoreResult,
  TraceQuery
} from '../interfaces/index.js';

/**
 * SQLite-backed Trace Store implementation
 * Provides persistent, append-only storage for PROV traces
 */
export class SQLiteTraceStore implements ITraceStore {
  private db: DatabaseType;
  private insertStmt: Database.Statement;
  private getByIdStmt: Database.Statement;

  constructor(dbPath: string = ':memory:') {
    this.db = new Database(dbPath);

    // Enable WAL mode for better concurrent performance
    this.db.pragma('journal_mode = WAL');

    // Create tables
    this.initSchema();

    // Prepare statements for performance
    this.insertStmt = this.db.prepare(`
      INSERT INTO traces (id, agent_did, agent_type, action_type, started_at, ended_at, data)
      VALUES (@id, @agentDid, @agentType, @actionType, @startedAt, @endedAt, @data)
    `);

    this.getByIdStmt = this.db.prepare(`
      SELECT data FROM traces WHERE id = ?
    `);
  }

  /**
   * Initialize database schema
   */
  private initSchema(): void {
    this.db.exec(`
      -- Main traces table
      CREATE TABLE IF NOT EXISTS traces (
        id TEXT PRIMARY KEY,
        agent_did TEXT NOT NULL,
        agent_type TEXT,
        action_type TEXT,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        data TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
      );

      -- Indexes for common queries
      CREATE INDEX IF NOT EXISTS idx_traces_agent ON traces(agent_did);
      CREATE INDEX IF NOT EXISTS idx_traces_action ON traces(action_type);
      CREATE INDEX IF NOT EXISTS idx_traces_started ON traces(started_at);
      CREATE INDEX IF NOT EXISTS idx_traces_agent_action ON traces(agent_did, action_type);

      -- Workflows table for state persistence
      CREATE TABLE IF NOT EXISTS workflows (
        id TEXT PRIMARY KEY,
        goal TEXT NOT NULL,
        status TEXT NOT NULL,
        data TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_workflows_status ON workflows(status);

      -- Tasks table
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        agent_did TEXT,
        data TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (workflow_id) REFERENCES workflows(id)
      );

      CREATE INDEX IF NOT EXISTS idx_tasks_workflow ON tasks(workflow_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_tasks_agent ON tasks(agent_did);

      -- Credentials table
      CREATE TABLE IF NOT EXISTS credentials (
        id TEXT PRIMARY KEY,
        holder_did TEXT NOT NULL,
        issuer_did TEXT NOT NULL,
        credential_type TEXT NOT NULL,
        issued_at TEXT,
        expires_at TEXT,
        data TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_credentials_holder ON credentials(holder_did);
      CREATE INDEX IF NOT EXISTS idx_credentials_issuer ON credentials(issuer_did);
      CREATE INDEX IF NOT EXISTS idx_credentials_type ON credentials(credential_type);

      -- Trust relationships table
      CREATE TABLE IF NOT EXISTS trust_relationships (
        id TEXT PRIMARY KEY,
        partner_broker_did TEXT NOT NULL,
        trust_level TEXT NOT NULL,
        status TEXT NOT NULL,
        established_at TEXT,
        expires_at TEXT,
        revoked_at TEXT,
        data TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_trust_partner ON trust_relationships(partner_broker_did);
      CREATE INDEX IF NOT EXISTS idx_trust_status ON trust_relationships(status);

      -- Causal evaluations log
      CREATE TABLE IF NOT EXISTS causal_evaluations (
        id TEXT PRIMARY KEY,
        model_ref TEXT NOT NULL,
        interventions TEXT,
        context TEXT,
        predictions TEXT,
        confidence REAL,
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_causal_model ON causal_evaluations(model_ref);
    `);
  }

  /**
   * Store a PROV trace (append-only)
   */
  async store(trace: ProvTrace): Promise<StoreResult> {
    // Validate trace has required fields
    if (!trace.id) {
      return { success: false, traceId: '', error: 'Trace must have an ID' };
    }

    // Check for duplicate (append-only means no overwrites)
    const existing = this.getByIdStmt.get(trace.id);
    if (existing) {
      return { success: false, traceId: trace.id, error: 'Trace already exists (append-only)' };
    }

    try {
      this.insertStmt.run({
        id: trace.id,
        agentDid: trace.wasAssociatedWith.agentDID,
        agentType: trace.wasAssociatedWith.agentType,
        actionType: trace.used.affordance.actionType,
        startedAt: trace.startedAtTime,
        endedAt: trace.endedAtTime,
        data: JSON.stringify(trace)
      });

      return { success: true, traceId: trace.id };
    } catch (error) {
      return {
        success: false,
        traceId: trace.id,
        error: `Failed to store trace: ${(error as Error).message}`
      };
    }
  }

  /**
   * Retrieve traces by query
   */
  async query(query: TraceQuery): Promise<ProvTrace[]> {
    const conditions: string[] = ['1=1'];
    const params: Record<string, unknown> = {};

    if (query.agentDID) {
      conditions.push('agent_did = @agentDid');
      params.agentDid = query.agentDID;
    }

    if (query.actionType) {
      conditions.push('action_type = @actionType');
      params.actionType = query.actionType;
    }

    if (query.fromTime) {
      conditions.push('started_at >= @fromTime');
      params.fromTime = query.fromTime;
    }

    if (query.toTime) {
      conditions.push('started_at <= @toTime');
      params.toTime = query.toTime;
    }

    const limit = query.limit ?? 100;
    const offset = query.offset ?? 0;

    const sql = `
      SELECT data FROM traces
      WHERE ${conditions.join(' AND ')}
      ORDER BY started_at DESC
      LIMIT @limit OFFSET @offset
    `;

    const stmt = this.db.prepare(sql);
    const rows = stmt.all({ ...params, limit, offset }) as Array<{ data: string }>;

    return rows.map(row => JSON.parse(row.data) as ProvTrace);
  }

  /**
   * Get a specific trace by ID
   */
  async getById(traceId: string): Promise<ProvTrace | null> {
    const row = this.getByIdStmt.get(traceId) as { data: string } | undefined;
    return row ? JSON.parse(row.data) as ProvTrace : null;
  }

  /**
   * Get total trace count
   */
  getCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) as count FROM traces').get() as { count: number };
    return row.count;
  }

  /**
   * Get traces for a specific agent
   */
  getTracesForAgent(agentDID: string): ProvTrace[] {
    const rows = this.db.prepare(`
      SELECT data FROM traces WHERE agent_did = ? ORDER BY started_at DESC
    `).all(agentDID) as Array<{ data: string }>;

    return rows.map(row => JSON.parse(row.data) as ProvTrace);
  }

  // ===========================================
  // Workflow persistence methods
  // ===========================================

  /**
   * Save a workflow
   */
  saveWorkflow(workflow: {
    id: string;
    goal: string;
    status: string;
    [key: string]: unknown;
  }): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO workflows (id, goal, status, data, updated_at)
      VALUES (@id, @goal, @status, @data, datetime('now'))
    `);

    stmt.run({
      id: workflow.id,
      goal: workflow.goal,
      status: workflow.status,
      data: JSON.stringify(workflow)
    });
  }

  /**
   * Get workflow by ID
   */
  getWorkflow(id: string): Record<string, unknown> | null {
    const row = this.db.prepare('SELECT data FROM workflows WHERE id = ?').get(id) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : null;
  }

  /**
   * Get all workflows
   */
  getAllWorkflows(): Array<Record<string, unknown>> {
    const rows = this.db.prepare('SELECT data FROM workflows ORDER BY created_at DESC').all() as Array<{ data: string }>;
    return rows.map(row => JSON.parse(row.data));
  }

  /**
   * Get workflows by status
   */
  getWorkflowsByStatus(status: string): Array<Record<string, unknown>> {
    const rows = this.db.prepare('SELECT data FROM workflows WHERE status = ? ORDER BY created_at DESC').all(status) as Array<{ data: string }>;
    return rows.map(row => JSON.parse(row.data));
  }

  // ===========================================
  // Task persistence methods
  // ===========================================

  /**
   * Save a task
   */
  saveTask(task: {
    id: string;
    workflowId: string;
    type: string;
    status: string;
    agentDID?: string;
    [key: string]: unknown;
  }): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO tasks (id, workflow_id, type, status, agent_did, data, updated_at)
      VALUES (@id, @workflowId, @type, @status, @agentDid, @data, datetime('now'))
    `);

    stmt.run({
      id: task.id,
      workflowId: task.workflowId,
      type: task.type,
      status: task.status,
      agentDid: task.agentDID ?? null,
      data: JSON.stringify(task)
    });
  }

  /**
   * Get tasks for a workflow
   */
  getTasksForWorkflow(workflowId: string): Array<Record<string, unknown>> {
    const rows = this.db.prepare('SELECT data FROM tasks WHERE workflow_id = ? ORDER BY created_at').all(workflowId) as Array<{ data: string }>;
    return rows.map(row => JSON.parse(row.data));
  }

  // ===========================================
  // Credential persistence methods
  // ===========================================

  /**
   * Save a credential
   */
  saveCredential(credential: {
    id: string;
    credentialSubject?: { id?: string };
    issuer?: string;
    type?: string[];
    issuanceDate?: string;
    expirationDate?: string;
    [key: string]: unknown;
  }): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO credentials (id, holder_did, issuer_did, credential_type, issued_at, expires_at, data)
      VALUES (@id, @holderDid, @issuerDid, @credentialType, @issuedAt, @expiresAt, @data)
    `);

    stmt.run({
      id: credential.id,
      holderDid: credential.credentialSubject?.id ?? '',
      issuerDid: credential.issuer ?? '',
      credentialType: (credential.type ?? []).join(','),
      issuedAt: credential.issuanceDate ?? null,
      expiresAt: credential.expirationDate ?? null,
      data: JSON.stringify(credential)
    });
  }

  /**
   * Get credentials for a holder
   */
  getCredentialsForHolder(holderDid: string): Array<Record<string, unknown>> {
    const rows = this.db.prepare('SELECT data FROM credentials WHERE holder_did = ?').all(holderDid) as Array<{ data: string }>;
    return rows.map(row => JSON.parse(row.data));
  }

  /**
   * Get all credentials
   */
  getAllCredentials(): Array<Record<string, unknown>> {
    const rows = this.db.prepare('SELECT data FROM credentials ORDER BY created_at DESC').all() as Array<{ data: string }>;
    return rows.map(row => JSON.parse(row.data));
  }

  // ===========================================
  // Causal evaluation persistence
  // ===========================================

  /**
   * Log a causal evaluation
   */
  logCausalEvaluation(evaluation: {
    id: string;
    modelRef: string;
    interventions: string[];
    context: Record<string, unknown>;
    predictions: Record<string, unknown>;
    confidence: number;
  }): void {
    const stmt = this.db.prepare(`
      INSERT INTO causal_evaluations (id, model_ref, interventions, context, predictions, confidence)
      VALUES (@id, @modelRef, @interventions, @context, @predictions, @confidence)
    `);

    stmt.run({
      id: evaluation.id,
      modelRef: evaluation.modelRef,
      interventions: JSON.stringify(evaluation.interventions),
      context: JSON.stringify(evaluation.context),
      predictions: JSON.stringify(evaluation.predictions),
      confidence: evaluation.confidence
    });
  }

  /**
   * Get causal evaluations for a model
   */
  getCausalEvaluationsForModel(modelRef: string): Array<{
    id: string;
    interventions: string[];
    context: Record<string, unknown>;
    predictions: Record<string, unknown>;
    confidence: number;
  }> {
    const rows = this.db.prepare(`
      SELECT id, interventions, context, predictions, confidence
      FROM causal_evaluations
      WHERE model_ref = ?
      ORDER BY created_at DESC
    `).all(modelRef) as Array<{
      id: string;
      interventions: string;
      context: string;
      predictions: string;
      confidence: number;
    }>;

    return rows.map(row => ({
      id: row.id,
      interventions: JSON.parse(row.interventions),
      context: JSON.parse(row.context),
      predictions: JSON.parse(row.predictions),
      confidence: row.confidence
    }));
  }

  // ===========================================
  // Utility methods
  // ===========================================

  /**
   * Close the database connection
   */
  close(): void {
    this.db.close();
  }

  /**
   * Get database statistics
   */
  getStats(): {
    traces: number;
    workflows: number;
    tasks: number;
    credentials: number;
    causalEvaluations: number;
  } {
    return {
      traces: (this.db.prepare('SELECT COUNT(*) as c FROM traces').get() as { c: number }).c,
      workflows: (this.db.prepare('SELECT COUNT(*) as c FROM workflows').get() as { c: number }).c,
      tasks: (this.db.prepare('SELECT COUNT(*) as c FROM tasks').get() as { c: number }).c,
      credentials: (this.db.prepare('SELECT COUNT(*) as c FROM credentials').get() as { c: number }).c,
      causalEvaluations: (this.db.prepare('SELECT COUNT(*) as c FROM causal_evaluations').get() as { c: number }).c
    };
  }

  /**
   * Vacuum the database to reclaim space
   */
  vacuum(): void {
    this.db.exec('VACUUM');
  }

  /**
   * Export all data as JSON (for backup)
   */
  exportData(): {
    traces: ProvTrace[];
    workflows: Array<Record<string, unknown>>;
    credentials: Array<Record<string, unknown>>;
  } {
    return {
      traces: (this.db.prepare('SELECT data FROM traces').all() as Array<{ data: string }>).map(r => JSON.parse(r.data)),
      workflows: this.getAllWorkflows(),
      credentials: this.getAllCredentials()
    };
  }

  /**
   * Get the raw database instance (for advanced operations)
   */
  getRawDb(): DatabaseType {
    return this.db;
  }
}
