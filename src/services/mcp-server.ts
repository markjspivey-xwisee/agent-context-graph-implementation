/**
 * Model Context Protocol (MCP) Server
 *
 * Exposes ACG capabilities as MCP tools for Claude and other AI assistants.
 *
 * MCP Spec: https://modelcontextprotocol.io/
 */

import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';

// =============================================================================
// MCP Types
// =============================================================================

export interface MCPToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, {
      type: string;
      description: string;
      enum?: string[];
      items?: unknown;
      required?: boolean;
    }>;
    required?: string[];
  };
}

export interface MCPToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface MCPToolResult {
  content: Array<{
    type: 'text' | 'image' | 'resource';
    text?: string;
    data?: string;
    mimeType?: string;
  }>;
  isError?: boolean;
}

export interface MCPResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface MCPPrompt {
  name: string;
  description?: string;
  arguments?: Array<{
    name: string;
    description?: string;
    required?: boolean;
  }>;
}

export interface MCPServerCapabilities {
  tools?: { listChanged?: boolean };
  resources?: { subscribe?: boolean; listChanged?: boolean };
  prompts?: { listChanged?: boolean };
  logging?: Record<string, unknown>;
}

export interface MCPServerInfo {
  name: string;
  version: string;
  protocolVersion: string;
  capabilities: MCPServerCapabilities;
}

// =============================================================================
// MCP Server Implementation
// =============================================================================

export class MCPServer extends EventEmitter {
  private tools: Map<string, {
    definition: MCPToolDefinition;
    handler: (args: Record<string, unknown>) => Promise<MCPToolResult>;
  }> = new Map();

  private resources: Map<string, MCPResource> = new Map();
  private prompts: Map<string, MCPPrompt> = new Map();

  private serverInfo: MCPServerInfo = {
    name: 'agent-context-graph',
    version: '1.0.0',
    protocolVersion: '2024-11-05',
    capabilities: {
      tools: { listChanged: true },
      resources: { subscribe: true, listChanged: true },
      prompts: { listChanged: true },
      logging: {}
    }
  };

  constructor() {
    super();
    this.registerBuiltInTools();
    this.registerBuiltInResources();
    this.registerBuiltInPrompts();
  }

  /**
   * Get server information
   */
  getServerInfo(): MCPServerInfo {
    return this.serverInfo;
  }

  /**
   * List available tools
   */
  listTools(): MCPToolDefinition[] {
    return Array.from(this.tools.values()).map(t => t.definition);
  }

  /**
   * Call a tool
   */
  async callTool(call: MCPToolCall): Promise<MCPToolResult> {
    const tool = this.tools.get(call.name);

    if (!tool) {
      return {
        content: [{ type: 'text', text: `Tool not found: ${call.name}` }],
        isError: true
      };
    }

    try {
      return await tool.handler(call.arguments);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return {
        content: [{ type: 'text', text: `Error executing tool: ${message}` }],
        isError: true
      };
    }
  }

  /**
   * List available resources
   */
  listResources(): MCPResource[] {
    return Array.from(this.resources.values());
  }

  /**
   * Read a resource
   */
  async readResource(uri: string): Promise<{
    contents: Array<{ uri: string; mimeType?: string; text?: string }>;
  }> {
    // Resource reading would be implemented based on URI scheme
    if (uri.startsWith('acg://context/')) {
      const contextId = uri.replace('acg://context/', '');
      return {
        contents: [{
          uri,
          mimeType: 'application/json',
          text: JSON.stringify({ contextId, note: 'Context data would be here' })
        }]
      };
    }

    return { contents: [] };
  }

  /**
   * List available prompts
   */
  listPrompts(): MCPPrompt[] {
    return Array.from(this.prompts.values());
  }

  /**
   * Get a prompt
   */
  async getPrompt(name: string, args?: Record<string, string>): Promise<{
    description?: string;
    messages: Array<{ role: string; content: { type: string; text: string } }>;
  }> {
    const prompt = this.prompts.get(name);

    if (!prompt) {
      return {
        messages: [{ role: 'user', content: { type: 'text', text: `Prompt not found: ${name}` } }]
      };
    }

    // Generate prompt based on name
    const promptText = this.generatePromptText(name, args || {});

    return {
      description: prompt.description,
      messages: [{ role: 'user', content: { type: 'text', text: promptText } }]
    };
  }

  /**
   * Register a custom tool
   */
  registerTool(
    definition: MCPToolDefinition,
    handler: (args: Record<string, unknown>) => Promise<MCPToolResult>
  ): void {
    this.tools.set(definition.name, { definition, handler });
    this.emit('tools/list_changed');
  }

  // ===========================================================================
  // Built-in Tools
  // ===========================================================================

  private registerBuiltInTools(): void {
    // Tool: Get Context Graph
    this.registerTool({
      name: 'acg_get_context',
      description: 'Generate a Context Graph for an agent based on their DID, type, goal, and capabilities',
      inputSchema: {
        type: 'object',
        properties: {
          agentDID: {
            type: 'string',
            description: 'The DID (Decentralized Identifier) of the agent'
          },
          agentType: {
            type: 'string',
            description: 'The type of agent (planner, executor, observer, arbiter, archivist)',
            enum: ['planner', 'executor', 'observer', 'arbiter', 'archivist']
          },
          goal: {
            type: 'string',
            description: 'The goal the agent is trying to achieve'
          },
          capabilities: {
            type: 'array',
            description: 'List of capabilities the agent has',
            items: { type: 'string' }
          }
        },
        required: ['agentDID', 'agentType', 'goal']
      }
    }, async (args) => {
      // Would call the actual context broker
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            contextId: `ctx-${uuidv4().slice(0, 8)}`,
            agentDID: args.agentDID,
            agentType: args.agentType,
            goal: args.goal,
            affordances: [
              { id: 'aff-1', type: 'SearchAction', description: 'Search for information' },
              { id: 'aff-2', type: 'CreatePlanAction', description: 'Create a plan' }
            ]
          }, null, 2)
        }]
      };
    });

    // Tool: Query Memory
    this.registerTool({
      name: 'acg_query_memory',
      description: 'Query the personal broker memory store for facts, preferences, and past interactions',
      inputSchema: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            description: 'Type of memory to query',
            enum: ['semantic', 'episodic', 'procedural', 'preference']
          },
          query: {
            type: 'string',
            description: 'Search query or topic'
          },
          minImportance: {
            type: 'number',
            description: 'Minimum importance score (0-1)'
          },
          limit: {
            type: 'number',
            description: 'Maximum number of results'
          }
        }
      }
    }, async (args) => {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            memories: [
              { id: 'mem-1', type: args.type, content: 'Example memory entry', importance: 0.8 }
            ],
            query: args.query
          }, null, 2)
        }]
      };
    });

    // Tool: Store Memory
    this.registerTool({
      name: 'acg_store_memory',
      description: 'Store a new memory entry in the personal broker',
      inputSchema: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            description: 'Type of memory',
            enum: ['semantic', 'episodic', 'procedural', 'preference']
          },
          content: {
            type: 'string',
            description: 'The content to remember'
          },
          importance: {
            type: 'number',
            description: 'Importance score (0-1)'
          },
          tags: {
            type: 'array',
            description: 'Tags for categorization',
            items: { type: 'string' }
          }
        },
        required: ['type', 'content']
      }
    }, async (args) => {
      const id = `mem-${uuidv4().slice(0, 8)}`;
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            id,
            type: args.type,
            content: args.content
          }, null, 2)
        }]
      };
    });

    // Tool: SPARQL Query
    this.registerTool({
      name: 'acg_sparql_query',
      description: 'Execute a SPARQL query against the RDF trace store',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'SPARQL query string'
          }
        },
        required: ['query']
      }
    }, async (args) => {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            query: args.query,
            results: { bindings: [] },
            note: 'SPARQL endpoint would return actual results'
          }, null, 2)
        }]
      };
    });

    // Tool: Create Shared Context
    this.registerTool({
      name: 'acg_create_context',
      description: 'Create a new shared context for collaboration',
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Name of the shared context'
          },
          description: {
            type: 'string',
            description: 'Description of the context'
          },
          isPublic: {
            type: 'boolean',
            description: 'Whether the context is publicly discoverable'
          }
        },
        required: ['name']
      }
    }, async (args) => {
      const id = `ctx-${uuidv4().slice(0, 8)}`;
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            contextId: id,
            name: args.name,
            description: args.description
          }, null, 2)
        }]
      };
    });

    // Tool: Send Message
    this.registerTool({
      name: 'acg_send_message',
      description: 'Send a message in a conversation',
      inputSchema: {
        type: 'object',
        properties: {
          conversationId: {
            type: 'string',
            description: 'ID of the conversation'
          },
          content: {
            type: 'string',
            description: 'Message content'
          },
          role: {
            type: 'string',
            description: 'Role of the sender',
            enum: ['user', 'assistant', 'system']
          }
        },
        required: ['conversationId', 'content']
      }
    }, async (args) => {
      const id = `msg-${uuidv4().slice(0, 8)}`;
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            messageId: id,
            conversationId: args.conversationId,
            content: args.content
          }, null, 2)
        }]
      };
    });
  }

  // ===========================================================================
  // Built-in Resources
  // ===========================================================================

  private registerBuiltInResources(): void {
    this.resources.set('acg://ontology', {
      uri: 'acg://ontology',
      name: 'ACG Ontology',
      description: 'The Agent Context Graph ontology in Turtle format',
      mimeType: 'text/turtle'
    });

    this.resources.set('acg://shacl', {
      uri: 'acg://shacl',
      name: 'SHACL Shapes',
      description: 'SHACL validation shapes for context graphs',
      mimeType: 'text/turtle'
    });

    this.resources.set('acg://aat', {
      uri: 'acg://aat',
      name: 'AAT Definitions',
      description: 'Abstract Agent Type definitions',
      mimeType: 'application/json'
    });
  }

  // ===========================================================================
  // Built-in Prompts
  // ===========================================================================

  private registerBuiltInPrompts(): void {
    this.prompts.set('plan_task', {
      name: 'plan_task',
      description: 'Create a plan to accomplish a goal using available affordances',
      arguments: [
        { name: 'goal', description: 'The goal to plan for', required: true },
        { name: 'constraints', description: 'Any constraints to consider' }
      ]
    });

    this.prompts.set('analyze_traces', {
      name: 'analyze_traces',
      description: 'Analyze PROV traces to understand what happened',
      arguments: [
        { name: 'timeRange', description: 'Time range to analyze' },
        { name: 'agentDID', description: 'Filter by agent DID' }
      ]
    });

    this.prompts.set('federation_status', {
      name: 'federation_status',
      description: 'Get status of federation connections and shared contexts'
    });
  }

  private generatePromptText(name: string, args: Record<string, string>): string {
    switch (name) {
      case 'plan_task':
        return `Please create a detailed plan to accomplish the following goal: ${args.goal || '[goal not specified]'}

${args.constraints ? `Constraints to consider: ${args.constraints}` : ''}

The plan should:
1. Break down the goal into actionable steps
2. Identify which agent types should handle each step
3. Consider dependencies between steps
4. Include verification criteria for each step`;

      case 'analyze_traces':
        return `Please analyze the PROV traces for the following criteria:
${args.timeRange ? `Time range: ${args.timeRange}` : ''}
${args.agentDID ? `Agent DID: ${args.agentDID}` : ''}

Provide:
1. Summary of actions taken
2. Any anomalies or failures
3. Causal chain analysis
4. Recommendations for improvement`;

      case 'federation_status':
        return `Please provide a comprehensive status report on:
1. Active federation connections
2. Shared contexts and participants
3. Pending connection requests
4. Recent federation activity`;

      default:
        return `Prompt: ${name}\nArguments: ${JSON.stringify(args)}`;
    }
  }
}

// Export singleton instance
export const mcpServer = new MCPServer();
