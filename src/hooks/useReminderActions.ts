/**
 * Reminder actions.
 */
import { useCallback } from 'react';
import { ReminderItem } from '../types';
import type { StateUpdater } from './useSiteActions';

export function useReminderActions(updateState: StateUpdater) {
  const addReminder = useCallback(
    (reminder: ReminderItem) => {
      updateState((prev) => ({ ...prev, reminders: [reminder, ...(prev.reminders || [])] }));
    },
    [updateState]
  );

  const deleteReminder = useCallback(
    (id: string) => {
      updateState((prev) => ({ ...prev, reminders: (prev.reminders || []).filter((r) => r.id !== id) }));
    },
    [updateState]
  );

  const updateReminder = useCallback(
    (reminder: ReminderItem) => {
      updateState((prev) => ({
        ...prev,
        reminders: (prev.reminders || []).map((r) => (r.id === reminder.id ? reminder : r))
      }));
    },
    [updateState]
  );

  const toggleReminderComplete = useCallback(
    (id: string) => {
      updateState((prev) => ({
        ...prev,
        reminders: (prev.reminders || []).map((r) =>
          r.id === id
            ? { ...r, completed: !r.completed, completedAt: !r.completed ? Date.now() : undefined }
            : r
        )
      }));
    },
    [updateState]
  );

  return { addReminder, deleteReminder, updateReminder, toggleReminderComplete };
}
