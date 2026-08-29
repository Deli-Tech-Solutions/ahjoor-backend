import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../../common/redis/redis.service';

/**
 * Service for managing trusted IPs and IP-based rate limiting.
 * Uses the shared RedisService client (same as throttler storage) so fail-modes
 * stay consistent across rate-limit counter paths.
 */
@Injectable()
export class TrustedIpService {
  private readonly logger = new Logger(TrustedIpService.name);
  private readonly trustedIps: Set<string>;
  private readonly trustedIpRanges: Array<{
    start: string;
    end: string;
  }>;

  /** Atomic INCR + EXPIRE-if-new so concurrent first hits cannot leave a key without TTL. */
  private static readonly VIOLATION_LUA = `
    local key = KEYS[1]
    local window = tonumber(ARGV[1])
    local count = redis.call('INCR', key)
    if count == 1 then
      redis.call('EXPIRE', key, window)
    end
    return count
  `;

  constructor(
    private readonly configService: ConfigService,
    private readonly redisService: RedisService,
  ) {
    const trustedIpsEnv = this.configService.get<string>('TRUSTED_IPS', '');
    this.trustedIps = new Set(
      trustedIpsEnv
        .split(',')
        .map((ip) => ip.trim())
        .filter(Boolean),
    );

    const trustedRangesEnv = this.configService.get<string>(
      'TRUSTED_IP_RANGES',
      '',
    );
    this.trustedIpRanges = trustedRangesEnv
      .split(',')
      .map((range) => range.trim())
      .filter(Boolean)
      .map((range) => {
        const [start, end] = range.split('-');
        return { start: start.trim(), end: end?.trim() || start.trim() };
      });

    if (this.trustedIps.size > 0) {
      this.logger.log(`Loaded ${this.trustedIps.size} trusted IPs`);
    }

    if (this.trustedIpRanges.length > 0) {
      this.logger.log(
        `Loaded ${this.trustedIpRanges.length} trusted IP ranges`,
      );
    }
  }

  private get redis() {
    return this.redisService.getClient();
  }

  isTrustedIp(ip: string): boolean {
    if (!ip) return false;

    if (this.trustedIps.has(ip)) {
      this.logger.debug(`IP ${ip} is in trusted list`);
      return true;
    }

    for (const range of this.trustedIpRanges) {
      if (this.isIpInRange(ip, range.start, range.end)) {
        this.logger.debug(
          `IP ${ip} is in trusted range ${range.start}-${range.end}`,
        );
        return true;
      }
    }

    return false;
  }

  async addTrustedIp(ip: string, ttl?: number): Promise<void> {
    this.trustedIps.add(ip);

    if (ttl) {
      await this.redis.setex(`trusted_ip:${ip}`, ttl, '1');
    } else {
      await this.redis.set(`trusted_ip:${ip}`, '1');
    }

    this.logger.log(`Added ${ip} to trusted IPs${ttl ? ` for ${ttl}s` : ''}`);
  }

  async removeTrustedIp(ip: string): Promise<void> {
    this.trustedIps.delete(ip);
    await this.redis.del(`trusted_ip:${ip}`);
    this.logger.log(`Removed ${ip} from trusted IPs`);
  }

  async isTrustedInRedis(ip: string): Promise<boolean> {
    const result = await this.redis.get(`trusted_ip:${ip}`);
    return result === '1';
  }

  async blockIp(ip: string, duration: number, reason?: string): Promise<void> {
    const key = `blocked_ip:${ip}`;
    await this.redis.setex(key, duration, reason || 'Rate limit exceeded');
    this.logger.warn(
      `Blocked IP ${ip} for ${duration}s. Reason: ${reason || 'Rate limit exceeded'}`,
    );
  }

  async isIpBlocked(
    ip: string,
  ): Promise<{ blocked: boolean; reason?: string }> {
    const key = `blocked_ip:${ip}`;
    const reason = await this.redis.get(key);

    if (reason) {
      return { blocked: true, reason };
    }

    return { blocked: false };
  }

  async unblockIp(ip: string): Promise<void> {
    await this.redis.del(`blocked_ip:${ip}`);
    this.logger.log(`Unblocked IP ${ip}`);
  }

  async getBlockedIps(): Promise<
    Array<{ ip: string; reason: string; ttl: number }>
  > {
    const keys = await this.redis.keys('blocked_ip:*');
    const results: Array<{ ip: string; reason: string; ttl: number }> = [];

    for (const key of keys) {
      const ip = key.replace('blocked_ip:', '');
      const reason = await this.redis.get(key);
      const ttl = await this.redis.ttl(key);

      if (reason) {
        results.push({ ip, reason, ttl });
      }
    }

    return results;
  }

  async incrementViolations(
    ip: string,
    threshold: number = 5,
    windowSeconds: number = 3600,
  ): Promise<{ count: number; shouldBlock: boolean }> {
    const key = `violations:${ip}`;
    const count = Number(
      await this.redis.eval(
        TrustedIpService.VIOLATION_LUA,
        1,
        key,
        String(windowSeconds),
      ),
    );

    const shouldBlock = count >= threshold;

    if (shouldBlock) {
      await this.blockIp(
        ip,
        3600,
        `Exceeded ${threshold} violations in ${windowSeconds}s`,
      );
      this.logger.warn(
        `IP ${ip} exceeded violation threshold (${count}/${threshold})`,
      );
    }

    return { count, shouldBlock };
  }

  private isIpInRange(ip: string, start: string, end: string): boolean {
    if (
      !this.isValidIpv4(ip) ||
      !this.isValidIpv4(start) ||
      !this.isValidIpv4(end)
    ) {
      return false;
    }

    const ipNum = this.ipToNumber(ip);
    const startNum = this.ipToNumber(start);
    const endNum = this.ipToNumber(end);

    return ipNum >= startNum && ipNum <= endNum;
  }

  private ipToNumber(ip: string): number {
    const parts = ip.split('.');
    return parts.reduce((acc, part, index) => {
      return acc + parseInt(part, 10) * Math.pow(256, 3 - index);
    }, 0);
  }

  private isValidIpv4(ip: string): boolean {
    const ipv4Pattern = /^(\d{1,3}\.){3}\d{1,3}$/;
    if (!ipv4Pattern.test(ip)) return false;

    const parts = ip.split('.');
    return parts.every((part) => {
      const num = parseInt(part, 10);
      return num >= 0 && num <= 255;
    });
  }

  async getIpInfo(ip: string): Promise<{
    ip: string;
    trusted: boolean;
    blocked: boolean;
    violations: number;
    blockReason?: string;
  }> {
    const trusted = this.isTrustedIp(ip) || (await this.isTrustedInRedis(ip));
    const { blocked, reason } = await this.isIpBlocked(ip);
    const violationsKey = `violations:${ip}`;
    const violations = parseInt(
      (await this.redis.get(violationsKey)) || '0',
      10,
    );

    return {
      ip,
      trusted,
      blocked,
      violations,
      blockReason: reason,
    };
  }
}
