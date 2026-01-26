// Using vitest globals
import { TaskManager, type Task } from '../../src/agents/task-manager.js';

describe('TaskManager', () => {
  let taskManager: TaskManager;

  beforeEach(() => {
    taskManager = new TaskManager();
  });

  describe('createTask', () => {
    it('should create a task with correct initial state', () => {
      const task = taskManager.createTask({
        type: 'plan',
        description: 'Create a plan for user authentication'
      });

      expect(task.id).toBeDefined();
      expect(task.type).toBe('plan');
      expect(task.description).toBe('Create a plan for user authentication');
      expect(task.status).toBe('queued'); // No dependencies, so queued
      expect(task.priority).toBe('normal');
      expect(task.assignedAgent).toBeNull();
    });

    it('should set custom priority', () => {
      const task = taskManager.createTask({
        type: 'execute',
        description: 'Critical action',
        priority: 'critical'
      });

      expect(task.priority).toBe('critical');
    });

    it('should handle dependencies', () => {
      const task1 = taskManager.createTask({
        type: 'plan',
        description: 'First task'
      });

      const task2 = taskManager.createTask({
        type: 'execute',
        description: 'Second task - depends on first',
        dependencies: [task1.id]
      });

      // Task 2 should be pending since task 1 is not complete
      expect(task2.status).toBe('pending');
    });
  });

  describe('task queue', () => {
    it('should return tasks in priority order', () => {
      taskManager.createTask({
        type: 'plan',
        description: 'Low priority',
        priority: 'low'
      });

      taskManager.createTask({
        type: 'plan',
        description: 'High priority',
        priority: 'high'
      });

      taskManager.createTask({
        type: 'plan',
        description: 'Normal priority',
        priority: 'normal'
      });

      // Get next task - should be high priority
      const next = taskManager.getNextTask('planner');
      expect(next?.description).toBe('High priority');
    });

    it('should filter by agent type', () => {
      taskManager.createTask({
        type: 'plan',
        description: 'Planning task'
      });

      taskManager.createTask({
        type: 'execute',
        description: 'Execution task'
      });

      // Planner should only get plan tasks
      const planTask = taskManager.getNextTask('planner');
      expect(planTask?.type).toBe('plan');

      // Executor should only get execute tasks
      const execTask = taskManager.getNextTask('executor');
      expect(execTask?.type).toBe('execute');
    });
  });

  describe('task lifecycle', () => {
    it('should assign task to agent', () => {
      const task = taskManager.createTask({
        type: 'plan',
        description: 'Test task'
      });

      taskManager.assignTask(task.id, 'agent-123');

      const updated = taskManager.getTask(task.id);
      expect(updated?.assignedAgent).toBe('agent-123');
      expect(updated?.status).toBe('assigned');
    });

    it('should start task', () => {
      const task = taskManager.createTask({
        type: 'plan',
        description: 'Test task'
      });

      taskManager.assignTask(task.id, 'agent-123');
      taskManager.startTask(task.id);

      const updated = taskManager.getTask(task.id);
      expect(updated?.status).toBe('running');
      expect(updated?.startedAt).toBeDefined();
    });

    it('should complete task', () => {
      const task = taskManager.createTask({
        type: 'plan',
        description: 'Test task'
      });

      taskManager.assignTask(task.id, 'agent-123');
      taskManager.startTask(task.id);
      taskManager.completeTask(task.id, { result: 'success' });

      const updated = taskManager.getTask(task.id);
      expect(updated?.status).toBe('completed');
      expect(updated?.output).toEqual({ result: 'success' });
      expect(updated?.completedAt).toBeDefined();
    });

    it('should fail task', () => {
      const task = taskManager.createTask({
        type: 'plan',
        description: 'Test task'
      });

      taskManager.assignTask(task.id, 'agent-123');
      taskManager.startTask(task.id);
      taskManager.failTask(task.id, 'Something went wrong');

      const updated = taskManager.getTask(task.id);
      expect(updated?.status).toBe('failed');
      expect(updated?.error).toBe('Something went wrong');
    });
  });

  describe('dependencies', () => {
    it('should unblock dependent task when dependency completes', () => {
      const task1 = taskManager.createTask({
        type: 'plan',
        description: 'First task'
      });

      const task2 = taskManager.createTask({
        type: 'execute',
        description: 'Depends on first',
        dependencies: [task1.id]
      });

      expect(task2.status).toBe('pending');

      // Complete first task
      taskManager.assignTask(task1.id, 'agent');
      taskManager.startTask(task1.id);
      taskManager.completeTask(task1.id, {});

      // Second task should now be queued
      const updated = taskManager.getTask(task2.id);
      expect(updated?.status).toBe('queued');
    });

    it('should block dependent tasks when dependency fails', () => {
      const task1 = taskManager.createTask({
        type: 'plan',
        description: 'First task'
      });

      const task2 = taskManager.createTask({
        type: 'execute',
        description: 'Depends on first',
        dependencies: [task1.id]
      });

      // Fail first task
      taskManager.assignTask(task1.id, 'agent');
      taskManager.startTask(task1.id);
      taskManager.failTask(task1.id, 'Failed');

      // Second task should be blocked
      const updated = taskManager.getTask(task2.id);
      expect(updated?.status).toBe('blocked');
    });
  });

  describe('subtasks', () => {
    it('should create subtasks linked to parent', () => {
      const parent = taskManager.createTask({
        type: 'plan',
        description: 'Parent task'
      });

      const subtasks = taskManager.createSubtasks(parent.id, [
        { type: 'execute', description: 'Step 1' },
        { type: 'execute', description: 'Step 2' },
        { type: 'execute', description: 'Step 3' }
      ]);

      expect(subtasks.length).toBe(3);
      expect(subtasks[0].parentTask).toBe(parent.id);

      const updatedParent = taskManager.getTask(parent.id);
      expect(updatedParent?.subtasks.length).toBe(3);
    });

    it('should chain subtask dependencies', () => {
      const parent = taskManager.createTask({
        type: 'plan',
        description: 'Parent task'
      });

      const subtasks = taskManager.createSubtasks(parent.id, [
        { type: 'execute', description: 'Step 1' },
        { type: 'execute', description: 'Step 2' }
      ]);

      // Step 2 should depend on Step 1
      expect(subtasks[1].dependencies).toContain(subtasks[0].id);
    });
  });

  describe('statistics', () => {
    it('should return correct stats', () => {
      taskManager.createTask({ type: 'plan', description: 'Task 1' });
      taskManager.createTask({ type: 'plan', description: 'Task 2' });
      taskManager.createTask({ type: 'execute', description: 'Task 3' });

      const stats = taskManager.getStats();

      expect(stats.total).toBe(3);
      expect(stats.byType.plan).toBe(2);
      expect(stats.byType.execute).toBe(1);
      expect(stats.byStatus.queued).toBe(3);
    });
  });
});
