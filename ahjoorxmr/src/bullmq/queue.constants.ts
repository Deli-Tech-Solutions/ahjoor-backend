export const QUEUE_NAMES = {
  EMAIL: 'email-queue',
  EVENT_SYNC: 'event-sync-queue',
  GROUP_SYNC: 'group-sync-queue',
  PAYOUT_RECONCILIATION: 'payout-reconciliation-queue',
  WEBHOOK_DELIVERY: 'webhook-delivery-queue',
  DEAD_LETTER: 'dead-letter-queue',
  TX_CONFIRMATION: 'tx-confirmation-queue',
  PUSH_NOTIFICATION: 'push-notification-queue',
  TRUST_SCORE: 'trust-score-queue',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

export const JOB_NAMES = {
  // Email jobs
  SEND_EMAIL: 'send-email',
  SEND_NOTIFICATION_EMAIL: 'send-notification-email',
  SEND_WELCOME_EMAIL: 'send-welcome-email',

  // Event sync jobs
  SYNC_ON_CHAIN_EVENT: 'sync-on-chain-event',
  PROCESS_TRANSFER_EVENT: 'process-transfer-event',
  PROCESS_APPROVAL_EVENT: 'process-approval-event',

  // Group sync jobs
  SYNC_GROUP_STATE: 'sync-group-state',
  SYNC_ALL_GROUPS: 'sync-all-groups',

  // Payout reconciliation jobs
  RECONCILE_PAYOUT: 'reconcile-payout',

  // Webhook delivery jobs
  DELIVER_WEBHOOK: 'deliver-webhook',

  // Transaction confirmation
  CONFIRM_TRANSACTION: 'confirm-transaction',

  // Push notification jobs
  SEND_PUSH: 'send-push',

  // Dead-letter
  DEAD_LETTER: 'dead-letter',

  // Trust score jobs
  RECALCULATE_TRUST_SCORES: 'recalculate-trust-scores',
} as const;

export const RETRY_CONFIG = {
  attempts: 3,
  backoff: {
    type: 'custom' as const,
  },
} as const;

// Exponential backoff delays in ms: 1s, 5s, 30s
export const BACKOFF_DELAYS = [1_000, 5_000, 30_000];
