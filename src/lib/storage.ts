import { HubState } from '../types';
import { syncStateToIndexedDb } from './indexedDb';
import {
  assertWritable,
  claimGeneration,
  CURRENT_GENERATION,
  MAX_SUPPORTED_GENERATION,
  readGenerationMarker,
  SCHEMA_WRITER
} from './schemaGeneration';
// From lib/migrationGate, not repositories/migration/lock: this module is in the entry's
// static graph, and importing the migration package here pulled the whole migration runner
// into the first load (~9 KB gzip, measured).
import { isWriteBlockedByMigration, readMigrationLock as readLock } from './migrationGate';
import { INITIAL_STATE, normalizeHubState } from './hubState';

/**
 * The state *shape* (`INITIAL_STATE`, `normalizeHubState`, `SCHEMA_VERSION`) now lives in
 * `lib/hubState.ts`. Reason: `lib/crypto` needs `normalizeHubState`, and `lib/crypto` is
 * reachable from the lazy v3/migration stack — while this module is in the entry's static
 * graph, so keeping the two together dragged the migration stack into the first load.
 * Re-exported here so every existing importer keeps working.
 */
export { INITIAL_STATE, normalizeHubState, SCHEMA_VERSION } from './hubState';

const STORAGE_KEY = 'self_hub_data_v2';
const MASTER_HASH_KEY = 'self_hub_master_auth';
const SCHEMA_VERSION = CURRENT_GENERATION;

export function getStorageKey(): string {
  return STORAGE_KEY;
}

// In-memory recovery buffer if localStorage fails
let inMemoryFallbackState: HubState | null = null;

export const SALVAGE_PREFIX = `${STORAGE_KEY}__corrupt_`;

/**
 * Keep a damaged payload for manual recovery.
 *
 * Deliberately idempotent: the old code wrote `${key}__corrupt_${Date.now()}`
 * on every failed load, so a profile with one unparseable payload grew a new
 * multi-megabyte copy on every refresh until localStorage filled up.
 */
function salvageDamagedPayload(damaged: string): void {
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key && key.startsWith(SALVAGE_PREFIX) && localStorage.getItem(key) === damaged) return;
    }
    localStorage.setItem(`${SALVAGE_PREFIX}${Date.now()}`, damaged);
  } catch {
    /* storage full or unavailable: the in-memory fallback still applies */
  }
}

/** Salvaged payloads, newest first. Surfaced by 高级与维护. */
export function listSalvagedPayloads(): Array<{ key: string; at: number; bytes: number }> {
  const out: Array<{ key: string; at: number; bytes: number }> = [];
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(SALVAGE_PREFIX)) continue;
      const value = localStorage.getItem(key) || '';
      out.push({ key, at: Number(key.slice(SALVAGE_PREFIX.length)) || 0, bytes: value.length });
    }
  } catch {
    return [];
  }
  return out.sort((a, b) => b.at - a.at);
}

export function loadHubState(): HubState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      // No seed write here: loadHubState() runs inside a useState initializer
      // (render phase). App seeds storage from an effect instead.
      return normalizeHubState(INITIAL_STATE);
    }
    return normalizeHubState(JSON.parse(raw));
  } catch (err) {
    console.error('Failed to load state from localStorage', err);
    // Keep the damaged payload so the user can still export/salvage it.
    try {
      const damaged = localStorage.getItem(STORAGE_KEY);
      if (damaged) salvageDamagedPayload(damaged);
    } catch {}
    return normalizeHubState(inMemoryFallbackState || INITIAL_STATE);
  }
}

/**
 * Result of the most recent failed IndexedDB mirror sync, null while healthy.
 * The mirror is a v3-migration data source, so a failure must stay visible.
 */
let lastMirrorError: { at: number; message: string } | null = null;
export function getLastMirrorError(): { at: number; message: string } | null {
  return lastMirrorError;
}

export interface SaveResult {
  success: boolean;
  error?: string;
  /**
   * True when the write was refused because a newer schema generation owns this
   * origin (see lib/schemaGeneration.ts). The UI must show a reload prompt
   * instead of "已保存".
   */
  readOnly?: boolean;
  /** Serialised size of the payload that was written (bytes). */
  bytes?: number;
  /**
   * True when the payload is close to the localStorage limit.
   *
   * The write still succeeded — this is the warning that has to arrive *before* the
   * quota error does. §12.1/P2-07: the user needs to know how close they are, not
   * discover it from "保存失败" one day.
   */
  nearQuota?: boolean;
}

/**
 * Rough per-origin localStorage budget.
 *
 * Browsers are not required to expose their real limit; 5 MB of UTF-16-ish data is
 * the figure every mainstream engine still behaves like, and the app already cannot
 * exceed it. Used only to turn a byte count into a warning, never to refuse a write.
 */
export const STORAGE_CAP_BYTES = 5_000_000;

/** Warn from 80% of the cap, so there is room to export and clean up. */
export const NEAR_QUOTA_RATIO = 0.8;

export interface StorageHealth {
  bytes: number;
  capBytes: number;
  ratio: number;
  nearQuota: boolean;
}

/** Current size of the stored payload, for the settings diagnostics. */
export function getStorageHealth(): StorageHealth {
  let bytes = 0;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    bytes = raw ? raw.length : 0;
  } catch {
    bytes = 0;
  }
  const ratio = STORAGE_CAP_BYTES > 0 ? bytes / STORAGE_CAP_BYTES : 0;
  return { bytes, capBytes: STORAGE_CAP_BYTES, ratio, nearQuota: ratio >= NEAR_QUOTA_RATIO };
}

function formatMb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/** One sentence the UI can show as-is. */
export function describeStorageHealth(health: StorageHealth): string {
  return `本机数据 ${formatMb(health.bytes)}（约占浏览器上限 ${formatMb(health.capBytes)} 的 ${Math.round(
    health.ratio * 100
  )}%）`;
}

/**
 * Collections that belong to the *library* (business data), as opposed to this
 * device's configuration.
 *
 * In v3 mode these are stored in IndexedDB and must not be written into the v2 payload
 * any more — writing them is exactly what pins the app to the ~5 MB localStorage limit.
 */
const LIBRARY_COLLECTIONS = [
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
  'wucaiHighlights',
  'youdaoNotes',
  'obsidianNotes'
] as const;

/** The pre-switch payload, kept as a one-time rollback copy for v3 mode. */
export const V2_ROLLBACK_KEY = 'selfhub_v2_rollback';

export function writeV2Rollback(payloadJson: string): void {
  try {
    localStorage.setItem(V2_ROLLBACK_KEY, payloadJson);
  } catch {
    /* a failed snapshot must not block the switch; the live payload still exists */
  }
}

export function readV2Rollback(): { json: string; at: number } | null {
  try {
    const raw = localStorage.getItem(V2_ROLLBACK_KEY);
    if (!raw) return null;
    return { json: raw, at: 0 };
  } catch {
    return null;
  }
}

export interface SaveOptions {
/**
 * Write only what belongs to this device (configuration + preferences).
 * Used in v3 mode: the business data lives in the library, and the payload shrinks to
 */
  deviceOnly?: boolean;
}

export function saveHubState(state: HubState, options: SaveOptions = {}): SaveResult {
  // P0-03: never let a stale client overwrite data a newer schema already owns.
  // This check is deliberately the first thing on the write path — after the
  // P2 migration bumps the generation, every P1 client refuses here instead of
  // clobbering the migrated payload.
  const guard = assertWritable();
  if (!guard.ok) {
    console.warn('[Self-Hub] write refused:', guard.reason);
    return { success: false, error: guard.reason, readOnly: true };
  }

  // P2-02: while a migration holds this origin's lock, ordinary edits are
  // refused. §13.3 requires the old writers to stop before the switch, and this
  // is the point where a write would otherwise interleave with it. The lock is
  // per-origin (a web page and the extension cannot block each other), and it
  // expires so a crashed migration cannot freeze the app forever.
  if (isWriteBlockedByMigration(SCHEMA_WRITER)) {
    const owner = readLock()?.owner ?? 'unknown';
    console.warn('[Self-Hub] write refused: migration lock held by', owner);
    return {
      success: false,
      readOnly: true,
      error: '本机正在进行数据迁移，暂时不能写入。请等待迁移完成，或先导出备份。'
    };
  }

  // Record that this client wrote generation 2. A no-op once claimed, and a
  // refusal-free no-op if a newer generation appeared between check and claim.
  claimGeneration();

  // Never mutate the caller's object (INITIAL_STATE used to be patched in place).
  const payload: HubState = { ...state, schemaVersion: SCHEMA_VERSION };
  if (options.deviceOnly) {
    // Keep the shape (`loadHubState` normalises arrays) but drop the contents: the
    // library is the fact source for these, and writing them here is what the 5 MB
    // limit was made of.
    for (const key of LIBRARY_COLLECTIONS) {
      (payload as unknown as Record<string, unknown>)[key] = [];
    }
  }
  inMemoryFallbackState = payload;
  const serialized = JSON.stringify(payload);
  const bytes = serialized.length;
  const nearQuota = bytes >= STORAGE_CAP_BYTES * NEAR_QUOTA_RATIO;
  // Last-moment generation recheck: the check at the top of this function and
  // the setItem below are not atomic. If a migration bumped the generation in
  // between, writing here would clobber the migrated data — the exact case
  // P0-03 exists to prevent.
  const lateMarker = readGenerationMarker();
  if (lateMarker && lateMarker.generation > MAX_SUPPORTED_GENERATION) {
    return {
      success: false,
      readOnly: true,
      error:
        `本机数据刚刚被更新版本升级到第 ${lateMarker.generation} 代格式。为避免覆盖新数据，本次保存已取消：请刷新页面。`
    };
  }
  try {
    localStorage.setItem(STORAGE_KEY, serialized);
  } catch (err: any) {
    console.error('Failed to save state to localStorage', err);
    // Still try to persist in IndexedDB even if localStorage quota failed!
    syncStateToIndexedDb(payload).catch((e) => console.warn('IndexedDB auto-sync error', e));
    const isQuota =
      err?.name === 'QuotaExceededError' ||
      err?.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
      err?.code === 22;
    return {
      success: false,
      error: isQuota
        ? '浏览器本地存储空间已满（LocalStorage 约 5MB）。本次改动只存在于内存中，刷新后会丢失：请先导出备份，再删除部分手绘/大笔记后重试。'
        : `保存失败: ${err?.message || '未知存储错误'}`
    };
  }
  // Asynchronously replicate to persistent IndexedDB. The mirror feeds the v3
  // migration, so a failure is recorded on the module for diagnostics instead
  // of being swallowed — it no longer silently disappears.
  lastMirrorError = null;
  syncStateToIndexedDb(payload).catch((e) => {
    lastMirrorError = { at: Date.now(), message: e?.message || String(e) };
    console.warn('IndexedDB auto-sync error', e);
  });
  return { success: true, bytes, nearQuota };
}

/**
 * Validate HubState structure integrity (N02)
 */
export function validateHubState(data: any): { isValid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!data || typeof data !== 'object') {
    return { isValid: false, errors: ['备份数据必须为有效的 JSON 对象'] };
  }

  const requiredArrays = [
    'sites', 'servers', 'secrets', 'reminders', 'notes', 'checkIns', 'handwritings'
  ];
  for (const field of requiredArrays) {
    if (data[field] !== undefined && !Array.isArray(data[field])) {
      errors.push(`字段类型错误，应为数组: ${field}`);
    }
  }

  for (const field of ['sites', 'servers', 'secrets', 'reminders', 'notes']) {
    if (!Array.isArray(data[field])) {
      errors.push(`缺少必要数据集合: ${field}`);
    }
  }

  // Check ID integrity and detect duplicate keys.
  //
  // The previous version shared one `seenIds` set across every collection, so a
  // site and a server that happened to carry the same id (which the old
  // importer could produce, and which the extension mirror can produce by
  // namespacing differently) made the *entire* plaintext backup un-importable
  // with a "重复 ID" error. Ids only have to be unique inside their collection,
  // so the set is now per collection.
  const checkColl = (items: unknown, typeName: string) => {
    if (!Array.isArray(items)) return;
    const seenIds = new Set<string>();
    for (const item of items as Array<{ id?: unknown }>) {
      if (!item || typeof item !== 'object' || !item.id) {
        errors.push(`${typeName} 集合中包含缺失唯一标识 ID 的无效条目`);
      } else if (seenIds.has(String(item.id))) {
        errors.push(`${typeName} 发现重复 ID: ${String(item.id)}`);
      } else {
        seenIds.add(String(item.id));
      }
    }
  };

  checkColl(data.sites, '常用站点');
  checkColl(data.servers, '部署服务器');
  checkColl(data.secrets, '金库凭据');
  checkColl(data.notes, '知识笔记');
  checkColl(data.reminders, '提醒事项');
  checkColl(data.checkIns, '签到任务');
  checkColl(data.handwritings, '手绘卡片');
  checkColl(data.inbox, '收件箱条目');
  checkColl(data.projects, '项目空间');

  return { isValid: errors.length === 0, errors };
}

export function getMasterAuth(): { hash: string; salt: string } | null {
  try {
    const raw = localStorage.getItem(MASTER_HASH_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function setMasterAuth(hash: string, salt: string): void {
  try {
    localStorage.setItem(MASTER_HASH_KEY, JSON.stringify({ hash, salt }));
  } catch (err) {
    console.error('Failed to set master auth', err);
  }
}

export function exportBackup(state: HubState): void {
  const dataStr = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(state, null, 2));
  const downloadAnchor = document.createElement('a');
  downloadAnchor.setAttribute('href', dataStr);
  downloadAnchor.setAttribute('download', `self-hub-backup-v2-${new Date().toISOString().slice(0, 10)}.json`);
  document.body.appendChild(downloadAnchor);
  downloadAnchor.click();
  downloadAnchor.remove();
}

const ROLLBACK_KEY = 'self_hub_rollback_snapshot';

/** Snapshot the current payload so a bad import can be undone. */
export function snapshotForRollback(): void {
  try {
    const prev = localStorage.getItem(STORAGE_KEY);
    if (prev) sessionStorage.setItem(ROLLBACK_KEY, prev);
  } catch {}
}

export function hasRollbackSnapshot(): boolean {
  try {
    return Boolean(sessionStorage.getItem(ROLLBACK_KEY));
  } catch {
    return false;
  }
}

/** Restore the snapshot captured before the last backup import. */
export function restoreRollbackSnapshot(): HubState | null {
  try {
    const raw = sessionStorage.getItem(ROLLBACK_KEY);
    if (!raw) return null;
    sessionStorage.removeItem(ROLLBACK_KEY);
    const restored = normalizeHubState(JSON.parse(raw));
    saveHubState(restored);
    return restored;
  } catch {
    return null;
  }
}

export function importBackup(jsonString: string): HubState | null {
  try {
    const parsed = JSON.parse(jsonString);
    const validation = validateHubState(parsed);
    if (!validation.isValid) {
      console.warn('Backup validation failed:', validation.errors);
      alert(`❌ 备份格式校验失败:\n${validation.errors.join('\n')}`);
      return null;
    }
    // Save previous snapshot as emergency rollback (readable via restoreRollbackSnapshot)
    snapshotForRollback();
    // Normalised so missing optional collections can never reach the views.
    // Persisting is the caller's job (App persists every committed state change).
    return normalizeHubState(parsed);
  } catch (err) {
    console.error('Failed to import backup', err);
    return null;
  }
}
