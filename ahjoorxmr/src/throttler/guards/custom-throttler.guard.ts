import {
  Injectable,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  ThrottlerGuard,
  ThrottlerException,
  ThrottlerLimitDetail,
  InjectThrottlerOptions,
  InjectThrottlerStorage,
} from '@nestjs/throttler';
import type {
  ThrottlerStorage,
  ThrottlerModuleOptions,
} from '@nestjs/throttler';
import { Reflector } from '@nestjs/core';
import { createHash } from 'crypto';
import { Request } from 'express';
import { TrustedIpService } from '../services/trusted-ip.service';
import {
  THROTTLE_SKIP_KEY,
  THROTTLE_CONFIG_KEY,
  THROTTLE_BYPASS_KEY,
  RateLimitConfig,
} from '../decorators/rate-limit.decorator';
import { getApiKeyThrottleLimits } from '../throttler.config';

/**
 * Enhanced throttler guard with IP-based rate limiting,
 * trusted IP bypass, API-key + IP/user AND composition, and fail-closed Redis.
 */
@Injectable()
export class CustomThrottlerGuard extends ThrottlerGuard {
  private readonly logger = new Logger(CustomThrottlerGuard.name);

  constructor(
    @InjectThrottlerOptions()
    protected readonly options: ThrottlerModuleOptions,
    @InjectThrottlerStorage()
    protected readonly storageService: ThrottlerStorage,
    protected readonly reflector: Reflector,
    protected readonly trustedIpService: TrustedIpService,
  ) {
    super(options, storageService, reflector);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();

    const skipRateLimit = this.reflector.getAllAndOverride<boolean>(
      THROTTLE_SKIP_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (skipRateLimit) {
      this.logger.debug(`Rate limiting skipped for ${request.path}`);
      return true;
    }

    const ip = this.extractIp(request);
    this.logger.debug(`Request from IP: ${ip} to ${request.path}`);

    try {
      const blockStatus = await this.trustedIpService.isIpBlocked(ip);
      if (blockStatus.blocked) {
        this.logger.warn(`Blocked IP ${ip} attempted to access ${request.path}`);
        throw new HttpException(
          {
            statusCode: HttpStatus.FORBIDDEN,
            message: `Access denied: ${blockStatus.reason}`,
            error: 'Forbidden',
            blockedUntil: await this.getBlockExpiry(ip),
          },
          HttpStatus.FORBIDDEN,
        );
      }
    } catch (error) {
      if (error instanceof HttpException) throw error;
      this.logger.error(
        `rate_limit_redis_unavailable (block check): ${(error as Error).message}`,
      );
      throw new ServiceUnavailableException({
        statusCode: 503,
        error: 'Service Unavailable',
        message:
          'Rate limiting temporarily unavailable. Request rejected (fail-closed).',
      });
    }

    const allowBypass = this.reflector.getAllAndOverride<boolean>(
      THROTTLE_BYPASS_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (allowBypass && this.trustedIpService.isTrustedIp(ip)) {
      this.logger.log(
        `Trusted IP ${ip} bypassing rate limit for ${request.path}`,
      );
      return true;
    }

    const customConfig = this.reflector.getAllAndOverride<RateLimitConfig>(
      THROTTLE_CONFIG_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (customConfig) {
      (request as any).rateLimitConfig = customConfig;
    }

    try {
      return await super.canActivate(context);
    } catch (error) {
      if (error instanceof ServiceUnavailableException) {
        throw error;
      }

      if (error instanceof ThrottlerException) {
        const { count, shouldBlock } =
          await this.trustedIpService.incrementViolations(ip);

        this.logger.warn(
          `Rate limit exceeded for IP ${ip} on ${request.path} (${count} violations)`,
        );

        if (shouldBlock) {
          throw new HttpException(
            {
              statusCode: HttpStatus.FORBIDDEN,
              message:
                'Too many rate limit violations. Your IP has been temporarily blocked.',
              error: 'Forbidden',
              violations: count,
            },
            HttpStatus.FORBIDDEN,
          );
        }

        const customMessage = customConfig?.message;
        if (customMessage) {
          throw new HttpException(
            {
              statusCode: HttpStatus.TOO_MANY_REQUESTS,
              message: customMessage,
              error: 'Too Many Requests',
              retryAfter: customConfig?.ttl
                ? Math.ceil(customConfig.ttl / 1000)
                : 60,
            },
            HttpStatus.TOO_MANY_REQUESTS,
          );
        }

        throw error;
      }

      throw error;
    }
  }

  /**
   * Enforce IP/user bucket AND API-key bucket when X-Api-Key is present.
   * Effective limit is the stricter of the two (AND), not the looser (OR).
   */
  protected async handleRequest(requestProps: any): Promise<boolean> {
    const {
      context,
      limit,
      ttl,
      throttler,
      blockDuration,
      getTracker,
      generateKey,
    } = requestProps;
    const { req, res } = this.getRequestResponse(context);

    const ignoreUserAgents =
      throttler.ignoreUserAgents ??
      (this as any).commonOptions?.ignoreUserAgents;
    if (Array.isArray(ignoreUserAgents)) {
      for (const pattern of ignoreUserAgents) {
        if (pattern.test(req.headers['user-agent'])) {
          return true;
        }
      }
    }

    const tracker = await getTracker(req, context);
    const key = generateKey(context, tracker, throttler.name);
    const primary = await this.storageService.increment(
      key,
      ttl,
      limit,
      blockDuration,
      throttler.name,
    );

    const apiKeyHeader = req.headers['x-api-key'] as string | undefined;
    let apiKeyRecord: Awaited<ReturnType<ThrottlerStorage['increment']>> | null =
      null;

    if (apiKeyHeader && throttler.name === 'default') {
      const apiLimits = getApiKeyThrottleLimits();
      const apiTracker = `apikey:${createHash('sha256')
        .update(apiKeyHeader)
        .digest('hex')
        .slice(0, 32)}`;
      const apiKey = generateKey(
        context,
        apiTracker,
        `${throttler.name}:apikey`,
      );
      apiKeyRecord = await this.storageService.increment(
        apiKey,
        apiLimits.ttl,
        apiLimits.limit,
        blockDuration,
        throttler.name,
      );
    }

    const isBlocked = primary.isBlocked || Boolean(apiKeyRecord?.isBlocked);
    const getThrottlerSuffix = (name: string) =>
      name === 'default' ? '' : `-${name}`;
    const setHeaders = throttler.setHeaders ?? true;
    const headerPrefix = (this as any).headerPrefix ?? 'X-RateLimit';

    if (isBlocked) {
      const retryAfter =
        apiKeyRecord?.isBlocked && !primary.isBlocked
          ? apiKeyRecord.timeToBlockExpire
          : primary.timeToBlockExpire;
      if (setHeaders) {
        res.header(
          `Retry-After${getThrottlerSuffix(throttler.name)}`,
          String(retryAfter),
        );
      }
      await this.throwThrottlingException(context, {
        limit,
        ttl,
        key,
        tracker,
        totalHits: Math.max(primary.totalHits, apiKeyRecord?.totalHits ?? 0),
        timeToExpire: primary.timeToExpire,
        isBlocked: true,
        timeToBlockExpire: retryAfter,
      });
    }

    if (setHeaders) {
      const primaryRemaining = Math.max(0, limit - primary.totalHits);
      const apiRemaining = apiKeyRecord
        ? Math.max(0, getApiKeyThrottleLimits().limit - apiKeyRecord.totalHits)
        : primaryRemaining;
      const remaining = Math.min(primaryRemaining, apiRemaining);
      res.header(
        `${headerPrefix}-Limit${getThrottlerSuffix(throttler.name)}`,
        limit,
      );
      res.header(
        `${headerPrefix}-Remaining${getThrottlerSuffix(throttler.name)}`,
        remaining,
      );
      res.header(
        `${headerPrefix}-Reset${getThrottlerSuffix(throttler.name)}`,
        primary.timeToExpire,
      );
    }

    return true;
  }

  protected extractIp(req: Request): string {
    const forwardedFor = req.headers['x-forwarded-for'];
    if (forwardedFor) {
      const ips = (forwardedFor as string).split(',').map((ip) => ip.trim());
      return ips[0];
    }

    const realIp = req.headers['x-real-ip'];
    if (realIp) {
      return realIp as string;
    }

    const cfIp = req.headers['cf-connecting-ip'];
    if (cfIp) {
      return cfIp as string;
    }

    return req.ip || req.socket?.remoteAddress || 'unknown';
  }

  protected async getTracker(req: Request): Promise<string> {
    const user = (req as any).user;
    if (user?.id && !user?.apiKeyId) {
      return `user:${user.id}`;
    }
    const ip = this.extractIp(req);
    const ua = (req.headers['user-agent'] ?? 'unknown').slice(0, 128);
    return `ip:${ip}:ua:${Buffer.from(`${ip}:${ua}`).toString('base64').slice(0, 32)}`;
  }

  protected getThrottlerLimit(context: ExecutionContext): number {
    const request = context.switchToHttp().getRequest();

    const customConfig = this.reflector.getAllAndOverride<RateLimitConfig>(
      THROTTLE_CONFIG_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (customConfig) {
      return customConfig.limit;
    }

    const user = request.user;
    if (user && user.id) {
      return 200;
    }

    return 100;
  }

  protected getThrottlerTtl(context: ExecutionContext): number {
    const customConfig = this.reflector.getAllAndOverride<RateLimitConfig>(
      THROTTLE_CONFIG_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (customConfig) {
      return customConfig.ttl;
    }

    return 60000;
  }

  private async getBlockExpiry(_ip: string): Promise<number> {
    return Date.now() + 3600000;
  }

  protected async throwThrottlingException(
    context: ExecutionContext,
    throttlerLimitDetail: ThrottlerLimitDetail,
  ): Promise<void> {
    const { res } = this.getRequestResponse(context);
    const waitTime = Math.ceil(
      throttlerLimitDetail.timeToExpire ||
        throttlerLimitDetail.timeToBlockExpire ||
        1,
    );

    res.header('Retry-After', waitTime.toString());

    throw new ThrottlerException(
      await this.getErrorMessage(context, throttlerLimitDetail),
    );
  }
}
