import {
  decrypt,
  encrypt,
  getActiveKeyVersion,
  getCiphertextKeyVersion,
  needsKeyRotation,
  hmacBlindIndex,
  __resetKeyRegistryCache,
} from './field-encryption.transformer';
import {
  rotateTarget,
  RotationRow,
  RotationStore,
  RotationTarget,
  StoredProgress,
} from './key-rotation';

const KEY_V1 = '11'.repeat(32);
const KEY_V2 = '22'.repeat(32);

function clearEncryptionEnv(): void {
  delete process.env.DB_FIELD_ENCRYPTION_KEY;
  delete process.env.DB_FIELD_ENCRYPTION_KEY_PREVIOUS;
  delete process.env.DB_FIELD_ENCRYPTION_KEY_VERSION;
  delete process.env.DB_FIELD_ENCRYPTION_KEY_PREVIOUS_VERSION;
  delete process.env.DB_FIELD_ENCRYPTION_KEYS;
  delete process.env.DB_FIELD_ENCRYPTION_ACTIVE_KEY_VERSION;
  delete process.env.DB_FIELD_ENCRYPTION_BLIND_INDEX_KEY;
  __resetKeyRegistryCache();
}

/** Encrypt a value as if `version` were the sole active key (pre-rotation). */
function encryptAtVersion(
  plaintext: string,
  version: number,
  keyHex: string,
): string {
  const saved = { ...process.env };
  clearEncryptionEnv();
  process.env.DB_FIELD_ENCRYPTION_KEY = keyHex;
  process.env.DB_FIELD_ENCRYPTION_KEY_VERSION = String(version);
  __resetKeyRegistryCache();
  const out = encrypt(plaintext);
  process.env = saved;
  __resetKeyRegistryCache();
  return out;
}

/** Enable versioned mode: v2 active (new key), v1 available (old key). */
function enableRotationConfig(): void {
  clearEncryptionEnv();
  process.env.DB_FIELD_ENCRYPTION_KEY = KEY_V2;
  process.env.DB_FIELD_ENCRYPTION_KEY_VERSION = '2';
  process.env.DB_FIELD_ENCRYPTION_KEY_PREVIOUS = KEY_V1;
  process.env.DB_FIELD_ENCRYPTION_KEY_PREVIOUS_VERSION = '1';
  __resetKeyRegistryCache();
}

/* -------------------------------------------------------------------------- */
/*  In-memory RotationStore                                                   */
/* -------------------------------------------------------------------------- */

class MemoryStore implements RotationStore {
  rows: Map<string, RotationRow>;
  progress: StoredProgress | null = null;
  fetchCalls = 0;

  constructor(rows: RotationRow[]) {
    this.rows = new Map(rows.map((r) => [r.id, { ...r }]));
  }

  loadProgress(): Promise<StoredProgress | null> {
    return Promise.resolve(this.progress ? { ...this.progress } : null);
  }

  saveProgress(progress: StoredProgress): Promise<void> {
    this.progress = { ...progress };
    return Promise.resolve();
  }

  fetchBatch(
    _target: RotationTarget,
    afterId: string | null,
    limit: number,
  ): Promise<RotationRow[]> {
    this.fetchCalls += 1;
    const sorted = [...this.rows.values()].sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    );
    const filtered =
      afterId == null ? sorted : sorted.filter((r) => r.id > afterId);
    return Promise.resolve(filtered.slice(0, limit).map((r) => ({ ...r })));
  }

  updateRow(
    _target: RotationTarget,
    id: string,
    values: Record<string, string>,
  ): Promise<void> {
    const row = this.rows.get(id);
    if (row) Object.assign(row, values);
    return Promise.resolve();
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    return fn();
  }
}

const USERS_TARGET: RotationTarget = {
  table: 'users',
  columns: ['email', 'twoFactorSecret'],
};

describe('encryption key rotation', () => {
  const savedEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...savedEnv };
    __resetKeyRegistryCache();
  });

  describe('versioned ciphertext format', () => {
    beforeEach(enableRotationConfig);

    it('prefixes ciphertext with the active key version', () => {
      const cipher = encrypt('user@example.com');
      expect(cipher).toMatch(/^v2:/);
      expect(getCiphertextKeyVersion(cipher)).toBe(2);
      expect(getActiveKeyVersion()).toBe(2);
    });

    it('round-trips with the active key', () => {
      expect(decrypt(encrypt('user@example.com'))).toBe('user@example.com');
    });

    it('legacy unprefixed value is still readable (encrypted with old key)', () => {
      // Value written before versioning, with what is now the previous key.
      clearEncryptionEnv();
      process.env.DB_FIELD_ENCRYPTION_KEY = KEY_V1;
      __resetKeyRegistryCache();
      const legacy = encrypt('legacy@example.com');
      expect(getCiphertextKeyVersion(legacy)).toBeNull();

      enableRotationConfig();
      expect(decrypt(legacy)).toBe('legacy@example.com');
    });
  });

  describe('reads succeed simultaneously mid-rotation', () => {
    it('a not-yet-rotated row and a rotated row both decrypt under the active key', () => {
      const notRotated = encryptAtVersion('old@example.com', 1, KEY_V1); // v1:
      enableRotationConfig();
      const rotated = encrypt('new@example.com'); // v2:

      expect(getCiphertextKeyVersion(notRotated)).toBe(1);
      expect(getCiphertextKeyVersion(rotated)).toBe(2);

      // Both readable at the same time, with the same (post-rotation) config.
      expect(decrypt(notRotated)).toBe('old@example.com');
      expect(decrypt(rotated)).toBe('new@example.com');

      expect(needsKeyRotation(notRotated)).toBe(true);
      expect(needsKeyRotation(rotated)).toBe(false);
    });
  });

  describe('blind index is stable across data-key rotation', () => {
    it('same blind index before and after rotation when the blind-index key is pinned', () => {
      clearEncryptionEnv();
      process.env.DB_FIELD_ENCRYPTION_KEY = KEY_V1;
      process.env.DB_FIELD_ENCRYPTION_BLIND_INDEX_KEY = KEY_V1;
      __resetKeyRegistryCache();
      const before = hmacBlindIndex('User@Example.com');

      enableRotationConfig();
      process.env.DB_FIELD_ENCRYPTION_BLIND_INDEX_KEY = KEY_V1;
      __resetKeyRegistryCache();
      const after = hmacBlindIndex('user@example.com');

      expect(after).toBe(before);
    });
  });

  describe('rotateTarget engine', () => {
    beforeEach(enableRotationConfig);

    function seedRows(n: number): RotationRow[] {
      const rows: RotationRow[] = [];
      for (let i = 0; i < n; i++) {
        const id = `user-${String(i).padStart(4, '0')}`;
        rows.push({
          id,
          email: encryptAtVersion(`u${i}@example.com`, 1, KEY_V1),
          twoFactorSecret:
            i % 3 === 0 ? encryptAtVersion(`secret${i}`, 1, KEY_V1) : null,
        });
        // encryptAtVersion resets env; restore rotation config for the next call.
        enableRotationConfig();
      }
      return rows;
    }

    it('re-encrypts every value to the active key version', async () => {
      const store = new MemoryStore(seedRows(25));
      const result = await rotateTarget(store, USERS_TARGET, {
        batchSize: 10,
        throttleMs: 0,
      });

      expect(result.done).toBe(true);
      expect(result.status).toBe('completed');
      expect(result.rowsScanned).toBe(25);
      expect(result.rowsReencrypted).toBe(25);
      expect(result.rowsFailed).toBe(0);

      for (const row of store.rows.values()) {
        expect(getCiphertextKeyVersion(row.email as string)).toBe(2);
        expect(decrypt(row.email as string)).toMatch(/@example\.com$/);
        if (row.twoFactorSecret) {
          expect(getCiphertextKeyVersion(row.twoFactorSecret)).toBe(2);
        }
      }
    });

    it('is resumable after an interruption', async () => {
      const store = new MemoryStore(seedRows(25));

      // Interrupt after a single batch.
      const partial = await rotateTarget(store, USERS_TARGET, {
        batchSize: 10,
        throttleMs: 0,
        maxBatches: 1,
      });
      expect(partial.done).toBe(false);
      expect(partial.rowsScanned).toBe(10);
      expect(store.progress?.lastProcessedId).toBe('user-0009');

      const rotatedSoFar = [...store.rows.values()].filter(
        (r) => getCiphertextKeyVersion(r.email as string) === 2,
      ).length;
      expect(rotatedSoFar).toBe(10);

      // Resume — continues from the checkpoint.
      const resumed = await rotateTarget(store, USERS_TARGET, {
        batchSize: 10,
        throttleMs: 0,
      });
      expect(resumed.done).toBe(true);
      expect(resumed.rowsScanned).toBe(25);
      expect(resumed.rowsReencrypted).toBe(25);
      for (const row of store.rows.values()) {
        expect(getCiphertextKeyVersion(row.email as string)).toBe(2);
      }
    });

    it('is idempotent — a second run re-encrypts nothing', async () => {
      const store = new MemoryStore(seedRows(12));
      await rotateTarget(store, USERS_TARGET, { batchSize: 5, throttleMs: 0 });

      const second = await rotateTarget(store, USERS_TARGET, {
        batchSize: 5,
        throttleMs: 0,
      });
      expect(second.done).toBe(true);
      expect(second.batchesRun).toBe(0);
      expect(second.rowsReencrypted).toBe(12);
    });

    it('throttles between batches', async () => {
      const store = new MemoryStore(seedRows(18));
      const sleeps: number[] = [];
      await rotateTarget(store, USERS_TARGET, {
        batchSize: 5,
        throttleMs: 50,
        sleep: (ms) => {
          sleeps.push(ms);
          return Promise.resolve();
        },
      });
      // Batches of 5,5,5,3 → pause after each full batch, none after the short one.
      expect(sleeps).toEqual([50, 50, 50]);
    });

    it('aborts when a row cannot be decrypted', async () => {
      const rows = seedRows(5);
      rows[2].email = 'v1:not-valid-ciphertext';
      const store = new MemoryStore(rows);

      await expect(
        rotateTarget(store, USERS_TARGET, { batchSize: 10, throttleMs: 0 }),
      ).rejects.toThrow(/failed to decrypt/i);
      expect(store.progress?.status).toBe('failed');
    });

    it('refuses to run when versioned encryption is disabled', async () => {
      clearEncryptionEnv();
      process.env.DB_FIELD_ENCRYPTION_KEY = KEY_V1; // legacy mode
      __resetKeyRegistryCache();
      const store = new MemoryStore([]);
      await expect(
        rotateTarget(store, USERS_TARGET, { throttleMs: 0 }),
      ).rejects.toThrow(/versioned encryption/i);
    });
  });
});
