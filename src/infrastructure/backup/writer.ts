/**
 * Generation writer, reader and retention (P2-05).
 *
 * Three rules from §10.2/§10.4 are enforced here rather than described in a comment:
 *
 * 1. **Write order is data → manifest → marker.** The marker is written last and
 *    is the only thing that makes a generation restorable, so an upload that dies
 *    halfway cannot be mistaken for a good backup ("中断上传不会出现可恢复成功
 *    标记").
 * 2. **Verification happens after the marker, not instead of it.** A generation is
 *    reported as complete only once the marker is readable, the manifest hash
 *    matches, and (by default) every object is fetched back and re-hashed.
 * 3. **Retention never deletes the only usable backup, another device's
 *    directory, or a generation that was just written.** Pruning runs after a
 *    successful, verified backup — not before one.
 */
import { appError, fail, ok, toAppError, type AppError, type Result } from '../../repositories/errors';
import type { BackupTransport } from './transport';
import { readLatestPointer, writeLatestPointer } from './latest';
import type { SnapshotContents } from './snapshot';
import {
  BACKUP_FORMAT,
  BACKUP_FORMAT_VERSION,
  BACKUP_SCHEMA_VERSION,
  COMPLETION_NAME,
  MANIFEST_NAME,
  BACKUP_CRYPTO_PARAMS,
  assertSafeRelativePath,
  byteLength,
  decryptObject,
  deriveBackupKey,
  describeManifest,
  devicePrefix,
  encryptObject,
  generationPrefix,
  hashStored,
  newGenerationId,
  newSalt,
  verifyCompletion,
  verifyManifestShape,
  verifyObjects,
  type BackupManifest,
  type BackupObjectEntry,
  type BackupPurpose,
  type CompletionMarker
} from './format';

export interface BackupGenerationInfo {
  libraryId: string;
  deviceId: string;
  generationId: string;
  prefix: string;
  manifestPath: string;
  markerPath: string;
  createdAt: number;
  counts: Record<string, number>;
  objectCount: number;
  attachmentCount: number;
  totalBytes: number;
  /** `full` re-downloaded and re-hashed every object after writing the marker. */
  verified: 'marker' | 'full';
  description: string;
  /** Non-fatal problems: the backup itself succeeded. */
  warnings: string[];
}

export interface WriteGenerationOptions {
  transport: BackupTransport;
  libraryId: string;
  deviceId: string;
  contentRevision: number;
  /** Backup password. Must be present; auto-runs use an unlocked session (§10.3). */
  password: string;
  snapshot: SnapshotContents;
  now?: () => number;
  generationId?: string;
  /** Progress for a long upload: stage label plus 0–100. */
  onProgress?: (stage: string, percent: number) => void;
  verify?: 'marker' | 'full';
  /** Remove partial objects when the upload fails. Default true. */
  discardOnFailure?: boolean;
  /**
   * Update this device's `latest` pointer after the generation verified.
   * Default true. The pointer is written strictly after the marker, so it can
   * never name an unproven generation (`latest.ts`).
   */
  updateLatest?: boolean;
  /**
   * Where the generation is written.
   *
   * `migration` uses its own root, so a credentials package cannot be listed as a
   * backup, counted by the status panel or pruned by the retention rules.
   */
  purpose?: BackupPurpose;
}

export type WriteGenerationResult = Result<BackupGenerationInfo>;

export async function writeGeneration(options: WriteGenerationOptions): Promise<WriteGenerationResult> {
  const { transport, snapshot } = options;
  const now = options.now ?? (() => Date.now());
  const verifyMode = options.verify ?? 'full';
  const discardOnFailure = options.discardOnFailure ?? true;

  if (!options.password) {
    // §10.2: a locked credential store must park the task, never upload plaintext.
    return fail(
      appError('LOCKED', '自动备份需要先解锁备份密码；本次没有上传任何内容。', {
        safeDetail: 'backup password missing',
        suggestedAction: 'unlock_backup_password'
      })
    );
  }
  if (!options.libraryId || !options.deviceId) {
    return fail(appError('VALIDATION', '备份缺少库或设备标识。', { safeDetail: 'missing library/device id' }));
  }

  const createdAt = now();
  const generationId = options.generationId ?? newGenerationId(createdAt);
  const purpose: BackupPurpose = options.purpose ?? 'backup';
  const prefix = generationPrefix(options.libraryId, options.deviceId, generationId, purpose);
  const manifestPath = `${prefix}${MANIFEST_NAME}`;
  const markerPath = `${prefix}${COMPLETION_NAME}`;
  const writtenPaths: string[] = [];

  try {
    const salt = newSalt();
    const key = await deriveBackupKey(options.password, salt);
    const entries: BackupObjectEntry[] = [];
    const attachments: BackupObjectEntry[] = [];

    let index = 0;
    for (const object of snapshot.objects) {
      assertSafeRelativePath(object.path);
      const stored = await encryptObject(key, object.text);
      const path = `${prefix}${object.path}`;
      await transport.put(path, stored, 'application/json');
      writtenPaths.push(path);
      entries.push({
        path: object.path,
        length: byteLength(stored),
        hash: await hashStored(stored),
        kind: object.kind,
        description: object.description
      });
      index += 1;
      options.onProgress?.('写入数据', Math.round((index / (snapshot.objects.length + 2)) * 100));
    }

    // Attachments are listed separately: a restore preview has to be able to say
    // "3 attachments are missing" rather than "some objects are missing".
    for (const entry of entries.filter((e) => e.kind === 'attachment')) attachments.push(entry);

    const manifest: BackupManifest = {
      format: BACKUP_FORMAT,
      formatVersion: BACKUP_FORMAT_VERSION,
      purpose,
      // Taken from the snapshot rather than from a separate flag: the manifest must
      // describe what is actually in the objects, not what the caller intended.
      includesCredentials: snapshot.scope.includesCredentials === true,
      libraryId: options.libraryId,
      deviceId: options.deviceId,
      generationId,
      createdAt,
      schemaVersion: BACKUP_SCHEMA_VERSION,
      contentRevision: options.contentRevision,
      counts: snapshot.counts,
      objects: entries.filter((e) => e.kind === 'data'),
      attachments,
      exclusions: snapshot.exclusions,
      crypto: {
        ...BACKUP_CRYPTO_PARAMS,
        salt,
        perObjectIv: true
      },
      completion: null,
      scope: {
        referenceOnly: snapshot.scope.referenceOnly,
        totalBytes: snapshot.scope.totalBytes,
        credentialScope: snapshot.scope.credentialScope.length > 0 ? snapshot.scope.credentialScope : undefined
      }
    };

    const storedManifest = await encryptObject(key, JSON.stringify(manifest));
    await transport.put(manifestPath, storedManifest, 'application/json');
    writtenPaths.push(manifestPath);
    const manifestHash = await hashStored(storedManifest);
    options.onProgress?.('写入清单', Math.round(((snapshot.objects.length + 1) / (snapshot.objects.length + 2)) * 100));

    const marker: CompletionMarker = {
      format: BACKUP_FORMAT,
      formatVersion: BACKUP_FORMAT_VERSION,
      libraryId: options.libraryId,
      deviceId: options.deviceId,
      generationId,
      manifestPath,
      manifestHash,
      salt,
      objectCount: entries.length,
      totalBytes: entries.reduce((sum, entry) => sum + entry.length, 0),
      writtenAt: now()
    };
    // Last write. Everything before this point is provisional.
    await transport.put(markerPath, JSON.stringify(marker), 'application/json');
    writtenPaths.push(markerPath);
    options.onProgress?.('写入完成标记', 100);

    // Verify what is actually stored, not what we intended to store.
    const readBack = await transport.get(markerPath);
    if (readBack === null) {
      throw appError('NETWORK_UNREACHABLE', '上传后读不回完成标记，本次备份按未完成处理。', {
        safeDetail: 'marker unreadable after put'
      });
    }
    const completion = verifyCompletion(JSON.parse(readBack) as CompletionMarker, manifestHash);
    if (!completion.ok) {
      throw appError('VALIDATION', `完成标记校验失败：${completion.issues.join('；')}`, {
        safeDetail: 'completion mismatch'
      });
    }
    if (verifyMode === 'full') {
      const objects = await verifyObjects(manifest, (relative) => transport.get(`${prefix}${relative}`));
      if (!objects.ok) {
        throw appError('VALIDATION', `备份校验失败：${objects.issues.join('；')}`, { safeDetail: 'object hash mismatch' });
      }
    }

    // Only now — after the marker exists and the stored bytes were verified — may
    // this device claim the generation as its current backup.
    const warnings: string[] = [];
    if (options.updateLatest !== false) {
      try {
        await writeLatestPointer(transport, {
          format: BACKUP_FORMAT,
          formatVersion: BACKUP_FORMAT_VERSION,
          libraryId: manifest.libraryId,
          deviceId: manifest.deviceId,
          generationId,
          manifestHash,
          createdAt,
          writtenAt: now(),
          objectCount: entries.length,
          totalBytes: marker.totalBytes
        });
      } catch (err) {
        // The generation is still a valid backup; without the pointer a restore
        // falls back to scanning complete generations.
        const error = toAppError(err, '无法更新本设备的最新备份指针');
        warnings.push(`备份已完成，但本设备指针未更新：${error.userMessage}`);
      }
    }

    return ok({
      libraryId: manifest.libraryId,
      deviceId: manifest.deviceId,
      generationId,
      prefix,
      manifestPath,
      markerPath,
      createdAt,
      counts: manifest.counts,
      objectCount: manifest.objects.length,
      attachmentCount: manifest.attachments.length,
      totalBytes: snapshot.scope.totalBytes,
      verified: verifyMode,
      description: describeManifest(manifest),
      warnings
    });
  } catch (err) {
    const error = toAppError(err, '备份上传失败');
    if (discardOnFailure) {
      // Partial objects are never restorable, but leaving them behind makes a
      // destination look like it has more history than it does.
      for (const path of writtenPaths) {
        try {
          await transport.remove(path);
        } catch {
          /* best effort: an orphan without a marker is ignored by every reader */
        }
      }
    }
    return fail(error);
  }
}

export interface ReadGenerationResult {
  manifest: BackupManifest;
  manifestHash: string;
  marker: CompletionMarker;
  /** Issues from the object re-hash; empty when everything matched. */
  issues: string[];
}

/** Read one generation, refusing anything without a valid completion marker. */
export async function readGeneration(options: {
  transport: BackupTransport;
  libraryId: string;
  deviceId: string;
  generationId: string;
  password: string;
  verifyObjects?: boolean;
  purpose?: BackupPurpose;
}): Promise<Result<ReadGenerationResult>> {
  const prefix = generationPrefix(options.libraryId, options.deviceId, options.generationId, options.purpose ?? 'backup');
  const markerPath = `${prefix}${COMPLETION_NAME}`;
  try {
    const markerRaw = await options.transport.get(markerPath);
    if (markerRaw === null) {
      return fail(
        appError('NOT_FOUND', '这个备份批次没有完成标记，不能作为恢复来源。', {
          safeDetail: 'missing completion marker',
          suggestedAction: 'choose_another_generation'
        })
      );
    }

    let marker: CompletionMarker;
    try {
      marker = JSON.parse(markerRaw) as CompletionMarker;
    } catch {
      return fail(appError('VALIDATION', '完成标记无法解析。', { safeDetail: 'bad marker json' }));
    }

    const manifestPath = marker.manifestPath || `${prefix}${MANIFEST_NAME}`;
    const storedManifest = await options.transport.get(manifestPath);
    if (storedManifest === null) {
      return fail(appError('NOT_FOUND', '备份清单缺失，这个批次不完整。', { safeDetail: 'manifest missing' }));
    }
    const manifestHash = await hashStored(storedManifest);
    const completion = verifyCompletion(marker, manifestHash);
    if (!completion.ok) {
      return fail(
        appError('VALIDATION', `备份批次校验失败：${completion.issues.join('；')}`, { safeDetail: 'marker mismatch' })
      );
    }

    if (!options.password) {
      return fail(appError('LOCKED', '读取备份清单需要备份密码。', { safeDetail: 'missing password for read' }));
    }
    if (!marker.salt) {
      return fail(
        appError('VALIDATION', '这个备份批次缺少加密参数，无法解密。', { safeDetail: 'marker has no salt' })
      );
    }
    const key = await deriveBackupKey(options.password, marker.salt);
    const decrypted = await decryptObject(key, storedManifest);
    if (!decrypted.ok) return fail(decrypted.error);

    let parsed: unknown;
    try {
      parsed = JSON.parse(decrypted.text);
    } catch {
      return fail(appError('VALIDATION', '备份清单解密后不是有效 JSON。', { safeDetail: 'manifest not json' }));
    }
    const shape = verifyManifestShape(parsed);
    if (!shape.ok) {
      return fail(appError('VALIDATION', `备份清单结构不正确：${shape.issues.join('；')}`, { safeDetail: 'bad manifest shape' }));
    }

    let issues: string[] = [];
    if (options.verifyObjects !== false) {
      const verified = await verifyObjects(shape.manifest, (relative) => options.transport.get(`${prefix}${relative}`));
      issues = verified.issues;
    }

    return ok({ manifest: shape.manifest, manifestHash, marker, issues });
  } catch (err) {
    return fail(toAppError(err, '读取备份批次失败'));
  }
}

export interface GenerationListing {
  generationId: string;
  complete: boolean;
  issues: string[];
  objectCount: number;
  totalBytes: number;
  writtenAt?: number;
  createdAt?: number;
  counts?: Record<string, number>;
  description?: string;
  /** Scope statement from the manifest; only available when a password was given. */
  exclusions?: string[];
  /** Remote documents referenced but not downloaded. */
  referenceOnly?: number;
  /** `migration` for credentials packages; needs a password to read. */
  purpose?: BackupPurpose;
  /** True when connection secrets are inside (migration packages only). */
  includesCredentials?: boolean;
  credentialScope?: string[];
}

export interface ListGenerationsOptions {
  transport: BackupTransport;
  libraryId: string;
  deviceId: string;
  /** Without a password only marker facts are reported (no decrypting). */
  password?: string;
  /** Which root to list. Defaults to the backup root. */
  purpose?: BackupPurpose;
}

/** List this device's generations, newest first, marking incomplete ones. */
export async function listGenerations(options: ListGenerationsOptions): Promise<Result<GenerationListing[]>> {
  const purpose: BackupPurpose = options.purpose ?? 'backup';
  const prefix = devicePrefix(options.libraryId, options.deviceId, purpose);
  try {
    const objects = await options.transport.list(prefix);
    // A generation id is only an id when something follows it in the path. Without
    // this, the device-level `latest.json` pointer (a top-level *file*) was parsed
    // as a generation named "latest.json" and showed up as a phantom incomplete
    // batch — found by running the real OSS transport, whose listing returns the
    // pointer alongside the generations.
    const ids = new Set<string>();
    for (const object of objects) {
      const parts = object.path.slice(prefix.length).split('/');
      if (parts.length < 2 || !parts[0]) continue;
      ids.add(parts[0]);
    }

    const listings: GenerationListing[] = [];
    for (const generationId of ids) {
      const generation = generationPrefix(options.libraryId, options.deviceId, generationId, purpose);
      const markerRaw = await options.transport.get(`${generation}${COMPLETION_NAME}`);
      if (markerRaw === null) {
        listings.push({ generationId, complete: false, issues: ['没有完成标记'], objectCount: 0, totalBytes: 0 });
        continue;
      }
      let marker: CompletionMarker | null = null;
      try {
        marker = JSON.parse(markerRaw) as CompletionMarker;
      } catch {
        listings.push({ generationId, complete: false, issues: ['完成标记无法解析'], objectCount: 0, totalBytes: 0 });
        continue;
      }
      const base: GenerationListing = {
        generationId,
        complete: true,
        issues: [],
        objectCount: Number(marker.objectCount) || 0,
        totalBytes: Number(marker.totalBytes) || 0,
        writtenAt: marker.writtenAt
      };

      if (!options.password) {
        listings.push(base);
        continue;
      }
      const read = await readGeneration({
        transport: options.transport,
        libraryId: options.libraryId,
        deviceId: options.deviceId,
        generationId,
        password: options.password,
        verifyObjects: false,
        purpose
      });
      if (!read.ok) {
        listings.push({ ...base, complete: false, issues: [read.error.userMessage] });
        continue;
      }
      listings.push({
        ...base,
        createdAt: read.value.manifest.createdAt,
        counts: read.value.manifest.counts,
        description: describeManifest(read.value.manifest),
        exclusions: read.value.manifest.exclusions,
        referenceOnly: read.value.manifest.scope.referenceOnly.length,
        purpose: read.value.manifest.purpose,
        includesCredentials: read.value.manifest.includesCredentials,
        credentialScope: read.value.manifest.scope.credentialScope
      });
    }

    listings.sort((a, b) => (b.createdAt ?? b.writtenAt ?? 0) - (a.createdAt ?? a.writtenAt ?? 0));
    return ok(listings);
  } catch (err) {
    return fail(toAppError(err, '无法列出备份批次'));
  }
}

export interface PruneOptions {
  transport: BackupTransport;
  libraryId: string;
  deviceId: string;
  now?: number;
  /** §10.2: keep the most recent N successful backups. */
  keepLast?: number;
  /** §10.2: keep one per day for the last N days. */
  keepDays?: number;
  /** Generations to protect even if they look old (e.g. the one just written). */
  protect?: string[];
  dryRun?: boolean;
}

export interface PruneResult {
  removed: string[];
  kept: string[];
  skipped: Array<{ generationId: string; reason: string }>;
  /** Set when pruning was refused outright. */
  refused?: string;
  /** The device's current generation, always protected from retention. */
  protectedByPointer?: string;
}

/**
 * Retention: last 10 successful generations plus one per day for 30 days.
 *
 * Only complete generations from **this device** are considered (the caller passes
 * one device prefix), and pruning refuses outright when it would delete the last
 * restorable generation — losing every backup to a retention rule would be worse
 * than keeping one too many.
 */
export async function pruneGenerations(options: PruneOptions): Promise<Result<PruneResult>> {
  const now = options.now ?? Date.now();
  const keepLast = options.keepLast ?? 10;
  const keepDays = options.keepDays ?? 30;
  const protect = new Set(options.protect ?? []);

  // The generation this device currently points at is never a retention
  // candidate: deleting the backup a restore would offer by default is the one
  // outcome worse than keeping an extra copy.
  const pointerRead = await readLatestPointer(options.transport, options.libraryId, options.deviceId);
  const protectedByPointer = pointerRead.ok ? pointerRead.pointer.generationId : undefined;
  if (protectedByPointer) protect.add(protectedByPointer);

  const listed = await listGenerations({
    transport: options.transport,
    libraryId: options.libraryId,
    deviceId: options.deviceId
  });
  if (!listed.ok) return fail(listed.error);

  const complete = listed.value.filter((entry) => entry.complete);
  const incomplete = listed.value.filter((entry) => !entry.complete);
  const result: PruneResult = { removed: [], kept: [], skipped: [], protectedByPointer };

  for (const entry of incomplete) {
    result.skipped.push({ generationId: entry.generationId, reason: '未完成批次，保留待人工清理' });
  }

  if (complete.length <= 1) {
    result.kept.push(...complete.map((entry) => entry.generationId));
    result.refused = '只剩一个可用的备份批次，不做清理。';
    return ok(result);
  }

  const sorted = [...complete].sort((a, b) => (b.createdAt ?? b.writtenAt ?? 0) - (a.createdAt ?? a.writtenAt ?? 0));
  const keep = new Set<string>(protect);
  sorted.slice(0, keepLast).forEach((entry) => keep.add(entry.generationId));

  const seenDays = new Set<string>();
  for (const entry of sorted) {
    const at = entry.createdAt ?? entry.writtenAt;
    if (!at) continue;
    const ageDays = (now - at) / 86_400_000;
    // "保留最近 30 天每日一份" is 30 days including today, so exactly-30-days-old is
    // outside the window.
    if (ageDays >= keepDays) continue;
    const day = new Date(at).toISOString().slice(0, 10);
    if (seenDays.has(day)) continue;
    seenDays.add(day);
    keep.add(entry.generationId);
  }

  const removable = sorted.filter((entry) => !keep.has(entry.generationId));
  if (removable.length > 0 && complete.length - removable.length < 1) {
    result.kept.push(...sorted.map((entry) => entry.generationId));
    result.refused = '清理会删掉所有可用备份，已取消本次清理。';
    return ok(result);
  }

  for (const entry of removable) {
    if (options.dryRun) {
      result.removed.push(entry.generationId);
      continue;
    }
    const prefix = generationPrefix(options.libraryId, options.deviceId, entry.generationId);
    try {
      const objects = await options.transport.list(prefix);
      for (const object of objects) await options.transport.remove(object.path);
      result.removed.push(entry.generationId);
    } catch (err) {
      const error = toAppError(err, '清理备份批次失败');
      result.skipped.push({ generationId: entry.generationId, reason: error.userMessage });
    }
  }

  result.kept.push(...sorted.filter((entry) => keep.has(entry.generationId)).map((entry) => entry.generationId));
  return ok(result);
}
