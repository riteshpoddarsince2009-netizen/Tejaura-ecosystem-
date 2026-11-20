import type { SecurityConfig } from '../security/index.ts';

interface AttemptBucket {
  timestampsMs: number[];
  lockedUntilMs: number | null;
}

export type RateLimitCheckResult =
  | { allowed: true; remainingAttempts: number }
  | { allowed: false; retryAfterSeconds: number; code: 'RATE_LIMITED'; error: string };

/**
 * Sliding-window login & recovery rate limiter with temporary lockout.
 * Keys both client IP and normalized identifier to resist distributed or
 * targeted password/recovery brute-forcing.
 */
export class LoginRateLimiter {
  private readonly buckets = new Map<string, AttemptBucket>();
  private readonly policy: SecurityConfig['rateLimit'];
  private readonly clock: () => Date;

  constructor(policy: SecurityConfig['rateLimit'], clock: () => Date = () => new Date()) {
    this.policy = policy;
    this.clock = clock;
  }

  private normalizeKeys(identifier: string, clientIp?: string): string[] {
    const cleanId = (identifier || 'unknown').trim().toLowerCase();
    const cleanIp = (clientIp || 'unknown-ip').trim().toLowerCase();
    return [`id:${cleanId}`, `ip:${cleanIp}`, `pair:${cleanIp}:${cleanId}`];
  }

  private pruneBucket(bucket: AttemptBucket, nowMs: number): void {
    const windowStart = nowMs - this.policy.windowSeconds * 1000;
    bucket.timestampsMs = bucket.timestampsMs.filter((t) => t > windowStart);
    if (bucket.lockedUntilMs !== null && bucket.lockedUntilMs <= nowMs) {
      bucket.lockedUntilMs = null;
    }
  }

  check(identifier: string, clientIp?: string): RateLimitCheckResult {
    const nowMs = this.clock().getTime();
    let minRemaining = this.policy.maxAttempts;

    for (const key of this.normalizeKeys(identifier, clientIp)) {
      const bucket = this.buckets.get(key);
      if (!bucket) continue;

      this.pruneBucket(bucket, nowMs);
      if (bucket.lockedUntilMs !== null && bucket.lockedUntilMs > nowMs) {
        const retryAfterSeconds = Math.max(
          1,
          Math.ceil((bucket.lockedUntilMs - nowMs) / 1000),
        );
        return {
          allowed: false,
          retryAfterSeconds,
          code: 'RATE_LIMITED',
          error: `Too many failed authentication attempts. Retry after ${retryAfterSeconds} seconds.`,
        };
      }

      const remaining = Math.max(
        0,
        this.policy.maxAttempts - bucket.timestampsMs.length,
      );
      if (remaining < minRemaining) {
        minRemaining = remaining;
      }
    }

    return { allowed: true, remainingAttempts: minRemaining };
  }

  recordFailure(identifier: string, clientIp?: string): RateLimitCheckResult {
    const nowMs = this.clock().getTime();
    let maxLockedUntil = 0;

    for (const key of this.normalizeKeys(identifier, clientIp)) {
      const bucket = this.buckets.get(key) ?? {
        timestampsMs: [],
        lockedUntilMs: null,
      };
      this.pruneBucket(bucket, nowMs);
      bucket.timestampsMs.push(nowMs);
      if (bucket.timestampsMs.length >= this.policy.maxAttempts) {
        bucket.lockedUntilMs = nowMs + this.policy.lockoutSeconds * 1000;
        if (bucket.lockedUntilMs > maxLockedUntil) {
          maxLockedUntil = bucket.lockedUntilMs;
        }
      }
      this.buckets.set(key, bucket);
    }

    if (maxLockedUntil > nowMs) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((maxLockedUntil - nowMs) / 1000),
      );
      return {
        allowed: false,
        retryAfterSeconds,
        code: 'RATE_LIMITED',
        error: `Too many failed authentication attempts. Locked out for ${retryAfterSeconds} seconds.`,
      };
    }

    return this.check(identifier, clientIp);
  }

  reset(identifier: string, clientIp?: string): void {
    for (const key of this.normalizeKeys(identifier, clientIp)) {
      this.buckets.delete(key);
    }
  }
}
