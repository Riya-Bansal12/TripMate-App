import { WorkerEnv } from '../types';

interface WindowBucket {
  minuteTimestamps: number[];
  hourTimestamps: number[];
}

export interface WorkerRateLimiterOptions {
  maxPerMinute?: number;
  maxPerHour?: number;
  nowMs?: () => number;
}

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSec?: number;
  message?: string;
}

export class WorkerRateLimitManager {
  private readonly buckets = new Map<string, WindowBucket>();
  private readonly inFlight = new Set<string>();
  private readonly maxPerMinute: number;
  private readonly maxPerHour: number;
  private readonly nowMs: () => number;

  constructor(options: WorkerRateLimiterOptions = {}) {
    this.maxPerMinute = options.maxPerMinute ?? 20;
    this.maxPerHour = options.maxPerHour ?? 120;
    this.nowMs = options.nowMs ?? (() => Date.now());
  }

  public async checkLimit(uid: string, env: WorkerEnv): Promise<RateLimitResult> {
    // 1. Cloudflare Workers Free edge Rate Limiting binding (distributed across edge)
    if (env.AI_RATE_LIMITER && typeof env.AI_RATE_LIMITER.limit === 'function') {
      const outcome = await env.AI_RATE_LIMITER.limit({ key: `ai:min:${uid}` });
      if (!outcome.success) {
        return {
          allowed: false,
          retryAfterSec: 60,
          message: `AI request limit reached (${this.maxPerMinute}/min). Please wait 60s and try again.`,
        };
      }
    }

    // 2. Isolate-local sliding-window fallback + hourly limit enforcement
    const now = this.nowMs();
    const oneMinuteAgo = now - 60_000;
    const oneHourAgo = now - 3_600_000;

    const bucket = this.buckets.get(uid) ?? { minuteTimestamps: [], hourTimestamps: [] };
    bucket.minuteTimestamps = bucket.minuteTimestamps.filter((t) => t > oneMinuteAgo);
    bucket.hourTimestamps = bucket.hourTimestamps.filter((t) => t > oneHourAgo);

    if (bucket.minuteTimestamps.length >= this.maxPerMinute) {
      const oldest = bucket.minuteTimestamps[0] ?? now;
      const retryAfterSec = Math.max(1, Math.ceil((oldest + 60_000 - now) / 1000));
      return {
        allowed: false,
        retryAfterSec,
        message: `AI request limit reached (${this.maxPerMinute}/min). Please wait ${retryAfterSec}s and try again.`,
      };
    }

    if (bucket.hourTimestamps.length >= this.maxPerHour) {
      const oldest = bucket.hourTimestamps[0] ?? now;
      const retryAfterSec = Math.max(1, Math.ceil((oldest + 3_600_000 - now) / 1000));
      return {
        allowed: false,
        retryAfterSec,
        message: 'Hourly AI request quota reached. Please try again shortly.',
      };
    }

    bucket.minuteTimestamps.push(now);
    bucket.hourTimestamps.push(now);
    this.buckets.set(uid, bucket);

    if (this.buckets.size > 5000) {
      for (const [k, v] of this.buckets.entries()) {
        if (v.hourTimestamps.every((t) => t <= oneHourAgo)) {
          this.buckets.delete(k);
        }
      }
    }

    return { allowed: true };
  }

  public async acquireDuplicateLock(
    uid: string,
    routeKey: string,
    payload: unknown
  ): Promise<string | null> {
    const raw = new TextEncoder().encode(`${uid}:${routeKey}:${JSON.stringify(payload)}`);
    const digest = await crypto.subtle.digest('SHA-256', raw);
    const bytes = new Uint8Array(digest);
    let hex = '';
    for (let i = 0; i < bytes.length; i++) {
      hex += bytes[i].toString(16).padStart(2, '0');
    }

    if (this.inFlight.has(hex)) {
      return null;
    }
    this.inFlight.add(hex);
    return hex;
  }

  public releaseDuplicateLock(lockKey: string | null): void {
    if (lockKey) {
      this.inFlight.delete(lockKey);
    }
  }
}
