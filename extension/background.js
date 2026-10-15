/**
 * Self-Hub Browser Extension - Background Service Worker (Manifest V3)
 * Handles context menus, sidepanel routing, and storage synchronizations.
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
    const item = {
      id: `inbox-${Date.now()}`,
      content: tab.title || tab.url,
      title: tab.title,
      url: tab.url,
      type: 'url',
      status: 'inbox',
      createdAt: Date.now()
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
      const filtered = all.filter((a) => a.pageUrl === url);
      sendResponse({ annotations: filtered, allCount: all.length });
    });
    return true;
  }

  if (message.action === 'SAVE_ANNOTATION') {
    chrome.storage.local.get(['selfhub_annotations'], (res) => {
      const all = res.selfhub_annotations || [];
      const existingIdx = all.findIndex((a) => a.id === message.annotation.id);
      if (existingIdx >= 0) {
        all[existingIdx] = message.annotation;
      } else {
        all.unshift(message.annotation);
      }
      chrome.storage.local.set({ selfhub_annotations: all }, () => {
        sendResponse({ success: true, count: all.length });
      });
    });
    return true;
  }

  if (message.action === 'DELETE_ANNOTATION') {
    chrome.storage.local.get(['selfhub_annotations'], (res) => {
      const all = res.selfhub_annotations || [];
      const updated = all.filter((a) => a.id !== message.id);
      chrome.storage.local.set({ selfhub_annotations: updated }, () => {
        sendResponse({ success: true, count: updated.length });
      });
    });
    return true;
  }

  if (message.action === 'GET_ALL_ANNOTATIONS') {
    chrome.storage.local.get(['selfhub_annotations'], (res) => {
      sendResponse({ annotations: res.selfhub_annotations || [] });
    });
    return true;
  }

  if (message.action === 'OPEN_SIDE_PANEL') {
    if (sender.tab && sender.tab.id && chrome.sidePanel && chrome.sidePanel.open) {
      chrome.sidePanel.open({ tabId: sender.tab.id });
    }
  }
});
