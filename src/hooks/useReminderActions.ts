/**
 * Reminder actions.
 * "完成本次" and "续期" are different things and are recorded differently
 * (P1-07 / 开发文档 §11.3):
 */
import { useCallback } from 'react';
import { ReminderItem, ReminderOccurrence } from '../types';
import {
  addOneCycle,
  advanceRecurringTimestamp,
  anchorFromDate,
  adjacentRenewal,
  nextOccurrenceAfter,
  resolveAnchor
} from '../lib/dates';
import type { StateUpdater } from './useSiteActions';

const MAX_OCCURRENCES = 100;

type SupportedRecurrence = 'monthly' | 'yearly' | 'weekly';

/** Local narrowing form of `isSupportedRecurrence` (the union, not just boolean). */
function supportedRecurrence(value: ReminderItem['recurring']): value is SupportedRecurrence {
  return value === 'monthly' || value === 'yearly' || value === 'weekly';
}

/** Same local calendar day? Occurrences are per day, so retries match. */
export function sameOccurrenceDay(a: number, b: number): boolean {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  const da = new Date(a);
  const db = new Date(b);
  return (
    da.getFullYear() === db.getFullYear() && da.getMonth() === db.getMonth() && da.getDate() === db.getDate()
  );
}

/** The stored record for an occurrence, if the user already acted on it. */
export function findOccurrence(reminder: ReminderItem, dueAt: number): ReminderOccurrence | undefined {
  return (reminder.occurrences || []).find((o) => sameOccurrenceDay(o.dueAt, dueAt));
}

function pushOccurrence(reminder: ReminderItem, entry: ReminderOccurrence): ReminderOccurrence[] {
  return [entry, ...(reminder.occurrences || [])]
    .sort((a, b) => b.dueAt - a.dueAt)
    .slice(0, MAX_OCCURRENCES);
}

/** Anchor captured when the reminder is created (or the date is edited). */
export function anchorForNewReminder(reminder: ReminderItem): Pick<ReminderItem, 'anchorDay' | 'anchorMonth'> {
  const anchor = anchorFromDate(reminder.targetDate, reminder.recurring);
  if (!anchor || Number.isNaN(anchor.day)) return {};
  return reminder.recurring === 'yearly'
    ? { anchorDay: anchor.day, anchorMonth: anchor.month }
    : { anchorDay: anchor.day };
}

/**
 * 完成本次: record the occurrence as handled and stop the countdown for it.
 *
 * Repeating the call for the same due date is a no-op (one record, no date move).
 * For a recurring series the item is not silenced forever: the record is per
 * occurrence, and the next occurrence is still listed.
 */
export function completeReminderOccurrence(reminder: ReminderItem, now: number = Date.now()): ReminderItem {
  const dueAt = reminder.targetDate;
  if (!Number.isFinite(dueAt)) return reminder;
  const existing = findOccurrence(reminder, dueAt);
  if (existing) {
    // Already handled: keep exactly one record and never move the date here.
    return reminder.completed ? reminder : { ...reminder, completed: true, completedAt: existing.at };
  }
  return {
    ...reminder,
    completed: true,
    completedAt: now,
    occurrences: pushOccurrence(reminder, { dueAt, at: now, action: 'completed' })
  };
}

/** Undo 完成本次 for the current occurrence (does not touch the due date). */
export function reopenReminderOccurrence(reminder: ReminderItem): ReminderItem {
  const dueAt = reminder.targetDate;
  return {
    ...reminder,
    completed: false,
    completedAt: undefined,
    occurrences: (reminder.occurrences || []).filter(
      (o) => !(o.action === 'completed' && sameOccurrenceDay(o.dueAt, dueAt))
    )
  };
}

export interface RenewResult {
  reminder: ReminderItem;
  /** True when this call moved the series (false when the occurrence was already renewed). */
  renewed: boolean;
  /** The due date the series now points at. */
  nextDueAt: number;
  reason?: 'not_recurring' | 'invalid_cycle';
}

/**
 * 续期: advance exactly one cycle from the *current occurrence*.
 * Deliberately one step, not a catch-up: the user is confirming "I renewed the
 * period that was due", so a long-neglected reminder lands on the immediately
 * · The anchor is re-derived from the current target date only when the reminder
 */
export function renewReminderOccurrence(reminder: ReminderItem, now: number = Date.now()): RenewResult {
  const dueAt = reminder.targetDate;
  const recurring = reminder.recurring;
  if (!supportedRecurrence(recurring)) {
    return { reminder, renewed: false, nextDueAt: dueAt, reason: 'not_recurring' };
  }
  if (!Number.isFinite(dueAt)) {
    return { reminder, renewed: false, nextDueAt: dueAt, reason: 'invalid_cycle' };
  }

  const existing = findOccurrence(reminder, dueAt);
  if (existing && existing.action === 'renewed' && Number.isFinite(existing.nextDueAt)) {
    const nextDueAt = existing.nextDueAt as number;
    return {
      reminder: reminder.completed
        ? { ...reminder, completed: false, completedAt: undefined, targetDate: nextDueAt }
        : { ...reminder, targetDate: nextDueAt },
      renewed: false,
      nextDueAt
    };
  }

  const anchor = resolveAnchor(reminder.anchorDay, reminder.anchorMonth, dueAt, recurring);
  const options = recurring === 'yearly' ? { anchorDay: anchor.day, anchorMonth: anchor.month } : { anchorDay: anchor.day };

  // One adjacent cycle, anchored on the stored day-of-month (so 2 月 28 日 of a
  // 31st-anchored series returns to 3 月 31 日, not 3 月 28 日).
  const nextDueAt = adjacentRenewal(dueAt, recurring, options);
  if (nextDueAt === null || !Number.isFinite(nextDueAt) || nextDueAt <= dueAt) {
    return { reminder, renewed: false, nextDueAt: dueAt, reason: 'invalid_cycle' };
  }

  const entry: ReminderOccurrence = { dueAt, at: now, action: 'renewed', nextDueAt };
  const occurrences = existing
    ? pushOccurrence({ ...reminder, occurrences: (reminder.occurrences || []).filter((o) => o !== existing) }, entry)
    : pushOccurrence(reminder, entry);

  return {
    reminder: {
      ...reminder,
      targetDate: nextDueAt,
      // A renewed series is live again: the previous "completed" marking belonged
      // to the old occurrence and must not hide the new one.
      completed: false,
      completedAt: undefined,
      anchorDay: anchor.day,
      ...(recurring === 'yearly' ? { anchorMonth: anchor.month } : {}),
      occurrences
    },
    renewed: true,
    nextDueAt
  };
}

/**
 * Auto-rollover for `autoRollover === true`: move the series to the next future
 * occurrence without pretending the user renewed it, so no fake occurrence is
 * recorded. Returns null when nothing should change.
 */
export function autoAdvanceReminder(reminder: ReminderItem, now: number = Date.now()): number | null {
  const recurring = reminder.recurring;
  if (!reminder.autoRollover || !supportedRecurrence(recurring)) return null;
  const base = Number(reminder.targetDate);
  if (!Number.isFinite(base) || base > now) return null;
  const anchor = resolveAnchor(reminder.anchorDay, reminder.anchorMonth, base, recurring);
  const options = recurring === 'yearly' ? { anchorDay: anchor.day, anchorMonth: anchor.month } : { anchorDay: anchor.day };
  const next =
    advanceRecurringTimestamp(base, recurring, now, options) !== null
      ? nextOccurrenceAfter(base, recurring, now, options)
      : addOneCycle(base, recurring, options);
  if (next === null || !Number.isFinite(next) || next <= base) return null;
  return next;
}

export function useReminderActions(updateState: StateUpdater) {
  const addReminder = useCallback(
    (reminder: ReminderItem) => {
      // Capture the anchor at creation time: it is the only moment the original
      // day-of-month is still unambiguous (1 月 31 日, not the clamped 2 月 28 日).
      const anchored: ReminderItem = { ...reminder, ...anchorForNewReminder(reminder) };
      updateState((prev) => ({ ...prev, reminders: [anchored, ...(prev.reminders || [])] }));
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

  /** 完成本次 — idempotent per occurrence. */
  const completeReminder = useCallback(
    (id: string) => {
      updateState((prev) => ({
        ...prev,
        reminders: (prev.reminders || []).map((r) => (r.id === id ? completeReminderOccurrence(r) : r))
      }));
    },
    [updateState]
  );

  /** Undo 完成本次. */
  const reopenReminder = useCallback(
    (id: string) => {
      updateState((prev) => ({
        ...prev,
        reminders: (prev.reminders || []).map((r) => (r.id === id ? reopenReminderOccurrence(r) : r))
      }));
    },
    [updateState]
  );

  /** 续期 — idempotent per occurrence. */
  const renewReminder = useCallback(
    (id: string) => {
      updateState((prev) => ({
        ...prev,
        reminders: (prev.reminders || []).map((r) => (r.id === id ? renewReminderOccurrence(r).reminder : r))
      }));
    },
    [updateState]
  );

  /**
   * Compatibility shim: the old single toggle meant "done for this occurrence".
   * It now records an occurrence instead of only flipping a boolean.
   */
  const toggleReminderComplete = useCallback(
    (id: string) => {
      updateState((prev) => ({
        ...prev,
        reminders: (prev.reminders || []).map((r) => {
          if (r.id !== id) return r;
          return r.completed ? reopenReminderOccurrence(r) : completeReminderOccurrence(r);
        })
      }));
    },
    [updateState]
  );

  return {
    addReminder,
    deleteReminder,
    updateReminder,
    toggleReminderComplete,
    completeReminder,
    reopenReminder,
    renewReminder
  };
}
