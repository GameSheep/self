/**
 * v3 restore: preview, then apply (P2-06).
 * §10.4 is the contract this file implements, and its first two steps are the ones
 * that are easy to skip and expensive to skip:
 * · hash or object hashes do not line up, so a restore never starts from a package
 */
import { appError, fail, ok, type Result } from '../../repositories/errors';
import type { HubState } from '../../types';
import { mergeRestoredState } from '../../lib/stateBackup';
import { V2_KNOWN_FIELDS } from '../../repositories/migration/mapping';
import { LOCAL_LIBRARY_ID, readV3Payload } from './backupService';
import { applyCredentialImport, planCredentialImport, type CredentialTransferPlan } from './credentialTransfer';
import { readBundle } from './bundleFile';
import type { BackupManifest } from './format';
import type { BackupTransport } from './transport';

/** Collections that participate in a restore, in the order users see them. */
export const RESTORE_COLLECTIONS = [
  'sites',
  'notes',
  'annotations',
  'handwritings',
  'projects',
  'servers',
  'secrets',
  'reminders',
  'checkIns',
  'inbox',
  'wucaiHighlights',
  'youdaoNotes'
] as const;

export type RestoreCollection = (typeof RESTORE_COLLECTIONS)[number];

/** Collections whose ids are referenced by other collections. */
const REFERENCE_FIELDS: Array<{ collection: 'projects'; fields: string[] }> = [
  { collection: 'projects', fields: ['noteIds', 'siteIds', 'serverIds', 'reminderIds', 'secretIds'] }
];

export type ConflictStrategy = 'keep-local' | 'use-backup' | 'keep-both';

export interface RestoreConflict {
  collection: string;
  id: string;
  label: string;
  /** True when the two versions differ; identical rows are not conflicts. */
  differs: boolean;
}

export interface RestorePreview {
  previewId: string;
  generationId: string;
  packageLibraryId: string;
  localLibraryId: string;
  sameLibrary: boolean;
  /** `migration` when the batch came from the migration root. */
  purpose: 'backup' | 'migration';
  /** True when the package carries connection secrets (migration packages). */
  includesCredentials: boolean;
  /** What the package says is inside, credential-wise. */
  credentialScope: string[];
  /** Per-service decision about importing those credentials. */
  credentialPlans: CredentialTransferPlan[];
  createdAt: number;
  packageCounts: Record<string, number>;
  localCounts: Record<string, number>;
  /** Ids that exist only in the package. */
  added: Record<string, number>;
  conflicts: RestoreConflict[];
  conflictCounts: Record<string, number>;
  identicalCount: number;
  missingAttachments: Array<{ itemId: string; name: string }>;
  referenceOnly: string[];
  exclusions: string[];
  unsupportedFields: string[];
  credentialNote: string;
  vaultNote: string;
  /** How many entities would be renamed because the package is another library. */
  idMappingCount: number;
  totalRecords: number;
  baselineFingerprint: string;
  warnings: string[];
}

export interface RestoreApplyResult {
  applied: Record<string, number>;
  conflictsResolved: number;
  keptLocal: number;
  copies: number;
  remapped: number;
  pending: string[];
  /** Credential labels taken from a migration package. */
  credentialsImported: string[];
  /** Credentials deliberately left alone or refused. */
  credentialsSkipped: Array<{ label: string; reason: string }>;
  /** Connections whose stored test result was dropped (they must be re-tested). */
  connectionsToRetest: string[];
}

interface StagedPackage {
  preview: RestorePreview;
  state: HubState;
  at: number;
}

/**
 * Staging area.
 * Deliberately in memory: §10.4.2 says the package is parsed "在暂存区" and the
 * current library is not modified. Keeping the decrypted library only in memory
 */
const stagingArea = new Map<string, StagedPackage>();
const STAGING_LIMIT = 3;
const STAGING_TTL_MS = 30 * 60 * 1000;

function rememberStaged(staged: StagedPackage): void {
  const now = Date.now();
  for (const [key, value] of stagingArea) {
    if (now - value.at > STAGING_TTL_MS) stagingArea.delete(key);
  }
  stagingArea.set(staged.preview.previewId, staged);
  while (stagingArea.size > STAGING_LIMIT) {
    const oldest = stagingArea.keys().next().value as string | undefined;
    if (!oldest) break;
    stagingArea.delete(oldest);
  }
}

export function getStaged(previewId: string): StagedPackage | undefined {
  const staged = stagingArea.get(previewId);
  if (!staged) return undefined;
  if (Date.now() - staged.at > STAGING_TTL_MS) {
    stagingArea.delete(previewId);
    return undefined;
  }
  return staged;
}

/* -------------------------------------------------------------------------- */
/* Fingerprint                                                                 */
/* -------------------------------------------------------------------------- */

/** Deterministic serialisation: object keys sorted, arrays in order. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
}

/**
 * Content fingerprint of the local library.
 *
 * Used as the preview baseline. It covers *content*, not the moment of writing, so
 * a save that changed nothing does not force a re-preview.
 */
export async function fingerprintState(state: HubState): Promise<string> {
  const text = stableStringify(state);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/* -------------------------------------------------------------------------- */
/* Preview                                                                     */
/* -------------------------------------------------------------------------- */

function rowsOf(state: HubState, collection: RestoreCollection): Array<Record<string, unknown>> {
  const value = (state as unknown as Record<string, unknown>)[collection];
  return Array.isArray(value) ? (value as Array<Record<string, unknown>>) : [];
}

function idOf(collection: RestoreCollection, row: Record<string, unknown>): string {
  void collection;
  return String(row.id ?? '');
}

function labelOf(collection: RestoreCollection, row: Record<string, unknown>): string {
  const candidates = ['title', 'name', 'pageTitle', 'content'];
  for (const key of candidates) {
    const value = row[key];
    if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 60);
  }
  return idOf(collection, row);
}

/** Top-level keys the current model knows about. */
const KNOWN_ROOT_KEYS = new Set([
  'schemaVersion',
  'theme',
  'sites',
  'servers',
  'secrets',
  'checkIns',
  'reminders',
  'notes',
  'handwritings',
  'inbox',
  'projects',
  'annotations',
  'gotabPrefs',
  'obsidianConfig',
  'obsidianNotes',
  'wucaiConfig',
  'wucaiHighlights',
  'youdaoConfig',
  'youdaoNotes',
  'aiConfig',
  'cloudflareSync',
  'webdavConfig',
  'backupPolicy',
  'homeBlocks',
  'connectionTests',
  'purposes',
  'sampleBatch',
  'features',
  'categories'
]);

function collectUnsupported(packageState: HubState): string[] {
  const out: string[] = [];
  const root = packageState as unknown as Record<string, unknown>;
  for (const key of Object.keys(root)) {
    if (!KNOWN_ROOT_KEYS.has(key)) out.push(`根级字段 ${key}`);
  }
  for (const collection of RESTORE_COLLECTIONS) {
    const known = new Set(V2_KNOWN_FIELDS[collection] ?? []);
    for (const row of rowsOf(packageState, collection)) {
      for (const field of Object.keys(row)) {
        if (!known.has(field)) out.push(`${collection}.${field}`);
      }
    }
  }
  return Array.from(new Set(out)).slice(0, 50);
}

export interface PreviewOptions {
  state: HubState;
  password: string | null | undefined;
  generationId: string;
  libraryId?: string;
  deviceId?: string;
  /** Library the package lives under, when it is not the local one. */
  sourceLibraryId?: string;
  /** Explicit transport (tests / non-connection destinations). */
  transport?: BackupTransport;
  /** Which root the package is in. Defaults to the backup root. */
  purpose?: 'backup' | 'migration';
}

export async function previewRestore(options: PreviewOptions): Promise<Result<RestorePreview>> {
  const localLibraryId = options.libraryId ?? LOCAL_LIBRARY_ID;
  const payload = await readV3Payload({
    state: options.state,
    password: options.password,
    generationId: options.generationId,
    libraryId: localLibraryId,
    deviceId: options.deviceId,
    sourceLibraryId: options.sourceLibraryId,
    transportOverride: options.transport,
    purpose: options.purpose
  });
  if (!payload.ok) return fail(payload.error);

  const preview = await stagePreview({
    packageState: payload.value.state,
    manifest: payload.value.manifest,
    localState: options.state,
    localLibraryId,
    generationId: options.generationId
  });
  return ok(preview);
}

/**
 * Build (and stage) the diff report for an already-verified package.
 * Shared by the remote-batch path and the single-file bundle path: both end up with
 * a decrypted library + manifest, and both must produce exactly the same report. If
 */
async function stagePreview(input: {
  packageState: HubState;
  manifest: BackupManifest;
  localState: HubState;
  localLibraryId: string;
  generationId: string;
}): Promise<RestorePreview> {
  const { packageState, manifest, localState } = input;
  const localLibraryId = input.localLibraryId;
  const packageLibraryId = manifest.libraryId;
  const sameLibrary = packageLibraryId === localLibraryId;
  const baselineFingerprint = await fingerprintState(localState);

  const packageCounts: Record<string, number> = {};
  const localCounts: Record<string, number> = {};
  const added: Record<string, number> = {};
  const conflictCounts: Record<string, number> = {};
  const conflicts: RestoreConflict[] = [];
  let identicalCount = 0;
  let totalRecords = 0;

  for (const collection of RESTORE_COLLECTIONS) {
    const packageRows = rowsOf(packageState, collection);
    const localRows = rowsOf(localState, collection);
    packageCounts[collection] = packageRows.length;
    localCounts[collection] = localRows.length;
    totalRecords += packageRows.length;

    const localById = new Map(localRows.map((row) => [idOf(collection, row), row]));
    let addedCount = 0;
    for (const row of packageRows) {
      const id = idOf(collection, row);
      const local = localById.get(id);
      if (!local) {
        addedCount += 1;
        continue;
      }
      if (stableStringify(local) === stableStringify(row)) {
        identicalCount += 1;
        continue;
      }
      conflicts.push({ collection, id, label: labelOf(collection, row), differs: true });
      conflictCounts[collection] = (conflictCounts[collection] ?? 0) + 1;
    }
    if (addedCount > 0) added[collection] = addedCount;
  }

  // Attachments: the manifest lists what the package actually carries.
  const attachmentIds = new Set(
    manifest.attachments
      .map((entry) => /handwriting-(.+)\.png$/.exec(entry.path)?.[1])
      .filter((value): value is string => Boolean(value))
  );
  const missingAttachments = rowsOf(packageState, 'handwritings')
    .filter((row) => String(row.dataUrl ?? '').length > 0 && !attachmentIds.has(String(row.id ?? '')))
    .map((row) => ({ itemId: String(row.id ?? ''), name: labelOf('handwritings', row) }));

  // Remote documents whose body is not in the package. `obsidianNotes` is a model
  // field rather than one of RESTORE_COLLECTIONS' entity lists, so it is read here
  // directly instead of through `rowsOf`.
  const packageRemoteRows = Array.isArray(packageState.obsidianNotes) ? packageState.obsidianNotes : [];
  const referenceOnly = [
    ...manifest.scope.referenceOnly,
    ...packageRemoteRows
      .filter((row) => !row.content)
      .map((row) => `obsidianNotes/${String(row.key ?? row.path ?? '')}`)
  ];
  const uniqueReferenceOnly = Array.from(new Set(referenceOnly));

  const idMappingCount = sameLibrary ? 0 : totalRecords;
  const unsupportedFields = collectUnsupported(packageState);

  const warnings: string[] = [];
  if (!sameLibrary) {
    warnings.push(
      `这个批次来自另一个库（${packageLibraryId}），其中的条目会以「${packageLibraryId}:原id」的形式导入，不会与本机同 id 的记录混在一起。`
    );
  }
  if (missingAttachments.length > 0) {
    warnings.push(`有 ${missingAttachments.length} 个手绘在本机附件清单里找不到对应对象，恢复后可能打不开。`);
  }
  if (uniqueReferenceOnly.length > 0) {
    warnings.push(`有 ${uniqueReferenceOnly.length} 个远端文件只有引用，恢复后需要联网读取。`);
  }
  if (manifest.scope.referenceOnly.length > 0 || !manifest.attachments.length) {
    warnings.push('包内只有本机已下载的内容；未下载的远端正文不在其中（引用备份，不是完整离线备份）。');
  }

  const preview: RestorePreview = {
    previewId: `preview-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    generationId: input.generationId,
    packageLibraryId,
    localLibraryId,
    sameLibrary,
    purpose: manifest.purpose,
    includesCredentials: manifest.includesCredentials,
    credentialScope: manifest.scope.credentialScope ?? [],
    credentialPlans: manifest.includesCredentials ? planCredentialImport(packageState, localState) : [],
    createdAt: manifest.createdAt,
    packageCounts,
    localCounts,
    added,
    conflicts,
    conflictCounts,
    identicalCount,
    missingAttachments,
    // `obsidianNotes` is part of the model but not of RESTORE_COLLECTIONS above.
    referenceOnly: uniqueReferenceOnly,
    exclusions: manifest.exclusions,
    unsupportedFields,
    credentialNote:
      manifest.includesCredentials
        ? '这是一个迁移包：它包含连接凭据。你可以选择是否把它们导入本机；导入只会补上本机还没有的连接，已配置不同账号的服务会被跳过，不会用包里的密钥覆盖它。'
        : '这个批次里没有连接密钥（OSS Secret、WebDAV 密码、AI Key、同步密钥在备份时已移除）。恢复会保留本机已保存的密钥，不会用空值覆盖它们；恢复后建议到「连接与任务」重新测试一次。',
    vaultNote:
      '金库条目保存的是密文：恢复后仍然需要原来的金库主密码才能查看。备份密码只能解开外层备份包，不等于解开金库。',
    idMappingCount,
    totalRecords,
    baselineFingerprint,
    warnings
  };

  rememberStaged({ preview, state: packageState, at: Date.now() });
  return preview;
}

/**
 * Preview a single-file bundle (§9.1 web↔extension exchange).
 *
 * Same preview/apply pipeline as a remote batch: the file is verified, decrypted and
 * then handed to `stagePreview`, so the conflict rules, the baseline check and the
 * credential rules are literally the same code.
 */
export async function previewBundleFile(options: {
  state: HubState;
  password: string | null | undefined;
  json: string;
  libraryId?: string;
}): Promise<Result<RestorePreview>> {
  const read = await readBundle(options.json, options.password);
  if (!read.ok) return fail(read.error);
  const preview = await stagePreview({
    packageState: read.value.state,
    manifest: read.value.manifest,
    localState: options.state,
    localLibraryId: options.libraryId ?? LOCAL_LIBRARY_ID,
    generationId: read.value.manifest.generationId
  });
  return ok(preview);
}

/* -------------------------------------------------------------------------- */
/* Apply                                                                       */
/* -------------------------------------------------------------------------- */

export interface ApplyOptions {
  state: HubState;
  previewId: string;
  mode: 'merge' | 'replace';
  /** Per-collection conflict decision; unlisted collections keep the local row. */
  conflicts?: Record<string, ConflictStrategy>;
  /**
   * Import the migration package's connection credentials.
   *
   * Explicit, and only meaningful for a package that carries any: a backup has no
   * credentials to import, and a migration package defaults to *not* touching the
   * local connections.
   */
  importCredentials?: boolean;
  /** Restrict the import to these services; default is every `adopt` plan. */
  credentialServices?: string[];
}

export interface ApplyOutcome {
  state: HubState;
  report: RestoreApplyResult;
}

/** Deterministic namespaced id: importing the same package twice is idempotent. */
export function namespacedId(packageLibraryId: string, id: string): string {
  return `${packageLibraryId}:${id}`;
}

function rewriteReferences(
  rows: Array<Record<string, unknown>>,
  idMap: Map<string, string>
): Array<Record<string, unknown>> {
  if (idMap.size === 0) return rows;
  return rows.map((row) => {
    let next = row;
    for (const { fields } of REFERENCE_FIELDS) {
      for (const field of fields) {
        const value = row[field];
        if (!Array.isArray(value)) continue;
        const mapped = value.map((entry) => (typeof entry === 'string' && idMap.has(entry) ? idMap.get(entry)! : entry));
        if (mapped.some((entry, index) => entry !== value[index])) {
          next = { ...next, [field]: mapped };
        }
      }
    }
    if (typeof row.targetId === 'string' && idMap.has(row.targetId)) {
      next = { ...next, targetId: idMap.get(row.targetId)! };
    }
    return next;
  });
}

export async function applyRestore(options: ApplyOptions): Promise<Result<ApplyOutcome>> {
  const staged = getStaged(options.previewId);
  if (!staged) {
    return fail(
      appError('NOT_FOUND', '这次预览已经失效（可能刷新过页面，或预览超过 30 分钟）。请重新预览一次。', {
        safeDetail: 'staged preview missing',
        suggestedAction: 'preview_again'
      })
    );
  }

  const currentFingerprint = await fingerprintState(options.state);
  if (currentFingerprint !== staged.preview.baselineFingerprint) {
    return fail(
      appError(
        'REVISION_CONFLICT',
        '预览之后本机数据又有改动，为避免覆盖这些改动，这次恢复没有执行。请重新预览并确认差异。',
        { safeDetail: 'baseline fingerprint changed', suggestedAction: 'preview_again' }
      )
    );
  }

  const packageState = staged.state;
  const preview = staged.preview;
  const idMap = new Map<string, string>();
  const applied: Record<string, number> = {};
  const pending: string[] = [];
  let conflictsResolved = 0;
  let keptLocal = 0;
  let copies = 0;

  let base: HubState = { ...options.state };

  // Credentials and preferences are merged, never taken from the package: the
  // package has no secrets, and an older preference snapshot must not blank the
  // local ones the user has since changed.
  const mergedShell = mergeRestoredState(packageState, options.state);

  for (const collection of RESTORE_COLLECTIONS) {
    const packageRows = rowsOf(packageState, collection);
    const localRows = rowsOf(options.state, collection);
    const localById = new Map(localRows.map((row) => [idOf(collection, row), row]));
    const result: Array<Record<string, unknown>> = options.mode === 'replace' ? [] : [...localRows];
    const resultById = new Map(result.map((row) => [idOf(collection, row), row]));
    /**
     * Replace mode replaces the collection wholesale, so per-item conflict choices
     * do not apply — asking "keep local?" while replacing would silently drop the
     * very rows the user asked to restore. (The first version did exactly that:
     * a replacing restore lost every conflicting row.) Strategies are therefore
     * only consulted in merge mode.
     */
    const strategy: ConflictStrategy =
      options.mode === 'replace' ? 'use-backup' : options.conflicts?.[collection] ?? 'keep-local';
    let appliedCount = 0;

    for (const row of packageRows) {
      const originalId = idOf(collection, row);
      const mappedId = preview.sameLibrary ? originalId : namespacedId(preview.packageLibraryId, originalId);
      const mappedRow = mappedId === originalId ? row : { ...row, id: mappedId };
      if (mappedId !== originalId) idMap.set(originalId, mappedId);

      const local = localById.get(originalId);
      if (!local) {
        if (!resultById.has(mappedId)) {
          result.push(mappedRow);
          resultById.set(mappedId, mappedRow);
          appliedCount += 1;
        }
        continue;
      }
      if (stableStringify(local) === stableStringify(row)) continue;

      conflictsResolved += 1;
      if (strategy === 'use-backup') {
        const index = result.findIndex((entry) => idOf(collection, entry) === originalId);
        if (index >= 0) result[index] = mappedRow;
        else result.push(mappedRow);
        resultById.set(mappedId, mappedRow);
        appliedCount += 1;
      } else if (strategy === 'keep-both') {
        const copyId = `${mappedId}~restored-${new Date(preview.createdAt).toISOString().slice(0, 10)}`;
        if (!resultById.has(copyId)) {
          const copyRow = { ...row, id: copyId };
          result.push(copyRow);
          resultById.set(copyId, copyRow);
          idMap.set(originalId, copyId);
          copies += 1;
          appliedCount += 1;
        }
      } else {
        keptLocal += 1;
      }
    }

    applied[collection] = appliedCount;
    (base as unknown as Record<string, unknown>)[collection] = rewriteReferences(result, idMap);
  }

  // Documents and configs follow the same policy as the rest of the model.
  const packageRemote = Array.isArray(packageState.obsidianNotes) ? packageState.obsidianNotes : [];
  const localRemote = Array.isArray(options.state.obsidianNotes) ? options.state.obsidianNotes : [];
  const remoteById = new Map(localRemote.map((row) => [String(row.key ?? ''), row]));
  const remoteResult = options.mode === 'replace' ? [] : [...localRemote];
  for (const row of packageRemote) {
    const id = preview.sameLibrary ? String(row.key ?? '') : namespacedId(preview.packageLibraryId, String(row.key ?? ''));
    const mapped = id === String(row.key ?? '') ? row : { ...row, key: id, path: id };
    if (!remoteById.has(id) && !remoteResult.some((entry) => String(entry.key ?? '') === id)) {
      remoteResult.push(mapped);
    }
  }
  base.obsidianNotes = remoteResult;

  base.categories = Array.from(new Set([...(options.state.categories ?? []), ...(packageState.categories ?? [])]));
  // The sanitised connection shell first: it never carries a secret from the package.
  base.obsidianConfig = mergedShell.obsidianConfig;
  base.webdavConfig = mergedShell.webdavConfig;
  base.aiConfig = mergedShell.aiConfig;
  base.wucaiConfig = mergedShell.wucaiConfig;
  base.youdaoConfig = mergedShell.youdaoConfig;
  base.cloudflareSync = mergedShell.cloudflareSync;

  /**
   * Credentials come last and only when asked for.
   *
   * Order matters: the assignments above deliberately drop every package secret, so
   * the explicit opt-in has to run afterwards — otherwise it would be overwritten
   * (which is exactly what the first version of this block did).
   */
  let credentialImport = {
    state: base,
    imported: [] as string[],
    kept: [] as string[],
    skipped: [] as Array<{ label: string; reason: string }>,
    invalidateTests: [] as string[]
  };
  if (preview.includesCredentials) {
    if (options.importCredentials) {
      credentialImport = applyCredentialImport(packageState, base, preview.credentialPlans, {
        acceptedServices: options.credentialServices
      });
      base = credentialImport.state as HubState;
    } else {
      credentialImport.skipped = preview.credentialPlans.map((plan) => ({
        label: plan.label,
        reason: '这次选择不导入连接凭据，只恢复数据。'
      }));
    }
  }

  // Deletions: §6.1 keeps soft deletes, so a package row carrying `deletedAt` stays
  // deleted rather than being resurrected as a visible record.
  if (preview.missingAttachments.length > 0) {
    pending.push(`${preview.missingAttachments.length} 个手绘缺少附件对象，恢复后可能打不开`);
  }
  if (preview.referenceOnly.length > 0) {
    pending.push(`${preview.referenceOnly.length} 个远端文件只有引用，需要联网读取`);
  }
  if (preview.unsupportedFields.length > 0) {
    pending.push(`${preview.unsupportedFields.length} 个当前版本不认识的字段被保留但不会使用`);
  }
  pending.push('连接密钥不在包内：恢复后请在「连接与任务」重新填写并测试');
  pending.push('金库条目仍是密文：需要原来的金库主密码才能查看');

  if (credentialImport.imported.length > 0) {
    // Replace the generic "no credentials in the package" note with what happened.
    pending.splice(
      pending.findIndex((line) => line.startsWith('连接密钥不在包内')),
      1,
      `已导入 ${credentialImport.imported.length} 项连接凭据；请在「连接与任务」重新测试它们`
    );
  }

  stagingArea.delete(options.previewId);

  return ok({
    state: base,
    report: {
      applied,
      conflictsResolved,
      keptLocal,
      copies,
      remapped: idMap.size,
      pending,
      credentialsImported: credentialImport.imported,
      credentialsSkipped: credentialImport.skipped,
      connectionsToRetest: credentialImport.invalidateTests
    }
  });
}
