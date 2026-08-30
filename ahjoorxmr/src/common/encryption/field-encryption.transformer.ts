import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const ENCODING = 'base64' as const;

/**
 * Key-version prefix on ciphertext, e.g. `v2:<base64>`.
 *
 * `:` is not part of the base64 alphabet, so a versioned value can never be
 * confused with a legacy (unprefixed) base64 payload. Legacy values written
 * before key rotation was introduced stay readable untouched.
 */
const VERSION_PREFIX_RE = /^v(\d+):/;

interface KeyRegistry {
  /**
   * `legacy`   — single active key (+ optional previous), unprefixed ciphertext.
   *              Exactly the behaviour that shipped before key rotation.
   * `versioned` — multiple keys addressed by version, ciphertext carries a
   *              `vN:` prefix, encryption always uses `activeVersion`.
   */
  mode: 'legacy' | 'versioned';
  keys: Map<number, Buffer>;
  activeVersion: number;
  legacyCurrent: Buffer;
  legacyPrevious: Buffer | null;
}

function parseHexKey(raw: string, label: string): Buffer {
  const buf = Buffer.from(raw, 'hex');
  if (buf.length !== 32) {
    throw new Error(`${label} must be 32 bytes (64 hex chars)`);
  }
  return buf;
}

let registryCache: { signature: string; registry: KeyRegistry } | null = null;

interface RegistryEnv {
  keysJson?: string;
  activeVersionEnv?: string;
  currentEnv?: string;
  previousEnv?: string;
  currentVersionEnv?: string;
  previousVersionEnv?: string;
}

function readRegistryEnv(): RegistryEnv {
  return {
    keysJson: process.env.DB_FIELD_ENCRYPTION_KEYS,
    activeVersionEnv: process.env.DB_FIELD_ENCRYPTION_ACTIVE_KEY_VERSION,
    currentEnv: process.env.DB_FIELD_ENCRYPTION_KEY,
    previousEnv: process.env.DB_FIELD_ENCRYPTION_KEY_PREVIOUS,
    currentVersionEnv: process.env.DB_FIELD_ENCRYPTION_KEY_VERSION,
    previousVersionEnv: process.env.DB_FIELD_ENCRYPTION_KEY_PREVIOUS_VERSION,
  };
}

function isSet(value: string | undefined): value is string {
  return value != null && value !== '';
}

function parseVersion(raw: string, label: string): number {
  const version = Number(raw);
  if (!Number.isInteger(version) || version < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return version;
}

function buildRegistry(env: RegistryEnv): KeyRegistry {
  const keys = new Map<number, Buffer>();

  // 1. Explicit key ring: DB_FIELD_ENCRYPTION_KEYS='{"1":"<hex>","2":"<hex>"}'
  if (isSet(env.keysJson)) {
    let parsed: Record<string, string>;
    try {
      parsed = JSON.parse(env.keysJson) as Record<string, string>;
    } catch {
      throw new Error(
        'DB_FIELD_ENCRYPTION_KEYS must be valid JSON: {"<version>":"<64 hex chars>"}',
      );
    }
    for (const [rawVersion, hex] of Object.entries(parsed)) {
      const version = parseVersion(
        rawVersion,
        `DB_FIELD_ENCRYPTION_KEYS key "${rawVersion}"`,
      );
      keys.set(
        version,
        parseHexKey(hex, `DB_FIELD_ENCRYPTION_KEYS["${rawVersion}"]`),
      );
    }
    if (keys.size === 0) {
      throw new Error('DB_FIELD_ENCRYPTION_KEYS must contain at least one key');
    }
    const activeVersion = isSet(env.activeVersionEnv)
      ? parseVersion(
          env.activeVersionEnv,
          'DB_FIELD_ENCRYPTION_ACTIVE_KEY_VERSION',
        )
      : Math.max(...keys.keys());
    if (!keys.has(activeVersion)) {
      throw new Error(
        `DB_FIELD_ENCRYPTION_ACTIVE_KEY_VERSION ${activeVersion} is not present in DB_FIELD_ENCRYPTION_KEYS`,
      );
    }
    return {
      mode: 'versioned',
      keys,
      activeVersion,
      legacyCurrent: keys.get(activeVersion)!,
      legacyPrevious: null,
    };
  }

  // 2. Simple rotation vars: DB_FIELD_ENCRYPTION_KEY_VERSION opts into versioned mode.
  if (isSet(env.currentVersionEnv)) {
    if (!isSet(env.currentEnv)) {
      throw new Error('Missing env var: DB_FIELD_ENCRYPTION_KEY');
    }
    const activeVersion = parseVersion(
      env.currentVersionEnv,
      'DB_FIELD_ENCRYPTION_KEY_VERSION',
    );
    keys.set(
      activeVersion,
      parseHexKey(env.currentEnv, 'DB_FIELD_ENCRYPTION_KEY'),
    );

    if (isSet(env.previousEnv)) {
      const previousVersion = isSet(env.previousVersionEnv)
        ? parseVersion(
            env.previousVersionEnv,
            'DB_FIELD_ENCRYPTION_KEY_PREVIOUS_VERSION',
          )
        : activeVersion - 1;
      if (previousVersion < 0) {
        throw new Error(
          'DB_FIELD_ENCRYPTION_KEY_PREVIOUS_VERSION must be a non-negative integer',
        );
      }
      if (previousVersion === activeVersion) {
        throw new Error(
          'DB_FIELD_ENCRYPTION_KEY_PREVIOUS_VERSION must differ from DB_FIELD_ENCRYPTION_KEY_VERSION',
        );
      }
      keys.set(
        previousVersion,
        parseHexKey(env.previousEnv, 'DB_FIELD_ENCRYPTION_KEY_PREVIOUS'),
      );
    }
    return {
      mode: 'versioned',
      keys,
      activeVersion,
      legacyCurrent: keys.get(activeVersion)!,
      legacyPrevious: null,
    };
  }

  // 3. Legacy mode — unchanged behaviour.
  if (!isSet(env.currentEnv)) {
    throw new Error('Missing env var: DB_FIELD_ENCRYPTION_KEY');
  }
  const legacyCurrent = parseHexKey(env.currentEnv, 'DB_FIELD_ENCRYPTION_KEY');
  let legacyPrevious: Buffer | null = null;
  if (isSet(env.previousEnv)) {
    const prev = Buffer.from(env.previousEnv, 'hex');
    if (prev.length === 32) legacyPrevious = prev;
  }
  return {
    mode: 'legacy',
    keys,
    activeVersion: 0,
    legacyCurrent,
    legacyPrevious,
  };
}

function loadRegistry(): KeyRegistry {
  const env = readRegistryEnv();
  const signature = [
    env.keysJson,
    env.activeVersionEnv,
    env.currentEnv,
    env.previousEnv,
    env.currentVersionEnv,
    env.previousVersionEnv,
  ].join('\0');

  if (registryCache && registryCache.signature === signature) {
    return registryCache.registry;
  }
  const registry = buildRegistry(env);
  registryCache = { signature, registry };
  return registry;
}

function candidateKeys(
  registry: KeyRegistry,
  version: number | null,
): Buffer[] {
  if (registry.mode === 'legacy') {
    const list = [registry.legacyCurrent];
    if (registry.legacyPrevious) list.push(registry.legacyPrevious);
    return list;
  }

  const ordered: Buffer[] = [];
  const seen = new Set<Buffer>();
  const push = (buf: Buffer | undefined): void => {
    if (buf && !seen.has(buf)) {
      seen.add(buf);
      ordered.push(buf);
    }
  };
  // Exact version match first, then the active key, then every remaining key
  // (handles legacy unprefixed rows and values from earlier rotations).
  if (version !== null) push(registry.keys.get(version));
  push(registry.keys.get(registry.activeVersion));
  for (const v of [...registry.keys.keys()].sort((a, b) => b - a)) {
    push(registry.keys.get(v));
  }
  return ordered;
}

export function encrypt(plaintext: string): string {
  const registry = loadRegistry();
  const versioned = registry.mode === 'versioned';
  const key = versioned
    ? registry.keys.get(registry.activeVersion)!
    : registry.legacyCurrent;

  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  const payload = Buffer.concat([iv, tag, encrypted]).toString(ENCODING);

  return versioned ? `v${registry.activeVersion}:${payload}` : payload;
}

export function decrypt(ciphertext: string): string {
  const registry = loadRegistry();
  const match = VERSION_PREFIX_RE.exec(ciphertext);
  const version = match ? Number(match[1]) : null;
  const payload = match ? ciphertext.slice(match[0].length) : ciphertext;

  const buf = Buffer.from(payload, ENCODING);
  const iv = buf.subarray(0, IV_LENGTH);
  const tag = buf.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const encrypted = buf.subarray(IV_LENGTH + TAG_LENGTH);

  const tryDecrypt = (key: Buffer): string | null => {
    try {
      const decipher = createDecipheriv(ALGORITHM, key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([
        decipher.update(encrypted),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      return null;
    }
  };

  for (const key of candidateKeys(registry, version)) {
    const result = tryDecrypt(key);
    if (result !== null) return result;
  }

  throw new Error('Failed to decrypt field: invalid key or corrupted data');
}

/**
 * Key version that encrypted a stored value, or `null` for a legacy
 * (unprefixed) value.
 */
export function getCiphertextKeyVersion(value: string): number | null {
  const match = VERSION_PREFIX_RE.exec(value);
  return match ? Number(match[1]) : null;
}

/**
 * The version new writes are encrypted with, or `null` when running in legacy
 * (single static key) mode.
 */
export function getActiveKeyVersion(): number | null {
  const registry = loadRegistry();
  return registry.mode === 'versioned' ? registry.activeVersion : null;
}

export function isVersionedEncryptionEnabled(): boolean {
  return loadRegistry().mode === 'versioned';
}

/**
 * True when `value` is encrypted, versioned encryption is enabled, and the
 * value is not yet at the active key version — i.e. the rotation job should
 * re-encrypt it.
 */
export function needsKeyRotation(value: string | null | undefined): boolean {
  if (value == null) return false;
  const active = getActiveKeyVersion();
  if (active === null) return false;
  return getCiphertextKeyVersion(value) !== active;
}

/** Test-only: drop the memoised key registry so env changes take effect. */
export function __resetKeyRegistryCache(): void {
  registryCache = null;
}

export function hmacBlindIndex(value: string): string {
  const secret =
    process.env.DB_FIELD_ENCRYPTION_BLIND_INDEX_KEY ??
    process.env.DB_FIELD_ENCRYPTION_KEY;
  if (!secret) {
    throw new Error(
      'Missing DB_FIELD_ENCRYPTION_BLIND_INDEX_KEY / DB_FIELD_ENCRYPTION_KEY for blind index',
    );
  }
  return createHmac('sha256', Buffer.from(secret, 'hex'))
    .update(value.toLowerCase())
    .digest('hex');
}

/**
 * TypeORM ValueTransformer for AES-256-GCM encrypted columns.
 * Falls back to returning raw value for unencrypted legacy rows.
 */
export const encryptedTransformer = {
  to(value: string | null | undefined): string | null {
    if (value == null) return null;
    return encrypt(value);
  },
  from(value: string | null | undefined): string | null {
    if (value == null) return null;
    try {
      return decrypt(value);
    } catch {
      return value;
    }
  },
};
