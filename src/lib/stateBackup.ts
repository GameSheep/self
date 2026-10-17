/**
 * Full-state cloud backup.
 *
 * The "多平台数据互通" page only ever uploaded Obsidian notes; sites, reminders,
 * projects, inbox, annotations and check-ins lived exclusively in this browser's
 * localStorage. Clearing site data or switching machines lost everything.
 *
 * This mirrors the whole HubState to `<prefix>.selfhub/state.json` in the same
 * bucket. Writes compare the remote Last-Modified first: if another device wrote
 * after our last backup we do NOT clobber it — the local snapshot is parked in
 * `.selfhub/conflicts/` and the caller is told to resolve it.
 */
import { HubState } from '../types';
import { ObsidianConfig, WebdavSyncConfig } from '../types';
import { headOssObject, putOssObject, fetchOssObjectBlob, hasRealOssKeys } from './s3Client';
import { validateHubState } from './storage';
import { getWebdavFile, putWebdavFile } from './webdavClient';

export const BACKUP_VERSION = 1;
const DEVICE_KEY = 'selfhub_device_id';
const LAST_BACKUP_KEY = 'selfhub_last_backup_at';
const LAST_BASE_KEY = 'selfhub_backup_base_mtime';

export interface BackupEnvelope {
  version: number;
  updatedAt: number;
  deviceId: string;
  /** Kept for compatibility with the existing JSON import format. */
  state: HubState;
}

export interface BackupResult {
  ok: boolean;
  /** True when the remote copy was newer, so we parked ours instead of overwriting. */
  conflict?: boolean;
  key?: string;
  conflictKey?: string;
  remoteLastModified?: number;
  error?: string;
}

/** Stable per-browser device id, used to label snapshots and conflicts. */
export function getDeviceId(): string {
  try {
    const existing = localStorage.getItem(DEVICE_KEY);
    if (existing) return existing;
    const id = `dev-${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-4)}`;
    localStorage.setItem(DEVICE_KEY, id);
    return id;
  } catch {
    return 'dev-unknown';
  }
}

/** `.selfhub/state.json` inside the configured prefix (so it follows the vault). */
export function backupKeyFor(config: ObsidianConfig): string {
  const prefix = (config.prefix || '').replace(/^\/+/, '');
  const normalized = prefix && !prefix.endsWith('/') ? `${prefix}/` : prefix;
  return `${normalized}.selfhub/state.json`;
}

export function conflictKeyFor(config: ObsidianConfig, deviceId: string, ts: number): string {
  const prefix = (config.prefix || '').replace(/^\/+/, '');
  const normalized = prefix && !prefix.endsWith('/') ? `${prefix}/` : prefix;
  const stamp = new Date(ts).toISOString().replace(/[:.]/g, '-');
  return `${normalized}.selfhub/conflicts/state-${stamp}-${deviceId}.json`;
}

export function readLastBackupAt(): number | undefined {
  try {
    const raw = localStorage.getItem(LAST_BACKUP_KEY);
    return raw ? Number(raw) : undefined;
  } catch {
    return undefined;
  }
}

function readBaseMtime(): number | undefined {
  try {
    const raw = localStorage.getItem(LAST_BASE_KEY);
    return raw ? Number(raw) : undefined;
  } catch {
    return undefined;
  }
}

function rememberBackup(mtime: number | undefined): void {
  try {
    localStorage.setItem(LAST_BACKUP_KEY, String(Date.now()));
    if (mtime !== undefined) localStorage.setItem(LAST_BASE_KEY, String(mtime));
  } catch {
    // ignore
  }
}

function envelopeFor(state: HubState): BackupEnvelope {
  return {
    version: BACKUP_VERSION,
    updatedAt: Date.now(),
    deviceId: getDeviceId(),
    state
  };
}

/**
 * Upload the current state.
 *
 * `force` skips the conflict check (user chose "覆盖云端"). Otherwise, when the
 * remote copy is newer than the one we last wrote, the snapshot is written to
 * `.selfhub/conflicts/` and `conflict: true` is returned.
 */
export async function backupStateToOss(config: ObsidianConfig, state: HubState, force = false): Promise<BackupResult> {
  if (!hasRealOssKeys(config) || !config.bucket) {
    return { ok: false, error: '未配置 OSS' };
  }

  const key = backupKeyFor(config);
  const payload = JSON.stringify(envelopeFor(state));

  if (!force) {
    const head = await headOssObject(config, key);
    if (head.exists && head.lastModified !== undefined) {
      const base = readBaseMtime();
      // Remote changed since our last write: somebody else is backing up here.
      if (base !== undefined && head.lastModified > base + 1500) {
        const conflictKey = conflictKeyFor(config, getDeviceId(), Date.now());
        const parked = await putOssObject(config, conflictKey, new Blob([payload]), 'application/json');
        return {
          ok: false,
          conflict: true,
          key,
          conflictKey: parked.success ? conflictKey : undefined,
          remoteLastModified: head.lastModified,
          error: '云端备份比本机新，已把本地快照另存到 conflicts 目录'
        };
      }
    }
  }

  const result = await putOssObject(config, key, new Blob([payload]), 'application/json');
  if (!result.success) return { ok: false, key, error: result.error };

  const after = await headOssObject(config, key);
  rememberBackup(after.lastModified);
  return { ok: true, key, remoteLastModified: after.lastModified };
}

export interface RemoteBackup {
  envelope: BackupEnvelope;
  key: string;
  lastModified?: number;
}

function parseEnvelope(text: string): BackupEnvelope | null {
  try {
    const parsed = JSON.parse(text);
    // Accept both the envelope and a plain exported HubState JSON.
    const candidate = parsed?.state ?? parsed;
    const check = validateHubState(candidate);
    if (!check.isValid) return null;
    return {
      version: Number(parsed?.version) || 0,
      updatedAt: Number(parsed?.updatedAt) || 0,
      deviceId: String(parsed?.deviceId || 'unknown'),
      state: candidate as HubState
    };
  } catch {
    return null;
  }
}

/** Download and validate the remote snapshot. */
export async function readStateBackup(config: ObsidianConfig): Promise<{ ok: boolean; backup?: RemoteBackup; error?: string }> {
  if (!hasRealOssKeys(config) || !config.bucket) return { ok: false, error: '未配置 OSS' };
  const key = backupKeyFor(config);
  const head = await headOssObject(config, key);
  if (!head.exists) return { ok: false, error: '云端还没有备份' };
  if (head.error) return { ok: false, error: head.error };

  const blob = await fetchOssObjectBlob(config, key);
  if (!blob) return { ok: false, error: '读取云端备份失败' };
  const text = await blob.text();
  const envelope = parseEnvelope(text);
  if (!envelope) return { ok: false, error: '云端备份格式无法识别' };
  return { ok: true, backup: { envelope, key, lastModified: head.lastModified } };
}

/* -------------------------------------------------------------------------- */
/* WebDAV provider                                                             */
/* -------------------------------------------------------------------------- */

const WEBDAV_FILE = 'state.json';

function webdavReady(config?: WebdavSyncConfig): boolean {
  return Boolean(config && config.url && config.username && config.password);
}

/**
 * Upload the whole state over WebDAV.
 *
 * WebDAV exposes no reliable server-side mtime through a plain GET, so conflict
 * detection compares the snapshot's own `updatedAt` against our last backup time.
 * A newer remote snapshot is not overwritten; ours is parked under `conflicts/`.
 */
export async function backupStateToWebdav(
  config: WebdavSyncConfig,
  state: HubState,
  force = false
): Promise<BackupResult> {
  if (!webdavReady(config)) return { ok: false, error: '未配置 WebDAV' };

  const payload = JSON.stringify(envelopeFor(state));

  if (!force) {
    const existing = await getWebdavFile(config, WEBDAV_FILE);
    if (existing.ok && existing.text) {
      const remote = parseEnvelope(existing.text);
      const base = readLastBackupAt();
      if (remote && base !== undefined && remote.updatedAt > base + 1500) {
        const prefix = (config.pathPrefix || '').replace(/^\/+|\/+$/g, '');
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const conflictName = `${prefix ? `${prefix}/` : ''}conflicts/state-${stamp}-${getDeviceId()}.json`;
        const parked = await putWebdavFile(config, conflictName, payload);
        return {
          ok: false,
          conflict: true,
          key: existing.path,
          conflictKey: parked.ok ? conflictName : undefined,
          remoteLastModified: remote.updatedAt,
          error: '云端备份比本机新，已把本地快照另存到 conflicts 目录'
        };
      }
    }
  }

  const result = await putWebdavFile(config, WEBDAV_FILE, payload);
  if (!result.ok) return { ok: false, key: result.path, error: result.message };
  rememberBackup(undefined);
  return { ok: true, key: result.path };
}

/** Download and validate a snapshot stored over WebDAV. */
export async function readStateBackupFromWebdav(
  config: WebdavSyncConfig
): Promise<{ ok: boolean; backup?: RemoteBackup; error?: string }> {
  if (!webdavReady(config)) return { ok: false, error: '未配置 WebDAV' };
  const result = await getWebdavFile(config, WEBDAV_FILE);
  if (!result.ok || !result.text) return { ok: false, error: result.message };
  const envelope = parseEnvelope(result.text);
  if (!envelope) return { ok: false, error: '云端备份格式无法识别' };
  return { ok: true, backup: { envelope, key: result.path } };
}

export { webdavReady };

/** Summary line for the settings panel. */
export function describeBackupAge(lastAt?: number): string {  if (!lastAt) return '尚未自动备份';
  const diff = Date.now() - lastAt;
  if (diff < 60_000) return '刚刚备份';
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)} 分钟前备份`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)} 小时前备份`;
  return `${Math.round(diff / 86_400_000)} 天前备份`;
}
