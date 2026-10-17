import { SyncManager } from './sync/sync-manager.js';

/**
 * Self-Hub Browser Extension - Background Service Worker (Manifest V3)
 * Handles context menus, sidepanel routing, storage synchronizations, and S3/WebDAV sync.
 */

// Initialize context menus on install
chrome.runtime.onInstalled.addListener(() => {
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
  const store = await chrome.storage.local.get([ 'selfhub_reminders', NOTIFIED_STORE_KEY ]);
  const reminders = Array.isArray(store.selfhub_reminders) ? store.selfhub_reminders : [];
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

  if (info.menuItemId === 'selfhub_highlight' && info.selectionText) {
    chrome.tabs.sendMessage(tab.id, {
      action: 'TRIGGER_HIGHLIGHT_FROM_MENU',
      text: info.selectionText
    });
  } else if (info.menuItemId === 'selfhub_save_page') {
    const now = Date.now();
    const item = {
      id: `inbox-${now}`,
      content: tab.title || tab.url,
      title: tab.title,
      url: tab.url,
      type: 'url',
      status: 'inbox',
      createdAt: now,
      updatedAt: now,
      isDeleted: false
    };

    const res = await chrome.storage.local.get(['selfhub_inbox']);
    const list = res.selfhub_inbox || [];
    list.unshift(item);
    await chrome.storage.local.set({ selfhub_inbox: list });

    chrome.tabs.sendMessage(tab.id, {
      action: 'SHOW_TOAST',
      message: '已保存至 Self-Hub 统一收件箱'
    });
  }
});

// Message hub
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'GET_PAGE_ANNOTATIONS') {
    const url = message.url || (sender.tab && sender.tab.url);
    if (!url) {
      sendResponse({ annotations: [] });
      return true;
    }

    chrome.storage.local.get(['selfhub_annotations'], (res) => {
      const all = res.selfhub_annotations || [];
      // Filter out tombstones (deleted items)
      const active = all.filter((a) => !a.isDeleted);
      const filtered = active.filter((a) => a.pageUrl === url);
      sendResponse({ annotations: filtered, allCount: active.length });
    });
    return true;
  }

  if (message.action === 'SAVE_ANNOTATION') {
    chrome.storage.local.get(['selfhub_annotations'], (res) => {
      const all = res.selfhub_annotations || [];
      const existingIdx = all.findIndex((a) => a.id === message.annotation.id);
      const now = Date.now();
      const annToSave = {
        ...message.annotation,
        updatedAt: now,
        isDeleted: false
      };

      if (existingIdx >= 0) {
        all[existingIdx] = annToSave;
      } else {
        all.unshift(annToSave);
      }
      chrome.storage.local.set({ selfhub_annotations: all }, () => {
        const activeCount = all.filter((a) => !a.isDeleted).length;
        sendResponse({ success: true, count: activeCount });
      });
    });
    return true;
  }

  // Tombstone soft deletion for conflict-free sync
  if (message.action === 'DELETE_ANNOTATION') {
    chrome.storage.local.get(['selfhub_annotations'], (res) => {
      const all = res.selfhub_annotations || [];
      const existingIdx = all.findIndex((a) => a.id === message.id);
      if (existingIdx >= 0) {
        all[existingIdx] = {
          ...all[existingIdx],
          isDeleted: true,
          updatedAt: Date.now()
        };
      }
      chrome.storage.local.set({ selfhub_annotations: all }, () => {
        const activeCount = all.filter((a) => !a.isDeleted).length;
        sendResponse({ success: true, count: activeCount });
      });
    });
    return true;
  }

  if (message.action === 'GET_ALL_ANNOTATIONS') {
    chrome.storage.local.get(['selfhub_annotations'], (res) => {
      const all = res.selfhub_annotations || [];
      const active = all.filter((a) => !a.isDeleted);
      sendResponse({ annotations: active });
    });
    return true;
  }

  if (message.action === 'OPEN_SIDE_PANEL') {
    if (sender.tab && sender.tab.id && chrome.sidePanel && chrome.sidePanel.open) {
      chrome.sidePanel.open({ tabId: sender.tab.id });
    }
    return true;
  }

  // Reminders published by the app: store them and check immediately so a newly
  // due item notifies without waiting for the 30-minute alarm.
  if (message.action === 'PUBLISH_REMINDERS') {
    const reminders = Array.isArray(message.reminders) ? message.reminders : [];
    chrome.storage.local.set({ selfhub_reminders: reminders }, () => {
      checkDueReminders()
        .then((report) => sendResponse({ success: true, ...report }))
        .catch((err) => sendResponse({ success: false, message: err.message }));
    });
    return true;
  }

  if (message.action === 'CHECK_REMINDERS_NOW') {
    checkDueReminders()
      .then((report) => sendResponse({ success: true, ...report }))
      .catch((err) => sendResponse({ success: false, message: err.message }));
    return true;
  }

  // Cloud sync trigger
  if (message.action === 'PERFORM_SYNC') {
    SyncManager.performSync({ force: !!message.force })
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ success: false, message: err.message }));
    return true; // Keep sendResponse open for async
  }
});

