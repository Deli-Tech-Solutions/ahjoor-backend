import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import {
  ThrottlerStorage,
  ThrottlerStorageRecord,
} from '@nestjs/throttler';
import { RedisService } from '../common/redis/redis.service';

/**
 * Redis-backed throttler storage shared across all instances.
 *
 * Policy (Issue 3):
 * - Counting is centralized in Redis only — no in-memory fallback that allows traffic.
 * - Increments are atomic Lua scripts (INCR+EXPIRE / ZSET sliding window).
 * - When Redis is unreachable, requests FAIL CLOSED (503) instead of silently allowing.
 * - NestJS Throttler v6 contract: returns `isBlocked` so limits are actually enforced.
 *
 * Keys:
 *   throttle:sw:{key}  — sliding window sorted set
 *   throttle:fw:{key}  — fixed window counter
 *   throttle:block:{key} — optional block TTL after limit exceeded
 */
@Injectable()
export class RedisThrottlerStorageService implements ThrottlerStorage {
  private readonly logger = new Logger(RedisThrottlerStorageService.name);
  private readonly algorithm: 'sliding_window' | 'fixed_window';

  /** Sliding-window Lua: ZREMRANGEBYSCORE + ZADD + ZCARD + PEXPIRE. Returns {hits, pttl}. */
  private static readonly SLIDING_LUA = `
    local key = KEYS[1]
    local now = tonumber(ARGV[1])
    local windowStart = tonumber(ARGV[2])
    local member = ARGV[3]
    local ttl = tonumber(ARGV[4])
    redis.call('ZREMRANGEBYSCORE', key, '-inf', windowStart)
    redis.call('ZADD', key, now, member)
    local hits = redis.call('ZCARD', key)
    redis.call('PEXPIRE', key, ttl)
    return { hits, ttl }
  `;

  /**
   * Fixed-window Lua: INCR, set EXPIRE only when key has no TTL (avoids resetting
   * the window on every hit), return hits + pttl.
   */
  private static readonly FIXED_LUA = `
    local key = KEYS[1]
    local ttl = tonumber(ARGV[1])
    local hits = redis.call('INCR', key)
    local pttl = redis.call('PTTL', key)
    if pttl < 0 then
      redis.call('PEXPIRE', key, ttl)
      pttl = ttl
    end
    return { hits, pttl }
  `;

  /** Set a block key with TTL when limit exceeded (Nest blockDuration). */
  private static readonly BLOCK_LUA = `
    local key = KEYS[1]
    local blockMs = tonumber(ARGV[1])
    local exists = redis.call('PTTL', key)
    if exists < 0 then
      redis.call('SET', key, '1', 'PX', blockMs)
      return blockMs
    end
    return exists
  `;

  constructor(private readonly redisService: RedisService) {
    const algo = process.env.THROTTLE_ALGORITHM ?? 'sliding_window';
    this.algorithm =
      algo === 'fixed_window' ? 'fixed_window' : 'sliding_window';
  }

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    _throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    try {
      const blockKey = `throttle:block:${key}`;
      const redis = this.redisService.getClient();

      const existingBlockTtl = await redis.pttl(blockKey);
      if (existingBlockTtl > 0) {
        return {
          totalHits: limit + 1,
          timeToExpire: Math.ceil(existingBlockTtl / 1000),
          isBlocked: true,
          timeToBlockExpire: Math.ceil(existingBlockTtl / 1000),
        };
      }

      const { totalHits, timeToExpireMs } =
        this.algorithm === 'sliding_window'
          ? await this.slidingWindow(key, ttl)
          : await this.fixedWindow(key, ttl);

      const isBlocked = totalHits > limit;
      let timeToBlockExpire = 0;

      if (isBlocked && blockDuration > 0) {
        const blockMs = await redis.eval(
          RedisThrottlerStorageService.BLOCK_LUA,
          1,
          blockKey,
          String(blockDuration),
        ) as number;
        timeToBlockExpire = Math.ceil(blockMs / 1000);
      }

      return {
        totalHits,
        timeToExpire: Math.ceil(timeToExpireMs / 1000),
        isBlocked,
        timeToBlockExpire: isBlocked
          ? timeToBlockExpire || Math.ceil(timeToExpireMs / 1000)
          : 0,
      };
    } catch (err) {
      // FAIL CLOSED — never silently allow when the shared store is down.
      this.logger.error(
        `rate_limit_redis_unavailable key=${key}: ${(err as Error).message}`,
        (err as Error).stack,
      );
      throw new ServiceUnavailableException({
        statusCode: 503,
        error: 'Service Unavailable',
        message:
          'Rate limiting temporarily unavailable. Request rejected (fail-closed).',
      });
    }
  }

  private async slidingWindow(
    key: string,
    ttl: number,
  ): Promise<{ totalHits: number; timeToExpireMs: number }> {
    const redis = this.redisService.getClient();
    const redisKey = `throttle:sw:${key}`;
    const now = Date.now();
    const windowStart = now - ttl;
    const member = `${now}-${Math.random()}`;

    const result = (await redis.eval(
      RedisThrottlerStorageService.SLIDING_LUA,
      1,
      redisKey,
      String(now),
      String(windowStart),
      member,
      String(ttl),
    )) as [number, number];

    return { totalHits: Number(result[0]), timeToExpireMs: Number(result[1]) };
  }

  private async fixedWindow(
    key: string,
    ttl: number,
  ): Promise<{ totalHits: number; timeToExpireMs: number }> {
    const redis = this.redisService.getClient();
    const redisKey = `throttle:fw:${key}`;

    const result = (await redis.eval(
      RedisThrottlerStorageService.FIXED_LUA,
      1,
      redisKey,
      String(ttl),
    )) as [number, number];

    return { totalHits: Number(result[0]), timeToExpireMs: Number(result[1]) };
  }
}
