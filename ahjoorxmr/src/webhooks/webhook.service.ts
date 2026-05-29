import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { createHmac, randomBytes } from 'crypto';
import axios from 'axios';
import { Webhook } from './entities/webhook.entity';
import {
  WebhookDelivery,
  WebhookDeliveryStatus,
} from './entities/webhook-delivery.entity';
import {
  WebhookPayload,
  WebhookDeliveryJobData,
  ContributionVerifiedPayload,
} from './interfaces/webhook.interface';
import { Contribution } from '../contributions/entities/contribution.entity';

export enum WebhookEventType {
  ROUND_COMPLETED = 'ROUND_COMPLETED',
  PAYOUT_SENT = 'PAYOUT_SENT',
  CONTRIBUTION_CONFIRMED = 'CONTRIBUTION_CONFIRMED',
  KYC_APPROVED = 'KYC_APPROVED',
  MEMBER_JOINED = 'MEMBER_JOINED',
  BALANCE_ALERT_LOW = 'BALANCE_ALERT_LOW',
  BALANCE_ALERT_RECOVERED = 'BALANCE_ALERT_RECOVERED',
  DAILY_FEE_EXCEEDED = 'DAILY_FEE_EXCEEDED',
  GROUP_COMPLETED = 'GROUP_COMPLETED',
  GROUP_ACTIVATED = 'GROUP_ACTIVATED',
  GROUP_ARCHIVED = 'GROUP_ARCHIVED',
}

@Injectable()
export class WebhookService {
  private readonly logger = new Logger(WebhookService.name);

  constructor(
    @InjectRepository(Webhook)
    private readonly webhookRepository: Repository<Webhook>,
    @InjectRepository(WebhookDelivery)
    private readonly deliveryRepository: Repository<WebhookDelivery>,
    @InjectQueue('webhook-delivery-queue')
    private readonly webhookQueue: Queue,
  ) {}

  /** HMAC-SHA256 signature used in X-Ahjoor-Signature header */
  generateSignature(payload: string, secret: string): string {
    return `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`;
  }

  async notifyContributionVerified(contribution: Contribution): Promise<void> {
    await this.dispatchEvent(WebhookEventType.CONTRIBUTION_CONFIRMED, {
      contributionId: contribution.id,
      groupId: contribution.groupId,
      userId: contribution.userId,
      walletAddress: contribution.walletAddress,
      amount: contribution.amount,
      roundNumber: contribution.roundNumber,
      transactionHash: contribution.transactionHash,
      timestamp: contribution.timestamp,
    } as ContributionVerifiedPayload);
  }

  async dispatchEvent(event: WebhookEventType, data: unknown): Promise<void> {
    const webhooks = await this.webhookRepository.find({
      where: { isActive: true },
    });

    const relevant = webhooks.filter((w) => w.eventTypes.includes(event));
    if (!relevant.length) return;

    const payload: WebhookPayload = {
      event,
      timestamp: new Date().toISOString(),
      data,
    };

    for (const webhook of relevant) {
      const jobData: WebhookDeliveryJobData = {
        webhookId: webhook.id,
        url: webhook.url,
        secret: webhook.secret,
        payload,
        attempt: 1,
      };

      await this.webhookQueue.add('deliver-webhook', jobData, {
        attempts: 5,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: { count: 1000, age: 24 * 60 * 60 },
        removeOnFail: false,
      });
    }
  }

  async deliverWebhook(
    url: string,
    secret: string,
    payload: WebhookPayload,
    webhookId: string,
    attemptNumber = 1,
  ): Promise<{
    statusCode: number;
    responseBody: string;
    deliveryTime: number;
  }> {
    const start = Date.now();
    const payloadString = JSON.stringify(payload);
    const signature = this.generateSignature(payloadString, secret);

    let delivery = this.deliveryRepository.create({
      webhookId,
      status: WebhookDeliveryStatus.PENDING,
      payload: payloadString,
      attemptNumber,
      responseCode: null,
      responseBody: null,
    });
    delivery = await this.deliveryRepository.save(delivery);

    try {
      const response = await axios.post(url, payload, {
        headers: {
          'Content-Type': 'application/json',
          'X-Ahjoor-Signature': signature,
          'User-Agent': 'Ahjoorxmr-Webhook/1.0',
        },
        timeout: 10_000,
        validateStatus: () => true,
      });

      const deliveryTime = Date.now() - start;
      const responseBody = JSON.stringify(response.data).slice(0, 1024);

      delivery.status =
        response.status < 300
          ? WebhookDeliveryStatus.SUCCESS
          : WebhookDeliveryStatus.FAILED;
      delivery.responseCode = response.status;
      delivery.responseBody = responseBody;
      await this.deliveryRepository.save(delivery);

      if (response.status >= 500) {
        throw new Error(`Endpoint returned ${response.status}`);
      }

      return { statusCode: response.status, responseBody, deliveryTime };
    } catch (error) {
      delivery.status = WebhookDeliveryStatus.FAILED;
      delivery.responseBody = (error as Error).message.slice(0, 1024);
      await this.deliveryRepository.save(delivery);
      throw error;
    }
  }

  async testWebhook(
    webhookId: string,
    ownerId?: string,
  ): Promise<{
    statusCode: number;
    responseBody: string;
    deliveryTime: number;
  }> {
    const webhook = await this.webhookRepository.findOne({
      where: { id: webhookId },
    });
    if (!webhook) throw new NotFoundException('Webhook not found');
    if (ownerId && webhook.userId !== ownerId) throw new ForbiddenException();

    const testPayload: WebhookPayload = {
      event: 'TEST',
      timestamp: new Date().toISOString(),
      data: { message: 'This is a test event', webhookId },
    };

    return this.deliverWebhook(
      webhook.url,
      webhook.secret,
      testPayload,
      webhookId,
    );
  }

  async replayDelivery(deliveryId: string, ownerId?: string): Promise<void> {
    const delivery = await this.deliveryRepository.findOne({
      where: { id: deliveryId },
      relations: ['webhook'],
    });
    if (!delivery) throw new NotFoundException('Delivery not found');
    if (ownerId && delivery.webhook.userId !== ownerId)
      throw new ForbiddenException();

    const jobData: WebhookDeliveryJobData = {
      webhookId: delivery.webhookId,
      url: delivery.webhook.url,
      secret: delivery.webhook.secret,
      payload: JSON.parse(delivery.payload),
      attempt: 1,
    };

    await this.webhookQueue.add('deliver-webhook', jobData, {
      attempts: 5,
      backoff: { type: 'exponential', delay: 5000 },
    });
  }

  async getDeliveries(
    webhookId: string,
    ownerId?: string,
  ): Promise<WebhookDelivery[]> {
    const webhook = await this.webhookRepository.findOne({
      where: { id: webhookId },
    });
    if (!webhook) throw new NotFoundException('Webhook not found');
    if (ownerId && webhook.userId !== ownerId) throw new ForbiddenException();

    return this.deliveryRepository.find({
      where: { webhookId },
      order: { attemptedAt: 'DESC' },
      take: 50,
    });
  }

  async createWebhook(
    userId: string,
    url: string,
    eventTypes: string[],
  ): Promise<Webhook> {
    const secret = randomBytes(32).toString('hex');
    const webhook = this.webhookRepository.create({
      userId,
      url,
      secret,
      eventTypes,
      isActive: true,
    });
    return this.webhookRepository.save(webhook);
  }

  async getUserWebhooks(userId: string): Promise<Webhook[]> {
    return this.webhookRepository.find({
      where: { userId },
      order: { createdAt: 'DESC' },
    });
  }

  async getAllWebhooks(): Promise<Webhook[]> {
    return this.webhookRepository.find({ order: { createdAt: 'DESC' } });
  }

  async deleteWebhook(webhookId: string, userId: string): Promise<void> {
    const result = await this.webhookRepository.delete({
      id: webhookId,
      userId,
    });
    if (result.affected === 0)
      throw new NotFoundException('Webhook not found or unauthorized');
  }
}
