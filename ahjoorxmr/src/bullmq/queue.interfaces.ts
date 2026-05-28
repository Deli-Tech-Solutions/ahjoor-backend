// ---------------------------------------------------------------------------
// Email Queue Job Data
// ---------------------------------------------------------------------------
export interface SendEmailJobData {
  to: string | string[];
  subject: string;
  template?: string;
  html?: string;
  text?: string;
  context?: Record<string, unknown>;
  from?: string;
  replyTo?: string;
}

export interface SendNotificationEmailJobData extends SendEmailJobData {
  userId: string;
  notificationType: string;
  body: string;
  actionLink?: string;
}

export interface SendWelcomeEmailJobData {
  userId: string;
  email: string;
  username: string;
}

// ---------------------------------------------------------------------------
// Event Sync Queue Job Data
// ---------------------------------------------------------------------------
export interface SyncOnChainEventJobData {
  eventName: string;
  transactionHash: string;
  blockNumber: number;
  contractAddress: string;
  logIndex: number;
  rawData: Record<string, unknown>;
  chainId: number;
}

export interface ProcessTransferEventJobData {
  from: string;
  to: string;
  amount: string;
  transactionHash: string;
  blockNumber: number;
  tokenAddress: string;
  chainId: number;
}

export interface ProcessApprovalEventJobData {
  owner: string;
  spender: string;
  amount: string;
  transactionHash: string;
  blockNumber: number;
  tokenAddress: string;
  chainId: number;
}

// ---------------------------------------------------------------------------
// Group Sync Queue Job Data
// ---------------------------------------------------------------------------
export interface SyncGroupStateJobData {
  groupId: string;
  contractAddress: string;
  chainId: number;
  forceSync?: boolean;
}

export interface SyncAllGroupsJobData {
  chainId: number;
  batchSize?: number;
}

export interface ReconcilePayoutJobData {
  payoutTransactionId: string;
}

// ---------------------------------------------------------------------------
// Push Notification Queue Job Data
// ---------------------------------------------------------------------------
export interface SendPushNotificationJobData {
  userId: string;
  title: string;
  body: string;
  data?: Record<string, string>;
  notificationType: string;
}

// ---------------------------------------------------------------------------
// Dead-letter Queue Job Data
// ---------------------------------------------------------------------------
export interface DeadLetterJobData {
  originalQueue: string;
  originalJobId: string | undefined;
  originalJobName: string;
  originalJobData: unknown;
  failedReason: string;
  failedAt: string;
  attemptsMade: number;
  stackTrace?: string;
}

// ---------------------------------------------------------------------------
// Trust Score Queue Job Data
// ---------------------------------------------------------------------------
export interface RecalculateTrustScoresJobData {
  /** Optional subset of user IDs to recalculate. If omitted, all users are processed. */
  userIds?: string[];
  /** ISO timestamp when the job was enqueued (for audit/logging). */
  enqueuedAt: string;
}
