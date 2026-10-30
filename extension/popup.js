/**
 * Self-Hub Popup Menu Controller
 */

document.addEventListener('DOMContentLoaded', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) {
    document.getElementById('page-title').innerText = tab.title || tab.url || '未知页面';

    // Envelope protocol via SelfHubClient; a raw {action} message is rejected
    // by the background and the count would always read zero.
    window.SelfHubClient.send('GET_PAGE_ANNOTATIONS', { url: tab.url })
      .then((data) => {
        const count = (data && data.annotations) ? data.annotations.length : 0;
        document.getElementById('page-highlights-count').innerText =
          `本页划线: ${count} 条 (全站共 ${(data && data.allCount) || 0} 条)`;
      })
      .catch(() => {
        document.getElementById('page-highlights-count').innerText = '本页划线: 读取失败（扩展未响应）';
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

    // Single writer: the background stores it (and de-duplicates by operationId).
    window.SelfHubClient.send('CAPTURE_ENTRY', {
      text: item.content,
      url: item.url,
      operationId: 'popup-' + item.id
    })
      .then(() => {
        alert('✅ 已将该网页存入 Self-Hub 统一收件箱！');
        window.close();
      })
      .catch((err) => {
        alert('❌ 保存失败：' + (err.message || '扩展未响应'));
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
        : chrome.runtime.getURL('app/index.html#/home');
      chrome.tabs.create({ url: target });
      window.close();
    });
  });
});
