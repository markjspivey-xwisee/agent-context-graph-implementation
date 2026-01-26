import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import SHACLValidator from 'rdf-validate-shacl';
import { Parser, Store, DataFactory } from 'n3';

const { namedNode, literal, quad } = DataFactory;

/**
 * SHACL Validation Result
 */
export interface SHACLValidationResult {
  conforms: boolean;
  results: SHACLViolation[];
}

export interface SHACLViolation {
  focusNode: string;
  resultPath?: string;
  resultMessage: string;
  resultSeverity: 'Violation' | 'Warning' | 'Info';
  sourceShape: string;
  value?: string;
}

/**
 * SHACL Validator Service
 * Validates RDF data against SHACL shapes
 */
export class SHACLValidatorService {
  private shapesStore: Store;
  private shapesLoaded: boolean = false;
  private shapesByAction: Map<string, Store> = new Map();

  // Base namespaces
  private readonly SH = 'http://www.w3.org/ns/shacl#';
  private readonly PARAMS = 'https://agentcontextgraph.dev/shacl/params#';
  private readonly ACG = 'https://agentcontextgraph.dev/ontology#';
  private readonly AAT = 'https://agentcontextgraph.dev/aat#';
  private readonly CG = 'https://agentcontextgraph.dev/context#';

  constructor() {
    this.shapesStore = new Store();
  }

  /**
   * Load SHACL shapes from a directory
   * Note: Files containing sh:sparql constraints are skipped as rdf-validate-shacl
   * doesn't support SPARQL-based constraints
   */
  async loadShapesFromDirectory(dir: string): Promise<void> {
    const files = readdirSync(dir).filter(f => f.endsWith('.ttl'));
    const parser = new Parser();
    let loadedCount = 0;

    for (const file of files) {
      const content = readFileSync(join(dir, file), 'utf-8');

      // Skip files containing SPARQL constraints (not supported by rdf-validate-shacl)
      if (content.includes('sh:sparql')) {
        console.log(`Skipping ${file} (contains unsupported SPARQL constraints)`);
        continue;
      }

      const quads = parser.parse(content);
      this.shapesStore.addQuads(quads);
      loadedCount++;
    }

    this.shapesLoaded = true;
    console.log(`Loaded SHACL shapes from ${loadedCount} files`);
  }

  /**
   * Load shapes from a Turtle string
   */
  async loadShapesFromString(turtle: string): Promise<void> {
    const parser = new Parser();
    const quads = parser.parse(turtle);
    this.shapesStore.addQuads(quads);
    this.shapesLoaded = true;
  }

  /**
   * Validate JSON-LD data against loaded SHACL shapes
   */
  async validate(data: Record<string, unknown>): Promise<SHACLValidationResult> {
    if (!this.shapesLoaded) {
      throw new Error('SHACL shapes not loaded. Call loadShapesFromDirectory first.');
    }

    // Convert JSON data to RDF quads
    const dataStore = this.jsonToRdf(data);

    // Create validator and validate
    const validator = new SHACLValidator(this.shapesStore);
    const report = await validator.validate(dataStore);

    return this.parseValidationReport(report);
  }

  /**
   * Validate affordance parameters against the action's SHACL shape
   */
  async validateParams(
    actionType: string,
    params: Record<string, unknown>
  ): Promise<SHACLValidationResult> {
    if (!this.shapesLoaded) {
      throw new Error('SHACL shapes not loaded');
    }

    // Convert params to RDF with appropriate type
    const paramsWithType = {
      '@type': `params:${actionType}Params`,
      ...params
    };

    const dataStore = this.jsonToRdf(paramsWithType);

    // Validate against the specific shape
    const validator = new SHACLValidator(this.shapesStore);
    const report = await validator.validate(dataStore);

    return this.parseValidationReport(report);
  }

  /**
   * Validate a Context Graph against context shapes
   */
  async validateContextGraph(context: Record<string, unknown>): Promise<SHACLValidationResult> {
    if (!this.shapesLoaded) {
      throw new Error('SHACL shapes not loaded');
    }

    const dataStore = this.jsonToRdf(context);
    const validator = new SHACLValidator(this.shapesStore);
    const report = await validator.validate(dataStore);

    return this.parseValidationReport(report);
  }

  /**
   * Get all loaded shape IRIs
   */
  getLoadedShapes(): string[] {
    const shapes: string[] = [];
    const shapeClass = namedNode(this.SH + 'NodeShape');

    for (const quad of this.shapesStore.match(null, namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type'), shapeClass)) {
      if (quad.subject.termType === 'NamedNode') {
        shapes.push(quad.subject.value);
      }
    }

    return shapes;
  }

  /**
   * Convert JSON object to RDF Store
   * Handles nested objects and arrays
   */
  private jsonToRdf(json: Record<string, unknown>, subjectUri?: string): Store {
    const store = new Store();
    const subject = subjectUri
      ? namedNode(subjectUri)
      : namedNode(`urn:uuid:${this.generateUUID()}`);

    this.addJsonToStore(store, subject, json);
    return store;
  }

  /**
   * Recursively add JSON properties to RDF store
   */
  private addJsonToStore(
    store: Store,
    subject: ReturnType<typeof namedNode>,
    json: Record<string, unknown>
  ): void {
    for (const [key, value] of Object.entries(json)) {
      if (value === null || value === undefined) continue;

      // Handle @type specially
      if (key === '@type') {
        const typeUri = this.expandPrefixedName(value as string);
        store.addQuad(quad(
          subject,
          namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type'),
          namedNode(typeUri)
        ));
        continue;
      }

      // Handle @id specially
      if (key === '@id') continue;

      // Skip @context
      if (key === '@context') continue;

      const predicate = namedNode(this.expandPrefixedName(key));

      if (Array.isArray(value)) {
        // Handle arrays
        for (const item of value) {
          this.addValueToStore(store, subject, predicate, item);
        }
      } else {
        this.addValueToStore(store, subject, predicate, value);
      }
    }
  }

  /**
   * Add a single value to the store
   */
  private addValueToStore(
    store: Store,
    subject: ReturnType<typeof namedNode>,
    predicate: ReturnType<typeof namedNode>,
    value: unknown
  ): void {
    if (typeof value === 'object' && value !== null) {
      // Nested object - create blank node or use @id
      const obj = value as Record<string, unknown>;
      const nestedSubject = obj['@id']
        ? namedNode(obj['@id'] as string)
        : namedNode(`urn:uuid:${this.generateUUID()}`);

      store.addQuad(quad(subject, predicate, nestedSubject));
      this.addJsonToStore(store, nestedSubject, obj);
    } else if (typeof value === 'string') {
      store.addQuad(quad(subject, predicate, literal(value)));
    } else if (typeof value === 'number') {
      const datatype = Number.isInteger(value)
        ? namedNode('http://www.w3.org/2001/XMLSchema#integer')
        : namedNode('http://www.w3.org/2001/XMLSchema#decimal');
      store.addQuad(quad(subject, predicate, literal(String(value), datatype)));
    } else if (typeof value === 'boolean') {
      store.addQuad(quad(
        subject,
        predicate,
        literal(String(value), namedNode('http://www.w3.org/2001/XMLSchema#boolean'))
      ));
    }
  }

  /**
   * Expand prefixed names to full URIs
   */
  private expandPrefixedName(name: string): string {
    const prefixes: Record<string, string> = {
      'sh:': this.SH,
      'params:': this.PARAMS,
      'acg:': this.ACG,
      'aat:': this.AAT,
      'cg:': this.CG,
      'xsd:': 'http://www.w3.org/2001/XMLSchema#',
      'rdf:': 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
      'rdfs:': 'http://www.w3.org/2000/01/rdf-schema#',
    };

    for (const [prefix, uri] of Object.entries(prefixes)) {
      if (name.startsWith(prefix)) {
        return uri + name.slice(prefix.length);
      }
    }

    // If no prefix matched and it looks like a local name, use params namespace
    if (!name.includes(':') && !name.startsWith('http')) {
      return this.PARAMS + name;
    }

    return name;
  }

  /**
   * Parse SHACL validation report into structured result
   */
  private parseValidationReport(report: { conforms: boolean; results: Iterable<unknown> }): SHACLValidationResult {
    const violations: SHACLViolation[] = [];

    for (const result of report.results) {
      const r = result as {
        focusNode?: { value?: string };
        path?: { value?: string };
        message?: Array<{ value?: string }> | { value?: string };
        severity?: { value?: string };
        sourceShape?: { value?: string };
        value?: { value?: string };
      };

      violations.push({
        focusNode: r.focusNode?.value ?? 'unknown',
        resultPath: r.path?.value,
        resultMessage: Array.isArray(r.message)
          ? r.message[0]?.value ?? 'Validation failed'
          : r.message?.value ?? 'Validation failed',
        resultSeverity: this.parseSeverity(r.severity?.value),
        sourceShape: r.sourceShape?.value ?? 'unknown',
        value: r.value?.value
      });
    }

    return {
      conforms: report.conforms,
      results: violations
    };
  }

  /**
   * Parse severity URI to enum
   */
  private parseSeverity(severityUri?: string): 'Violation' | 'Warning' | 'Info' {
    if (!severityUri) return 'Violation';
    if (severityUri.includes('Warning')) return 'Warning';
    if (severityUri.includes('Info')) return 'Info';
    return 'Violation';
  }

  /**
   * Generate a simple UUID
   */
  private generateUUID(): string {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = Math.random() * 16 | 0;
      const v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }
}

/**
 * Create a singleton instance
 */
let validatorInstance: SHACLValidatorService | null = null;

export function getSHACLValidator(): SHACLValidatorService {
  if (!validatorInstance) {
    validatorInstance = new SHACLValidatorService();
  }
  return validatorInstance;
}
