import {
  Injectable,
  BadRequestException,
  NotFoundException,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
  UnprocessableEntityException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import * as path from 'path';
import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { KycDocument } from './entities/kyc-document.entity';
import { KycStatus } from './entities/kyc-status.enum';
import { User } from '../users/entities/user.entity';
import { NotificationsService } from '../notification/notifications.service';
import { NotificationType } from '../notification/notification-type.enum';
import { WinstonLogger } from '../common/logger/winston.logger';
import { scrubForLog } from '../common/pii/pii-scrubber';
import { KycProviderOrchestrator } from './providers/kyc-provider-orchestrator.service';

const KYC_ALLOWED_MIME = ['image/jpeg', 'image/png', 'application/pdf'];

/** Magic-byte signatures for allowed MIME types. */
const MAGIC_BYTES: Array<{ mime: string; bytes: number[]; offset?: number }> = [
  { mime: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
  { mime: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mime: 'application/pdf', bytes: [0x25, 0x50, 0x44, 0x46] }, // %PDF
];

function detectMimeFromBuffer(buffer: Buffer): string | null {
  for (const sig of MAGIC_BYTES) {
    const offset = sig.offset ?? 0;
    const slice = buffer.slice(offset, offset + sig.bytes.length);
    if (sig.bytes.every((b, i) => slice[i] === b)) {
      return sig.mime;
    }
  }
  return null;
}

@Injectable()
export class KycService {
  private readonly logger = new Logger(KycService.name);
  private readonly s3Client: S3Client | null;
  private readonly bucket: string | null;
  private readonly useS3: boolean;
  private readonly uploadDir: string;
  private readonly baseUrl: string;
  private readonly maxFileSizeBytes: number;
  private readonly clamavHost: string | null;
  private readonly clamavPort: number;

  constructor(
    @InjectRepository(KycDocument)
    private readonly kycDocumentRepository: Repository<KycDocument>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    private readonly notificationsService: NotificationsService,
    private readonly configService: ConfigService,
    private readonly winstonLogger: WinstonLogger,
    private readonly providerOrchestrator: KycProviderOrchestrator,
  ) {
    this.bucket = this.configService.get<string>('AWS_S3_BUCKET') ?? null;
    this.useS3 = !!this.bucket;
    this.uploadDir = this.configService.get<string>('LOCAL_STORAGE_PATH', './uploads');
    this.baseUrl = this.configService.get<string>('BASE_URL', 'http://localhost:3000');

    const maxMb = this.configService.get<number>('KYC_MAX_FILE_SIZE_MB', 10);
    this.maxFileSizeBytes = maxMb * 1024 * 1024;

    this.clamavHost = this.configService.get<string>('CLAMAV_HOST') ?? null;
    this.clamavPort = this.configService.get<number>('CLAMAV_PORT', 3310);

    if (this.useS3) {
      this.s3Client = new S3Client({
        region: this.configService.get<string>('AWS_REGION'),
        credentials: {
          accessKeyId: this.configService.get<string>('AWS_ACCESS_KEY_ID'),
          secretAccessKey: this.configService.get<string>('AWS_SECRET_ACCESS_KEY'),
        },
      });
    }
  }

  async uploadDocument(userId: string, file: Express.Multer.File): Promise<KycDocument> {
    await this.validateFile(file);

    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    const ext = path.extname(file.originalname).toLowerCase();
    const storageKey = `kyc/${userId}/${crypto.randomUUID()}${ext}`;

    const url = this.useS3
      ? await this.uploadToS3(storageKey, file)
      : await this.uploadToLocal(storageKey, file);

    const doc = this.kycDocumentRepository.create({
      userId,
      storageKey,
      url,
      mimeType: file.mimetype,
      fileSize: file.size,
      originalName: file.originalname,
      uploadedAt: new Date(),
    });

    const saved = await this.kycDocumentRepository.save(doc);

    const orchestrated = await this.providerOrchestrator.submitOrReuse(
      user,
      saved,
      file.buffer,
    );

    await this.userRepository.update(userId, { kycStatus: orchestrated.status });

    await this.notificationsService.notify({
      userId,
      type: NotificationType.KYC_SUBMITTED,
      title: 'KYC Document Submitted',
      body: 'Your KYC document has been submitted and is pending review.',
    });

    const safeDoc = scrubForLog({
      userId,
      storageKey,
      mimeType: file.mimetype,
      fileSize: file.size,
      originalName: file.originalname,
    });
    this.winstonLogger.log(`KYC document uploaded: ${JSON.stringify(safeDoc)}`, 'KycService');

    return orchestrated;
  }

  async getLatestDocument(userId: string): Promise<KycDocument & { kycStatus: KycStatus }> {
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    const doc = await this.kycDocumentRepository.findOne({
      where: { userId },
      order: { uploadedAt: 'DESC' },
    });

    if (!doc) {
      throw new NotFoundException('No KYC document found');
    }

    return { ...doc, kycStatus: user.kycStatus };
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private async validateFile(file: Express.Multer.File): Promise<void> {
    if (!file) {
      throw new BadRequestException('No file provided');
    }

    // 1. Size check (uses Multer limit, but double-check here)
    if (file.size > this.maxFileSizeBytes) {
      throw new PayloadTooLargeException(
        `File exceeds the ${this.maxFileSizeBytes / 1024 / 1024} MB limit (received ${file.size} bytes)`,
      );
    }

    // 2. Magic-byte MIME detection (ignores client-supplied Content-Type)
    const detectedMime = detectMimeFromBuffer(file.buffer);
    if (!detectedMime || !KYC_ALLOWED_MIME.includes(detectedMime)) {
      throw new UnsupportedMediaTypeException(
        `Unsupported file type detected. Allowed: ${KYC_ALLOWED_MIME.join(', ')}`,
      );
    }

    // 3. ClamAV virus scan
    await this.scanForViruses(file);
  }

  /**
   * Scans the file buffer with ClamAV via TCP socket.
   * If CLAMAV_HOST is not configured, logs a warning and skips scanning (non-blocking).
   * Throws 422 UnprocessableEntityException on positive detection.
   */
  private async scanForViruses(file: Express.Multer.File): Promise<void> {
    if (!this.clamavHost) {
      this.logger.warn(
        'CLAMAV_HOST not configured – skipping virus scan. Set CLAMAV_HOST and CLAMAV_PORT to enable.',
      );
      return;
    }

    try {
      const NodeClam = await this.loadClamav();
      const clamscan = await NodeClam.init({
        clamdscan: {
          host: this.clamavHost,
          port: this.clamavPort,
          timeout: 60000,
          active: true,
        },
        preference: 'clamdscan',
      });

      const { isInfected, viruses } = await clamscan.scanBuffer(file.buffer);

      if (isInfected) {
        const fileHash = crypto.createHash('sha256').update(file.buffer).digest('hex');
        this.logger.error(
          `Virus detected in upload. File hash: ${fileHash}. Viruses: ${viruses?.join(', ')}`,
        );
        throw new UnprocessableEntityException(
          'File failed virus scan and was rejected.',
        );
      }
    } catch (err) {
      if (err instanceof UnprocessableEntityException) throw err;
      // ClamAV unavailable – log warning and allow upload (non-blocking)
      this.logger.warn(`ClamAV scan failed (non-blocking): ${err.message}`);
    }
  }

  /** Lazy-loads clamscan to avoid hard dependency when ClamAV is not configured. */
  private async loadClamav(): Promise<any> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { default: NodeClam } = await import('clamscan');
      return new NodeClam();
    } catch {
      throw new Error('clamscan package not installed. Run: npm install clamscan');
    }
  }

  private async uploadToS3(key: string, file: Express.Multer.File): Promise<string> {
    await this.s3Client!.send(
      new PutObjectCommand({
        Bucket: this.bucket!,
        Key: key,
        Body: file.buffer,
        ContentType: file.mimetype,
      }),
    );
    return `https://${this.bucket}.s3.amazonaws.com/${key}`;
  }

  private async uploadToLocal(key: string, file: Express.Multer.File): Promise<string> {
    const filePath = path.join(this.uploadDir, key);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, file.buffer);
    return `${this.baseUrl}/uploads/${key}`;
  }
}
