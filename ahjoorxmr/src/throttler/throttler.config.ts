import { ThrottlerModuleOptions } from '@nestjs/throttler';

/**
 * Named throttlers registered with Nest.
 *
 * Nest applies EVERY named throttler on every request unless skipped.
 * Only `default` (and optional burst `short`) should be globally restrictive.
 * Other names exist so `@Throttle({ auth: { … } })` etc. can tighten a route;
 * their baseline limits are intentionally very high so they do not act as a
 * second global ceiling (AND with default already enforces the product limit).
 */
const NAMED_OVERRIDE_CEILING = 1_000_000;

export const throttlerConfig: ThrottlerModuleOptions = {
  throttlers: [
    {
      name: 'default',
      ttl: parseInt(process.env.THROTTLE_TTL || '60000', 10),
      limit: parseInt(process.env.THROTTLE_LIMIT || '100', 10),
    },
    {
      name: 'short',
      ttl: 1000,
      limit: parseInt(process.env.THROTTLE_SHORT_LIMIT || '10', 10),
    },
    {
      name: 'authenticated',
      ttl: parseInt(process.env.THROTTLE_TTL_AUTHENTICATED || '60000', 10),
      limit: NAMED_OVERRIDE_CEILING,
    },
    {
      name: 'auth',
      ttl: parseInt(process.env.AUTH_LOGIN_TTL || '60000', 10),
      limit: NAMED_OVERRIDE_CEILING,
    },
    {
      name: 'strict',
      ttl: 60000,
      limit: NAMED_OVERRIDE_CEILING,
    },
    {
      name: 'public',
      ttl: 60000,
      limit: NAMED_OVERRIDE_CEILING,
    },
  ],
  errorMessage: 'Too Many Requests',
  skipSuccessfulRequests: false,
  skipFailedRequests: false,
  ignoreUserAgents: [
    /googlebot/i,
    /bingbot/i,
    /slackbot/i,
    /twitterbot/i,
    /facebookexternalhit/i,
    /linkedinbot/i,
    /kube-probe/i,
    /pingdom/i,
    /uptimerobot/i,
  ],
};

/**
 * Optional dedicated API-key bucket (AND-composed with IP/user tracker).
 * Defaults match the default throttler unless overridden.
 */
export function getApiKeyThrottleLimits(): { limit: number; ttl: number } {
  return {
    limit: parseInt(
      process.env.API_KEY_THROTTLE_LIMIT || process.env.THROTTLE_LIMIT || '100',
      10,
    ),
    ttl: parseInt(
      process.env.API_KEY_THROTTLE_TTL || process.env.THROTTLE_TTL || '60000',
      10,
    ),
  };
}

export function getThrottlerConfig(): ThrottlerModuleOptions {
  const env = process.env.NODE_ENV || 'development';

  if (env === 'development') {
    return {
      ...throttlerConfig,
      throttlers: throttlerConfig.throttlers.map((t) =>
        t.name === 'default' || t.name === 'short'
          ? { ...t, limit: t.limit * 2 }
          : t,
      ),
    };
  }

  return throttlerConfig;
}
