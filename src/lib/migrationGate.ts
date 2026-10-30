/**
 * "Is a migration running?" — the part of the migration lock that ordinary writers need.
 *
 * This lives **outside** `repositories/migration/` on purpose. `lib/storage.ts` has to ask
 * this question on every single write (§13.3: old writers stop before a migration touches
 * anything), and while it imported `repositories/migration/lock` the production entry
 * chunk statically pulled the migration package in with it — the first load paid for the
 * migration runner, sources and mapping, none of which can run until a user switches
 * storage mode. Measured: entry 174.82 → 184.00 KB gzip before this split (≈9 KB).
 *
 * The reverse dependency would be just as wrong, so this module owns the key and the
 * readers; `repositories/migration/lock.ts` imports *from here* and adds the writer side
 * (acquire/renew/release) that only a migration needs.
 */
import type { MigrationPhase } from '../repositories/migration/types';
import { runV3Transaction, requestToPromise } from '../infrastructure/storage/idbV3';

/** localStorage key holding the lock. Shared by every reader and writer of the lock. */
export const MIGRATION_LOCK_KEY = 'self_hub_migration_lock';

/** `library_meta_v3` key holding the library the app should read. */
export const ACTIVE_LIBRARY_KEY = 'activeLibraryId';

/** Fifteen minutes: long enough for a large migration, short enough to recover. */
export const LOCK_TTL_MS = 15 * 60 * 1000;

export interface MigrationLockSummary {
  owner: string;
  acquiredAt: number;
  expiresAt: number;
  phase: MigrationPhase;
  stagingLibraryId: string;
  /** Bumped every time the lock is acquired, so a stale owner can detect it lost. */
  fence: number;
}

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function readMigrationLock(): MigrationLockSummary | null {
  const raw = safeGet(MIGRATION_LOCK_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<MigrationLockSummary>;
    if (!parsed || typeof parsed.owner !== 'string') return null;
    return {
      owner: parsed.owner,
      acquiredAt: Number(parsed.acquiredAt) || 0,
      expiresAt: Number(parsed.expiresAt) || 0,
      phase: (parsed.phase as MigrationPhase) || 'discovered',
      stagingLibraryId: String(parsed.stagingLibraryId || ''),
      fence: Number(parsed.fence) || 0
    };
  } catch {
    return null;
  }
}

export function isMigrationLockLive(lock: MigrationLockSummary | null, now = Date.now()): boolean {
  return Boolean(lock && lock.expiresAt > now);
}

/**
 * True when `writer` must not write right now.
 *
 * An *expired* lock does not block: a crashed tab must not freeze the app forever.
 * Reclaiming it is the migration's job, and it is recorded rather than silent.
 */
export function isWriteBlockedByMigration(writer: string, now = Date.now()): boolean {
  const lock = readMigrationLock();
  if (!isMigrationLockLive(lock, now)) return false;
  // A migration's own writes are not blocked by its own lock.
  return lock?.owner !== writer;
}

/**
 * The library the app should read, or `null` when no migration has ever switched this device.
 *
 * This lives here rather than in the migration runner because **every reader and writer of
 * library data needs it**: the app's boot hydration, and — this is what made it a bug —
 * the v3 backup service, which used to default to the pre-migration `local-v2` library and
 * would have backed up the wrong data after a switch. It is a single indexed read, so the
 * eager cost is negligible.
 */
export async function readActiveLibraryId(): Promise<string | null> {
  try {
    const result = await runV3Transaction(['library_meta_v3'], 'readonly', async (ctx) =>
      requestToPromise(ctx.store('library_meta_v3').get(ACTIVE_LIBRARY_KEY))
    );
    const value = (result.value as { value?: unknown } | undefined)?.value;
    return typeof value === 'string' && value ? value : null;
  } catch {
    // No database yet (first run) or unreadable: "no active library" is the honest answer.
    return null;
  }
}
