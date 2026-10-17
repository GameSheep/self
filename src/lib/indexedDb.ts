/**
 * Self-Hub Local-First IndexedDB Storage Engine (N04)
 * Provides item-level transactions, persistent Blob storage, and quota estimation
 */
import { HubState } from '../types';

const DB_NAME = 'self_hub_idb';
const DB_VERSION = 1;

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
 * Save single item into IndexedDB store
 */
export async function saveItemToDb<T>(storeName: string, item: T): Promise<void> {
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const req = store.put(item);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

/**
 * Delete single item from IndexedDB store
 */
export async function deleteItemFromDb(storeName: string, id: string): Promise<void> {
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const req = store.delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

/**
 * Get all items from an IndexedDB store
 */
export async function getAllFromDb<T>(storeName: string): Promise<T[]> {
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Sync entire HubState into IndexedDB
 */
export async function syncStateToIndexedDb(state: HubState): Promise<void> {
  try {
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

    // Sync collections
    const putAll = (storeName: string, items: any[] | undefined) => {
      if (!items || !Array.isArray(items)) return;
      const store = tx.objectStore(storeName);
      for (const it of items) {
        store.put(it);
      }
    };

    putAll('notes', state.notes);
    putAll('sites', state.sites);
    putAll('servers', state.servers);
    putAll('secrets', state.secrets);
    putAll('reminders', state.reminders);
    putAll('inbox', state.inbox);
    putAll('projects', state.projects);
    putAll('annotations', state.annotations);

    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    console.warn('Failed to sync to IndexedDB', err);
  }
}

/**
 * Load complete HubState from IndexedDB (N04 recovery engine)
 */
export async function loadStateFromIndexedDb(): Promise<HubState | null> {
  try {
    const db = await getDb();
    const [notes, sites, servers, secrets, reminders, inbox, projects, annotations] = await Promise.all([
      getAllFromDb<any>('notes'),
      getAllFromDb<any>('sites'),
      getAllFromDb<any>('servers'),
      getAllFromDb<any>('secrets'),
      getAllFromDb<any>('reminders'),
      getAllFromDb<any>('inbox'),
      getAllFromDb<any>('projects'),
      getAllFromDb<any>('annotations')
    ]);

    if (!sites || sites.length === 0) {
      return null;
    }

    return {
      schemaVersion: 2,
      theme: 'dark',
      categories: ['全部', '常用工具', '云平台与运维', '自研与部署', 'API与服务', '日常资讯'],
      sites,
      servers,
      secrets,
      reminders,
      notes,
      inbox,
      projects,
      annotations,
      checkIns: [],
      handwritings: [],
      obsidianConfig: { enabled: false, bucket: '', endpoint: '', region: '', accessKeyId: '', accessKeySecret: '', prefix: '' },
      aiConfig: { provider: 'gemini', apiKey: '', baseUrl: '', model: '' },
      cloudflareSync: { enabled: false, workerUrl: '', syncKey: '', autoSync: false },
      webdavConfig: { enabled: false, url: '', username: '', password: '', pathPrefix: 'selfhub_sync' }
    };
  } catch (err) {
    console.warn('Failed to load state from IndexedDB', err);
    return null;
  }
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
