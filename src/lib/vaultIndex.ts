/**
 * Full-vault content index.
 * The tree only knows file names, so with ~1700 notes there was no way to answer
 * "which note mentions Redis?". OSS has no full-text search, so we keep a local
 * · never disturb the main app data.
 */
import { ObsidianConfig, ObsidianNote } from '../types';
import { fetchObsidianNoteContent } from './s3Client';

const DB_NAME = 'self_hub_vault_index';
const DB_VERSION = 1;
const STORE = 'docs';

export interface IndexedDoc {
  key: string;
  title: string;
  /** Body text as stored in the bucket (used for snippets). */
  text: string;
  tags: string[];
  /** Wikilink targets found in the body (normalised, no alias/heading). */
  links: string[];
  /** Cloud last-modified at the time this body was fetched. */
  lastModified: number;
  size: number;
  indexedAt: number;
}

export interface BuildProgress {
  done: number;
  total: number;
  fetched: number;
  skipped: number;
  failed: number;
  currentKey?: string;
}

export interface BuildResult {
  records: IndexedDoc[];
  fetched: number;
  skipped: number;
  failed: number;
  errors: string[];
  /** True when the run stopped early at the caller's request. */
  cancelled?: boolean;
}

let cachedDb: IDBDatabase | null = null;

const META_KEY = 'selfhub_index_meta';

export interface IndexMeta {
  /** When the index was last built/updated (ms). */
  lastBuiltAt?: number;
  /** Docs written in the most recent build. */
  docs?: number;
  /** True when the last run was cancelled before finishing. */
  partial?: boolean;
}

export function readIndexMeta(): IndexMeta {
  try {
    const raw = localStorage.getItem(META_KEY);
    return raw ? (JSON.parse(raw) as IndexMeta) : {};
  } catch {
    return {};
  }
}

export function writeIndexMeta(meta: IndexMeta): void {
  try {
    localStorage.setItem(META_KEY, JSON.stringify(meta));
  } catch {
    // ignore quota errors
  }
}

/**
 * Empty the index. Prefers `clear()` over deleting the database: deleting it can
 * be blocked by an open connection (another tab, a pending transaction), and a
 * blocked delete that we treat as success leaves writes going to a database that
 * is about to disappear.
 */
export async function resetIndexDatabase(): Promise<void> {
  let cleared = false;
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    cleared = true;
  } catch {
    cleared = false;
  }

  if (!cleared) {
    // The store itself is unusable (older/foreign schema): drop the database.
    try {
      cachedDb?.close();
    } catch {
      // ignore
    }
    cachedDb = null;
    await new Promise<void>((resolve) => {
      try {
        const request = indexedDB.deleteDatabase(DB_NAME);
        request.onsuccess = () => resolve();
        request.onerror = () => resolve();
        // Resolve on unblock too, otherwise a stuck connection hangs the UI.
        request.onblocked = () => resolve();
        setTimeout(resolve, 3000);
      } catch {
        resolve();
      }
    });
  }

  try {
    localStorage.removeItem(META_KEY);
  } catch {
    // ignore
  }
}

function openDb(): Promise<IDBDatabase> {
  if (cachedDb) return Promise.resolve(cachedDb);
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'key' });
      }
    };
    request.onsuccess = () => {
      cachedDb = request.result;
      resolve(request.result);
    };
    request.onerror = () => reject(request.error);
  });
}

/**
 * Read every indexed document (used on startup; a few MB at most).
 *
 * If the database is unusable (older schema, corrupted, store missing) it is
 * deleted and the index starts empty rather than leaving search permanently
 * broken with no way back.
 */
export async function loadIndex(): Promise<IndexedDoc[]> {
  try {
    return (await readValidatedDocs()).docs;
  } catch (err) {
    console.warn('[Self-Hub] vault index unreadable, resetting it', err);
    await resetIndexDatabase();
    try {
      return (await readValidatedDocs()).docs;
    } catch {
      return [];
    }
  }
}

/**
 * Runtime shape check for stored documents.
 * The index is a cache of *other people's* content fetched over the network, so a
 * malformed row must not be able to break search for the whole library: one bad
 */
export function validateIndexDocs(raw: unknown[]): { docs: IndexedDoc[]; corrupt: number } {
  const docs: IndexedDoc[] = [];
  let corrupt = 0;
  for (const entry of raw) {
    const row = entry as Partial<IndexedDoc> | null;
    // Field names matter here: the body is `text` (not `content`). Getting this wrong
    // would classify every healthy record as corrupt and send the user to rebuild an
    // index that is fine — which is why the health check has a "healthy" test.
    if (
      !row ||
      typeof row !== 'object' ||
      typeof row.key !== 'string' ||
      !row.key ||
      typeof row.title !== 'string' ||
      typeof row.text !== 'string'
    ) {
      corrupt += 1;
      continue;
    }
    docs.push({
      ...(row as IndexedDoc),
      key: row.key,
      title: row.title,
      text: row.text,
      tags: Array.isArray(row.tags) ? row.tags.filter((tag): tag is string => typeof tag === 'string') : [],
      links: Array.isArray(row.links) ? row.links.filter((link): link is string => typeof link === 'string') : [],
      lastModified: typeof row.lastModified === 'number' ? row.lastModified : 0,
      size: typeof row.size === 'number' ? row.size : row.text.length,
      indexedAt: typeof row.indexedAt === 'number' ? row.indexedAt : 0
    });
  }
  return { docs, corrupt };
}

async function readValidatedDocs(): Promise<{ docs: IndexedDoc[]; corrupt: number }> {
  return validateIndexDocs(await readAllDocs());
}

export interface IndexHealth {
  /** Usable documents in the store. */
  docs: number;
  /** Documents the store held but that could not be used. */
  corrupt: number;
  meta: IndexMeta;
  /** The store could not be read at all (it self-heals on the next load). */
  unreadable: boolean;
  /** Plain-language problems; empty means healthy. */
  problems: string[];
  /** True when a rebuild is the only way back to a trustworthy index. */
  needsRebuild: boolean;
}

/**
 * Report whether the persisted index can be trusted (§P2-07 "损坏重建").
 * `loadIndex()` silently resets an unreadable store, which keeps the app working but
 */
export async function inspectIndex(): Promise<IndexHealth> {
  const meta = readIndexMeta();
  const problems: string[] = [];
  let docs = 0;
  let corrupt = 0;
  let unreadable = false;

  try {
    const result = await readValidatedDocs();
    docs = result.docs.length;
    corrupt = result.corrupt;
  } catch {
    unreadable = true;
  }

  if (unreadable) problems.push('本机索引无法读取（可能已损坏），重新打开时会被清空并需要重建。');
  if (corrupt > 0) problems.push(`有 ${corrupt} 条索引记录格式不正确，已忽略；建议重建索引。`);
  if (typeof meta.docs === 'number' && meta.docs !== docs + corrupt) {
    problems.push(`索引元信息记录 ${meta.docs} 篇，本机实际 ${docs + corrupt} 篇，两者不一致。`);
  }
  if (docs > 0 && !meta.lastBuiltAt) problems.push('索引没有记录建立时间，无法判断是否过期。');
  if (meta.partial) problems.push('上次建立索引没有跑完，可能缺少部分笔记正文；可以再跑一次补齐。');
  if (meta.lastBuiltAt && meta.lastBuiltAt > Date.now() + 60_000) {
    problems.push('索引的建立时间在未来，可能是设备时间被改过。');
  }

  return {
    docs,
    corrupt,
    meta,
    unreadable,
    problems,
    needsRebuild: unreadable || corrupt > 0
  };
}

async function readAllDocs(): Promise<IndexedDoc[]> {
  const db = await openDb();
  return await new Promise<IndexedDoc[]>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve((req.result as IndexedDoc[]) || []);
    req.onerror = () => reject(req.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function putDocs(docs: IndexedDoc[]): Promise<void> {
  if (docs.length === 0) return;
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      docs.forEach((doc) => store.put(doc));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    console.warn('[Self-Hub] vault index write failed', err);
  }
}

/* -------------------------------------------------------------- extraction */

const TAG_RE = /(^|[\s(（[【>])#([\p{L}\p{N}_\-/]{1,64})/gu;
const WIKILINK_RE = /\[\[([^\]\n]+?)\]\]/g;

/** Tags declared in frontmatter plus inline `#tag` occurrences. */
export function extractTags(content: string): string[] {
  const tags = new Set<string>();

  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (fm) {
    const tagLine = /^tags:\s*(.+)$/m.exec(fm[1]);
    if (tagLine) {
      tagLine[1]
        .replace(/^\[|\]$/g, '')
        .split(',')
        .map((t) => t.trim().replace(/^["']|["']$/g, '').replace(/^#/, ''))
        .filter(Boolean)
        .forEach((t) => tags.add(t));
    }
    // `tags:\n  - a\n  - b`
    const block = /^tags:\s*\r?\n((?:\s*-\s*.+\r?\n?)+)/m.exec(fm[1]);
    if (block) {
      block[1]
        .split('\n')
        .map((line) => line.replace(/^\s*-\s*/, '').trim().replace(/^#/, ''))
        .filter(Boolean)
        .forEach((t) => tags.add(t));
    }
  }

  // Inline tags: skip fenced code blocks to avoid `#include <stdio.h>` noise.
  const withoutCode = content.replace(/```[\s\S]*?```/g, '');
  for (const match of withoutCode.matchAll(TAG_RE)) {
    tags.add(match[2]);
  }
  return [...tags];
}

/** Wikilink targets, normalised to the same form used for resolution. */
export function extractWikilinks(content: string): string[] {
  const out = new Set<string>();
  const withoutCode = content.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
  for (const match of withoutCode.matchAll(WIKILINK_RE)) {
    const target = match[1].split('|')[0].split('#')[0].trim();
    if (target) out.add(target);
  }
  return [...out];
}

/* --------------------------------------------------------------- building */

/** Fetch bodies for new/changed notes and upsert them. Skips unchanged ones. */
export async function buildIndex(
  config: ObsidianConfig,
  notes: ObsidianNote[],
  existing: IndexedDoc[],
  onProgress?: (p: BuildProgress) => void,
  concurrency = 4,
  /**
   * Cancellation (§P2-07 "导入与索引可取消，可看到进度").
   *
   * A vault index can mean hundreds of HTTP fetches; on a slow connection the user
   * must be able to stop it. Everything fetched so far is still persisted, so a
   * cancelled run is progress rather than a lost one.
   */
  options: { signal?: AbortSignal } = {}
): Promise<BuildResult> {
  const byKey = new Map(existing.map((d) => [d.key, d]));
  const targets = notes.filter((n) => n.key.toLowerCase().endsWith('.md'));

  const pending: ObsidianNote[] = [];
  let skipped = 0;
  for (const note of targets) {
    const prev = byKey.get(note.key);
    const unchanged = prev && prev.lastModified === note.lastModified && prev.size === note.size;
    if (unchanged) skipped++;
    else pending.push(note);
  }

  const progress: BuildProgress = {
    done: 0,
    total: pending.length,
    fetched: 0,
    skipped,
    failed: 0
  };

  const fresh: IndexedDoc[] = [];
  const errors: string[] = [];
  let cursor = 0;

  const worker = async () => {
    while (cursor < pending.length) {
      if (options.signal?.aborted) return;
      const note = pending[cursor++];
      progress.currentKey = note.key;
      try {
        const content = await fetchObsidianNoteContent(config, note.key);
        if (content === null) {
          progress.failed++;
          if (errors.length < 5) errors.push(`${note.key}: 读取失败`);
        } else {
          fresh.push({
            key: note.key,
            title: note.title,
            text: content,
            tags: extractTags(content),
            links: extractWikilinks(content),
            lastModified: note.lastModified,
            size: note.size,
            indexedAt: Date.now()
          });
          progress.fetched++;
        }
      } catch (err: any) {
        progress.failed++;
        if (errors.length < 5) errors.push(`${note.key}: ${err?.message || '读取异常'}`);
      }
      progress.done++;
      onProgress?.({ ...progress });
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));

  // Persist in batches to keep transactions short.
  for (let i = 0; i < fresh.length; i += 100) {
    await putDocs(fresh.slice(i, i + 100));
  }

  // Drop entries for notes that no longer exist in the bucket.
  const liveKeys = new Set(targets.map((n) => n.key));
  const stale = existing.filter((d) => !liveKeys.has(d.key)).map((d) => d.key);
  if (stale.length > 0) {
    try {
      const db = await openDb();
      await new Promise<void>((resolve) => {
        const tx = db.transaction(STORE, 'readwrite');
        const store = tx.objectStore(STORE);
        stale.forEach((key) => store.delete(key));
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      });
    } catch {
      // ignore
    }
  }

  const merged = new Map(byKey);
  fresh.forEach((doc) => merged.set(doc.key, doc));
  stale.forEach((key) => merged.delete(key));

  const cancelled = Boolean(options.signal?.aborted);
  writeIndexMeta({ lastBuiltAt: Date.now(), docs: merged.size, partial: cancelled });

  return {
    records: [...merged.values()],
    fetched: progress.fetched,
    skipped,
    failed: progress.failed,
    errors,
    cancelled
  };
}

/* --------------------------------------------------------------- searching */

export interface SearchHit {
  key: string;
  title: string;
  /** Which field matched. */
  field: 'title' | 'content' | 'tag' | 'link';
  /** Context around the match, for the result row. */
  snippet: string;
  /** Offset of the match inside `snippet` (for highlighting). */
  matchIndex: number;
  matchLength: number;
}

export interface SearchPage {
  hits: SearchHit[];
  /** Total matches, not just the ones on this page. */
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
}

/**
 * Paged search over the index (§P2-07 "分页与按需加载").
 *
 * `searchIndex` used to cap at a fixed limit with no way to tell whether that was
 * everything — so a query with 300 matches and one with 80 looked the same. This
 * returns the real total so the UI can say "还有 N 条".
 */
export function searchIndexPage(
  records: IndexedDoc[],
  query: string,
  options: { offset?: number; limit?: number } = {}
): SearchPage {
  const offset = Math.max(0, options.offset ?? 0);
  const limit = Math.max(1, options.limit ?? 40);
  const all = searchIndex(records, query, Number.MAX_SAFE_INTEGER);
  return {
    hits: all.slice(offset, offset + limit),
    total: all.length,
    offset,
    limit,
    hasMore: offset + limit < all.length
  };
}

function makeSnippet(text: string, index: number, length: number, radius = 48): { snippet: string; matchIndex: number } {
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + length + radius);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < text.length ? '…' : '';
  const snippet = `${prefix}${text.slice(start, end).replace(/\s+/g, ' ')}${suffix}`;

  // Whitespace collapsing shifts offsets, so re-locate the match inside the
  // final snippet instead of doing arithmetic on the original index.
  const matched = text.slice(index, index + length).replace(/\s+/g, ' ');
  const found = matched ? snippet.toLowerCase().indexOf(matched.toLowerCase()) : -1;
  return { snippet, matchIndex: found >= 0 ? found : 0 };
}

/**
 * Search indexed bodies. Case-insensitive substring match over title, body, tags
 * and wikilink targets. `#tag` queries match tags exactly.
 */
export function searchIndex(records: IndexedDoc[], query: string, limit = 80): SearchHit[] {
  const raw = query.trim();
  if (!raw) return [];

  const tagQuery = raw.startsWith('#') ? raw.slice(1).toLowerCase() : null;
  const needle = raw.toLowerCase();
  const hits: SearchHit[] = [];

  for (const doc of records) {
    if (tagQuery) {
      const hit = doc.tags.find((t) => t.toLowerCase() === tagQuery);
      if (hit) {
        hits.push({
          key: doc.key,
          title: doc.title,
          field: 'tag',
          snippet: `#${hit}`,
          matchIndex: 0,
          matchLength: hit.length + 1
        });
        if (hits.length >= limit) break;
        continue;
      }
    }

    const titleIndex = doc.title.toLowerCase().indexOf(needle);
    if (titleIndex >= 0) {
      hits.push({
        key: doc.key,
        title: doc.title,
        field: 'title',
        snippet: doc.title,
        matchIndex: titleIndex,
        matchLength: needle.length
      });
      if (hits.length >= limit) break;
      continue;
    }

    const bodyIndex = doc.text.toLowerCase().indexOf(needle);
    if (bodyIndex >= 0) {
      const { snippet, matchIndex } = makeSnippet(doc.text, bodyIndex, needle.length);
      hits.push({
        key: doc.key,
        title: doc.title,
        field: 'content',
        snippet,
        matchIndex,
        matchLength: needle.length
      });
      if (hits.length >= limit) break;
      continue;
    }

    const linkHit = doc.links.find((l) => l.toLowerCase().includes(needle));
    if (linkHit) {
      hits.push({
        key: doc.key,
        title: doc.title,
        field: 'link',
        snippet: `[[${linkHit}]]`,
        matchIndex: 2,
        matchLength: linkHit.length
      });
      if (hits.length >= limit) break;
    }
  }

  return hits;
}

/** Notes that link to `targetKey` (resolved by file name). */
export function findBacklinks(records: IndexedDoc[], targetKey: string): SearchHit[] {
  const base = (targetKey.split('/').pop() || targetKey).replace(/\.md$/i, '').toLowerCase();
  const out: SearchHit[] = [];
  for (const doc of records) {
    if (doc.key === targetKey) continue;
    const hit = doc.links.find((l) => {
      const target = (l.split('/').pop() || l).replace(/\.md$/i, '').toLowerCase();
      return target === base;
    });
    if (hit) {
      out.push({
        key: doc.key,
        title: doc.title,
        field: 'link',
        snippet: `[[${hit}]]`,
        matchIndex: 2,
        matchLength: hit.length
      });
    }
  }
  return out;
}

/** Aggregate stats for the index panel. */
export function indexStats(records: IndexedDoc[]) {
  let chars = 0;
  let bytes = 0;
  let withTags = 0;
  for (const doc of records) {
    chars += doc.text.length;
    // The cloud object size is the UTF-8 byte count — a far better estimate of
    // what we store than counting JS characters.
    bytes += doc.size || 0;
    if (doc.tags.length > 0) withTags++;
  }
  return { docs: records.length, chars, bytes, withTags };
}

export interface StorageEstimate {
  usageBytes?: number;
  quotaBytes?: number;
}

/** Device-level storage usage for this origin, when the browser reports it. */
export async function estimateOriginStorage(): Promise<StorageEstimate> {
  try {
    if (typeof navigator === 'undefined' || !navigator.storage?.estimate) return {};
    const { usage, quota } = await navigator.storage.estimate();
    return { usageBytes: usage, quotaBytes: quota };
  } catch {
    return {};
  }
}

export function formatBytes(bytes?: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}
