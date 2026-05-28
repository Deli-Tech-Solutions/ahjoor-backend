import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RoundService } from '../round.service';
import { Group } from '../entities/group.entity';
import { GroupStatus } from '../entities/group-status.enum';
import { Membership } from '../../memberships/entities/membership.entity';
import { MembershipStatus } from '../../memberships/entities/membership-status.enum';
import { NotificationsService } from '../../notification/notifications.service';
import { PayoutService } from '../payout.service';
import { WebhookService, WebhookEventType } from '../../webhooks/webhook.service';

describe('RoundService - Webhook Events', () => {
  let service: RoundService;
  let groupRepo: jest.Mocked<Repository<Group>>;
  let membershipRepo: jest.Mocked<Repository<Membership>>;
  let webhookService: jest.Mocked<WebhookService>;

  const mockGroup = (overrides: Partial<Group> = {}): Group => ({
    id: 'group-1',
    name: 'Test Group',
    status: GroupStatus.ACTIVE,
    currentRound: 5,
    totalRounds: 5,
    minMembers: 3,
    maxMembers: 5,
    contributionAmount: '100',
    adminWallet: 'admin-wallet',
    contractAddress: null,
    assetCode: 'XLM',
    assetIssuer: null,
    payoutOrderStrategy: 'fixed_order',
    staleAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    ...overrides,
  });

  const mockMembership = (overrides: Partial<Membership> = {}): Membership => ({
    id: 'membership-1',
    userId: 'user-1',
    groupId: 'group-1',
    group: mockGroup(),
    status: MembershipStatus.ACTIVE,
    payoutOrder: 0,
    hasPaidCurrentRound: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  });

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RoundService,
        {
          provide: getRepositoryToken(Group),
          useValue: {
            findOne: jest.fn(),
            save: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(Membership),
          useValue: {
            find: jest.fn(),
            update: jest.fn(),
          },
        },
        {
          provide: NotificationsService,
          useValue: {
            notifyBatch: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: PayoutService,
          useValue: {
            distributePayout: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: WebhookService,
          useValue: {
            dispatchEvent: jest.fn().mockResolvedValue(undefined),
          },
        },
      ],
    }).compile();

    service = module.get<RoundService>(RoundService);
    groupRepo = module.get(getRepositoryToken(Group));
    membershipRepo = module.get(getRepositoryToken(Membership));
    webhookService = module.get(WebhookService);
  });

  describe('tryAdvanceRound', () => {
    it('should dispatch GROUP_COMPLETED webhook when group transitions to COMPLETED', async () => {
      const group = mockGroup({ currentRound: 5, totalRounds: 5 });
      const memberships = [
        mockMembership({ hasPaidCurrentRound: true }),
        mockMembership({ id: 'membership-2', userId: 'user-2', hasPaidCurrentRound: true }),
        mockMembership({ id: 'membership-3', userId: 'user-3', hasPaidCurrentRound: true }),
      ];

      groupRepo.findOne.mockResolvedValue(group);
      membershipRepo.find.mockResolvedValue(memberships);
      groupRepo.save.mockResolvedValue({ ...group, status: GroupStatus.COMPLETED });

      const result = await service.tryAdvanceRound('group-1');

      expect(result).toBe(true);
      expect(webhookService.dispatchEvent).toHaveBeenCalledWith(
        WebhookEventType.GROUP_COMPLETED,
        expect.objectContaining({
          groupId: 'group-1',
          totalRounds: 5,
          completedAt: expect.any(String),
        }),
      );
    });

    it('should not dispatch GROUP_COMPLETED webhook when group advances to next round', async () => {
      const group = mockGroup({ currentRound: 2, totalRounds: 5 });
      const memberships = [
        mockMembership({ hasPaidCurrentRound: true }),
        mockMembership({ id: 'membership-2', userId: 'user-2', hasPaidCurrentRound: true }),
      ];

      groupRepo.findOne.mockResolvedValue(group);
      membershipRepo.find.mockResolvedValue(memberships);
      groupRepo.save.mockResolvedValue({ ...group, currentRound: 3 });

      const result = await service.tryAdvanceRound('group-1');

      expect(result).toBe(true);
      expect(webhookService.dispatchEvent).not.toHaveBeenCalledWith(
        WebhookEventType.GROUP_COMPLETED,
        expect.anything(),
      );
    });

    it('should not dispatch webhook when not all members have paid', async () => {
      const group = mockGroup({ currentRound: 5, totalRounds: 5 });
      const memberships = [
        mockMembership({ hasPaidCurrentRound: true }),
        mockMembership({ id: 'membership-2', userId: 'user-2', hasPaidCurrentRound: false }),
      ];

      groupRepo.findOne.mockResolvedValue(group);
      membershipRepo.find.mockResolvedValue(memberships);

      const result = await service.tryAdvanceRound('group-1');

      expect(result).toBe(false);
      expect(webhookService.dispatchEvent).not.toHaveBeenCalled();
    });

    it('should handle webhook dispatch failure gracefully', async () => {
      const group = mockGroup({ currentRound: 5, totalRounds: 5 });
      const memberships = [mockMembership({ hasPaidCurrentRound: true })];

      groupRepo.findOne.mockResolvedValue(group);
      membershipRepo.find.mockResolvedValue(memberships);
      groupRepo.save.mockResolvedValue({ ...group, status: GroupStatus.COMPLETED });
      webhookService.dispatchEvent.mockRejectedValue(new Error('Webhook dispatch failed'));

      // Should not throw even though webhook dispatch fails
      const result = await service.tryAdvanceRound('group-1');

      expect(result).toBe(true);
      expect(webhookService.dispatchEvent).toHaveBeenCalled();
    });
  });
});
