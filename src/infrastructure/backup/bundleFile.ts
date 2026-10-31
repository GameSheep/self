/**
 * Single-file encrypted bundles (P2-06, §9.1).
 * The web app and the packaged extension live on **different origins**, so they
 * cannot share a local database: §9.1 says to exchange an encrypted migration
 */
import { appError, fail, ok, type Result } from '../../repositories/errors';
import type { HubState } from '../../types';
import { normalizeHubState } from '../../lib/storage';
import { collectSnapshot } from './snapshot';
import {
  BACKUP_FORMAT,
  BACKUP_FORMAT_VERSION,
  BACKUP_SCHEMA_VERSION,
  BACKUP_CRYPTO_PARAMS,
  decryptObject,
  deriveBackupKey,
  encryptObject,
  hashStored,
  newSalt,
  verifyManifestShape,
  type BackupManifest,
  type BackupObjectEntry
} from './format';

export const BUNDLE_MODE = 'single-file';

export interface BundleEnvelope {
  format: typeof BACKUP_FORMAT;
  formatVersion: number;
  /** Distinguishes this from a remote generation directory listing. */
  mode: typeof BUNDLE_MODE;
  createdAt: number;
  crypto: { salt: string };
  /** Encrypted manifest, base64 envelope as a string. */
  manifest: string;
  /** path → encrypted envelope string. */
  objects: Record<string, string>;
  completion: { at: number; manifestHash: string; objectCount: number };
}

export interface BuildBundleOptions {
  state: HubState;
  password: string | null | undefined;
  libraryId: string;
  deviceId: string;
  purpose?: 'backup' | 'migration';
  /** Include connection secrets (only meaningful for a migration bundle). */
  includeCredentials?: boolean;
  now?: () => number;
}

export interface BuiltBundle {
  json: string;
  fileName: string;
  manifest: BackupManifest;
  summary: string;
}

function stampFor(at: number): string {
  const d = new Date(at);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

export async function buildBundle(options: BuildBundleOptions): Promise<Result<BuiltBundle>> {
  const password = (options.password ?? '').trim();
  if (!password) {
    return fail(
      appError('LOCKED', '需要备份密码才能生成加密文件；没有生成任何内容。', { safeDetail: 'no password for bundle' })
    );
  }
  const purpose = options.purpose ?? 'backup';
  const includesCredentials = options.includeCredentials === true;
  if (purpose !== 'migration' && includesCredentials) {
    // §10.3: credentials only ever travel inside an explicit migration package.
    return fail(
      appError('VALIDATION', '只有迁移用途的文件才能包含连接凭据。', { safeDetail: 'credentials require migration purpose' })
    );
  }

  const now = options.now ?? (() => Date.now());
  const createdAt = now();
  const snapshot = collectSnapshot(options.state, { includeCredentials: includesCredentials });
  const salt = newSalt();
  const key = await deriveBackupKey(password, salt);

  const objects: Record<string, string> = {};
  const entries: BackupObjectEntry[] = [];
  for (const object of snapshot.objects) {
    const stored = await encryptObject(key, object.text);
    objects[object.path] = stored;
    entries.push({
      path: object.path,
      length: new TextEncoder().encode(stored).byteLength,
      hash: await hashStored(stored),
      kind: object.kind,
      description: object.description
    });
  }

  const manifest: BackupManifest = {
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_FORMAT_VERSION,
    purpose,
    includesCredentials,
    libraryId: options.libraryId,
    deviceId: options.deviceId,
    generationId: `bundle-${stampFor(createdAt)}`,
    createdAt,
    schemaVersion: BACKUP_SCHEMA_VERSION,
    contentRevision: Number((options.state as { contentRevision?: number }).contentRevision) || 0,
    counts: snapshot.counts,
    objects: entries.filter((entry) => entry.kind === 'data'),
    attachments: entries.filter((entry) => entry.kind === 'attachment'),
    exclusions: snapshot.exclusions,
    crypto: { ...BACKUP_CRYPTO_PARAMS, salt, perObjectIv: true },
    completion: null,
    scope: {
      referenceOnly: snapshot.scope.referenceOnly,
      totalBytes: snapshot.scope.totalBytes,
      credentialScope: snapshot.scope.credentialScope.length > 0 ? snapshot.scope.credentialScope : undefined
    }
  };

  const storedManifest = await encryptObject(key, JSON.stringify(manifest));
  const envelope: BundleEnvelope = {
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_FORMAT_VERSION,
    mode: BUNDLE_MODE,
    createdAt,
    crypto: { salt },
    manifest: storedManifest,
    objects,
    completion: {
      at: now(),
      manifestHash: await hashStored(storedManifest),
      objectCount: entries.length
    }
  };

  return ok({
    json: JSON.stringify(envelope),
    fileName: `self-hub-${purpose === 'migration' ? 'migration' : 'bundle'}-${stampFor(createdAt)}.json`,
    manifest,
    summary: [
      `${Object.values(snapshot.counts).reduce((sum, value) => sum + value, 0)} 条记录`,
      `${manifest.attachments.length} 个附件`,
      includesCredentials ? '含连接凭据（迁移用）' : '不含连接凭据'
    ].join(' · ')
  });
}

export interface ReadBundleResult {
  manifest: BackupManifest;
  state: HubState;
}

/**
 * Verify and decrypt a bundle.
 *
 * Order matters for the same reason it does remotely: the manifest hash is checked
 * before anything is decrypted, and every object hash before the payload is parsed.
 * A truncated or hand-edited file therefore fails as "invalid package" instead of
 * surfacing as a half-restored library.
 */
export async function readBundle(json: string, password: string | null | undefined): Promise<Result<ReadBundleResult>> {
  const pass = (password ?? '').trim();
  if (!pass) {
    return fail(appError('LOCKED', '需要备份密码才能读取这个文件。', { safeDetail: 'no password for bundle read' }));
  }

  let envelope: BundleEnvelope;
  try {
    envelope = JSON.parse(json) as BundleEnvelope;
  } catch {
    return fail(appError('VALIDATION', '这个文件不是有效的 JSON。', { safeDetail: 'bundle not json' }));
  }
  if (envelope?.format !== BACKUP_FORMAT || Number(envelope.formatVersion) !== BACKUP_FORMAT_VERSION) {
    return fail(
      appError('VALIDATION', '这个文件不是 Self-Hub 的 v3 加密包，或者版本不受支持。', {
        safeDetail: 'bundle header mismatch'
      })
    );
  }
  if (envelope.mode !== BUNDLE_MODE) {
    return fail(appError('VALIDATION', '这个文件不是单文件加密包。', { safeDetail: 'bundle mode mismatch' }));
  }
  if (!envelope.crypto?.salt || typeof envelope.manifest !== 'string' || !envelope.objects) {
    return fail(appError('VALIDATION', '这个文件缺少加密参数。', { safeDetail: 'bundle missing crypto' }));
  }

  const manifestHash = await hashStored(envelope.manifest);
  if (!envelope.completion || envelope.completion.manifestHash !== manifestHash) {
    return fail(
      appError('VALIDATION', '文件的完整性校验失败（可能被截断或改动过）。', {
        safeDetail: 'manifest hash mismatch',
        suggestedAction: 're-export'
      })
    );
  }

  const key = await deriveBackupKey(pass, envelope.crypto.salt);
  const decryptedManifest = await decryptObject(key, envelope.manifest);
  if (!decryptedManifest.ok) return fail(decryptedManifest.error);

  let parsedManifest: unknown;
  try {
    parsedManifest = JSON.parse(decryptedManifest.text);
  } catch {
    return fail(appError('VALIDATION', '清单解密后不是有效 JSON。', { safeDetail: 'manifest not json' }));
  }
  const shape = verifyManifestShape(parsedManifest);
  if (!shape.ok) {
    return fail(
      appError('VALIDATION', `清单结构不正确：${shape.issues.join('；')}`, { safeDetail: 'bad manifest shape' })
    );
  }
  const manifest = shape.manifest;

  for (const entry of [...manifest.objects, ...manifest.attachments]) {
    const stored = envelope.objects[entry.path];
    if (typeof stored !== 'string') {
      return fail(appError('VALIDATION', `缺少对象：${entry.path}`, { safeDetail: 'bundle object missing' }));
    }
    if ((await hashStored(stored)) !== entry.hash) {
      return fail(appError('VALIDATION', `对象校验失败：${entry.path}`, { safeDetail: 'bundle object hash mismatch' }));
    }
  }

  const dataEntry = manifest.objects.find((entry) => entry.path === 'objects/state.json') ?? manifest.objects[0];
  if (!dataEntry) {
    return fail(appError('VALIDATION', '这个文件里没有数据对象。', { safeDetail: 'bundle has no data object' }));
  }
  const data = await decryptObject(key, envelope.objects[dataEntry.path]);
  if (!data.ok) return fail(data.error);

  let parsedState: unknown;
  try {
    parsedState = JSON.parse(data.text);
  } catch {
    return fail(appError('VALIDATION', '数据解密后不是有效 JSON。', { safeDetail: 'bundle payload not json' }));
  }

  return ok({ manifest, state: normalizeHubState(parsedState) });
}
