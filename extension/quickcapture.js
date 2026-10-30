/**
 * Self-Hub New Tab Page Controller (GoTab Replacement Engine)
 * Fast search switcher, categorized bookmark grids, instant scratchpad, inbox capture.
 */

const ENGINES = {
  google: 'https://www.google.com/search?q=',
  bing: 'https://www.bing.com/search?q=',
  baidu: 'https://www.baidu.com/s?wd=',
  github: 'https://github.com/search?q=',
  v2ex: 'https://www.google.com/search?q=site:v2ex.com/t+'
};

let currentEngine = 'google';
let currentCategory = '常用推荐';

// Default bookmarks (matching Self-Hub seed data)
const DEFAULT_SITES = [
  { id: '1', title: 'GitHub', url: 'https://github.com', category: '常用推荐', desc: '全球最大的开源与代码托管平台' },
  { id: '2', title: 'Claude', url: 'https://claude.ai', category: '常用推荐', desc: 'Anthropic 大语言模型助手' },
  { id: '3', title: 'ChatGPT', url: 'https://chat.openai.com', category: '常用推荐', desc: 'OpenAI 交互与创作引擎' },
  { id: '4', title: 'V2EX', url: 'https://v2ex.com', category: '常用推荐', desc: '创意工作者讨论社区' },
  { id: '5', title: 'Cloudflare', url: 'https://dash.cloudflare.com', category: '开发与云服务', desc: '全球边缘网络与 DNS 门禁平台' },
  { id: '6', title: '阿里云控制台', url: 'https://aliyun.com', category: '开发与云服务', desc: 'ECS 服务器与 OSS 对象存储管理' },
  { id: '7', title: 'Google AI Studio', url: 'https://aistudio.google.com', category: '常用推荐', desc: 'Gemini 原生模型 API 控制台' },
  { id: '8', title: 'Obsidian Publish', url: 'https://obsidian.md', category: '知识库', desc: '本地 Markdown 知识管理库' },
  { id: '9', title: 'Product Hunt', url: 'https://www.producthunt.com', category: '独立出海', desc: '全球新奇互联网科技产品首发榜单' },
  { id: '10', title: 'Stripe 仪表盘', url: 'https://dashboard.stripe.com', category: '独立出海', desc: '全球跨境在线收款与订阅支付' }
];

let allSites = DEFAULT_SITES;

// Initialize
document.addEventListener('DOMContentLoaded', async () => {
  // Load saved engine
  const savedEngine = localStorage.getItem('selfhub_newtab_engine');
  if (savedEngine && ENGINES[savedEngine]) {
    setEngine(savedEngine);
  }

  // Load custom sites and quicknote from chrome storage
  refreshLocalContent();

  // Setup Sync Pill & Auto-Sync
  setupSyncWorkflow();

  setupEventListeners();
});

function refreshLocalContent() {
  // Reads go through the background so there is one writer for this data. The
  // client rejects rather than returning undefined, so a missing background is
  // visible instead of silently showing an empty grid.
  if (window.SelfHubClient) {
    window.SelfHubClient.send('QUERY_BOOKMARKS')
      .then((data) => {
        if (data && Array.isArray(data.bookmarks) && data.bookmarks.length > 0) {
          allSites = data.bookmarks.filter((s) => !s.isDeleted);
        }
        renderCategories();
        renderSites();
      })
      .catch((err) => console.warn('[Self-Hub] reading bookmarks failed', err));
    window.SelfHubClient.send('READ_QUICK_NOTE')
      .then((note) => {
        if (note && typeof note.text === 'string' && note.text) {
          const el = document.getElementById('quick-note');
          if (el && !el.value) el.value = note.text;
        }
      })
      .catch(() => {});
    return;
  }
  if (chrome && chrome.storage && chrome.storage.local) {
    chrome.storage.local.get(['selfhub_sites', 'selfhub_quicknote'], (res) => {
      if (res.selfhub_sites && res.selfhub_sites.length > 0) {
        // Filter out tombstones
        allSites = res.selfhub_sites.filter(s => !s.isDeleted);
      }
      renderCategories();
      renderSites();

      if (res.selfhub_quicknote !== undefined) {
        document.getElementById('quick-note').value = res.selfhub_quicknote;
      }
    });
  } else {
    renderCategories();
    renderSites();
    const savedNote = localStorage.getItem('selfhub_quicknote');
    if (savedNote) {
      document.getElementById('quick-note').value = savedNote;
    }
  }
}

function updateSyncPill(status, config) {
  const dot = document.getElementById('sync-dot');
  const label = document.getElementById('sync-label');
  if (!dot || !label) return;

  if (!config || config.provider === 'none') {
    dot.className = 'dot-idle';
    label.textContent = '云同步 (未配置)';
    return;
  }

  const providerName = config.provider === 's3' ? 'S3/R2' : 'WebDAV';
  if (status && status.state === 'syncing') {
    dot.className = 'dot-syncing';
    label.textContent = `${providerName} 同步中...`;
  } else if (status && status.state === 'success') {
    dot.className = 'dot-success';
    label.textContent = `${providerName} 已同步`;
  } else if (status && status.state === 'error') {
    dot.className = 'dot-error';
    label.textContent = `${providerName} 失败`;
  } else {
    dot.className = 'dot-idle';
    label.textContent = `${providerName} 就绪`;
  }
}

function setupSyncWorkflow() {
  const syncPill = document.getElementById('sync-pill');
  if (syncPill) {
    syncPill.addEventListener('click', () => {
      if (chrome.runtime.openOptionsPage) {
        chrome.runtime.openOptionsPage();
      } else {
        window.open('options.html');
      }
    });
  }

  if (chrome && chrome.storage && chrome.storage.local) {
    chrome.storage.local.get(['selfhub_sync_config', 'selfhub_sync_status'], (res) => {
      const config = res.selfhub_sync_config;
      const status = res.selfhub_sync_status;
      updateSyncPill(status, config);

      // The legacy SyncManager no longer runs automatically from this page.
      //
      // Dev doc §9.3: after the P2 migration has been accepted, "关闭旧
      // SyncManager.performSync 写入". Until then it stays available as an explicit
      // action from the settings page (which states that it is the legacy,
      // independent mechanism) rather than a second automatic writer firing
      // whenever someone opens a new tab.
      if (config && config.provider && config.provider !== 'none') {
        const pill = document.getElementById('sync-status-pill');
        if (pill) {
          pill.title = '旧版独立同步仍保留配置，但不再自动执行；请在统一设置里确认后再手动触发。';
        }
      }
    });

    // Listen for status changes
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg && msg.type === 'SELFHUB_CHANGED') {
        // Ids only; re-query instead of trusting a broadcast body.
        refreshLocalContent();
        return;
      }
      if (msg.action === 'SYNC_STATUS_CHANGED') {
        chrome.storage.local.get(['selfhub_sync_config'], (cfgRes) => {
          updateSyncPill(msg.status, cfgRes.selfhub_sync_config);
          if (msg.status && msg.status.state === 'success') {
            refreshLocalContent();
          }
        });
      }
    });
  }
}

function setupEventListeners() {
  // Engine switchers
  document.querySelectorAll('.engine-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const engine = btn.getAttribute('data-engine');
      setEngine(engine);
    });
  });

  // Search submission
  document.getElementById('search-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const q = document.getElementById('search-input').value.trim();
    if (!q) return;

    // Direct URL navigation detection
    if (/^https?:\/\//i.test(q) || (/^([a-z0-9-]+\.)+[a-z]{2,}(\/.*)?$/i.test(q) && !q.includes(' '))) {
      const url = q.startsWith('http') ? q : `https://${q}`;
      window.location.href = url;
      return;
    }

    const targetUrl = ENGINES[currentEngine] + encodeURIComponent(q);
    window.location.href = targetUrl;
  });

  // Scratchpad Note auto-save with timestamp
  const noteEl = document.getElementById('quick-note');
  const statusEl = document.getElementById('note-status');
  let saveTimer = null;
  noteEl.addEventListener('input', () => {
    statusEl.innerText = '正在保存...';
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const val = noteEl.value;
      const now = Date.now();
      // The background owns the note now; local storage keeps a display cache so
      // the textarea still shows what the user typed before the round trip ends.
      localStorage.setItem('selfhub_quicknote', val);
      if (window.SelfHubClient) {
        window.SelfHubClient.send('SAVE_QUICK_NOTE', { text: val })
          .then(() => {
            statusEl.innerText = '已保存';
          })
          .catch((err) => {
            statusEl.innerText = '保存失败：' + (err.message || '扩展未响应');
          });
        return;
      }
      if (chrome && chrome.storage && chrome.storage.local) {
        chrome.storage.local.set({
          selfhub_quicknote: val,
          selfhub_quicknote_updatedAt: now
        });
      }
      statusEl.innerText = '已保存';
    }, 400);
  });

  // Fast Inbox Input
  const inboxInput = document.getElementById('inbox-input');
  const inboxMsg = document.getElementById('inbox-msg');
  inboxInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const val = inboxInput.value.trim();
      if (!val) return;

      const now = Date.now();
      const item = {
        id: `inbox-${now}`,
        content: val,
        type: val.startsWith('http') ? 'url' : 'text',
        url: val.startsWith('http') ? val : undefined,
        status: 'inbox',
        createdAt: now,
        updatedAt: now,
        isDeleted: false
      };

      if (window.SelfHubClient) {
        inboxInput.value = '';
        inboxMsg.innerText = '正在保存…';
        window.SelfHubClient.send('CAPTURE_ENTRY', {
          text: item.content,
          url: item.url,
          operationId: 'newtab-' + item.id
        }).then(() => {
          inboxMsg.innerText = '✅ 已存入统一收件箱待办！';
          setTimeout(() => { inboxMsg.innerText = ''; }, 2000);
        }).catch((err) => {
          inboxMsg.innerText = '保存失败：' + (err.message || '扩展未响应');
        });
      } else {
        // No background write path exists for this fallback; writing to
        // chrome.storage directly would bypass the single-writer protocol and
        // the entry would never be read. Tell the user instead of pretending.
        inboxMsg.innerText = '保存失败：扩展通信未就绪，请重新打开此页面';
      }
    }
  });

  // Handle Hub Link Navigation (Open Built-in Local App Dashboard)
  const hubBtn = document.getElementById('hub-main-btn');
  if (hubBtn) {
    hubBtn.addEventListener('click', (e) => {
      e.preventDefault();
      const openBuiltinApp = () => {
        const builtinUrl = chrome && chrome.runtime && chrome.runtime.getURL
          ? chrome.runtime.getURL('app/index.html#/home')
          : 'app/index.html';
        window.open(builtinUrl, '_blank');
      };

      if (chrome && chrome.storage && chrome.storage.local) {
        chrome.storage.local.get(['selfhub_web_url'], (res) => {
          const customUrl = res.selfhub_web_url || localStorage.getItem('selfhub_web_url');
          if (customUrl && !customUrl.includes('localhost:4173')) {
            window.open(customUrl, '_blank');
          } else {
            openBuiltinApp();
          }
        });
      } else {
        const customUrl = localStorage.getItem('selfhub_web_url');
        if (customUrl && !customUrl.includes('localhost:4173')) {
          window.open(customUrl, '_blank');
        } else {
          openBuiltinApp();
        }
      }
    });

    hubBtn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const current = localStorage.getItem('selfhub_web_url') || '';
      const updated = prompt('自定义 Self-Hub 远程部署网址（留空则默认使用内置离线工作台）：', current);
      if (updated !== null) {
        const trimmed = updated.trim();
        localStorage.setItem('selfhub_web_url', trimmed);
        if (chrome && chrome.storage && chrome.storage.local) {
          chrome.storage.local.set({ selfhub_web_url: trimmed });
        }
        alert(trimmed ? `✅ 已配置为远程网址: ${trimmed}` : '✅ 已恢复为插件内置离线工作台！');
      }
    });
  }
}

function setEngine(engine) {
  currentEngine = engine;
  localStorage.setItem('selfhub_newtab_engine', engine);
  document.querySelectorAll('.engine-btn').forEach(b => {
    b.classList.toggle('active', b.getAttribute('data-engine') === engine);
  });
}

function renderCategories() {
  const catBar = document.getElementById('cat-bar');
  const categories = Array.from(new Set(['常用推荐', ...allSites.map(s => s.category)]));

  catBar.innerHTML = '';
  categories.forEach(cat => {
    const btn = document.createElement('button');
    btn.className = `cat-btn ${cat === currentCategory ? 'active' : ''}`;
    btn.innerText = cat;
    btn.addEventListener('click', () => {
      currentCategory = cat;
      document.querySelectorAll('.cat-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      renderSites();
    });
    catBar.appendChild(btn);
  });
}

function renderSites() {
  const grid = document.getElementById('bookmarks-grid');
  const filtered = allSites.filter(s => s.category === currentCategory);

  grid.innerHTML = '';
  filtered.forEach(site => {
    const card = document.createElement('a');
    card.className = 'site-card';
    card.href = site.url;

    const initial = site.title ? site.title.charAt(0).toUpperCase() : 'W';
    card.innerHTML = `
      <div class="site-header">
        <div class="site-icon">${initial}</div>
        <div class="site-title">${site.title}</div>
      </div>
      <div class="site-desc">${site.desc || site.description || site.url}</div>
    `;
    grid.appendChild(card);
  });
}
