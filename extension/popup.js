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
    const item = {
      id: `inbox-${Date.now()}`,
      content: tab.title || tab.url,
      title: tab.title,
      url: tab.url,
      type: 'url',
      status: 'inbox',
      createdAt: Date.now()
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

  // Open Main App
  document.getElementById('open-app-btn').addEventListener('click', () => {
    chrome.storage.local.get(['selfhub_web_url'], (res) => {
      let target = res.selfhub_web_url;
      if (!target) {
        target = prompt('请输入您的 Self-Hub 部署地址（如 Cloudflare Pages 网址或 http://localhost:4173）：', 'http://localhost:4173');
        if (target) {
          target = target.trim();
          chrome.storage.local.set({ selfhub_web_url: target });
        }
      }
      if (target) {
        chrome.tabs.create({ url: target });
        window.close();
      }
    });
  });
});
