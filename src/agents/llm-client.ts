import Anthropic from '@anthropic-ai/sdk';
import type { ContextGraph, Affordance } from '../interfaces/index.js';
import type { IReasoningClient, LLMResponse, AgentSystemPrompt } from './reasoning-client.js';

// Re-export types for backwards compatibility
export type { LLMResponse, AgentSystemPrompt } from './reasoning-client.js';

/**
 * LLM Client for agent reasoning
 * Wraps the Anthropic Claude API for agent decision-making
 */
export class LLMClient implements IReasoningClient {
  private client: Anthropic;
  private model: string;

  constructor(apiKey?: string, model: string = 'claude-opus-4-5-20251101') {
    this.client = new Anthropic({
      apiKey: apiKey ?? process.env.ANTHROPIC_API_KEY
    });
    this.model = model;
  }

  /**
   * Ask the LLM to reason about what action to take given a context
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

You MUST respond in this exact JSON format:
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
- If no affordance fits, set selectedAffordance to null and shouldContinue to false`;

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 2048,
      messages: [
        { role: 'user', content: prompt }
      ]
    });

    // Extract text content
    const textContent = response.content.find(c => c.type === 'text');
    if (!textContent || textContent.type !== 'text') {
      throw new Error('No text response from LLM');
    }

    // Parse JSON response
    const jsonMatch = textContent.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('Could not parse JSON from LLM response');
    }

    try {
      return JSON.parse(jsonMatch[0]) as LLMResponse;
    } catch (e) {
      throw new Error(`Failed to parse LLM response as JSON: ${textContent.text}`);
    }
  }

  /**
   * Generate a plan for a complex task
   */
  async generatePlan(
    task: string,
    constraints: string[] = []
  ): Promise<{ goal: string; steps: Array<{ action: string; rationale: string }> }> {
    const prompt = `You are a planning agent. Create a detailed plan for the following task.

TASK: ${task}

${constraints.length > 0 ? `CONSTRAINTS:\n${constraints.map(c => `- ${c}`).join('\n')}` : ''}

Create a step-by-step plan. Each step should be actionable and have a clear rationale.

Respond in this exact JSON format:
{
  "goal": "The high-level goal being achieved",
  "steps": [
    { "action": "First action to take", "rationale": "Why this action is needed" },
    { "action": "Second action", "rationale": "Why this action follows" }
  ]
}`;

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 2048,
      messages: [
        { role: 'user', content: prompt }
      ]
    });

    const textContent = response.content.find(c => c.type === 'text');
    if (!textContent || textContent.type !== 'text') {
      throw new Error('No text response from LLM');
    }

    const jsonMatch = textContent.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('Could not parse JSON from LLM response');
    }

    return JSON.parse(jsonMatch[0]);
  }

  /**
   * Summarize observations
   */
  async summarizeObservations(
    observations: string[],
    context: string
  ): Promise<string> {
    const prompt = `You are an observer agent. Summarize the following observations.

CONTEXT: ${context}

OBSERVATIONS:
${observations.map((o, i) => `${i + 1}. ${o}`).join('\n')}

Provide a concise summary that captures the key information and any notable patterns or anomalies.`;

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 1024,
      messages: [
        { role: 'user', content: prompt }
      ]
    });

    const textContent = response.content.find(c => c.type === 'text');
    if (!textContent || textContent.type !== 'text') {
      throw new Error('No text response from LLM');
    }

    return textContent.text;
  }

  /**
   * Make an approval decision
   */
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

Respond in this exact JSON format:
{
  "decision": "approve" or "deny" or "modify",
  "reason": "Explanation of your decision",
  "modification": "If decision is 'modify', describe the required modification"
}`;

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 1024,
      messages: [
        { role: 'user', content: prompt }
      ]
    });

    const textContent = response.content.find(c => c.type === 'text');
    if (!textContent || textContent.type !== 'text') {
      throw new Error('No text response from LLM');
    }

    const jsonMatch = textContent.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('Could not parse JSON from LLM response');
    }

    return JSON.parse(jsonMatch[0]);
  }

  /**
   * Describe an affordance in human-readable format
   */
  private describeAffordance(affordance: Affordance): string {
    let description = `ID: ${affordance.id}
Action Type: ${affordance.actionType}
Relation: ${affordance.rel}
Target: ${affordance.target.type}${affordance.target.href ? ` (${affordance.target.href})` : ''}`;

    if (affordance.params?.shaclRef) {
      // Extract the shape name from the SHACL ref URI
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
}
