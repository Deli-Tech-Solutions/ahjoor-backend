# ADR 0013: Zero-Downtime Encryption Key Rotation for PII Fields

## Status

Accepted

## Context

Field-level encryption for PII (`src/common/encryption`, migration
`1747000000000-AddFieldEncryptionAndTxStatus`) shipped with a single static
key (`DB_FIELD_ENCRYPTION_KEY`) and an ad-hoc "previous key" fallback that
worked only by trial decryption. There was no way to rotate the key
(compromise, compliance, scheduled rotation) without:

- a coordinated stop-the-world re-encryption of every encrypted column, and
- reader downtime during the window, because the decrypt path assumed one
  active key and could not tell which key encrypted a given value.

The blind index used for email lookups (`hmacBlindIndex`) was also keyed off
`DB_FIELD_ENCRYPTION_KEY`, so rotating that key would silently break every
`findByEmail` until all indexes were recomputed.

## Decision

### 1. Key-versioned ciphertext

Encrypted values gain an optional key-version prefix: `vN:<base64(iv|tag|ct)>`.
`:` is not in the base64 alphabet, so a versioned value is never ambiguous with
a legacy (unprefixed) one. Legacy values already in the database stay readable
with no migration.

Versioning is opt-in. When neither `DB_FIELD_ENCRYPTION_KEY_VERSION` nor
`DB_FIELD_ENCRYPTION_KEYS` is set, the transformer behaves exactly as before
(legacy mode, unprefixed ciphertext).

### 2. Key registry

A registry resolves keys by version from either:

- simple vars — `DB_FIELD_ENCRYPTION_KEY` + `DB_FIELD_ENCRYPTION_KEY_VERSION`
  (active) and `DB_FIELD_ENCRYPTION_KEY_PREVIOUS` +
  `DB_FIELD_ENCRYPTION_KEY_PREVIOUS_VERSION` (old), or
- an explicit ring — `DB_FIELD_ENCRYPTION_KEYS` (JSON `{version: hex}`) +
  `DB_FIELD_ENCRYPTION_ACTIVE_KEY_VERSION`.

`encrypt()` always uses the active version. `decrypt()` resolves the version
named in the prefix first, then falls back to every other key in the ring (so
legacy unprefixed rows and rows from a prior rotation still decrypt). This is
what makes reads safe for the entire rotation window.

### 3. Resumable, throttled, online re-encryption job

`src/common/encryption/key-rotation.ts` drives a storage-agnostic
`RotationStore`. `scripts/rotate-encryption-keys.ts` wires it to Postgres.

- Keyset pagination by primary key (no `OFFSET`, no long-held locks).
- One transaction per batch; a checkpoint row
  (`pii_encryption_key_rotation_progress`, migration `1756500000000`) records
  the last processed id and running counters. An interrupted run resumes from
  the checkpoint.
- Configurable pause between batches (`ROTATION_THROTTLE_MS`).
- Idempotent: rows already at the active version are skipped, so re-running a
  completed rotation is a no-op.

### 4. Blind-index key decoupled

`hmacBlindIndex` now prefers `DB_FIELD_ENCRYPTION_BLIND_INDEX_KEY`, falling
back to `DB_FIELD_ENCRYPTION_KEY` for backward compatibility. The runbook
requires pinning `DB_FIELD_ENCRYPTION_BLIND_INDEX_KEY` to the current data key
*before* rotating the data key, so lookups keep working. Rotating the
blind-index key itself is explicitly out of scope for online rotation — it
requires recomputing every index and is a separate maintenance operation.

## Consequences

- Ciphertext for rotated/new rows is ~4 bytes longer (the `vN:` prefix). All
  encrypted columns are `varchar(500)`; the longest plaintext (email) is far
  under the limit.
- Operators must follow the ordered runbook
  (`docs/runbooks/encryption-key-rotation.md`): deploy the two-key config,
  run the job, then drop the old key.
- The decrypt path does up to `keyCount` trial decryptions for legacy/rotated
  mismatches. During a rotation there are at most two keys; after cleanup, one.
- Existing tests and existing stored data are unaffected because legacy mode is
  the default and the legacy ciphertext format is unchanged.
