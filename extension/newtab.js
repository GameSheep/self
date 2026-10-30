/**
 * Self-Hub 新标签页（独立页）。
 *
 * 与工作台的关系：
 * - 它**不是**工作台，没有左侧菜单；右上角「进入工作台」才跳 `app/index.html#/home`。
 * - 它直接读同一份数据（同源）：v2 在 `localStorage['self_hub_data_v2']`，v3 在 IndexedDB
 *   `self_hub_idb`。所以「搜索所有内容」不用先打开工作台。
 * - 「常用网站」由**用户自己点 ☆ 决定**，存在 `chrome.storage.local.selfhub_newtab_pins`
 *   （只存网站 id；工作台里删掉这个网站时，这里自动不再显示它）。
 */
(function () {
  'use strict';

  var V2_KEY = 'self_hub_data_v2';
  var THEME_KEY = 'selfhub_newtab_theme';
  var MODE_KEY = 'selfhub_storage_mode';
  var PINS_KEY = 'selfhub_newtab_pins';
  var IDB_NAME = 'self_hub_idb';
  var DAY = 86400000;

  var state = null;
  var pins = [];
/**
   * 分类归并：只影响"怎么显示"，不改用户数据里的 category。
   *
   * 用户的旧分类名很长（"AI 工具、API 与编程平台"、"导航、个人项目与用途待确认"），
   * 平铺在下拉里根本分不清。这里按用途压成 6 个固定分组，原始分类名放在 title 里。
   */
  var BUCKETS = ['工具', '开发', '运维', 'AI', '社区', '其他'];

  function bucketOf(site) {
    var raw = String((site && site.category) || '').trim();
    var text = raw + ' ' + String((site && site.url) || '');
    if (/AI|GPT|Claude|大模型|模型|prompt|对话/i.test(text)) return 'AI';
    if (/运维|服务器|服务与后台|后台|云|部署|监控|域名|CDN|OSS|数据库|Docker/i.test(text)) return '运维';
    // 社区要排在 开发 之前：「技术社区与编程学习」属于社区，不是开发。
    if (/社区|资讯|知识|学习|博客|论坛|阅读|文档/i.test(text)) return '社区';
    if (/开发|编程|脚本|代码|技术|API|GitHub|框架|前端|后端/i.test(text)) return '开发';
    if (/工具|常用|效率|笔记|邮箱|设计|影音|媒体/i.test(text)) return '工具';
    return '其他';
  }

  function groupByBucket(sites) {
    var groups = {};
    BUCKETS.forEach(function (bucket) {
      groups[bucket] = [];
    });
    sites.forEach(function (site) {
      groups[bucketOf(site)].push(site);
    });
    return groups;
  }

  var activeBucket = '全部';


  /* ── 数据读取 ───────────────────────────────────────────── */

  function readV2() {
    try {
      var raw = localStorage.getItem(V2_KEY);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (err) {
      console.warn('[Self-Hub] new tab: v2 payload unreadable', err);
      return null;
    }
  }

  /** Best-effort read of the v3 library. Store names differ between generations, so try both. */
  function readIdb() {
    return new Promise(function (resolve) {
      var request;
      try {
        request = indexedDB.open(IDB_NAME);
      } catch (err) {
        resolve(null);
        return;
      }
      request.onerror = function () {
        resolve(null);
      };
      request.onupgradeneeded = function () {
        // Opening a missing DB would create an empty one; that is harmless but pointless.
        try {
          request.transaction.abort();
        } catch (err) {
          /* ignore */
        }
        resolve(null);
      };
      request.onsuccess = function () {
        var db = request.result;
        var names = Array.prototype.slice.call(db.objectStoreNames);
        if (!names.length) {
          db.close();
          resolve(null);
          return;
        }
        var wanted = [
          'notes',
          'sites',
          'reminders',
          'servers',
          'secrets',
          'inbox',
          'annotations',
          'domains',
          'projects'
        ];
        var out = {};
        var pending = 0;
        var done = false;
        var finish = function () {
          if (done) return;
          done = true;
          db.close();
          resolve(out);
        };
        wanted.forEach(function (base) {
          var name = names.indexOf(base) >= 0 ? base : names.indexOf(base + '_v3') >= 0 ? base + '_v3' : null;
          if (!name) return;
          pending += 1;
          try {
            var getAll = db.transaction(name, 'readonly').objectStore(name).getAll();
            getAll.onsuccess = function () {
              out[base] = (getAll.result || []).filter(function (row) {
                return row && row.isDeleted !== true;
              });
              pending -= 1;
              if (pending === 0) finish();
            };
            getAll.onerror = function () {
              pending -= 1;
              if (pending === 0) finish();
            };
          } catch (err) {
            pending -= 1;
            if (pending === 0) finish();
          }
        });
        if (pending === 0) finish();
      };
    });
  }

  function asArray(value) {
    return Array.isArray(value) ? value : [];
  }

  /** Merge v2 + v3 into one shape the renderer uses. Per collection, the richer source wins. */
  function buildState(v2, idb) {
    var pick = function (key) {
      var fromV2 = v2 ? asArray(v2[key]) : [];
      var fromIdb = idb ? asArray(idb[key]) : [];
      return fromV2.length >= fromIdb.length ? fromV2 : fromIdb;
    };
    return {
      notes: pick('notes'),
      sites: pick('sites'),
      reminders: pick('reminders'),
      servers: pick('servers'),
      secrets: pick('secrets'),
      inbox: pick('inbox'),
      annotations: pick('annotations'),
      domains: pick('domains'),
      projects: pick('projects'),
      checkIns: pick('checkIns')
    };
  }

  function loadPins() {
    return new Promise(function (resolve) {
      try {
        chrome.storage.local.get([PINS_KEY], function (res) {
          var value = res && res[PINS_KEY];
          resolve(Array.isArray(value) ? value : []);
        });
      } catch (err) {
        resolve([]);
      }
    });
  }

  function savePins() {
    try {
      chrome.storage.local.set({ selfhub_newtab_pins: pins });
    } catch (err) {
      console.warn('[Self-Hub] new tab: cannot persist pins', err);
    }
  }

  /* ── 工具 ───────────────────────────────────────────────── */

  function daysUntil(ts) {
    if (!ts || !isFinite(ts)) return NaN;
    var today = new Date();
    today.setHours(0, 0, 0, 0);
    var target = new Date(ts);
    target.setHours(0, 0, 0, 0);
    return Math.round((target.getTime() - today.getTime()) / DAY);
  }

  function relTime(ts) {
    if (!ts) return '';
    var diff = Date.now() - ts;
    if (diff < 60000) return '刚刚';
    if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前';
    if (diff < DAY) return Math.floor(diff / 3600000) + ' 小时前';
    if (diff < 30 * DAY) return Math.floor(diff / DAY) + ' 天前';
    return new Date(ts).toLocaleDateString();
  }

  function hostOf(url) {
    return String(url || '')
      .replace(/^https?:\/\//, '')
      .replace(/\/.*$/, '');
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function workspaceUrl(hash) {
    var suffix = hash || '#/home';
    try {
      return chrome.runtime.getURL('app/index.html' + suffix);
    } catch (err) {
      return 'app/index.html' + suffix;
    }
  }

  /* ── 渲染 ───────────────────────────────────────────────── */

  function renderNotes() {
    var host = document.getElementById('notes-list');
    host.textContent = '';
    var notes = asArray(state.notes)
      .slice()
      .sort(function (a, b) {
        return (b.updatedAt || 0) - (a.updatedAt || 0);
      })
      .slice(0, 10);
    if (!notes.length) {
      host.appendChild(el('div', 'empty', '还没有笔记。进工作台写第一条，这里就会出现。'));
      return;
    }
    notes.forEach(function (note) {
      var row = el('button', 'list-item');
      row.type = 'button';
      row.setAttribute('data-note-id', note.id);
      var main = el('span', 'list-main');
      main.appendChild(el('span', 'list-title', note.title || '未命名笔记'));
      main.appendChild(el('span', 'list-sub', (note.folder ? note.folder + ' · ' : '') + relTime(note.updatedAt)));
      row.appendChild(main);
      row.addEventListener('click', function () {
        window.location.href = workspaceUrl('#/library/item/note:' + note.id);
      });
      host.appendChild(row);
    });
  }

  function pinButton(site) {
    var pinned = pins.indexOf(site.id) >= 0;
    var button = el('button', 'pin', pinned ? '★' : '☆');
    button.type = 'button';
    button.setAttribute('aria-pressed', pinned ? 'true' : 'false');
    button.setAttribute('aria-label', (pinned ? '从常用移除 ' : '加入常用 ') + (site.title || hostOf(site.url)));
    button.setAttribute('data-pin', site.id);
    button.title = pinned ? '从常用移除' : '加入常用';
    button.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopPropagation();
      togglePin(site.id);
    });
    return button;
  }

  // ── 站点图标：真 favicon 优先，加载失败原地换成按主机名着色的首字母块。 ──
  // favicon 只向站点自身请求（它的 /favicon.ico），不经过任何第三方图标服务。
  // 注意：Chromium 会静默取消路径恰好是裸 /favicon.ico 的子资源请求（img 亦然，
  // 连网络层都不到），必须带一个查询参数才能作为普通图片请求发出。
  function faviconUrl(site) {
    try {
      return new URL('/favicon.ico?s=1', site.url).href;
    } catch (e) {
      return '';
    }
  }

  function hueOf(hostname) {
    var h = 0;
    for (var i = 0; i < hostname.length; i++) h = (h * 31 + hostname.charCodeAt(i)) % 360;
    return h;
  }

  // 彩色首字母块：色相写进 --h，深浅主题各自配色（见 newtab.css）。
  function tileMark(hostname, initial) {
    var mark = el('span', 'tile-mark', initial);
    mark.style.setProperty('--h', String(hueOf(hostname)));
    return mark;
  }

  function tileIcon(site) {
    var hostname = hostOf(site.url).replace(/^www\./, '');
    var initial = String(site.title || hostname || '?').trim().charAt(0).toUpperCase() || '?';
    var src = faviconUrl(site);
    if (!src) return tileMark(hostname, initial);
    var img = document.createElement('img');
    img.className = 'tile-icon';
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.src = src;
    img.addEventListener('error', function () {
      if (img.parentNode) img.parentNode.replaceChild(tileMark(hostname, initial), img);
    });
    return img;
  }

  function siteCard(site) {
    var hostname = hostOf(site.url).replace(/^www\./, '');
    var card = el('div', 'site-tile');
    card.setAttribute('data-site-id', site.id);
    var link = el('a', 'tile-link');
    link.href = site.url;
    link.target = '_blank';
    link.rel = 'noreferrer';
    link.title = (site.title || '') + '\n' + site.url;
    link.appendChild(tileIcon(site));
    link.appendChild(el('span', 'tile-name', site.title || hostname));
    card.appendChild(link);
    card.appendChild(pinButton(site));
    return card;
  }

  function togglePin(id) {
    var index = pins.indexOf(id);
    if (index >= 0) pins.splice(index, 1);
    else pins.push(id);
    savePins();
    renderPinned();
    renderAllSites();
  }

  function renderPinned() {
    var host = document.getElementById('pinned-sites');
    host.textContent = '';
    var sites = asArray(state.sites);
    var byId = {};
    sites.forEach(function (site) {
      byId[site.id] = site;
    });
    // Drop ids whose site no longer exists: the workbench is the source of truth for sites.
    var live = pins.filter(function (id) {
      return Boolean(byId[id]);
    });
    if (live.length !== pins.length) {
      pins = live.slice();
      savePins();
    }
    if (!live.length) {
      host.appendChild(el('div', 'empty', '还没有常用网站。在下面「全部网站」里点 ☆ 就会出现在这里。'));
      return;
    }
    live.forEach(function (id) {
      host.appendChild(siteCard(byId[id]));
    });
  }

  function renderAllSites() {
    var host = document.getElementById('all-sites');
    host.textContent = '';
    var sites = asArray(state.sites);
    if (!sites.length) {
      host.appendChild(el('div', 'empty', '还没有网站。进工作台「快捷导航」添加，或先把浏览器书签导进去。'));
      return;
    }
    var groups = groupByBucket(sites);

    // 分类 = 全部 + 每个非空分组（带计数）。桌面是左栏，窄屏折成横向条。
    var tabDefs = [{ key: '全部', count: sites.length }].concat(
      BUCKETS.filter(function (bucket) {
        return groups[bucket].length > 0;
      }).map(function (bucket) {
        return { key: bucket, count: groups[bucket].length };
      })
    );

    // A site can move out of the selected bucket; fall back to 全部 instead of
    // rendering an empty panel with no selected tab.
    var activeIndex = 0;
    tabDefs.forEach(function (def, index) {
      if (def.key === activeBucket) activeIndex = index;
    });
    activeBucket = tabDefs[activeIndex].key;

    var browser = el('div', 'site-browser');

    var categories = el('aside', 'site-categories');
    categories.setAttribute('aria-label', '网站分类');
    var head = el('div', 'site-categories-head');
    head.appendChild(el('span', null, '分类'));
    head.appendChild(el('span', 'site-categories-count', String(tabDefs.length - 1) + ' 组'));
    categories.appendChild(head);

    var tabs = el('div', 'site-tabs');
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-orientation', 'vertical');
    tabDefs.forEach(function (def, index) {
      var tab = el('button', 'tab');
      tab.type = 'button';
      tab.id = 'site-bucket-tab-' + index;
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', activeBucket === def.key ? 'true' : 'false');
      tab.setAttribute('aria-controls', 'site-bucket-panel');
      tab.setAttribute('data-bucket', def.key);
      tab.appendChild(el('span', 'tab-label', def.key));
      tab.appendChild(el('span', 'tab-count', String(def.count)));
      tab.addEventListener('click', function () {
        activeBucket = def.key;
        renderAllSites();
        var current = document.querySelector('#all-sites .tab[aria-selected="true"]');
        if (current) current.focus();
      });
      tabs.appendChild(tab);
    });
    categories.appendChild(tabs);
    browser.appendChild(categories);

    var panel = el('div', 'site-panel');
    panel.id = 'site-bucket-panel';
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', 'site-bucket-tab-' + activeIndex);

    var list = activeBucket === '全部' ? sites : groups[activeBucket] || [];
    if (!list.length) {
      panel.appendChild(el('div', 'empty', '这个分类下还没有网站。'));
    } else {
      var grid = el('div', 'chips');
      list.forEach(function (site) {
        var pinned = pins.indexOf(site.id) >= 0;
        var chip = el('span', 'chip' + (pinned ? ' pinned' : ''));
        // 原始分类名保留在 title 里，方便核对归并到了哪一组。
        chip.title = (site.category ? site.category + ' · 归入「' + bucketOf(site) + '」' : '未分类');
        chip.appendChild(tileIcon(site));
        var link = el('a', null, site.title || hostOf(site.url));
        link.href = site.url;
        link.target = '_blank';
        link.rel = 'noreferrer';
        chip.appendChild(link);
        chip.appendChild(pinButton(site));
        grid.appendChild(chip);
      });
      panel.appendChild(grid);
    }
    browser.appendChild(panel);
    host.appendChild(browser);
  }

  function renderReminders() {
    var host = document.getElementById('reminders-list');
    host.textContent = '';
    var reminders = asArray(state.reminders)
      .filter(function (item) {
        return !item.completed;
      })
      .map(function (item) {
        return { item: item, days: daysUntil(item.targetDate) };
      })
      .filter(function (entry) {
        return isFinite(entry.days);
      })
      .sort(function (a, b) {
        return a.days - b.days;
      })
      .slice(0, 10);
    if (!reminders.length) {
      host.appendChild(el('div', 'empty', '没有待办提醒。'));
      return;
    }
    reminders.forEach(function (entry) {
      var row = el('button', 'list-item');
      row.type = 'button';
      var main = el('span', 'list-main');
      main.appendChild(el('span', 'list-title', entry.item.title || '未命名提醒'));
      main.appendChild(el('span', 'list-sub', entry.item.category || ''));
      row.appendChild(main);
      var days = entry.days;
      row.appendChild(
        el(
          'span',
          'badge ' + (days < 0 ? 'overdue' : days <= 7 ? 'soon' : 'ok'),
          days < 0 ? '过期 ' + Math.abs(days) + ' 天' : days === 0 ? '今天' : days + ' 天后'
        )
      );
      row.addEventListener('click', function () {
        window.location.href = workspaceUrl('#/reminders');
      });
      host.appendChild(row);
    });
  }

  /** 划线颜色 → 色点（与侧边栏 COLOR_MAP 保持一致）。 */
  var HL_COLORS = {
    yellow: '#fde047',
    green: '#86efac',
    blue: '#93c5fd',
    purple: '#d8b4fe',
    red: '#fca5a5'
  };

  function snippetOf(text, max) {
    var value = String(text || '').replace(/\s+/g, ' ').trim();
    return value.length > max ? value.slice(0, max - 1) + '…' : value;
  }

  /**
   * 网页批注：右栏卡片，最近的划词在前。
   * 点击进工作台该批注的条目页（原文 + 批注一起看），不直接跳原网页——
   * 原网页入口在条目页里有，这里更要紧的是"我存了什么"。
   */
  function renderAnnotations() {
    var host = document.getElementById('annotations-list');
    if (!host) return;
    host.textContent = '';
    var rows = asArray(state.annotations)
      .filter(function (item) {
        return item && item.isDeleted !== true;
      })
      .slice()
      .sort(function (a, b) {
        return (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0);
      })
      .slice(0, 8);
    if (!rows.length) {
      host.appendChild(el('div', 'empty', '还没有网页批注。在网页里划词保存后，这里就会出现。'));
      return;
    }
    rows.forEach(function (item) {
      var row = el('button', 'list-item');
      row.type = 'button';
      row.setAttribute('data-annotation-id', item.id);
      var title = snippetOf(item.pageTitle, 40) || snippetOf(item.text, 40) || '未命名批注';
      var subParts = [snippetOf(item.text, 60), snippetOf(item.note, 60)].filter(Boolean);
      var when = relTime(item.updatedAt || item.createdAt);
      if (when) subParts.push(when);

      var dotWrap = el('span', 'list-dot');
      var dot = el('span', 'hl-dot');
      dot.style.backgroundColor = HL_COLORS[item.color] || HL_COLORS.yellow;
      dotWrap.appendChild(dot);
      row.appendChild(dotWrap);

      var main = el('span', 'list-main');
      main.appendChild(el('span', 'list-title', title));
      var sub = subParts.join(' · ');
      if (sub) main.appendChild(el('span', 'list-sub', sub));
      row.appendChild(main);

      row.addEventListener('click', function () {
        window.location.href = workspaceUrl('#/library/item/webpage:' + encodeURIComponent(item.id));
      });
      host.appendChild(row);
    });
  }

  /**
   * 签到 = 中间列的一条横排站点清单（右栏的签到卡片已删）。
   *
   * 每个 chip 直接打开该站的签到页——"签到网站清单"的语义就是打开由人来签；
   * 没有配置任何站点时整条隐藏，不占地方。
   */
  function renderCheckIns() {
    var strip = document.getElementById('checkins-strip');
    var host = document.getElementById('checkins-items');
    if (!strip || !host) return;
    host.textContent = '';
    var tasks = asArray(state.checkIns).slice(0, 12);
    if (!tasks.length) {
      strip.hidden = true;
      return;
    }
    strip.hidden = false;
    tasks.forEach(function (task) {
      var chip = el('button', 'chip');
      chip.type = 'button';
      chip.title = '打开 ' + (task.name || task.url || '签到站点') + ' 的签到页';
      chip.textContent = task.name || '未命名站点';
      chip.addEventListener('click', function () {
        if (task.url) window.open(task.url, '_blank', 'noopener,noreferrer');
      });
      host.appendChild(chip);
    });
  }

  /* ── 搜索：跨所有集合 ───────────────────────────────────── */

  function buildIndex() {
    var items = [];
    var push = function (kind, title, sub, onOpen) {
      items.push({ kind: kind, title: title || '', sub: sub || '', onOpen: onOpen });
    };
    asArray(state.notes).forEach(function (note) {
      push('笔记', note.title, [note.folder, note.content].filter(Boolean).join(' · '), function () {
        window.location.href = workspaceUrl('#/library/item/note:' + note.id);
      });
    });
    asArray(state.sites).forEach(function (site) {
      push('网站', site.title, site.url, function () {
        window.open(site.url, '_blank', 'noopener,noreferrer');
      });
    });
    asArray(state.annotations).forEach(function (item) {
      push('批注', item.pageTitle || item.text, [item.text, item.note].filter(Boolean).join(' · '), function () {
        window.open(item.pageUrl || workspaceUrl('#/library?type=webpage'), '_blank', 'noopener,noreferrer');
      });
    });
    asArray(state.reminders).forEach(function (item) {
      push('提醒', item.title, item.category, function () {
        window.location.href = workspaceUrl('#/reminders');
      });
    });
    asArray(state.servers).forEach(function (item) {
      push('服务器', item.name, item.publicIp || item.host, function () {
        window.location.href = workspaceUrl('#/resources/servers');
      });
    });
    asArray(state.domains).forEach(function (item) {
      push('域名', item.name, item.registrar, function () {
        window.location.href = workspaceUrl('#/resources/assets');
      });
    });
    // Secrets: title only. The new tab must never surface a credential value.
    asArray(state.secrets).forEach(function (item) {
      push('凭证', item.title || item.name, '按标题匹配（内容不显示）', function () {
        window.location.href = workspaceUrl('#/resources/vault');
      });
    });
    asArray(state.projects).forEach(function (item) {
      push('项目', item.name, item.description, function () {
        window.location.href = workspaceUrl('#/projects');
      });
    });
    asArray(state.inbox).forEach(function (item) {
      if (item.status && item.status !== 'inbox') return;
      push('收件箱', item.content, item.url, function () {
        window.location.href = workspaceUrl('#/inbox');
      });
    });
    return items;
  }

  function runSearch(query) {
    var results = document.getElementById('results');
    var needle = String(query || '').trim().toLowerCase();
    if (!needle) {
      results.hidden = true;
      results.textContent = '';
      return;
    }
    var hits = buildIndex()
      .filter(function (item) {
        return item.title.toLowerCase().indexOf(needle) >= 0 || item.sub.toLowerCase().indexOf(needle) >= 0;
      })
      .slice(0, 40);
    results.textContent = '';
    results.hidden = false;
    if (!hits.length) {
      results.appendChild(el('div', 'empty', '没找到匹配的内容。'));
      return;
    }
    hits.forEach(function (hit) {
      var row = el('button', 'result');
      row.type = 'button';
      row.appendChild(el('span', 'result-kind', hit.kind));
      var main = el('span', 'result-main');
      main.appendChild(el('span', 'result-title', hit.title || '（无标题）'));
      if (hit.sub) main.appendChild(el('span', 'result-sub', String(hit.sub).slice(0, 160)));
      row.appendChild(main);
      row.addEventListener('click', hit.onOpen);
      results.appendChild(row);
    });
  }

  /* ── 记一笔 ─────────────────────────────────────────────── */

  function submitCapture() {
    var input = document.getElementById('capture-input');
    var status = document.getElementById('capture-status');
    if (!input || !status) return;
    var text = (input.value || '').trim();
    if (!text) return;
    status.className = 'capture-status subtle';
    status.style.color = '';
    status.textContent = '保存中…';
    var isUrl = /^https?:\/\//i.test(text);
    var payload = {
      text: text,
      operationId: 'newtab-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8)
    };
    if (isUrl) payload.url = text;
    window.SelfHubClient.send('CAPTURE_ENTRY', payload)
      .then(function () {
        status.className = 'capture-status';
        status.style.color = 'var(--ok)';
        status.textContent = '已进收件箱';
        input.value = '';
        setTimeout(function () {
          status.textContent = '';
        }, 2600);
      })
      .catch(function (err) {
        status.className = 'capture-status';
        status.style.color = 'var(--danger)';
        status.textContent = '保存失败：' + ((err && err.message) || '扩展未响应');
      });
  }

  /* ── 启动 ───────────────────────────────────────────────── */

  function wireStaticLinks() {
    var map = {
      'open-workspace': '#/home',
      'open-notes': '#/library?view=notes',
      'open-annotations': '#/library?type=webpage',
      'open-navigation': '#/navigation',
      'open-reminders': '#/reminders',
      'open-checkins': '#/tools/checkins'
    };
    Object.keys(map).forEach(function (id) {
      var node = document.getElementById(id);
      if (node) node.setAttribute('href', workspaceUrl(map[id]));
    });
    var input = document.getElementById('capture-input');
    var submit = document.getElementById('capture-submit');
    if (submit) submit.addEventListener('click', submitCapture);
    if (input) {
      input.addEventListener('keydown', function (event) {
        if (event.key === 'Enter') {
          event.preventDefault();
          submitCapture();
        }
      });
    }
    var search = document.getElementById('search-input');
    if (search) {
      search.addEventListener('input', function () {
        runSearch(search.value);
      });
      search.addEventListener('keydown', function (event) {
        if (event.key === 'Escape') {
          search.value = '';
          runSearch('');
        }
      });
      // The new tab exists to search; nothing else should compete for the cursor.
      setTimeout(function () {
        search.focus();
      }, 30);
    }
  }

  function applyTheme(mode) {
    document.documentElement.setAttribute('data-theme', mode === 'dark' ? 'dark' : 'light');
    var button = document.getElementById('theme-toggle');
    if (button) {
      var isDark = mode === 'dark';
      button.textContent = isDark ? '☀️' : '🌙';
      button.setAttribute('aria-label', isDark ? '切换到浅色' : '切换到深色');
      button.title = isDark ? '切换到浅色' : '切换到深色';
    }
  }

  /**
   * 主题优先级：本页手动选择 > 工作台的主题 > 浅色。
   * 新标签页是"看一眼、搜一下"的页面，浅色更耐看；用户想跟工作台一致时点右上角切换即可。
   */
  function resolveTheme(v2) {
    return new Promise(function (resolve) {
      try {
        chrome.storage.local.get([THEME_KEY], function (res) {
          var saved = res && res[THEME_KEY];
          if (saved === 'light' || saved === 'dark') {
            resolve(saved);
            return;
          }
          resolve(v2 && v2.theme === 'dark' ? 'dark' : 'light');
        });
      } catch (err) {
        resolve('light');
      }
    });
  }

  function boot() {
    wireStaticLinks();
    var v2 = readV2();
    var mode = 'local';
    try {
      mode = localStorage.getItem(MODE_KEY) === 'v3' ? 'v3' : 'local';
    } catch (err) {
      mode = 'local';
    }
    var start = function (idb) {
      state = buildState(v2, idb);
      resolveTheme(v2).then(function (mode) {
        applyTheme(mode);
        var toggle = document.getElementById('theme-toggle');
        if (toggle) {
          toggle.addEventListener('click', function () {
            var next =
              document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
            applyTheme(next);
            try {
              chrome.storage.local.set({ selfhub_newtab_theme: next });
            } catch (err) {
              /* keep the visual change even if it cannot persist */
            }
          });
        }
      });
      loadPins().then(function (loaded) {
        pins = loaded;
        var saveState = document.getElementById('save-state');
        if (saveState) {
          var count = state.notes.length + state.sites.length + state.reminders.length + state.annotations.length;
          saveState.textContent = count ? '本机 · ' + (mode === 'v3' ? 'v3 库' : 'v2 负载') : '还没有数据 · 进工作台开始';
        }
        renderNotes();
        renderPinned();
        renderAllSites();
        renderReminders();
        renderAnnotations();
        renderCheckIns();
      });
    };
    if (mode === 'v3' || !v2) {
      readIdb().then(start);
    } else {
      start(null);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
