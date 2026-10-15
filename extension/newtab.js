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

  // Load custom sites from chrome storage if available
  if (chrome && chrome.storage && chrome.storage.local) {
    chrome.storage.local.get(['selfhub_sites', 'selfhub_quicknote'], (res) => {
      if (res.selfhub_sites && res.selfhub_sites.length > 0) {
        allSites = res.selfhub_sites;
      }
      renderCategories();
      renderSites();

      if (res.selfhub_quicknote) {
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

  setupEventListeners();
});

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

  // Scratchpad Note auto-save
  const noteEl = document.getElementById('quick-note');
  const statusEl = document.getElementById('note-status');
  let saveTimer = null;
  noteEl.addEventListener('input', () => {
    statusEl.innerText = '正在保存...';
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const val = noteEl.value;
      localStorage.setItem('selfhub_quicknote', val);
      if (chrome && chrome.storage && chrome.storage.local) {
        chrome.storage.local.set({ selfhub_quicknote: val });
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

      const item = {
        id: `inbox-${Date.now()}`,
        content: val,
        type: val.startsWith('http') ? 'url' : 'text',
        url: val.startsWith('http') ? val : undefined,
        status: 'inbox',
        createdAt: Date.now()
      };

      if (chrome && chrome.storage && chrome.storage.local) {
        chrome.storage.local.get(['selfhub_inbox'], (res) => {
          const list = res.selfhub_inbox || [];
          list.unshift(item);
          chrome.storage.local.set({ selfhub_inbox: list });
        });
      }

      inboxInput.value = '';
      inboxMsg.innerText = '✅ 已存入统一收件箱待办！';
      setTimeout(() => {
        inboxMsg.innerText = '';
      }, 2000);
    }
  });

  // Handle Hub Link Navigation
  const hubBtn = document.getElementById('hub-main-btn');
  if (hubBtn) {
    hubBtn.addEventListener('click', (e) => {
      e.preventDefault();
      if (chrome && chrome.storage && chrome.storage.local) {
        chrome.storage.local.get(['selfhub_web_url'], (res) => {
          let target = res.selfhub_web_url || localStorage.getItem('selfhub_web_url');
          if (!target) {
            target = prompt('请输入您的 Self-Hub 部署地址（例如 Cloudflare Pages 网址或 http://localhost:4173）：', 'http://localhost:4173');
            if (target) {
              target = target.trim();
              chrome.storage.local.set({ selfhub_web_url: target });
              localStorage.setItem('selfhub_web_url', target);
            }
          }
          if (target) {
            window.open(target, '_blank');
          }
        });
      } else {
        let target = localStorage.getItem('selfhub_web_url');
        if (!target) {
          target = prompt('请输入您的 Self-Hub 部署地址（例如 Cloudflare Pages 网址或 http://localhost:4173）：', 'http://localhost:4173');
          if (target) {
            target = target.trim();
            localStorage.setItem('selfhub_web_url', target);
          }
        }
        if (target) {
          window.open(target, '_blank');
        }
      }
    });

    hubBtn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const current = localStorage.getItem('selfhub_web_url') || 'http://localhost:4173';
      const updated = prompt('修改 Self-Hub 部署网址：', current);
      if (updated !== null) {
        const trimmed = updated.trim();
        localStorage.setItem('selfhub_web_url', trimmed);
        if (chrome && chrome.storage && chrome.storage.local) {
          chrome.storage.local.set({ selfhub_web_url: trimmed });
        }
        alert('✅ Self-Hub 部署网址已更新！');
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
