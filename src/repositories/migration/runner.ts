/**
 * Migration runner (P2-02).
 * Implements §13.3's state machine:
 * discover → encrypted snapshot → read-only preflight → batched writes into a
 */
import type { MigrationCheckpoint, MigrateOptions, MigrateOutcome, MigrationReport, SourceHashRecord } from './types';
import { SNAPSHOT_KEY_PREFIX, STAGING_LIBRARY_PREFIX } from './types';
import { readAllSources, sha256Hex } from './sources';
import { buildMapping } from './mapping';
import { acquireLock, newLockOwner, readLock, releaseLock, renewLock, isLockLive } from './lock';
import { runV3Transaction, requestToPromise } from '../../infrastructure/storage/idbV3';
import { validateRecord } from '../schema';
import { encryptText, decryptText } from '../../lib/crypto';

/** Where the encrypted pre-migration snapshot lives (schema: `MIGRATION_SNAPSHOT_STORE`). */
const SNAPSHOT_STORE = 'migration_snapshots_v3';

const CHECKPOINT_PREFIX = 'self_hub_migration_checkpoint_';
const DEFAULT_BATCH_SIZE = 200;

interface PendingRecord {
  store: string;
  key: unknown;
  value: unknown;
}

/**
 * Root-level fields a source carried that this build does not model.
 *
 * §13.2 requires unknown fields to survive a migration. They cannot be typed into
 * the v3 stores (there is nowhere to put them), so they are reported explicitly —
 * a visible list beats a silent drop, and P2-06's migration package can carry them
 * verbatim.
 */
function rootUnknownFields(
  snapshots: Array<{ id: string; unknownFields: string[] }>
): Array<{ source: string; collection: string; field: string }> {
  return snapshots.flatMap((snapshot) =>
    (snapshot.unknownFields || []).map((field) => ({ source: snapshot.id, collection: '<root>', field }))
  );
}

function checkpointKey(stagingLibraryId: string): string {
  return `${CHECKPOINT_PREFIX}${stagingLibraryId}`;
}

export function readCheckpoint(stagingLibraryId: string): MigrationCheckpoint | null {
  try {
    const raw = localStorage.getItem(checkpointKey(stagingLibraryId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as MigrationCheckpoint;
    if (!parsed || typeof parsed.batchIndex !== 'number') return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeCheckpoint(checkpoint: MigrationCheckpoint): void {
  try {
    localStorage.setItem(checkpointKey(checkpoint.stagingLibraryId), JSON.stringify(checkpoint));
  } catch {
    /* storage full: the checkpoint is best-effort, the batches are durable */
  }
}

export function clearCheckpoint(stagingLibraryId: string): void {
  try {
    localStorage.removeItem(checkpointKey(stagingLibraryId));
  } catch {
    /* nothing to clear */
  }
}

/**
 * Save the immutable, encrypted pre-migration copy of every raw source.
 * Stored in **IndexedDB**, not `localStorage`. The snapshot is roughly the size of the
 * sources it copies, and the whole point of migrating is that the library outgrew
 */
async function saveSnapshot(
  migrationId: string,
  snapshots: Array<{ id: string; raw: string; hash: string }>,
  password: string
): Promise<{ ok: boolean; hash?: string; error?: string }> {
  try {
    const payload = JSON.stringify({
      format: 'selfhub-migration-snapshot',
      formatVersion: 1,
      createdAt: Date.now(),
      sources: snapshots.map((s) => ({ id: s.id, hash: s.hash, raw: s.raw }))
    });
    const encrypted = await encryptText(payload, password);
    const stored = JSON.stringify(encrypted);
    const hash = await sha256Hex(stored);
    await runV3Transaction([SNAPSHOT_STORE], 'readwrite', async (ctx) => {
      const store = ctx.store(SNAPSHOT_STORE);
      store.put({ id: migrationId, ciphertext: stored, hash, createdAt: Date.now() });
/**
 * Keep only the newest snapshot.
 * Each snapshot is roughly the size of the sources it copies, so keeping every one of
 * them grows without bound on a device whose owner migrates more than once. One is
 * · — which is the only one a "I switched and something is missing" rollback can mean.
 */
      const existing = await requestToPromise(
        store.getAllKeys() as IDBRequest<IDBValidKey[]>
      );
      for (const key of existing) {
        if (String(key) !== migrationId) store.delete(key);
      }
    });
    /**
     * Drop snapshots left in `localStorage` by earlier versions of this code.
     *
     * They were written there until the snapshot moved to IndexedDB, and a stale one can be
     * megabytes — sitting in the very budget the migration exists to escape. Removing them
     * is safe: the snapshot for *this* run was just written to IndexedDB, and an old
     * snapshot only ever served the run that created it.
     */
    try {
      for (const key of Object.keys(localStorage)) {
        if (key.startsWith(SNAPSHOT_KEY_PREFIX)) localStorage.removeItem(key);
      }
    } catch {
      /* storage unavailable: nothing to clean up */
    }
    return { ok: true, hash };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Read a snapshot back, so a report can prove it is recoverable. */
export async function readSnapshot(
  migrationId: string,
  password: string
): Promise<{ ok: boolean; sources?: Array<{ id: string; hash: string; raw: string }>; error?: string }> {
  try {
    const row = await runV3Transaction([SNAPSHOT_STORE], 'readonly', async (ctx) =>
      requestToPromise(
        ctx.store(SNAPSHOT_STORE).get(migrationId) as IDBRequest<{ ciphertext?: string } | undefined>
      )
    ).then((result) => result.value);
    if (!row?.ciphertext) return { ok: false, error: '没有找到迁移快照' };
    const envelope = JSON.parse(row.ciphertext) as { ciphertext: string; iv: string; salt: string };
    const plain = await decryptText(envelope.ciphertext, envelope.iv, envelope.salt, password);
    const parsed = JSON.parse(plain) as { sources: Array<{ id: string; hash: string; raw: string }> };
    return { ok: true, sources: parsed.sources };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : '快照无法解密' };
  }
}

/** Write one batch of records, validating every record before it is queued. */
async function writeBatch(records: PendingRecord[]): Promise<{ written: number; skipped: number }> {
  if (records.length === 0) return { written: 0, skipped: 0 };

  // Validate before opening a transaction: a bad record must not abort a batch
  // that is otherwise fine, and it must never land half-written.
  const issues = records.flatMap((record) =>
    validateRecord(record.store, record.value).map((issue) => ({ store: record.store, field: issue.field, message: issue.message }))
  );
  if (issues.length > 0) {
    throw new Error(`批次中有 ${issues.length} 条记录不符合模型: ${issues[0].store}.${issues[0].field} ${issues[0].message}`);
  }

  const stores = Array.from(new Set(records.map((r) => r.store)));
  let skipped = 0;

  await runV3Transaction(stores, 'readwrite', async (ctx) => {
    for (const record of records) {
      const store = ctx.store(record.store);
      // Idempotent re-run: an identical record already present is skipped rather
      // than duplicated. §13.3: "同一源重试不新增重复项".
      const existing = await requestToPromise(store.get(record.key as IDBValidKey));
      if (existing) {
        skipped += 1;
        continue;
      }
      store.put(record.value);
    }
  });

  return { written: records.length - skipped, skipped };
}

/** Per-store counts in the staging library, for verification. */
async function countStaging(stores: string[], libraryId: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const store of stores) {
    try {
      out[store] = await runV3Transaction([store], 'readonly', async (ctx) => {
        const rows = await requestToPromise(
          ctx.store(store).getAll() as IDBRequest<Array<{ libraryId?: string }>>
        );
        return rows.filter((row) => row.libraryId === libraryId).length;
      }).then((r) => r.value);
    } catch {
      out[store] = -1;
    }
  }
  return out;
}

/**
 * Re-exported from `lib/migrationGate`, which owns the reader: the backup service and the
 * app's boot path need it too, and neither should have to pull the migration runner in.
 */
export { readActiveLibraryId } from '../../lib/migrationGate';

async function writeActiveLibraryId(libraryId: string): Promise<void> {
  await runV3Transaction(['library_meta_v3'], 'readwrite', async (ctx) => {
    ctx.store('library_meta_v3').put({ key: 'activeLibraryId', value: libraryId, at: Date.now() });
  });
}

export interface PreflightResult {
  ok: boolean;
  report: MigrationReport;
  /** Record counts per store that *would* be written. */
  planned: Array<{ store: string; found: number; missing: number }>;
  sourceHashes: SourceHashRecord[];
  error?: string;
}

/**
 * Read-only preflight: exactly what a migration would write, and every problem
 * found, without writing anything. This is the step the UI shows before asking
 * for confirmation.
 */
export async function preflightMigration(options: {
  stagingLibraryId?: string;
  includeChromeStorage?: boolean;
  preferPayload?: boolean;
} = {}): Promise<PreflightResult> {
  const stagingLibraryId = options.stagingLibraryId ?? `${STAGING_LIBRARY_PREFIX}${Date.now().toString(36)}`;
  const now = Date.now();

  try {
    const sources = await readAllSources({ includeChromeStorage: options.includeChromeStorage, preferPayload: options.preferPayload });
    const mapping = buildMapping(stagingLibraryId, sources.collections, { now });
    const sourceHashes: SourceHashRecord[] = sources.snapshots.map((s) => ({
      source: s.id,
      hash: s.hash,
      counts: s.counts
    }));

    const report: MigrationReport = {
      id: `preflight-${now}`,
      from: 'v2',
      to: 'v3',
      phase: 'preflight',
      stagingLibraryId,
      sourceHashes,
      counts: mapping.counts,
      conflicts: mapping.conflicts,
      unknownFields: [...rootUnknownFields(sources.snapshots), ...mapping.unknownFields],
      warnings: [...sources.snapshots.flatMap((s) => s.warnings), ...mapping.warnings],
      createdAt: now,
      updatedAt: now
    };

    // "found" is what the mapping produced; "missing" is what the live/staging
    // store already has, so the UI can say "resume will add N".
    const byStore = new Map<string, number>();
    for (const { store } of mapping.records.values()) byStore.set(store, (byStore.get(store) || 0) + 1);
    const existing = await countStaging(Array.from(byStore.keys()), stagingLibraryId);
    const planned = Array.from(byStore.entries()).map(([store, found]) => ({
      store,
      found,
      missing: Math.max(0, found - (existing[store] || 0))
    }));

    return { ok: true, report, planned, sourceHashes };
  } catch (err) {
    const now2 = Date.now();
    return {
      ok: false,
      report: {
        id: `preflight-${now2}`,
        from: 'v2',
        to: 'v3',
        phase: 'failed',
        stagingLibraryId,
        sourceHashes: [],
        counts: [],
        conflicts: [],
        unknownFields: [],
        warnings: [],
        failure: err instanceof Error ? err.message : String(err),
        createdAt: now2,
        updatedAt: now2
      },
      planned: [],
      sourceHashes: [],
      error: err instanceof Error ? err.message : String(err)
    };
  }
}

/**
 * Run the migration.
 * `skipSwitch` exists so the whole pipeline can be verified *without* changing
 * which library the app reads. The default in this build is `true` (see
 * · never leave a user with an app that reads a half-filled library.
 */
export const MIGRATION_SWITCH_ENABLED = false;

export async function migrateV2ToV3(options: MigrateOptions): Promise<MigrateOutcome> {
  const now = Date.now();
  const stagingLibraryId = options.stagingLibraryId ?? `${STAGING_LIBRARY_PREFIX}${now.toString(36)}`;
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const owner = newLockOwner();

  const emptyReport = (failure: string): MigrationReport => ({
    id: `migration-${now}`,
    from: 'v2',
    to: 'v3',
    phase: 'failed',
    stagingLibraryId,
    sourceHashes: [],
    counts: [],
    conflicts: [],
    unknownFields: [],
    warnings: [],
    failure,
    createdAt: now,
    updatedAt: now
  });

  // A password is mandatory: §13.3 requires the encrypted snapshot before any
  // write, and a migration without a way back is not offered.
  if (!options.password) {
    return {
      ok: false,
      report: emptyReport('缺少快照密码：迁移前必须生成一份加密的原始数据副本'),
      switched: false,
      error: 'missing-password'
    };
  }

  // 1. Discover.
  const sources = await readAllSources({ includeChromeStorage: options.includeChromeStorage, preferPayload: options.preferPayload });
  const sourceHashes: SourceHashRecord[] = sources.snapshots.map((s) => ({
    source: s.id,
    hash: s.hash,
    counts: s.counts
  }));

  // Resuming requires the inputs to be unchanged.
  const previous = options.resume ? readCheckpoint(stagingLibraryId) : null;
  if (options.resume && previous) {
    const changed = previous.sourceHashes.some(
      (previousHash) => sourceHashes.find((current) => current.source === previousHash.source)?.hash !== previousHash.hash
    );
    if (changed) {
      return {
        ok: false,
        report: {
          ...emptyReport('来源数据在两次运行之间发生了变化，无法安全续跑'),
          phase: 'failed',
          sourceHashes
        },
        switched: false,
        error: 'source-changed'
      };
    }
  }

  // 2. Encrypted snapshot.
  const migrationId = `migration-${stagingLibraryId}`;
  const snapshot = await saveSnapshot(migrationId, sources.snapshots, options.password);
  if (!snapshot.ok) {
    return {
      ok: false,
      report: emptyReport(`无法保存加密快照: ${snapshot.error ?? '未知错误'}`),
      switched: false,
      error: 'snapshot-failed'
    };
  }

  // 3. Preflight mapping, then the lock, then writes.
  const mapping = buildMapping(stagingLibraryId, sources.collections, { now });
  const lock = acquireLock(stagingLibraryId, { owner, phase: 'staging', now });
  if (!lock.ok) {
    return {
      ok: false,
      report: {
        ...emptyReport(
          lock.blockedBy
            ? `另一个迁移正在进行（${lock.blockedBy.owner}，阶段 ${lock.blockedBy.phase}）。如需接管，请先确认那次迁移已经放弃。`
            : '无法获取迁移锁'
        ),
        sourceHashes
      },
      switched: false,
      snapshotHash: snapshot.hash,
      error: 'locked'
    };
  }

  const records: PendingRecord[] = Array.from(mapping.records.values());
  const startBatch = previous?.batchIndex ?? 0;
  const counts = new Map(mapping.counts.map((c) => [c.store, { ...c }]));
  let writtenTotal = 0;
  let skippedTotal = 0;
  let interrupted = false;

  try {
    const batches: PendingRecord[][] = [];
    for (let i = 0; i < records.length; i += batchSize) batches.push(records.slice(i, i + batchSize));

    for (let index = startBatch; index < batches.length; index += 1) {
      if (options.maxBatches !== undefined && index - startBatch >= options.maxBatches) {
        interrupted = true;
        break;
      }
      const { written, skipped } = await writeBatch(batches[index]);
      writtenTotal += written;
      skippedTotal += skipped;

      writeCheckpoint({
        batchIndex: index + 1,
        sourceHashes,
        stagingLibraryId,
        startedAt: previous?.startedAt ?? now,
        updatedAt: Date.now()
      });
      // Keep the lock alive across a long migration, and let the main thread
      // breathe between batches (§13.3: "每批约 200 条并让出主线程").
      renewLock(owner, 'staging');
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    // 4. Verify.
    const stores = Array.from(new Set(records.map((r) => r.store)));
    const actual = await countStaging(stores, stagingLibraryId);
    const verificationProblems: string[] = [];
    const plannedByStore = new Map<string, number>();
    for (const record of records) plannedByStore.set(record.store, (plannedByStore.get(record.store) || 0) + 1);

    for (const [store, planned] of plannedByStore) {
      const found = actual[store] ?? 0;
      if (found < planned) {
        verificationProblems.push(`${store}: 计划 ${planned} 条，实际 ${found} 条`);
      }
      const countRecord = counts.get(store);
      if (countRecord) countRecord.written = found;
    }

    // Referential check: every link's endpoints must exist in the staging library.
    const linkProblems = await verifyLinks(stagingLibraryId);
    verificationProblems.push(...linkProblems);

    const report: MigrationReport = {
      id: migrationId,
      from: 'v2',
      to: 'v3',
      phase: interrupted
        ? 'staging'
        : verificationProblems.length === 0
          ? 'verified'
          : 'failed',
      stagingLibraryId,
      sourceHashes,
      counts: Array.from(counts.values()),
      conflicts: mapping.conflicts,
      unknownFields: [...rootUnknownFields(sources.snapshots), ...mapping.unknownFields],
      warnings: [
        ...sources.snapshots.flatMap((s) => s.warnings),
        ...mapping.warnings,
        ...(skippedTotal > 0 ? [`续跑跳过了 ${skippedTotal} 条已存在的记录（幂等，未重复写入）`] : [])
      ],
      failure: verificationProblems.length > 0 ? verificationProblems.join('; ') : undefined,
      createdAt: now,
      updatedAt: Date.now()
    };

    // 5. Switch, only when verification passed, the caller did not skip it, and
    //    switching is either the build default or explicitly allowed. The switch
    //    is a single durable write of `activeLibraryId`, so it is atomic: there is
    //    no moment where the app reads a library that is only half the target.
    let switched = false;
    const switchAllowed = options.allowSwitch ?? MIGRATION_SWITCH_ENABLED;
    const allowSwitch = !options.skipSwitch && switchAllowed;
    if (!interrupted && verificationProblems.length === 0 && allowSwitch) {
      renewLock(owner, 'switched');
      await writeActiveLibraryId(stagingLibraryId);
      switched = true;
      releaseLock(owner);
      writeCheckpoint({
        batchIndex: Math.ceil(records.length / batchSize),
        sourceHashes,
        stagingLibraryId,
        startedAt: previous?.startedAt ?? now,
        updatedAt: Date.now()
      });
    } else {
      releaseLock(owner);
    }

    return {
      ok: verificationProblems.length === 0 && !interrupted,
      report,
      interrupted,
      snapshotHash: snapshot.hash,
      switched,
      error: verificationProblems.length > 0 ? report.failure : undefined
    };
  } catch (err) {
    releaseLock(owner);
    return {
      ok: false,
      report: {
        ...emptyReport(err instanceof Error ? err.message : String(err)),
        phase: 'failed',
        sourceHashes,
        counts: Array.from(counts.values()),
        conflicts: mapping.conflicts,
        unknownFields: mapping.unknownFields
      },
      switched: false,
      snapshotHash: snapshot.hash,
      error: err instanceof Error ? err.message : String(err)
    };
  }
}

/** Every EntityLink endpoint must resolve inside the staging library. */
async function verifyLinks(libraryId: string): Promise<string[]> {
  try {
    const problems: string[] = [];
    const links = await runV3Transaction(['entity_links_v3'], 'readonly', async (ctx) => {
      const rows = await requestToPromise(
        ctx.store('entity_links_v3').getAll() as IDBRequest<Array<{ libraryId: string; fromType: string; fromId: string; toType: string; toId: string }>>
      );
      return rows.filter((row) => row.libraryId === libraryId);
    }).then((r) => r.value);

    if (links.length === 0) return problems;

    const targets = Array.from(new Set(links.map((l) => `${l.toType}\u0000${l.toId}`)));
    for (const target of targets) {
      // Namespaced ids contain ':' (e.g. `localStorage-v2:note-1`), so the type
      // separator must not be ':' — a plain split would truncate the id and make
      // every link look broken.
      const separator = target.indexOf('\u0000');
      const type = target.slice(0, separator);
      const id = target.slice(separator + 1);
      const store =
        type === 'note' || type === 'bookmark' || type === 'drawing' ? 'items_v3' : type === 'project' ? 'projects_v3' : null;
      if (!store) continue;
      const found = await runV3Transaction([store], 'readonly', async (ctx) =>
        requestToPromise(ctx.store(store).get([libraryId, id]))
      ).then((r) => Boolean(r.value));
      if (!found) problems.push(`关联指向不存在的 ${type} ${id}`);
    }
    return problems;
  } catch (err) {
    return [`关联校验失败: ${err instanceof Error ? err.message : String(err)}`];
  }
}
