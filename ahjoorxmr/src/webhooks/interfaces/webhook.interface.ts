export interface WebhookPayload {
  event: string;
  timestamp: string;
  data: any;
}

export interface ContributionVerifiedPayload {
  contributionId: string;
  groupId: string;
  userId: string;
  walletAddress: string;
  amount: string;
  roundNumber: number;
  transactionHash: string;
  timestamp: Date;
}

export interface WebhookDeliveryJobData {
  webhookId: string;
  url: string;
  secret: string;
  payload: WebhookPayload;
  attempt: number;
}

export interface GroupCompletedPayload {
  groupId: string;
  totalRounds: number;
  completedAt: string;
}

export interface GroupActivatedPayload {
  groupId: string;
  activatedAt: string;
  totalRounds: number;
  memberCount: number;
}

export interface GroupArchivedPayload {
  groupId: string;
  archivedAt: string;
}
