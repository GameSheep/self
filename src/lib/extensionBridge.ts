/**
 * Chrome-extension bridge.
 * The web app stores everything in `localStorage['self_hub_data_v2']`, while the
 * bundled extension reads `chrome.storage.local` (`selfhub_sites`,
 * · only show its hardcoded defaults.
 */
import { HubState, ReminderItem } from '../types';
import { checkWritable } from './schemaGeneration';

interface ChromeStorageLike {
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

/** Envelope for the extension's command API (P2-04). */
export const EXTENSION_PROTOCOL_VERSION = 1;

interface CommandEnvelope {
  protocolVersion: number;
  requestId: string;
  command: string;
  payload: Record<string, unknown>;
}

interface CommandResponse<T> {
  requestId: string;
  ok: boolean;
  protocolVersion?: number;
  data?: T;
  error?: { code: string; message: string };
}

function newRequestId(): string {
  return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Send one command to the extension background.
 * P2-04: this is the only way the app writes extension data. The previous
 * implementation mirrored whole collections into `chrome.storage.local` on every
 * · whichever writer ran last, and the app never learned that it happened.
 */
export function sendExtensionCommand<T = unknown>(
  command: string,
  payload: Record<string, unknown> = {}
): Promise<T> {
  return new Promise((resolve, reject) => {
    const chromeApi = getChrome();
    const send = chromeApi?.runtime?.sendMessage?.bind(chromeApi.runtime);
    if (!send) {
      reject(new Error('当前环境没有扩展消息通道'));
      return;
    }
    const message: CommandEnvelope = {
      protocolVersion: EXTENSION_PROTOCOL_VERSION,
      requestId: newRequestId(),
      command,
      payload
    };
    try {
      send(message, (raw) => {
        const lastError = chromeApi?.runtime?.lastError;
        if (lastError) {
          reject(new Error(String((lastError as { message?: string })?.message ?? '扩展未响应')));
          return;
        }
        const response = raw as CommandResponse<T> | undefined;
        if (!response || typeof response !== 'object') {
          reject(new Error('扩展返回了空响应'));
          return;
        }
        if (!response.ok) {
          const error = new Error(response.error?.message || '命令失败');
          (error as Error & { code?: string }).code = response.error?.code ?? 'INTERNAL';
          reject(error);
          return;
        }
        resolve(response.data as T);
      });
    } catch (err) {
      reject(err as Error);
    }
  });
}

/** Stable operation id for one logical write, so a retry cannot duplicate it. */
export function newOperationId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Push the bookmark list to the extension so the new-tab grid stays accurate.
 *
 * Only the bookmarks are sent, and only as an ordered list; the background owns
 * the write. Annotations are *not* mirrored any more: they now flow
 * content-script → background → store, and the app imports them explicitly
 * instead of overwriting them.
 */
export function syncBookmarksToExtension(state: HubState): void {
  if (!isExtensionContext()) return;
  if (checkWritable().mode === 'read-only-newer-schema') {
    console.warn('[Self-Hub] bookmark sync skipped: newer schema generation owns this origin');
    return;
  }
  const bookmarks = (state.sites || []).map((s) => ({
    id: s.id,
    title: s.title,
    url: s.url,
    description: s.description || '',
    category: s.category,
    pinned: Boolean(s.pinned),
    visitCount: s.visitCount || 0,
    order: s.order
  }));
  void sendExtensionCommand('REPLACE_BOOKMARKS', { bookmarks }).catch((err) => {
    console.warn('[Self-Hub] pushing bookmarks to the extension failed', err);
  });
}

/**
 * Import annotations the extension collected, without overwriting anything.
 * Returns only the records the app does not already have (`rows`), plus how many
 * annotations the extension holds in total (`totalCount`). `totalCount === -1`
 */
export interface ExtensionAnnotationImport {
  rows: Array<{ id: string; pageUrl: string; pageTitle?: string; text: string; note?: string; color?: string; anchor?: unknown; createdAt?: number; updatedAt?: number }>;
  totalCount: number;
  /**
   * Rows the extension returned but the shape check rejected (missing id/text).
   *
   * Zero in every healthy path; a positive value means the extension holds
   * annotations this build cannot read — data written by an older/other shape.
   * Surfaced so "the pane is empty" can distinguish "extension is empty" from
   * "extension has rows we silently dropped".
   */
  dropped: number;
}

export async function importExtensionAnnotations(knownIds: Set<string>): Promise<ExtensionAnnotationImport> {
  try {
    const data = await sendExtensionCommand<{ annotations?: Array<Record<string, unknown>> }>('GET_ALL_ANNOTATIONS');
    const rows = Array.isArray(data?.annotations) ? data.annotations : [];
    const usable = rows.filter(
      (row): row is Record<string, unknown> & { id: string; text: string } =>
        typeof row?.id === 'string' && typeof row?.text === 'string'
    );
    return {
      rows: usable
        .filter((row) => !knownIds.has(row.id))
        .map((row) => ({
          id: row.id,
          pageUrl: String(row.pageUrl ?? ''),
          pageTitle: typeof row.pageTitle === 'string' ? row.pageTitle : undefined,
          text: row.text,
          note: typeof row.note === 'string' ? row.note : undefined,
          color: typeof row.color === 'string' ? row.color : undefined,
          anchor: row.anchor,
          createdAt: typeof row.createdAt === 'number' ? row.createdAt : undefined,
          updatedAt: typeof row.updatedAt === 'number' ? row.updatedAt : undefined
        })),
      totalCount: rows.length,
      dropped: rows.length - usable.length
    };
  } catch (err) {
    console.warn('[Self-Hub] importing extension annotations failed', err);
    return { rows: [], totalCount: -1, dropped: 0 };
  }
}

/** What a manual 「从扩展同步」 pass reports back to the pane. */
export interface AnnotationSyncResult {
  ok: boolean;
  /** How many annotations the extension holds (-1 = extension unreachable). */
  extensionCount?: number;
  /** How many were newly brought into the app. */
  imported?: number;
  /** A one-line, user-facing explanation. */
  message: string;
}

/**
 * Kept as a thin alias so existing callers keep compiling.
 *
 * It no longer mirrors annotations; see {@link syncBookmarksToExtension}.
 */
export function mirrorStateToExtension(state: HubState): void {
  syncBookmarksToExtension(state);
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

/* -------------------------------------------------------------------------- */
/* The extension's own inbox                                                  */
/* -------------------------------------------------------------------------- */

/**
 * One row of the extension's unified inbox (`selfhub_extension` → `inbox`).
 * Everything the extension collects by itself lands here: the new-tab
 * 「记一笔」 module, the toolbar popup and the right-click 「保存至统一收件箱」
 * · reading them: a capture used to stop at the extension and never reach the
 */
export interface ExtensionInboxRecord {
  id: string;
  content: string;
  title?: string;
  url?: string;
  createdAt: number;
  status?: string;
  operationId?: string;
}

/**
 * Rows the workbench has not taken yet.
 *
 * Asks for `status === 'inbox'` only, so a capture that was already imported
 * (and marked below) cannot come back on the next boot. Anything that goes wrong
 * — older extension build without `QUERY_INBOX`, worker asleep, plain web page —
 * degrades to an empty list rather than a failed import.
 */
export async function readExtensionInbox(): Promise<ExtensionInboxRecord[]> {
  try {
    const data = await sendExtensionCommand<{ items?: Array<Record<string, unknown>> }>('QUERY_INBOX', {
      status: 'inbox'
    });
    const rows = Array.isArray(data?.items) ? data.items : [];
    const out: ExtensionInboxRecord[] = [];
    for (const row of rows) {
      if (!row || typeof row.id !== 'string' || !row.id) continue;
      const content = typeof row.content === 'string' ? row.content : '';
      const title = typeof row.title === 'string' ? row.title : undefined;
      if (!content.trim() && !(title || '').trim()) continue;
      out.push({
        id: row.id,
        content,
        title,
        // A row whose URL is the extension itself (`chrome-extension://…/newtab.html`)
        // is not a link the workbench can open — it is noise left by an older build
        // that borrowed `sender.tab.url` from the new-tab page. Drop it so the row
        // falls back to showing the text the user actually typed.
        url: typeof row.url === 'string' && /^https?:\/\//i.test(row.url) ? row.url : undefined,
        createdAt: typeof row.createdAt === 'number' ? row.createdAt : Date.now(),
        status: typeof row.status === 'string' ? row.status : undefined,
        operationId: typeof row.operationId === 'string' ? row.operationId : undefined
      });
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Mark extension-inbox rows as taken.
 * Without this the import is only *idempotent*, not *one-shot*: the app copies a
 * capture into its own inbox, the user turns it into a note (which removes the
 */
export async function markExtensionInboxImported(ids: string[]): Promise<void> {
  if (!ids.length) return;
  await Promise.all(
    ids.map((id) =>
      sendExtensionCommand('UPDATE_INBOX_STATUS', {
        id,
        status: 'imported',
        operationId: `app-inbox-import-${id}`
      }).catch(() => undefined)
    )
  );
}

/* -------------------------------------------------------------------------- */
/* Captures made inside the extension                                          */
/* -------------------------------------------------------------------------- */

export interface ExtensionCapture {
  /** Stable key used to dedupe repeated imports. */
  operationId: string;
  text: string;
  url?: string;
  createdAt: number;
  origin: 'newtab-quicknote' | 'extension-inbox';
}

export interface ExtensionCaptureBatch {
  captures: ExtensionCapture[];
  /** Extension-inbox row ids behind these captures, for post-import acknowledgement. */
  inboxIds: string[];
}

interface ExtensionCapturePayload {
  quickNote?: string;
  quickNoteUpdatedAt?: number;
  inbox?: Array<{ id?: string; content?: string; title?: string; url?: string; createdAt?: number }>;
}

/**
 * Read what the extension captured on its own.
 * Two sources, because the extension has two generations of capture storage:
 * 1. **The v3 inbox** (`QUERY_INBOX`) — where 记一笔 / popup / 右键菜单 write today.
 */
export async function readExtensionCaptures(): Promise<ExtensionCaptureBatch> {
  const [legacy, inbox] = await Promise.all([readLegacyCaptures(), readExtensionInbox()]);

  const inboxIds: string[] = [];
  const fromInbox: ExtensionCapture[] = [];
  for (const row of inbox) {
    const text = (row.content || row.title || '').trim();
    if (!text) continue;
    inboxIds.push(row.id);
    fromInbox.push({
      operationId: `ext-inbox-${row.id}`,
      text,
      url: row.url,
      createdAt: row.createdAt,
      origin: 'extension-inbox'
    });
  }

  return { captures: [...fromInbox, ...legacy], inboxIds };
}

async function readLegacyCaptures(): Promise<ExtensionCapture[]> {
  const api = chromeSyncApi();
  if (!api?.storage?.local?.get) return [];
  const get = api.storage!.local!.get!.bind(api.storage!.local);

  return new Promise<ExtensionCapture[]>((resolve) => {
    try {
      get(['selfhub_quicknote', 'selfhub_quicknote_updatedAt', 'selfhub_inbox'], (res) => {
        const payload = (res || {}) as ExtensionCapturePayload;
        const out: ExtensionCapture[] = [];
        const quick = (payload.quickNote || '').trim();
        if (quick) {
          const at = Number(payload.quickNoteUpdatedAt) || 0;
          out.push({
            operationId: `ext-quicknote-${at || quick.length}`,
            text: quick,
            createdAt: at || Date.now(),
            origin: 'newtab-quicknote'
          });
        }
        for (const item of payload.inbox || []) {
          const text = (item?.content || item?.title || '').trim();
          if (!text) continue;
          const id = item?.id || `${text.length}-${item?.createdAt || 0}`;
          out.push({
            operationId: `ext-inbox-${id}`,
            text,
            url: item?.url,
            createdAt: Number(item?.createdAt) || Date.now(),
            origin: 'extension-inbox'
          });
        }
        resolve(out);
      });
    } catch {
      resolve([]);
    }
  });
}

/**
 * Clear the new-tab quick note once it has been imported.
 *
 * `selfhub_inbox` is left alone: the side panel still reads it, and the import is
 * idempotent through `operationId`, so removing it would gain nothing and could
 * lose an entry the user has not opened yet.
 */
export async function acknowledgeQuickNoteImported(): Promise<void> {
  const api = chromeSyncApi();
  if (!api?.storage?.local?.set) return;
  try {
    api.storage.local.set({ selfhub_quicknote: '', selfhub_quicknote_updatedAt: 0 });
  } catch {
    /* nothing to clear */
  }
}

/* -------------------------------------------------------------------------- */
/* Notes typed on the new tab                                                  */
/* -------------------------------------------------------------------------- */

/**
 * A note written in the new tab's 「文本框」 module.
 *
 * The new tab cannot write the library itself: the app is the only writer of the
 * v2 payload / v3 library, and a second writer is exactly what produced lost
 * updates before. So the new tab appends to a queue in `chrome.storage.local`
 * (idempotent by id) and the app drains it here.
 */
export interface PendingNote {
  id: string;
  title: string;
  content: string;
  folder?: string;
  updatedAt: number;
}

const PENDING_NOTES_KEY = 'selfhub_pending_notes';

function isPendingNote(value: unknown): value is PendingNote {
  const row = value as PendingNote | null;
  return Boolean(row && typeof row.id === 'string' && row.id && typeof row.content === 'string');
}

export async function readPendingNotes(): Promise<PendingNote[]> {
  const api = chromeSyncApi();
  if (!api?.storage?.local?.get) return [];
  const get = api.storage.local.get.bind(api.storage.local);
  return new Promise<PendingNote[]>((resolve) => {
    try {
      get([PENDING_NOTES_KEY], (res) => {
        const queue = (res || {})[PENDING_NOTES_KEY];
        resolve(Array.isArray(queue) ? queue.filter(isPendingNote) : []);
      });
    } catch {
      resolve([]);
    }
  });
}

/**
 * Drop the notes that made it into the library.
 *
 * Re-reads the queue instead of writing an empty array: a note typed while the
 * import was running must not be thrown away with the ones already imported.
 */
export async function acknowledgePendingNotes(ids: string[]): Promise<void> {
  const api = chromeSyncApi();
  if (!api?.storage?.local?.set) return;
  if (!ids.length) return;
  const done = new Set(ids);
  const queue = await readPendingNotes();
  const remaining = queue.filter((note) => !done.has(note.id));
  if (remaining.length === queue.length) return;
  try {
    api.storage.local.set({ [PENDING_NOTES_KEY]: remaining });
  } catch {
    /* the queue is retried on the next import; nothing is lost */
  }
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

