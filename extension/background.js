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
});

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

  // Cloud sync trigger
  if (message.action === 'PERFORM_SYNC') {
    SyncManager.performSync({ force: !!message.force })
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ success: false, message: err.message }));
    return true; // Keep sendResponse open for async
  }
});

