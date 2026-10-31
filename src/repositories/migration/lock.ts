/**
 * Migration lock (P2-02), the durable half of P0-03's write guard.
 * §13.3 requires the old writers to stop *before* a migration touches anything,
 * and §13.4 requires that a failed migration leaves the live library usable. The
 * · - The lock **expires**. A crashed tab must not freeze the app forever; an
 */
import { type MigrationPhase } from './types';
import {
  LOCK_TTL_MS,
  MIGRATION_LOCK_KEY,
  isWriteBlockedByMigration as gateWriteBlocked,
  readMigrationLock
} from '../../lib/migrationGate';

export interface MigrationLock {
  owner: string;
  acquiredAt: number;
  expiresAt: number;
  phase: MigrationPhase;
  stagingLibraryId: string;
  /** Bumped every time the lock is acquired, so a stale owner can detect it lost. */
  fence: number;
}

export { LOCK_TTL_MS };

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function safeRemove(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* unavailable */
  }
}

export function newLockOwner(): string {
  return `mig-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function readLock(): MigrationLock | null {
  // Delegated: the reader lives in `lib/migrationGate` so that `lib/storage.ts` (which
  // asks this on every write) does not statically pull the migration package into the
  // entry chunk. Same key, same shape.
  return readMigrationLock();
}

export function isLockLive(lock: MigrationLock | null, now = Date.now()): boolean {
  return Boolean(lock && lock.expiresAt > now);
}

export interface AcquireResult {
  ok: boolean;
  lock?: MigrationLock;
  /** True when an expired lock was taken over. */
  reclaimed?: boolean;
  /** Set when a live lock owned by somebody else blocks the acquisition. */
  blockedBy?: MigrationLock;
}

/**
 * Take the lock.
 *
 * `force` reclaims even a live lock; it exists for the explicit "迁移卡住了，强制
 * 接管" action and is never used implicitly — a silent takeover could abandon a
 * half-written migration that another tab is still finishing.
 */
export function acquireLock(
  stagingLibraryId: string,
  options: { owner?: string; phase?: MigrationPhase; force?: boolean; now?: number } = {}
): AcquireResult {
  const now = options.now ?? Date.now();
  const existing = readLock();
  const owner = options.owner ?? newLockOwner();

  if (isLockLive(existing, now) && existing && existing.owner !== owner && !options.force) {
    return { ok: false, blockedBy: existing };
  }

  const lock: MigrationLock = {
    owner,
    acquiredAt: now,
    expiresAt: now + LOCK_TTL_MS,
    phase: options.phase ?? 'discovered',
    stagingLibraryId,
    fence: (existing?.fence ?? 0) + 1
  };
  if (!safeSet(MIGRATION_LOCK_KEY, JSON.stringify(lock))) {
    return { ok: false };
  }
  return { ok: true, lock, reclaimed: Boolean(existing && !isLockLive(existing, now)) };
}

/** Extend a lock this process still owns. Returns false when ownership was lost. */
export function renewLock(owner: string, phase?: MigrationPhase, now = Date.now()): boolean {
  const existing = readLock();
  if (!existing || existing.owner !== owner) return false;
  const lock: MigrationLock = {
    ...existing,
    expiresAt: now + LOCK_TTL_MS,
    phase: phase ?? existing.phase
  };
  return safeSet(MIGRATION_LOCK_KEY, JSON.stringify(lock));
}

/** Release a lock this process owns. A foreign lock is left alone. */
export function releaseLock(owner: string): boolean {
  const existing = readLock();
  if (!existing) return true;
  if (existing.owner !== owner) return false;
  safeRemove(MIGRATION_LOCK_KEY);
  return true;
}

/** True when a write from `writer` must be refused. Delegated to `lib/migrationGate`. */
export function isWriteBlockedByMigration(writer: string, now = Date.now()): boolean {
  return gateWriteBlocked(writer, now);
}
