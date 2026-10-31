/**
 * Reminder notifications.
 * Reminders could only be seen by opening the app, which defeats the purpose of
 * a renewal reminder. This wires the browser Notification API.
 * · - a plain web page can only notify **while a page is open**;
 */
import { ReminderItem } from '../types';
import { daysUntil } from './dates';

export interface DueReminder {
  reminder: ReminderItem;
  daysLeft: number;
  /** overdue (< 0) / today (0) / soon (1..horizon) */
  kind: 'overdue' | 'today' | 'soon';
}

/** Notification stage. Today each due reminder fires once per occurrence. */
export type NotifyStage = 'due_soon';

const NOTIFIED_KEY_PREFIX = 'selfhub_reminder_notified_';

export function notificationsSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

export function notificationPermission(): NotificationPermission | 'unsupported' {
  if (!notificationsSupported()) return 'unsupported';
  return Notification.permission;
}

export async function requestNotificationPermission(): Promise<NotificationPermission | 'unsupported'> {
  if (!notificationsSupported()) return 'unsupported';
  if (Notification.permission === 'granted') return 'granted';
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

/** Reminders due within `horizonDays` (including overdue ones). */
export function collectDueReminders(
  reminders: ReminderItem[],
  now: number = Date.now(),
  horizonDays = 3
): DueReminder[] {
  const out: DueReminder[] = [];
  for (const reminder of reminders) {
    if (reminder.completed) continue;
    if (!Number.isFinite(reminder.targetDate)) continue;
    const daysLeft = daysUntil(reminder.targetDate, now);
    if (Number.isNaN(daysLeft)) continue;
    if (daysLeft > horizonDays) continue;
    out.push({
      reminder,
      daysLeft,
      kind: daysLeft < 0 ? 'overdue' : daysLeft === 0 ? 'today' : 'soon'
    });
  }
  return out.sort((a, b) => a.daysLeft - b.daysLeft);
}

/** Local `YYYY-MM-DD` of a timestamp (the occurrence identity). */
export function localDayKey(ts: number): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return 'invalid';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function notifiedKey(id: string, dueAt: number, stage: NotifyStage): string {
  return `${NOTIFIED_KEY_PREFIX}${id}_${localDayKey(dueAt)}_${stage}`;
}

/**
 * Has this reminder already been announced for this occurrence and stage in the
 * current tab session? Session-scoped on purpose: notifications are a "while I
 * am here" capability, so a fresh session legitimately re-announces.
 */
export function wasNotified(id: string, dueAt: number, stage: NotifyStage = 'due_soon'): boolean {
  try {
    const session = typeof sessionStorage !== 'undefined' ? sessionStorage : null;
    const key = notifiedKey(id, dueAt, stage);
    if (session?.getItem(key) === '1') return true;
    // Legacy day-scoped marker written by older versions: keep it working.
    return localStorage.getItem(`${NOTIFIED_KEY_PREFIX}${id}_${localDayKey(dueAt)}`) === '1';
  } catch {
    return false;
  }
}

function markNotified(id: string, dueAt: number, stage: NotifyStage): void {
  try {
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.setItem(notifiedKey(id, dueAt, stage), '1');
    }
  } catch {
    // ignore quota / privacy-mode errors
  }
  try {
    const key = `${NOTIFIED_KEY_PREFIX}${id}_${localDayKey(dueAt)}`;
    localStorage.setItem(key, '1');
    pruneNotifiedKeys();
  } catch {
    // ignore quota errors
  }
}

/**
 * Day-scoped markers have no per-key delete anywhere, so they accumulated
 * forever and squeezed the 5 MB localStorage budget. Keep the last 30 days.
 */
function pruneNotifiedKeys(): void {
  const cutoffDay = localDayKey(Date.now() - 30 * 86400000);
  // Session keys are `id_<day>_<stage>`; legacy keys are `id_<day>`. Match the
  // date part directly instead of splitting on `_`.
  const dayPattern = /(\d{4}-\d{2}-\d{2})/;
  const stale: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key || !key.startsWith(NOTIFIED_KEY_PREFIX)) continue;
    const day = key.match(dayPattern)?.[1];
    if (day && day < cutoffDay) stale.push(key);
  }
  for (const key of stale) {
    try {
      localStorage.removeItem(key);
    } catch {
      // ignore
    }
  }
}

export function dueTitle(due: DueReminder): string {
  const { reminder, daysLeft } = due;
  if (daysLeft < 0) return `${reminder.title}（已过期 ${Math.abs(daysLeft)} 天）`;
  if (daysLeft === 0) return `${reminder.title}（今天到期）`;
  return `${reminder.title}（还有 ${daysLeft} 天）`;
}

export interface NotifyResult {
  /** Reminders that actually produced a notification. */
  notified: DueReminder[];
  /** Due but already announced for this occurrence in this session. */
  skipped: DueReminder[];
  /** Due but no permission / unsupported. */
  blocked: DueReminder[];
}

/**
 * Fire one notification per due reminder, at most once per occurrence per
 * session. Callers should also render `blocked` as an in-app banner — a denied
 * permission must not swallow the reminder.
 */
export function notifyDueReminders(
  reminders: ReminderItem[],
  now: number = Date.now(),
  horizonDays = 3,
  stage: NotifyStage = 'due_soon'
): NotifyResult {
  const due = collectDueReminders(reminders, now, horizonDays);
  const result: NotifyResult = { notified: [], skipped: [], blocked: [] };
  if (due.length === 0) return result;

  const permitted = notificationsSupported() && Notification.permission === 'granted';

  for (const item of due) {
    const dueAt = item.reminder.targetDate;
    if (wasNotified(item.reminder.id, dueAt, stage)) {
      result.skipped.push(item);
      continue;
    }
    if (!permitted) {
      result.blocked.push(item);
      continue;
    }
    try {
      // `tag` collapses duplicates that other tabs may have created.
      new Notification('Self-Hub 时效提醒', {
        body: `${dueTitle(item)}${item.reminder.cost ? ` · ${item.reminder.cost}` : ''}`,
        tag: `selfhub-reminder-${item.reminder.id}-${localDayKey(dueAt)}`,
        requireInteraction: false
      });
      markNotified(item.reminder.id, dueAt, stage);
      result.notified.push(item);
    } catch {
      result.blocked.push(item);
    }
  }

  return result;
}
