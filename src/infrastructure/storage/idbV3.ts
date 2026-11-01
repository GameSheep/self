/**
 * v3 IndexedDB provisioning (P2-01).
 * Kept separate from the repository so the upgrade path is one auditable place:
 */
import { V3_STORES, isLibraryScoped } from '../../repositories/schema';
import { closeDb, getDb } from '../../lib/indexedDb';

export const V3_DB_NAME = 'self_hub_idb';
/**
 * 1 = the P1-era mirror stores; 2 = adds the `_v3` stores beside them;
 * 3 = adds `migration_snapshots_v3` (the encrypted pre-migration snapshot, moved out of
 * `localStorage` so a library that outgrew the ~5 MB payload can still be migrated).
 */
/**
 * Schema generation of the v3 library database.
 *
 * 4: adds `domains_v3` (域名 became its own collection). The upgrade handler in
 *    `lib/indexedDb.ts` creates any store listed in `V3_STORES` that is missing, so a bump here
 *    is what makes the new store appear for existing installs.
 */
export const V3_DB_VERSION = 4;

/**
 * Old stores from the v1 schema.
 *
 * Listed explicitly so the upgrade is idempotent and so nothing here *removes*
 * them: they are the fallback read path until P2-02 has proven the migration.
 */
export const LEGACY_STORE_NAMES = [
  'metadata',
  'notes',
  'sites',
  'servers',
  'secrets',
  'reminders',
  'inbox',
  'projects',
  'annotations',
  'blobs'
] as const;

export function openV3Db(): Promise<IDBDatabase> {
  return getDb();
}

/** Which of the v3 stores actually exist, for diagnostics and migration checks. */
export async function inspectV3Schema(): Promise<{
  version: number;
  v3Stores: string[];
  missingV3Stores: string[];
  legacyStores: string[];
}> {
  const db = await openV3Db();
  const present = Array.from(db.objectStoreNames);
  return {
    version: db.version,
    v3Stores: V3_STORES.map((s) => s.name).filter((n) => present.includes(n)),
    missingV3Stores: V3_STORES.map((s) => s.name).filter((n) => !present.includes(n)),
    legacyStores: LEGACY_STORE_NAMES.filter((n) => present.includes(n))
  };
}

/* -------------------------------------------------------------------------- */
/* Transaction plumbing                                                        */
/* -------------------------------------------------------------------------- */

export interface TxContext {
  tx: IDBTransaction;
  store(name: string): IDBObjectStore;
}

/**
 * Run one IndexedDB transaction and resolve **only after `oncomplete`**.
 * This is the single place that decides what "written" means. §6.4 is explicit:
 */
export async function runV3Transaction<T>(
  stores: string[],
  mode: IDBTransactionMode,
  work: (ctx: TxContext) => Promise<T> | T
): Promise<{ value: T; committed: boolean }> {
  const db = await openV3Db();
  const unique = Array.from(new Set(stores));
  const tx = db.transaction(unique, mode);

  let abortRequested = false;
  const ctx: TxContext = {
    tx,
    store(name) {
      if (!unique.includes(name)) {
        throw new Error(`事务未包含集合 ${name}`);
      }
      return tx.objectStore(name);
    }
  };

  const completed = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('事务失败'));
    tx.onabort = () => reject(tx.error || new Error('事务已中止'));
  });

  let value: T;
  try {
    value = await work(ctx);
  } catch (err) {
    abortRequested = true;
    try {
      tx.abort();
    } catch {
      /* already finished */
    }
    await completed.catch(() => undefined);
    throw err;
  }

  if (abortRequested) {
    await completed.catch(() => undefined);
    throw new Error('事务已中止');
  }

  await completed;
  return { value, committed: true };
}

/** Wrap one IDBRequest as a promise. */
export function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB 请求失败'));
  });
}

/** Build an IDBKeyRange from the contract's range shape. */
export function toKeyRange(range?: {
  lower?: unknown;
  upper?: unknown;
  lowerOpen?: boolean;
  upperOpen?: boolean;
}): IDBKeyRange | null {
  if (!range) return null;
  const { lower, upper, lowerOpen, upperOpen } = range;
  if (lower !== undefined && upper !== undefined) {
    return IDBKeyRange.bound(lower, upper, Boolean(lowerOpen), Boolean(upperOpen));
  }
  if (lower !== undefined) return IDBKeyRange.lowerBound(lower, Boolean(lowerOpen));
  if (upper !== undefined) return IDBKeyRange.upperBound(upper, Boolean(upperOpen));
  return null;
}

/** Convenience for callers that need to know whether a store is library-scoped. */
export { isLibraryScoped };
