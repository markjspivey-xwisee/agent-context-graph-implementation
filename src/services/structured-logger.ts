/**
 * Structured Logger Service
 *
 * JSON-based structured logging with log levels, context, and correlation IDs.
 */

import { EventEmitter } from 'events';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  component?: string;
  correlationId?: string;
  requestId?: string;
  brokerId?: string;
  userId?: string;
  duration?: number;
  error?: {
    name: string;
    message: string;
    stack?: string;
  };
  metadata?: Record<string, unknown>;
}

export interface LoggerConfig {
  level: LogLevel;
  prettyPrint: boolean;
  includeTimestamp: boolean;
  includeStack: boolean;
  redactPaths: string[];
  output: 'console' | 'file' | 'both';
  filePath?: string;
}

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  fatal: 4
};

export class StructuredLogger extends EventEmitter {
  private config: LoggerConfig;
  private context: Record<string, unknown> = {};
  private buffer: LogEntry[] = [];
  private maxBufferSize = 1000;

  constructor(config?: Partial<LoggerConfig>) {
    super();
    this.config = {
      level: (process.env.LOG_LEVEL as LogLevel) || 'info',
      prettyPrint: process.env.NODE_ENV !== 'production',
      includeTimestamp: true,
      includeStack: process.env.NODE_ENV !== 'production',
      redactPaths: ['password', 'token', 'secret', 'apiKey', 'privateKey'],
      output: 'console',
      ...config
    };
  }

  /**
   * Set global context that's included in all logs
   */
  setContext(context: Record<string, unknown>): void {
    this.context = { ...this.context, ...context };
  }

  /**
   * Create a child logger with additional context
   */
  child(context: Record<string, unknown>): StructuredLogger {
    const child = new StructuredLogger(this.config);
    child.setContext({ ...this.context, ...context });
    return child;
  }

  debug(message: string, metadata?: Record<string, unknown>): void {
    this.log('debug', message, metadata);
  }

  info(message: string, metadata?: Record<string, unknown>): void {
    this.log('info', message, metadata);
  }

  warn(message: string, metadata?: Record<string, unknown>): void {
    this.log('warn', message, metadata);
  }

  error(message: string, error?: Error | unknown, metadata?: Record<string, unknown>): void {
    const errorMeta = error instanceof Error ? {
      error: {
        name: error.name,
        message: error.message,
        stack: this.config.includeStack ? error.stack : undefined
      }
    } : {};

    this.log('error', message, { ...metadata, ...errorMeta });
  }

  fatal(message: string, error?: Error | unknown, metadata?: Record<string, unknown>): void {
    const errorMeta = error instanceof Error ? {
      error: {
        name: error.name,
        message: error.message,
        stack: this.config.includeStack ? error.stack : undefined
      }
    } : {};

    this.log('fatal', message, { ...metadata, ...errorMeta });
  }

  /**
   * Log HTTP request
   */
  request(req: {
    method: string;
    path: string;
    statusCode: number;
    duration: number;
    ip?: string;
    userAgent?: string;
    correlationId?: string;
    brokerId?: string;
  }): void {
    const level: LogLevel = req.statusCode >= 500 ? 'error' :
                            req.statusCode >= 400 ? 'warn' : 'info';

    this.log(level, `${req.method} ${req.path} ${req.statusCode}`, {
      http: {
        method: req.method,
        path: req.path,
        statusCode: req.statusCode,
        duration: req.duration,
        ip: req.ip,
        userAgent: req.userAgent
      },
      correlationId: req.correlationId,
      brokerId: req.brokerId,
      duration: req.duration
    });
  }

  /**
   * Log WebSocket event
   */
  websocket(event: {
    type: 'connect' | 'disconnect' | 'message' | 'error';
    connectionId: string;
    brokerId?: string;
    messageType?: string;
    error?: Error;
  }): void {
    const level: LogLevel = event.type === 'error' ? 'error' : 'debug';

    this.log(level, `WebSocket ${event.type}`, {
      websocket: {
        type: event.type,
        connectionId: event.connectionId,
        messageType: event.messageType
      },
      brokerId: event.brokerId,
      error: event.error ? {
        name: event.error.name,
        message: event.error.message
      } : undefined
    });
  }

  /**
   * Get recent logs from buffer
   */
  getRecentLogs(options: {
    level?: LogLevel;
    component?: string;
    correlationId?: string;
    limit?: number;
  } = {}): LogEntry[] {
    let logs = [...this.buffer];

    if (options.level) {
      const minLevel = LOG_LEVELS[options.level];
      logs = logs.filter(l => LOG_LEVELS[l.level] >= minLevel);
    }

    if (options.component) {
      logs = logs.filter(l => l.component === options.component);
    }

    if (options.correlationId) {
      logs = logs.filter(l => l.correlationId === options.correlationId);
    }

    return logs.slice(-(options.limit || 100));
  }

  /**
   * Flush buffer (for graceful shutdown)
   */
  flush(): void {
    // In production, would write to file or external service
    this.buffer = [];
  }

  private log(level: LogLevel, message: string, metadata?: Record<string, unknown>): void {
    if (LOG_LEVELS[level] < LOG_LEVELS[this.config.level]) {
      return;
    }

    const entry: LogEntry = {
      timestamp: this.config.includeTimestamp ? new Date().toISOString() : '',
      level,
      message,
      ...this.context,
      ...this.redact(metadata || {})
    };

    // Add to buffer
    this.buffer.push(entry);
    if (this.buffer.length > this.maxBufferSize) {
      this.buffer.shift();
    }

    // Output
    this.output(entry);

    // Emit for external handlers
    this.emit('log', entry);

    // Fatal logs should also emit an alert
    if (level === 'fatal') {
      this.emit('fatal', entry);
    }
  }

  private output(entry: LogEntry): void {
    if (this.config.output === 'console' || this.config.output === 'both') {
      if (this.config.prettyPrint) {
        this.prettyOutput(entry);
      } else {
        console.log(JSON.stringify(entry));
      }
    }
  }

  private prettyOutput(entry: LogEntry): void {
    const colors = {
      debug: '\x1b[36m',  // Cyan
      info: '\x1b[32m',   // Green
      warn: '\x1b[33m',   // Yellow
      error: '\x1b[31m',  // Red
      fatal: '\x1b[35m',  // Magenta
      reset: '\x1b[0m'
    };

    const color = colors[entry.level] || colors.reset;
    const levelStr = entry.level.toUpperCase().padEnd(5);
    const component = entry.component ? `[${entry.component}]` : '';

    let output = `${entry.timestamp} ${color}${levelStr}${colors.reset} ${component} ${entry.message}`;

    if (entry.duration !== undefined) {
      output += ` (${entry.duration}ms)`;
    }

    if (entry.metadata && Object.keys(entry.metadata).length > 0) {
      output += ` ${JSON.stringify(entry.metadata)}`;
    }

    console.log(output);

    if (entry.error?.stack) {
      console.log(entry.error.stack);
    }
  }

  private redact(obj: Record<string, unknown>): Record<string, unknown> {
    const redacted = { ...obj };

    const redactValue = (value: unknown, path: string): unknown => {
      if (value === null || value === undefined) {
        return value;
      }

      if (typeof value === 'object' && !Array.isArray(value)) {
        const result: Record<string, unknown> = {};
        for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
          const currentPath = path ? `${path}.${key}` : key;
          result[key] = redactValue(val, currentPath);
        }
        return result;
      }

      if (Array.isArray(value)) {
        return value.map((item, idx) => redactValue(item, `${path}[${idx}]`));
      }

      // Check if this path should be redacted
      const pathParts = path.toLowerCase().split('.');
      const shouldRedact = this.config.redactPaths.some(redactPath =>
        pathParts.some(part => part.includes(redactPath.toLowerCase()))
      );

      if (shouldRedact && typeof value === 'string') {
        return '[REDACTED]';
      }

      return value;
    };

    return redactValue(redacted, '') as Record<string, unknown>;
  }
}

// Singleton instance for convenience
export const logger = new StructuredLogger();

/**
 * Hapi plugin for request logging
 */
export function loggerPlugin(structuredLogger: StructuredLogger) {
  return {
    name: 'structuredLogger',
    version: '1.0.0',
    register: async (server: any) => {
      // Generate correlation ID for each request
      server.ext('onRequest', (request: any, h: any) => {
        request.app.correlationId = request.headers['x-correlation-id'] ||
          `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        request.app.startTime = Date.now();
        return h.continue;
      });

      // Log completed requests
      server.events.on('response', (request: any) => {
        const duration = Date.now() - (request.app.startTime || Date.now());
        structuredLogger.request({
          method: request.method.toUpperCase(),
          path: request.path,
          statusCode: request.response?.statusCode || 0,
          duration,
          ip: request.info.remoteAddress,
          userAgent: request.headers['user-agent'],
          correlationId: request.app.correlationId,
          brokerId: request.auth?.credentials?.brokerId
        });
      });
    }
  };
}
