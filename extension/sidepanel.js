/**
 * Self-Hub Sidepanel Controller (Wucai Alternative Panel)
 * Real-time highlights sync, Obsidian Markdown export, in-page scroll-to-element.
 */

let currentAnnotations = [];
let activeTabUrl = '';
let activeTabTitle = '';

const COLOR_MAP = {
  yellow: '#fde047',
  green: '#86efac',
  blue: '#93c5fd',
  purple: '#d8b4fe',
  red: '#fca5a5'
};

async function loadAnnotations() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url) return;

  activeTabUrl = tab.url;
  activeTabTitle = tab.title || tab.url;

  // The background's single message entry requires the versioned envelope
  // (window.SelfHubClient.send); a raw {action} payload is rejected with
  // INVALID_PAYLOAD and the list would silently stay empty.
  window.SelfHubClient.send('GET_PAGE_ANNOTATIONS', { url: activeTabUrl })
    .then((data) => {
      currentAnnotations = (data && data.annotations) || [];
      renderList(currentAnnotations);
    })
    .catch((err) => {
      console.warn('[Self-Hub] loading annotations failed', err);
      currentAnnotations = [];
      renderList(currentAnnotations);
    });
}

function renderList(list) {
  const container = document.getElementById('list');
  const countSpan = document.getElementById('page-count');
  countSpan.innerText = `本页划线: ${list.length} 条`;

  if (list.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        当前网页暂无划线<br>
        在网页中选中任意文本，点击浮动工具条或按 <code>Alt+H</code> 即可自动标注！
      </div>
    `;
    return;
  }

  container.innerHTML = '';
  list.forEach(item => {
    const card = document.createElement('div');
    card.className = 'card';

    const colorHex = COLOR_MAP[item.color] || '#fde047';

    // Build with textContent: highlighted text comes from arbitrary web pages,
    // so interpolating it into innerHTML was a stored-XSS sink.
    const stripe = document.createElement('div');
    stripe.className = 'card-color-stripe';
    stripe.style.backgroundColor = colorHex;

    const content = document.createElement('div');
    content.className = 'card-content';

    const text = document.createElement('div');
    text.className = 'card-text';
    text.textContent = `"${item.text}"`;
    content.appendChild(text);

    if (item.note) {
      const note = document.createElement('div');
      note.className = 'card-note';
      note.textContent = `💭 ${item.note}`;
      content.appendChild(note);
    }

    const meta = document.createElement('div');
    meta.className = 'card-meta';
    const time = document.createElement('span');
    time.textContent = new Date(item.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const jump = document.createElement('span');
    jump.textContent = '定位跳转 →';
    meta.appendChild(time);
    meta.appendChild(jump);
    content.appendChild(meta);

    card.appendChild(stripe);
    card.appendChild(content);

    // Click card to scroll to annotation on web page
    card.addEventListener('click', async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab && tab.id && tab.url === activeTabUrl) {
        chrome.tabs.sendMessage(tab.id, {
          action: 'SCROLL_TO_ANNOTATION',
          id: item.id
        });
      } else if (tab && tab.id) {
        alert('该划线属于另一个标签页，请切换到对应网页后再定位。');
      }
    });

    container.appendChild(card);
  });
}

/* ------------------------------------------------------------------ */
/* Unified inbox: chrome.storage.local.selfhub_inbox used to be write-only. */
/* ------------------------------------------------------------------ */

let inboxItems = [];
let activeTab = 'annotations';

function loadInbox() {
  // The background is the single writer; the panel asks it instead of reading
  // the collection directly.
  window.SelfHubClient.send('QUERY_INBOX', {})
    .then((data) => {
      inboxItems = ((data && data.items) || []).filter((i) => !i.isDeleted);
      renderInbox();
    })
    .catch((err) => {
      console.warn('[Self-Hub] loading inbox failed', err);
      inboxItems = [];
      renderInbox();
    });
}

function renderInbox() {
  const container = document.getElementById('inbox-list');
  const count = document.getElementById('inbox-count');
  if (count) count.textContent = String(inboxItems.length);

  container.innerHTML = '';
  if (inboxItems.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = '统一收件箱还是空的。用弹窗按钮或右键菜单「保存至统一收件箱」收集网页与灵感。';
    container.appendChild(empty);
    return;
  }

  inboxItems.forEach((item) => {
    const card = document.createElement('div');
    card.className = 'inbox-item';

    const title = document.createElement('div');
    title.className = 'inbox-title';
    title.textContent = item.title || (item.url ? item.url : '未命名碎片');
    card.appendChild(title);

    const body = document.createElement('div');
    body.className = 'inbox-content';
    body.textContent = item.content || item.url || '';
    card.appendChild(body);

    const actions = document.createElement('div');
    actions.className = 'inbox-actions';

    const meta = document.createElement('span');
    meta.className = 'inbox-meta';
    meta.textContent = item.createdAt ? new Date(item.createdAt).toLocaleString() : '';
    actions.appendChild(meta);

    const btnRow = document.createElement('div');
    btnRow.style.display = 'flex';
    btnRow.style.gap = '6px';

    if (item.url) {
      const openBtn = document.createElement('button');
      openBtn.className = 'btn-action';
      openBtn.textContent = '打开';
      openBtn.addEventListener('click', () => chrome.tabs.create({ url: item.url }));
      btnRow.appendChild(openBtn);
    }

    const delBtn = document.createElement('button');
    delBtn.className = 'btn-action';
    delBtn.textContent = '删除';
    delBtn.addEventListener('click', () => {
      if (!confirm('确定从统一收件箱删除该条吗？')) return;
      // Archive rather than splice: a tombstone lets a later merge tell
      // "removed here" from "never existed".
      window.SelfHubClient.send('UPDATE_INBOX_STATUS', {
        id: item.id,
        status: 'archived',
        operationId: 'sidepanel-archive-' + item.id + '-' + Date.now()
      })
        .then(() => {
          inboxItems = inboxItems.filter((i) => i.id !== item.id);
          renderInbox();
        })
        .catch((err) => alert('操作失败：' + (err.message || '扩展未响应')));
    });
    btnRow.appendChild(delBtn);

    actions.appendChild(btnRow);
    card.appendChild(actions);
    container.appendChild(card);
  });
}

function setActiveTab(tab) {
  activeTab = tab;
  const isInbox = tab === 'inbox';
  document.getElementById('tab-annotations').classList.toggle('active', !isInbox);
  document.getElementById('tab-inbox').classList.toggle('active', isInbox);
  document.getElementById('list').style.display = isInbox ? 'none' : 'flex';
  document.getElementById('inbox-list').style.display = isInbox ? 'flex' : 'none';
  document.getElementById('export-md-btn').style.display = isInbox ? 'none' : 'block';
  document.getElementById('search-input').placeholder = isInbox
    ? '检索收件箱内容...'
    : '检索当前网页批注与思考...';
  if (isInbox) renderInbox();
}

document.getElementById('tab-annotations').addEventListener('click', () => setActiveTab('annotations'));
document.getElementById('tab-inbox').addEventListener('click', () => setActiveTab('inbox'));

// Search filter
document.getElementById('search-input').addEventListener('input', (e) => {
  const q = e.target.value.toLowerCase().trim();
  if (activeTab === 'inbox') {
    const container = document.getElementById('inbox-list');
    const filtered = q
      ? inboxItems.filter(
          (i) =>
            (i.title && i.title.toLowerCase().includes(q)) ||
            (i.content && i.content.toLowerCase().includes(q)) ||
            (i.url && i.url.toLowerCase().includes(q))
        )
      : inboxItems;
    const backup = inboxItems;
    inboxItems = filtered;
    renderInbox();
    inboxItems = backup;
    return;
  }
  if (!q) {
    renderList(currentAnnotations);
    return;
  }
  const filtered = currentAnnotations.filter(item =>
    (item.text && item.text.toLowerCase().includes(q)) ||
    (item.note && item.note.toLowerCase().includes(q))
  );
  renderList(filtered);
});

// Refresh button
document.getElementById('refresh-btn').addEventListener('click', () => {
  loadAnnotations();
  loadInbox();
});

// Keep the list in sync when the current tab changes.
chrome.tabs.onActivated.addListener(() => loadAnnotations());
chrome.tabs.onUpdated.addListener((_id, info) => {
  if (info.status === 'complete') loadAnnotations();
});
// The background is the only writer and broadcasts SELFHUB_CHANGED with the
// touched store names; chrome.storage.local.selfhub_inbox no longer receives
// writes, so listening to it kept the inbox stale until manual refresh.
window.SelfHubClient.onChange((msg) => {
  if (msg && Array.isArray(msg.stores) && msg.stores.includes('inbox_v3')) {
    loadInbox();
  }
  if (msg && Array.isArray(msg.stores) && msg.stores.includes('annotations_v3')) {
    loadAnnotations();
  }
});

// Export to Obsidian Markdown format
document.getElementById('export-md-btn').addEventListener('click', () => {
  if (currentAnnotations.length === 0) {
    alert('当前页面暂无划线可导出');
    return;
  }

  const dateStr = new Date().toISOString().slice(0, 10);
  let md = `---
title: "${activeTabTitle.replace(/"/g, '\\"')}"
url: "${activeTabUrl}"
date: ${dateStr}
tags:
  - clippings
  - selfhub
---

# ${activeTabTitle}

> 来源: [${activeTabTitle}](${activeTabUrl})
> 导出时间: ${new Date().toLocaleString()}

---

## 📌 划线与核心摘录 (${currentAnnotations.length})

`;

  currentAnnotations.forEach((item, idx) => {
    md += `### 摘录 ${idx + 1} (${item.color || '黄色'})\n`;
    md += `> ${item.text.replace(/\n/g, '\n> ')}\n\n`;
    if (item.note) {
      md += `**💭 思考笔记**: ${item.note}\n\n`;
    }
  });

  // Copy to clipboard (best effort) and always trigger the download; a
  // rejected clipboard write used to skip the download silently.
  const triggerDownload = () => {
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${activeTabTitle.slice(0, 30).replace(/[\\/:*?"<>|]/g, '_')}-SelfHub.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };
  navigator.clipboard.writeText(md).then(() => {
    triggerDownload();
    alert('已复制 Markdown 内容到剪贴板，并下载为 Obsidian 兼容文件！');
  }).catch(() => {
    triggerDownload();
    alert('已下载为 Obsidian 兼容文件！（剪贴板不可用，未能同时复制）');
  });
});

// Open Self-Hub Web App (Built-in offline workspace)
document.getElementById('open-hub-btn').addEventListener('click', () => {
  chrome.storage.local.get(['selfhub_web_url'], (res) => {
    const customUrl = res.selfhub_web_url;
    const target = (customUrl && !customUrl.includes('localhost:4173'))
      ? customUrl
      : chrome.runtime.getURL('app/index.html#/home');
    chrome.tabs.create({ url: target });
  });
});

// Open Sync Settings
const syncBtn = document.getElementById('sync-btn');
if (syncBtn) {
  syncBtn.addEventListener('click', () => {
    if (chrome.runtime.openOptionsPage) {
      chrome.runtime.openOptionsPage();
    } else {
      window.open('options.html');
    }
  });
}

// Initial load
loadAnnotations();
loadInbox();
