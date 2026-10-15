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

  chrome.runtime.sendMessage({
    action: 'GET_PAGE_ANNOTATIONS',
    url: activeTabUrl
  }, (res) => {
    currentAnnotations = (res && res.annotations) || [];
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
    card.innerHTML = `
      <div class="card-color-stripe" style="background-color: ${colorHex};"></div>
      <div class="card-content">
        <div class="card-text">"${item.text}"</div>
        ${item.note ? `<div class="card-note">💭 ${item.note}</div>` : ''}
        <div class="card-meta">
          <span>${new Date(item.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
          <span>定位跳转 &rarr;</span>
        </div>
      </div>
    `;

    // Click card to scroll to annotation on web page
    card.addEventListener('click', async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab && tab.id) {
        chrome.tabs.sendMessage(tab.id, {
          action: 'SCROLL_TO_ANNOTATION',
          id: item.id
        });
      }
    });

    container.appendChild(card);
  });
}

// Search filter
document.getElementById('search-input').addEventListener('input', (e) => {
  const q = e.target.value.toLowerCase().trim();
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
document.getElementById('refresh-btn').addEventListener('click', loadAnnotations);

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

  // Copy to clipboard and trigger download
  navigator.clipboard.writeText(md).then(() => {
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${activeTabTitle.slice(0, 30).replace(/[\\/:*?"<>|]/g, '_')}-SelfHub.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    alert('已复制 Markdown 内容到剪贴板，并下载为 Obsidian 兼容文件！');
  });
});

// Open Self-Hub Web App
document.getElementById('open-hub-btn').addEventListener('click', () => {
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
    }
  });
});

// Initial load
loadAnnotations();
