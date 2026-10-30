/**
 * Application layer for the v3 backup path (P2-05).
 *
 * Everything below the UI meets here: the policy decides *whether* and *where*, the
 * snapshot decides *what*, the writer decides *how*, and this module turns that
 * into the two answers a screen needs — "what is the state of my backups?" and
 * "run one now".
 *
 * Three decisions worth stating, because they are the ones a UI could get wrong:
 *
 * 1. **The backup only ever reports what storage confirmed.** A run returns the
 *    writer's own result; nothing here optimistically says "已保存".
 * 2. **No password means no run.** §10.3 forbids falling back to plaintext, so a
 *    missing session password is returned as `LOCKED` with a message the settings
 *    page shows verbatim — and no request is made.
 * 3. **Status is read, not remembered.** The "last successful backup" comes from
 *    the on-destination pointer, so it survives a reload and cannot disagree with
 *    what is actually in the bucket.
 */
import { appError, fail, ok, toAppError, type Result } from '../../repositories/errors';
import type { HubState } from '../../types';
import { getDeviceId } from '../../lib/stateBackup';
import { normalizeHubState, validateHubState } from '../../lib/storage';
import { resolveBackupTarget } from '../../lib/backupPolicy';
import { createTransport } from './providers';
import type { BackupTransport } from './transport';
import { collectSnapshot } from './snapshot';
import { describeCredentialScope } from './snapshot';

/**
 * Re-exported so callers that already load this module on demand (the settings hook)
 * can also describe a credential scope without a second static import. Anything that
 * imports `snapshot.ts` from the entry graph makes that whole module a shared chunk
 * that the first load has to fetch — measured, not theoretical.
 */
export { describeCredentialScope };
import { decryptObject, deriveBackupKey, generationPrefix, type BackupManifest, type BackupPurpose, type CompletionMarker } from './format';
import {
  listGenerations,
  pruneGenerations,
  readGeneration,
  writeGeneration,
  type BackupGenerationInfo,
  type GenerationListing,
  type PruneResult
} from './writer';
import { resolveLatestGeneration } from './resolve';
import { describeResolvedLatest, type ResolvedLatest } from './latest';
import { isBackupPasswordEstablished } from './backupSession';

/**
 * The library id used until P2-06 switches the app onto a real v3 library.
 *
 * Deliberately explicit rather than derived from the device: two devices must not
 * share a backup directory, and the current v2 payload is one logical library on
 * every device, so the device id below does the separating.
 */
/**
 * The library id used when the app has never been migrated onto a v3 library.
 *
 * Single definition lives in `lib/storageMode.ts` (the switch reads it too); re-exported
 * here so backup/restore callers can keep importing it from the backup layer.
 */
export { LOCAL_LIBRARY_ID } from '../../lib/storageMode';
import { LOCAL_LIBRARY_ID } from '../../lib/storageMode';
import { readActiveLibraryId } from '../../lib/migrationGate';
import { readStorageMode } from '../../lib/storageMode';
import { withFreshNewtabPreferences } from '../../lib/newtabPreferences';

/**
 * Which library this operation is about.
 *
 * `local-v2` is only the *pre-migration* default. Once a migration switches
 * `activeLibraryId`, that pointer is the library the app reads and writes — so backups,
 * restores and migration packages must follow it too. They used to default to the constant,
 * which meant that after switching, a v3 backup silently captured the **old** library while
 * the user kept editing the new one: the backup existed, looked fine, and did not contain
 * their data. Every call site goes through here now.
 */
export async function resolveLibraryId(explicit?: string): Promise<string> {
  if (explicit) return explicit;
  return (await readActiveLibraryId()) ?? LOCAL_LIBRARY_ID;
}

export function currentDeviceId(): string {
  return getDeviceId();
}

export interface V3BatchSummary {
  generationId: string;
  complete: boolean;
  createdAt?: number;
  objectCount: number;
  totalBytes: number;
  counts?: Record<string, number>;
  description?: string;
  issues: string[];
  exclusions?: string[];
  referenceOnly?: number;
}

export interface V3Status {
  /** Resolved from `backupPolicy` + the connections, exactly like the legacy path. */
  provider: 'oss' | 'webdav' | 'none';
  format: 'legacy' | 'v3';
  autoEnabled: boolean;
  destination: string;
  /** True when a transport could be built for the resolved provider. */
  usable: boolean;
  /** Why the destination cannot be used, when it cannot. */
  unusableReason?: string;
  /** Whether this session holds the backup password. */
  unlocked: boolean;
  passwordEstablished: boolean;
  /** True when the automatic task would actually create a v3 package. */
  canAutoRun: boolean;
  /** Plain-language reason when `canAutoRun` is false. */
  autoReason?: string;
  batches: V3BatchSummary[];
  incomplete: number;
  latest?: ResolvedLatest;
  latestDescription?: string;
  /** Newest complete batch, for the scope lines in the settings panel. */
  latestBatch?: V3BatchSummary;
  /** Device storage mode, so the panel can explain a legacy-format backup in v3 mode. */
  storageMode?: 'local' | 'v3';
  /** Set when the chosen format cannot contain this device's data (see `resolveBackupTarget`). */
  formatWarning?: string;
}

export interface InspectOptions {
  state: HubState;
  libraryId?: string;
  deviceId?: string;
  /** Omit to inspect without decrypting (marker facts only). */
  password?: string | null;
}

function buildTransportFor(state: HubState): { transport?: BackupTransport; provider: 'oss' | 'webdav' | 'none'; reason?: string } {
  const target = resolveBackupTarget(state);
  if (target.provider === 'none') {
    return { provider: 'none', reason: target.reason || '还没有可用的备份目的地。' };
  }
  const created = createTransport({ provider: target.provider, oss: state.obsidianConfig, webdav: state.webdavConfig });
  if (!created.ok) return { provider: target.provider, reason: created.error.userMessage };
  return { transport: created.transport, provider: target.provider };
}

/** Why a v3 automatic run would not happen right now (or nothing when it would). */
export function describeV3AutoConditions(status: {
  provider: 'oss' | 'webdav' | 'none';
  format: 'legacy' | 'v3';
  autoEnabled: boolean;
  unlocked: boolean;
  passwordEstablished: boolean;
  usable: boolean;
  /** Device storage mode; `v3` means a legacy backup cannot contain the user's data. */
  storageMode?: 'local' | 'v3';
}): string | undefined {
  if (status.format !== 'v3') {
    // Two situations look identical from here but need different words: the ordinary
    // "you have not opted in yet", and the trap where business data lives in the v3
    // library while the backup would still write the emptied payload.
    return status.storageMode === 'v3'
      ? '当前存储模式是 v3，而备份格式仍是旧的 state.json：这种备份只包含本机负载（连接与偏好），不含你的资料。请改用 v3 加密备份。'
      : '当前使用旧的 state.json 备份格式；v3 加密备份需要在这里显式启用。';
  }
  if (!status.usable) return '还没有可用的备份目的地，先在「连接与任务」里保存一个连接。';
  if (!status.autoEnabled) return '自动备份任务处于暂停状态。';
  if (!status.unlocked) {
    return status.passwordEstablished
      ? '本次会话还没有解锁备份密码：自动备份不会运行，也不会上传明文。'
      : '还没有建立备份密码：自动备份不会运行，也不会上传明文。';
  }
  return undefined;
}

export async function inspectV3Status(options: InspectOptions): Promise<Result<V3Status>> {
  const libraryId = await resolveLibraryId(options.libraryId);
  const deviceId = options.deviceId ?? getDeviceId();
  const target = resolveBackupTarget(options.state);
  const built = buildTransportFor(options.state);
  const password = options.password ?? null;

  const status: V3Status = {
    provider: built.provider,
    format: target.format,
    autoEnabled: target.enabled,
    destination: built.transport?.description ?? target.destination,
    usable: Boolean(built.transport),
    unusableReason: built.reason,
    unlocked: Boolean(password),
    passwordEstablished: false,
    canAutoRun: false,
    batches: [],
    incomplete: 0,
    // The panel needs to tell "not opted in" from "opted in but storing data elsewhere".
    storageMode: readStorageMode(),
    formatWarning: target.formatWarning
  };

  /**
   * "Would the automatic task create a package right now?" must be answered on
   * every path — the first version only filled it in when no transport could be
   * built, so a fully working v3 setup still showed "not running".
   */
  const finalize = (): V3Status => {
    status.canAutoRun = status.usable && status.format === 'v3' && status.autoEnabled && status.unlocked;
    status.autoReason = describeV3AutoConditions(status);
    return status;
  };

  if (!built.transport) {
    return ok(finalize());
  }

  try {
    const listed = await listGenerations({
      transport: built.transport,
      libraryId,
      deviceId,
      password: password ?? undefined
    });
    if (!listed.ok) return fail(listed.error);
    status.batches = listed.value.map((entry: GenerationListing) => ({
      generationId: entry.generationId,
      complete: entry.complete,
      createdAt: entry.createdAt ?? entry.writtenAt,
      objectCount: entry.objectCount,
      totalBytes: entry.totalBytes,
      counts: entry.counts,
      description: entry.description,
      issues: entry.issues,
      exclusions: entry.exclusions,
      referenceOnly: entry.referenceOnly
    }));
    status.incomplete = status.batches.filter((batch) => !batch.complete).length;
    status.latestBatch = status.batches.find((batch) => batch.complete);

    const resolved = await resolveLatestGeneration({
      transport: built.transport,
      libraryId,
      deviceId,
      password: password ?? undefined
    });
    if (!resolved.ok) return fail(resolved.error);
    status.latest = resolved.value;
    status.latestDescription = describeResolvedLatest(resolved.value);
  } catch (err) {
    return fail(toAppError(err, '无法读取备份目的地'));
  }

  status.passwordEstablished = isBackupPasswordEstablished();
  return ok(finalize());
}

export interface RunV3Options {
  state: HubState;
  password: string | null | undefined;
  libraryId?: string;
  deviceId?: string;
  onProgress?: (stage: string, percent: number) => void;
  /** Skip retention (used by tests and by "just make one copy"). */
  skipPrune?: boolean;
  retain?: { keepLast?: number; keepDays?: number };
}

export interface RunV3Outcome {
  info: BackupGenerationInfo;
  pruned?: PruneResult;
  warnings: string[];
}

export async function runV3Backup(options: RunV3Options): Promise<Result<RunV3Outcome>> {
  const libraryId = await resolveLibraryId(options.libraryId);
  const deviceId = options.deviceId ?? getDeviceId();
  const password = (options.password ?? '').trim();
  /**
   * The new tab owns the dashboard layout; the snapshot serialises the whole state, so it
   * rides along for free once it is in there. Read it here — at the moment of the run,
   * not from whatever `options.state` happened to hold — so a card dragged seconds before
   * the backup is in the package. No-op outside the extension.
   */
  const state = await withFreshNewtabPreferences(options.state);

  if (!password) {
    return fail(
      appError('LOCKED', '需要备份密码才能创建加密备份；本次没有上传任何内容。', {
        safeDetail: 'no session backup password',
        suggestedAction: 'unlock_backup_password'
      })
    );
  }

  const built = buildTransportFor(state);
  if (!built.transport) {
    return fail(
      appError('VALIDATION', built.reason || '还没有可用的备份目的地。', { safeDetail: 'no backup transport' })
    );
  }

  const snapshot = collectSnapshot(state);
  const written = await writeGeneration({
    transport: built.transport,
    libraryId,
    deviceId,
    contentRevision: Number((state as { contentRevision?: number }).contentRevision) || 0,
    password,
    snapshot,
    onProgress: options.onProgress,
    verify: 'full'
  });
  if (!written.ok) return fail(written.error);

  const warnings = [...written.value.warnings];
  let pruned: PruneResult | undefined;
  if (!options.skipPrune) {
    const retention = await pruneGenerations({
      transport: built.transport,
      libraryId,
      deviceId,
      keepLast: options.retain?.keepLast,
      keepDays: options.retain?.keepDays,
      protect: [written.value.generationId]
    });
    if (retention.ok) {
      pruned = retention.value;
    } else {
      // Retention failing is not a failed backup. Say so instead of hiding it.
      warnings.push(`备份已完成，但清理旧批次失败：${retention.error.userMessage}`);
    }
  }

  return ok({ info: written.value, pruned, warnings });
}

/** Retention on demand (the settings page exposes it as an explicit action). */
export async function pruneV3Batches(
  options: Omit<InspectOptions, 'password'> & { dryRun?: boolean }
): Promise<Result<PruneResult>> {
  const built = buildTransportFor(options.state);
  if (!built.transport) {
    return fail(appError('VALIDATION', built.reason || '还没有可用的备份目的地。', { safeDetail: 'no transport' }));
  }
  return pruneGenerations({
    transport: built.transport,
    libraryId: await resolveLibraryId(options.libraryId),
    deviceId: options.deviceId ?? getDeviceId(),
    dryRun: options.dryRun
  });
}

/* -------------------------------------------------------------------------- */
/* Migration packages (§10.3)                                                  */
/* -------------------------------------------------------------------------- */

export interface MigrationExportOptions extends Omit<RunV3Options, 'skipPrune' | 'retain'> {
  /**
   * Must be exactly `true`.
   *
   * §10.3: "需主动选择、说明范围". A boolean that has to be set deliberately (rather
   * than a default) is what stops a credentials export from happening because
   * someone reused the wrong code path.
   */
  confirmCredentialExport: boolean;
}

export async function exportMigrationPackage(options: MigrationExportOptions): Promise<Result<RunV3Outcome>> {
  const libraryId = await resolveLibraryId(options.libraryId);
  const deviceId = options.deviceId ?? getDeviceId();
  const password = (options.password ?? '').trim();

  if (options.confirmCredentialExport !== true) {
    return fail(
      appError('VALIDATION', '导出含凭据的迁移包需要明确确认（并确认已知晓包含哪些凭据）。', {
        safeDetail: 'credential export not confirmed',
        suggestedAction: 'confirm_scope'
      })
    );
  }
  if (!password) {
    return fail(
      appError('LOCKED', '需要备份密码才能创建迁移包；本次没有上传任何内容。', {
        safeDetail: 'no session backup password'
      })
    );
  }

  const built = buildTransportFor(options.state);
  if (!built.transport) {
    return fail(appError('VALIDATION', built.reason || '还没有可用的备份目的地。', { safeDetail: 'no transport' }));
  }

  const snapshot = collectSnapshot(options.state, { includeCredentials: true });
  if (snapshot.scope.credentialScope.length === 0) {
    return fail(
      appError('VALIDATION', '本机没有可导出的连接凭据；普通备份已经包含全部业务数据。', {
        safeDetail: 'no credentials to export'
      })
    );
  }

  const written = await writeGeneration({
    transport: built.transport,
    libraryId,
    deviceId,
    contentRevision: Number((options.state as { contentRevision?: number }).contentRevision) || 0,
    password,
    snapshot,
    purpose: 'migration',
    onProgress: options.onProgress,
    verify: 'full',
    // Deliberately no `latest` pointer: a migration package is not "this device's
    // current backup", and pointing the device at a credentials package would make
    // a restore offer it as a normal backup.
    updateLatest: false
  });
  if (!written.ok) return fail(written.error);

  return ok({ info: written.value, warnings: [...written.value.warnings] });
}

/** List migration packages for this device (needs the password to read manifests). */
export async function listMigrationPackages(
  options: InspectOptions
): Promise<Result<GenerationListing[]>> {
  const built = buildTransportFor(options.state);
  if (!built.transport) {
    return fail(appError('VALIDATION', built.reason || '还没有可用的备份目的地。', { safeDetail: 'no transport' }));
  }
  const listed = await listGenerations({
    transport: built.transport,
    libraryId: await resolveLibraryId(options.libraryId),
    deviceId: options.deviceId ?? getDeviceId(),
    password: (options.password ?? '').trim() || undefined,
    purpose: 'migration'
  });
  return listed.ok ? ok(listed.value) : fail(listed.error);
}

/**
 * Delete one migration package.
 *
 * Deliberately an explicit, one-at-a-time action: retention never touches the
 * migration root (§10.3), so without this a credentials package would sit in the
 * user's bucket forever with no way to remove it. Objects are deleted one by one and
 * the count is reported, so a partial failure is visible rather than silent.
 */
export async function removeMigrationPackage(
  options: InspectOptions & { generationId: string }
): Promise<Result<{ removed: number; failed: Array<{ path: string; reason: string }> }>> {
  const built = buildTransportFor(options.state);
  if (!built.transport) {
    return fail(appError('VALIDATION', built.reason || '还没有可用的备份目的地。', { safeDetail: 'no transport' }));
  }
  const libraryId = await resolveLibraryId(options.libraryId);
  const deviceId = options.deviceId ?? getDeviceId();
  const prefix = generationPrefix(libraryId, deviceId, options.generationId, 'migration');
  try {
    const objects = await built.transport.list(prefix);
    if (objects.length === 0) {
      return fail(appError('NOT_FOUND', '这个迁移包在目的地上已经不存在。', { safeDetail: 'migration package empty' }));
    }
    let removed = 0;
    const failed: Array<{ path: string; reason: string }> = [];
    for (const object of objects) {
      try {
        await built.transport.remove(object.path);
        removed += 1;
      } catch (err) {
        failed.push({ path: object.path, reason: toAppError(err, '删除失败').userMessage });
      }
    }
    return ok({ removed, failed });
  } catch (err) {
    return fail(toAppError(err, '无法删除迁移包'));
  }
}

export interface V3Payload {
  /** The library as it was when this batch was written. */
  state: HubState;
  manifest: BackupManifest;
  marker: CompletionMarker;
  /** Object-level verification problems; empty when everything matched. */
  issues: string[];
}

/**
 * Read one batch's actual contents (§10.4.1).
 *
 * Marker → manifest hash → decrypt manifest → object hashes → decrypt the data
 * object → parse. Anything that fails along the way aborts the read: a restore
 * must never start from a package that only *partly* verified.
 */
export async function readV3Payload(
  options: InspectOptions & {
    generationId: string;
    /**
     * Which library the batch lives under.
     *
     * A package is addressed by (libraryId, deviceId, generationId); a package from
     * *another* library therefore cannot be found by searching the local prefix.
     * Callers that import an external package pass its library id explicitly.
     */
    sourceLibraryId?: string;
    /** Use this transport instead of resolving one from the state. */
    transportOverride?: BackupTransport;
    /** Description for the alternative transport (diagnostics only). */
    destinationLabel?: string;
    /** `backup` (default) or `migration`; picks the root to read from. */
    purpose?: BackupPurpose;
  }
): Promise<Result<V3Payload>> {
  const libraryId = await resolveLibraryId(options.sourceLibraryId ?? options.libraryId);
  const deviceId = options.deviceId ?? getDeviceId();
  const purpose: BackupPurpose = options.purpose ?? 'backup';
  const password = (options.password ?? '').trim();
  if (!password) {
    return fail(appError('LOCKED', '需要备份密码才能读取这个批次。', { safeDetail: 'no password for payload read' }));
  }
  const built = options.transportOverride
    ? { transport: options.transportOverride, provider: 'oss' as const, reason: undefined }
    : buildTransportFor(options.state);
  if (!built.transport) {
    return fail(appError('VALIDATION', built.reason || '还没有可用的备份目的地。', { safeDetail: 'no transport' }));
  }

  const read = await readGeneration({
    transport: built.transport,
    libraryId,
    deviceId,
    generationId: options.generationId,
    password,
    verifyObjects: true,
    purpose
  });
  if (!read.ok) return fail(read.error);
  if (read.value.issues.length > 0) {
    return fail(
      appError('VALIDATION', `这个批次的校验没有通过，不能作为恢复来源：${read.value.issues.join('；')}`, {
        safeDetail: 'object verification failed',
        suggestedAction: 'choose_another_generation'
      })
    );
  }

  const prefix = generationPrefix(libraryId, deviceId, options.generationId, purpose);
  const dataPath =
    read.value.manifest.objects.find((entry) => entry.path === 'objects/state.json')?.path ??
    read.value.manifest.objects[0]?.path;
  if (!dataPath) {
    return fail(appError('VALIDATION', '这个批次里没有数据对象。', { safeDetail: 'manifest has no data object' }));
  }

  const stored = await built.transport.get(`${prefix}${dataPath}`);
  if (stored === null) {
    return fail(appError('NOT_FOUND', '批次的数据对象读不回来。', { safeDetail: 'data object missing' }));
  }
  const key = await deriveBackupKey(password, read.value.marker.salt);
  const decrypted = await decryptObject(key, stored);
  if (!decrypted.ok) return fail(decrypted.error);

  let parsed: unknown;
  try {
    parsed = JSON.parse(decrypted.text);
  } catch {
    return fail(appError('VALIDATION', '备份数据解密后不是有效 JSON。', { safeDetail: 'payload not json' }));
  }
  const validation = validateHubState(parsed);
  if (!validation.isValid) {
    return fail(
      appError('VALIDATION', `备份内容不符合当前数据模型：${validation.errors.slice(0, 3).join('；')}`, {
        safeDetail: 'payload failed validation'
      })
    );
  }

  return ok({
    state: normalizeHubState(parsed),
    manifest: read.value.manifest,
    marker: read.value.marker,
    issues: read.value.issues
  });
}
