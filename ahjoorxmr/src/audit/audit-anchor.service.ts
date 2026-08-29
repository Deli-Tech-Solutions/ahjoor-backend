import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { AuditAnchor } from './entities/audit-anchor.entity';
import * as StellarSdk from '@stellar/stellar-sdk';
import { AuditLog } from './entities/audit-log.entity';
import { CHAIN_PARTITION_GLOBAL } from './audit-chain-hash';

/**
 * Periodic external anchoring of the audit chain head.
 *
 * Strategy:
 *  1. Fetch the current chain head hash from the audit_logs table.
 *  2. If Stellar credentials are configured, submit a `manageData` operation
 *     with key `audit_anchor_<chainId>` and value `<chainHeadHash>` so the
 *     head is anchored immutably on the Stellar ledger.
 *  3. If Stellar is not configured (or submission fails), fall back to the
 *     append-only `audit_anchors` table (write-once store). This provides a
 *     lower-strength anchor but still gives an append-only record that can
 *     be compared by the integrity verification job.
 */
@Injectable()
export class AuditAnchorService {
  private readonly logger = new Logger(AuditAnchorService.name);

  constructor(
    @InjectRepository(AuditAnchor)
    private readonly anchorRepo: Repository<AuditAnchor>,
    @InjectRepository(AuditLog)
    private readonly auditLogRepo: Repository<AuditLog>,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Find the current chain head (most recent row) and anchor its hash.
   *
   * @param chainId       - chain to anchor (defaults to the GLOBAL chain)
   * @param chainPartition- partition key (defaults to 'GLOBAL')
   */
  async anchorCurrentChainHead(
    chainId?: string,
    chainPartition: string = CHAIN_PARTITION_GLOBAL,
  ): Promise<AuditAnchor> {
    const cid = chainId ?? (await this.resolveGlobalChainId());

    // 1. Latest row in the chain
    const head = await this.auditLogRepo
      .createQueryBuilder('al')
      .where('al.chainId = :chainId', { chainId: cid })
      .andWhere('al.chainPartition = :chainPartition', { chainPartition })
      .orderBy('al.timestamp', 'DESC')
      .addOrderBy('al.id', 'DESC')
      .getOne();

    if (!head?.hash) {
      throw new Error(
        `No auditable row found for chain ${cid}/${chainPartition} — cannot anchor`,
      );
    }

    // 2. Try Stellar on-chain anchoring
    let stellarTxHash: string | null = null;
    let anchorType = 'WRITE_ONCE';
    try {
      const keypairSecret = this.configService.get<string>(
        'AUDIT_ANCHOR_STELLAR_SECRET',
      );
      if (keypairSecret) {
        stellarTxHash = await this.anchorOnStellar(cid, head.hash);
        anchorType = 'STELLAR';
        this.logger.log(
          `Anchored audit chain ${cid} head ${head.hash} on Stellar tx ${stellarTxHash}`,
        );
      }
    } catch (err) {
      this.logger.warn(
        `Stellar anchoring failed for chain ${cid}; falling back to write-once: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    // 3. Append-to-write-once record regardless of on-chain success.
    const anchor = this.anchorRepo.create({
      chainId: cid,
      chainPartition,
      chainHeadHash: head.hash,
      anchorType,
      stellarTxHash: stellarTxHash ?? null,
      payload: {
        anchoredHeadId: head.id,
        anchoredAt: new Date().toISOString(),
        rowTimestamp: head.timestamp.toISOString(),
        stellarAnchored: stellarTxHash != null,
      },
    });
    const saved = await this.anchorRepo.save(anchor);

    // Optionally stamp the head row with the anchor reference.
    await this.auditLogRepo
      .createQueryBuilder()
      .update(AuditLog)
      .set({
        anchorReference: stellarTxHash ?? saved.id,
      })
      .where('id = :id', { id: head.id })
      .execute();

    return saved;
  }

  /**
   * Verify the most recent anchor matches the current chain head.
   * Returns true if the stored anchor matches the row's hash (including
   * Stellar verification when an on-chain tx hash is present).
   */
  async verifyLatestAnchor(
    chainId?: string,
    chainPartition: string = CHAIN_PARTITION_GLOBAL,
  ): Promise<{
    ok: boolean;
    expectedHeadHash: string | null;
    anchorChainHeadHash: string | null;
    anchorType: string | null;
    stellarTxHash: string | null;
    message: string;
  }> {
    const cid = chainId ?? (await this.resolveGlobalChainId());

    const head = await this.auditLogRepo
      .createQueryBuilder('al')
      .where('al.chainId = :chainId', { chainId: cid })
      .andWhere('al.chainPartition = :chainPartition', { chainPartition })
      .orderBy('al.timestamp', 'DESC')
      .addOrderBy('al.id', 'DESC')
      .getOne();

    const latestAnchor = await this.anchorRepo
      .createQueryBuilder('anchor')
      .where('anchor.chainId = :chainId', { chainId: cid })
      .andWhere('anchor.chainPartition = :chainPartition', {
        chainPartition,
      })
      .orderBy('anchor.sequence', 'DESC')
      .getOne();

    if (!head?.hash) {
      return {
        ok: false,
        expectedHeadHash: null,
        anchorChainHeadHash: null,
        anchorType: null,
        stellarTxHash: null,
        message: 'No chain head found (chain may be empty or tampered)',
      };
    }

    if (!latestAnchor) {
      return {
        ok: false,
        expectedHeadHash: head.hash,
        anchorChainHeadHash: null,
        anchorType: null,
        stellarTxHash: null,
        message: 'No anchor found for chain — run the anchoring job first',
      };
    }

    const ok = latestAnchor.chainHeadHash === head.hash;

    let stellarMessage = '';
    if (latestAnchor.anchorType === 'STELLAR' && latestAnchor.stellarTxHash) {
      const verified = await this.verifyStellarAnchor(
        latestAnchor.stellarTxHash,
        cid,
        head.hash,
      );
      stellarMessage = verified
        ? ' Stellar anchor verified on-chain.'
        : ' WARNING: Stellar anchor mismatch on-chain!';
      if (!verified) {
        return {
          ok: false,
          expectedHeadHash: head.hash,
          anchorChainHeadHash: latestAnchor.chainHeadHash,
          anchorType: latestAnchor.anchorType,
          stellarTxHash: latestAnchor.stellarTxHash,
          message: `Stellar anchor mismatch${stellarMessage}`,
        };
      }
    }

    return {
      ok,
      expectedHeadHash: head.hash,
      anchorChainHeadHash: latestAnchor.chainHeadHash,
      anchorType: latestAnchor.anchorType,
      stellarTxHash: latestAnchor.stellarTxHash,
      message: ok
        ? `Anchor matches current chain head${stellarMessage}`
        : `Anchor mismatch: stored ${latestAnchor.chainHeadHash} vs current head ${head.hash} — chain may have been tampered after anchoring`,
    };
  }

  /**
   * Resolve the global chainId for the audit_logs table (single chain covering
   * all rows — the default when no partition key is used).
   */
  private async resolveGlobalChainId(): Promise<string> {
    const row = await this.auditLogRepo
      .createQueryBuilder('al')
      .select('al.chainId', 'chainId')
      .where('al.chainPartition = :p', { p: CHAIN_PARTITION_GLOBAL })
      .orderBy('al.timestamp', 'ASC')
      .addOrderBy('al.id', 'ASC')
      .getRawOne();

    if (!row?.chainId) {
      throw new Error('No global audit chain found');
    }
    return row.chainId;
  }

  /**
   * Submit a `manageData` operation to the Stellar network to anchor the
   * chain head hash under the key `audit_anchor_<chainId>`.
   */
  private async anchorOnStellar(
    chainId: string,
    chainHeadHash: string,
  ): Promise<string> {
    const rpcUrl =
      this.configService.get<string>('STELLAR_RPC_URL') ||
      this.configService.get<string>('STELLAR_RPC_URLS')?.split(',')[0];
    if (!rpcUrl) {
      throw new Error('No STELLAR_RPC_URL configured for anchoring');
    }

    const secret = this.configService.get<string>('AUDIT_ANCHOR_STELLAR_SECRET');
    if (!secret) {
      throw new Error('No AUDIT_ANCHOR_STELLAR_SECRET configured');
    }

    const keypair = (StellarSdk as any).Keypair.fromSecret(secret);
    const networkPassphrase =
      this.configService.get<string>('STELLAR_NETWORK_PASSPHRASE') ||
      (this.configService.get<string>('STELLAR_NETWORK', 'testnet') === 'mainnet'
        ? (StellarSdk as any).Networks.PUBLIC
        : (StellarSdk as any).Networks.TESTNET);

    const server = new (StellarSdk as any).Server(
      rpcUrl.startsWith('http') ? rpcUrl : `https://${rpcUrl}`,
      { allowHttp: rpcUrl.startsWith('http://') },
    );

    const account = await server.loadAccount(keypair.publicKey());
    const tx = new (StellarSdk as any).TransactionBuilder(account, {
      fee: '100',
      networkPassphrase,
    })
      .addOperation(
        (StellarSdk as any).Operation.manageData({
          name: `audit_anchor_${chainId.slice(0, 20)}`,
          value: chainHeadHash,
        }),
      )
      .setTimeout(60)
      .build();

    tx.sign(keypair);
    const result = await server.submitTransaction(tx);

    return result?.hash?.toString() ?? result?.id ?? String(result);
  }

  /**
   * Verify a Stellar transaction contains the expected manageData value.
   */
  private async verifyStellarAnchor(
    txHash: string,
    chainId: string,
    expectedHash: string,
  ): Promise<boolean> {
    try {
      const rpcUrl =
        this.configService.get<string>('STELLAR_RPC_URL') ||
        this.configService.get<string>('STELLAR_RPC_URLS')?.split(',')[0];
      if (!rpcUrl) return false;

      const server = new (StellarSdk as any).Server(
        rpcUrl.startsWith('http') ? rpcUrl : `https://${rpcUrl}`,
        { allowHttp: rpcUrl.startsWith('http://') },
      );

      const tx = await server.loadTransaction(txHash);
      if (!tx) return false;

      const envelope = tx.envelopeXdr
        ? (StellarSdk as any).xdr.TransactionEnvelope.fromXDR(
            tx.envelopeXdr,
            'base64',
          )
        : null;

      if (!envelope) return false;

      const txContainer =
        (typeof envelope.v1 === 'function' && envelope.v1()?.tx?.()) ||
        (typeof envelope.tx === 'function' && envelope.tx()) ||
        null;

      const operations = txContainer?.operations?.() ?? [];
      for (const op of operations) {
        const body = op.body?.();
        const manageDataOp = body?.manageDataOp?.();
        if (!manageDataOp) continue;

        const name = manageDataOp.dataName?.()?.toString?.() ?? '';
        const value = manageDataOp.dataValue?.()?.toString?.('hex') ?? '';
        const expectedKey = `audit_anchor_${chainId.slice(0, 20)}`;

        if (name === expectedKey && value === expectedHash) {
          return true;
        }
      }
      return false;
    } catch {
      return false;
    }
  }
}