/**
 * Rate Limiter Service
 *
 * Token bucket rate limiting for API endpoints with configurable limits per route.
 */

import { EventEmitter } from 'events';

export interface RateLimitConfig {
  windowMs: number;       // Time window in milliseconds
  maxRequests: number;    // Max requests per window
  keyGenerator?: (request: RateLimitRequest) => string;
}

export interface RateLimitRequest {
  ip?: string;
  userId?: string;
  brokerId?: string;
  path: string;
  method: string;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetTime: number;
  retryAfter?: number;
}

interface TokenBucket {
  tokens: number;
  lastRefill: number;
}

export class RateLimiterService extends EventEmitter {
  private buckets: Map<string, TokenBucket> = new Map();
  private configs: Map<string, RateLimitConfig> = new Map();
  private defaultConfig: RateLimitConfig;
  private cleanupInterval: NodeJS.Timer | null = null;

  constructor(defaultConfig?: Partial<RateLimitConfig>) {
    super();
    this.defaultConfig = {
      windowMs: 60000,      // 1 minute
      maxRequests: 100,     // 100 requests per minute
      ...defaultConfig
    };

    // Start cleanup interval
    this.startCleanup();
  }

  /**
   * Configure rate limit for a specific route pattern
   */
  setRouteLimit(pattern: string, config: Partial<RateLimitConfig>): void {
    this.configs.set(pattern, {
      ...this.defaultConfig,
      ...config
    });
  }

  /**
   * Configure common route limits
   */
  configureDefaults(): void {
    // High-frequency endpoints (less restrictive)
    this.setRouteLimit('/health', { maxRequests: 1000, windowMs: 60000 });
    this.setRouteLimit('/stats', { maxRequests: 300, windowMs: 60000 });

    // Read endpoints (moderate)
    this.setRouteLimit('GET:/broker/*', { maxRequests: 200, windowMs: 60000 });
    this.setRouteLimit('GET:/social/*', { maxRequests: 200, windowMs: 60000 });
    this.setRouteLimit('GET:/contexts/*', { maxRequests: 200, windowMs: 60000 });

    // Write endpoints (more restrictive)
    this.setRouteLimit('POST:/broker/*', { maxRequests: 60, windowMs: 60000 });
    this.setRouteLimit('POST:/social/*', { maxRequests: 60, windowMs: 60000 });
    this.setRouteLimit('POST:/contexts/*', { maxRequests: 60, windowMs: 60000 });

    // SPARQL (expensive operations)
    this.setRouteLimit('POST:/sparql', { maxRequests: 30, windowMs: 60000 });

    // Context generation (expensive)
    this.setRouteLimit('POST:/context', { maxRequests: 30, windowMs: 60000 });

    // Bulk operations
    this.setRouteLimit('POST:/goals', { maxRequests: 10, windowMs: 60000 });

    // WebSocket message rate (per connection)
    this.setRouteLimit('WS:message', { maxRequests: 50, windowMs: 1000 }); // 50/sec
  }

  /**
   * Check if request is allowed
   */
  check(request: RateLimitRequest): RateLimitResult {
    const key = this.getKey(request);
    const config = this.getConfig(request);
    const now = Date.now();

    let bucket = this.buckets.get(key);

    if (!bucket) {
      bucket = {
        tokens: config.maxRequests,
        lastRefill: now
      };
      this.buckets.set(key, bucket);
    }

    // Refill tokens based on elapsed time
    const elapsed = now - bucket.lastRefill;
    const refillRate = config.maxRequests / config.windowMs;
    const tokensToAdd = Math.floor(elapsed * refillRate);

    if (tokensToAdd > 0) {
      bucket.tokens = Math.min(config.maxRequests, bucket.tokens + tokensToAdd);
      bucket.lastRefill = now;
    }

    // Check if request is allowed
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return {
        allowed: true,
        remaining: Math.floor(bucket.tokens),
        resetTime: now + config.windowMs
      };
    }

    // Rate limited
    const retryAfter = Math.ceil((1 - bucket.tokens) / refillRate);

    this.emit('limited', {
      key,
      request,
      retryAfter
    });

    return {
      allowed: false,
      remaining: 0,
      resetTime: now + config.windowMs,
      retryAfter
    };
  }

  /**
   * Get rate limit headers for response
   */
  getHeaders(result: RateLimitResult): Record<string, string> {
    const headers: Record<string, string> = {
      'X-RateLimit-Remaining': result.remaining.toString(),
      'X-RateLimit-Reset': Math.ceil(result.resetTime / 1000).toString()
    };

    if (!result.allowed && result.retryAfter) {
      headers['Retry-After'] = result.retryAfter.toString();
    }

    return headers;
  }

  /**
   * Reset rate limit for a key
   */
  reset(key: string): void {
    this.buckets.delete(key);
  }

  /**
   * Get current stats
   */
  getStats(): {
    activeBuckets: number;
    configuredRoutes: number;
    recentLimited: number;
  } {
    return {
      activeBuckets: this.buckets.size,
      configuredRoutes: this.configs.size,
      recentLimited: 0 // Would track in production
    };
  }

  private getKey(request: RateLimitRequest): string {
    const keyGen = this.getConfig(request).keyGenerator;
    if (keyGen) {
      return keyGen(request);
    }

    // Default key: IP + route
    const identifier = request.brokerId || request.userId || request.ip || 'anonymous';
    return `${identifier}:${request.method}:${request.path}`;
  }

  private getConfig(request: RateLimitRequest): RateLimitConfig {
    const routeKey = `${request.method}:${request.path}`;

    // Check for exact match
    if (this.configs.has(routeKey)) {
      return this.configs.get(routeKey)!;
    }

    // Check for pattern match
    for (const [pattern, config] of this.configs) {
      if (this.matchesPattern(routeKey, pattern)) {
        return config;
      }
    }

    // Check path-only patterns
    if (this.configs.has(request.path)) {
      return this.configs.get(request.path)!;
    }

    return this.defaultConfig;
  }

  private matchesPattern(route: string, pattern: string): boolean {
    // Convert glob pattern to regex
    const regexPattern = pattern
      .replace(/\*/g, '.*')
      .replace(/\//g, '\\/');
    const regex = new RegExp(`^${regexPattern}$`);
    return regex.test(route);
  }

  private startCleanup(): void {
    // Clean up stale buckets every 5 minutes
    this.cleanupInterval = setInterval(() => {
      const now = Date.now();
      const staleThreshold = 5 * 60 * 1000; // 5 minutes

      for (const [key, bucket] of this.buckets) {
        if (now - bucket.lastRefill > staleThreshold) {
          this.buckets.delete(key);
        }
      }
    }, 5 * 60 * 1000);
  }

  stop(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }
}

/**
 * Hapi plugin for rate limiting
 */
export function rateLimiterPlugin(rateLimiter: RateLimiterService) {
  return {
    name: 'rateLimiter',
    version: '1.0.0',
    register: async (server: any) => {
      server.ext('onPreHandler', (request: any, h: any) => {
        const rateLimitRequest: RateLimitRequest = {
          ip: request.info.remoteAddress,
          brokerId: request.auth?.credentials?.brokerId,
          path: request.path,
          method: request.method.toUpperCase()
        };

        const result = rateLimiter.check(rateLimitRequest);

        // Add headers to response
        request.response?.header && Object.entries(rateLimiter.getHeaders(result))
          .forEach(([key, value]) => request.response.header(key, value));

        if (!result.allowed) {
          return h.response({
            error: 'Too Many Requests',
            retryAfter: result.retryAfter
          }).code(429).takeover();
        }

        return h.continue;
      });
    }
  };
}
