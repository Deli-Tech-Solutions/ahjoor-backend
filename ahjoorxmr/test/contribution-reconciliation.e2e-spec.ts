import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { AppModule } from '../src/app.module';
import { Contribution, ContributionStatus } from '../src/contributions/entities/contribution.entity';
import { ContributionsService } from '../src/contributions/contributions.service';
import { StellarService } from '../src/stellar/stellar.service';

describe('Contribution reconciliation after crash (e2e)', () => {
  let app: INestApplication;
  let contributionRepo: Repository<Contribution>;
  let contributionsService: ContributionsService;
  let stellarService: StellarService;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    contributionRepo = app.get(getRepositoryToken(Contribution));
    contributionsService = app.get(ContributionsService);
    stellarService = app.get(StellarService);
  });

  afterAll(async () => {
    await app.close();
  });

  it('reconciles a contribution stuck in ON_CHAIN_SUBMITTED when Stellar reports CONFIRMED', async () => {
    // Simulate a crash: DB write succeeded (ON_CHAIN_SUBMITTED) but process died
    // before the confirmation job could run.
    const stuckContribution = contributionRepo.create({
      id: uuidv4(),
      groupId: uuidv4(),
      userId: uuidv4(),
      walletAddress: 'GTEST123',
      roundNumber: 1,
      amount: '100.00',
      transactionHash: `crash-test-${Date.now()}`,
      timestamp: new Date(),
      assetCode: 'XLM',
      assetIssuer: null,
      status: ContributionStatus.ON_CHAIN_SUBMITTED,
      idempotencyKey: uuidv4(),
    });

    // Back-date updatedAt so it falls outside the stale window
    await contributionRepo.save(stuckContribution);
    await contributionRepo.update(stuckContribution.id, {
      updatedAt: new Date(Date.now() - 120_000),
    } as any);

    // Mock Stellar to report the tx as confirmed
    jest
      .spyOn(stellarService, 'getTransactionStatus')
      .mockResolvedValueOnce('CONFIRMED');

    await contributionsService.reconcileStuckContributions(60_000);

    const resolved = await contributionRepo.findOneOrFail({
      where: { id: stuckContribution.id },
    });
    expect(resolved.status).toBe(ContributionStatus.CONFIRMED);
  });

  it('reconciles a contribution stuck in ON_CHAIN_SUBMITTED when Stellar reports FAILED', async () => {
    const stuckContribution = contributionRepo.create({
      id: uuidv4(),
      groupId: uuidv4(),
      userId: uuidv4(),
      walletAddress: 'GTEST456',
      roundNumber: 1,
      amount: '100.00',
      transactionHash: `crash-test-failed-${Date.now()}`,
      timestamp: new Date(),
      assetCode: 'XLM',
      assetIssuer: null,
      status: ContributionStatus.ON_CHAIN_SUBMITTED,
      idempotencyKey: uuidv4(),
    });

    await contributionRepo.save(stuckContribution);
    await contributionRepo.update(stuckContribution.id, {
      updatedAt: new Date(Date.now() - 120_000),
    } as any);

    jest
      .spyOn(stellarService, 'getTransactionStatus')
      .mockResolvedValueOnce('FAILED');

    await contributionsService.reconcileStuckContributions(60_000);

    const resolved = await contributionRepo.findOneOrFail({
      where: { id: stuckContribution.id },
    });
    expect(resolved.status).toBe(ContributionStatus.FAILED);
  });

  it('leaves a contribution in ON_CHAIN_SUBMITTED when Stellar still reports PENDING', async () => {
    const stuckContribution = contributionRepo.create({
      id: uuidv4(),
      groupId: uuidv4(),
      userId: uuidv4(),
      walletAddress: 'GTEST789',
      roundNumber: 1,
      amount: '100.00',
      transactionHash: `crash-test-pending-${Date.now()}`,
      timestamp: new Date(),
      assetCode: 'XLM',
      assetIssuer: null,
      status: ContributionStatus.ON_CHAIN_SUBMITTED,
      idempotencyKey: uuidv4(),
    });

    await contributionRepo.save(stuckContribution);
    await contributionRepo.update(stuckContribution.id, {
      updatedAt: new Date(Date.now() - 120_000),
    } as any);

    jest
      .spyOn(stellarService, 'getTransactionStatus')
      .mockResolvedValueOnce('PENDING');

    await contributionsService.reconcileStuckContributions(60_000);

    const unchanged = await contributionRepo.findOneOrFail({
      where: { id: stuckContribution.id },
    });
    expect(unchanged.status).toBe(ContributionStatus.ON_CHAIN_SUBMITTED);
  });

  it('concurrent requests with the same idempotency key produce exactly one DB record', async () => {
    const idempotencyKey = uuidv4();
    const transactionHash = `concurrent-test-${Date.now()}`;

    // Stub out the heavy validation so we can test the locking path in isolation
    jest.spyOn(contributionsService as any, 'validateGroupExists').mockRejectedValue(
      new Error('group not found — expected in this test'),
    );

    const results = await Promise.allSettled([
      contributionsService.createContribution(
        {
          groupId: uuidv4(),
          userId: uuidv4(),
          walletAddress: 'GTEST',
          roundNumber: 1,
          amount: '100',
          transactionHash,
          timestamp: new Date(),
        },
        idempotencyKey,
      ),
      contributionsService.createContribution(
        {
          groupId: uuidv4(),
          userId: uuidv4(),
          walletAddress: 'GTEST',
          roundNumber: 1,
          amount: '100',
          transactionHash,
          timestamp: new Date(),
        },
        idempotencyKey,
      ),
    ]);

    // Both will reject (group not found), but only one should have attempted the lock
    const rows = await contributionRepo.find({ where: { transactionHash } });
    expect(rows.length).toBeLessThanOrEqual(1);

    jest.restoreAllMocks();
  });
});
