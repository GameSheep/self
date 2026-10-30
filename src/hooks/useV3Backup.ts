/**
 * Settings-facing state for the v3 backup path (P2-05).
 *
 * The settings pane needs four things: whether this session can decrypt a backup,
 * what the destination currently holds, a way to run one now, and an honest
 * statement of whether the automatic task will run. All of that is derived here so
 * the pane stays presentational and `App` does not grow another block of state.
 *
 * Refresh is explicit rather than automatic on every state change: listing a
 * destination costs network requests, and a settings page that re-lists on each
 * keystroke of an unrelated field would be both slow and rude to the server.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ConnectionTestRecord, HubState } from '../types';
import type { V3Status } from '../infrastructure/backup/backupService';
import type {
  ConflictStrategy,
  RestoreApplyResult,
  RestorePreview
} from '../infrastructure/backup/restoreService';
import {
  clearSessionBackupPassword,
  getSessionBackupPassword,
  hasSessionBackupPassword,
  isBackupPasswordEstablished,
  readBackupPasswordMeta,
  setSessionBackupPassword
} from '../infrastructure/backup/backupSession';
import { resolveBackupTarget } from '../lib/backupPolicy';
import { snapshotForRollback } from '../lib/storage';

/**
 * The v3 backup stack is loaded on demand.
 *
 * Importing it statically pulled the whole backup implementation (format, writer,
 * encryption, OSS/WebDAV clients) into the initial bundle — measured at +9.8 KB
 * gzip for every user, including those who never turn v3 on. These dynamic imports
 * keep the feature out of the first load and inside the settings chunk / first v3
 * run, which is where it is actually needed.
 */
const loadService = () => import('../infrastructure/backup/backupService');

export interface V3BackupPanelState {
  unlocked: boolean;
  passwordEstablished: boolean;
  establishedAt?: number;
  format: 'legacy' | 'v3';
  busy: boolean;
  progress?: number;
  /** Success text, e.g. "备份完成 · 3 条记录 · 12 KB". */
  message?: string;
  /** Failure text, shown as-is (already safe to display). */
  error?: string;
  status?: V3Status;
  /** Restore preview for one batch; absent until the user asks for one. */
  preview?: RestorePreview;
  previewBusy?: boolean;
  previewError?: string;
  /** Result of the last applied restore. */
  applied?: RestoreApplyResult;
  /** Per-collection conflict decision; unlisted collections keep the local row. */
  conflictChoices: Record<string, ConflictStrategy>;
  restoreMode: 'merge' | 'replace';
  /** Migration packages (credentials packages) found on the destination. */
  migrationPackages?: Array<{
    generationId: string;
    complete: boolean;
    createdAt?: number;
    includesCredentials?: boolean;
    credentialScope?: string[];
    description?: string;
  }>;
  /** True when the previewed package carries credentials and the user opted in. */
  importCredentials: boolean;
  /** What a migration package would contain, in user language. */
  credentialScope: string[];
}

export interface UseV3BackupResult {
  panel: V3BackupPanelState;
  unlock: (password: string) => void;
  lock: () => void;
  refresh: () => Promise<void>;
  runNow: () => Promise<{ ok: boolean; error?: string }>;
  pruneNow: () => Promise<{ ok: boolean; error?: string; removed?: number; refused?: string }>;
  setFormat: (format: 'legacy' | 'v3') => void;
  /** §10.4.2: parse a batch into staging and report; changes nothing. */
  previewBatch: (generationId: string) => Promise<void>;
  setConflictChoice: (collection: string, strategy: ConflictStrategy) => void;
  setRestoreMode: (mode: 'merge' | 'replace') => void;
  /** §10.4.5/6: apply the preview (baseline-checked) and hand the state back. */
  applyPreview: () => Promise<{ ok: boolean; error?: string }>;
  discardPreview: () => void;
  /** Write a credentials migration package (§10.3). Caller must confirm the scope. */
  exportMigration: () => Promise<{ ok: boolean; error?: string; generationId?: string }>;
  /** Preview a migration package instead of a backup batch. */
  previewMigration: (generationId: string) => Promise<void>;
  setImportCredentials: (value: boolean) => void;
  /** Delete a migration package (the credentials artefact must be removable). */
  removeMigration: (generationId: string) => Promise<{ ok: boolean; error?: string }>;
  /**
   * Export a single encrypted file for the other environment (§9.1 web↔extension).
   * Returns the text; the caller triggers the download.
   */
  buildBundleFile: (options?: { includeCredentials?: boolean }) => Promise<{
    ok: boolean;
    error?: string;
    json?: string;
    fileName?: string;
    summary?: string;
  }>;
  /** Preview an imported file through the same staging/conflict pipeline. */
  previewBundleFile: (json: string) => Promise<{ ok: boolean; error?: string }>;
  /** Re-run the connection tests for the services a restore just imported. */
  retestConnections: (services: string[]) => Promise<{ ok: boolean; tested: string[]; failed: string[] }>;
}

export function useV3Backup(
  state: HubState,
  onUpdatePolicy?: (policy: { provider: 'auto' | 'oss' | 'webdav'; enabled: boolean; format: 'legacy' | 'v3' }) => void,
  /**
   * Signals from the automatic backup task.
   *
   * `lastBackupAt` is bumped by a completed run (manual or automatic). Without it
   * the panel would keep showing the batches it saw at mount, so an automatic
   * backup would appear to have done nothing until the user pressed 刷新.
   */
  signals?: {
    lastBackupAt?: number;
    /** Receives the merged library so the caller can persist it (§10.4.6). */
    onRestoreState?: (next: HubState) => void;
    /** Records a connection test result (same handler the settings cards use). */
    onRecordConnectionTest?: (id: string, record: ConnectionTestRecord) => void;
  }
): UseV3BackupResult {
  const stateRef = useRef(state);
  stateRef.current = state;

  const resolved = resolveBackupTarget(state);
  const [panel, setPanel] = useState<V3BackupPanelState>(() => ({
    unlocked: hasSessionBackupPassword(),
    passwordEstablished: isBackupPasswordEstablished(),
    establishedAt: readBackupPasswordMeta()?.establishedAt,
    format: resolved.format,
    busy: false,
    conflictChoices: {},
    restoreMode: 'merge',
    importCredentials: false,
    credentialScope: []
  }));

  const password = () => getSessionBackupPassword();

  const refresh = useCallback(async () => {
    const current = stateRef.current;
    const target = resolveBackupTarget(current);
    const { inspectV3Status, listMigrationPackages, describeCredentialScope } = await loadService();
    const result = await inspectV3Status({ state: current, password: password() });
    // Migration packages live in their own root, so they need their own listing.
    const migrations = password()
      ? await listMigrationPackages({ state: current, password: password() })
      : undefined;
    setPanel((prev) => ({
      ...prev,
      format: target.format,
      unlocked: hasSessionBackupPassword(),
      passwordEstablished: isBackupPasswordEstablished(),
      establishedAt: readBackupPasswordMeta()?.establishedAt,
      credentialScope: describeCredentialScope(current),
      status: result.ok ? result.value : undefined,
      migrationPackages: migrations?.ok
        ? migrations.value.map((entry) => ({
            generationId: entry.generationId,
            complete: entry.complete,
            createdAt: entry.createdAt ?? entry.writtenAt,
            includesCredentials: entry.includesCredentials,
            credentialScope: entry.credentialScope,
            description: entry.description
          }))
        : undefined,
      error: result.ok ? undefined : result.error.userMessage
    }));
  }, []);

  // Refresh when the destination or the format changes, and once on mount.
  //
  // Only once v3 is actually in use: listing a destination costs requests, and a
  // user who is still on the legacy format (or has never unlocked a backup
  // password) should not pay for a feature they have not switched on. They can
  // still press "刷新状态", which calls `refresh` directly.
  const destinationKey = `${resolved.provider}|${resolved.destination}|${resolved.format}`;
  const shouldAutoInspect = resolved.format === 'v3' || hasSessionBackupPassword();
  const lastRunAt = signals?.lastBackupAt;
  useEffect(() => {
    if (!shouldAutoInspect) return;
    void refresh();
  }, [refresh, destinationKey, shouldAutoInspect, lastRunAt]);

  const unlock = useCallback(
    (value: string) => {
      setSessionBackupPassword(value);
      setPanel((prev) => ({
        ...prev,
        unlocked: hasSessionBackupPassword(),
        passwordEstablished: isBackupPasswordEstablished(),
        establishedAt: readBackupPasswordMeta()?.establishedAt,
        error: undefined
      }));
      void refresh();
    },
    [refresh]
  );

  const lock = useCallback(() => {
    clearSessionBackupPassword();
    setPanel((prev) => ({ ...prev, unlocked: false, message: '已锁定备份密码；自动备份会暂停到下次解锁。' }));
  }, []);

  const runNow = useCallback(async () => {
    const current = stateRef.current;
    setPanel((prev) => ({ ...prev, busy: true, error: undefined, message: undefined, progress: 0 }));
    const { runV3Backup } = await loadService();
    const result = await runV3Backup({
      state: current,
      password: password(),
      onProgress: (_stage, percent) => setPanel((prev) => ({ ...prev, progress: percent }))
    });
    if (!result.ok) {
      setPanel((prev) => ({ ...prev, busy: false, progress: undefined, error: result.error.userMessage }));
      return { ok: false, error: result.error.userMessage };
    }
    const info = result.value;
    const summary = [
      `备份完成 · ${info.info.description}`,
      info.pruned && info.pruned.removed.length > 0 ? `已清理 ${info.pruned.removed.length} 个旧批次` : undefined,
      ...info.warnings
    ]
      .filter(Boolean)
      .join(' · ');
    setPanel((prev) => ({ ...prev, busy: false, progress: undefined, message: summary }));
    await refresh();
    return { ok: true };
  }, [refresh]);

  const pruneNow = useCallback(async () => {
    setPanel((prev) => ({ ...prev, busy: true, error: undefined, message: undefined }));
    const { pruneV3Batches } = await loadService();
    const result = await pruneV3Batches({ state: stateRef.current });
    if (!result.ok) {
      setPanel((prev) => ({ ...prev, busy: false, error: result.error.userMessage }));
      return { ok: false, error: result.error.userMessage };
    }
    setPanel((prev) => ({
      ...prev,
      busy: false,
      message: result.value.refused
        ? result.value.refused
        : result.value.removed.length > 0
        ? `已清理 ${result.value.removed.length} 个旧批次，保留 ${result.value.kept.length} 个`
        : '没有需要清理的批次'
    }));
    await refresh();
    return {
      ok: true,
      removed: result.value.removed.length,
      refused: result.value.refused
    };
  }, [refresh]);

  const setFormat = useCallback(
    (format: 'legacy' | 'v3') => {
      const target = resolveBackupTarget(stateRef.current);
      onUpdatePolicy?.({ provider: target.provider === 'none' ? 'auto' : target.provider, enabled: target.enabled, format });
      setPanel((prev) => ({ ...prev, format }));
    },
    [onUpdatePolicy]
  );

  /**
   * Preview one batch into the staging area.
   *
   * Nothing is written here: the report is what the user reads before deciding,
   * and `applyPreview` is the only call that changes the library.
   */
  const previewBatch = useCallback(async (generationId: string) => {
    setPanel((prev) => ({ ...prev, previewBusy: true, previewError: undefined, applied: undefined, preview: undefined }));
    const { previewRestore } = await import('../infrastructure/backup/restoreService');
    const result = await previewRestore({
      state: stateRef.current,
      password: password(),
      generationId
    });
    if (!result.ok) {
      setPanel((prev) => ({ ...prev, previewBusy: false, previewError: result.error.userMessage }));
      return;
    }
    const preview = result.value;
    setPanel((prev) => ({
      ...prev,
      previewBusy: false,
      preview,
      // Default to not touching the local connections: importing credentials is a
      // deliberate choice, not something a restore does on its own.
      importCredentials: false,
      // Default to the safe choice for every conflicting collection.
      conflictChoices: Object.fromEntries(Object.keys(preview.conflictCounts).map((key) => [key, 'keep-local' as ConflictStrategy]))
    }));
  }, []);

  /** Same flow as `previewBatch`, but reading the migration root. */
  const previewMigration = useCallback(async (generationId: string) => {
    setPanel((prev) => ({ ...prev, previewBusy: true, previewError: undefined, applied: undefined, preview: undefined }));
    const { previewRestore } = await import('../infrastructure/backup/restoreService');
    const result = await previewRestore({
      state: stateRef.current,
      password: password(),
      generationId,
      purpose: 'migration'
    });
    if (!result.ok) {
      setPanel((prev) => ({ ...prev, previewBusy: false, previewError: result.error.userMessage }));
      return;
    }
    const preview = result.value;
    setPanel((prev) => ({
      ...prev,
      previewBusy: false,
      preview,
      importCredentials: false,
      conflictChoices: Object.fromEntries(Object.keys(preview.conflictCounts).map((key) => [key, 'keep-local' as ConflictStrategy]))
    }));
  }, []);

  const setImportCredentials = useCallback((value: boolean) => {
    setPanel((prev) => ({ ...prev, importCredentials: value }));
  }, []);

  const removeMigration = useCallback(
    async (generationId: string) => {
      setPanel((prev) => ({ ...prev, busy: true, error: undefined, message: undefined }));
      const { removeMigrationPackage } = await loadService();
      const result = await removeMigrationPackage({ state: stateRef.current, generationId });
      if (!result.ok) {
        setPanel((prev) => ({ ...prev, busy: false, error: result.error.userMessage }));
        return { ok: false, error: result.error.userMessage };
      }
      const partial = result.value.failed.length > 0 ? `，${result.value.failed.length} 个对象未删除` : '';
      setPanel((prev) => ({
        ...prev,
        busy: false,
        message: `已删除迁移包 ${generationId}（${result.value.removed} 个对象${partial}）`
      }));
      await refresh();
      return { ok: true };
    },
    [refresh]
  );

  const exportMigration = useCallback(async () => {
    setPanel((prev) => ({ ...prev, busy: true, error: undefined, message: undefined }));
    const { exportMigrationPackage } = await loadService();
    const result = await exportMigrationPackage({
      state: stateRef.current,
      password: password(),
      // The confirmation itself happens in the UI (the scope is listed there);
      // reaching this call means the user accepted it.
      confirmCredentialExport: true
    });
    if (!result.ok) {
      setPanel((prev) => ({ ...prev, busy: false, error: result.error.userMessage }));
      return { ok: false, error: result.error.userMessage };
    }
    setPanel((prev) => ({
      ...prev,
      busy: false,
      message: `迁移包已创建：${result.value.info.description}`
    }));
    await refresh();
    return { ok: true, generationId: result.value.info.generationId };
  }, [refresh]);

  const setConflictChoice = useCallback((collection: string, strategy: ConflictStrategy) => {
    setPanel((prev) => ({ ...prev, conflictChoices: { ...prev.conflictChoices, [collection]: strategy } }));
  }, []);

  const setRestoreMode = useCallback((mode: 'merge' | 'replace') => {
    setPanel((prev) => ({ ...prev, restoreMode: mode }));
  }, []);

  const applyPreview = useCallback(async () => {
    const preview = panel.preview;
    if (!preview) return { ok: false, error: '还没有预览结果。' };
    setPanel((prev) => ({ ...prev, previewBusy: true, previewError: undefined }));
    const { applyRestore } = await import('../infrastructure/backup/restoreService');
    // §10.4.6: keep a pre-restore snapshot of the current payload so the user can
    // undo. Taken before the merge, so it is the state the preview was based on.
    snapshotForRollback();
    const result = await applyRestore({
      state: stateRef.current,
      previewId: preview.previewId,
      mode: panel.restoreMode,
      conflicts: panel.conflictChoices,
      importCredentials: panel.importCredentials
    });
    if (!result.ok) {
      setPanel((prev) => ({ ...prev, previewBusy: false, previewError: result.error.userMessage }));
      return { ok: false, error: result.error.userMessage };
    }
    // The caller owns the write path; handing the merged library back keeps the
    // "one place that saves" rule intact.
    signals?.onRestoreState?.(result.value.state);
    setPanel((prev) => ({
      ...prev,
      previewBusy: false,
      preview: undefined,
      applied: result.value.report,
      message: `恢复完成：应用 ${Object.values(result.value.report.applied).reduce((sum, n) => sum + n, 0)} 条，冲突处理 ${
        result.value.report.conflictsResolved
      } 条。`
    }));
    return { ok: true };
  }, [panel.preview, panel.restoreMode, panel.conflictChoices, signals]);

  const discardPreview = useCallback(() => {
    setPanel((prev) => ({
      ...prev,
      preview: undefined,
      previewError: undefined,
      conflictChoices: {},
      importCredentials: false
    }));
  }, []);

  /**
   * Build a single encrypted file for the other environment.
   *
   * The file is the only practical channel between the web app and the packaged
   * extension (different origins, no shared database — §9.1). Nothing is uploaded:
   * the text is handed back so the caller can save it.
   */
  const buildBundleFile = useCallback(async (options: { includeCredentials?: boolean } = {}) => {
    setPanel((prev) => ({ ...prev, busy: true, error: undefined, message: undefined }));
    const { buildBundle } = await import('../infrastructure/backup/bundleFile');
    const { currentDeviceId } = await loadService();
    const result = await buildBundle({
      state: stateRef.current,
      password: password(),
      // The id is imported from the same on-demand module: a static import of the
      // backup service here would put the whole backup stack back into the first load.
      libraryId: (await loadService()).LOCAL_LIBRARY_ID,
      deviceId: currentDeviceId(),
      purpose: options.includeCredentials ? 'migration' : 'backup',
      includeCredentials: options.includeCredentials
    });
    if (!result.ok) {
      setPanel((prev) => ({ ...prev, busy: false, error: result.error.userMessage }));
      return { ok: false, error: result.error.userMessage };
    }
    setPanel((prev) => ({
      ...prev,
      busy: false,
      message: `已生成加密文件：${result.value.summary}`
    }));
    // Hand the file to the browser. It is the only channel between the web app and
    // the packaged extension (§9.1), so the download is part of the feature.
    try {
      const blob = new Blob([result.value.json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = result.value.fileName;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      /* the json is still returned to the caller */
    }
    return { ok: true, json: result.value.json, fileName: result.value.fileName, summary: result.value.summary };
  }, []);

  const previewBundleFile = useCallback(async (json: string) => {
    setPanel((prev) => ({ ...prev, previewBusy: true, previewError: undefined, applied: undefined, preview: undefined }));
    const { previewBundleFile: previewFile } = await import('../infrastructure/backup/restoreService');
    const result = await previewFile({ state: stateRef.current, password: password(), json });
    if (!result.ok) {
      setPanel((prev) => ({ ...prev, previewBusy: false, previewError: result.error.userMessage }));
      return { ok: false, error: result.error.userMessage };
    }
    const preview = result.value;
    setPanel((prev) => ({
      ...prev,
      previewBusy: false,
      preview,
      importCredentials: false,
      conflictChoices: Object.fromEntries(
        Object.keys(preview.conflictCounts).map((key) => [key, 'keep-local' as ConflictStrategy])
      )
    }));
    return { ok: true };
  }, []);

  /**
   * Re-test the connections a restore just imported.
   *
   * §1.3: a connection test is an independent request the user initiates, so this is
   * a button — never something a restore does by itself.
   */
  const retestConnections = useCallback(
    async (services: string[]) => {
      const tested: string[] = [];
      const failed: string[] = [];
      const { INTEGRATIONS } = await import('../lib/integrations');
      const { runConnectionTest, fingerprintOf } = await import('../lib/connectionState');
      const { isExtensionContext } = await import('../lib/extensionBridge');
      for (const id of services) {
        const def = INTEGRATIONS.find((entry) => entry.id === id);
        // The legacy Cloudflare sync has no integration card, so it cannot be tested
        // here; say nothing rather than pretend it passed.
        if (!def) continue;
        const values = def.read(stateRef.current);
        const result = await runConnectionTest(def, values);
        if (result.status === 'unavailable') {
          // "Cannot test here" is not a credential failure and must not be recorded
          // as one (same rule the settings cards follow).
          failed.push(`${def.title}（当前环境无法检测）`);
          continue;
        }
        signals?.onRecordConnectionTest?.(def.id, {
          at: Date.now(),
          ok: result.status === 'ok',
          message: result.message,
          fingerprint: fingerprintOf(def, values),
          capabilities: result.capabilities,
          environment: isExtensionContext() ? 'extension' : 'web'
        });
        if (result.status === 'ok') tested.push(def.title);
        else failed.push(def.title);
      }
      setPanel((prev) => ({
        ...prev,
        message: `已重新测试：通过 ${tested.length} 个${failed.length > 0 ? `，未通过 ${failed.length} 个（${failed.join('、')}）` : ''}。`,
        applied: prev.applied
          ? { ...prev.applied, connectionsToRetest: failed.length > 0 ? prev.applied.connectionsToRetest : [] }
          : prev.applied
      }));
      return { ok: failed.length === 0, tested, failed };
    },
    [signals]
  );

  return {
    panel,
    unlock,
    lock,
    refresh,
    runNow,
    pruneNow,
    setFormat,
    previewBatch,
    setConflictChoice,
    setRestoreMode,
    applyPreview,
    discardPreview,
    exportMigration,
    previewMigration,
    setImportCredentials,
    removeMigration,
    buildBundleFile,
    previewBundleFile,
    retestConnections
  };
}
