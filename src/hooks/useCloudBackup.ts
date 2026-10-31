/**
 * Cloud backup side-effects, extracted from App.
 * App owned the backup state, the debounce timer, the provider routing and the
 * status object, all inline next to unrelated business logic. That is what made
 * · effect looked only at the OSS fields, the manual button at WebDAV-then-OSS —
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { HubState } from '../types';
import type { BackupResult } from '../lib/stateBackup';
import { resolveBackupTarget, resolveBackupTargets, type BackupTarget } from '../lib/backupPolicy';
import { getSessionBackupPassword } from '../infrastructure/backup/backupSession';

/**
 * The legacy (v2) backup implementation is loaded on demand.
 *
 * It pulls in the OSS/WebDAV clients and the whole-state serialiser — several KB of
 * first-load JavaScript for a path that only runs after the user configured a
 * connection *and* the debounce fired. The only thing needed synchronously is the
 * "上次备份时间" key, which is a single localStorage read.
 */
const LAST_BACKUP_KEY = 'selfhub_last_backup_at';
const loadLegacyBackup = () => import('../lib/stateBackup');

function readLastBackupAt(): number | undefined {
  try {
    const raw = localStorage.getItem(LAST_BACKUP_KEY);
    return raw ? Number(raw) : undefined;
  } catch {
    return undefined;
  }
}

export type BackupTrigger = 'manual' | 'auto';

export type BackupStatus = {
  status: 'idle' | 'saving' | 'error' | 'conflict' | 'disabled';
  lastAt?: number;
  lastTrigger?: BackupTrigger;
  message?: string;
  /** Extra user-facing explanation (e.g. why nothing ran). */
  hint?: string;
};

const DEBOUNCE_MS = 5000;

export interface UseCloudBackupResult {
  backupStatus: BackupStatus;
  /** Resolved destination; the settings page reads this instead of re-deriving it. */
  target: BackupTarget;
  runStateBackup: (force?: boolean, trigger?: BackupTrigger) => Promise<BackupResult>;
}

export function useCloudBackup(state: HubState): UseCloudBackupResult {
  const stateRef = useRef(state);
  stateRef.current = state;

  const target = resolveBackupTarget(state);

  const [backupStatus, setBackupStatus] = useState<BackupStatus>(() => ({
    status: 'idle',
    lastAt: readLastBackupAt()
  }));

  // Serialise runs: a manual upload still in flight while the 5s auto debounce
  // fires would run two concurrent uploads whose status writes overwrite each
  // other, and the final "已备份" could describe a run the user never saw.
  const runningRef = useRef(false);

  const runStateBackupInner = useCallback(
    async (force = false, trigger: BackupTrigger = 'manual'): Promise<BackupResult> => {
      const current = stateRef.current;
      // One resolver for both triggers. `canRun` folds together "the fields are
      // filled" and "the user switched the task on"; neither alone is enough.
      const resolved = resolveBackupTarget(current);

      if (!resolved.configured) {
        const error = resolved.reason || '未配置 OSS 或 WebDAV';
        setBackupStatus((prev) => ({ ...prev, status: 'disabled', message: error }));
        return { ok: false, error };
      }
      if (!resolved.enabled) {
        const error = resolved.reason || '自动备份尚未启用';
        setBackupStatus((prev) => ({ ...prev, status: 'disabled', message: error }));
        return { ok: false, error };
      }

      setBackupStatus((prev) => ({ ...prev, status: 'saving', message: undefined, lastTrigger: trigger }));

      // Which format this run writes is a user choice (§10.2), not something the
      // backup code decides. `v3` additionally needs this session's backup
      // password: without it the run must stop *before* any request, because
      // uploading unencrypted data would silently downgrade what the user chose.
      if (resolved.format === 'v3') {
        const password = getSessionBackupPassword();
        if (!password) {
          const error = '本次会话没有解锁备份密码，v3 加密备份没有运行，也没有上传任何内容。';
          setBackupStatus((prev) => ({ ...prev, status: 'disabled', message: error, lastTrigger: trigger }));
          return { ok: false, error };
        }
        // Loaded on demand: the v3 stack (format, writer, provider clients) is only
        // reachable for users who opted into v3, so it must not sit in the initial
        // bundle for everyone else.
        const { runV3Backup } = await import('../infrastructure/backup/backupService');
        const run = await runV3Backup({ state: current, password });
        if (!run.ok) {
          setBackupStatus((prev) => ({
            ...prev,
            status: 'error',
            lastAt: readLastBackupAt(),
            message: run.error.userMessage,
            lastTrigger: trigger
          }));
          return { ok: false, error: run.error.userMessage };
        }
        setBackupStatus({
          status: 'idle',
          lastAt: run.value.info.createdAt,
          lastTrigger: trigger,
          message: run.value.info.description,
          hint: run.value.warnings.length > 0 ? run.value.warnings.join('；') : undefined
        });
        return { ok: true, key: run.value.info.markerPath };
      }

      const legacy = await loadLegacyBackup();
      /**
       * Multi-target: every configured destination the user ticked gets its own upload.
       * `resolveBackupTargets` returns one entry per destination when `destinations` is set,
       * and exactly the old single entry when it is not.
       */
      const targets = resolveBackupTargets(current).filter((entry) => entry.provider !== 'none');
      const results: Array<{ provider: string; ok: boolean; conflict?: boolean; error?: string }> = [];
      for (const entry of targets.length > 0 ? targets : [resolved]) {
        const outcome =
          entry.provider === 'webdav'
            ? await legacy.backupStateToWebdav(current.webdavConfig, current, force)
            : entry.provider === 'oss'
              ? await legacy.backupStateToOss(current.obsidianConfig, current, force)
              : { ok: true };
        results.push({ provider: entry.provider, ...outcome });
      }

      const failed = results.filter((entry) => !entry.ok);
      const result = {
        ok: failed.length === 0,
        conflict: failed.some((entry) => entry.conflict),
        error: failed
          .map((entry) => `${entry.provider === 'webdav' ? 'WebDAV' : 'OSS'}：${entry.error ?? '未知错误'}`)
          .join('；')
      };

      if (result.ok) {
        setBackupStatus({ status: 'idle', lastAt: readLastBackupAt(), lastTrigger: trigger });
      } else {
        setBackupStatus({
          status: result.conflict ? 'conflict' : 'error',
          lastAt: readLastBackupAt(),
          message: result.error,
          lastTrigger: trigger
        });
      }
      return result;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  const runStateBackup = useCallback(
    async (force = false, trigger: BackupTrigger = 'manual'): Promise<BackupResult> => {
      if (runningRef.current) {
        const error = '上一次备份仍在进行中，请稍后再试。';
        if (trigger === 'manual') {
          setBackupStatus((prev) => ({ ...prev, message: error }));
        }
        return { ok: false, error };
      }
      runningRef.current = true;
      try {
        return await runStateBackupInner(force, trigger);
      } finally {
        runningRef.current = false;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  // Debounced auto-backup: bursts of edits become one upload.
  const timerRef = useRef<number | null>(null);
  const hydratedRef = useRef(false);
  useEffect(() => {
    if (!hydratedRef.current) {
      hydratedRef.current = true;
      return; // never write on the very first render
    }
    // P1-09: the automatic trigger no longer duplicates the conditions. It asks
    // the same resolver the manual path asks, so "only WebDAV configured" now
    // schedules a run instead of returning early.
    const resolved = resolveBackupTarget(state);
    if (!resolved.canRun) return;

    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      void runStateBackup(false, 'auto');
    }, DEBOUNCE_MS);
    return () => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
    };
  }, [state, runStateBackup]);

  return { backupStatus, target, runStateBackup };
}
