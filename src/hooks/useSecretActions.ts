/**
 * Vault (secret) actions and the check-in list actions.
 * Check-ins were deliberately demoted from "automation" to a plain list of sites
 * the user wants to visit daily: the app opens the page and records what *it*
 * · observed (a page opened / the user said "done"), and never fires HTTP requests
 */
import { useCallback, useRef } from 'react';
import { CheckInTask, HubState, SecretItem } from '../types';
import { recordRun } from '../lib/checkInHistory';
import type { StateUpdater } from './useSiteActions';

/** How a check-in entry was acted on: open the site, or the user marked it done. */
export type CheckInMode = 'open_page' | 'mark_done';

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
      // Automatic execution defaults to off and creating a task never turns it on.
      const normalised: CheckInTask = { ...task, enabled: task.enabled === true };
      updateState((prev) => ({ ...prev, checkIns: [normalised, ...prev.checkIns] }));
    },
    [updateState]
  );

  const deleteCheckIn = useCallback(
    (id: string) => {
      updateState((prev) => ({ ...prev, checkIns: prev.checkIns.filter((c) => c.id !== id) }));
    },
    [updateState]
  );

/**
 * Open the site, or record the user's "done" confirmation.
 * `open_page` opens a new tab and records `opened_page` — the app cannot know
 * whether the site counted anything, so it stays out of the streak.
 */
  const runCheckIn = useCallback(
    async (id: string, mode: CheckInMode = 'open_page') => {
      const task = stateRef.current.checkIns.find((c) => c.id === id);
      if (!task) return;

      if (mode === 'mark_done') {
        updateState((prev) => ({
          ...prev,
          checkIns: prev.checkIns.map((c) =>
            c.id === id
              ? recordRun(c, {
                  success: true,
                  // The user is the verifier now: their confirmation is what makes
                  // this a done day, so it counts for the streak.
                  verified: true,
                  outcome: 'http_success',
                  message: '你手动标记为已签到（以你的确认为准，应用未校验网站结果）'
                })
              : c
          )
        }));
        return;
      }

      let opened = false;
      try {
        const target = new URL(task.url);
        window.open(target.toString(), '_blank', 'noopener,noreferrer');
        opened = true;
      } catch {
        opened = false;
      }
      updateState((prev) => ({
        ...prev,
        checkIns: prev.checkIns.map((c) =>
          c.id === id
            ? recordRun(c, {
                success: false,
                verified: false,
                outcome: 'opened_page',
                message: opened
                  ? '已打开签到页面，签完可点「标记今天已签」'
                  : `打开页面失败：URL 无效（${task.url}）`
              })
            : c
        )
      }));
    },
    [updateState]
  );

  return { addCheckIn, deleteCheckIn, runCheckIn };
}
