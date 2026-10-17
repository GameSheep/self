/**
 * Cloud backup side-effects, extracted from App.
 *
 * App owned the backup state, the debounce timer, the provider routing and the
 * status object, all inline next to unrelated business logic. That is what made
 * "changing one feature touches everything" true. Backup is now one hook.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { HubState } from '../types';
import {
  backupStateToOss,
  backupStateToWebdav,
  readLastBackupAt,
  type BackupResult
} from '../lib/stateBackup';

export type BackupStatus = {
  status: 'idle' | 'saving' | 'error' | 'conflict';
  lastAt?: number;
  message?: string;
};

const DEBOUNCE_MS = 5000;

export function useCloudBackup(state: HubState) {
  const stateRef = useRef(state);
  stateRef.current = state;

  const [backupStatus, setBackupStatus] = useState<BackupStatus>(() => ({
    status: 'idle',
    lastAt: readLastBackupAt()
  }));

  const runStateBackup = useCallback(async (force = false): Promise<BackupResult> => {
    const current = stateRef.current;
    const wd = current.webdavConfig;
    const useWebdav = Boolean(wd?.enabled && wd.url && wd.username && wd.password);

    if (!useWebdav) {
      const cfg = current.obsidianConfig;
      if (!cfg?.enabled || !cfg.bucket || !cfg.accessKeyId) {
        return { ok: false, error: '未配置 OSS 或 WebDAV' };
      }
    }

    setBackupStatus((prev) => ({ ...prev, status: 'saving' }));
    const result = useWebdav
      ? await backupStateToWebdav(wd!, current, force)
      : await backupStateToOss(current.obsidianConfig, current, force);

    if (result.ok) {
      setBackupStatus({ status: 'idle', lastAt: readLastBackupAt() });
    } else {
      setBackupStatus({
        status: result.conflict ? 'conflict' : 'error',
        lastAt: readLastBackupAt(),
        message: result.error
      });
    }
    return result;
  }, []);

  // Debounced auto-backup: bursts of edits become one upload.
  const timerRef = useRef<number | null>(null);
  const hydratedRef = useRef(false);
  useEffect(() => {
    if (!hydratedRef.current) {
      hydratedRef.current = true;
      return; // never write on the very first render
    }
    const cfg = state.obsidianConfig;
    if (!cfg?.enabled || !cfg.bucket || !cfg.accessKeyId || cfg.accessKeyId.includes('•••')) return;

    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      void runStateBackup();
    }, DEBOUNCE_MS);
    return () => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
    };
  }, [state, runStateBackup]);

  return { backupStatus, runStateBackup };
}
