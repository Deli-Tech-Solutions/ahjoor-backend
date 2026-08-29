/**
 * Distributed rate limiting across ≥3 simulated instances.
 *
 * Uses a shared in-process counter that implements the Nest v6 storage
 * contract (`isBlocked`) to prove a client cannot multiply their budget by
 * spreading requests across instances. Production uses Redis Lua; this test
 * models the shared store without requiring a live Redis in unit CI.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, Controller, Get, Module } from '@nestjs/common';
import { ThrottlerModule, ThrottlerGuard, ThrottlerStorageRecord } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import request from 'supertest';
import { ConfigModule } from '@nestjs/config';

@Controller('test-rl')
class TestRlController {
  @Get()
  ping() {
    return { ok: true };
  }
}

class SharedAtomicStore {
  private counts = new Map<string, number>();

  reset() {
    this.counts.clear();
  }

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    _throttlerName: string,
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

const sharedStore = new SharedAtomicStore();

async function buildApp(limit: number, ttl: number): Promise<INestApplication> {
  @Module({
    imports: [
      ConfigModule.forRoot({ isGlobal: true }),
      ThrottlerModule.forRoot({
        throttlers: [{ name: 'default', ttl, limit }],
        storage: sharedStore as any,
      }),
    ],
    controllers: [TestRlController],
    providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
  })
  class TestAppModule {}

  const module: TestingModule = await Test.createTestingModule({
    imports: [TestAppModule],
  }).compile();

  const app = module.createNestApplication();
  await app.init();
  return app;
}

describe('Distributed Rate Limiting (≥3 instances)', () => {
  let apps: INestApplication[];
  const LIMIT = 5;
  const TTL = 60_000;

  beforeAll(async () => {
    apps = await Promise.all([
      buildApp(LIMIT, TTL),
      buildApp(LIMIT, TTL),
      buildApp(LIMIT, TTL),
    ]);
  });

  afterAll(async () => {
    await Promise.all(apps.map((a) => a.close()));
  });

  beforeEach(() => sharedStore.reset());

  it('allows at most LIMIT successes when requests are spread across 3 instances', async () => {
    const statuses: number[] = [];

    // 9 requests round-robin across 3 instances (would be 3×LIMIT if per-instance)
    for (let i = 0; i < LIMIT * 2; i++) {
      const app = apps[i % apps.length];
      const res = await request(app.getHttpServer()).get('/test-rl');
      statuses.push(res.status);
    }

    const allowed = statuses.filter((s) => s === 200).length;
    const blocked = statuses.filter((s) => s === 429).length;

    expect(allowed).toBe(LIMIT);
    expect(blocked).toBe(LIMIT);
  });

  it('blocks on instance C after A and B together exhaust the shared limit', async () => {
    for (let i = 0; i < 2; i++) {
      await request(apps[0].getHttpServer()).get('/test-rl').expect(200);
    }
    for (let i = 0; i < 2; i++) {
      await request(apps[1].getHttpServer()).get('/test-rl').expect(200);
    }
    await request(apps[2].getHttpServer()).get('/test-rl').expect(200);

    const res = await request(apps[2].getHttpServer()).get('/test-rl');
    expect(res.status).toBe(429);
  });
});
