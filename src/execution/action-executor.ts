import { v4 as uuidv4 } from 'uuid';
import type { Affordance, Target } from '../interfaces/index.js';

export interface ExecutionResult {
  success: boolean;
  statusCode?: number;
  data?: unknown;
  error?: string;
  duration: number;
  timestamp: string;
}

export interface ExecutionContext {
  agentDID: string;
  contextId: string;
  traceId: string;
}

/**
 * ActionExecutor - Executes affordance targets
 *
 * Handles:
 * - HTTP targets (real HTTP calls)
 * - Internal targets (in-process execution)
 * - Event emission
 * - DIDComm (stubbed for now)
 * - OID4VCI (stubbed for now)
 */
export class ActionExecutor {
  private httpTimeout: number;
  private eventHandlers: Map<string, (data: unknown) => void> = new Map();

  constructor(options?: { httpTimeout?: number }) {
    this.httpTimeout = options?.httpTimeout ?? 30000;
  }

  /**
   * Execute an affordance
   */
  async execute(
    affordance: Affordance,
    parameters: Record<string, unknown>,
    context: ExecutionContext
  ): Promise<ExecutionResult> {
    const startTime = Date.now();

    try {
      let result: ExecutionResult;

      switch (affordance.target.type) {
        case 'HTTP':
          result = await this.executeHTTP(affordance.target, parameters, context);
          break;

        case 'Internal':
          result = await this.executeInternal(affordance, parameters, context);
          break;

        case 'EventEmit':
          result = await this.executeEventEmit(affordance, parameters, context);
          break;

        case 'DIDComm':
          result = await this.executeDIDComm(affordance.target, parameters, context);
          break;

        case 'OID4VCI':
          result = await this.executeOID4VCI(affordance.target, parameters, context);
          break;

        default:
          result = {
            success: false,
            error: `Unknown target type: ${affordance.target.type}`,
            duration: Date.now() - startTime,
            timestamp: new Date().toISOString()
          };
      }

      return result;

    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        duration: Date.now() - startTime,
        timestamp: new Date().toISOString()
      };
    }
  }

  /**
   * Execute HTTP target
   */
  private async executeHTTP(
    target: Target,
    parameters: Record<string, unknown>,
    context: ExecutionContext
  ): Promise<ExecutionResult> {
    const startTime = Date.now();

    if (!target.href) {
      return {
        success: false,
        error: 'HTTP target missing href',
        duration: Date.now() - startTime,
        timestamp: new Date().toISOString()
      };
    }

    const method = target.method ?? 'POST';
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Agent-DID': context.agentDID,
      'X-Context-ID': context.contextId,
      'X-Trace-ID': context.traceId
    };

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.httpTimeout);

      const fetchOptions: RequestInit = {
        method,
        headers,
        signal: controller.signal
      };

      if (method !== 'GET' && method !== 'HEAD') {
        fetchOptions.body = JSON.stringify(parameters);
      }

      const response = await fetch(target.href, fetchOptions);
      clearTimeout(timeoutId);

      let data: unknown;
      const contentType = response.headers.get('content-type');
      if (contentType?.includes('application/json')) {
        data = await response.json();
      } else {
        data = await response.text();
      }

      return {
        success: response.ok,
        statusCode: response.status,
        data,
        duration: Date.now() - startTime,
        timestamp: new Date().toISOString()
      };

    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        return {
          success: false,
          error: 'Request timeout',
          duration: Date.now() - startTime,
          timestamp: new Date().toISOString()
        };
      }

      return {
        success: false,
        error: error instanceof Error ? error.message : 'HTTP request failed',
        duration: Date.now() - startTime,
        timestamp: new Date().toISOString()
      };
    }
  }

  /**
   * Execute internal target
   */
  private async executeInternal(
    affordance: Affordance,
    parameters: Record<string, unknown>,
    context: ExecutionContext
  ): Promise<ExecutionResult> {
    const startTime = Date.now();

    // Internal actions are processed in-memory
    // This is where custom internal handlers would be registered

    return {
      success: true,
      data: {
        actionType: affordance.actionType,
        parameters,
        processedAt: new Date().toISOString(),
        resultId: `urn:uuid:${uuidv4()}`
      },
      duration: Date.now() - startTime,
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Execute event emission
   */
  private async executeEventEmit(
    affordance: Affordance,
    parameters: Record<string, unknown>,
    context: ExecutionContext
  ): Promise<ExecutionResult> {
    const startTime = Date.now();

    const eventType = `${affordance.actionType}Event`;
    const eventId = `urn:uuid:${uuidv4()}`;

    const event = {
      id: eventId,
      type: eventType,
      source: context.agentDID,
      data: parameters,
      timestamp: new Date().toISOString(),
      traceId: context.traceId
    };

    // Notify registered handlers
    const handler = this.eventHandlers.get(eventType);
    if (handler) {
      try {
        handler(event);
      } catch (e) {
        // Event handler errors shouldn't fail the action
        console.error(`Event handler error for ${eventType}:`, e);
      }
    }

    return {
      success: true,
      data: { eventId, eventType },
      duration: Date.now() - startTime,
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Execute DIDComm message (stub)
   */
  private async executeDIDComm(
    target: Target,
    parameters: Record<string, unknown>,
    context: ExecutionContext
  ): Promise<ExecutionResult> {
    const startTime = Date.now();

    // DIDComm implementation would go here
    // For now, return a stub response
    console.log(`DIDComm message to ${target.serviceEndpoint}:`, parameters);

    return {
      success: true,
      data: {
        messageType: target.didcommType,
        messageId: `urn:uuid:${uuidv4()}`,
        status: 'sent',
        note: 'DIDComm execution is stubbed'
      },
      duration: Date.now() - startTime,
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Execute OID4VCI credential request (stub)
   */
  private async executeOID4VCI(
    target: Target,
    parameters: Record<string, unknown>,
    context: ExecutionContext
  ): Promise<ExecutionResult> {
    const startTime = Date.now();

    // OID4VCI implementation would go here
    // For now, return a stub response
    console.log(`OID4VCI request to ${target.href}:`, parameters);

    return {
      success: true,
      data: {
        credentialType: parameters.credentialType,
        status: 'pending',
        note: 'OID4VCI execution is stubbed - credential issuance would happen here'
      },
      duration: Date.now() - startTime,
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Register an event handler
   */
  onEvent(eventType: string, handler: (data: unknown) => void): void {
    this.eventHandlers.set(eventType, handler);
  }

  /**
   * Remove an event handler
   */
  offEvent(eventType: string): void {
    this.eventHandlers.delete(eventType);
  }
}
