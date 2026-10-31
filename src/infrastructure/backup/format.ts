/**
 * v3 backup format (P2-05).
 * The P1 backup was a single mutable `state.json` per destination. That shape has
 * three problems the dev doc calls out explicitly:
 * · the only thing that makes a generation restorable. Anything without a marker is
 */
import { appError, type AppError } from '../../repositories/errors';

export const BACKUP_FORMAT = 'selfhub-backup';
export const BACKUP_FORMAT_VERSION = 3;
export const BACKUP_SCHEMA_VERSION = 3;
/** `<root>/.selfhub/v3/...` — the root is the connection's configured prefix. */
export const BACKUP_ROOT_SEGMENT = '.selfhub/v3';
/**
 * Migration packages live under their own root (§10.3).
 *
 * "为迁移设备提供单独'包含连接凭据的加密迁移包'…不进入日常备份默认路径." A separate
 * root is what makes that structural rather than a promise: retention, the daily
 * status panel and the automatic trigger all list the backup root only, so a
 * credentials package can never be counted as a backup or pruned as one.
 */
export const MIGRATION_ROOT_SEGMENT = '.selfhub/migration';
export const MANIFEST_NAME = 'manifest.enc.json';
export const COMPLETION_NAME = '_complete.json';

export type BackupPurpose = 'backup' | 'migration';

/**
 * Versioned crypto parameters.
 *
 * Recorded in the manifest rather than only in code: a package written today has
 * to stay readable after these constants change, and a reader must never have to
 * guess which parameters produced a given envelope.
 */
export const BACKUP_CRYPTO_PARAMS = {
  algorithm: 'AES-GCM',
  kdf: 'PBKDF2',
  iterations: 100_000,
  hash: 'SHA-256',
  keyLength: 256
} as const;

export interface BackupObjectEntry {
  /** Path relative to the generation directory. */
  path: string;
  /** Byte length of the stored (encrypted) envelope. */
  length: number;
  /** SHA-256 of the stored bytes, so corruption is detected before decryption. */
  hash: string;
  kind: 'data' | 'attachment';
  /** Safe description for the restore preview (no content). */
  description: string;
}

export interface BackupManifest {
  format: typeof BACKUP_FORMAT;
  formatVersion: number;
  /** `migration` means this package was created explicitly to move a device. */
  purpose: BackupPurpose;
  /**
   * True when connection secrets are inside.
   *
   * Only ever true for a migration package, and it is recorded in the manifest so a
   * reader can refuse to treat such a package as an ordinary backup.
   */
  includesCredentials: boolean;
  libraryId: string;
  deviceId: string;
  generationId: string;
  createdAt: number;
  schemaVersion: number;
  contentRevision: number;
  counts: Record<string, number>;
  objects: BackupObjectEntry[];
  attachments: BackupObjectEntry[];
  /** What this package deliberately leaves out; shown to the user. */
  exclusions: string[];
  crypto: {
    algorithm: string;
    kdf: string;
    iterations: number;
    hash: string;
    keyLength: number;
    /** Base64 salt used for this generation's key. */
    salt: string;
    perObjectIv: true;
  };
  /** Always null in the manifest: completion lives in its own object. */
  completion: null;
  scope: {
    /** Remote documents referenced but not downloaded; a reference-only backup. */
    referenceOnly: string[];
    totalBytes: number;
    /** Human-readable list of the credentials inside a migration package. */
    credentialScope?: string[];
  };
}

export interface CompletionMarker {
  format: typeof BACKUP_FORMAT;
  formatVersion: number;
  libraryId: string;
  deviceId: string;
  generationId: string;
  manifestPath: string;
  /** SHA-256 of the stored manifest envelope. */
  manifestHash: string;
  /**
   * PBKDF2 salt for this generation.
   *
   * The salt also lives in the manifest, but the manifest is encrypted — so a
   * reader cannot get it from there before deriving the key. A KDF salt is a
   * public parameter, not a secret, so the marker carries it; without this the
   * package would be unreadable by anyone, including its owner.
   */
  salt: string;
  objectCount: number;
  totalBytes: number;
  writtenAt: number;
}

/** Encrypted envelope as stored: the only shape a reader has to trust. */
export interface EncryptedEnvelope {
  v: number;
  iv: string;
  ciphertext: string;
}

/* -------------------------------------------------------------------------- */
/* Paths                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Make one path segment safe.
 *
 * §10.5: "路径规范化后禁止越界、`..` 和不受控绝对地址". Ids come from user data and
 * from remote listings, so they are sanitised rather than trusted.
 */
export function safeSegment(value: string): string {
  const cleaned = (value || '').replace(/[^A-Za-z0-9._-]/g, '_').replace(/^[.]+/, '_');
  return cleaned.length > 0 ? cleaned.slice(0, 96) : '_';
}

/** Reject a generated path that escapes the generation directory. */
export function assertSafeRelativePath(path: string): void {
  if (!path || path.startsWith('/') || path.includes('\\')) {
    throw appError('VALIDATION', `备份路径不合法：${path}`, { safeDetail: 'unsafe backup path' });
  }
  if (path.split('/').some((segment) => segment === '..' || segment === '')) {
    throw appError('VALIDATION', `备份路径不合法：${path}`, { safeDetail: 'unsafe backup path' });
  }
}

export function generationPrefix(
  libraryId: string,
  deviceId: string,
  generationId: string,
  purpose: BackupPurpose = 'backup'
): string {
  const root = purpose === 'migration' ? MIGRATION_ROOT_SEGMENT : BACKUP_ROOT_SEGMENT;
  return `${root}/${safeSegment(libraryId)}/${safeSegment(deviceId)}/${safeSegment(generationId)}/`;
}

export function devicePrefix(libraryId: string, deviceId: string, purpose: BackupPurpose = 'backup'): string {
  const root = purpose === 'migration' ? MIGRATION_ROOT_SEGMENT : BACKUP_ROOT_SEGMENT;
  return `${root}/${safeSegment(libraryId)}/${safeSegment(deviceId)}/`;
}

/** Sortable, collision-resistant generation id. */
export function newGenerationId(now: number, random: () => number = Math.random): string {
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
  return `gen-${stamp}-${random().toString(36).slice(2, 6)}`;
}

/* -------------------------------------------------------------------------- */
/* Hashing                                                                     */
/* -------------------------------------------------------------------------- */

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export function byteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

/** SHA-256 over the stored bytes, not over the plaintext. */
export async function hashStored(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return toHex(digest);
}

/* -------------------------------------------------------------------------- */
/* Crypto                                                                      */
/* -------------------------------------------------------------------------- */

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function newSalt(): string {
  return bytesToBase64(crypto.getRandomValues(new Uint8Array(16)));
}

/**
 * Derive the generation key.
 *
 * Same audited Web Crypto primitives (PBKDF2-SHA256 → AES-256-GCM) as the vault,
 * with the iteration count taken from `BACKUP_CRYPTO_PARAMS` so the stored
 * parameters and the derivation cannot disagree.
 */
export async function deriveBackupKey(password: string, saltBase64: string): Promise<CryptoKey> {
  if (!password) {
    throw appError('LOCKED', '需要备份密码才能加密备份。', { safeDetail: 'empty backup password' });
  }
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, [
    'deriveKey'
  ]);
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: base64ToBytes(saltBase64) as unknown as BufferSource,
      iterations: BACKUP_CRYPTO_PARAMS.iterations,
      hash: BACKUP_CRYPTO_PARAMS.hash
    },
    material,
    { name: 'AES-GCM', length: BACKUP_CRYPTO_PARAMS.keyLength },
    false,
    ['encrypt', 'decrypt']
  );
}

/** Encrypt one object with a fresh IV. */
export async function encryptObject(key: CryptoKey, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as unknown as BufferSource },
    key,
    new TextEncoder().encode(plaintext)
  );
  const envelope: EncryptedEnvelope = {
    v: BACKUP_FORMAT_VERSION,
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext))
  };
  return JSON.stringify(envelope);
}

export async function decryptObject(key: CryptoKey, stored: string): Promise<{ ok: true; text: string } | { ok: false; error: AppError }> {
  let envelope: EncryptedEnvelope;
  try {
    envelope = JSON.parse(stored) as EncryptedEnvelope;
  } catch {
    return { ok: false, error: appError('VALIDATION', '备份对象不是有效的加密信封。', { safeDetail: 'bad envelope json' }) };
  }
  if (!envelope || typeof envelope.ciphertext !== 'string' || typeof envelope.iv !== 'string') {
    return { ok: false, error: appError('VALIDATION', '备份对象缺少加密参数。', { safeDetail: 'envelope missing iv/ciphertext' }) };
  }
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: base64ToBytes(envelope.iv) as unknown as BufferSource },
      key,
      base64ToBytes(envelope.ciphertext) as unknown as BufferSource
    );
    return { ok: true, text: new TextDecoder().decode(plaintext) };
  } catch {
    // AES-GCM authentication failed: wrong password, or the bytes were altered.
    return {
      ok: false,
      error: appError('AUTH_FAILED', '备份解密失败：密码不正确，或这个包已被改动。', {
        safeDetail: 'gcm authentication failed',
        suggestedAction: 'reenter_backup_password'
      })
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Manifest verification                                                       */
/* -------------------------------------------------------------------------- */

export interface ManifestVerification {
  ok: boolean;
  issues: string[];
}

/** Structural check, run before anything from a package is trusted (§10.4.1). */
export function verifyManifestShape(value: unknown): { ok: true; manifest: BackupManifest } | { ok: false; issues: string[] } {
  const issues: string[] = [];
  if (!value || typeof value !== 'object') return { ok: false, issues: ['清单不是对象'] };
  const manifest = value as BackupManifest;
  if (manifest.format !== BACKUP_FORMAT) issues.push(`格式标识不正确：${String(manifest.format)}`);
  if (Number(manifest.formatVersion) !== BACKUP_FORMAT_VERSION) {
    issues.push(`备份格式版本不支持：${String(manifest.formatVersion)}`);
  }
  if (Number(manifest.schemaVersion) !== BACKUP_SCHEMA_VERSION) {
    issues.push(`数据模型版本不支持：${String(manifest.schemaVersion)}`);
  }
  if (!manifest.libraryId || !manifest.deviceId || !manifest.generationId) issues.push('清单缺少库/设备/批次标识');
  if (!manifest.crypto?.salt) issues.push('清单缺少加密参数');
  if (!Array.isArray(manifest.objects) || !Array.isArray(manifest.attachments)) issues.push('清单缺少对象列表');
  if (issues.length > 0) return { ok: false, issues };
  // Older packages predate `purpose`/`includesCredentials`; normalise rather than
  // reject, but never *upgrade* something to "migration" by accident.
  manifest.purpose = manifest.purpose === 'migration' ? 'migration' : 'backup';
  manifest.includesCredentials = manifest.includesCredentials === true;
  return { ok: true, manifest };
}

/**
 * Check that the marker really belongs to this manifest.
 *
 * `manifestHash` is over the *stored* (encrypted) bytes, so the marker can be
 * public without leaking anything — it only proves "this exact manifest was
 * uploaded, whole, before the marker was written".
 */
export function verifyCompletion(marker: unknown, manifestHash: string): ManifestVerification {
  const issues: string[] = [];
  if (!marker || typeof marker !== 'object') return { ok: false, issues: ['缺少完成标记'] };
  const typed = marker as CompletionMarker;
  if (typed.format !== BACKUP_FORMAT) issues.push('完成标记格式标识不正确');
  if (Number(typed.formatVersion) !== BACKUP_FORMAT_VERSION) issues.push('完成标记版本不支持');
  if (!typed.generationId) issues.push('完成标记缺少批次标识');
  if (!typed.salt) issues.push('完成标记缺少加密盐值');
  if (typed.manifestHash !== manifestHash) issues.push('完成标记与清单不一致（上传未完成或已被替换）');
  return { ok: issues.length === 0, issues };
}

/** Every listed object must exist with the recorded length and hash. */
export async function verifyObjects(
  manifest: BackupManifest,
  read: (path: string) => Promise<string | null>
): Promise<ManifestVerification> {
  const issues: string[] = [];
  for (const entry of [...manifest.objects, ...manifest.attachments]) {
    const stored = await read(entry.path);
    if (stored === null) {
      issues.push(`缺少对象：${entry.path}`);
      continue;
    }
    if (byteLength(stored) !== entry.length) {
      issues.push(`对象长度不符：${entry.path}`);
      continue;
    }
    const hash = await hashStored(stored);
    if (hash !== entry.hash) issues.push(`对象校验失败：${entry.path}`);
  }
  return { ok: issues.length === 0, issues };
}

/** User-facing summary of what a package contains (§10.3 "范围必须说明"). */
export function describeManifest(manifest: BackupManifest): string {
  const total = Object.values(manifest.counts).reduce((sum, value) => sum + (Number(value) || 0), 0);
  const remote = manifest.scope.referenceOnly.length;
  const parts = [
    `${total} 条记录`,
    `${manifest.attachments.length} 个本机附件`,
    manifest.scope.totalBytes > 0 ? `${Math.round(manifest.scope.totalBytes / 1024)} KB` : '无附件字节'
  ];
  if (remote > 0) parts.push(`${remote} 个远端文件仅保存引用`);
  if (manifest.includesCredentials) parts.push('含连接凭据（迁移包）');
  else if (manifest.purpose === 'migration') parts.push('迁移包（未含凭据）');
  return parts.join(' · ');
}
