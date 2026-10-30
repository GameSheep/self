/**
 * Reminder delivery, extracted from App.
 *
 * Three paths exist and they must not fight:
 * - inside the extension, the background service worker owns notifications
 *   (it can fire while the browser runs, with notification permission), so the
 *   extension page itself must stay silent;
 * - in a plain browser tab, the page notifies **while the page is open**;
 * - when the permission is not granted, neither path notifies — the reminders
 *   page keeps the in-page list and offers an explicit "开启到期提醒" action
 *   instead of requesting the permission on first visit.
 *
 * Nothing here can remind while the browser is closed; the reminder page says so.
 *
 * Deduplication lives in `reminderNotifier` and is keyed by
 * reminderId + occurrence due date + stage, so a re-render or a repeated effect
 * cannot fire the same notification twice.
 */
import { useEffect, useRef } from 'react';
import { ReminderItem } from '../types';
import { notificationsSupported, notifyDueReminders } from '../lib/reminderNotifier';
import { isExtensionContext, publishRemindersToExtension } from '../lib/extensionBridge';

const TICK_MS = 60_000;

export function useReminderNotifications(reminders: ReminderItem[] | undefined) {
  const list = reminders || [];
  const remindersRef = useRef<ReminderItem[]>(list);
  remindersRef.current = list;

  // Hand reminders to the extension worker so alarms can fire with no tab open.
  useEffect(() => {
    publishRemindersToExtension(list);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list]);

  // In-page delivery for the non-extension build. Runs on mount and whenever the
  // list changes (e.g. a reminder is created or renewed while the page is open),
  // and then keeps ticking so a tab left open all day still reminds.
  useEffect(() => {
    if (typeof window === 'undefined' || !notificationsSupported()) return;
    if (isExtensionContext()) return; // the worker owns notifications here

    const tick = () => {
      if (Notification.permission !== 'granted') return;
      try {
        notifyDueReminders(remindersRef.current);
      } catch (err) {
        console.warn('[Self-Hub] reminder notification failed', err);
      }
    };

    tick();
    const timer = setInterval(tick, TICK_MS);
    return () => clearInterval(timer);
  }, [list]);
}
