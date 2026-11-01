import { SyncManager } from './sync/sync-manager.js';
import { ExtensionStore } from './store.js';
import {
  COMMANDS,
  ERRORS,
  PROTOCOL_VERSION,
  classifySender,
  checkPageBinding,
  errorResponse,
  okResponse,
  operationIdOf,
  validateEnvelope,
  validatePayload
} from './protocol.js';

/**
 * Self-Hub Browser Extension - Background Service Worker (Manifest V3)
 * Handles context menus, sidepanel routing, storage synchronizations, and S3/WebDAV sync.
 */

// Initialize context menus on install
chrome.runtime.onInstalled.addListener(() => {
  // MV3 context menus persist across service worker restarts; re-creating on
  // every onInstalled (each extension update) throws "duplicate id" unless the
  // old tree is removed first.
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'selfhub_highlight',
      title: '划线高亮并存入 Self-Hub (Alt+H)',
      contexts: ['selection']
    });

    chrome.contextMenus.create({
      id: 'selfhub_save_page',
      title: '将当前网页保存至统一收件箱',
      contexts: ['page']
    });
  });

  // Enable sidepanel to open on action if supported
  if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
  }

  ensureReminderAlarm();
});

/* ========================================================================== */
/* Background reminder notifications                                          */
/*                                                                            */
/* A web page can only notify while it is open. The service worker can run     */
/* while the browser is up, so due reminders are checked here on an alarm and   */
/* survive the app tab being closed.                                           */
/* ========================================================================== */

const REMINDER_ALARM = 'selfhub_reminder_check';
const REMINDER_ALARM_MINUTES = 30;
const NOTIFIED_STORE_KEY = 'selfhub_reminder_notified';
const HORIZON_DAYS = 3;

function ensureReminderAlarm() {
  if (!chrome.alarms) return;
  chrome.alarms.get(REMINDER_ALARM, (existing) => {
    if (!existing) {
      chrome.alarms.create(REMINDER_ALARM, {
        periodInMinutes: REMINDER_ALARM_MINUTES,
        delayInMinutes: 1
      });
    }
  });
}

// Alarms are cleared when the browser restarts; recreate them eagerly.
ensureReminderAlarm();
if (chrome.runtime.onStartup) {
  chrome.runtime.onStartup.addListener(ensureReminderAlarm);
}

if (chrome.alarms) {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'selfhub_pomodoro') {
      // 番茄钟完成：模块 UI 只在页面打开时走字，离开页面的人靠这条通知。
      chrome.notifications.create('selfhub_pomodoro_done', {
        type: 'basic',
        iconUrl: 'icon128.png',
        title: '🍅 番茄钟完成',
        message: '一个专注周期结束了。休息一下，或者再来一轮。'
      });
      return;
    }
    if (alarm.name === REMINDER_ALARM) {
      checkDueReminders().catch((err) => console.warn('[Self-Hub] reminder check failed', err));
    }
  });
}

function localDayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function daysUntil(target, now) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(target);
  end.setHours(0, 0, 0, 0);
  return Math.round((end.getTime() - start.getTime()) / 86400000);
}

function dueTitle(reminder, daysLeft) {
  if (daysLeft < 0) return `${reminder.title}（已过期 ${Math.abs(daysLeft)} 天）`;
  if (daysLeft === 0) return `${reminder.title}（今天到期）`;
  return `${reminder.title}（还有 ${daysLeft} 天）`;
}

/**
 * Check published reminders and raise at most one notification per reminder per
 * local day. Returns a small report so the caller (or a test) can verify it.
 */
async function checkDueReminders() {
  // Published reminders live in the extension store (single writer). The notified
  // ledger stays in chrome.storage.local: it is small, and losing it only costs a
  // duplicate notification, not data.
  const store = await chrome.storage.local.get([NOTIFIED_STORE_KEY]);
  let reminders = await ExtensionStore.getReminders();
  if (reminders.length === 0) {
    // Older installs published through chrome.storage before the store existed.
    const legacy = await chrome.storage.local.get(['selfhub_reminders']);
    reminders = Array.isArray(legacy.selfhub_reminders) ? legacy.selfhub_reminders : [];
  }
  const notified = store[NOTIFIED_STORE_KEY] || {};

  const now = Date.now();
  const today = localDayKey(now);
  const report = { due: 0, notified: 0, skipped: 0 };

  for (const reminder of reminders) {
    if (!reminder || reminder.completed) continue;
    const target = Number(reminder.targetDate);
    if (!Number.isFinite(target)) continue;
    const daysLeft = daysUntil(target, now);
    if (daysLeft > HORIZON_DAYS) continue;
    report.due++;

    const key = `${reminder.id}_${today}`;
    if (notified[key]) {
      report.skipped++;
      continue;
    }

    try {
      await chrome.notifications.create(`selfhub_reminder_${key}`, {
        type: 'basic',
        iconUrl: 'icon128.png',
        title: 'Self-Hub 时效提醒',
        message: `${dueTitle(reminder, daysLeft)}${reminder.cost ? ` · ${reminder.cost}` : ''}`,
        priority: daysLeft <= 0 ? 2 : 0
      });
      notified[key] = now;
      report.notified++;
    } catch (err) {
      console.warn('[Self-Hub] notification failed', err);
    }
  }

  // Keep the ledger small: drop entries older than 30 days.
  const cutoff = now - 30 * 86400000;
  let pruned = false;
  for (const key of Object.keys(notified)) {
    if (typeof notified[key] === 'number' && notified[key] < cutoff) {
      delete notified[key];
      pruned = true;
    }
  }

  if (report.notified > 0 || pruned) {
    await chrome.storage.local.set({ [NOTIFIED_STORE_KEY]: notified });
  }
  return report;
}

if (chrome.notifications && chrome.notifications.onClicked) {
  chrome.notifications.onClicked.addListener(() => {
    chrome.tabs.create({ url: chrome.runtime.getURL('options.html') });
  });
}

// Context menu click listener
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab || !tab.id) return;

  // content.js is not injected into tabs opened before install/update, so a
  // missing receiver here is expected — check lastError instead of letting it
  // surface as an unchecked error, and fall back to a badge so the user still
  // sees that the capture happened.
  const sendToContent = (message) => {
    chrome.tabs.sendMessage(tab.id, message, () => {
      if (chrome.runtime.lastError) {
        chrome.action.setBadgeText({ tabId: tab.id, text: '✓' });
        chrome.action.setBadgeBackgroundColor({ color: '#10b981' });
        setTimeout(() => {
          chrome.action.setBadgeText({ tabId: tab.id, text: '' });
        }, 3000);
      }
    });
  };

  if (info.menuItemId === 'selfhub_highlight' && info.selectionText) {
    sendToContent({
      action: 'TRIGGER_HIGHLIGHT_FROM_MENU',
      text: info.selectionText
    });
  } else if (info.menuItemId === 'selfhub_save_page') {
    // Goes through the same store and idempotency path as every other capture,
    // instead of writing `chrome.storage.local.selfhub_inbox` by hand.
    const captured = await ExtensionStore.captureEntry(
      { text: tab.title || tab.url, url: tab.url, source: 'content' },
      `ctxmenu-${tab.id}-${Date.now()}`
    );
    await broadcastChange(['inbox_v3'], [captured.id], 'capture');

    sendToContent({
      action: 'SHOW_TOAST',
      message: '已保存至 Self-Hub 统一收件箱'
    });
  }
});


/* ========================================================================== */
/* Message hub: the extension's single write entry point (P2-04)               */
/*                                                                            */
/* Every write to extension-owned data goes through this dispatcher. It is     */
/* deliberately the only place that touches `ExtensionStore`, so the previous  */
/* situation — four scripts each writing collections, plus the app mirroring    */
/* whole collections in from another origin — cannot come back by accident.     */
/* ========================================================================== */

/**
 * Tell every extension page what changed.
 *
 * §9.2: "变更事件仅包含实体 ID、类型和 revision，不广播正文或凭据". Only ids and the
 * store names are sent; a listener that needs the content asks for it.
 */
async function broadcastChange(stores, ids, kind) {
  const event = {
    type: 'SELFHUB_CHANGED',
    kind,
    protocolVersion: PROTOCOL_VERSION,
    stores,
    ids,
    at: Date.now()
  };
  // `runtime.sendMessage` with no receiver rejects; a page that is not open is
  // not an error.
  try {
    await chrome.runtime.sendMessage(event);
  } catch {
    /* no listener open */
  }
}

/** Route one validated command to the store. */
async function execute(command, payload, sender, senderKind) {
  switch (command) {
    case 'GET_PAGE_ANNOTATIONS': {
      const pageUrl = sender.tab?.url || payload.url;
      const annotations = await ExtensionStore.listAnnotations(pageUrl);
      const all = await ExtensionStore.listAnnotations();
      return { data: { annotations, allCount: all.length } };
    }

    case 'SAVE_ANNOTATION': {
      const annotation = { ...payload.annotation };
      // The stored pageUrl is the sender's URL, never the payload's claim.
      if (sender.tab?.url) annotation.pageUrl = sender.tab.url;
      const saved = await ExtensionStore.saveAnnotation(annotation, operationIdOf({ payload }));
      await broadcastChange(['annotations_v3'], [saved.id], 'annotation-saved');
      return { data: { success: true, ...saved } };
    }

    case 'DELETE_ANNOTATION': {
      const deleted = await ExtensionStore.deleteAnnotation(payload.id, operationIdOf({ payload }));
      await broadcastChange(['annotations_v3'], [deleted.id], 'annotation-deleted');
      return { data: { success: true, ...deleted } };
    }

    case 'GET_ALL_ANNOTATIONS': {
      const annotations = await ExtensionStore.listAnnotations();
      return { data: { annotations } };
    }

    case 'CAPTURE_ENTRY': {
      /**
       * Only a real web page may lend its URL to a capture.
       *
       * `sender.tab` is populated for extension pages too, so the new-tab 「记一笔」
       * module used to store `chrome-extension://<id>/newtab.html` as the URL of every
       * quick note. The inbox renders a row that has a URL as a link *instead of* its
       * text, so those captures appeared as a blank row pointing at the new-tab page —
       * which reads exactly like "it was never saved".
       */
      const pageUrl =
        typeof sender.tab?.url === 'string' && /^https?:\/\//i.test(sender.tab.url)
          ? sender.tab.url
          : undefined;
      const captured = await ExtensionStore.captureEntry(
        { text: payload.text, url: payload.url || pageUrl, source: senderKind },
        operationIdOf({ payload })
      );
      await broadcastChange(['inbox_v3'], [captured.id], 'capture');
      return { data: captured };
    }

    case 'QUERY_INBOX': {
      const items = await ExtensionStore.listInbox(payload.status);
      return { data: { items } };
    }

    case 'UPDATE_INBOX_STATUS': {
      const updated = await ExtensionStore.updateInboxStatus(payload.id, payload.status, operationIdOf({ payload }));
      await broadcastChange(['inbox_v3'], [updated.id], 'inbox-status');
      return { data: updated };
    }

    case 'QUERY_BOOKMARKS': {
      const bookmarks = await ExtensionStore.listBookmarks();
      return { data: { bookmarks } };
    }

    case 'REPLACE_BOOKMARKS': {
      // The app owns the ordered list; the background performs the write so a
      // second writer cannot reintroduce the whole-collection mirror.
      const count = await ExtensionStore.replaceBookmarks(payload.bookmarks);
      await broadcastChange(['bookmarks_v3'], [], 'bookmarks-replaced');
      return { data: { count } };
    }

    case 'SAVE_QUICK_NOTE': {
      const saved = await ExtensionStore.saveQuickNote(payload.text);
      await broadcastChange(['quicknote_v3'], ['current'], 'quicknote');
      return { data: saved };
    }

    case 'READ_QUICK_NOTE': {
      const note = await ExtensionStore.readQuickNote();
      return { data: note };
    }

    case 'OPEN_SIDE_PANEL': {
      if (sender.tab?.id && chrome.sidePanel?.open) {
        await chrome.sidePanel.open({ tabId: sender.tab.id });
        return { data: { opened: true } };
      }
      return { data: { opened: false, reason: 'no-tab' } };
    }

    case 'PUBLISH_REMINDERS': {
      const count = await ExtensionStore.setReminders(payload.reminders);
      const report = await checkDueReminders();
      return { data: { success: true, stored: count, ...report } };
    }

    case 'CHECK_REMINDERS_NOW': {
      const report = await checkDueReminders();
      return { data: { success: true, ...report } };
    }

    case 'OPEN_WORKSPACE': {
      const target = payload.route ? `app/index.html${payload.route}` : 'app/index.html#/home';
      await chrome.tabs.create({ url: chrome.runtime.getURL(target) });
      return { data: { opened: true, target } };
    }

    case 'GET_TASK_STATUS': {
      // The task queue is P2-05; report what actually exists rather than a
      // fabricated "running" state.
      const counts = await ExtensionStore.counts();
      return {
        data: {
          syncEnabled: await ExtensionStore.getMeta('syncEnabled'),
          waitingUnlock: 0,
          queueImplemented: false,
          counts
        }
      };
    }

    case 'PERFORM_SYNC': {
      const result = await SyncManager.performSync({ force: Boolean(payload.force) });
      return { data: result };
    }

    default:
      return { error: { code: ERRORS.UNKNOWN_COMMAND, message: `未知命令: ${command}` } };
  }
}

/**
 * The single message entry point.
 *
 * Order matters and is deliberate: envelope → whitelist → sender → payload →
 * page binding → execute. Anything that fails an earlier step never reaches the
 * store, and every rejection carries a code plus a reason.
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Change notifications travel the other way (background → pages); ignore them
  // here so a page echoing one cannot cause a loop.
  if (message && message.type === 'SELFHUB_CHANGED') return false;

  const envelope = validateEnvelope(message);
  if (!envelope.ok) {
    sendResponse(
      errorResponse(message?.requestId ?? 'unknown', envelope.code, envelope.message)
    );
    return false;
  }

  const command = message.command;
  const spec = COMMANDS[command];
  if (!spec) {
    sendResponse(errorResponse(message.requestId, ERRORS.UNKNOWN_COMMAND, `未知命令: ${command}`));
    return false;
  }

  const senderKind = classifySender(sender);
  if (!spec.senders.includes(senderKind)) {
    sendResponse(
      errorResponse(message.requestId, ERRORS.FORBIDDEN_SENDER, `该命令不接受来自 ${senderKind} 的请求`)
    );
    return false;
  }

  const payloadCheck = validatePayload(command, message.payload ?? {});
  if (!payloadCheck.ok) {
    sendResponse(errorResponse(message.requestId, payloadCheck.code, payloadCheck.message));
    return false;
  }

  const pageCheck = checkPageBinding(command, message.payload ?? {}, sender, senderKind);
  if (!pageCheck.ok) {
    sendResponse(errorResponse(message.requestId, pageCheck.code, pageCheck.message));
    return false;
  }

  const payload = { ...(message.payload ?? {}) };
  if (spec.requiresSamePage && pageCheck.url) payload.url = payload.url || pageCheck.url;

  execute(command, payload, sender, senderKind)
    .then((result) => {
      if (result.error) {
        sendResponse(errorResponse(message.requestId, result.error.code, result.error.message));
        return;
      }
      sendResponse(okResponse(message.requestId, result.data));
    })
    .catch((err) => {
      console.error('[Self-Hub] command failed', command, err);
      sendResponse(
        errorResponse(message.requestId, ERRORS.INTERNAL, err instanceof Error ? err.message : String(err))
      );
    });

  // Keep the response channel open for the async work above.
  return true;
});
