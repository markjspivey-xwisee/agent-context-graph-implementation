import { v4 as uuidv4 } from 'uuid';
import { EventEmitter } from 'eventemitter3';

export type TaskStatus = 'pending' | 'queued' | 'assigned' | 'running' | 'completed' | 'failed' | 'blocked';
export type TaskPriority = 'low' | 'normal' | 'high' | 'critical';

export interface Task {
  id: string;
  type: 'plan' | 'execute' | 'observe' | 'approve' | 'archive';
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  assignedAgent: string | null;
  parentTask: string | null;
  subtasks: string[];
  dependencies: string[];
  input: Record<string, unknown>;
  output: unknown;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
  metadata: Record<string, unknown>;
}

export interface TaskEvents {
  'task-created': (task: Task) => void;
  'task-updated': (task: Task) => void;
  'task-assigned': (task: Task, agentId: string) => void;
  'task-completed': (task: Task) => void;
  'task-failed': (task: Task, error: string) => void;
  'subtask-created': (parent: Task, subtask: Task) => void;
}

/**
 * TaskManager - Manages task lifecycle, queue, and dependencies
 */
export class TaskManager extends EventEmitter<TaskEvents> {
  private tasks: Map<string, Task> = new Map();
  private queue: string[] = []; // Task IDs in priority order

  /**
   * Create a new task
   */
  createTask(params: {
    type: Task['type'];
    description: string;
    priority?: TaskPriority;
    parentTask?: string;
    dependencies?: string[];
    input?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  }): Task {
    const task: Task = {
      id: uuidv4(),
      type: params.type,
      description: params.description,
      status: 'pending',
      priority: params.priority ?? 'normal',
      assignedAgent: null,
      parentTask: params.parentTask ?? null,
      subtasks: [],
      dependencies: params.dependencies ?? [],
      input: params.input ?? {},
      output: null,
      createdAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null,
      error: null,
      metadata: params.metadata ?? {}
    };

    this.tasks.set(task.id, task);

    // Add to parent's subtasks if applicable
    if (task.parentTask) {
      const parent = this.tasks.get(task.parentTask);
      if (parent) {
        parent.subtasks.push(task.id);
      }
    }

    // Add to queue if no unmet dependencies
    if (this.areDependenciesMet(task)) {
      this.enqueue(task.id);
    }

    this.emit('task-created', task);
    return task;
  }

  /**
   * Create subtasks for a parent task
   */
  createSubtasks(
    parentId: string,
    subtaskParams: Array<{
      type: Task['type'];
      description: string;
      input?: Record<string, unknown>;
    }>
  ): Task[] {
    const parent = this.tasks.get(parentId);
    if (!parent) {
      throw new Error(`Parent task ${parentId} not found`);
    }

    const subtasks: Task[] = [];
    let previousTaskId: string | null = null;

    for (const params of subtaskParams) {
      const subtask = this.createTask({
        type: params.type,
        description: params.description,
        priority: parent.priority,
        parentTask: parentId,
        dependencies: previousTaskId ? [previousTaskId] : [],
        input: params.input
      });

      subtasks.push(subtask);
      this.emit('subtask-created', parent, subtask);
      previousTaskId = subtask.id;
    }

    return subtasks;
  }

  /**
   * Get a task by ID
   */
  getTask(taskId: string): Task | undefined {
    return this.tasks.get(taskId);
  }

  /**
   * Get all tasks
   */
  getAllTasks(): Task[] {
    return Array.from(this.tasks.values());
  }

  /**
   * Get tasks by status
   */
  getTasksByStatus(status: TaskStatus): Task[] {
    return Array.from(this.tasks.values()).filter(t => t.status === status);
  }

  /**
   * Get next task from queue that can be assigned
   */
  getNextTask(agentType?: string): Task | null {
    // Map agent type to task type
    const taskTypeMap: Record<string, Task['type']> = {
      planner: 'plan',
      executor: 'execute',
      observer: 'observe',
      arbiter: 'approve',
      archivist: 'archive'
    };

    const targetType = agentType ? taskTypeMap[agentType] : undefined;

    for (const taskId of this.queue) {
      const task = this.tasks.get(taskId);
      if (!task) continue;

      // Skip if already assigned
      if (task.assignedAgent) continue;

      // Skip if dependencies not met
      if (!this.areDependenciesMet(task)) continue;

      // Filter by type if specified
      if (targetType && task.type !== targetType) continue;

      return task;
    }

    return null;
  }

  /**
   * Assign a task to an agent
   */
  assignTask(taskId: string, agentId: string): Task {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }

    task.assignedAgent = agentId;
    task.status = 'assigned';

    // Remove from queue
    this.queue = this.queue.filter(id => id !== taskId);

    this.emit('task-assigned', task, agentId);
    this.emit('task-updated', task);

    return task;
  }

  /**
   * Start a task
   */
  startTask(taskId: string): Task {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }

    task.status = 'running';
    task.startedAt = new Date().toISOString();

    this.emit('task-updated', task);
    return task;
  }

  /**
   * Complete a task
   */
  completeTask(taskId: string, output: unknown): Task {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }

    task.status = 'completed';
    task.completedAt = new Date().toISOString();
    task.output = output;

    this.emit('task-completed', task);
    this.emit('task-updated', task);

    // Check if this unblocks any dependent tasks
    this.checkDependentTasks(taskId);

    // Check if parent task is complete
    if (task.parentTask) {
      this.checkParentCompletion(task.parentTask);
    }

    return task;
  }

  /**
   * Fail a task
   */
  failTask(taskId: string, error: string): Task {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }

    task.status = 'failed';
    task.completedAt = new Date().toISOString();
    task.error = error;

    this.emit('task-failed', task, error);
    this.emit('task-updated', task);

    // Block dependent tasks
    this.blockDependentTasks(taskId, `Dependency ${taskId} failed`);

    return task;
  }

  /**
   * Block a task
   */
  blockTask(taskId: string, reason: string): Task {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }

    task.status = 'blocked';
    task.error = reason;

    // Remove from queue
    this.queue = this.queue.filter(id => id !== taskId);

    this.emit('task-updated', task);
    return task;
  }

  /**
   * Get task statistics
   */
  getStats(): {
    total: number;
    byStatus: Record<TaskStatus, number>;
    byType: Record<string, number>;
    queueLength: number;
  } {
    const tasks = Array.from(this.tasks.values());

    const byStatus: Record<TaskStatus, number> = {
      pending: 0,
      queued: 0,
      assigned: 0,
      running: 0,
      completed: 0,
      failed: 0,
      blocked: 0
    };

    const byType: Record<string, number> = {};

    for (const task of tasks) {
      byStatus[task.status]++;
      byType[task.type] = (byType[task.type] ?? 0) + 1;
    }

    return {
      total: tasks.length,
      byStatus,
      byType,
      queueLength: this.queue.length
    };
  }

  /**
   * Check if task dependencies are met
   */
  private areDependenciesMet(task: Task): boolean {
    for (const depId of task.dependencies) {
      const dep = this.tasks.get(depId);
      if (!dep || dep.status !== 'completed') {
        return false;
      }
    }
    return true;
  }

  /**
   * Add task to priority queue
   */
  private enqueue(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (!task) return;

    task.status = 'queued';

    const priorityOrder: Record<TaskPriority, number> = {
      critical: 0,
      high: 1,
      normal: 2,
      low: 3
    };

    // Insert in priority order
    let inserted = false;
    for (let i = 0; i < this.queue.length; i++) {
      const existingTask = this.tasks.get(this.queue[i]);
      if (existingTask && priorityOrder[task.priority] < priorityOrder[existingTask.priority]) {
        this.queue.splice(i, 0, taskId);
        inserted = true;
        break;
      }
    }

    if (!inserted) {
      this.queue.push(taskId);
    }

    this.emit('task-updated', task);
  }

  /**
   * Check and enqueue tasks that depended on completed task
   */
  private checkDependentTasks(completedTaskId: string): void {
    for (const task of this.tasks.values()) {
      if (
        task.dependencies.includes(completedTaskId) &&
        task.status === 'pending' &&
        this.areDependenciesMet(task)
      ) {
        this.enqueue(task.id);
      }
    }
  }

  /**
   * Block tasks that depended on a failed task
   */
  private blockDependentTasks(failedTaskId: string, reason: string): void {
    for (const task of this.tasks.values()) {
      if (
        task.dependencies.includes(failedTaskId) &&
        (task.status === 'pending' || task.status === 'queued')
      ) {
        this.blockTask(task.id, reason);
      }
    }
  }

  /**
   * Check if all subtasks of a parent are complete
   */
  private checkParentCompletion(parentId: string): void {
    const parent = this.tasks.get(parentId);
    if (!parent) return;

    const allSubtasksComplete = parent.subtasks.every(subtaskId => {
      const subtask = this.tasks.get(subtaskId);
      return subtask?.status === 'completed';
    });

    if (allSubtasksComplete && parent.status === 'running') {
      // Aggregate subtask outputs
      const subtaskOutputs = parent.subtasks.map(id => ({
        id,
        output: this.tasks.get(id)?.output
      }));

      this.completeTask(parentId, { subtaskOutputs });
    }
  }
}
