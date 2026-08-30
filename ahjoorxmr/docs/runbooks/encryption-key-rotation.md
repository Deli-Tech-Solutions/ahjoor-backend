# Runbook: Zero-Downtime Encryption Key Rotation (PII fields)

Rotates `DB_FIELD_ENCRYPTION_KEY` for all field-level-encrypted PII
(`users.email`, `users.twoFactorSecret`, `kyc_documents.documentNumber`) with
no downtime and no interruption to in-flight reads or writes.

Related: ADR 0013, `src/common/encryption/`, `scripts/rotate-encryption-keys.ts`,
migration `1756500000000-AddPiiKeyRotationProgress`.

---

## How it works

- **Ciphertext is key-versioned.** Values written under versioned mode look like
  `v2:<base64>`. Legacy values written before rotation have no prefix and are
  still readable.
- **Two keys are live during rotation.** `encrypt()` uses the new (active) key;
  `decrypt()` resolves the old key too, by version. Readers never break.
- **Re-encryption is a background job.** Batched by primary key, one transaction
  per batch, throttled, and checkpointed to
  `pii_encryption_key_rotation_progress` so it resumes after any interruption.
  Rows already at the active version are skipped (safe to re-run).

---

## Pre-checks

1. Generate the new key:
   ```
   openssl rand -hex 32
   ```
2. Pick version numbers. If the current data is unversioned (legacy), the old
   key becomes version `1` and the new key version `2`. If you have rotated
   before, increment from the current `DB_FIELD_ENCRYPTION_KEY_VERSION`.
3. Confirm the migration has run in the target environment:
   ```
   npm run migration:run
   ```
   (creates `pii_encryption_key_rotation_progress`)
4. Store the new key in the secrets manager. Keep the old key — it must stay
   available until Step 4.

---

## Step 0 — Pin the blind-index key (do this first, separate deploy)

Email lookups use an HMAC blind index keyed, by default, off
`DB_FIELD_ENCRYPTION_KEY`. Pin it explicitly to the **current** key so rotating
the data key does not change the index:

```
DB_FIELD_ENCRYPTION_BLIND_INDEX_KEY=<current DB_FIELD_ENCRYPTION_KEY value>
```

Deploy this with no other change. It is a no-op (same key, same hashes).
Leave `DB_FIELD_ENCRYPTION_BLIND_INDEX_KEY` untouched for the rest of this
procedure.

> Rotating the blind-index key itself is **not** covered here — it requires
> recomputing every `emailBlindIndex` and is a separate offline task.

---

## Step 1 — Deploy the two-key configuration

Set on every running instance (API, workers, cron) and deploy/restart:

```
DB_FIELD_ENCRYPTION_KEY=<NEW key hex>
DB_FIELD_ENCRYPTION_KEY_VERSION=2

DB_FIELD_ENCRYPTION_KEY_PREVIOUS=<OLD key hex>
DB_FIELD_ENCRYPTION_KEY_PREVIOUS_VERSION=1
```

After this deploy:

- new and updated rows are written as `v2:…`
- all existing rows (`v1:…` or unprefixed legacy) still decrypt via the previous
  key

Verify: read a user profile and a KYC record through the API — both succeed.
Update a user's email — it round-trips.

---

## Step 2 — Run the re-encryption job

From a task runner / one-off pod with database access and the **same env** as
Step 1:

```
npm run encryption:rotate-keys
```

Tuning (env vars):

| var | default | meaning |
|-----|---------|---------|
| `ROTATION_BATCH_SIZE` | `500` | rows per batch / per transaction |
| `ROTATION_THROTTLE_MS` | `100` | pause between batches |
| `ROTATION_MAX_FAILURES` | `0` | undecryptable rows tolerated before abort |
| `ROTATION_TABLES` | (all) | comma list, e.g. `users,kyc_documents` |

The job logs progress per table:

```
[rotate:users] running — scanned 5000, re-encrypted 5000, failed 0
...
[rotate:users] completed — scanned 41231, re-encrypted 41231, failed 0
[rotate:kyc_documents] completed — scanned 8801, re-encrypted 8801, failed 0
Rotation complete. All PII fields are at the active key version.
```

**If it is interrupted** (deploy, crash, Ctrl-C): just run it again. It reads
`pii_encryption_key_rotation_progress` and continues from the last committed
batch.

**Monitor** while it runs:

```sql
SELECT target_table, status, target_key_version,
       last_processed_id, rows_scanned, rows_reencrypted, rows_failed,
       started_at, updated_at, completed_at
FROM pii_encryption_key_rotation_progress;
```

**If `rows_failed > 0`**: the job aborts (with default `ROTATION_MAX_FAILURES=0`)
and the failed rows are named in the warnings. Investigate — usually a value
encrypted with a key that is not in the current ring, or genuine corruption.
Do **not** proceed to Step 3 until every table shows `status = completed` and
`rows_failed = 0`.

---

## Step 3 — Verify full coverage

```sql
-- expect 0 for every encrypted column
SELECT count(*) FROM users            WHERE email           IS NOT NULL AND email           NOT LIKE 'v2:%';
SELECT count(*) FROM users            WHERE "twoFactorSecret" IS NOT NULL AND "twoFactorSecret" NOT LIKE 'v2:%';
SELECT count(*) FROM kyc_documents    WHERE "documentNumber" IS NOT NULL AND "documentNumber" NOT LIKE 'v2:%';
```

(substitute your active version for `v2`). Non-zero means either the job did not
finish or new legacy writes are still happening — re-run Step 2.

---

## Step 4 — Retire the old key

Once Step 3 is clean and you are confident no backup/replica restore will
reintroduce old-key data:

1. Remove from config and redeploy:
   ```
   DB_FIELD_ENCRYPTION_KEY_PREVIOUS=
   DB_FIELD_ENCRYPTION_KEY_PREVIOUS_VERSION=
   ```
2. Keep `DB_FIELD_ENCRYPTION_KEY_VERSION=2` (and the pinned
   `DB_FIELD_ENCRYPTION_BLIND_INDEX_KEY`).
3. Delete the old key from the secrets manager per your key-destruction policy.
4. Optionally clear the progress table:
   ```sql
   DELETE FROM pii_encryption_key_rotation_progress;
   ```

Verify once more: profile read, KYC read, email login, email update.

---

## Rollback

- **Before Step 4** (old key still configured): revert the Step 1 env change.
  New `v2:` rows written in the meantime still decrypt because the new key is
  the previous key after revert — set
  `DB_FIELD_ENCRYPTION_KEY=<OLD>`, `DB_FIELD_ENCRYPTION_KEY_VERSION=1`,
  `DB_FIELD_ENCRYPTION_KEY_PREVIOUS=<NEW>`,
  `DB_FIELD_ENCRYPTION_KEY_PREVIOUS_VERSION=2`. Reads of both formats keep
  working. You can re-run the job later to converge back to `v1`.
- **After Step 4**: the old key is gone; you cannot roll back. Only forward — a
  new rotation to version 3.

---

## Emergency (suspected key compromise)

1. Do Step 0 and Step 1 immediately (new key active — all *new* writes are
   protected at once).
2. Lower `ROTATION_THROTTLE_MS` (e.g. `0`) and raise `ROTATION_BATCH_SIZE`
   within what the database can absorb, then run Step 2.
3. Proceed through Steps 3–4 as fast as verification allows.
