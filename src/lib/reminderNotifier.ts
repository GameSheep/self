/**
 * Reminder notifications.
 *
 * Reminders could only be seen by opening the app, which defeats the purpose of
 * a renewal reminder. This wires the browser Notification API.
 *
 * Honest limitation: a web page can only fire notifications while it is open.
 * We therefore (a) say so in the UI, (b) dedupe per reminder per day so opening
 * several tabs does not spam, and (c) also expose the due list for an in-app
 * banner when permission is denied.
 */
import { ReminderItem } from '../types';
import { daysUntil } from './dates';

const NOTIFIED_KEY_PREFIX = 'selfhub_reminder_notified_';

export interface DueReminder {
  reminder: ReminderItem;
  daysLeft: number;
  /** overdue (< 0) / today (0) / soon (1..horizon) */
  kind: 'overdue' | 'today' | 'soon';
}

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

function notifiedKey(id: string, dateKey: string): string {
  return `${NOTIFIED_KEY_PREFIX}${id}_${dateKey}`;
}

/** Has this reminder already produced a notification today? */
export function wasNotifiedToday(id: string, now: number = Date.now()): boolean {
  try {
    return localStorage.getItem(notifiedKey(id, localDayKey(now))) === '1';
  } catch {
    return false;
  }
}

function localDayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function markNotified(id: string, now: number): void {
  try {
    localStorage.setItem(notifiedKey(id, localDayKey(now)), '1');
  } catch {
    // ignore quota errors
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
  /** Due but already notified today. */
  skipped: DueReminder[];
  /** Due but no permission / unsupported. */
  blocked: DueReminder[];
}

/**
 * Fire one notification per due reminder, at most once per day each.
 * Callers should also render `blocked` as an in-app banner.
 */
export function notifyDueReminders(
  reminders: ReminderItem[],
  now: number = Date.now(),
  horizonDays = 3
): NotifyResult {
  const due = collectDueReminders(reminders, now, horizonDays);
  const result: NotifyResult = { notified: [], skipped: [], blocked: [] };
  if (due.length === 0) return result;

  const permitted = notificationsSupported() && Notification.permission === 'granted';

  for (const item of due) {
    if (wasNotifiedToday(item.reminder.id, now)) {
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
        tag: `selfhub-reminder-${item.reminder.id}`,
        requireInteraction: false
      });
      markNotified(item.reminder.id, now);
      result.notified.push(item);
    } catch {
      result.blocked.push(item);
    }
  }

  return result;
}
