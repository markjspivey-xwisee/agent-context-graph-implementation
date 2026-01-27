import { spawn, type ChildProcess } from 'child_process';
import { v4 as uuidv4 } from 'uuid';
import type { ContextGraph, Affordance } from '../interfaces/index.js';
import type { AgentSystemPrompt, LLMResponse } from './reasoning-client.js';

export interface CodexCLIClientConfig {
  /**
   * Path to the codex CLI executable (default: 'codex')
   */
  cliPath?: string;

  /**
   * Working directory for CLI processes
   */
  workingDirectory?: string;

  /**
   * Maximum time to wait for CLI response (ms)
   */
  timeout?: number;

  /**
   * Model to use (passed as --model)
   */
  model?: string;

  /**
   * Additional CLI flags
   */
  additionalFlags?: string[];

  /**
   * Sandbox mode (passed as --sandbox)
   */
  sandbox?: string;
}

/**
 * Codex CLI Client - Uses OpenAI Codex CLI for agent reasoning
 */
export class CodexCLIClient {
  private config: Required<CodexCLIClientConfig>;
  private activeProcesses: Map<string, ChildProcess> = new Map();

  constructor(config: CodexCLIClientConfig = {}) {
    this.config = {
      cliPath: config.cliPath ?? 'codex',
      workingDirectory: config.workingDirectory ?? process.cwd(),
      timeout: config.timeout ?? 120000,
      model: config.model ?? '',
      additionalFlags: config.additionalFlags ?? [],
      sandbox: config.sandbox ?? ''
    };
  }

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

    const prompt = `You are a ${systemPrompt.role} agent of type ${systemPrompt.agentType}.

Your capabilities:
${systemPrompt.capabilities.map(c => `- ${c}`).join('\n')}

Your constraints (you MUST follow these):
${systemPrompt.constraints.map(c => `- ${c}`).join('\n')}

CURRENT TASK: ${task}
${previousActionsText}

AVAILABLE AFFORDANCES (these are the ONLY actions you can take):
${affordanceDescriptions}

Based on the current task and available affordances, decide what to do next.

You MUST respond in this exact JSON format and ONLY this JSON (no other text):
{
  "reasoning": "Your step-by-step reasoning about what to do",
  "selectedAffordance": "the affordance id to traverse, or null ONLY if you have already taken action and the task is truly done",
  "parameters": { "param1": "value1" },
  "shouldContinue": true or false (false ONLY after you have traversed an affordance that completes the task),
  "message": "optional message about your decision"
}

CRITICAL RULES:
- You MUST select an affordance and traverse it to complete the task
- Thinking about what to do is NOT the same as doing it - you must traverse an affordance
- For Planners: you MUST traverse EmitPlan with parameters { "goal": "...", "steps": [{"action": "...", "rationale": "..."}] }
- Set shouldContinue=false ONLY after you have successfully traversed an affordance that produces output
- If this is your first action for the task, you MUST select an affordance (not null)
- If no affordance fits, set selectedAffordance to null and shouldContinue to false
- ONLY output the JSON, nothing else`;

    const response = await this.runCLI(prompt);
    return this.parseJSONResponse(response);
  }

  async generatePlan(
    task: string,
    constraints: string[] = []
  ): Promise<{ goal: string; steps: Array<{ action: string; rationale: string }> }> {
    const prompt = `You are a planning agent. Create a detailed plan for the following task.

TASK: ${task}

${constraints.length > 0 ? `CONSTRAINTS:\n${constraints.map(c => `- ${c}`).join('\n')}` : ''}

Create a step-by-step plan. Each step should be actionable and have a clear rationale.

Respond in this exact JSON format and ONLY this JSON (no other text):
{
  "goal": "The high-level goal being achieved",
  "steps": [
    { "action": "First action to take", "rationale": "Why this action is needed" },
    { "action": "Second action", "rationale": "Why this action follows" }
  ]
}`;

    const response = await this.runCLI(prompt);
    return this.parseJSONResponse(response);
  }

  async summarizeObservations(
    observations: string[],
    context: string
  ): Promise<string> {
    const prompt = `You are an observer agent. Summarize the following observations.

CONTEXT: ${context}

OBSERVATIONS:
${observations.map((o, i) => `${i + 1}. ${o}`).join('\n')}

Provide a concise summary that captures the key information and any notable patterns or anomalies.
Output ONLY the summary text, nothing else.`;

    return this.runCLI(prompt);
  }

  async makeApprovalDecision(
    proposedAction: string,
    context: string,
    policies: string[]
  ): Promise<{ decision: 'approve' | 'deny' | 'modify'; reason: string; modification?: string }> {
    const prompt = `You are an arbiter agent responsible for approving or denying proposed actions.

PROPOSED ACTION: ${proposedAction}

CONTEXT: ${context}

POLICIES TO ENFORCE:
${policies.map(p => `- ${p}`).join('\n')}

Evaluate whether this action should be approved, denied, or modified.

Respond in this exact JSON format and ONLY this JSON (no other text):
{
  "decision": "approve" or "deny" or "modify",
  "reason": "Explanation of your decision",
  "modification": "If decision is 'modify', describe the required modification"
}`;

    const response = await this.runCLI(prompt);
    return this.parseJSONResponse(response);
  }

  async runWithTools(
    task: string,
    allowedTools: string[] = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash']
  ): Promise<{ success: boolean; output: string; error?: string }> {
    const prompt = `Execute the following task using available tools:

TASK: ${task}

You have access to the following tools: ${allowedTools.join(', ')}

Execute the task and report the result. Be direct and concise.
IMPORTANT: Actually use the tools to complete the task - do not just describe what you would do.`;

    try {
      const output = await this.runCLI(prompt, {
        allowTools: true,
        timeout: this.config.timeout * 2
      });
      return { success: true, output };
    } catch (error) {
      return {
        success: false,
        output: '',
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  private runCLI(
    prompt: string,
    options: { allowTools?: boolean; timeout?: number } = {}
  ): Promise<string> {
    const processId = uuidv4();
    const timeout = options.timeout ?? this.config.timeout;

    return new Promise((resolve, reject) => {
      const args: string[] = ['exec'];

      if (this.config.model) {
        args.push('--model', this.config.model);
      }

      if (this.config.sandbox) {
        args.push('--sandbox', this.config.sandbox);
      }

      args.push(...this.config.additionalFlags);

      if (options.allowTools && !args.includes('--full-auto')) {
        args.push('--full-auto');
      }

      args.push(prompt);

      const isWindows = process.platform === 'win32';
      const child = spawn(this.config.cliPath, args, {
        cwd: this.config.workingDirectory,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: isWindows ? 'cmd.exe' : false
      });

      this.activeProcesses.set(processId, child);

      let stdout = '';
      let stderr = '';

      child.stdout?.on('data', (data) => {
        stdout += data.toString();
      });

      child.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      const timeoutId = setTimeout(() => {
        child.kill('SIGTERM');
        this.activeProcesses.delete(processId);
        reject(new Error(`CLI process timed out after ${timeout}ms`));
      }, timeout);

      child.on('close', (code) => {
        clearTimeout(timeoutId);
        this.activeProcesses.delete(processId);

        if (code === 0) {
          resolve(stdout.trim());
        } else {
          reject(new Error(`CLI exited with code ${code}: ${stderr}`));
        }
      });

      child.on('error', (err) => {
        clearTimeout(timeoutId);
        this.activeProcesses.delete(processId);
        reject(err);
      });
    });
  }

  private parseJSONResponse<T>(response: string): T {
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error(`Could not parse JSON from CLI response: ${response}`);
    }

    try {
      return JSON.parse(jsonMatch[0]) as T;
    } catch (e) {
      throw new Error(`Failed to parse CLI response as JSON: ${response}`);
    }
  }

  private describeAffordance(affordance: Affordance): string {
    let description = `ID: ${affordance.id}
Action Type: ${affordance.actionType}
Relation: ${affordance.rel}
Target: ${affordance.target.type}${affordance.target.href ? ` (${affordance.target.href})` : ''}`;

    if (affordance.params?.shaclRef) {
      const shapeName = affordance.params.shaclRef.split('#').pop() ?? affordance.params.shaclRef;
      description += `\nParameters: Validated by SHACL shape ${shapeName}`;
    }

    if (affordance.effects && affordance.effects.length > 0) {
      description += `\nEffects: ${affordance.effects.map(e => e.description).join('; ')}`;
    }

    if (affordance.requiresCredential && affordance.requiresCredential.length > 0) {
      description += `\nRequires: ${affordance.requiresCredential.map(c => c.schema).join(', ')}`;
    }

    return description;
  }

  killAll(): void {
    for (const [id, process] of this.activeProcesses) {
      process.kill('SIGTERM');
      this.activeProcesses.delete(id);
    }
  }

  getActiveProcessCount(): number {
    return this.activeProcesses.size;
  }
}
