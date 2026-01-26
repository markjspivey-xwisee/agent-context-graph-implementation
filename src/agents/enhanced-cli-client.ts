import { spawn } from 'child_process';
import { v4 as uuidv4 } from 'uuid';
import type { ContextGraph, Affordance } from '../interfaces/index.js';
import type { IReasoningClient, LLMResponse, AgentSystemPrompt } from './reasoning-client.js';
import { ToolExecutor, type ToolResult } from './tool-executor.js';

export interface EnhancedCLIClientConfig {
  workingDirectory?: string;
  timeout?: number;
  model?: string;
  enableTools?: boolean;
  sandboxMode?: boolean;
}

interface ToolCall {
  tool: string;
  params: Record<string, unknown>;
}

/**
 * Enhanced CLI Client - Uses Claude Code CLI with real tool execution
 *
 * This client can:
 * 1. Use Claude for reasoning about what to do
 * 2. Actually execute tools (file operations, bash commands)
 * 3. Report results back for verification
 */
export class EnhancedCLIClient implements IReasoningClient {
  private config: Required<EnhancedCLIClientConfig>;
  private toolExecutor: ToolExecutor;

  constructor(config: EnhancedCLIClientConfig = {}) {
    this.config = {
      workingDirectory: config.workingDirectory ?? process.cwd(),
      timeout: config.timeout ?? 120000,
      model: config.model ?? 'opus',
      enableTools: config.enableTools ?? true,
      sandboxMode: config.sandboxMode ?? false
    };

    this.toolExecutor = new ToolExecutor({
      workingDirectory: this.config.workingDirectory,
      timeout: this.config.timeout
    });
  }

  /**
   * Reason about context and optionally execute tools
   */
  async reasonAboutContext(
    systemPrompt: AgentSystemPrompt,
    context: ContextGraph,
    task: string,
    previousActions: string[] = []
  ): Promise<LLMResponse> {
    const affordanceDescriptions = context.affordances
      .filter(a => a.enabled)
      .map(a => this.describeAffordance(a))
      .join('\n\n');

    const previousActionsText = previousActions.length > 0
      ? `\n\nPrevious actions taken:\n${previousActions.map((a, i) => `${i + 1}. ${a}`).join('\n')}`
      : '';

    // Include available tools if this is an executor
    const toolsSection = (systemPrompt.agentType.includes('Executor') && this.config.enableTools)
      ? `\n\nAVAILABLE TOOLS (you can request these be executed):
- writeFile: Write content to a file { path: string, content: string }
- readFile: Read a file { path: string }
- bash: Execute a shell command { command: string }
- npm: Run npm command { command: string }
- git: Run git command { command: string }
- createCodeFile: Create a code file { path: string, code: string, language: 'typescript' | 'javascript' }
- compileTypeScript: Run TypeScript compiler { }
- runTests: Run tests { pattern?: string }

To use a tool, include in your response:
TOOL_CALL: { "tool": "toolName", "params": { ... } }
`
      : '';

    const prompt = `You are a ${systemPrompt.role} agent of type ${systemPrompt.agentType}.

Your capabilities:
${systemPrompt.capabilities.map(c => `- ${c}`).join('\n')}

Your constraints (you MUST follow these):
${systemPrompt.constraints.map(c => `- ${c}`).join('\n')}

CURRENT TASK: ${task}
${previousActionsText}
${toolsSection}

AVAILABLE AFFORDANCES (these are the ONLY actions you can take):
${affordanceDescriptions}

Based on the current task and available affordances, decide what to do next.

You MUST respond in this exact JSON format:
{
  "reasoning": "Your step-by-step reasoning about what to do",
  "selectedAffordance": "the affordance id to traverse, or null if task is complete",
  "parameters": { "param1": "value1" },
  "shouldContinue": true or false,
  "message": "optional message about your decision",
  "toolCalls": [{ "tool": "toolName", "params": { ... } }]  // optional, only for executors
}`;

    // Use Claude CLI to get response
    const response = await this.callClaude(prompt);
    const parsed = this.parseResponse(response);

    // Execute any requested tools
    if (parsed.toolCalls && parsed.toolCalls.length > 0 && this.config.enableTools) {
      const toolResults = await this.executeTools(parsed.toolCalls);
      parsed.message = (parsed.message ?? '') + '\n\nTool execution results:\n' +
        toolResults.map((r, i) =>
          `${parsed.toolCalls![i].tool}: ${r.success ? 'SUCCESS' : 'FAILED'} - ${r.output || r.error}`
        ).join('\n');
    }

    return parsed;
  }

  /**
   * Generate a plan
   */
  async generatePlan(
    task: string,
    constraints: string[] = []
  ): Promise<{ goal: string; steps: Array<{ action: string; rationale: string }> }> {
    const prompt = `You are a planning agent. Create a detailed plan for the following task.

TASK: ${task}

${constraints.length > 0 ? `CONSTRAINTS:\n${constraints.map(c => `- ${c}`).join('\n')}` : ''}

Create a step-by-step plan where each step is specific and actionable.
Consider what files need to be created, what commands need to be run, etc.

Respond in this exact JSON format:
{
  "goal": "The high-level goal being achieved",
  "steps": [
    { "action": "Specific action to take", "rationale": "Why this action is needed" }
  ]
}`;

    const response = await this.callClaude(prompt);
    return JSON.parse(this.extractJSON(response));
  }

  /**
   * Summarize observations
   */
  async summarizeObservations(
    observations: string[],
    context: string
  ): Promise<string> {
    const prompt = `Summarize the following observations:

CONTEXT: ${context}

OBSERVATIONS:
${observations.map((o, i) => `${i + 1}. ${o}`).join('\n')}

Provide a concise summary.`;

    return this.callClaude(prompt);
  }

  /**
   * Make an approval decision
   */
  async makeApprovalDecision(
    proposedAction: string,
    context: string,
    policies: string[]
  ): Promise<{ decision: 'approve' | 'deny' | 'modify'; reason: string; modification?: string }> {
    const prompt = `You are an arbiter agent. Evaluate this proposed action:

PROPOSED ACTION: ${proposedAction}

CONTEXT: ${context}

POLICIES:
${policies.map(p => `- ${p}`).join('\n')}

Respond in JSON:
{
  "decision": "approve" or "deny" or "modify",
  "reason": "Your reasoning",
  "modification": "If modifying, what changes are needed"
}`;

    const response = await this.callClaude(prompt);
    return JSON.parse(this.extractJSON(response));
  }

  /**
   * Execute tools requested by the agent
   */
  private async executeTools(toolCalls: ToolCall[]): Promise<ToolResult[]> {
    const results: ToolResult[] = [];

    for (const call of toolCalls) {
      let result: ToolResult;

      switch (call.tool) {
        case 'writeFile':
          result = await this.toolExecutor.writeFile(call.params as any);
          break;
        case 'readFile':
          result = await this.toolExecutor.readFile(call.params as any);
          break;
        case 'bash':
          result = await this.toolExecutor.bash(call.params as any);
          break;
        case 'npm':
          result = await this.toolExecutor.npm(call.params as any);
          break;
        case 'git':
          result = await this.toolExecutor.git(call.params as any);
          break;
        case 'createCodeFile':
          result = await this.toolExecutor.createCodeFile(call.params as any);
          break;
        case 'compileTypeScript':
          result = await this.toolExecutor.compileTypeScript(call.params as any);
          break;
        case 'runTests':
          result = await this.toolExecutor.runTests(call.params as any);
          break;
        case 'listFiles':
          result = await this.toolExecutor.listFiles(call.params as any);
          break;
        default:
          result = {
            success: false,
            output: '',
            error: `Unknown tool: ${call.tool}`,
            duration: 0
          };
      }

      results.push(result);
    }

    return results;
  }

  /**
   * Call Claude CLI
   */
  private callClaude(prompt: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const args = ['--print', '--model', this.config.model];

      // Use appropriate shell for Windows vs Unix
      const isWindows = process.platform === 'win32';
      const child = spawn('claude', args, {
        cwd: this.config.workingDirectory,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: isWindows ? 'cmd.exe' : false
      });

      let stdout = '';
      let stderr = '';

      child.stdout?.on('data', (data) => {
        stdout += data.toString();
      });

      child.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      child.stdin?.write(prompt);
      child.stdin?.end();

      const timeoutId = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error('Claude CLI timed out'));
      }, this.config.timeout);

      child.on('close', (code) => {
        clearTimeout(timeoutId);
        if (code === 0) {
          resolve(stdout.trim());
        } else {
          reject(new Error(`Claude CLI failed: ${stderr}`));
        }
      });

      child.on('error', (err) => {
        clearTimeout(timeoutId);
        reject(err);
      });
    });
  }

  /**
   * Parse LLM response
   */
  private parseResponse(response: string): LLMResponse & { toolCalls?: ToolCall[] } {
    const json = this.extractJSON(response);
    try {
      return JSON.parse(json);
    } catch {
      return {
        reasoning: response,
        selectedAffordance: null,
        parameters: {},
        shouldContinue: false,
        message: 'Could not parse response'
      };
    }
  }

  /**
   * Extract JSON from response
   */
  private extractJSON(response: string): string {
    const match = response.match(/\{[\s\S]*\}/);
    return match ? match[0] : '{}';
  }

  /**
   * Describe an affordance
   */
  private describeAffordance(affordance: Affordance): string {
    let description = `ID: ${affordance.id}
Action Type: ${affordance.actionType}
Target: ${affordance.target.type}${affordance.target.href ? ` (${affordance.target.href})` : ''}`;

    if (affordance.params?.shaclRef) {
      // Extract the shape name from the SHACL ref URI
      const shapeName = affordance.params.shaclRef.split('#').pop() ?? affordance.params.shaclRef;
      description += `\nParameters: Validated by SHACL shape ${shapeName}`;
    }

    if (affordance.effects && affordance.effects.length > 0) {
      description += `\nEffects: ${affordance.effects.map(e => e.description).join('; ')}`;
    }

    return description;
  }

  /**
   * Get tool execution log
   */
  getToolExecutionLog() {
    return this.toolExecutor.getExecutionLog();
  }
}
