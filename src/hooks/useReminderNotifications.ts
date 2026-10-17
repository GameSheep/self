/**
 * Reminder delivery, extracted from App.
 *
 * Two paths exist and they must not fight:
 * - inside the extension, the background service worker owns notifications
 *   (it can fire with no tab open), so the page must stay silent;
 * - in a plain browser tab, the page notifies while it is open.
 *
 * Both the publishing and the in-page loop used to live inline in App.
 */
import { useEffect, useRef } from 'react';
import { ReminderItem } from '../types';
import { notifyDueReminders } from '../lib/reminderNotifier';
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

  // In-page fallback for the non-extension build.
  useEffect(() => {
    if (typeof window === 'undefined' || !('Notification' in window)) return;
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
  }, []);
}
