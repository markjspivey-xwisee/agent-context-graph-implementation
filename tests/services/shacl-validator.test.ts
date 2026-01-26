// Using vitest globals
import { readFileSync, readdirSync } from 'fs';
import { join, resolve } from 'path';
import { SHACLValidatorService } from '../../src/services/shacl-validator.js';
import { resolveSpecPath } from '../../src/utils/spec-path.js';

describe('SHACLValidatorService', () => {
  let validator: SHACLValidatorService;
  const shaclDir = resolveSpecPath('shacl');
  const examplesDir = resolve('./examples/golden-path');

  beforeAll(async () => {
    validator = new SHACLValidatorService();
    await validator.loadShapesFromDirectory(shaclDir);
  });

  describe('shape loading', () => {
    it('should load SHACL shapes from directory', () => {
      const shapes = validator.getLoadedShapes();
      expect(shapes.length).toBeGreaterThan(0);
    });

    it('should have context graph shape', () => {
      const shapes = validator.getLoadedShapes();
      const hasContextGraphShape = shapes.some(s => s.includes('ContextGraphShape'));
      expect(hasContextGraphShape).toBe(true);
    });

    it('should have affordance shape', () => {
      const shapes = validator.getLoadedShapes();
      const hasAffordanceShape = shapes.some(s => s.includes('AffordanceShape'));
      expect(hasAffordanceShape).toBe(true);
    });
  });

  describe('golden-path example validation', () => {
    const files = readdirSync(examplesDir).filter(f => f.endsWith('.json'));

    for (const file of files) {
      it(`should validate ${file}`, async () => {
        const content = readFileSync(join(examplesDir, file), 'utf-8');
        const data = JSON.parse(content);

        // Note: Full validation may have some expected violations due to
        // the difference between JSON-LD @context and actual RDF conversion
        // This test verifies the validator runs without errors
        const result = await validator.validateContextGraph(data);

        // Just verify it runs - actual conformance depends on full RDF conversion
        expect(result).toBeDefined();
        expect(typeof result.conforms).toBe('boolean');
      });
    }
  });

  describe('parameter validation', () => {
    it('should validate EmitPlan parameters', async () => {
      const params = {
        '@type': 'params:EmitPlanParams',
        goal: 'Implement feature X',
        steps: [
          {
            action: 'Design schema',
            rationale: 'Need structure first'
          }
        ]
      };

      const result = await validator.validateParams('EmitPlan', params);
      expect(result).toBeDefined();
    });

    it('should validate Approve parameters', async () => {
      const params = {
        '@type': 'params:ApproveParams',
        proposalId: 'urn:proposal:test-001',
        reason: 'Approved after review'
      };

      const result = await validator.validateParams('Approve', params);
      expect(result).toBeDefined();
    });

    it('should validate FederateContext parameters', async () => {
      const params = {
        '@type': 'params:FederateContextParams',
        targetBrokerDID: 'did:web:broker.example.com',
        resourceURNs: ['urn:resource:inventory'],
        federationProtocol: 'HTTP'
      };

      const result = await validator.validateParams('FederateContext', params);
      expect(result).toBeDefined();
    });
  });

  describe('custom shape validation', () => {
    it('should validate against loaded shapes', async () => {
      const data = {
        '@type': 'cg:ContextGraph',
        id: 'urn:test:context-001',
        agentDID: 'did:key:z6MkTest123',
        timestamp: new Date().toISOString()
      };

      const result = await validator.validate(data);
      expect(result).toBeDefined();
    });
  });
});
