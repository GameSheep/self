/**
 * Chrome-extension bridge.
 *
 * The web app stores everything in `localStorage['self_hub_data_v2']`, while the
 * bundled extension reads `chrome.storage.local` (`selfhub_sites`,
 * `selfhub_annotations`, `selfhub_inbox`). When the app is opened from inside the
 * extension (`chrome-extension://<id>/app/index.html`) the two live on different
 * origins, so nothing ever flowed between them: the extension's new-tab grid could
 * only show its hardcoded defaults.
 *
 * This mirrors the bookmarks and annotations one way (app -> extension) on every
 * persisted change, and is a no-op in a normal browser tab.
 *
 * It also hands reminders to the background worker, which schedules alarms so
 * due reminders notify even when no app tab is open.
 */
import { HubState, ReminderItem } from '../types';

interface ChromeStorageLike {
  storage?: {
    local?: {
      set: (items: Record<string, unknown>, cb?: () => void) => void;
    };
  };
  runtime?: {
    id?: string;
    sendMessage?: (message: unknown, cb?: (response: unknown) => void) => void;
    lastError?: unknown;
  };
}

function getChrome(): ChromeStorageLike | null {
  const candidate = (globalThis as unknown as { chrome?: ChromeStorageLike }).chrome;
  if (candidate?.storage?.local?.set) return candidate;
  return null;
}

export function isExtensionContext(): boolean {
  return Boolean(getChrome());
}

/** Shape expected by extension/newtab.js and extension/background.js. */
export function mirrorStateToExtension(state: HubState): void {
  const chromeApi = getChrome();
  if (!chromeApi?.storage?.local) return;

  try {
    const wucaiAsAnnotations = (state.wucaiHighlights || []).map((h) => ({
      id: h.id,
      pageUrl: h.pageUrl,
      pageTitle: h.pageTitle,
      text: h.text,
      note: h.note || '',
      color: h.color,
      tags: h.tags || [],
      createdAt: h.createdAt,
      updatedAt: h.updatedAt || h.createdAt
    }));

    const pageAnnotations = (state.annotations || []).map((a) => ({
      id: a.id,
      pageUrl: a.pageUrl,
      pageTitle: a.pageTitle,
      text: a.text,
      note: a.note || '',
      color: a.color,
      tags: a.tags || [],
      anchor: a.anchor,
      createdAt: a.createdAt,
      updatedAt: a.updatedAt
    }));

    const byId = new Map<string, unknown>();
    for (const item of [...pageAnnotations, ...wucaiAsAnnotations]) {
      byId.set((item as { id: string }).id, item);
    }

    chromeApi.storage.local.set({
      selfhub_sites: (state.sites || []).map((s) => ({
        id: s.id,
        title: s.title,
        url: s.url,
        desc: s.description || '',
        category: s.category,
        pinned: Boolean(s.pinned),
        visitCount: s.visitCount || 0
      })),
      selfhub_annotations: Array.from(byId.values())
    });
  } catch (err) {
    console.warn('[Self-Hub] extension mirror failed', err);
  }
}

/* -------------------------------------------------------------------------- */
/* Background reminders                                                        */
/* -------------------------------------------------------------------------- */

function sendToWorker(message: unknown): boolean {
  const chromeApi = getChrome();
  if (!chromeApi?.runtime?.id || !chromeApi.runtime.sendMessage) return false;
  try {
    chromeApi.runtime.sendMessage(message, () => {
      // Reading lastError prevents "Unchecked runtime.lastError" noise when the
      // worker is asleep and the message has no receiver.
      void chromeApi.runtime?.lastError;
    });
    return true;
  } catch {
    return false;
  }
}

/** Only the fields the worker needs to decide whether something is due. */
function reminderPayload(reminders: ReminderItem[]) {
  return reminders.map((r) => ({
    id: r.id,
    title: r.title,
    targetDate: r.targetDate,
    completed: !!r.completed,
    cost: r.cost
  }));
}

/**
 * Publish reminders to the worker (stored + checked immediately).
 * Returns false outside the extension, where callers use the in-page notifier.
 */
export function publishRemindersToExtension(reminders: ReminderItem[]): boolean {
  return sendToWorker({ action: 'PUBLISH_REMINDERS', reminders: reminderPayload(reminders) });
}

/** Ask the worker to re-check now (e.g. right after a due date is edited). */
export function requestReminderCheck(): boolean {
  return sendToWorker({ action: 'CHECK_REMINDERS_NOW' });
}
