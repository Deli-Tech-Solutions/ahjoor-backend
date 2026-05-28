import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { PayoutService } from '../payout.service';
import { Group } from '../entities/group.entity';
import { Membership } from '../../memberships/entities/membership.entity';
import { StellarService } from '../../stellar/stellar.service';
import { NotificationsService } from '../../notification/notifications.service';
import { GroupStatus } from '../entities/group-status.enum';
import {
  NotFoundException,
  BadRequestException,
  BadGatewayException,
  ConflictException,
} from '@nestjs/common';
import { PayoutTransaction } from '../entities/payout-transaction.entity';
import { QueueService } from '../../bullmq/queue.service';
import { ConfigService } from '@nestjs/config';
import { PayoutTransactionStatus } from '../entities/payout-transaction-status.enum';
import { Penalty } from '../../penalties/entities/penalty.entity';

describe('PayoutService', () => {
  let service: PayoutService;
  let groupRepo: { findOne: jest.Mock };
  let membershipRepo: { findOne: jest.Mock; save: jest.Mock };
  let payoutTransactionRepo: {
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
  };
  let penaltyRepo: { count: jest.Mock };
  let stellarService: { disbursePayout: jest.Mock };
  let notificationsService: { notify: jest.Mock };
  let queueService: { addPayoutReconciliation: jest.Mock };
  let configService: { get: jest.Mock };

  const GROUP_ID = 'group-uuid';
  const USER_ID = 'user-uuid';
  const CONTRACT_ADDRESS = 'CCONTRACT123';
  const WALLET_ADDRESS = 'GWALLET456';
  const CONTRIBUTION_AMOUNT = '100';

  beforeEach(async () => {
    groupRepo = { findOne: jest.fn() };
    membershipRepo = { findOne: jest.fn(), save: jest.fn() };
    payoutTransactionRepo = {
      findOne: jest.fn(),
      create: jest.fn(),
      save: jest.fn(),
    };
    penaltyRepo = { count: jest.fn().mockResolvedValue(0) };
    stellarService = { disbursePayout: jest.fn() };
    notificationsService = { notify: jest.fn().mockResolvedValue(undefined) };
    queueService = {
      addPayoutReconciliation: jest.fn().mockResolvedValue(undefined),
    };
    configService = { get: jest.fn(() => 'false') };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PayoutService,
        { provide: getRepositoryToken(Group), useValue: groupRepo },
        { provide: getRepositoryToken(Membership), useValue: membershipRepo },
        {
          provide: getRepositoryToken(PayoutTransaction),
          useValue: payoutTransactionRepo,
        },
        { provide: getRepositoryToken(Penalty), useValue: penaltyRepo },
        { provide: StellarService, useValue: stellarService },
        { provide: NotificationsService, useValue: notificationsService },
        { provide: QueueService, useValue: queueService },
        { provide: ConfigService, useValue: configService },
      ],
    }).compile();

    service = module.get(PayoutService);
  });

  it('should successfully distribute payout', async () => {
    const group = {
      id: GROUP_ID,
      status: GroupStatus.ACTIVE,
      contractAddress: CONTRACT_ADDRESS,
      contributionAmount: CONTRIBUTION_AMOUNT,
      name: 'Test Group',
    } as Group;

    const recipient = {
      userId: USER_ID,
      walletAddress: WALLET_ADDRESS,
      payoutOrder: 0,
      hasReceivedPayout: false,
    } as Membership;

    const txHash = 'TX_HASH_123';

    groupRepo.findOne.mockResolvedValue(group);
    membershipRepo.findOne.mockResolvedValue(recipient);
    payoutTransactionRepo.findOne.mockResolvedValue(null);
    payoutTransactionRepo.create.mockReturnValue({
      id: 'ptx-1',
      payoutOrderId: `${GROUP_ID}:1`,
      status: PayoutTransactionStatus.PENDING_SUBMISSION,
      txHash: null,
    });
    payoutTransactionRepo.save
      .mockResolvedValueOnce({
        id: 'ptx-1',
        payoutOrderId: `${GROUP_ID}:1`,
        status: PayoutTransactionStatus.PENDING_SUBMISSION,
        txHash: null,
      })
      // onBeforeSubmit callback save — persists txHash before sendTransaction
      .mockResolvedValueOnce({
        id: 'ptx-1',
        payoutOrderId: `${GROUP_ID}:1`,
        status: PayoutTransactionStatus.PENDING_SUBMISSION,
        txHash,
      })
      .mockResolvedValueOnce({
        id: 'ptx-1',
        payoutOrderId: `${GROUP_ID}:1`,
        status: PayoutTransactionStatus.SUBMITTED,
        txHash,
      });
    stellarService.disbursePayout.mockImplementation(
      async (
        _contract: string,
        _recipient: string,
        _amount: string,
        onBeforeSubmit?: (hash: string) => Promise<void>,
      ) => {
        if (onBeforeSubmit) {
          await onBeforeSubmit(txHash);
        }
        return txHash;
      },
    );
    membershipRepo.save.mockResolvedValue({
      ...recipient,
      hasReceivedPayout: true,
      transactionHash: txHash,
    });

    const result = await service.distributePayout(GROUP_ID, 1);

    expect(result).toBe(txHash);
    expect(stellarService.disbursePayout).toHaveBeenCalledWith(
      CONTRACT_ADDRESS,
      WALLET_ADDRESS,
      CONTRIBUTION_AMOUNT,
      expect.any(Function),
    );
    expect(queueService.addPayoutReconciliation).toHaveBeenCalledWith({
      payoutTransactionId: 'ptx-1',
    });
    expect(membershipRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        hasReceivedPayout: true,
        transactionHash: txHash,
      }),
    );
    expect(notificationsService.notify).toHaveBeenCalled();
  });

  it('should throw NotFoundException if group not found', async () => {
    groupRepo.findOne.mockResolvedValue(null);
    await expect(service.distributePayout(GROUP_ID, 1)).rejects.toThrow(
      NotFoundException,
    );
  });

  it('should throw BadRequestException if group is not ACTIVE', async () => {
    groupRepo.findOne.mockResolvedValue({
      status: GroupStatus.PENDING,
    } as Group);
    await expect(service.distributePayout(GROUP_ID, 1)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('should throw NotFoundException if no recipient found for round', async () => {
    groupRepo.findOne.mockResolvedValue({
      status: GroupStatus.ACTIVE,
      contractAddress: CONTRACT_ADDRESS,
    } as Group);
    membershipRepo.findOne.mockResolvedValue(null);
    await expect(service.distributePayout(GROUP_ID, 1)).rejects.toThrow(
      NotFoundException,
    );
  });

  it('should throw ConflictException if member already received payout', async () => {
    groupRepo.findOne.mockResolvedValue({
      status: GroupStatus.ACTIVE,
      contractAddress: CONTRACT_ADDRESS,
    } as Group);
    membershipRepo.findOne.mockResolvedValue({
      hasReceivedPayout: true,
    } as Membership);
    await expect(service.distributePayout(GROUP_ID, 1)).rejects.toThrow(
      ConflictException,
    );
  });

  it('should throw BadGatewayException if contract invocation fails', async () => {
    groupRepo.findOne.mockResolvedValue({
      status: GroupStatus.ACTIVE,
      contractAddress: CONTRACT_ADDRESS,
      contributionAmount: CONTRIBUTION_AMOUNT,
    } as Group);
    membershipRepo.findOne.mockResolvedValue({
      hasReceivedPayout: false,
      walletAddress: WALLET_ADDRESS,
    } as Membership);
    payoutTransactionRepo.findOne.mockResolvedValue(null);
    payoutTransactionRepo.create.mockReturnValue({
      id: 'ptx-2',
      payoutOrderId: `${GROUP_ID}:1`,
      status: PayoutTransactionStatus.PENDING_SUBMISSION,
      txHash: null,
    });
    payoutTransactionRepo.save.mockResolvedValue({
      id: 'ptx-2',
      payoutOrderId: `${GROUP_ID}:1`,
      status: PayoutTransactionStatus.FAILED,
      txHash: null,
    });
    stellarService.disbursePayout.mockRejectedValue(new Error('Stellar Error'));

    await expect(service.distributePayout(GROUP_ID, 1)).rejects.toThrow(
      BadGatewayException,
    );
  });

  it('should return existing transaction state when payout already exists (idempotent)', async () => {
    groupRepo.findOne.mockResolvedValue({
      status: GroupStatus.ACTIVE,
      contractAddress: CONTRACT_ADDRESS,
      contributionAmount: CONTRIBUTION_AMOUNT,
    } as Group);
    membershipRepo.findOne.mockResolvedValue({
      hasReceivedPayout: false,
      walletAddress: WALLET_ADDRESS,
    } as Membership);
    payoutTransactionRepo.findOne.mockResolvedValue({
      id: 'existing-ptx',
      payoutOrderId: `${GROUP_ID}:1`,
      status: PayoutTransactionStatus.SUBMITTED,
      txHash: 'EXISTING_HASH',
    });

    const result = await service.distributePayout(GROUP_ID, 1);

    expect(result).toBe('EXISTING_HASH');
    expect(stellarService.disbursePayout).not.toHaveBeenCalled();
  });

  it('simulates crash after submitTransaction and before submitted status update', async () => {
    configService.get.mockImplementation((key: string) =>
      key === 'SIMULATE_PAYOUT_CRASH_AFTER_SUBMIT' ? 'true' : 'false',
    );
    groupRepo.findOne.mockResolvedValue({
      status: GroupStatus.ACTIVE,
      contractAddress: CONTRACT_ADDRESS,
      contributionAmount: CONTRIBUTION_AMOUNT,
    } as Group);
    membershipRepo.findOne.mockResolvedValue({
      hasReceivedPayout: false,
      walletAddress: WALLET_ADDRESS,
    } as Membership);
    payoutTransactionRepo.findOne.mockResolvedValue(null);
    payoutTransactionRepo.create.mockReturnValue({
      id: 'ptx-crash',
      payoutOrderId: `${GROUP_ID}:1`,
      status: PayoutTransactionStatus.PENDING_SUBMISSION,
      txHash: null,
    });
    payoutTransactionRepo.save.mockResolvedValue({
      id: 'ptx-crash',
      payoutOrderId: `${GROUP_ID}:1`,
      status: PayoutTransactionStatus.PENDING_SUBMISSION,
      txHash: 'CRASH_HASH',
    });
    stellarService.disbursePayout.mockImplementation(
      async (contract, recipient, amount, onBeforeSubmit) => {
        if (onBeforeSubmit) {
          await onBeforeSubmit('CRASH_HASH');
        }
        return 'CRASH_HASH';
      }
    );

    // Simulate crash where distributePayout throws
    await expect(service.distributePayout(GROUP_ID, 1)).rejects.toThrow();
    expect(membershipRepo.save).not.toHaveBeenCalled();

    // Verify it saved the PENDING_SUBMISSION with correct CRASH_HASH through the intent hook before the simulated crash
    expect(payoutTransactionRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        status: PayoutTransactionStatus.PENDING_SUBMISSION,
        txHash: 'CRASH_HASH',
      }),
    );

    // Now restart the node and verify that pollenUnconfirmedPayouts enqueues it
    payoutTransactionRepo.find = jest.fn().mockResolvedValue([{
      id: 'ptx-crash',
      txHash: 'CRASH_HASH',
      status: PayoutTransactionStatus.PENDING_SUBMISSION
    }]);

    await service.pollUnconfirmedPayouts();

    expect(queueService.addPayoutReconciliation).toHaveBeenCalledWith({
      payoutTransactionId: 'ptx-crash',
    });
  });

  it('should throw BadRequestException and emit notification when recipient has outstanding penalties', async () => {
    groupRepo.findOne.mockResolvedValue({
      id: GROUP_ID,
      status: GroupStatus.ACTIVE,
      contractAddress: CONTRACT_ADDRESS,
      contributionAmount: CONTRIBUTION_AMOUNT,
      name: 'Test Group',
    } as Group);
    membershipRepo.findOne.mockResolvedValue({
      userId: USER_ID,
      walletAddress: WALLET_ADDRESS,
      hasReceivedPayout: false,
    } as Membership);
    penaltyRepo.count.mockResolvedValue(2);

    await expect(service.distributePayout(GROUP_ID, 1)).rejects.toThrow(
      BadRequestException,
    );
    expect(stellarService.disbursePayout).not.toHaveBeenCalled();
    expect(notificationsService.notify).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'payout_blocked_pending_penalty' }),
    );
  });

  it('should proceed with payout when recipient has no outstanding penalties', async () => {
    const txHash = 'TX_CLEAR_123';
    groupRepo.findOne.mockResolvedValue({
      id: GROUP_ID,
      status: GroupStatus.ACTIVE,
      contractAddress: CONTRACT_ADDRESS,
      contributionAmount: CONTRIBUTION_AMOUNT,
      name: 'Test Group',
    } as Group);
    membershipRepo.findOne.mockResolvedValue({
      userId: USER_ID,
      walletAddress: WALLET_ADDRESS,
      hasReceivedPayout: false,
    } as Membership);
    penaltyRepo.count.mockResolvedValue(0);
    payoutTransactionRepo.findOne.mockResolvedValue(null);
    payoutTransactionRepo.create.mockReturnValue({
      id: 'ptx-clear',
      payoutOrderId: `${GROUP_ID}:1`,
      status: PayoutTransactionStatus.PENDING_SUBMISSION,
      txHash: null,
    });
    payoutTransactionRepo.save.mockResolvedValue({
      id: 'ptx-clear',
      status: PayoutTransactionStatus.SUBMITTED,
      txHash,
    });
    stellarService.disbursePayout.mockResolvedValue(txHash);
    membershipRepo.save.mockResolvedValue({});

    const result = await service.distributePayout(GROUP_ID, 1);

    expect(result).toBe(txHash);
    expect(stellarService.disbursePayout).toHaveBeenCalled();
  });
});
