/**
 * Extension-origin store (P2-04).
 *
 * The single writer for everything the extension itself owns. Before this file,
 * four different scripts wrote `chrome.storage.local` collections directly
 * (`newtab.js`, `sidepanel.js`, `popup.js`, `background.js`), plus the app mirrored
 * whole collections in from another origin — so a capture made while the app was
 * open could be overwritten by whichever writer ran last.
 *
 * Design choices worth stating:
 *
 * - **IndexedDB, not `chrome.storage.local`.** The collections are unbounded
 *   (annotations grow with reading), and `chrome.storage` is a key/value blob whose
 *   whole value is rewritten on every save. IDB gives per-record writes.
 * - **Same store names as the app's v3 schema** (`annotations_v3`, `inbox_v3`, …)
 *   so the packed app and the extension can eventually read one database instead of
 *   two, without a second migration.
 * - **Idempotency lives here**, not in the callers: a repeated `operationId`
 *   returns the stored result, so a lost response cannot create a duplicate.
 * - **Tombstones, not deletes**, matching the app: `isDeleted` + `updatedAt` so a
 *   later merge can tell "deleted here" from "never existed".
 */
'use strict';

const DB_NAME = 'selfhub_extension';
const DB_VERSION = 1;

const STORES = {
  annotations: 'annotations_v3',
  inbox: 'inbox_v3',
  bookmarks: 'bookmarks_v3',
  quicknote: 'quicknote_v3',
  operations: 'operations_v3',
  meta: 'meta_v3'
};

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORES.annotations)) {
        const store = db.createObjectStore(STORES.annotations, { keyPath: 'id' });
        store.createIndex('pageUrl', 'pageUrl', { unique: false });
        store.createIndex('updatedAt', 'updatedAt', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORES.inbox)) {
        const store = db.createObjectStore(STORES.inbox, { keyPath: 'id' });
        store.createIndex('status', 'status', { unique: false });
        store.createIndex('createdAt', 'createdAt', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORES.bookmarks)) {
        db.createObjectStore(STORES.bookmarks, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORES.quicknote)) {
        db.createObjectStore(STORES.quicknote, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORES.operations)) {
        db.createObjectStore(STORES.operations, { keyPath: 'operationId' });
      }
      if (!db.objectStoreNames.contains(STORES.meta)) {
        db.createObjectStore(STORES.meta, { keyPath: 'key' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('打开扩展本地数据库失败'));
    request.onblocked = () => reject(new Error('扩展本地数据库被占用'));
  });
  return dbPromise;
}

function tx(db, names, mode) {
  return db.transaction(names, mode);
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB 请求失败'));
  });
}

function completionOf(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('事务失败'));
    transaction.onabort = () => reject(transaction.error || new Error('事务已中止'));
  });
}

function newId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Run a write once per `operationId` — **atomically**.
 *
 * The existence check, the data write and the operation record share **one** IndexedDB
 * transaction. The previous version used three separate transactions, which is not
 * idempotent under concurrency: two senders (two extension pages, or a retry racing the
 * original) both read "not present", both ran the action, and both wrote — the
 * `两个扩展页面同时提交同一 operationId` test caught exactly that duplicate.
 *
 * `action(txn, db)` must only await IndexedDB requests, otherwise the transaction would
 * auto-commit between them and the atomicity is lost again.
 */
async function withIdempotency(operationId, stores, action) {
  const db = await openDb();
  if (!operationId) {
    // No key to deduplicate on: run the action on its own transaction.
    return action(null, db);
  }
  const txn = tx(db, [STORES.operations, ...stores], 'readwrite');
  const operations = txn.objectStore(STORES.operations);
  const existing = await requestToPromise(operations.get(operationId));
  if (existing) {
    await completionOf(txn).catch(() => undefined);
    return { ...existing.result, replayed: true };
  }
  const result = await action(txn, db);
  operations.put({ operationId, at: Date.now(), result });
  await completionOf(txn);
  return result;
}

/* -------------------------------------------------------------------------- */
/* Annotations                                                                 */
/* -------------------------------------------------------------------------- */

async function listAnnotations(pageUrl) {
  const db = await openDb();
  const all = await requestToPromise(
    tx(db, [STORES.annotations], 'readonly').objectStore(STORES.annotations).getAll()
  );
  const active = all.filter((row) => !row.isDeleted);
  return pageUrl ? active.filter((row) => row.pageUrl === pageUrl) : active;
}

async function saveAnnotation(annotation, operationId) {
  return withIdempotency(operationId, [STORES.annotations], async (txn, db) => {
    const handle = txn ?? tx(db, [STORES.annotations], 'readwrite');
    const store = handle.objectStore(STORES.annotations);
    const now = Date.now();
    const record = {
      id: annotation.id || newId('ann'),
      pageUrl: annotation.pageUrl,
      pageTitle: annotation.pageTitle || annotation.pageUrl,
      text: annotation.text,
      note: annotation.note || '',
      color: annotation.color || 'yellow',
      tags: Array.isArray(annotation.tags) ? annotation.tags : [],
      anchor: annotation.anchor,
      projectId: annotation.projectId,
      createdAt: annotation.createdAt || now,
      updatedAt: now,
      isDeleted: false,
      revision: (annotation.revision || 0) + 1
    };
    store.put(record);
    // Same transaction, so the count cannot disagree with what was just written.
    const all = await requestToPromise(store.getAll());
    if (!txn) await completionOf(handle);
    const active = all.filter((row) => !row.isDeleted);
    return { id: record.id, count: active.length, revision: record.revision, updatedAt: now };
  });
}

/** Soft delete: a tombstone keeps "deleted here" distinguishable from "absent". */
async function deleteAnnotation(id, operationId) {
  return withIdempotency(operationId, [STORES.annotations], async (txn, db) => {
    const handle = txn ?? tx(db, [STORES.annotations], 'readwrite');
    const store = handle.objectStore(STORES.annotations);
    const existing = await requestToPromise(store.get(id));
    const now = Date.now();
    if (existing) {
      store.put({
        ...existing,
        isDeleted: true,
        updatedAt: now,
        revision: (existing.revision || 0) + 1
      });
    }
    const all = await requestToPromise(store.getAll());
    if (!txn) await completionOf(handle);
    const active = all.filter((row) => !row.isDeleted);
    return { id, count: active.length };
  });
}

/* -------------------------------------------------------------------------- */
/* Inbox                                                                      */
/* -------------------------------------------------------------------------- */

async function listInbox(status) {
  const db = await openDb();
  const all = await requestToPromise(tx(db, [STORES.inbox], 'readonly').objectStore(STORES.inbox).getAll());
  const active = all.filter((row) => !row.isDeleted && (!status || row.status === status));
  return active.sort((a, b) => b.createdAt - a.createdAt);
}

async function captureEntry(payload, operationId) {
  return withIdempotency(operationId, [STORES.inbox], async (txn, db) => {
    const handle = txn ?? tx(db, [STORES.inbox], 'readwrite');
    const now = Date.now();
    const text = String(payload.text || '').trim();
    const url = typeof payload.url === 'string' ? payload.url : undefined;
    const record = {
      id: newId('inbox'),
      content: text,
      url,
      title: url ? text.slice(0, 80) : undefined,
      type: url ? 'url' : 'text',
      status: 'inbox',
      createdAt: now,
      updatedAt: now,
      source: payload.source === 'content' ? 'extension' : 'extension',
      operationId,
      isDeleted: false
    };
    handle.objectStore(STORES.inbox).put(record);
    if (!txn) await completionOf(handle);
    return { id: record.id, createdAt: now };
  });
}

async function updateInboxStatus(id, status, operationId) {
  return withIdempotency(operationId, [STORES.inbox], async (txn, db) => {
    const handle = txn ?? tx(db, [STORES.inbox], 'readwrite');
    const store = handle.objectStore(STORES.inbox);
    const existing = await requestToPromise(store.get(id));
    if (existing) {
      store.put({ ...existing, status, updatedAt: Date.now() });
    }
    if (!txn) await completionOf(handle);
    return existing ? { id, updated: true, status } : { id, updated: false };
  });
}

/* -------------------------------------------------------------------------- */
/* Bookmarks, quick note, meta                                                */
/* -------------------------------------------------------------------------- */

async function listBookmarks() {
  const db = await openDb();
  return requestToPromise(tx(db, [STORES.bookmarks], 'readonly').objectStore(STORES.bookmarks).getAll());
}

/** Replace the bookmark list in one transaction; ids are stable. */
async function replaceBookmarks(sites) {
  const db = await openDb();
  const writeTx = tx(db, [STORES.bookmarks], 'readwrite');
  const store = writeTx.objectStore(STORES.bookmarks);
  store.clear();
  for (const site of sites) {
    store.put({
      id: site.id,
      title: site.title,
      url: site.url,
      desc: site.description || site.desc || '',
      category: site.category,
      pinned: Boolean(site.pinned),
      visitCount: site.visitCount || 0,
      order: site.order
    });
  }
  await completionOf(writeTx);
  return sites.length;
}

const QUICK_NOTE_ID = 'current';

async function readQuickNote() {
  const db = await openDb();
  const row = await requestToPromise(tx(db, [STORES.quicknote], 'readonly').objectStore(STORES.quicknote).get(QUICK_NOTE_ID));
  return row || { id: QUICK_NOTE_ID, text: '', updatedAt: 0 };
}

async function saveQuickNote(text) {
  const db = await openDb();
  const now = Date.now();
  const writeTx = tx(db, [STORES.quicknote], 'readwrite');
  writeTx.objectStore(STORES.quicknote).put({ id: QUICK_NOTE_ID, text, updatedAt: now });
  await completionOf(writeTx);
  return { text, updatedAt: now };
}

/** Reminders published by the app live here so the alarm handler can read them. */
async function setReminders(reminders) {
  const db = await openDb();
  const writeTx = tx(db, [STORES.meta], 'readwrite');
  writeTx.objectStore(STORES.meta).put({ key: 'reminders', value: reminders, at: Date.now() });
  await completionOf(writeTx);
  return reminders.length;
}

async function getReminders() {
  const db = await openDb();
  const row = await requestToPromise(tx(db, [STORES.meta], 'readonly').objectStore(STORES.meta).get('reminders'));
  return Array.isArray(row?.value) ? row.value : [];
}

async function setMeta(key, value) {
  const db = await openDb();
  const writeTx = tx(db, [STORES.meta], 'readwrite');
  writeTx.objectStore(STORES.meta).put({ key, value, at: Date.now() });
  await completionOf(writeTx);
}

async function getMeta(key) {
  const db = await openDb();
  const row = await requestToPromise(tx(db, [STORES.meta], 'readonly').objectStore(STORES.meta).get(key));
  return row?.value;
}

/** Counts for the diagnostics panel; no bodies, no credentials. */
async function counts() {
  const [annotations, inbox, bookmarks, inboxRows] = await Promise.all([
    listAnnotations(),
    listInbox(),
    listBookmarks(),
    listInbox()
  ]);
  return {
    annotations: annotations.length,
    inbox: inbox.length,
    bookmarks: bookmarks.length,
    pendingInbox: inboxRows.filter((row) => row.status === 'inbox').length
  };
}

export const ExtensionStore = {
  STORES,
  listAnnotations,
  saveAnnotation,
  deleteAnnotation,
  listInbox,
  captureEntry,
  updateInboxStatus,
  listBookmarks,
  replaceBookmarks,
  readQuickNote,
  saveQuickNote,
  setReminders,
  getReminders,
  setMeta,
  getMeta,
  counts
};
