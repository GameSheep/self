/**
 * Migration source readers (P2-02).
 * docs/SELF_HUB_DEVELOPMENT.md §13.1 lists every place v2 data can live. This
 * module reads them **without writing anything**, and records for each source:
 * · - Never assume the async IndexedDB mirror is newer than the localStorage
 */
import { STORAGE_KEY_SELF_HUB } from './types';

export type SourceId = 'localStorage-v2' | 'idb-mirror-v1' | 'chrome-storage';

export interface SourceSnapshot {
  id: SourceId;
  /** Raw text/JSON as read, for the immutable pre-migration snapshot. */
  raw: string;
  /** SHA-256 of `raw`, so a re-run can prove the source did not change. */
  hash: string;
  counts: Record<string, number>;
  /** Root-level keys this build does not model, preserved for the report. */
  unknownFields: string[];
  /** Non-fatal problems worth showing the user (unparseable sub-parts, …). */
  warnings: string[];
  readAt: number;
}

export interface MigrationSources {
  snapshots: SourceSnapshot[];
  /** Every collection value, keyed `${sourceId}:${collection}`. */
  collections: Map<string, unknown[]>;
}

/** Keys we are allowed to read from `chrome.storage.local`. */
export const CHROME_STORAGE_WHITELIST = [
  'selfhub_sites',
  'selfhub_annotations',
  'selfhub_inbox',
  'selfhub_quicknote',
  'selfhub_quicknote_updatedAt'
] as const;

/**
 * Collections the v2 payload and the v1 mirror can contain.
 *
 * Kept as one list so both readers and the mapping layer agree on coverage; a
 * collection added here without a mapping shows up as an unmapped count in the
 * report rather than being silently dropped.
 */
export const V2_COLLECTIONS = [
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
  'obsidianNotes',
  'wucaiHighlights',
  'youdaoNotes'
] as const;

/** Root-level config objects, migrated as connections rather than collections. */
export const V2_CONFIG_KEYS = [
  'obsidianConfig',
  'webdavConfig',
  'aiConfig',
  'wucaiConfig',
  'youdaoConfig',
  'cloudflareSync',
  'backupPolicy',
  'features',
  'gotabPrefs',
  'homeBlocks',
  'connectionTests',
  'purposes'
] as const;

const KNOWN_ROOT_KEYS = new Set<string>([...V2_COLLECTIONS, ...V2_CONFIG_KEYS, 'theme', 'categories', 'schemaVersion']);

/** SHA-256 as lowercase hex. Uses Web Crypto; available in browsers and Node 18+. */
export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function countCollections(payload: Record<string, unknown>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const name of V2_COLLECTIONS) {
    const value = payload[name];
    counts[name] = Array.isArray(value) ? value.length : 0;
  }
  return counts;
}

function unknownRootFields(payload: Record<string, unknown>): string[] {
  return Object.keys(payload).filter((key) => !KNOWN_ROOT_KEYS.has(key));
}

/* -------------------------------------------------------------------------- */
/* Source 1: the localStorage v2 payload                                       */
/* -------------------------------------------------------------------------- */

export async function readLocalStorageSource(): Promise<{ snapshot: SourceSnapshot; payload: Record<string, unknown> | null }> {
  const raw = localStorage.getItem(STORAGE_KEY_SELF_HUB) ?? '';
  const warnings: string[] = [];
  let payload: Record<string, unknown> | null = null;

  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        payload = parsed as Record<string, unknown>;
      } else {
        warnings.push('localStorage 负载不是对象，已跳过内容读取');
      }
    } catch {
      warnings.push('localStorage 负载无法解析，原始字节仍会进入快照');
    }
  }

  const collections: Record<string, unknown[]> = {};
  if (payload) {
    for (const name of V2_COLLECTIONS) {
      const value = payload[name];
      collections[name] = Array.isArray(value) ? value : [];
    }
  }

  const hash = await sha256Hex(raw);
  return {
    snapshot: {
      id: 'localStorage-v2',
      raw,
      hash,
      counts: payload ? countCollections(payload) : {},
      unknownFields: payload ? unknownRootFields(payload) : [],
      warnings,
      readAt: Date.now()
    },
    payload
  };
}

/* -------------------------------------------------------------------------- */
/* Source 2: the v1 IndexedDB mirror                                           */
/* -------------------------------------------------------------------------- */

/** Mirror stores written by P1's `syncStateToIndexedDb`. */
const MIRROR_STORES = [
  'notes',
  'sites',
  'servers',
  'secrets',
  'reminders',
  'inbox',
  'projects',
  'annotations'
] as const;

function openMirrorReadonly(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null);
      return;
    }
    // Read at version 2 (the P2-01 schema) so the existing connection is not
    // blocked, and never trigger an upgrade from a read path.
    const request = indexedDB.open('self_hub_idb', 2);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
    request.onupgradeneeded = () => {
      // Opening at a higher version than the file has would trigger this; we do
      // not want a read to create schema, so abandon it.
      request.transaction?.abort();
      resolve(null);
    };
  });
}

export async function readIdbMirrorSource(): Promise<{ snapshot: SourceSnapshot; collections: Record<string, unknown[]> }> {
  const warnings: string[] = [];
  const collections: Record<string, unknown[]> = {};
  const db = await openMirrorReadonly();
  if (!db) {
    const empty = JSON.stringify({});
    return {
      snapshot: {
        id: 'idb-mirror-v1',
        raw: empty,
        hash: await sha256Hex(empty),
        counts: {},
        unknownFields: [],
        warnings: ['本环境没有可读取的旧 IndexedDB 镜像'],
        readAt: Date.now()
      },
      collections
    };
  }

  try {
    for (const store of MIRROR_STORES) {
      if (!db.objectStoreNames.contains(store)) {
        collections[store] = [];
        continue;
      }
      collections[store] = await new Promise<unknown[]>((resolve) => {
        try {
          const tx = db.transaction(store, 'readonly');
          const req = tx.objectStore(store).getAll();
          req.onsuccess = () => resolve(req.result || []);
          req.onerror = () => {
            warnings.push(`读取镜像集合 ${store} 失败`);
            resolve([]);
          };
        } catch {
          warnings.push(`无法打开镜像集合 ${store}`);
          resolve([]);
        }
      });
    }
  } finally {
    db.close();
  }

  const raw = JSON.stringify(collections);
  const counts: Record<string, number> = {};
  for (const [name, rows] of Object.entries(collections)) counts[name] = rows.length;

  return {
    snapshot: {
      id: 'idb-mirror-v1',
      raw,
      hash: await sha256Hex(raw),
      counts,
      unknownFields: [],
      warnings,
      readAt: Date.now()
    },
    collections
  };
}

/* -------------------------------------------------------------------------- */
/* Source 3: chrome.storage.local (extension origin only)                      */
/* -------------------------------------------------------------------------- */

interface ChromeLocalLike {
  storage?: { local?: { get?: (keys: string[] | string, cb: (items: Record<string, unknown>) => void) => void } };
}

export async function readChromeStorageSource(): Promise<{ snapshot: SourceSnapshot; collections: Record<string, unknown[]> }> {
  const collections: Record<string, unknown[]> = {};
  const warnings: string[] = [];
  const api = (globalThis as unknown as { chrome?: ChromeLocalLike }).chrome;
  const get = api?.storage?.local?.get?.bind(api.storage.local);

  if (!get) {
    const raw = JSON.stringify({ available: false });
    return {
      snapshot: {
        id: 'chrome-storage',
        raw,
        hash: await sha256Hex(raw),
        counts: {},
        unknownFields: [],
        warnings: ['当前环境不是扩展，chrome.storage 来源不适用'],
        readAt: Date.now()
      },
      collections
    };
  }

  const items = await new Promise<Record<string, unknown>>((resolve) => {
    try {
      get([...CHROME_STORAGE_WHITELIST], (result) => resolve(result || {}));
    } catch {
      resolve({});
    }
  });

  collections.sites = Array.isArray(items.selfhub_sites) ? (items.selfhub_sites as unknown[]) : [];
  collections.annotations = Array.isArray(items.selfhub_annotations) ? (items.selfhub_annotations as unknown[]) : [];
  collections.inbox = Array.isArray(items.selfhub_inbox) ? (items.selfhub_inbox as unknown[]) : [];
  const quickNote = typeof items.selfhub_quicknote === 'string' ? items.selfhub_quicknote.trim() : '';
  collections.quicknote = quickNote ? [{ content: quickNote, updatedAt: items.selfhub_quicknote_updatedAt }] : [];
  if (quickNote) warnings.push('扩展新标签页还有一条未导入的快速记录，已并入收件箱来源');

  const raw = JSON.stringify(items);
  const counts: Record<string, number> = {};
  for (const [name, rows] of Object.entries(collections)) counts[name] = rows.length;
  return {
    snapshot: { id: 'chrome-storage', raw, hash: await sha256Hex(raw), counts, unknownFields: [], warnings, readAt: Date.now() },
    collections
  };
}

/* -------------------------------------------------------------------------- */
/* Aggregate                                                                   */
/* -------------------------------------------------------------------------- */

export async function readAllSources(options: {
  includeChromeStorage?: boolean;
/**
 * Treat the live payload as authoritative and use the v1 mirror only to fill gaps.
 * The default (`false`) is the archival reading: collect everything from every source,
 * with namespaced ids, so nothing that exists anywhere is lost. That is right when the
 * · `preferPayload` the payload wins per collection and the mirror is used only for
 */
  preferPayload?: boolean;
} = {}): Promise<MigrationSources> {
  const snapshots: SourceSnapshot[] = [];
  const collections = new Map<string, unknown[]>();

  const ls = await readLocalStorageSource();
  snapshots.push(ls.snapshot);
  /** Collections the payload actually has rows for (used by `preferPayload`). */
  const payloadCollections = new Set<string>();
  if (ls.payload) {
    for (const name of V2_COLLECTIONS) {
      const rows = Array.isArray(ls.payload[name]) ? (ls.payload[name] as unknown[]) : [];
      collections.set(`localStorage-v2:${name}`, rows);
      if (rows.length > 0) payloadCollections.add(name);
    }
    for (const key of V2_CONFIG_KEYS) {
      const value = ls.payload[key];
      collections.set(`localStorage-v2:${key}`, value === undefined ? [] : [value]);
      if (value !== undefined) payloadCollections.add(key);
    }
    collections.set('localStorage-v2:theme', [ls.payload.theme ?? 'dark']);
    collections.set('localStorage-v2:categories', Array.isArray(ls.payload.categories) ? (ls.payload.categories as unknown[]) : []);
  }

  const idb = await readIdbMirrorSource();
  snapshots.push(idb.snapshot);
  for (const [name, rows] of Object.entries(idb.collections)) {
    // Collections the payload does not have (or has empty) always come through: that is
    // the mirror's purpose. Otherwise the payload is the same logical data.
    if (options.preferPayload && payloadCollections.has(name)) continue;
    collections.set(`idb-mirror-v1:${name}`, rows);
  }

  if (options.includeChromeStorage) {
    const chromeSource = await readChromeStorageSource();
    snapshots.push(chromeSource.snapshot);
    for (const [name, rows] of Object.entries(chromeSource.collections)) {
      collections.set(`chrome-storage:${name}`, rows);
    }
  }

  return { snapshots, collections };
}
