import { createHmac } from 'crypto';
import { WebhookService } from './webhook.service';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Test, TestingModule } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { Webhook } from './entities/webhook.entity';
import { WebhookDelivery, WebhookDeliveryStatus } from './entities/webhook-delivery.entity';

const mockWebhookRepo = () => ({
  find: jest.fn(),
  findOne: jest.fn(),
  create: jest.fn(),
  save: jest.fn(),
  delete: jest.fn(),
});

const mockDeliveryRepo = () => ({
  find: jest.fn(),
  findOne: jest.fn(),
  create: jest.fn(),
  save: jest.fn(),
});

const mockQueue = () => ({ add: jest.fn() });

describe('WebhookService – HMAC signing', () => {
  let service: WebhookService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WebhookService,
        { provide: getRepositoryToken(Webhook), useFactory: mockWebhookRepo },
        { provide: getRepositoryToken(WebhookDelivery), useFactory: mockDeliveryRepo },
        { provide: getQueueToken('webhook-delivery-queue'), useFactory: mockQueue },
      ],
    }).compile();

    service = module.get(WebhookService);
  });

  it('generates correct HMAC-SHA256 signature', () => {
    const secret = 'test-secret';
    const payload = '{"event":"TEST"}';
    const expected = `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`;
    expect(service.generateSignature(payload, secret)).toBe(expected);
  });

  it('produces different signatures for different secrets', () => {
    const payload = '{"event":"TEST"}';
    const sig1 = service.generateSignature(payload, 'secret1');
    const sig2 = service.generateSignature(payload, 'secret2');
    expect(sig1).not.toBe(sig2);
  });

  it('produces different signatures for different payloads', () => {
    const secret = 'same-secret';
    const sig1 = service.generateSignature('{"event":"A"}', secret);
    const sig2 = service.generateSignature('{"event":"B"}', secret);
    expect(sig1).not.toBe(sig2);
  });
});

describe('WebhookService – delivery recording', () => {
  let service: WebhookService;
  let deliveryRepo: ReturnType<typeof mockDeliveryRepo>;
  let webhookRepo: ReturnType<typeof mockWebhookRepo>;
  let queue: ReturnType<typeof mockQueue>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WebhookService,
        { provide: getRepositoryToken(Webhook), useFactory: mockWebhookRepo },
        { provide: getRepositoryToken(WebhookDelivery), useFactory: mockDeliveryRepo },
        { provide: getQueueToken('webhook-delivery-queue'), useFactory: mockQueue },
      ],
    }).compile();

    service = module.get(WebhookService);
    deliveryRepo = module.get(getRepositoryToken(WebhookDelivery));
    webhookRepo = module.get(getRepositoryToken(Webhook));
    queue = module.get(getQueueToken('webhook-delivery-queue'));
  });

  it('enqueues with 5 attempts on dispatchEvent', async () => {
    webhookRepo.find.mockResolvedValue([
      { id: 'wh-1', url: 'https://example.com', secret: 'sec', eventTypes: ['CONTRIBUTION_CONFIRMED'], isActive: true },
    ]);
    queue.add.mockResolvedValue({});

    await service.dispatchEvent('CONTRIBUTION_CONFIRMED' as any, {});

    expect(queue.add).toHaveBeenCalledWith(
      'deliver-webhook',
      expect.objectContaining({ payload: expect.objectContaining({ event_id: expect.any(String) }) }),
      expect.objectContaining({ attempts: 5 }),
    );
  });

  it('uses the same event id when the same logical event is dispatched again', async () => {
    webhookRepo.find.mockResolvedValue([
      { id: 'wh-1', url: 'https://example.com', secret: 'sec', eventTypes: ['CONTRIBUTION_CONFIRMED'], isActive: true },
    ]);
    queue.add.mockResolvedValue({});

    await service.dispatchEvent('CONTRIBUTION_CONFIRMED' as any, { contributionId: 'c-1' });
    await service.dispatchEvent('CONTRIBUTION_CONFIRMED' as any, { contributionId: 'c-1' });

    const firstJob = queue.add.mock.calls[0][1] as any;
    const secondJob = queue.add.mock.calls[1][1] as any;
    expect(firstJob.payload.event_id).toBe(secondJob.payload.event_id);
  });

  it('skips a duplicate event after a successful delivery', async () => {
    const payload = {
      event: 'CONTRIBUTION_CONFIRMED',
      event_id: 'event-1',
      timestamp: '2026-08-25T00:00:00.000Z',
      data: { contributionId: 'c-1' },
    };
    deliveryRepo.findOne.mockResolvedValue({
      eventId: 'event-1',
      status: WebhookDeliveryStatus.SUCCESS,
      responseCode: 200,
      responseBody: '{"received":true}',
    } as WebhookDelivery);

    const result = await service.deliverWebhook('https://example.com', 'sec', payload, 'wh-1');

    expect(result).toMatchObject({ statusCode: 200, deliveryTime: 0 });
    expect(deliveryRepo.save).not.toHaveBeenCalled();
  });

  it('getDeliveries returns last 50 for owner', async () => {
    webhookRepo.findOne.mockResolvedValue({ id: 'wh-1', userId: 'user-1' });
    deliveryRepo.find.mockResolvedValue([{ id: 'd-1' }]);

    const result = await service.getDeliveries('wh-1', 'user-1');
    expect(deliveryRepo.find).toHaveBeenCalledWith(
      expect.objectContaining({ take: 50 }),
    );
    expect(result).toHaveLength(1);
  });

  it('replayDelivery enqueues the original payload', async () => {
    const payload = { event: 'TEST', timestamp: '2024-01-01', data: {} };
    deliveryRepo.findOne.mockResolvedValue({
      id: 'd-1',
      webhookId: 'wh-1',
      payload: JSON.stringify(payload),
      webhook: { id: 'wh-1', userId: 'user-1', url: 'https://example.com', secret: 'sec' },
    });
    queue.add.mockResolvedValue({});

    await service.replayDelivery('d-1', 'user-1');
    expect(queue.add).toHaveBeenCalledWith(
      'deliver-webhook',
      expect.objectContaining({ payload }),
      expect.any(Object),
    );
  });
});
