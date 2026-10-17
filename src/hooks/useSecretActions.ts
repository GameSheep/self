/**
 * Vault (secret) actions and the check-in automation actions.
 *
 * Both were inline in App. Secrets keep their AES-encrypted payload untouched —
 * this hook only manages the list.
 */
import { useCallback, useRef } from 'react';
import { CheckInTask, HubState, SecretItem } from '../types';
import { executeCheckIn } from '../lib/automation';
import { recordRun } from '../lib/checkInHistory';
import type { StateUpdater } from './useSiteActions';

export function useSecretActions(updateState: StateUpdater) {
  const addSecret = useCallback(
    (secret: SecretItem) => {
      updateState((prev) => ({ ...prev, secrets: [secret, ...prev.secrets] }));
    },
    [updateState]
  );

  const deleteSecret = useCallback(
    (id: string) => {
      updateState((prev) => ({ ...prev, secrets: prev.secrets.filter((s) => s.id !== id) }));
    },
    [updateState]
  );

  return { addSecret, deleteSecret };
}

export function useCheckInActions(state: HubState, updateState: StateUpdater) {
  const stateRef = useRef(state);
  stateRef.current = state;

  const addCheckIn = useCallback(
    (task: CheckInTask) => {
      updateState((prev) => ({ ...prev, checkIns: [task, ...prev.checkIns] }));
    },
    [updateState]
  );

  const deleteCheckIn = useCallback(
    (id: string) => {
      updateState((prev) => ({ ...prev, checkIns: prev.checkIns.filter((c) => c.id !== id) }));
    },
    [updateState]
  );

  /** Run one task; history is per local day so repeats cannot inflate the streak. */
  const runCheckIn = useCallback(
    async (id: string) => {
      const task = stateRef.current.checkIns.find((c) => c.id === id);
      if (!task) return;
      const result = await executeCheckIn(task);
      updateState((prev) => ({
        ...prev,
        checkIns: prev.checkIns.map((c) => (c.id === id ? recordRun(c, result) : c))
      }));
    },
    [updateState]
  );

  const runAllCheckIns = useCallback(async () => {
    const tasks = stateRef.current.checkIns;
    if (tasks.length === 0) return;
    const results = await Promise.all(
      tasks.map(async (task) => ({ id: task.id, result: await executeCheckIn(task) }))
    );
    updateState((prev) => ({
      ...prev,
      checkIns: prev.checkIns.map((c) => {
        const hit = results.find((r) => r.id === c.id);
        return hit ? recordRun(c, hit.result) : c;
      })
    }));
  }, [updateState]);

  return { addCheckIn, deleteCheckIn, runCheckIn, runAllCheckIns };
}
