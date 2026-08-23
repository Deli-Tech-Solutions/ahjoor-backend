/**
 * API-key + IP/user throttling composition (AND, not OR).
 * Exhausting either bucket must 429 even if the other still has budget.
 */
import { Test, TestingModule } from '@nestjs/testing';
import {
  INestApplication,
  Controller,
  Get,
  Module,
  Injectable,
  CanActivate,
  ExecutionContext,
} from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { Reflector } from '@nestjs/core';
import request from 'supertest';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { CustomThrottlerGuard } from './guards/custom-throttler.guard';
import { TrustedIpService } from './services/trusted-ip.service';
import { RedisService } from '../common/redis/redis.service';
import { ThrottlerStorageRecord } from '@nestjs/throttler';

@Controller('compose')
class ComposeController {
  @Get()
  ping() {
    return { ok: true };
  }
}

/** Optional stub that attaches apiKeyId after reading header (simulates ApiKeyAuthGuard). */
@Injectable()
class AttachApiKeyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const key = req.headers['x-api-key'];
    if (key) {
      req.user = { id: 'owner-1', apiKeyId: 'key-1', scopes: [] };
    }
    return true;
  }
}

class DualBucketStore {
  counts = new Map<string, number>();

  reset() {
    this.counts.clear();
  }

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    _name: string,
  ): Promise<ThrottlerStorageRecord> {
    const totalHits = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, totalHits);
    const isBlocked = totalHits > limit;
    return {
      totalHits,
      timeToExpire: Math.ceil(ttl / 1000),
      isBlocked,
      timeToBlockExpire: isBlocked ? Math.ceil(blockDuration / 1000) : 0,
    };
  }
}

describe('API-key + IP throttling composition (AND)', () => {
  let app: INestApplication;
  const store = new DualBucketStore();
  const IP_LIMIT = 10;
  const API_LIMIT = 3;

  beforeAll(async () => {
    process.env.API_KEY_THROTTLE_LIMIT = String(API_LIMIT);
    process.env.API_KEY_THROTTLE_TTL = '60000';
    process.env.THROTTLE_LIMIT = String(IP_LIMIT);

    @Module({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        ThrottlerModule.forRoot({
          throttlers: [{ name: 'default', ttl: 60_000, limit: IP_LIMIT }],
          storage: store as any,
        }),
      ],
      controllers: [ComposeController],
      providers: [
        {
          provide: RedisService,
          useValue: {
            getClient: () => ({
              get: jest.fn().mockResolvedValue(null),
              eval: jest.fn().mockResolvedValue(1),
              setex: jest.fn(),
              incr: jest.fn(),
              expire: jest.fn(),
            }),
          },
        },
        TrustedIpService,
        ConfigService,
        Reflector,
        {
          provide: APP_GUARD,
          useClass: CustomThrottlerGuard,
        },
        {
          provide: APP_GUARD,
          useClass: AttachApiKeyGuard,
        },
      ],
    })
    class TestModule {}

    const module: TestingModule = await Test.createTestingModule({
      imports: [TestModule],
    }).compile();

    app = module.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    delete process.env.API_KEY_THROTTLE_LIMIT;
    delete process.env.API_KEY_THROTTLE_TTL;
    delete process.env.THROTTLE_LIMIT;
    await app.close();
  });

  beforeEach(() => store.reset());

  it('429s when API-key bucket is exhausted even if IP budget remains', async () => {
    const agent = request.agent(app.getHttpServer());

    for (let i = 0; i < API_LIMIT; i++) {
      await agent
        .get('/compose')
        .set('X-Api-Key', 'secret-key-aaa')
        .set('User-Agent', 'compose-test')
        .expect(200);
    }

    const res = await agent
      .get('/compose')
      .set('X-Api-Key', 'secret-key-aaa')
      .set('User-Agent', 'compose-test');

    expect(res.status).toBe(429);
  });

  it('429s when IP bucket is exhausted even if a fresh API key has budget', async () => {
    // Exhaust IP/UA tracker without API key
    for (let i = 0; i < IP_LIMIT; i++) {
      await request(app.getHttpServer())
        .get('/compose')
        .set('User-Agent', 'same-ua-for-ip')
        .expect(200);
    }

    const res = await request(app.getHttpServer())
      .get('/compose')
      .set('User-Agent', 'same-ua-for-ip')
      .set('X-Api-Key', 'brand-new-key');

    expect(res.status).toBe(429);
  });
});
