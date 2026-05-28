import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan } from 'typeorm';
import { MailerService } from '@nestjs-modules/mailer';
import { Notification } from './notification.entity';
import { NotificationType } from './notification-type.enum';
import {
  PaginateNotificationsDto,
  NotifyDto,
  CreateNotificationDto,
} from './notifications.dto';
import { UseReadReplica } from '../common/decorators/read-replica.decorator';
import { RedisService } from '../common/redis/redis.service';
import { NotificationsGateway } from './notifications.gateway';
import { NotificationPreferenceService } from './notification-preference.service';
import { QueueService } from '../bullmq/queue.service';

export interface PaginatedResult<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

const EMAIL_TEMPLATE_MAP: Partial<Record<NotificationType, string>> = {
  [NotificationType.ROUND_OPENED]: 'round-opened',
  [NotificationType.CONTRIBUTION_REMINDER]: 'contribution-reminder',
  [NotificationType.PAYOUT_RECEIVED]: 'payout-received',
};

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    @InjectRepository(Notification)
    private readonly notificationRepo: Repository<Notification>,
    private readonly mailerService: MailerService,
    private readonly redisService: RedisService,
    @Inject(forwardRef(() => NotificationsGateway))
    private readonly gateway: NotificationsGateway,
    private readonly prefService: NotificationPreferenceService,
    private readonly queueService: QueueService,
  ) {}

  /**
   * Core notify method: creates a DB record and optionally queues an email.
   * Email sending is always asynchronous — it never blocks the caller.
   */
  async notify(dto: NotifyDto): Promise<Notification | null> {
    const prefs = await this.prefService.getChannelPreference(dto.userId, dto.type);

    if (!prefs.inApp) {
      this.logger.debug(`Skipping in-app notification for user ${dto.userId} [${dto.type}]: disabled`);
      // Still send email if enabled and requested
      if (prefs.email && dto.sendEmail && dto.emailTo) {
        setImmediate(() =>
          this.sendEmail(dto).catch((err) =>
            this.logger.error(`Failed to send email [${dto.type}]: ${err.message}`, err.stack),
          ),
        );
      }
      return null;
    }

    const notification = this.notificationRepo.create({
      userId: dto.userId,
      type: dto.type,
      title: dto.title,
      body: dto.body,
      metadata: dto.metadata ?? {},
      idempotencyKey: dto.idempotencyKey ?? null,
    });

    const saved = await this.notificationRepo.save(notification);

    // Publish to Redis for SSE consumers
    this.redisService
      .getClient()
      .publish(`notifications:${dto.userId}`, JSON.stringify(saved))
      .catch((err) => this.logger.error(`Redis publish failed: ${err.message}`));

    // Push via WebSocket immediately after persisting
    this.gateway.emitNotification(dto.userId, saved);

    if (prefs.email && dto.sendEmail && dto.emailTo) {
      setImmediate(() =>
        this.sendEmail(dto).catch((err) => {
          this.logger.error(
            `Failed to send email for notification ${saved.id}: ${err.message}`,
            err.stack,
          );
        }),
      );
    }

    return saved;
  }

  /**
   * Batch insert notifications with idempotency.
   * Duplicate idempotency keys within 24h are silently dropped.
   */
  async notifyBatch(
    notifications: CreateNotificationDto[],
  ): Promise<Notification[]> {
    if (notifications.length === 0) {
      return [];
    }

    const uniqueNotifications = this.deduplicateByKey(notifications);
    const existingKeys = await this.getExistingKeys(
      uniqueNotifications
        .map((n) => n.idempotencyKey)
        .filter(Boolean) as string[],
    );

    const toInsert = uniqueNotifications.filter(
      (n) => !n.idempotencyKey || !existingKeys.has(n.idempotencyKey),
    );

    if (toInsert.length === 0) {
      this.logger.debug('All notifications were duplicates, skipping insert');
      return [];
    }

    // Filter out notifications where the user has disabled in-app channel
    const prefChecked = await Promise.all(
      toInsert.map(async (dto) => {
        const prefs = await this.prefService.getChannelPreference(dto.userId, dto.type);
        return prefs.inApp ? dto : null;
      }),
    );
    const allowed = prefChecked.filter((d): d is CreateNotificationDto => d !== null);

    if (allowed.length === 0) {
      this.logger.debug('All batch notifications skipped due to user preferences');
      return [];
    }

    const entities = allowed.map((dto) =>
      this.notificationRepo.create({
        userId: dto.userId,
        type: dto.type,
        title: dto.title,
        body: dto.body,
        metadata: dto.metadata ?? {},
        idempotencyKey: dto.idempotencyKey ?? null,
      }),
    );

    try {
      const saved = await this.notificationRepo.save(entities);
      this.logger.log(`Batch inserted ${saved.length} notifications`);
      return saved;
    } catch (error) {
      this.logger.error(`Batch insert failed: ${error.message}`, error.stack);
      throw error;
    }
  }

  @UseReadReplica()
  async findAll(
    userId: string,
    query: PaginateNotificationsDto,
    cursor?: string,
  ): Promise<PaginatedResult<Notification>> {
    const { page = 1, limit = 20, type } = query;

    const where: Record<string, any> = { userId };
    if (type) where.type = type;

    // Cursor-based pagination: cursor is the createdAt ISO string of the last seen item
    if (cursor) {
      where.createdAt = LessThan(new Date(cursor));
      const data = await this.notificationRepo.find({
        where,
        order: { createdAt: 'DESC' },
        take: limit,
      });
      return { data, total: data.length, page: 1, limit, totalPages: 1 };
    }

    const skip = (page - 1) * limit;
    const [data, total] = await this.notificationRepo.findAndCount({
      where,
      order: { createdAt: 'DESC' },
      skip,
      take: limit,
    });

    return {
      data,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async markAsRead(id: string, userId: string): Promise<Notification> {
    const notification = await this.notificationRepo.findOne({ where: { id } });

    if (!notification) {
      throw new NotFoundException(`Notification ${id} not found`);
    }

    if (notification.userId !== userId) {
      throw new ForbiddenException('Cannot access this notification');
    }

    notification.isRead = true;
    return this.notificationRepo.save(notification);
  }

  async markAllAsRead(userId: string): Promise<{ updated: number }> {
    const result = await this.notificationRepo
      .createQueryBuilder()
      .update(Notification)
      .set({ isRead: true })
      .where('userId = :userId AND isRead = false', { userId })
      .execute();

    return { updated: result.affected ?? 0 };
  }

  async getUnreadCount(userId: string): Promise<number> {
    return this.notificationRepo.count({
      where: { userId, isRead: false },
    });
  }

  // ─── Private Helpers ──────────────────────────────────────────────────────

  private deduplicateByKey(
    notifications: CreateNotificationDto[],
  ): CreateNotificationDto[] {
    const seen = new Set<string>();
    return notifications.filter((n) => {
      if (!n.idempotencyKey) return true;
      if (seen.has(n.idempotencyKey)) return false;
      seen.add(n.idempotencyKey);
      return true;
    });
  }

  private async getExistingKeys(keys: string[]): Promise<Set<string>> {
    if (keys.length === 0) return new Set();

    const cutoff = new Date();
    cutoff.setHours(cutoff.getHours() - 24);

    const existing = await this.notificationRepo
      .createQueryBuilder('n')
      .select('n.idempotencyKey')
      .where('n.idempotencyKey IN (:...keys)', { keys })
      .andWhere('n.createdAt > :cutoff', { cutoff })
      .getRawMany();

    return new Set(existing.map((row) => row.n_idempotencyKey));
  }

  private async sendEmail(dto: NotifyDto): Promise<void> {
    const template = EMAIL_TEMPLATE_MAP[dto.type];

    if (!template) {
      this.logger.debug(`No email template for type ${dto.type}, skipping.`);
      return;
    }

    await this.mailerService.sendMail({
      to: dto.emailTo,
      subject: dto.title,
      template,
      context: {
        title: dto.title,
        body: dto.body,
        ...(dto.emailTemplateData ?? {}),
      },
    });

    this.logger.log(`Email sent to ${dto.emailTo} [${dto.type}]`);
  }
}
