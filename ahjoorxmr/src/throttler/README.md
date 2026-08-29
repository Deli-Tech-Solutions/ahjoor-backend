# Rate Limiting & API Protection

This module implements comprehensive rate limiting and API protection using `@nestjs/throttler` with Redis storage for distributed systems.

## Counter-path audit (Issue 3)

| Path | Store | Atomic? | Fail mode |
|------|--------|---------|-----------|
| Request throttle (`RedisThrottlerStorageService.increment`) | Redis Lua (`throttle:sw:*` / `throttle:fw:*`) | Yes | **Fail-closed** → HTTP 503 (never silent allow) |
| Nest `isBlocked` contract | Same | Enforced (`totalHits > limit`) | N/A |
| Violation counters (`TrustedIpService.incrementViolations`) | Redis Lua (`violations:*`) | Yes (INCR + EXPIRE-if-new) | Errors propagate |
| IP block list | Redis (`blocked_ip:*`) | SETEX | Fail-closed in guard → 503 |
| In-memory fallback | **None in production** | — | — |

**Composition:** When `X-Api-Key` is present, the default throttler evaluates **both** the IP/user tracker and an `apikey:{sha256}` tracker. Request is rejected if **either** bucket is blocked (AND / strictest), not if only the looser one is exhausted.

**Alerting:** Log line `rate_limit_redis_unavailable` — wire pager/alert on that string when Redis is unhealthy.

**Env (API-key bucket):** `API_KEY_THROTTLE_LIMIT`, `API_KEY_THROTTLE_TTL` (default to `THROTTLE_LIMIT` / `THROTTLE_TTL`).

## Features

- ✅ **Global rate limiting** across all endpoints
- ✅ **Redis-backed storage** for distributed systems
- ✅ **IP-based throttling** with automatic IP extraction (supports proxies, load balancers, Cloudflare)
- ✅ **Trusted IP bypass** mechanism for whitelisted IPs and IP ranges
- ✅ **Automatic IP blocking** after repeated violations
- ✅ **Different limits** for authenticated vs anonymous users
- ✅ **Custom rate limits** for sensitive endpoints with decorators
- ✅ **Comprehensive rate limit headers** (RFC 6585 compatible)
- ✅ **Admin API** for managing blocked IPs and trusted IPs
- ✅ **Violation tracking** with automatic blocking
- ✅ **Configurable presets** for common scenarios (auth, public, strict, etc.)

## Configuration

### Environment Variables

Add to your `.env` file:

```env
# Redis Configuration (required for distributed rate limiting)
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=your_redis_password_here

# Rate Limiting Configuration
THROTTLE_TTL=60000                # Default rate limit window (ms)
THROTTLE_LIMIT=100                # Max requests per window (anonymous)
THROTTLE_LIMIT_AUTHENTICATED=200  # Max requests per window (authenticated)
THROTTLE_TTL_AUTHENTICATED=60000  # Rate limit window for authenticated

# Trusted IP Configuration
TRUSTED_IPS=127.0.0.1,::1
TRUSTED_IP_RANGES=10.0.0.1-10.0.0.255,172.16.0.1-172.16.255.255
```

### Default Limits

- **Anonymous users**: 100 requests per minute
- **Authenticated users**: 200 requests per minute
- **Short burst protection**: 10 requests per second
- **Strict endpoints**: 5 requests per minute (auth, registration)
- **Public endpoints**: 500 requests per minute

## Usage

### 1. Automatic Global Rate Limiting

Rate limiting is automatically applied to all endpoints via `APP_GUARD` in the `CustomThrottlerModule`.

### 2. Custom Rate Limits with Decorators

#### Using Presets

```typescript
import { Controller, Post } from '@nestjs/common';
import {
  ApiRateLimit,
  RateLimitPresets,
  AuthRateLimit,
} from '../throttler/decorators/rate-limit.decorator';

@Controller('auth')
export class AuthController {
  // Strict rate limiting (5 req/min) for authentication
  @AuthRateLimit()
  @Post('login')
  async login() {
    // Login logic
  }

  // Very strict for password reset (3 req/5min)
  @ApiRateLimit(RateLimitPresets.VERY_STRICT)
  @Post('reset-password')
  async resetPassword() {
    // Reset logic
  }

  // Moderate rate limiting (20 req/min)
  @ApiRateLimit(RateLimitPresets.MODERATE)
  @Post('verify-email')
  async verifyEmail() {
    // Verification logic
  }
}
```

#### Custom Configuration

```typescript
import { ApiRateLimit } from '../throttler/decorators/rate-limit.decorator';

@Controller('api')
export class ApiController {
  @ApiRateLimit({
    ttl: 60000, // 1 minute
    limit: 10, // 10 requests
    message: 'Too many API requests. Please slow down.',
    blockDuration: 300000, // Block for 5 minutes if exceeded
  })
  @Post('sensitive-action')
  async sensitiveAction() {
    // ...
  }
}
```

### 3. Skip Rate Limiting

```typescript
import { SkipRateLimit } from '../throttler/decorators/rate-limit.decorator';

@Controller('health')
export class HealthController {
  @SkipRateLimit()
  @Get()
  check() {
    return { status: 'ok' };
  }

  @SkipRateLimit()
  @Get('ready')
  readiness() {
    return { ready: true };
  }
}
```

### 4. Trusted IP Bypass

```typescript
import { AllowBypass } from '../throttler/decorators/rate-limit.decorator';

@Controller('internal')
export class InternalController {
  // Trusted IPs can bypass rate limits
  @AllowBypass()
  @Get('metrics')
  getMetrics() {
    // ...
  }
}
```

### 5. Public Endpoints (Lenient Limits)

```typescript
import { PublicRateLimit } from '../throttler/decorators/rate-limit.decorator';

@Controller('public')
export class PublicController {
  // 500 req/min for public data
  @PublicRateLimit()
  @Get('data')
  getPublicData() {
    // ...
  }
}
```

## Rate Limit Presets

Available presets in `RateLimitPresets`:

| Preset        | TTL   | Limit | Use Case                         |
| ------------- | ----- | ----- | -------------------------------- |
| `VERY_STRICT` | 5 min | 3     | Password reset, account deletion |
| `STRICT`      | 1 min | 5     | Login, registration, 2FA         |
| `MODERATE`    | 1 min | 20    | Sensitive operations             |
| `DEFAULT`     | 1 min | 100   | General endpoints                |
| `LENIENT`     | 1 min | 200   | Authenticated users              |
| `PUBLIC`      | 1 min | 500   | Public data endpoints            |
| `BURST`       | 1 sec | 10    | Burst protection                 |

## Response Headers

All responses include comprehensive rate limit headers:

### Standard Headers (widely supported)

```
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 95
X-RateLimit-Reset: 1708872000
X-RateLimit-Reset-After: 45
X-RateLimit-Window: 60
```

### Draft Standard Headers (RFC format)

```
RateLimit-Limit: 100
RateLimit-Remaining: 95
RateLimit-Reset: 45
RateLimit-Policy: 100;w=60
```

### Retry-After Header

When rate limit is exceeded:

```
Retry-After: 45
```

## Error Responses

### 429 Too Many Requests

```json
{
  "statusCode": 429,
  "message": "Too many authentication attempts. Please try again later.",
  "error": "Too Many Requests",
  "retryAfter": 60
}
```

### 403 Forbidden (IP Blocked)

```json
{
  "statusCode": 403,
  "message": "Access denied: Exceeded 5 violations in 3600s",
  "error": "Forbidden",
  "blockedUntil": 1708875600000
}
```

## IP Blocking & Violations

The system automatically tracks violations and blocks IPs that repeatedly exceed rate limits.

### Violation Tracking

- Each rate limit violation is logged
- After 5 violations within 1 hour, the IP is automatically blocked
- Blocked IPs receive a 403 Forbidden response
- Blocks last for 1 hour by default

### Managing Blocked IPs

Use the admin API endpoints:

```bash
# Get all blocked IPs
GET /api/v1/admin/rate-limit/blocked-ips

# Unblock an IP
DELETE /api/v1/admin/rate-limit/blocked-ips/192.168.1.100

# Manually block an IP
POST /api/v1/admin/rate-limit/blocked-ips/192.168.1.100

# Get IP information
GET /api/v1/admin/rate-limit/ip-info/192.168.1.100
```

## Trusted IPs

Configure trusted IPs that can bypass rate limits (useful for internal services, monitoring, etc.).

### Configuration

In `.env`:

```env
TRUSTED_IPS=127.0.0.1,10.0.0.1,192.168.1.50
TRUSTED_IP_RANGES=10.0.0.1-10.0.0.255,172.16.0.1-172.16.255.255
```

### Runtime Management

```bash
# Add trusted IP
POST /api/v1/admin/rate-limit/trusted-ips/10.0.0.50

# Remove trusted IP
DELETE /api/v1/admin/rate-limit/trusted-ips/10.0.0.50
```

### Usage in Code

```typescript
// Check if IP is trusted
const isTrusted = trustedIpService.isTrustedIp('10.0.0.50');

// Add IP dynamically (optional TTL in seconds)
await trustedIpService.addTrustedIp('10.0.0.50', 3600);

// Remove IP
await trustedIpService.removeTrustedIp('10.0.0.50');
```

## IP Extraction

The guard automatically extracts the real client IP from various headers:

1. `X-Forwarded-For` (first IP) - load balancers, proxies
2. `X-Real-IP` - nginx
3. `CF-Connecting-IP` - Cloudflare
4. `req.ip` - Express default
5. `req.socket.remoteAddress` - fallback

This ensures accurate rate limiting even behind proxies and CDNs.

## Admin API

All admin endpoints require authentication (add your auth guard):

### Get Blocked IPs

```bash
GET /api/v1/admin/rate-limit/blocked-ips
```

**Response:**

```json
[
  {
    "ip": "192.168.1.100",
    "reason": "Exceeded 5 violations in 3600s",
    "ttl": 3452
  }
]
```

### Get IP Information

```bash
GET /api/v1/admin/rate-limit/ip-info/192.168.1.100
```

**Response:**

```json
{
  "ip": "192.168.1.100",
  "trusted": false,
  "blocked": true,
  "violations": 6,
  "blockReason": "Exceeded 5 violations in 3600s"
}
```

### Unblock IP

```bash
DELETE /api/v1/admin/rate-limit/blocked-ips/192.168.1.100
```

### Manually Block IP

```bash
POST /api/v1/admin/rate-limit/blocked-ips/192.168.1.100
```

### Add Trusted IP

```bash
POST /api/v1/admin/rate-limit/trusted-ips/10.0.0.50
```

### Remove Trusted IP

```bash
DELETE /api/v1/admin/rate-limit/trusted-ips/10.0.0.50
```

## Testing

### Manual Testing with curl

```bash
# Test rate limit
for i in {1..105}; do
  curl -w " - Status: %{http_code}\n" http://localhost:3000/api/v1/endpoint
done

# Test with rate limit headers
curl -v http://localhost:3000/api/v1/endpoint

# Test authenticated user (higher limits)
for i in {1..205}; do
  curl -H "Authorization: Bearer YOUR_TOKEN" \
    http://localhost:3000/api/v1/endpoint
done

# Test specific headers
curl -I http://localhost:3000/api/v1/endpoint | grep -i ratelimit
```

### Unit Tests

```bash
npm test trusted-ip.service.spec
```

### Integration Tests

```typescript
describe('Rate Limiting (e2e)', () => {
  it('should throttle requests after limit', async () => {
    // Make 100 requests
    const requests = Array(100)
      .fill(null)
      .map(() => request(app.getHttpServer()).get('/api/v1/test'));

    await Promise.all(requests);

    // 101st request should be throttled
    const response = await request(app.getHttpServer())
      .get('/api/v1/test')
      .expect(429);

    expect(response.body.message).toContain('Too Many Requests');
  });
});
```

## Production Considerations

### 1. Redis Configuration

Ensure Redis is:

- Properly configured with persistence
- Using Redis Cluster for high availability
- Configured with appropriate memory limits
- Monitored for connection issues

### 2. Rate Limit Tuning

Adjust limits based on your use case:

```typescript
// For high-traffic APIs
THROTTLE_LIMIT = 500;
THROTTLE_LIMIT_AUTHENTICATED = 1000;

// For strict security
THROTTLE_LIMIT = 50;
THROTTLE_LIMIT_AUTHENTICATED = 100;
```

### 3. Monitoring

Monitor:

- Rate limit violations (logs)
- Blocked IPs count
- Redis memory usage
- Response time impact

### 4. CDN/Proxy Setup

If using Cloudflare, nginx, or other proxies:

```nginx
# Nginx config to forward real IP
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
```

### 5. Alerting

Set up alerts for:

- High violation rates (potential attack)
- Redis connection failures
- Unusual IP blocking patterns

## Architecture

```
┌─────────────────┐
│   HTTP Request  │
└────────┬────────┘
         │
         ▼
┌────────────────────────┐
│ CustomThrottlerGuard   │
│ (APP_GUARD)            │
├────────────────────────┤
│ 1. Extract IP          │
│ 2. Check if blocked    │
│ 3. Check if trusted    │
│ 4. Apply rate limit    │
│ 5. Track violations    │
└────────┬───────────────┘
         │
         ├─────────────────────┐
         ▼                     ▼
┌─────────────────┐   ┌────────────────────┐
│ TrustedIpService│   │ Redis Storage      │
├─────────────────┤   ├────────────────────┤
│ • Check trusted │   │ • Store counters   │
│ • Check blocked │   │ • Store violations │
│ • Track violations   │ • Expire keys      │
└─────────────────┘   └────────────────────┘
         │
         ▼
┌─────────────────────────┐
│ RateLimitHeaders        │
│ Interceptor             │
├─────────────────────────┤
│ Add response headers    │
└─────────────────────────┘
```

## Security Best Practices

1. **Always use HTTPS** in production
2. **Configure trusted IPs carefully** - only add IPs you control
3. **Monitor for abuse patterns** - unusual geographic patterns, user agents
4. **Use authentication** where possible - authenticated users are easier to manage
5. **Implement exponential backoff** - suggest clients implement backoff strategies
6. **Log violations** - review logs regularly for attack patterns
7. **Combine with other security measures** - use with helmet, CORS, etc.

## Troubleshooting

### High False Positives

If legitimate users are being blocked:

- Increase rate limits
- Check if proxy/CDN is configured correctly
- Verify IP extraction is working
- Add trusted IP ranges for known services

### Redis Connection Issues

```typescript
// Check Redis connection
await redisClient.ping(); // Should return 'PONG'

// Monitor Redis
await redisClient.info('stats');
```

### Rate Limit Not Working

1. Verify Redis is running: `redis-cli ping`
2. Check environment variables are loaded
3. Ensure CustomThrottlerModule is imported
4. Check logs for errors
5. Verify IP extraction with: `GET /api/v1/admin/rate-limit/ip-info/YOUR_IP`

## References

- [NestJS Throttler Documentation](https://docs.nestjs.com/security/rate-limiting)
- [RFC 6585 - Additional HTTP Status Codes](https://tools.ietf.org/html/rfc6585)
- [Draft: RateLimit Header Fields](https://datatracker.ietf.org/doc/draft-ietf-httpapi-ratelimit-headers/)
- [Redis Best Practices](https://redis.io/topics/memory-optimization)

---

**Module Version**: 2.0.0  
**Last Updated**: February 2026  
**Maintainer**: Backend Team

    // ...

}

// 3 requests per 5 minutes for password reset
@Throttle({ default: { limit: 3, ttl: 300000 } })
@Post('reset-password')
async resetPassword() {
// ...
}
}

````

### Skip Rate Limiting

Use `@SkipThrottle()` to exclude specific endpoints:

```typescript
import { SkipThrottle } from '@nestjs/throttler';

@Controller('health')
export class HealthController {
  @SkipThrottle()
  @Get()
  check() {
    return { status: 'ok' };
  }
}
````

## Response Headers

All responses include rate limit headers:

- `X-RateLimit-Limit`: Maximum number of requests allowed
- `X-RateLimit-Remaining`: Number of requests remaining
- `X-RateLimit-Reset`: Timestamp when the limit resets

## 429 Response Format

When rate limit is exceeded:

```json
{
  "statusCode": 429,
  "message": "ThrottlerException: Too Many Requests",
  "error": "Too Many Requests"
}
```

## Redis Storage

Rate limit data is stored in Redis with keys in the format:

```
throttle:user:{userId}
throttle:{ipAddress}
```

Keys automatically expire based on the TTL configuration.

## Testing

Test rate limiting with curl:

```bash
# Test anonymous rate limit
for i in {1..105}; do
  curl http://localhost:3000/api/endpoint
done

# Test authenticated rate limit
for i in {1..205}; do
  curl -H "Authorization: Bearer YOUR_TOKEN" http://localhost:3000/api/endpoint
done
```

## Production Considerations

1. Ensure Redis is properly configured and accessible
2. Monitor Redis memory usage
3. Adjust limits based on your application needs
4. Consider using Redis Cluster for high availability
5. Set up alerts for rate limit violations
