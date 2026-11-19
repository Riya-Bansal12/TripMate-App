import crypto from 'node:crypto';
import { NextFunction, Request, Response } from 'express';

/**
 * In-memory per-UID rate limiter + duplicate in-flight submission guard.
 * Suitable for this single-instance development / preview runtime.
 * Multi-instance production hosting requires a distributed rate-limit store (e.g., Redis).
 */
interface WindowBucket {
  minuteTimestamps: number[];
  hourTimestamps: number[];
}

export interface RateLimiterOptions {
  maxPerMinute?: number;
  maxPerHour?: number;
}

export class RateLimitManager {
  private readonly buckets = new Map<string, WindowBucket>();
  private readonly inFlight = new Set<string>();
  private readonly maxPerMinute: number;
  private readonly maxPerHour: number;

  constructor(options: RateLimiterOptions = {}) {
    this.maxPerMinute = options.maxPerMinute ?? 20;
    this.maxPerHour = options.maxPerHour ?? 120;
  }

  public middleware = (req: Request, res: Response, next: NextFunction): void => {
    const uid = req.auth?.uid;
    if (!uid) {
      res.status(401).json({
        error: 'Authentication required before rate limit evaluation.',
        code: 'AUTH_MISSING',
      });
      return;
    }

    const now = Date.now();
    const oneMinuteAgo = now - 60_000;
    const oneHourAgo = now - 3_600_000;

    const bucket = this.buckets.get(uid) ?? { minuteTimestamps: [], hourTimestamps: [] };
    bucket.minuteTimestamps = bucket.minuteTimestamps.filter((t) => t > oneMinuteAgo);
    bucket.hourTimestamps = bucket.hourTimestamps.filter((t) => t > oneHourAgo);

    if (bucket.minuteTimestamps.length >= this.maxPerMinute) {
      const oldest = bucket.minuteTimestamps[0] ?? now;
      const retryAfterSec = Math.max(1, Math.ceil((oldest + 60_000 - now) / 1000));
      res.setHeader('Retry-After', String(retryAfterSec));
      res.status(429).json({
        error: `AI request limit reached (${this.maxPerMinute}/min). Please wait ${retryAfterSec}s and try again.`,
        code: 'RATE_LIMIT_EXCEEDED',
      });
      return;
    }

    if (bucket.hourTimestamps.length >= this.maxPerHour) {
      const oldest = bucket.hourTimestamps[0] ?? now;
      const retryAfterSec = Math.max(1, Math.ceil((oldest + 3_600_000 - now) / 1000));
      res.setHeader('Retry-After', String(retryAfterSec));
      res.status(429).json({
        error: 'Hourly AI request quota reached. Please try again shortly.',
        code: 'RATE_LIMIT_EXCEEDED',
      });
      return;
    }

    bucket.minuteTimestamps.push(now);
    bucket.hourTimestamps.push(now);
    this.buckets.set(uid, bucket);

    // Prevent memory buildup in long-running single instance
    if (this.buckets.size > 5000) {
      for (const [k, v] of this.buckets.entries()) {
        if (v.hourTimestamps.every((t) => t <= oneHourAgo)) {
          this.buckets.delete(k);
        }
      }
    }

    next();
  };

  public acquireDuplicateLock(uid: string, routeKey: string, payload: unknown): string | null {
    const hash = crypto
      .createHash('sha256')
      .update(`${uid}:${routeKey}:${JSON.stringify(payload)}`)
      .digest('hex');
    if (this.inFlight.has(hash)) {
      return null;
    }
    this.inFlight.add(hash);
    return hash;
  }

  public releaseDuplicateLock(lockKey: string | null): void {
    if (lockKey) {
      this.inFlight.delete(lockKey);
    }
  }
}
