/**
 * Self-Hub Local-First IndexedDB Storage Engine (N04)
 * Provides item-level transactions, persistent Blob storage, and quota estimation
 */
import { HubState } from '../types';
import { V3_DB_NAME, V3_DB_VERSION } from '../infrastructure/storage/idbV3';
import { V3_STORES } from '../repositories/schema';

const DB_NAME = V3_DB_NAME;
/**
 * 1 = the P1-era mirror stores. 2 adds the `_v3` stores beside them (P2-01).
 *
 * This module is the **only** opener of the database. A second module opening
 * the same database at a different version would be blocked by this connection
 * (which is cached and never closed), so `idbV3.ts` deliberately delegates here
 * instead of calling `indexedDB.open` itself.
 */
const DB_VERSION = V3_DB_VERSION;

let dbInstance: IDBDatabase | null = null;

/** Drop the cached connection (needed before deleting/upgrading the database). */
export function closeDb(): void {
  if (dbInstance) {
    try {
      dbInstance.close();
    } catch {}
    dbInstance = null;
  }
}

/**
 * Delete every IndexedDB database owned by this origin.
 * The reset action used to call deleteDatabase('SelfHubDB') while the real
 * database is named 'self_hub_idb', so nothing was ever removed.
 */
export async function deleteAllDatabases(): Promise<string[]> {
  closeDb();
  if (typeof indexedDB === 'undefined' || !indexedDB.databases) return [];
  try {
    const dbs = await indexedDB.databases();
    const names = dbs.map((d) => d.name).filter((n): n is string => Boolean(n));
    await Promise.all(
      names.map(
        (name) =>
          new Promise<void>((resolve) => {
            const req = indexedDB.deleteDatabase(name);
            req.onsuccess = () => resolve();
            req.onerror = () => resolve();
            // A blocked delete (another tab holding a connection) must not hang the UI.
            req.onblocked = () => resolve();
          })
      )
    );
    return names;
  } catch {
    return [];
  }
}

export async function getDb(): Promise<IDBDatabase> {
  if (dbInstance) return dbInstance;

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;

      // 1. Meta & Config store
      if (!db.objectStoreNames.contains('metadata')) {
        db.createObjectStore('metadata', { keyPath: 'key' });
      }

      // 2. Collections stores with indexes
      if (!db.objectStoreNames.contains('notes')) {
        const store = db.createObjectStore('notes', { keyPath: 'id' });
        store.createIndex('category', 'category', { unique: false });
        store.createIndex('updatedAt', 'updatedAt', { unique: false });
      }

      if (!db.objectStoreNames.contains('sites')) {
        const store = db.createObjectStore('sites', { keyPath: 'id' });
        store.createIndex('category', 'category', { unique: false });
        store.createIndex('pinned', 'pinned', { unique: false });
      }

      if (!db.objectStoreNames.contains('servers')) {
        const store = db.createObjectStore('servers', { keyPath: 'id' });
        store.createIndex('env', 'env', { unique: false });
      }

      if (!db.objectStoreNames.contains('secrets')) {
        const store = db.createObjectStore('secrets', { keyPath: 'id' });
        store.createIndex('category', 'category', { unique: false });
      }

      if (!db.objectStoreNames.contains('reminders')) {
        const store = db.createObjectStore('reminders', { keyPath: 'id' });
        store.createIndex('targetDate', 'targetDate', { unique: false });
      }

      if (!db.objectStoreNames.contains('inbox')) {
        const store = db.createObjectStore('inbox', { keyPath: 'id' });
        store.createIndex('status', 'status', { unique: false });
        store.createIndex('createdAt', 'createdAt', { unique: false });
      }

      if (!db.objectStoreNames.contains('projects')) {
        const store = db.createObjectStore('projects', { keyPath: 'id' });
        store.createIndex('status', 'status', { unique: false });
      }

      if (!db.objectStoreNames.contains('annotations')) {
        const store = db.createObjectStore('annotations', { keyPath: 'id' });
        store.createIndex('pageUrl', 'pageUrl', { unique: false });
        store.createIndex('projectId', 'projectId', { unique: false });
      }

      // 3. Attachments & Blob binary store
      if (!db.objectStoreNames.contains('blobs')) {
        db.createObjectStore('blobs', { keyPath: 'id' });
      }

      // 4. v3 stores (P2-01). Created *beside* the mirror stores above rather
      //    than replacing them: the old stores stay readable until the migration
      //    in P2-02 has been proven, and creating a store never rewrites a
      //    record. Existing stores are left completely alone — changing a
      //    keyPath or an index here would silently orphan data.
      for (const def of V3_STORES) {
        if (db.objectStoreNames.contains(def.name)) continue;
        const store = db.createObjectStore(def.name, { keyPath: def.keyPath as string | string[] });
        for (const index of def.indexes) {
          store.createIndex(index.name, index.keyPath as string | string[], {
            unique: Boolean(index.unique),
            multiEntry: Boolean(index.multiEntry)
          });
        }
      }
    };

    request.onsuccess = () => {
      dbInstance = request.result;
      resolve(dbInstance);
    };

    request.onerror = () => {
      reject(request.error);
    };
  });
}

/**
 * Sync entire HubState into IndexedDB
 *
 * The mirror is a migration data source, so it must reflect deletions too:
 * putting only the current items would leave removed records behind and a
 * later v3 migration would resurrect deleted notes/secrets. Each store is
 * reconciled — put current items, delete ids that are no longer in the state.
 */
export async function syncStateToIndexedDb(state: HubState): Promise<void> {
  const db = await getDb();
  const tx = db.transaction(
    ['notes', 'sites', 'servers', 'secrets', 'reminders', 'inbox', 'projects', 'annotations', 'metadata'],
    'readwrite'
  );

  // Save metadata snapshot
  tx.objectStore('metadata').put({ key: 'last_sync', value: Date.now() });
  tx.objectStore('metadata').put({ key: 'schema_version', value: 2 });
  tx.objectStore('metadata').put({ key: 'theme', value: state.theme });
  tx.objectStore('metadata').put({ key: 'categories', value: state.categories });

  const reconcile = (storeName: string, items: any[] | undefined, keyField: string) => {
    const store = tx.objectStore(storeName);
    const currentIds = new Set<string>();
    for (const it of items || []) {
      if (it && it[keyField] != null) {
        currentIds.add(String(it[keyField]));
        store.put(it);
      }
    }
    const cursorRequest = store.openCursor();
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (!cursor) return;
      if (!currentIds.has(String(cursor.key))) {
        cursor.delete();
      }
      cursor.continue();
    };
  };

  reconcile('notes', state.notes, 'id');
  reconcile('sites', state.sites, 'id');
  reconcile('servers', state.servers, 'id');
  reconcile('secrets', state.secrets, 'id');
  reconcile('reminders', state.reminders, 'id');
  reconcile('inbox', state.inbox, 'id');
  reconcile('projects', state.projects, 'id');
  reconcile('annotations', state.annotations, 'id');

  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error || new Error('sync transaction aborted'));
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Estimate storage usage using navigator.storage.estimate() (N04)
 */
export async function estimateStorageQuota(): Promise<{
  usageMb: number;
  quotaMb: number;
  percentage: number;
  persisted: boolean;
}> {
  if (navigator.storage && navigator.storage.estimate) {
    try {
      const estimate = await navigator.storage.estimate();
      const isPersisted = navigator.storage.persisted ? await navigator.storage.persisted() : false;
      const usageMb = (estimate.usage || 0) / (1024 * 1024);
      const quotaMb = (estimate.quota || 0) / (1024 * 1024);
      const percentage = quotaMb > 0 ? (usageMb / quotaMb) * 100 : 0;
      return {
        usageMb: Math.round(usageMb * 100) / 100,
        quotaMb: Math.round(quotaMb),
        percentage: Math.round(percentage * 10) / 10,
        persisted: isPersisted
      };
    } catch {}
  }

  return {
    usageMb: 0.8,
    quotaMb: 500,
    percentage: 0.16,
    persisted: false
  };
}

