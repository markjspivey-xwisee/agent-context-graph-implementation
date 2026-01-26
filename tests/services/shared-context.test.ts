import { describe, it, expect, beforeEach } from 'vitest';
import {
  SharedContextService,
  type SharedContext,
  type ContextNode,
  type ContextEdge
} from '../../src/services/shared-context.js';

describe('SharedContextService', () => {
  let service: SharedContextService;
  const aliceId = 'broker-alice';
  const bobId = 'broker-bob';

  beforeEach(() => {
    service = new SharedContextService();
  });

  describe('Context Creation', () => {
    it('should create a shared context', () => {
      const context = service.createContext(aliceId, {
        name: 'Research Project',
        description: 'AI Safety Research',
        syncStrategy: 'crdt'
      });
      expect(context.id).toBeDefined();
      expect(context.name).toBe('Research Project');
      expect(context.ownerBrokerId).toBe(aliceId);
    });

    it('should get a context by ID', () => {
      const created = service.createContext(aliceId, { name: 'Test' });
      const retrieved = service.getContext(created.id);
      expect(retrieved?.id).toBe(created.id);
    });

    it('should list contexts for a broker', () => {
      service.createContext(aliceId, { name: 'Context 1' });
      service.createContext(aliceId, { name: 'Context 2' });
      const list = service.getContextsForBroker(aliceId);
      expect(list.length).toBe(2);
    });

    it('should delete a context', () => {
      const context = service.createContext(aliceId, { name: 'To Delete' });
      const deleted = service.deleteContext(context.id, aliceId);
      expect(deleted).toBe(true);
      expect(service.getContext(context.id)).toBeUndefined();
    });

    it('should not delete context if not owner', () => {
      const context = service.createContext(aliceId, { name: 'Protected' });
      const deleted = service.deleteContext(context.id, bobId);
      expect(deleted).toBe(false);
    });
  });

  describe('Access Control', () => {
    let contextId: string;

    beforeEach(() => {
      const context = service.createContext(aliceId, { name: 'Shared' });
      contextId = context.id;
    });

    it('should grant access to another broker', () => {
      const success = service.grantAccess(contextId, aliceId, bobId, 'write');
      expect(success).toBe(true);
    });

    it('should revoke access', () => {
      service.grantAccess(contextId, aliceId, bobId, 'write');
      const success = service.revokeAccess(contextId, aliceId, bobId);
      expect(success).toBe(true);
    });

    it('should get access level', () => {
      service.grantAccess(contextId, aliceId, bobId, 'read');
      const level = service.getAccessLevel(contextId, bobId);
      expect(level).toBe('read');
    });

    it('should return owner as having full access', () => {
      const level = service.getAccessLevel(contextId, aliceId);
      expect(level).toBe('owner');
    });
  });

  describe('Joining Contexts', () => {
    let contextId: string;

    beforeEach(() => {
      const context = service.createContext(aliceId, { name: 'Joinable', isPublic: true });
      contextId = context.id;
      service.grantAccess(contextId, aliceId, bobId, 'write');
    });

    it('should join a context with access', () => {
      const replica = service.joinContext(contextId, bobId);
      expect(replica?.brokerId).toBe(bobId);
      expect(replica?.status).toBe('synced');
    });

    it('should leave a context', () => {
      service.joinContext(contextId, bobId);
      const left = service.leaveContext(contextId, bobId);
      expect(left).toBe(true);
    });

    it('should return null if no access to non-public context', () => {
      // Create a private context (isPublic defaults to false)
      const privateContext = service.createContext(aliceId, { name: 'Private' });
      const replica = service.joinContext(privateContext.id, 'unknown-broker');
      expect(replica).toBeNull();
    });
  });

  describe('Nodes', () => {
    let contextId: string;

    beforeEach(() => {
      const context = service.createContext(aliceId, { name: 'Node Test' });
      contextId = context.id;
    });

    it('should add a node', () => {
      const node = service.addNode(contextId, aliceId, 'Finding', {
        title: 'Research Finding',
        confidence: 0.9
      });
      expect(node?.id).toBeDefined();
      expect(node?.type).toBe('Finding');
    });

    it('should get nodes by type', () => {
      service.addNode(contextId, aliceId, 'Finding', { title: 'F1' });
      service.addNode(contextId, aliceId, 'Task', { title: 'T1' });
      service.addNode(contextId, aliceId, 'Finding', { title: 'F2' });

      const findings = service.getNodes(contextId, { type: 'Finding' });
      expect(findings.length).toBe(2);
    });

    it('should update a node', () => {
      const node = service.addNode(contextId, aliceId, 'Finding', { title: 'Original' });
      const updated = service.updateNode(contextId, aliceId, node!.id, { title: 'Updated' });
      expect(updated?.data.title).toBe('Updated');
    });

    it('should delete a node', () => {
      const node = service.addNode(contextId, aliceId, 'Finding', { title: 'To Delete' });
      const deleted = service.deleteNode(contextId, aliceId, node!.id);
      expect(deleted).toBe(true);
    });

    it('should increment version on update', () => {
      const node = service.addNode(contextId, aliceId, 'Finding', { title: 'V1' });
      const v1 = node!.version;
      service.updateNode(contextId, aliceId, node!.id, { title: 'V2' });
      const updated = service.getNodes(contextId).find(n => n.id === node!.id);
      expect(updated!.version).toBeGreaterThan(v1);
    });
  });

  describe('Edges', () => {
    let contextId: string;
    let node1Id: string;
    let node2Id: string;

    beforeEach(() => {
      const context = service.createContext(aliceId, { name: 'Edge Test' });
      contextId = context.id;
      const n1 = service.addNode(contextId, aliceId, 'A', {});
      const n2 = service.addNode(contextId, aliceId, 'B', {});
      node1Id = n1!.id;
      node2Id = n2!.id;
    });

    it('should add an edge', () => {
      const edge = service.addEdge(contextId, aliceId, node1Id, node2Id, 'relatesTo');
      expect(edge?.sourceId).toBe(node1Id);
      expect(edge?.targetId).toBe(node2Id);
    });

    it('should get edges by type', () => {
      service.addEdge(contextId, aliceId, node1Id, node2Id, 'relatesTo');
      service.addEdge(contextId, aliceId, node1Id, node2Id, 'supports');

      const relates = service.getEdges(contextId, { type: 'relatesTo' });
      expect(relates.length).toBe(1);
    });

    it('should get edges by source node', () => {
      const n3 = service.addNode(contextId, aliceId, 'C', {});
      service.addEdge(contextId, aliceId, node1Id, node2Id, 'a');
      service.addEdge(contextId, aliceId, node1Id, n3!.id, 'b');
      service.addEdge(contextId, aliceId, node2Id, n3!.id, 'c');

      const fromNode1 = service.getEdges(contextId, { sourceId: node1Id });
      expect(fromNode1.length).toBe(2);
    });

    it('should delete an edge', () => {
      const edge = service.addEdge(contextId, aliceId, node1Id, node2Id, 'test');
      const deleted = service.deleteEdge(contextId, aliceId, edge!.id);
      expect(deleted).toBe(true);
    });
  });

  describe('Presence', () => {
    let contextId: string;

    beforeEach(() => {
      const context = service.createContext(aliceId, { name: 'Presence Test' });
      contextId = context.id;
    });

    it('should update presence', () => {
      const updated = service.updatePresence(contextId, aliceId, {
        state: 'active',
        cursor: { nodeId: 'node-1', field: 'title', offset: 5 }
      });
      expect(updated).toBe(true);
    });

    it('should get active participants', () => {
      service.updatePresence(contextId, aliceId, { state: 'active' });
      const participants = service.getActiveParticipants(contextId);
      expect(participants.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Export', () => {
    it('should export context as JSON', () => {
      const context = service.createContext(aliceId, { name: 'Export Test' });
      service.addNode(context.id, aliceId, 'Node', { data: 'test' });

      const exported = service.exportContextAsJSON(context.id) as any;
      expect(exported).not.toBeNull();
      expect(exported.name).toBe('Export Test');
      expect(exported.graph.nodes.length).toBe(1);
    });

    it('should return null for non-existent context', () => {
      const exported = service.exportContextAsJSON('nonexistent');
      expect(exported).toBeNull();
    });
  });

  describe('Statistics', () => {
    it('should return stats', () => {
      service.createContext(aliceId, { name: 'Ctx 1' });
      service.createContext(aliceId, { name: 'Ctx 2' });

      const stats = service.getStats() as any;
      expect(stats.totalContexts).toBe(2);
    });

    it('should count nodes and edges', () => {
      const context = service.createContext(aliceId, { name: 'Test' });
      const n1 = service.addNode(context.id, aliceId, 'A', {});
      const n2 = service.addNode(context.id, aliceId, 'B', {});
      service.addEdge(context.id, aliceId, n1!.id, n2!.id, 'test');

      const stats = service.getStats() as any;
      expect(stats.totalNodes).toBe(2);
      expect(stats.totalEdges).toBe(1);
    });
  });
});
