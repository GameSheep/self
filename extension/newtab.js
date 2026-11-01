/**
 * Self-Hub 新标签页（独立页）。
 *
 * 与工作台的关系：
 * - 它**不是**工作台，没有左侧菜单；右上角「进入工作台」才跳 `app/index.html#/home`。
 * - 它直接读同一份数据（同源）：v2 在 `localStorage['self_hub_data_v2']`，v3 在 IndexedDB
 *   `self_hub_idb`。所以「搜索所有内容」不用先打开工作台。
 * - 「常用网站」由**用户自己点 ☆ 决定**，存在 `chrome.storage.local.selfhub_newtab_pins`
 *   （只存网站 id；工作台里删掉这个网站时，这里自动不再显示它）。
 *
 * 面板本身（列宽、模块顺序、高度、数据来源）由 `newtab-dashboard.js` 管；这个文件只
 * 负责「每个模块里画什么」和页面级的搜索 / 主题。
 */
(function () {
  'use strict';

  var V2_KEY = 'self_hub_data_v2';
  var THEME_KEY = 'selfhub_newtab_theme';
  var MODE_KEY = 'selfhub_storage_mode';
  var PINS_KEY = 'selfhub_newtab_pins';
  var PENDING_NOTES_KEY = 'selfhub_pending_notes';
  var HINT_KEY = 'selfhub_newtab_hint_seen';
  var IDB_NAME = 'self_hub_idb';
  var DAY = 86400000;

  var state = null;
  var pins = [];
  var dashboard = null;
  var pendingNotes = [];

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

  function goWorkspace(hash) {
    window.location.href = workspaceUrl(hash);
  }

  function moreLink(text, hash) {
    var link = el('a', 'module-more', text);
    link.href = workspaceUrl(hash);
    return link;
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

  /**
   * 一个网站 = 一张小卡片。
   *
   * 用户要的「card 中的 card」：外面的网站模块是一张卡，里面每个网站还是卡，
   * 而不是一排扁平的 chip。卡片之间靠间距和描边分层，不靠背景色差。
   */
  function siteCard(site, options) {
    var hostname = hostOf(site.url).replace(/^www\./, '');
    var card = el('div', 'site-card');
    card.setAttribute('data-site-id', site.id);
    var link = el('a', 'site-card-link');
    link.href = site.url;
    link.target = '_blank';
    link.rel = 'noreferrer';
    link.title = (site.title || '') + '\n' + site.url;
    link.appendChild(tileIcon(site));
    link.appendChild(el('span', 'site-card-name', site.title || hostname));
    if (options && options.showHost) link.appendChild(el('span', 'site-card-host', hostname));
    card.appendChild(link);
    card.appendChild(pinButton(site));
    return card;
  }

  function togglePin(id) {
    var index = pins.indexOf(id);
    if (index >= 0) pins.splice(index, 1);
    else pins.push(id);
    savePins();
    if (dashboard) dashboard.refreshBodies(['pinned', 'sites']);
  }

  /* ── 模块：笔记 ─────────────────────────────────────────── */

  function noteFolders() {
    var seen = {};
    var out = [];
    asArray(state.notes).forEach(function (note) {
      var folder = String(note.folder || '').trim();
      if (!folder || seen[folder]) return;
      seen[folder] = true;
      out.push(folder);
    });
    return out.sort();
  }

  /** 待同步的笔记先混进来显示，用户不用等打开工作台才看得到自己刚写的东西。 */
  function allNotes() {
    var merged = asArray(state.notes).slice();
    var ids = {};
    merged.forEach(function (note) {
      ids[note.id] = true;
    });
    pendingNotes.forEach(function (note) {
      if (!ids[note.id]) merged.push(note);
    });
    return merged;
  }

  function renderNotesBody(mod, body) {
    var folder = mod.source && mod.source.mode === 'folder' ? mod.source.value : '';
    var notes = allNotes()
      .filter(function (note) {
        return !folder || String(note.folder || '') === folder;
      })
      .sort(function (a, b) {
        return (b.updatedAt || 0) - (a.updatedAt || 0);
      })
      .slice(0, 30);

    var list = el('div', 'list');
    if (!notes.length) {
      list.appendChild(
        el('div', 'empty', folder ? '「' + folder + '」里还没有笔记。' : '还没有笔记。左边「文本框」写一条，或进工作台写。')
      );
    } else {
      notes.forEach(function (note) {
        var row = el('button', 'list-item');
        row.type = 'button';
        row.setAttribute('data-note-id', note.id);
        var main = el('span', 'list-main');
        main.appendChild(el('span', 'list-title', note.title || '未命名笔记'));
        main.appendChild(el('span', 'list-sub', (note.folder ? note.folder + ' · ' : '') + relTime(note.updatedAt)));
        row.appendChild(main);
        row.addEventListener('click', function () {
          goWorkspace('#/library/item/note:' + note.id);
        });
        list.appendChild(row);
      });
    }
    body.appendChild(list);
    body.appendChild(moreLink('全部笔记 →', '#/library?view=notes'));
  }

  /* ── 模块：文本框（直接存进笔记）─────────────────────────── */

  function queuePendingNote(note) {
    return new Promise(function (resolve, reject) {
      try {
        chrome.storage.local.get([PENDING_NOTES_KEY], function (res) {
          var queue = Array.isArray(res && res[PENDING_NOTES_KEY]) ? res[PENDING_NOTES_KEY] : [];
          var exists = queue.some(function (item) {
            return item && item.id === note.id;
          });
          if (!exists) queue.push(note);
          chrome.storage.local.set({ selfhub_pending_notes: queue }, function () {
            if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
            else resolve(queue);
          });
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  function titleOf(text) {
    var firstLine = String(text || '')
      .split('\n')
      .map(function (line) {
        return line.trim();
      })
      .filter(Boolean)[0];
    if (!firstLine) return '新标签页笔记';
    return firstLine.length > 40 ? firstLine.slice(0, 39) + '…' : firstLine;
  }

  function renderQuickNoteBody(mod, body, moduleEl) {
    var folder = (mod.source && mod.source.mode === 'folder' && mod.source.value) || '';
    var form = el('div', 'quicknote');

    var textarea = document.createElement('textarea');
    textarea.className = 'quicknote-input';
    textarea.id = 'quicknote-input';
    textarea.rows = 4;
    textarea.placeholder = '想到什么写下来，直接存成一条笔记…';
    textarea.setAttribute('aria-label', '快速笔记');
    form.appendChild(textarea);

    var bar = el('div', 'quicknote-bar');
    var select = document.createElement('select');
    select.className = 'quicknote-folder';
    select.id = 'quicknote-folder';
    select.setAttribute('aria-label', '存到哪个文件夹');
    var rootOption = document.createElement('option');
    rootOption.value = '';
    rootOption.textContent = '根目录';
    select.appendChild(rootOption);
    noteFolders().forEach(function (name) {
      var option = document.createElement('option');
      option.value = name;
      option.textContent = name;
      select.appendChild(option);
    });
    select.value = folder;
    select.addEventListener('change', function () {
      mod.source = { mode: 'folder', value: select.value };
      if (dashboard) dashboard.save();
      var label = moduleEl && moduleEl.querySelector('.module-source');
      if (label) {
        label.textContent = select.value || '根目录';
        label.hidden = false;
      }
    });
    bar.appendChild(select);

    var status = el('span', 'quicknote-status');
    status.id = 'quicknote-status';
    bar.appendChild(status);

    var save = el('button', 'quicknote-save', '存进笔记');
    save.type = 'button';
    save.id = 'quicknote-save';
    bar.appendChild(save);
    form.appendChild(bar);
    body.appendChild(form);

    function submit() {
      var text = (textarea.value || '').trim();
      if (!text) {
        status.textContent = '写点什么再存';
        status.className = 'quicknote-status is-warn';
        return;
      }
      var note = {
        id: 'note-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7),
        title: titleOf(text),
        content: text,
        folder: select.value || undefined,
        tags: [],
        updatedAt: Date.now()
      };
      status.className = 'quicknote-status';
      status.textContent = '保存中…';
      save.disabled = true;
      queuePendingNote(note)
        .then(function () {
          pendingNotes.push(note);
          textarea.value = '';
          status.className = 'quicknote-status is-ok';
          status.textContent = '已存进笔记';
          save.disabled = false;
          if (dashboard) dashboard.refreshBodies(['notes']);
          setTimeout(function () {
            if (status.textContent === '已存进笔记') status.textContent = '';
          }, 2600);
        })
        .catch(function (err) {
          save.disabled = false;
          status.className = 'quicknote-status is-danger';
          status.textContent = '保存失败：' + ((err && err.message) || '扩展未响应');
        });
    }

    save.addEventListener('click', submit);
    textarea.addEventListener('keydown', function (event) {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault();
        submit();
      }
    });
  }

  /* ── 模块：记一笔（进收件箱）─────────────────────────────── */

  function renderCaptureBody(mod, body) {
    var form = el('div', 'capture');
    var input = document.createElement('input');
    input.id = 'capture-input';
    input.type = 'text';
    input.placeholder = '记一笔：先进收件箱，回工作台再整理';
    input.setAttribute('aria-label', '快速记录');
    form.appendChild(input);

    var submit = el('button', null, '记录');
    submit.id = 'capture-submit';
    submit.type = 'button';
    form.appendChild(submit);
    body.appendChild(form);

    var status = el('div', 'capture-status');
    status.id = 'capture-status';
    body.appendChild(status);

    function send() {
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

    submit.addEventListener('click', send);
    input.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') {
        event.preventDefault();
        send();
      }
    });
  }

  /* ── 模块：常用网站 / 全部网站 ───────────────────────────── */

  function livePins() {
    var byId = {};
    asArray(state.sites).forEach(function (site) {
      byId[site.id] = site;
    });
    var live = pins.filter(function (id) {
      return Boolean(byId[id]);
    });
    // 只有**确实读到了网站数据**才裁剪失效的 id。
    // 数据还没加载完（v3 库读得慢、或这一页先于工作台打开）时站点是空的，
    // 这时按「找不到就删」会把用户收藏的常用网站全清掉。
    if (state.sites.length && live.length !== pins.length) {
      pins = live.slice();
      savePins();
    }
    return live.map(function (id) {
      return byId[id];
    });
  }

  function renderPinnedBody(mod, body) {
    var sites = livePins();
    if (!sites.length) {
      body.appendChild(el('div', 'empty', '还没有常用网站。在下面「全部网站」里点 ☆ 就会出现在这里。'));
      return;
    }
    var grid = el('div', 'site-cards');
    sites.forEach(function (site) {
      grid.appendChild(siteCard(site));
    });
    body.appendChild(grid);
  }

  function renderSitesBody(mod, body) {
    var sites = asArray(state.sites);
    if (!sites.length) {
      body.appendChild(el('div', 'empty', '还没有网站。进工作台「快捷导航」添加，或先把浏览器书签导进去。'));
      body.appendChild(moreLink('去添网站 →', '#/navigation'));
      return;
    }
    var groups = groupByBucket(sites);
    var mode = (mod.source && mod.source.mode) || 'all';
    var activeBucket = mode === 'bucket' ? mod.source.value : '全部';

    // 分类筛选做成模块顶部的一排小 chip：点一下就是「换个数据来源」。
    var chips = el('div', 'bucket-chips');
    var defs = [{ key: '全部', count: sites.length }].concat(
      BUCKETS.filter(function (bucket) {
        return groups[bucket].length > 0;
      }).map(function (bucket) {
        return { key: bucket, count: groups[bucket].length };
      })
    );
    defs.forEach(function (def) {
      var chip = el('button', 'bucket-chip' + (def.key === activeBucket ? ' is-active' : ''), def.key);
      chip.type = 'button';
      chip.setAttribute('data-bucket', def.key);
      chip.appendChild(el('span', 'bucket-chip-count', String(def.count)));
      chip.addEventListener('click', function () {
        mod.source = def.key === '全部' ? { mode: 'all' } : { mode: 'bucket', value: def.key };
        if (dashboard) dashboard.render();
        dashboard.save();
      });
      chips.appendChild(chip);
    });
    body.appendChild(chips);

    var wrap = el('div', 'site-groups');
    defs
      .filter(function (def) {
        return def.key !== '全部' && (activeBucket === '全部' || def.key === activeBucket);
      })
      .forEach(function (def) {
        var list = groups[def.key];
        if (!list.length) return;
        var sub = el('div', 'subcard');
        sub.setAttribute('data-bucket-card', def.key);
        var head = el('div', 'subcard-head');
        head.appendChild(el('span', 'subcard-title', def.key));
        head.appendChild(el('span', 'subcard-count', String(list.length)));
        sub.appendChild(head);
        var grid = el('div', 'site-cards');
        list.forEach(function (site) {
          grid.appendChild(siteCard(site));
        });
        sub.appendChild(grid);
        wrap.appendChild(sub);
      });
    body.appendChild(wrap);
    body.appendChild(moreLink('管理网站 →', '#/navigation'));
  }

  /* ── 模块：签到网站 ─────────────────────────────────────── */

  function renderCheckInsBody(mod, body, moduleEl) {
    var tasks = asArray(state.checkIns).slice(0, 24);
    if (!tasks.length) {
      // 没有配置任何签到站点时整块隐藏，不占地方（和管理页的语义一致）。
      if (moduleEl) moduleEl.hidden = true;
      return;
    }
    var strip = el('div', 'checkin-strip');
    strip.id = 'checkins-items';
    var items = el('div', 'strip-items');
    tasks.forEach(function (task) {
      var chip = el('button', 'chip');
      chip.type = 'button';
      chip.title = '打开 ' + (task.name || task.url || '签到站点') + ' 的签到页';
      chip.textContent = task.name || '未命名站点';
      chip.addEventListener('click', function () {
        if (task.url) window.open(task.url, '_blank', 'noopener,noreferrer');
      });
      items.appendChild(chip);
    });
    strip.appendChild(items);
    var link = el('a', 'strip-link', '管理 →');
    link.href = workspaceUrl('#/tools/checkins');
    strip.appendChild(link);
    body.appendChild(strip);
  }

  /* ── 模块：提醒 ─────────────────────────────────────────── */

  function renderRemindersBody(mod, body) {
    var category = mod.source && mod.source.mode === 'category' ? mod.source.value : '';
    var reminders = asArray(state.reminders)
      .filter(function (item) {
        return !item.completed;
      })
      .filter(function (item) {
        return !category || String(item.category || '') === category;
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
      .slice(0, 30);

    var list = el('div', 'list');
    if (!reminders.length) {
      list.appendChild(el('div', 'empty', category ? '「' + category + '」下没有待办。' : '没有待办提醒。'));
    } else {
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
          goWorkspace('#/reminders');
        });
        list.appendChild(row);
      });
    }
    body.appendChild(list);
    body.appendChild(moreLink('全部提醒 →', '#/reminders'));
  }

  /* ── 模块：网页批注 ─────────────────────────────────────── */

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

  function annotationDomains() {
    var seen = {};
    var out = [];
    asArray(state.annotations).forEach(function (item) {
      var host = hostOf(item.pageUrl).replace(/^www\./, '');
      if (!host || seen[host]) return;
      seen[host] = true;
      out.push(host);
    });
    return out.sort();
  }

  function renderAnnotationsBody(mod, body) {
    var domain = mod.source && mod.source.mode === 'domain' ? mod.source.value : '';
    var rows = asArray(state.annotations)
      .filter(function (item) {
        return item && item.isDeleted !== true;
      })
      .filter(function (item) {
        return !domain || hostOf(item.pageUrl).replace(/^www\./, '') === domain;
      })
      .slice()
      .sort(function (a, b) {
        return (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0);
      })
      .slice(0, 30);

    var list = el('div', 'list');
    if (!rows.length) {
      list.appendChild(el('div', 'empty', '还没有网页批注。在网页里划词保存后，这里就会出现。'));
    } else {
      rows.forEach(function (item) {
        var row = el('button', 'list-item');
        row.type = 'button';
        row.setAttribute('data-annotation-id', item.id);
        // 原文是主行，页面标题退到副行——同一篇文章划多条时，标题全一样，
        // 真正区分它们的是划了什么（工作台批注列表同款口径）。
        var title = snippetOf(item.text, 60) || snippetOf(item.note, 60) || snippetOf(item.pageTitle, 40) || '未命名批注';
        var subParts = [snippetOf(item.note, 60) || snippetOf(item.pageTitle, 40)];
        var when = relTime(item.updatedAt || item.createdAt);
        if (when) subParts.push(when);

        var dotWrap = el('span', 'list-dot');
        var dot = el('span', 'hl-dot');
        var hl = HL_COLORS[item.color] || HL_COLORS.yellow;
        dot.style.backgroundColor = hl;
        dotWrap.appendChild(dot);
        row.appendChild(dotWrap);

        var main = el('span', 'list-main');
        // 原文带荧光底（和工作台批注列表同款），一眼看出「划的是哪句」。
        var titleSpan = el('span', 'list-title', title);
        titleSpan.style.backgroundColor = hl + '1f';
        titleSpan.style.borderRadius = '3px';
        titleSpan.style.padding = '0 3px';
        main.appendChild(titleSpan);
        var sub = subParts.join(' · ');
        if (sub) main.appendChild(el('span', 'list-sub', sub));
        row.appendChild(main);

        row.addEventListener('click', function () {
          goWorkspace('#/library/item/webpage:' + encodeURIComponent(item.id));
        });
        list.appendChild(row);
      });
    }
    body.appendChild(list);
    body.appendChild(moreLink('全部批注 →', '#/library?type=webpage'));
  }

  /* ── 模块类型表：谁能在「＋ 添加模块」里出现 ─────────────── */

  function folderOptions() {
    return noteFolders().map(function (name) {
      return { value: name, label: name };
    });
  }

  function categoryOptions() {
    var seen = {};
    var out = [];
    asArray(state.reminders).forEach(function (item) {
      var name = String(item.category || '').trim();
      if (!name || seen[name]) return;
      seen[name] = true;
      out.push({ value: name, label: name });
    });
    return out.sort(function (a, b) {
      return a.label.localeCompare(b.label);
    });
  }

  function MODULE_TYPES() {
    return {
      notes: {
        label: '笔记',
        icon: '📝',
        desc: '最近编辑的笔记，可按文件夹筛选',
        legacyId: 'notes-list',
        sources: function () {
          return [
            { mode: 'recent', label: '最近更新' },
            { mode: 'folder', label: '指定文件夹', needsValue: true, valueLabel: '文件夹', options: folderOptions() }
          ];
        }
      },
      quicknote: {
        label: '文本框',
        icon: '✍️',
        desc: '随手写，直接存成一条笔记',
        defaultHeight: 232,
        defaultSource: { mode: 'folder', value: '' },
        sources: function () {
          return [
            { mode: 'folder', label: '存到根目录', value: '' },
            { mode: 'folder', label: '存到指定文件夹', needsValue: true, valueLabel: '文件夹', options: folderOptions() }
          ];
        }
      },
      capture: {
        label: '记一笔',
        icon: '📥',
        desc: '先进收件箱，回工作台再整理',
        sources: []
      },
      pinned: {
        label: '常用网站',
        icon: '⭐',
        desc: '点过 ☆ 的网站',
        legacyId: 'pinned-sites',
        sources: []
      },
      sites: {
        label: '全部网站',
        icon: '🌐',
        desc: '按分类成组，卡片套卡片',
        legacyId: 'all-sites',
        defaultHeight: null,
        defaultSource: { mode: 'all' },
        sources: function () {
          return [{ mode: 'all', label: '全部分类' }].concat(
            BUCKETS.map(function (bucket) {
              return { mode: 'bucket', label: '只看「' + bucket + '」', value: bucket };
            })
          );
        }
      },
      checkins: {
        label: '签到网站',
        icon: '✅',
        desc: '每天要打开的签到页，一点就开',
        legacyId: 'checkins-strip',
        sources: []
      },
      reminders: {
        label: '提醒',
        icon: '🔔',
        desc: '按到期时间排的待办',
        legacyId: 'reminders-list',
        sources: function () {
          return [
            { mode: 'all', label: '全部提醒' },
            { mode: 'category', label: '指定分类', needsValue: true, valueLabel: '分类', options: categoryOptions() }
          ];
        }
      },
      annotations: {
        label: '网页批注',
        icon: '🖍️',
        desc: '最近划的词和我的批注',
        legacyId: 'annotations-list',
        sources: function () {
          return [
            { mode: 'all', label: '全部批注' },
            { mode: 'domain', label: '指定网站', needsValue: true, valueLabel: '网站', options: annotationDomains().map(function (host) {
              return { value: host, label: host };
            }) }
          ];
        }
      }
    };
  }

  function renderBody(mod, body, moduleEl) {
    switch (mod.type) {
      case 'notes':
        renderNotesBody(mod, body);
        break;
      case 'quicknote':
        renderQuickNoteBody(mod, body, moduleEl);
        break;
      case 'capture':
        renderCaptureBody(mod, body);
        break;
      case 'pinned':
        renderPinnedBody(mod, body);
        break;
      case 'sites':
        renderSitesBody(mod, body);
        break;
      case 'checkins':
        renderCheckInsBody(mod, body, moduleEl);
        break;
      case 'reminders':
        renderRemindersBody(mod, body);
        break;
      case 'annotations':
        renderAnnotationsBody(mod, body);
        break;
      default:
        body.appendChild(el('div', 'empty', '未知模块：' + mod.type));
    }
  }

  /* ── 搜索：跨所有集合 ───────────────────────────────────── */

  function buildIndex() {
    var items = [];
    var push = function (kind, title, sub, onOpen) {
      items.push({ kind: kind, title: title || '', sub: sub || '', onOpen: onOpen });
    };
    asArray(state.notes).forEach(function (note) {
      push('笔记', note.title, [note.folder, note.content].filter(Boolean).join(' · '), function () {
        goWorkspace('#/library/item/note:' + note.id);
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
        goWorkspace('#/reminders');
      });
    });
    asArray(state.servers).forEach(function (item) {
      push('服务器', item.name, item.publicIp || item.host, function () {
        goWorkspace('#/resources/servers');
      });
    });
    asArray(state.domains).forEach(function (item) {
      push('域名', item.name, item.registrar, function () {
        goWorkspace('#/resources/assets');
      });
    });
    // Secrets: title only. The new tab must never surface a credential value.
    asArray(state.secrets).forEach(function (item) {
      push('凭证', item.title || item.name, '按标题匹配（内容不显示）', function () {
        goWorkspace('#/resources/vault');
      });
    });
    asArray(state.projects).forEach(function (item) {
      push('项目', item.name, item.description, function () {
        goWorkspace('#/projects');
      });
    });
    asArray(state.inbox).forEach(function (item) {
      if (item.status && item.status !== 'inbox') return;
      push('收件箱', item.content, item.url, function () {
        goWorkspace('#/inbox');
      });
    });
    return items;
  }

  /* 搜索是这一页的主操作（newtab.html 自述），所以键盘必须完整：打字 →
     ↑↓ 选择 → Enter 打开。没有这套键位的搜索框，等于让最高频的动作每次
     都伸手去拿鼠标。activeIndex 是 runSearch 闭包内的状态，与渲染同步。 */
  var searchActiveIndex = -1;
  var searchHits = [];

  function highlightActiveResult() {
    var results = document.getElementById('results');
    if (!results) return;
    var rows = results.querySelectorAll('button.result');
    rows.forEach(function (row, i) {
      row.classList.toggle('is-active', i === searchActiveIndex);
      if (i === searchActiveIndex) row.scrollIntoView({ block: 'nearest' });
    });
  }

  function openActiveResult() {
    var hit = searchHits[searchActiveIndex] || searchHits[0];
    if (hit) hit.onOpen();
  }

  function runSearch(query) {
    var results = document.getElementById('results');
    var needle = String(query || '').trim().toLowerCase();
    searchActiveIndex = -1;
    searchHits = [];
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
    searchHits = hits;
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
      row.addEventListener('click', function () {
        // 鼠标点击与 Enter 走同一条路：让悬停态也写回 activeIndex，避免
        // 键盘选择的行和鼠标点击的行各说各话。
        searchActiveIndex = searchHits.indexOf(hit);
        hit.onOpen();
      });
      row.addEventListener('mousemove', function () {
        if (searchActiveIndex !== searchHits.indexOf(hit)) {
          searchActiveIndex = searchHits.indexOf(hit);
          highlightActiveResult();
        }
      });
      results.appendChild(row);
    });
    // 有结果时默认停在第一条：Enter 立刻可用，无需先按方向键。
    searchActiveIndex = 0;
    highlightActiveResult();
  }

  /* ── 启动 ───────────────────────────────────────────────── */

  function wireStaticLinks() {
    var workspace = document.getElementById('open-workspace');
    if (workspace) workspace.setAttribute('href', workspaceUrl('#/home'));

    var search = document.getElementById('search-input');
    if (search) {
      search.addEventListener('input', function () {
        runSearch(search.value);
      });
      search.addEventListener('keydown', function (event) {
        if (event.key === 'Escape') {
          search.value = '';
          runSearch('');
        } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          if (!searchHits.length) return;
          event.preventDefault();
          var delta = event.key === 'ArrowDown' ? 1 : -1;
          searchActiveIndex = (searchActiveIndex + delta + searchHits.length) % searchHits.length;
          highlightActiveResult();
        } else if (event.key === 'Enter') {
          event.preventDefault();
          openActiveResult();
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

  function readPendingNotes() {
    return new Promise(function (resolve) {
      try {
        chrome.storage.local.get([PENDING_NOTES_KEY], function (res) {
          resolve(Array.isArray(res && res[PENDING_NOTES_KEY]) ? res[PENDING_NOTES_KEY] : []);
        });
      } catch (err) {
        resolve([]);
      }
    });
  }

  /** 一次性提示条：讲清楚这一版新增的拖拽交互，点「知道了」之后不再出现。 */
  function wireHint() {
    var hint = document.getElementById('dash-hint');
    var close = document.getElementById('dash-hint-close');
    if (!hint || !close) return;
    try {
      chrome.storage.local.get([HINT_KEY], function (res) {
        if (res && res[HINT_KEY]) return;
        hint.hidden = false;
      });
    } catch (err) {
      hint.hidden = false;
    }
    close.addEventListener('click', function () {
      hint.hidden = true;
      try {
        chrome.storage.local.set({ selfhub_newtab_hint_seen: true });
      } catch (err) {
        /* it will come back next time; harmless */
      }
    });
  }

  function boot() {
    wireStaticLinks();
    wireHint();
    var v2 = readV2();
    var mode = 'local';
    try {
      mode = localStorage.getItem(MODE_KEY) === 'v3' ? 'v3' : 'local';
    } catch (err) {
      mode = 'local';
    }
    var start = function (idb) {
      state = buildState(v2, idb);
      resolveTheme(v2).then(function (theme) {
        applyTheme(theme);
        var toggle = document.getElementById('theme-toggle');
        if (toggle) {
          toggle.addEventListener('click', function () {
            var next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
            applyTheme(next);
            try {
              chrome.storage.local.set({ selfhub_newtab_theme: next });
            } catch (err) {
              /* keep the visual change even if it cannot persist */
            }
          });
        }
      });

      Promise.all([loadPins(), readPendingNotes(), window.SelfHubDashboard.loadLayout()]).then(function (loaded) {
        pins = loaded[0];
        pendingNotes = loaded[1];
        var saveState = document.getElementById('save-state');
        if (saveState) {
          var count = state.notes.length + state.sites.length + state.reminders.length + state.annotations.length;
          saveState.textContent = count ? '本机 · ' + (mode === 'v3' ? 'v3 库' : 'v2 负载') : '还没有数据 · 进工作台开始';
        }

        dashboard = window.SelfHubDashboard.mount({
          root: document.getElementById('dash'),
          layout: loaded[2],
          types: MODULE_TYPES(),
          renderBody: renderBody
        });

        /**
         * 布局和 ☆ 都可能被**工作台**改：恢复备份时它会把备份里的布局写回
         * `chrome.storage.local`。不接住的话，这一页还拿着启动时读到的旧布局，
         * 用户随后随手拖一下就会把恢复出来的布局覆盖掉。
         *
         * 自己写进去的改动也会触发 onChanged，所以先比对一次再决定要不要重画。
         */
        function adoptExternalChange(changes, area) {
          if (area !== 'local') return;
          if (changes.selfhub_newtab_layout) {
            var nextLayout = changes.selfhub_newtab_layout.newValue;
            // adopt() 内部会整页重画（模块可能增删），不需要再 refreshBodies。
            if (nextLayout && JSON.stringify(nextLayout) !== JSON.stringify(dashboard.getLayout())) {
              dashboard.adopt(nextLayout);
            }
          }
          if (changes.selfhub_newtab_pins) {
            var nextPins = changes.selfhub_newtab_pins.newValue;
            var clean = Array.isArray(nextPins)
              ? nextPins.filter(function (id) {
                  return typeof id === 'string';
                })
              : [];
            if (JSON.stringify(clean) !== JSON.stringify(pins)) {
              pins = clean;
              if (dashboard) dashboard.refreshBodies(['pinned']);
            }
          }
        }
        try {
          if (chrome && chrome.storage && chrome.storage.onChanged) {
            chrome.storage.onChanged.addListener(adoptExternalChange);
          }
        } catch (err) {
          /* 没有 storage.onChanged 也不影响使用 */
        }

        var reset = document.getElementById('reset-layout');
        if (reset) {
          reset.addEventListener('click', function () {
            if (!window.confirm('把模块布局恢复成默认的三栏？数据不会动。')) return;
            dashboard.reset();
          });
        }
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
