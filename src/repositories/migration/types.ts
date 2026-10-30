/**
 * Migration types shared by the readers, the mapping layer and the runner
 * (P2-02).
 */

/** The v2 payload key. Imported rather than duplicated so a rename cannot drift. */
export const STORAGE_KEY_SELF_HUB = 'self_hub_data_v2';

/** Stage directory for a staging library, kept out of the live one. */
export const STAGING_LIBRARY_PREFIX = 'staging-';

/** Where the immutable pre-migration snapshot is stored. */
export const SNAPSHOT_KEY_PREFIX = 'self_hub_migration_snapshot_';

/** Marker that an environment's old writer must stop while a switch is pending. */
// Single definition lives in lib/migrationGate (the eager write guard needs it too).
export { MIGRATION_LOCK_KEY } from '../../lib/migrationGate';

export interface ConflictRecord {
  kind: 'same-id-two-sources' | 'same-url-different-content' | 'dangling-reference' | 'unmappable';
  collection: string;
  id?: string;
  detail: string;
}

export interface UnknownFieldRecord {
  source: string;
  collection: string;
  field: string;
}

export interface CountRecord {
  store: string;
  /** Records read from a source. */
  read: number;
  /** Records written into the staging library. */
  written: number;
  /** Records skipped because an identical record already existed (re-run). */
  skipped: number;
}

export interface MappingResult {
  /** `${store}:${JSON.stringify(key)}` → record, already deduplicated. */
  records: Map<string, { store: string; key: unknown; value: unknown }>;
  counts: CountRecord[];
  conflicts: ConflictRecord[];
  unknownFields: UnknownFieldRecord[];
  warnings: string[];
}

export interface SourceHashRecord {
  source: string;
  hash: string;
  counts: Record<string, number>;
}

export interface MigrationCheckpoint {
  /** Batch index already committed; a re-run resumes after it. */
  batchIndex: number;
  /** Identity of the inputs, so a changed source forces a re-read. */
  sourceHashes: SourceHashRecord[];
  stagingLibraryId: string;
  startedAt: number;
  updatedAt: number;
}

export type MigrationPhase =
  | 'discovered'
  | 'snapshot-saved'
  | 'preflight'
  | 'staging'
  | 'verified'
  | 'switched'
  | 'failed';

export interface MigrationReport {
  id: string;
  from: string;
  to: string;
  phase: MigrationPhase;
  stagingLibraryId: string;
  sourceHashes: SourceHashRecord[];
  counts: CountRecord[];
  conflicts: ConflictRecord[];
  unknownFields: UnknownFieldRecord[];
  warnings: string[];
  /** Set when verification failed; the live library is left untouched. */
  failure?: string;
  createdAt: number;
  updatedAt: number;
}

export interface MigrateOptions {
  /**
   * Snapshot password. Required: §13.3 requires an encrypted copy of both raw
   * sources before anything is written, so that a failed migration is
   * recoverable. Refusing to run without one is deliberate.
   */
  password: string;
  /** Target library id. Defaults to a fresh staging id. */
  stagingLibraryId?: string;
  /** Records per commit; §13.3 suggests ~200 with a yield between batches. */
  batchSize?: number;
  /** Include the extension's chrome.storage as a source when available. */
  includeChromeStorage?: boolean;
  /**
   * Use the live payload as authoritative and let the v1 mirror fill gaps only.
   *
   * The switch to v3 passes 	rue: the app mirrors every save into that IndexedDB copy,
   * so the archival default (both sources, namespaced ids) would put every record into the
   * switched library twice.
   */
  preferPayload?: boolean;
  /** Resume from a previous run's checkpoint instead of starting over. */
  resume?: boolean;
  /** Stop after this many batches (test hook for interrupt/resume). */
  maxBatches?: number;
  /** Skip the final activeLibraryId switch (staging-only verification). */
  skipSwitch?: boolean;
  /**
   * Explicitly allow the final switch even when the build default is off.
   *
   * It exists so the switch itself can be exercised and verified end to end
   * without making it the default for users: enabling it by default is a separate
   * decision that needs P2-05's restore path and P2-07's regression to stand on.
   */
  allowSwitch?: boolean;
}

export interface MigrateOutcome {
  ok: boolean;
  report: MigrationReport;
  /** Set when the migration stopped short on purpose (test hook). */
  interrupted?: boolean;
  /** Hash of the encrypted snapshot, so the caller can prove it exists. */
  snapshotHash?: string;
  /** True when the active library was switched to the staging library. */
  switched: boolean;
  error?: string;
}
