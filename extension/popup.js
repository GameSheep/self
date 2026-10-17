/**
 * Self-Hub Popup Menu Controller
 */

document.addEventListener('DOMContentLoaded', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) {
    document.getElementById('page-title').innerText = tab.title || tab.url || '未知页面';

    chrome.runtime.sendMessage({
      action: 'GET_PAGE_ANNOTATIONS',
      url: tab.url
    }, (res) => {
      const count = (res && res.annotations) ? res.annotations.length : 0;
      document.getElementById('page-highlights-count').innerText = `本页划线: ${count} 条 (全站共 ${res?.allCount || 0} 条)`;
    });
  }

  // Open Sidepanel
  document.getElementById('open-panel-btn').addEventListener('click', async () => {
    if (tab && tab.id && chrome.sidePanel && chrome.sidePanel.open) {
      await chrome.sidePanel.open({ tabId: tab.id });
      window.close();
    } else {
      alert('您的浏览器可通过右上角侧边栏按钮直接打开');
    }
  });

  // Save to Inbox
  document.getElementById('save-inbox-btn').addEventListener('click', async () => {
    if (!tab) return;
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

    chrome.storage.local.get(['selfhub_inbox'], (res) => {
      const list = res.selfhub_inbox || [];
      list.unshift(item);
      chrome.storage.local.set({ selfhub_inbox: list }, () => {
        alert('✅ 已将该网页存入 Self-Hub 统一收件箱！');
        window.close();
      });
    });
  });

  // Open Sync Settings
  const syncBtn = document.getElementById('open-sync-btn');
  if (syncBtn) {
    syncBtn.addEventListener('click', () => {
      if (chrome.runtime.openOptionsPage) {
        chrome.runtime.openOptionsPage();
      } else {
        window.open('options.html');
      }
    });
  }

  // Open Main App (Built-in offline workspace)
  document.getElementById('open-app-btn').addEventListener('click', () => {
    chrome.storage.local.get(['selfhub_web_url'], (res) => {
      const customUrl = res.selfhub_web_url;
      const target = (customUrl && !customUrl.includes('localhost:4173'))
        ? customUrl
        : chrome.runtime.getURL('app/index.html');
      chrome.tabs.create({ url: target });
      window.close();
    });
  });
});
