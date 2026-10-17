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

/* -------------------------------------------------------------------------- */
/* Extension's own sync (SyncManager) — made visible to the app settings       */
/* -------------------------------------------------------------------------- */

export interface ExtensionSyncState {
  /** Was a chrome.storage-backed config found at all? */
  available: boolean;
  provider: 'none' | 's3' | 'webdav';
  autoSync: boolean;
  /** Path prefix the extension writes under, e.g. "self" or "selfhub_sync". */
  pathPrefix?: string;
  /** Where the data actually lands (URL or bucket), for the overlap check. */
  endpoint?: string;
  lastSyncTime?: number;
  lastMessage?: string;
  state?: string;
}

interface ChromeSyncLike extends ChromeStorageLike {
  storage?: {
    local?: {
      set: (items: Record<string, unknown>, cb?: () => void) => void;
      get?: (keys: string[] | string, cb: (items: Record<string, unknown>) => void) => void;
    };
  };
  runtime?: {
    id?: string;
    sendMessage?: (message: unknown, cb?: (response: unknown) => void) => void;
    lastError?: unknown;
    openOptionsPage?: () => void;
    getURL?: (path: string) => string;
  };
  tabs?: { create?: (props: { url: string }) => void };
}

function chromeSyncApi(): ChromeSyncLike | null {
  const candidate = (globalThis as unknown as { chrome?: ChromeSyncLike }).chrome;
  if (candidate?.storage?.local?.set) return candidate;
  return null;
}

/** Read the extension's sync configuration (empty when not in the extension). */
export async function readExtensionSyncState(): Promise<ExtensionSyncState> {
  const api = chromeSyncApi();
  const unavailable: ExtensionSyncState = { available: false, provider: 'none', autoSync: false };
  if (!api?.storage?.local?.get) return unavailable;

  const get = api.storage!.local!.get!.bind(api.storage!.local);
  const set = api.storage!.local!.set!.bind(api.storage!.local);
  return new Promise<ExtensionSyncState>((resolve) => {
    try {
      get(['selfhub_sync_config', 'selfhub_sync_status'], (res) => {
        const config = (res?.selfhub_sync_config || {}) as Record<string, any>;
        const status = (res?.selfhub_sync_status || {}) as Record<string, any>;
        const provider = (config.provider || 'none') as ExtensionSyncState['provider'];
        const sub = provider === 'webdav' ? config.webdav || {} : config.s3 || {};
        resolve({
          available: true,
          provider,
          autoSync: config.autoSync !== false,
          pathPrefix: sub.pathPrefix,
          endpoint: provider === 'webdav' ? sub.serverUrl : sub.endpoint || sub.bucket,
          lastSyncTime: status.lastSyncTime,
          lastMessage: status.lastMessage,
          state: status.state
        });
      });
    } catch {
      resolve(unavailable);
    }
  });
}

/**
 * Turn the extension's own sync off (or back on).
 *
 * Used to resolve the overlap: the app already backs up sites/annotations inside
 * its whole-state snapshot, so running both writes the same data twice.
 */
export async function setExtensionSyncEnabled(enabled: boolean): Promise<boolean> {
  const api = chromeSyncApi();
  if (!api?.storage?.local?.get || !api.storage.local.set) return false;

  const get = api.storage!.local!.get!.bind(api.storage!.local);
  const set = api.storage!.local!.set!.bind(api.storage!.local);
  return new Promise<boolean>((resolve) => {
    try {
      get(['selfhub_sync_config'], (res) => {
        const config = { ...((res?.selfhub_sync_config || {}) as Record<string, unknown>) };
        config.provider = enabled ? config.provider || 'none' : 'none';
        config.disabledByApp = !enabled;
        set({ selfhub_sync_config: config }, () => resolve(true));
      });
    } catch {
      resolve(false);
    }
  });
}

/** Open the extension's own options page (where SyncManager is configured). */
export function openExtensionOptions(): boolean {
  const api = chromeSyncApi();
  if (!api?.runtime?.id) return false;
  try {
    if (api.runtime.openOptionsPage) {
      api.runtime.openOptionsPage();
      return true;
    }
    if (api.runtime.getURL && api.tabs?.create) {
      api.tabs.create({ url: api.runtime.getURL('options.html') });
      return true;
    }
  } catch {
    // ignore
  }
  return false;
}


