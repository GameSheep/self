/**
 * Dev-only diagnostic bridge.
 *
 * Used by `tests/e2e/repository-contract.spec.ts` to run the shared contract
 * suite against **real** IndexedDB and the **real** legacy payload, inside a
 * browser, without Playwright having to import app internals (it cannot: the
 * repositories are TypeScript modules behind Vite).
 *
 * Guarded by `import.meta.env.DEV`, so a production build never exposes it. It
 * only constructs repositories and runs the read/write contract — it is not a
 * back door to credentials, settings or remote files.
 */
import { runContractSuite, type ContractCheckResult } from '../repositories/contractSuite';
import { IndexedDbRepository } from '../repositories/indexedDbRepository';
import { LegacyRepository } from '../repositories/legacyRepository';
import { inspectV3Schema } from '../infrastructure/storage/idbV3';
import {
  migrateV2ToV3,
  preflightMigration,
  readActiveLibraryId,
  readCheckpoint,
  readSnapshot,
  clearCheckpoint,
  type PreflightResult
} from '../repositories/migration/runner';
import { acquireLock, readLock, releaseLock } from '../repositories/migration/lock';
import type { MigrateOutcome, MigrateOptions } from '../repositories/migration/types';
import {
  ConnectionRepository,
  connectionStatus,
  evaluateReadiness,
  fingerprintConfig,
  requiredFieldsComplete,
  type ConnectionStatus,
  type TaskReadiness
} from '../repositories/connectionRepository';
import type { Connection, PurposeBinding, PurposeId } from '../domain/model';
import { JobQueue } from '../infrastructure/jobs/jobQueue';
import { runJobSuite, type JobCheckResult } from '../infrastructure/jobs/jobSuite';
import { runBackupSuite, type BackupCheckResult } from '../infrastructure/backup/backupSuite';
import { createTransport } from '../infrastructure/backup/providers';
import { runProviderRoundTrip, type ProviderRoundTripReport } from '../infrastructure/backup/providerSuite';
import type { ConflictStrategy, RestoreApplyResult, RestorePreview } from '../infrastructure/backup/restoreService';
import type { AdapterReport } from '../repositories/hubStateAdapter';
import { loadHubState, saveHubState } from '../lib/storage';
import type { HubState } from '../types';

/**
 * Import rule for this file: anything under `infrastructure/backup` or
 * `infrastructure/jobs` must be loaded with `await import(...)` inside the handler
 * that needs it, never imported at the top.
 *
 * The bridge is imported by the app entry even in a production build, where its body
 * is dead code that the bundler removes — but a *static* import here still makes the
 * module part of the entry graph. Twice now that quietly moved the backup stack
 * (≈6 KB, then ≈5 KB gzip) into the first load; `npm run measure:first-load` is what
 * caught both. `lib/storage` and the type-only imports are fine: the app loads them
 * anyway or they do not exist at runtime.
 */

/** Build an OSS config from the plain object a spec passes over the bridge. */
function toOssConfig(kind: 'oss' | 'webdav', config: Record<string, string>) {
  if (kind !== 'oss') return undefined;
  return {
    enabled: true,
    bucket: config.bucket ?? '',
    endpoint: config.endpoint ?? '',
    region: config.region ?? '',
    accessKeyId: config.accessKeyId ?? '',
    accessKeySecret: config.accessKeySecret ?? '',
    prefix: config.prefix ?? ''
  };
}

function toWebdavConfig(kind: 'oss' | 'webdav', config: Record<string, string>) {
  if (kind !== 'webdav') return undefined;
  return {
    enabled: true,
    url: config.url ?? '',
    username: config.username ?? '',
    password: config.password ?? '',
    pathPrefix: config.pathPrefix ?? ''
  };
}

export interface ConnectionBridge {
  save(input: {
    id?: string;
    provider: string;
    displayName?: string;
    publicConfig: Record<string, string>;
    purposes?: PurposeId[];
  }): Promise<{ ok: boolean; error?: unknown; connection?: Connection; versionBumped?: boolean }>;
  saveCredential(connectionId: string, secret: string, masterPassword: string): Promise<{ ok: boolean; error?: unknown }>;
  hasCredential(connectionId: string): Promise<{ ok: boolean; value?: boolean }>;
  reveal(connectionId: string, masterPassword: string): Promise<{ ok: boolean; value?: string; error?: unknown }>;
  recordVerification(
    connectionId: string,
    report: { ok: boolean; message: string; fingerprint: string; configVersion: number }
  ): Promise<{ ok: boolean; value?: { accepted: boolean; reason?: string } }>;
  status(connectionId: string): Promise<ConnectionStatus | null>;
  setPurpose(connectionId: string, purpose: PurposeId, enabled: boolean): Promise<{ ok: boolean; error?: unknown }>;
  bindings(connectionId?: string): Promise<PurposeBinding[]>;
  readiness(connectionId: string, purpose: PurposeId, vaultUnlocked: boolean): Promise<TaskReadiness | null>;
  previewDelete(connectionId: string): Promise<{
    ok: boolean;
    value?: { affectedPurposes: Array<{ purpose: string; enabled: boolean }>; referencingProjects: number; deletesRemoteData: boolean };
  }>;
  remove(connectionId: string): Promise<{ ok: boolean; value?: { deleted: boolean; disabledPurposes: number } }>;
  countWaitingUnlock(): Promise<number>;
  fingerprint(provider: string, config: Record<string, string>): string;
  requiredComplete(provider: string, config: Record<string, string>): boolean;
}

export interface MigrationBridge {
  preflight(options?: { stagingLibraryId?: string; includeChromeStorage?: boolean }): Promise<PreflightResult>;
  migrate(options: MigrateOptions): Promise<MigrateOutcome>;
  readSnapshot(migrationId: string, password: string): ReturnType<typeof readSnapshot>;
  checkpoint(stagingLibraryId: string): ReturnType<typeof readCheckpoint>;
  clearCheckpoint(stagingLibraryId: string): void;
  activeLibraryId(): Promise<string | null>;
  lock(): ReturnType<typeof readLock>;
  acquireLock(stagingLibraryId: string, options?: { force?: boolean }): ReturnType<typeof acquireLock>;
  releaseLock(owner: string): boolean;
}

export interface ContractBridge {
  run(kind: 'legacy' | 'indexeddb', runId: string): Promise<ContractCheckResult[]>;
  schema(): Promise<Awaited<ReturnType<typeof inspectV3Schema>>>;
  migration: MigrationBridge;
  connections(libraryId: string): ConnectionBridge;
  jobs: JobsBridge;
  backup: BackupBridge;
  /**
   * HubState ⇄ v3 library adapter (切库 phase 1).
   *
   * Top-level, not under `backup`: switching the fact source is a storage concern. The
   * app still reads localStorage; these calls exist so the mapping can be exercised
   * against real IndexedDB and a real payload without flipping the default.
   */
  library: LibraryBridge;
}

/**
 * Backup format surface (P2-05).
 *
 * `run` executes the in-page self-check suite against the real Web Crypto stack
 * with an in-memory transport. Providers are not involved on purpose: the format's
 * guarantees (write order, completion marker, hash verification, retention) are
 * what is under test.
 */
export interface BackupBridge {
  run(runId: string): Promise<BackupCheckResult[]>;
  /**
   * Drive a full v3 backup round trip through the **real** provider transport
   * (signed OSS requests / PROPFIND+MKCOL+DELETE over WebDAV) against whatever the
   * test has mocked at the network layer.
   */
  providerRoundTrip(input: {
    kind: 'oss' | 'webdav';
    config: Record<string, string>;
    libraryId: string;
    deviceId: string;
    password: string;
  }): Promise<{ ok: boolean; error?: string; report?: ProviderRoundTripReport }>;
  restore: RestoreBridge;
  /** Credentials migration packages (§10.3). */
  migration: MigrationPackageBridge;
  /** Single-file encrypted bundles (§9.1 web↔extension exchange). */
  bundle: BundleBridge;
}

export interface LibraryBridge {
  /** Write the current payload's business data into a v3 library. */
  save(
    libraryId: string,
    options?: { allowDrop?: boolean }
  ): Promise<{
    ok: boolean;
    error?: string;
    revision?: number;
    counts?: Record<string, number>;
    /** Records actually put (changed or new). */
    written?: Record<string, number>;
    /** Old records removed. */
    deleted?: Record<string, number>;
    report?: AdapterReport;
  }>;
  /** Read it back, composed with this device's connection config. */
  load(libraryId: string): Promise<{
    ok: boolean;
    error?: string;
    state?: unknown;
    counts?: Record<string, number>;
    report?: AdapterReport;
  }>;
  /**
   * Save + load and compare every record by id.
   *
   * This is the evidence that switching would not lose anything: a mismatch is
   * returned by id instead of being summarised away.
   */
  roundTrip(libraryId: string): Promise<{
    ok: boolean;
    error?: string;
    diff?: string[];
    counts?: Record<string, number>;
    report?: AdapterReport;
  }>;
}

export interface BundleBridge {
  build(input: {
    password: string;
    libraryId: string;
    deviceId: string;
    purpose?: 'backup' | 'migration';
    includeCredentials?: boolean;
  }): Promise<{ ok: boolean; error?: string; json?: string; fileName?: string; summary?: string }>;
  preview(input: {
    json: string;
    password: string;
    libraryId?: string;
  }): Promise<{ ok: boolean; error?: { code: string; userMessage: string }; preview?: RestorePreview }>;
}

export interface MigrationPackageBridge {
  export(input: {
    password: string;
    libraryId: string;
    deviceId: string;
    /** Must be true; the service refuses anything else. */
    confirm: boolean;
  }): Promise<{ ok: boolean; error?: string; generationId?: string; description?: string; warnings?: string[] }>;
  list(input: {
    libraryId: string;
    deviceId: string;
    password?: string;
  }): Promise<{
    ok: boolean;
    error?: string;
    packages?: Array<{
      generationId: string;
      complete: boolean;
      includesCredentials?: boolean;
      credentialScope?: string[];
      description?: string;
      counts?: Record<string, number>;
    }>;
  }>;
}

/**
 * Restore surface (P2-06).
 *
 * Reads and writes the **app's own payload** (`self_hub_data_v2`) so a spec can
 * drive the real preview/apply path: seed a package from one library, preview it
 * against what the app currently holds, then apply with a chosen strategy.
 * `setCurrentState` exists so a test can simulate "the user edited something after
 * the preview", which is the case that must be refused rather than overwritten.
 */
export interface RestoreBridge {
  seedBatch(input: {
    kind: 'oss' | 'webdav';
    config: Record<string, string>;
    state: unknown;
    password: string;
    libraryId: string;
    deviceId: string;
    generationId: string;
  }): Promise<{ ok: boolean; error?: string }>;
  preview(input: {
    kind: 'oss' | 'webdav';
    config: Record<string, string>;
    password: string;
    generationId: string;
    libraryId: string;
    deviceId: string;
    /** Set when the package lives under a different library prefix. */
    sourceLibraryId?: string;
    /** `migration` reads from the migration root (credentials packages). */
    purpose?: 'backup' | 'migration';
  }): Promise<{ ok: boolean; error?: { code: string; userMessage: string; suggestedAction?: string }; preview?: RestorePreview }>;
  apply(input: {
    previewId: string;
    mode: 'merge' | 'replace';
    conflicts?: Record<string, ConflictStrategy>;
    /** Migration packages only: adopt the package's connection credentials. */
    importCredentials?: boolean;
    credentialServices?: string[];
  }): Promise<{
    ok: boolean;
    error?: { code: string; userMessage: string };
    report?: RestoreApplyResult;
    state?: unknown;
  }>;
  currentState(): unknown;
  setCurrentState(state: unknown): void;
  /** This browser's stable device id (created on first use). */
  deviceId(): Promise<string>;
}

/**
 * Durable job queue surface (P2-05).
 *
 * `run` executes the in-page self-check suite. The individual calls exist so a
 * spec can prove durability across a **real page reload** — a fresh JS context
 * with no memory of the previous one is the closest a browser test gets to an
 * MV3 worker being terminated and restarted.
 */
export interface JobsBridge {
  run(runId: string): Promise<JobCheckResult[]>;
  enqueue(
    libraryId: string,
    input: { kind: string; scopeKey: string }
  ): Promise<{ ok: boolean; id?: string; created?: boolean; error?: unknown }>;
  claim(
    libraryId: string,
    owner: string
  ): Promise<{ ok: boolean; job?: { id: string; kind: string; state: string; attempt: number } | null; error?: unknown }>;
  summary(libraryId: string): Promise<Record<string, number>>;
}

declare global {
  interface Window {
    __selfhubContract?: ContractBridge;
  }
}

export function installRepositoryContractBridge(): void {
  if (!import.meta.env.DEV || typeof window === 'undefined') return;

  const migration: MigrationBridge = {
    preflight: (options) => preflightMigration(options ?? {}),
    migrate: (options) => migrateV2ToV3(options),
    readSnapshot: (migrationId, password) => readSnapshot(migrationId, password),
    checkpoint: (stagingLibraryId) => readCheckpoint(stagingLibraryId),
    clearCheckpoint: (stagingLibraryId) => clearCheckpoint(stagingLibraryId),
    activeLibraryId: () => readActiveLibraryId(),
    lock: () => readLock(),
    acquireLock: (stagingLibraryId, options) => acquireLock(stagingLibraryId, options ?? {}),
    releaseLock: (owner) => releaseLock(owner)
  };

  const bridge: ContractBridge = {
    async run(kind, runId) {
      const repo =
        kind === 'legacy'
          ? new LegacyRepository({ libraryId: `legacy-${runId}` })
          : new IndexedDbRepository({ libraryId: `idb-${runId}` });
      try {
        return await runContractSuite(repo, { runId });
      } finally {
        repo.close();
      }
    },
    schema: () => inspectV3Schema(),
    migration,
    // Assigned below; declared here so the object satisfies the interface.
    connections: undefined as unknown as ContractBridge['connections'],
    jobs: undefined as unknown as JobsBridge,
    backup: undefined as unknown as BackupBridge,
    library: undefined as unknown as LibraryBridge
  };

  bridge.backup = {
    run: (runId) => runBackupSuite({ runId }),
    providerRoundTrip: async (input) => {
      const created = createTransport({
        provider: input.kind,
        oss: toOssConfig(input.kind, input.config) as never,
        webdav: toWebdavConfig(input.kind, input.config) as never
      });
      if (!created.ok) return { ok: false, error: created.error.userMessage };
      try {
        const report = await runProviderRoundTrip({
          transport: created.transport,
          libraryId: input.libraryId,
          deviceId: input.deviceId,
          password: input.password,
          label: created.transport.description
        });
        return { ok: report.steps.every((step) => step.ok), report };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    restore: {
      seedBatch: async (input) => {
        const { collectSnapshot } = await import('../infrastructure/backup/snapshot');
        const { writeGeneration } = await import('../infrastructure/backup/writer');
        const created = createTransport({
          provider: input.kind,
          oss: toOssConfig(input.kind, input.config) as never,
          webdav: toWebdavConfig(input.kind, input.config) as never
        });
        if (!created.ok) return { ok: false, error: created.error.userMessage };
        const written = await writeGeneration({
          transport: created.transport,
          libraryId: input.libraryId,
          deviceId: input.deviceId,
          contentRevision: 1,
          password: input.password,
          snapshot: collectSnapshot(input.state as never),
          generationId: input.generationId
        });
        return written.ok ? { ok: true } : { ok: false, error: written.error.userMessage };
      },
      preview: async (input) => {
        const created = createTransport({
          provider: input.kind,
          oss: toOssConfig(input.kind, input.config) as never,
          webdav: toWebdavConfig(input.kind, input.config) as never
        });
        if (!created.ok) return { ok: false, error: created.error };
        // Imported on demand, exactly like the settings hook does. A static import
        // here pulled the whole restore/backup graph into the *first load* chunk
        // (measured: 191.6 → 202.4 KB gzip) because the bridge is imported by the
        // app entry even in production, where its body is dead code.
        const { previewRestore } = await import('../infrastructure/backup/restoreService');
        // The transport is passed in explicitly instead of being written into the
        // payload: a bridge that edited the payload to make its own call work would
        // also change the baseline the preview is supposed to measure against.
        const result = await previewRestore({
          state: loadHubState(),
          password: input.password,
          generationId: input.generationId,
          libraryId: input.libraryId,
          deviceId: input.deviceId,
          sourceLibraryId: input.sourceLibraryId,
          purpose: input.purpose,
          transport: created.transport
        });
        return result.ok ? { ok: true, preview: result.value } : { ok: false, error: result.error };
      },
      apply: async (input) => {
        const { applyRestore } = await import('../infrastructure/backup/restoreService');
        const current = loadHubState();
        const result = await applyRestore({
          state: current,
          previewId: input.previewId,
          mode: input.mode,
          conflicts: input.conflicts,
          importCredentials: input.importCredentials,
          credentialServices: input.credentialServices
        });
        return result.ok
          ? { ok: true, report: result.value.report, state: result.value.state }
          : { ok: false, error: result.error };
      },
      currentState: () => loadHubState(),
      setCurrentState: (state) => {
        saveHubState(state as never);
      },
      deviceId: async () => {
        const { currentDeviceId } = await import('../infrastructure/backup/backupService');
        return currentDeviceId();
      }
    },
    migration: {
      export: async (input) => {
        // The connection comes from the payload, exactly like the settings page: the
        // migration export must go through the same transport resolution as a backup.
        const { exportMigrationPackage } = await import('../infrastructure/backup/backupService');
        const result = await exportMigrationPackage({
          state: loadHubState(),
          password: input.password,
          libraryId: input.libraryId,
          deviceId: input.deviceId,
          confirmCredentialExport: input.confirm
        });
        return result.ok
          ? {
              ok: true,
              generationId: result.value.info.generationId,
              description: result.value.info.description,
              warnings: result.value.warnings
            }
          : { ok: false, error: result.error.userMessage };
      },
      list: async (input) => {
        const { listMigrationPackages } = await import('../infrastructure/backup/backupService');
        const result = await listMigrationPackages({
          state: loadHubState(),
          password: input.password,
          libraryId: input.libraryId,
          deviceId: input.deviceId
        });
        return result.ok
          ? {
              ok: true,
              packages: result.value.map((entry) => ({
                generationId: entry.generationId,
                complete: entry.complete,
                includesCredentials: entry.includesCredentials,
                credentialScope: entry.credentialScope,
                description: entry.description,
                counts: entry.counts
              }))
            }
          : { ok: false, error: result.error.userMessage };
      }
    },
    bundle: {
      build: async (input) => {
        const { buildBundle } = await import('../infrastructure/backup/bundleFile');
        const result = await buildBundle({
          state: loadHubState(),
          password: input.password,
          libraryId: input.libraryId,
          deviceId: input.deviceId,
          purpose: input.purpose,
          includeCredentials: input.includeCredentials
        });
        return result.ok
          ? { ok: true, json: result.value.json, fileName: result.value.fileName, summary: result.value.summary }
          : { ok: false, error: result.error.userMessage };
      },
      preview: async (input) => {
        const { previewBundleFile } = await import('../infrastructure/backup/restoreService');
        const result = await previewBundleFile({
          state: loadHubState(),
          password: input.password,
          json: input.json,
          libraryId: input.libraryId
        });
        return result.ok ? { ok: true, preview: result.value } : { ok: false, error: result.error };
      }
    }
  };

  /**
   * The library adapter sits directly on the bridge, not under `backup`: switching the
   * fact source is a storage concern, not a backup one.
   */
  bridge.library = {
    save: async (libraryId, options) => {
      const { writeLibrary } = await import('../repositories/hubStateAdapter');
      const result = await writeLibrary(loadHubState(), { libraryId, allowDrop: options?.allowDrop });
      return result.ok
        ? {
            ok: true,
            revision: result.value.revision,
            counts: result.value.counts,
            written: result.value.written,
            deleted: result.value.deleted,
            report: result.value.report
          }
        : { ok: false, error: result.error.userMessage };
    },
    load: async (libraryId) => {
      const { readLibrary, mergeDeviceConfig } = await import('../repositories/hubStateAdapter');
      const read = await readLibrary(libraryId);
      if (!read.ok) return { ok: false, error: read.error.userMessage };
      return {
        ok: true,
        state: mergeDeviceConfig(read.value.state, loadHubState()),
        counts: read.value.counts,
        report: read.value.report
      };
    },
    roundTrip: async (libraryId) => {
        const { writeLibrary, readLibrary, mergeDeviceConfig } = await import('../repositories/hubStateAdapter');
        const { stableStringify } = await import('../infrastructure/backup/restoreService');
        const before = loadHubState();
        const written = await writeLibrary(before, { libraryId });
        if (!written.ok) return { ok: false, error: written.error.userMessage };
        const read = await readLibrary(libraryId);
        if (!read.ok) return { ok: false, error: read.error.userMessage };
        const after = mergeDeviceConfig(read.value.state, before);

        const collections = [
          'notes',
          'sites',
          'annotations',
          'wucaiHighlights',
          'handwritings',
          'projects',
          'servers',
          'secrets',
          'reminders',
          'checkIns',
          'inbox',
          'obsidianNotes'
        ] as const;
        const diff: string[] = [];
        for (const key of collections) {
          const beforeRows = (before[key] ?? []) as Array<{ id?: string; key?: string }>;
          const afterRows = (after[key] ?? []) as Array<{ id?: string; key?: string }>;
          const idOf = (row: { id?: string; key?: string }) => String(row.id ?? row.key ?? '');
          const mapBefore = new Map(beforeRows.map((row) => [idOf(row), row]));
          const mapAfter = new Map(afterRows.map((row) => [idOf(row), row]));
          for (const [id, row] of mapBefore) {
            const other = mapAfter.get(id);
            if (!other) {
              diff.push(`${key}:${id} 丢失`);
            } else if (stableStringify(row) !== stableStringify(other)) {
              diff.push(`${key}:${id} 内容不同`);
            }
          }
          for (const id of mapAfter.keys()) {
            if (!mapBefore.has(id)) diff.push(`${key}:${id} 多出`);
          }
        }
        return { ok: diff.length === 0, diff, counts: read.value.counts, report: read.value.report };
      }
  };

  bridge.jobs = {
    run: (runId) => runJobSuite({ runId }),
    enqueue: async (libraryId, input) => {
      const queue = new JobQueue({ libraryId });
      const result = await queue.enqueue(input);
      return result.ok
        ? { ok: true, id: result.value.job.id, created: result.value.created }
        : { ok: false, error: result.error };
    },
    claim: async (libraryId, owner) => {
      const queue = new JobQueue({ libraryId });
      const result = await queue.claimNext({ owner });
      if (!result.ok) return { ok: false, error: result.error };
      const job = result.value;
      return { ok: true, job: job ? { id: job.id, kind: job.kind, state: job.state, attempt: job.attempt } : null };
    },
    summary: async (libraryId) => {
      const queue = new JobQueue({ libraryId });
      const result = await queue.summary();
      return result.ok ? result.value : {};
    }
  };

  bridge.connections = (libraryId: string): ConnectionBridge => {
    const repo = new ConnectionRepository({ libraryId });
    return {
      save: async (input) => {
        const result = await repo.saveConnection(input);
        return result.ok
          ? { ok: true, connection: result.value.connection, versionBumped: result.value.versionBumped }
          : { ok: false, error: result.error };
      },
      saveCredential: async (connectionId, secret, masterPassword) => {
        const result = await repo.saveCredential(connectionId, secret, masterPassword);
        return result.ok ? { ok: true } : { ok: false, error: result.error };
      },
      hasCredential: async (connectionId) => {
        const result = await repo.hasCredential(connectionId);
        return result.ok ? { ok: true, value: result.value } : { ok: false };
      },
      reveal: async (connectionId, masterPassword) => {
        const result = await repo.revealCredential(connectionId, masterPassword);
        return result.ok ? { ok: true, value: result.value } : { ok: false, error: result.error };
      },
      recordVerification: async (connectionId, report) => {
        const result = await repo.recordVerification(connectionId, report);
        return result.ok ? { ok: true, value: result.value } : { ok: false };
      },
      status: async (connectionId) => {
        const result = await repo.getConnection(connectionId);
        return result.ok && result.value ? connectionStatus(result.value) : null;
      },
      setPurpose: async (connectionId, purpose, enabled) => {
        const result = await repo.setPurposeEnabled(connectionId, purpose, enabled);
        return result.ok ? { ok: true } : { ok: false, error: result.error };
      },
      bindings: async (connectionId) => {
        const result = await repo.listBindings(connectionId);
        return result.ok ? result.value : [];
      },
      readiness: async (connectionId, purpose, vaultUnlocked) => {
        const [connection, bindings, credential] = await Promise.all([
          repo.getConnection(connectionId),
          repo.listBindings(connectionId),
          repo.hasCredential(connectionId)
        ]);
        if (!connection.ok || !connection.value) return null;
        return evaluateReadiness({
          connection: connection.value,
          binding: bindings.ok ? bindings.value.find((b) => b.purpose === purpose) : undefined,
          hasCredential: credential.ok ? Boolean(credential.value) : false,
          vaultUnlocked,
          supportedInEnvironment: true
        });
      },
      previewDelete: async (connectionId) => {
        const result = await repo.previewDeleteConnection(connectionId);
        return result.ok
          ? {
              ok: true,
              value: {
                affectedPurposes: result.value.affectedPurposes,
                referencingProjects: result.value.referencingProjects,
                deletesRemoteData: result.value.deletesRemoteData
              }
            }
          : { ok: false };
      },
      remove: async (connectionId) => {
        const result = await repo.deleteConnection(connectionId);
        return result.ok
          ? { ok: true, value: { deleted: result.value.deleted, disabledPurposes: result.value.disabledPurposes.length } }
          : { ok: false };
      },
      countWaitingUnlock: async () => {
        const result = await repo.countWaitingUnlock();
        return result.ok ? result.value : -1;
      },
      fingerprint: (provider, config) => fingerprintConfig(provider, config),
      requiredComplete: (provider, config) => requiredFieldsComplete(provider, config)
    };
  };

  window.__selfhubContract = bridge;
}
