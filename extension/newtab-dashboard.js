/**
 * 新标签页的模块面板（布局引擎）。
 *
 * 这一页原来是一张写死的三栏：左笔记、中网站、右提醒。用户要的是「每个模块自己
 * 说了算」——能拖大小、能换数据来源、能加能删。所以布局从 HTML 里搬到了数据里：
 *
 *   { v: 1, columns: [{ id, fr }], modules: [{ id, type, column, height, source }] }
 *
 * 设计取舍：
 * - **列宽存 `fr`（比例），不存 px。** 窗口一变宽，三栏按比例一起长，不会出现
 *   一个 1px 的缝或者横向滚动条。拖拽时把 px 增量换算回比例。
 * - **模块高度存 px。** 高度是「我就要这么高」的意图，不该随窗口缩放。
 * - **只有布局变化才重建 DOM。** 数据刷新（比如点了个 ☆）只重画 body，否则每点
 *   一次都会丢焦点、丢滚动位置。
 * - **这一层不碰数据。** 每个模块的内容由 `renderBody(module, bodyEl)` 画，
 *   引擎只负责壳、拖拽和持久化。
 */
(function () {
  'use strict';

  var LAYOUT_KEY = 'selfhub_newtab_layout';
  var MIN_COL_PX = 150;
  var MIN_MODULE_PX = 60;
  var RESIZER_PX = 12;

  var DEFAULT_LAYOUT = {
    v: 1,
    columns: [
      { id: 'c1', fr: 0.92 },
      { id: 'c2', fr: 3.1 },
      { id: 'c3', fr: 0.86 }
    ],
    modules: [
      { id: 'm-notes', type: 'notes', column: 0, height: null, source: { mode: 'recent' } },
      { id: 'm-capture', type: 'capture', column: 1, height: 200, source: { mode: 'inbox' } },
      { id: 'm-pinned', type: 'pinned', column: 1, height: null, source: {} },
      { id: 'm-sites', type: 'sites', column: 1, height: null, source: { mode: 'all' } },
      { id: 'm-checkins', type: 'checkins', column: 1, height: null, source: {} },
      { id: 'm-reminders', type: 'reminders', column: 2, height: null, source: { mode: 'all' } },
      { id: 'm-annotations', type: 'annotations', column: 2, height: null, source: { mode: 'all' } }
    ]
  };

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  /* ── 持久化 ─────────────────────────────────────────────── */

  function normalize(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var columns = Array.isArray(raw.columns) ? raw.columns : [];
    if (columns.length < 1 || columns.length > 7) return null;
    var cleanColumns = [];
    for (var i = 0; i < columns.length; i += 1) {
      var fr = Number(columns[i] && columns[i].fr);
      if (!isFinite(fr) || fr <= 0) return null;
      cleanColumns.push({ id: String(columns[i].id || 'c' + (i + 1)), fr: fr });
    }
    var modules = Array.isArray(raw.modules) ? raw.modules : [];
    var cleanModules = [];
    var seen = {};
    for (var j = 0; j < modules.length; j += 1) {
      var mod = modules[j];
      if (!mod || typeof mod !== 'object') continue;
      if (typeof mod.type !== 'string' || !mod.type) continue;
      var id = String(mod.id || '');
      if (!id || seen[id]) continue;
      seen[id] = true;
      var column = Number(mod.column);
      var width = mod.width;
      if (['quarter', 'third', 'half', 'two-thirds', 'three-quarters', 'full', 'span-full'].indexOf(width) >= 0) {
        // 合法预设档位
      } else if (typeof width === 'string' && /^\d+[%]?$/.test(width)) {
        var num = parseInt(width, 10);
        width = isFinite(num) && num >= 15 && num <= 100 ? num : 'full';
      } else if (isFinite(Number(width)) && Number(width) >= 15 && Number(width) <= 100) {
        width = Math.round(Number(width));
      } else {
        width = 'full';
      }
      var x = Number(mod.x);
      var y = Number(mod.y);
      var w = Number(mod.w);
      var h = Number(mod.h);

      cleanModules.push({
        id: id,
        type: mod.type,
        column: isFinite(column) ? clamp(column, 0, cleanColumns.length - 1) : 0,
        height: isFinite(Number(mod.height)) && Number(mod.height) > 0 ? Math.round(Number(mod.height)) : null,
        width: width,
        x: isFinite(x) && x >= 0 && x <= 11 ? Math.round(x) : null,
        y: isFinite(y) && y >= 0 ? Math.round(y) : null,
        w: isFinite(w) && w >= 1 && w <= 12 ? Math.round(w) : null,
        h: isFinite(h) && h >= 1 && h <= 10 ? Math.round(h) : 1,
        /**
         * `free` = "这张卡是我亲手放到 (x, y) 的"，排版时第一遍就按坐标落位。
         *
         * **必须跟着存盘一起往返。** 这里漏掉它，卡片就只有 x/y 没有"别动我"的标记，
         * 下次开新标签页（或任何一次 normalize）都会退回自动排版 —— 表现就是
         * "拖到下面，一松手 / 一刷新又回到最上面"。横向之所以看着还行，是因为
         * 自动排版仍然认 `explicitSide` 的列，只是把行号归零了。
         */
        free: Boolean(mod.free),
        explicitSide: Boolean(mod.explicitSide),
        source: mod.source && typeof mod.source === 'object' ? mod.source : {}
      });
    }
    return { v: 1, columns: cleanColumns, modules: cleanModules };
  }

  function loadLayout() {
    return new Promise(function (resolve) {
      try {
        chrome.storage.local.get([LAYOUT_KEY], function (res) {
          resolve(normalize(res && res[LAYOUT_KEY]) || clone(DEFAULT_LAYOUT));
        });
      } catch (err) {
        resolve(clone(DEFAULT_LAYOUT));
      }
    });
  }

  /**
   * 键序无关的 JSON：`chrome.storage` 内部用有序字典存对象，读回来的键是**按字母排**的，
   * 和内存里对象的插入顺序对不上。直接 `JSON.stringify` 比两次必然"不相等"，
   * 于是页面会把自己刚写进去的布局当成"外部改的"再采纳一遍（见 isOwnWrite）。
   */
  function stableStringify(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) {
      return '[' + value.map(stableStringify).join(',') + ']';
    }
    var keys = Object.keys(value).sort();
    var parts = [];
    for (var i = 0; i < keys.length; i += 1) {
      var v = value[keys[i]];
      if (v === undefined) continue;
      parts.push(JSON.stringify(keys[i]) + ':' + stableStringify(v));
    }
    return '{' + parts.join(',') + '}';
  }

  /**
   * 本页最近一次写盘（或采纳）的布局快照。
   *
   * 用快照而不是"当前内存里的布局"来判重，是因为 `render()` 里的 `packColumnModules`
   * 会在写盘之后继续微调 x/y/h（把撞位的卡片往下让、给并排卡片补跨行）——
   * 拿内存对象去比，永远比不出"这是我写的"。
   */
  var lastSavedJson = null;

  function saveLayout(layout) {
    try {
      lastSavedJson = stableStringify(layout);
      chrome.storage.local.set({ selfhub_newtab_layout: layout });
    } catch (err) {
      console.warn('[Self-Hub] new tab: cannot persist layout', err);
    }
  }

  /** 这条变更是不是本页自己写下去的回声？ */
  function isOwnWrite(next) {
    return lastSavedJson != null && stableStringify(next) === lastSavedJson;
  }

  /* ── 引擎 ───────────────────────────────────────────────── */

  function mount(options) {
    var root = options.root;
    var types = options.types || {};
    var renderBody = options.renderBody || function () {};
    var layout = options.layout || clone(DEFAULT_LAYOUT);
    var cols = [];
    var pop = null;

    function moduleById(id) {
      for (var i = 0; i < layout.modules.length; i += 1) {
        if (layout.modules[i].id === id) return layout.modules[i];
      }
      return null;
    }

    function specOf(type) {
      return types[type] || { label: type, icon: '▫', desc: '' };
    }

    /* — 帧调度 — */

    /**
     * 拖拽的性能铁律：**一帧只写一次，写之前不读。**
     *
     * 浏览器里 `style.x = ...` 只是标记脏，真正回流发生在你下一次「读布局」的时候
     * （clientWidth / getBoundingClientRect 都算）。所以「写→读→写→读」的循环等于
     * 每一轮都强制同步回流一次，这就是之前拖动像卡住的原因。这里的做法是：
     * 拖动开始时把尺寸量好存起来，过程中只写不读，指针事件合并到 rAF 里。
     */
    function nextFrame(fn) {
      var id = 0;
      return function () {
        if (id) return;
        id = requestAnimationFrame(function () {
          id = 0;
          fn();
        });
      };
    }

    function reducedMotion() {
      try {
        return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      } catch (err) {
        return false;
      }
    }

    /* — 尺寸气泡：拖动时跟着指针显示 px，Grafana 那种手感 — */

    var badgeEl = null;

    function showBadge(text, x, y) {
      if (!badgeEl) {
        badgeEl = el('div', 'drag-badge');
        document.body.appendChild(badgeEl);
      }
      badgeEl.textContent = text;
      badgeEl.hidden = false;
      badgeEl.style.transform = 'translate3d(' + (x + 16) + 'px,' + (y + 18) + 'px,0)';
    }

    function hideBadge() {
      if (badgeEl) badgeEl.hidden = true;
    }

    /* — 列宽 — */

    /**
     * @param avail 可选的容器宽度。拖动过程中必须传进来，否则这里会读
     *   `root.clientWidth`，而上一帧刚写过列宽 —— 又是强制回流。
     */
    function applyWidths(avail) {
      if (!cols.length) return;
      if (window.innerWidth <= 1180) {
        cols.forEach(function (col) {
          col.style.flexBasis = '';
        });
        return;
      }
      var gaps = RESIZER_PX * (cols.length - 1);
      var width = avail == null ? Math.max(320, root.clientWidth - gaps) : avail;
      var sum = layout.columns.reduce(function (acc, column) {
        return acc + column.fr;
      }, 0) || 1;
      for (var i = 0; i < layout.columns.length; i += 1) {
        var px = Math.max(120, Math.round((width * layout.columns[i].fr) / sum));
        cols[i].style.flexBasis = px + 'px';
      }
    }

    function beginColumnDrag(index, event) {
      event.preventDefault();
      var left = cols[index];
      var right = cols[index + 1];
      if (!left || !right) return;

      // 量一次，之后全程不读。
      var gaps = RESIZER_PX * (cols.length - 1);
      var avail = Math.max(320, root.clientWidth - gaps);
      var startX = event.clientX;
      var a = left.getBoundingClientRect().width;
      var b = right.getBoundingClientRect().width;
      var sumPx = a + b;
      var sumFr = layout.columns[index].fr + layout.columns[index + 1].fr;
      var minPx = Math.min(MIN_COL_PX, sumPx / 2);
      var maxPx = sumPx - minPx;
      var nextA = a;
      var point = { x: event.clientX, y: event.clientY };

      document.body.classList.add('is-col-resizing');
      showBadge(Math.round(a) + ' px', point.x, point.y);

      var apply = nextFrame(function () {
        var w = Math.round(clamp(nextA, minPx, maxPx));
        left.style.flexBasis = w + 'px';
        right.style.flexBasis = sumPx - w + 'px';
        layout.columns[index].fr = (sumFr * w) / sumPx;
        layout.columns[index + 1].fr = (sumFr * (sumPx - w)) / sumPx;
        showBadge(w + ' px', point.x, point.y);
      });

      function onMove(moveEvent) {
        point = { x: moveEvent.clientX, y: moveEvent.clientY };
        nextA = a + (moveEvent.clientX - startX);
        apply();
      }
      function onUp() {
        document.body.classList.remove('is-col-resizing');
        hideBadge();
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
        applyWidths(avail);
        saveLayout(layout);
      }
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    }

    /* — 模块高度 — */

    function applyHeight(moduleEl, mod) {
      if (mod.height) {
        moduleEl.style.height = mod.height + 'px';
        moduleEl.style.minHeight = mod.height + 'px';
        moduleEl.classList.add('has-fixed-height');
      } else {
        moduleEl.style.height = '';
        moduleEl.style.minHeight = '';
        moduleEl.classList.remove('has-fixed-height');
      }
    }

    function widthToCols(width) {
      if (width === 'quarter') return 3;
      if (width === 'third') return 4;
      if (width === 'half') return 6;
      if (width === 'two-thirds') return 8;
      if (width === 'three-quarters') return 9;
      if (width === 'full') return 12;
      if (typeof width === 'number' || (isFinite(Number(width)) && Number(width) > 0)) {
        return clamp(Math.round((Number(width) / 100) * 12), 2, 12);
      }
      return 12;
    }

    function applyGridPos(moduleEl, mod) {
      var w = mod.w != null ? mod.w : widthToCols(mod.width);
      var x = mod.x;
      if (x != null && w != null && w < 12) {
        moduleEl.style.gridColumn = (x + 1) + ' / span ' + w;
      } else if (w === 6 && x === 6) {
        moduleEl.style.gridColumn = '7 / span 6';
      } else if (w === 6) {
        moduleEl.style.gridColumn = '1 / span 6';
      } else if (w != null && w < 12) {
        moduleEl.style.gridColumn = 'span ' + w;
      } else {
        moduleEl.style.gridColumn = '1 / -1';
      }
      if (w < 12 && mod.y != null) {
        var spanH = mod.h && mod.h > 1 ? mod.h : 1;
        moduleEl.style.gridRow = (mod.y + 1) + ' / span ' + spanH;
      } else if (mod.h != null && mod.h > 1) {
        moduleEl.style.gridRow = 'span ' + mod.h;
      } else {
        moduleEl.style.gridRow = '';
      }
    }

    function packColumnModules(mods) {
      // 占用矩阵 grid[row][col]，按 12 栏跟踪哪一格被占用（Grafana 级 2D 紧凑排版）
      var grid = [];
      function isOccupied(r, c) {
        return Boolean(grid[r] && grid[r][c]);
      }
      function markOccupied(r, c, w, h) {
        for (var row = r; row < r + h; row += 1) {
          if (!grid[row]) grid[row] = [];
          for (var col = c; col < c + w; col += 1) {
            grid[row][col] = true;
          }
        }
      }
      function canPlace(r, c, w, h) {
        for (var row = r; row < r + h; row += 1) {
          for (var col = c; col < c + w; col += 1) {
            if (isOccupied(row, col)) return false;
          }
        }
        return true;
      }

      /**
       * 第一遍：**用户亲手放下的卡片先落位**，位置就是它被放下的地方。
       *
       * 旧版一律按"从左上角找第一个能塞下的空"重排，所以哪怕拖到指定位置，
       * 一松手也会被重新排到别处 —— 拖到哪都"不算数"，观感就是完全不自由。
       * 现在带 `free` 标记的卡片按 (x, y) 直接落，被占就往下让一行（宁可挪一点，
       * 也不甩到别的地方）。剩下的卡片再按老规则填空，这样既自由又不会互相盖住。
       */
      var pending = [];
      mods.forEach(function (m) {
        var w = widthToCols(m.width);
        m.w = w;
        var h = m.h && m.h > 1 ? m.h : 1;
        m.h = h;
        if (!m.free || m.x == null || m.y == null) {
          pending.push(m);
          return;
        }
        var fx = m.w >= 12 ? 0 : clamp(Math.round(m.x), 0, 12 - m.w);
        var fy = Math.max(0, Math.round(m.y));
        while (fy < 400 && !canPlace(fy, fx, m.w, h)) fy += 1;
        m.x = fx;
        m.y = fy;
        markOccupied(fy, fx, m.w, h);
      });

      // 第二遍：没被亲手放过的卡片从顶部找第一个能放下的位置
      pending.forEach(function (m) {
        if (m.w >= 12) {
          // 整栏单卡片：寻找第一个完全空闲的整行
          var r = 0;
          while (r < 400 && !canPlace(r, 0, 12, m.h)) r += 1;
          m.x = 0;
          m.y = r;
          markOccupied(r, 0, 12, m.h);
          return;
        }

        // 分栏卡片（半栏、1/3、1/4 等）：
        // 如果卡片有显式指定的列（如通过拖拽指定的 x: 6），优先尝试放在指定列
        var targetCol = (m.explicitSide && m.x != null && m.x + m.w <= 12) ? m.x : null;
        var placed = false;
        for (var r2 = 0; r2 < 400 && !placed; r2 += 1) {
          if (targetCol != null) {
            if (canPlace(r2, targetCol, m.w, m.h)) {
              m.x = targetCol;
              m.y = r2;
              markOccupied(r2, targetCol, m.w, m.h);
              placed = true;
            }
            // 显式指定列时，本行放不下继续看下一行，不滑到其它列
            continue;
          }

          // 否则从左向右寻找第一个能容纳当前卡片 w * h 的空闲区间
          var step = (m.w === 3 ? 3 : (m.w === 4 ? 4 : (m.w === 6 ? 6 : 1)));
          for (var c = 0; c <= 12 - m.w; c += step) {
            if (canPlace(r2, c, m.w, m.h)) {
              m.x = c;
              m.y = r2;
              markOccupied(r2, c, m.w, m.h);
              placed = true;
              break;
            }
          }
        }
      });

      // 第二阶段：2D 纵向自适应跨行（Grafana 级并排卡片高度补齐）
      // 当一侧为单张卡片，而相邻另一侧上下堆叠了多张卡片时，单张卡片自动 span 覆盖相应行数（无限制多行 1 对多）
      mods.forEach(function (m) {
        if (m.w < 12) {
          var sideCol = m.x === 0 ? 6 : (m.x === 6 ? 0 : -1);
          if (sideCol >= 0) {
            var stacked = mods.filter(function (other) {
              return other !== m && other.x === sideCol && other.y >= m.y;
            });
            if (stacked.length >= 2) {
              var count = stacked.length;
              var targetSpan = Math.max(m.h || 1, count);
              var canSpan = true;
              for (var row = m.y + 1; row < m.y + targetSpan; row += 1) {
                if (isOccupied(row, m.x)) { canSpan = false; break; }
              }
              if (canSpan) {
                m.h = targetSpan;
                for (var r = m.y + 1; r < m.y + targetSpan; r += 1) {
                  markOccupied(r, m.x, m.w, 1);
                }
              }
            }
          }
        }
      });
    }

    function applyWidth(moduleEl, mod) {
      moduleEl.classList.remove(
        'is-quarter-width',
        'is-third-width',
        'is-half-width',
        'is-two-thirds-width',
        'is-three-quarters-width',
        'is-span-full',
        'is-custom-width'
      );
      moduleEl.style.flex = '';
      moduleEl.style.width = '';
      if (mod.width === 'quarter') {
        moduleEl.classList.add('is-quarter-width');
      } else if (mod.width === 'third') {
        moduleEl.classList.add('is-third-width');
      } else if (mod.width === 'half') {
        moduleEl.classList.add('is-half-width');
      } else if (mod.width === 'two-thirds') {
        moduleEl.classList.add('is-two-thirds-width');
      } else if (mod.width === 'three-quarters') {
        moduleEl.classList.add('is-three-quarters-width');
      } else if (mod.width === 'span-full') {
        moduleEl.classList.add('is-span-full');
      } else if (typeof mod.width === 'number' || (isFinite(Number(mod.width)) && Number(mod.width) > 0)) {
        var pct = clamp(Math.round(Number(mod.width)), 15, 100);
        moduleEl.classList.add('is-custom-width');
        moduleEl.style.setProperty('--custom-pct', pct + '%');
        if (pct >= 48 && pct <= 52) moduleEl.classList.add('is-half-width');
        else if (pct >= 23 && pct <= 27) moduleEl.classList.add('is-quarter-width');
        else if (pct >= 31 && pct <= 35) moduleEl.classList.add('is-third-width');
        else if (pct >= 65 && pct <= 69) moduleEl.classList.add('is-two-thirds-width');
        else if (pct >= 73 && pct <= 77) moduleEl.classList.add('is-three-quarters-width');
      }
      applyGridPos(moduleEl, mod);
    }

    function labelOfWidth(wState, px, hPx) {
      var wStr = '整栏 (100%)';
      if (wState === 'quarter') wStr = '1/4 (25%)';
      else if (wState === 'third') wStr = '1/3 (33%)';
      else if (wState === 'half') wStr = '半栏 (50%)';
      else if (wState === 'two-thirds') wStr = '2/3 (67%)';
      else if (wState === 'three-quarters') wStr = '3/4 (75%)';
      else if (wState === 'span-full') wStr = '全宽通栏';
      else if (typeof wState === 'number' || isFinite(Number(wState))) {
        var pNum = Math.round(Number(wState));
        if (pNum === 50) wStr = '半栏 (50%)';
        else if (pNum === 25) wStr = '1/4 (25%)';
        else if (pNum === 33) wStr = '1/3 (33%)';
        else if (pNum === 67) wStr = '2/3 (67%)';
        else if (pNum === 75) wStr = '3/4 (75%)';
        else wStr = pNum + '%';
      }
      var pxStr = Math.round(px) + ' px';
      if (hPx != null) pxStr += ' × ' + Math.round(hPx) + ' px';
      return wStr + ' · ' + pxStr;
    }

    function resolveSnapWidth(nextW, colW, isAltOrShift) {
      if (nextW > colW * 1.15 && layout.columns.length > 1) {
        return 'span-full';
      }
      var pct = clamp(Math.round((nextW / colW) * 100), 15, 100);
      if (pct >= 90) return 'full';
      if (!isAltOrShift) {
        if (pct >= 72 && pct <= 80) return 'three-quarters';
        if (pct >= 63 && pct <= 71) return 'two-thirds';
        if (pct >= 44 && pct <= 60) return 'half';
        if (pct >= 29 && pct <= 38) return 'third';
        if (pct >= 21 && pct <= 28) return 'quarter';
      } else {
        if (pct >= 48 && pct <= 52) return 'half';
        if (pct >= 23 && pct <= 27) return 'quarter';
        if (pct >= 31 && pct <= 35) return 'third';
        if (pct >= 65 && pct <= 69) return 'two-thirds';
        if (pct >= 73 && pct <= 77) return 'three-quarters';
      }
      return pct;
    }

    function beginHeightDrag(moduleEl, mod, event) {
      event.preventDefault();
      var startY = event.clientY;
      var startH = moduleEl.getBoundingClientRect().height;
      var nextH = startH;
      var moved = false;
      var point = { x: event.clientX, y: event.clientY };

      document.body.classList.add('is-module-resizing');
      moduleEl.classList.add('is-live-resizing');
      showBadge(Math.round(startH) + ' px', point.x, point.y);

      var apply = nextFrame(function () {
        mod.height = Math.max(MIN_MODULE_PX, Math.round(nextH));
        applyHeight(moduleEl, mod);
        showBadge(mod.height + ' px', point.x, point.y);
      });

      function onMove(moveEvent) {
        var dy = moveEvent.clientY - startY;
        point = { x: moveEvent.clientX, y: moveEvent.clientY };
        if (!moved && Math.abs(dy) < 3) return;
        moved = true;
        nextH = startH + dy;
        apply();
      }
      function onUp() {
        document.body.classList.remove('is-module-resizing');
        moduleEl.classList.remove('is-live-resizing');
        hideBadge();
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
        if (moved) saveLayout(layout);
      }
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    }

    /* — 模块宽度（水平拖拽与角拖拽，Grafana 手感） — */

    function beginWidthDrag(moduleEl, mod, event) {
      event.preventDefault();
      var startX = event.clientX;
      var colEl = moduleEl.closest('.dash-col');
      var colW = colEl ? colEl.clientWidth : Math.max(320, root.clientWidth);
      var startW = moduleEl.getBoundingClientRect().width;
      var moved = false;
      var nextW = startW;
      var targetWidth = mod.width || 'full';
      var point = { x: event.clientX, y: event.clientY };
      var isAltOrShift = event.altKey || event.shiftKey;

      document.body.classList.add('is-module-resizing-x');
      moduleEl.classList.add('is-live-resizing');

      showBadge(labelOfWidth(targetWidth, startW), point.x, point.y);

      var apply = nextFrame(function () {
        var wClamped = Math.max(80, Math.round(nextW));
        moduleEl.style.width = wClamped + 'px';
        moduleEl.style.flexBasis = wClamped + 'px';

        targetWidth = resolveSnapWidth(nextW, colW, isAltOrShift);
        var snapCols = widthToCols(targetWidth);
        if (targetWidth === 'span-full') {
          moduleEl.style.gridColumn = '1 / -1';
        } else if (snapCols < 12) {
          moduleEl.style.gridColumn = (mod.x != null && mod.x + snapCols <= 12 ? (mod.x + 1) + ' / span ' : '1 / span ') + snapCols;
        } else {
          moduleEl.style.gridColumn = '1 / -1';
        }
        showBadge(labelOfWidth(targetWidth, nextW), point.x, point.y);
      });

      function onMove(moveEvent) {
        var dx = moveEvent.clientX - startX;
        point = { x: moveEvent.clientX, y: moveEvent.clientY };
        isAltOrShift = moveEvent.altKey || moveEvent.shiftKey;
        if (!moved && Math.abs(dx) < 3) return;
        moved = true;
        nextW = Math.max(80, startW + dx);
        apply();
      }

      function onUp() {
        document.body.classList.remove('is-module-resizing-x');
        moduleEl.classList.remove('is-live-resizing');
        hideBadge();
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
        moduleEl.style.width = '';
        moduleEl.style.flexBasis = '';
        if (moved) {
          targetWidth = resolveSnapWidth(nextW, colW, isAltOrShift);
          mod.width = targetWidth;
          mod.w = widthToCols(targetWidth);
          if (mod.w >= 12) {
            mod.x = 0;
            mod.explicitSide = false;
          } else if (mod.x != null && mod.x + mod.w > 12) {
            mod.x = 12 - mod.w;
          }
          saveLayout(layout);
          if (targetWidth === 'span-full' || moduleEl.classList.contains('is-span-full')) {
            render();
          } else if (colEl) {
            var colMods = layout.modules.filter(function (m) {
              return m.column === Number(colEl.getAttribute('data-col')) && m.width !== 'span-full';
            });
            packColumnModules(colMods);
            colMods.forEach(function (m) {
              var mEl = colEl.querySelector('[data-module-id="' + m.id + '"]');
              if (mEl) {
                applyWidth(mEl, m);
              }
            });
          } else {
            render();
          }
        }
      }

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    }

    function beginCornerDrag(moduleEl, mod, event) {
      event.preventDefault();
      var startX = event.clientX;
      var startY = event.clientY;
      var colEl = moduleEl.closest('.dash-col');
      var colW = colEl ? colEl.clientWidth : Math.max(320, root.clientWidth);
      var startW = moduleEl.getBoundingClientRect().width;
      var startH = moduleEl.getBoundingClientRect().height;
      var moved = false;
      var nextW = startW;
      var nextH = startH;
      var targetWidth = mod.width || 'full';
      var point = { x: event.clientX, y: event.clientY };
      var isAltOrShift = event.altKey || event.shiftKey;

      document.body.classList.add('is-module-resizing-xy');
      moduleEl.classList.add('is-live-resizing');

      showBadge(labelOfWidth(targetWidth, startW, startH), point.x, point.y);

      var apply = nextFrame(function () {
        var wClamped = Math.max(80, Math.round(nextW));
        moduleEl.style.width = wClamped + 'px';
        moduleEl.style.flexBasis = wClamped + 'px';

        targetWidth = resolveSnapWidth(nextW, colW, isAltOrShift);
        var snapCols = widthToCols(targetWidth);
        if (targetWidth === 'span-full') {
          moduleEl.style.gridColumn = '1 / -1';
        } else if (snapCols < 12) {
          moduleEl.style.gridColumn = (mod.x != null && mod.x + snapCols <= 12 ? (mod.x + 1) + ' / span ' : '1 / span ') + snapCols;
        } else {
          moduleEl.style.gridColumn = '1 / -1';
        }
        mod.height = Math.max(MIN_MODULE_PX, Math.round(nextH));
        applyHeight(moduleEl, mod);
        showBadge(labelOfWidth(targetWidth, nextW, mod.height), point.x, point.y);
      });

      function onMove(moveEvent) {
        var dx = moveEvent.clientX - startX;
        var dy = moveEvent.clientY - startY;
        point = { x: moveEvent.clientX, y: moveEvent.clientY };
        isAltOrShift = moveEvent.altKey || moveEvent.shiftKey;
        if (!moved && Math.hypot(dx, dy) < 3) return;
        moved = true;
        nextW = Math.max(80, startW + dx);
        nextH = startH + dy;
        apply();
      }

      function onUp() {
        document.body.classList.remove('is-module-resizing-xy');
        moduleEl.classList.remove('is-live-resizing');
        hideBadge();
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
        moduleEl.style.width = '';
        moduleEl.style.flexBasis = '';
        if (moved) {
          targetWidth = resolveSnapWidth(nextW, colW, isAltOrShift);
          if (targetWidth !== mod.width) {
            mod.width = targetWidth;
            mod.w = widthToCols(targetWidth);
            if (mod.w >= 12) {
              mod.x = 0;
              mod.explicitSide = false;
            } else if (mod.x != null && mod.x + mod.w > 12) {
              mod.x = 12 - mod.w;
            }
          }
          saveLayout(layout);
          if (targetWidth === 'span-full' || moduleEl.classList.contains('is-span-full')) {
            render();
          } else if (colEl) {
            var colMods = layout.modules.filter(function (m) {
              return m.column === Number(colEl.getAttribute('data-col')) && m.width !== 'span-full';
            });
            packColumnModules(colMods);
            colMods.forEach(function (m) {
              var mEl = colEl.querySelector('[data-module-id="' + m.id + '"]');
              if (mEl) {
                applyWidth(mEl, m);
              }
            });
          } else {
            render();
          }
        }
      }

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    }

    /* — 拖拽排序 — */

    /**
     * Grafana 那种手感由三件事凑成，缺一件就像"网页在硬撑"：
     *
     * 1. **跟手的幽灵卡片**：克隆一个只有标题的轻卡片，`position: fixed` +
     *    `transform` 跟着指针走。transform 走合成层，不触发回流，所以是 60/120fps。
     * 2. **目标位置的虚线槽**：鼠标划过的地方插一个和卡片差不多高的空槽，其它卡片
     *    被挤开 —— 这就是"我要放这里"的预览。
     * 3. **被挤开的卡片用 FLIP 滑过去**：先量旧位置，改完 DOM 再量新位置，用反向
     *    transform 起手再动画到 0。不这样做，卡片是瞬间跳一格，看着就是"卡"。
     *
     * 原来那版用的是 `dropLine` 一条 2px 线：每个 dragover（每秒上百次）都无条件
     * `insertBefore` 一次，等于每帧都在改 DOM + 强制回流。现在只在目标位置真的变了
     * 的时候才动，而且指针事件合并到 rAF。
     */
    var drag = null;
    var hoverPoint = null;

    /** 位移超过这个距离才算"拖"，否则当成点了一下标题栏（px）。 */
    var DRAG_THRESHOLD = 3;
    /** 从卡片身体起手的阈值放宽一点：身体上的误触比标题栏多，宁可迟疑半拍。 */
    var BODY_DRAG_THRESHOLD = 6;

    function withFlip(nodes, mutate) {
      if (reducedMotion() || !nodes.length) {
        mutate();
        return;
      }
      var before = nodes.map(function (node) {
        var r = node.getBoundingClientRect();
        return { left: r.left, top: r.top };
      });
      mutate();
      for (var i = 0; i < nodes.length; i += 1) {
        var r = nodes[i].getBoundingClientRect();
        var dx = before[i].left - r.left;
        var dy = before[i].top - r.top;
        if (!dx && !dy) continue;
        // 快速拖动时同一个卡片会在一秒内被重新定位好几次。不掐掉上一段动画，
        // 两段 transform 会同时跑，卡片就"抖"起来了 —— 这是"卡"的观感来源之一。
        var running = nodes[i].getAnimations();
        for (var j = 0; j < running.length; j += 1) running[j].cancel();
        nodes[i].animate(
          [
            { transform: 'translate3d(' + dx + 'px,' + dy + 'px,0)' },
            { transform: 'translate3d(0,0,0)' }
          ],
          { duration: 150, easing: 'cubic-bezier(0.2, 0, 0, 1)' }
        );
      }
    }

    function makeGhost(mod, rect) {
      var spec = specOf(mod.type);
      var ghost = el('div', 'drag-ghost');
      // 和真实卡片同宽同高：抓取点锚定的前提是"影子轮廓 = 卡片轮廓"，
      // 否则"按住卡片的哪个点"和"影子上被按住的点"对不上，影子还是漂的。
      ghost.style.width = Math.round(rect.width) + 'px';
      ghost.style.height = Math.round(rect.height) + 'px';
      // 视觉外壳单独包一层：外层只写 transform 跟指针（每帧都写，合成层），
      // 一次性的"抓起来"入场动画跑在内层，两段 transform 互不覆盖。
      var inner = el('div', 'drag-ghost-inner');
      var head = el('div', 'module-head');
      head.appendChild(el('span', 'module-grip', '⠿'));
      head.appendChild(el('span', 'module-icon', spec.icon || '▫'));
      head.appendChild(el('span', 'module-title', spec.label));
      inner.appendChild(head);
      // 身体不克隆内容 DOM，只留一个虚线占位：轻，但轮廓是真的。
      inner.appendChild(el('div', 'drag-ghost-body'));
      ghost.appendChild(inner);
      document.body.appendChild(ghost);
      return ghost;
    }

    /**
     * Move the ghost. **No rAF throttle here on purpose.**
     *
     * `transform` is a compositor property: writing it never invalidates layout or paint, and
     * several writes inside one frame collapse to the last value. Throttling it through rAF
     * therefore buys nothing and costs up to a full frame of lag — which is exactly what makes
     * a dragged card feel like it is chasing the cursor instead of sitting under it.
     */
    function followGhost(x, y) {
      if (!drag || !drag.ghost) return;
      // 抓取点锚定：按住卡片的哪个点，指针就钉在影子的哪个点上。
      // 之前固定 +14/+12 的偏移让"看到的影子"和"判定落点用的指针"是两个位置，
      // 影子明明悬在槽的右边，松手却落进槽里 —— 落点全靠猜。
      drag.ghost.style.transform = 'translate3d(' + (x - drag.offX) + 'px,' + (y - drag.offY) + 'px,0)';
    }

    function measureColumn(colEl) {
      return Array.prototype.slice.call(colEl.querySelectorAll('.module')).map(function (node) {
        var rect = node.getBoundingClientRect();
        var id = node.getAttribute('data-module-id');
        return {
          el: node,
          id: id,
          mod: moduleById(id),
          mid: rect.top + rect.height / 2,
          top: rect.top,
          bottom: rect.bottom,
          left: rect.left,
          right: rect.right,
          width: rect.width,
          height: rect.height,
          midX: rect.left + rect.width / 2
        };
      });
    }

    /**
     * 「拖到哪就停在哪」：窄卡片（< 12 栏）的落点直接由指针算。
     *
     * 旧版无论拖到哪，x 只可能是 0 或 6（左半 / 右半），所以想把一张卡放在
     * "偏左三分之一"或者"紧贴着某张卡右边"根本做不到 —— 一松手就被吸走。
     *
     * - x：指针在 12 栏里的位置，减去卡片半宽（指针代表卡片中心），夹到 [0, 12-w]
     * - y：指针压在谁身上就落在谁那一行；压在上半截插到它前面，下半截插到它后面
     */
    function freeSpot(x, y, colRect, list, w) {
      var frac = clamp((x - colRect.left) / Math.max(1, colRect.width), 0, 1);
      var gx = clamp(Math.round(frac * 12 - w / 2), 0, 12 - w);
      var byTop = list.slice().sort(function (a, b) {
        return a.top - b.top;
      });
      var gy = null;
      for (var i = 0; i < byTop.length; i += 1) {
        var it = byTop[i];
        var baseY = it.mod && it.mod.y != null ? it.mod.y : i;
        var span = Math.max(1, (it.mod && it.mod.h) || 1);
        if (y <= it.bottom) {
          gy = y < it.mid ? baseY : baseY + span;
          break;
        }
        gy = baseY + span;
      }
      return { x: gx, y: gy };
    }

    function computeTarget(x, y, fallback) {
      var target = computeTargetHeuristic(x, y, fallback);
      if (!target || !drag) return target;
      var draggedW = drag.mod.w != null ? drag.mod.w : widthToCols(drag.mod.width);
      // 整栏卡片保持老规则（拖到别人侧边就劈成两半），窄卡片才走自由落点。
      if (draggedW >= 12) return target;
      var cache = drag.rects && drag.rects.col === target.colEl ? drag.rects : null;
      var colRect = (cache && cache.rect) || target.colEl.getBoundingClientRect();
      var list = (cache && cache.list) || measureColumn(target.colEl);
      var spot = freeSpot(x, y, colRect, list, draggedW);
      target.x = spot.x;
      target.w = draggedW;
      if (spot.y != null) target.y = spot.y;
      return target;
    }

    function computeTargetHeuristic(x, y, fallback) {
      // 优先用事件里的 target（浏览器已经做过命中测试，不用重复算）；
      // 只有当它不是栏的后代时才按坐标补一次 —— 比如拖到两栏之间的分隔条、
      // 栏的 padding 上。幽灵卡片是 pointer-events:none，不会被命中。
      var colEl = fallback && fallback.closest ? fallback.closest('.dash-col') : null;
      if (!colEl) {
        var node = null;
        try {
          node = document.elementFromPoint(x, y);
        } catch (err) {
          node = null;
        }
        colEl = node && node.closest ? node.closest('.dash-col') : null;
      }
      if (!colEl && cols.length) {
        // 指针落在栏间缝隙 / 分隔条 / 面板两侧空白时，按"离哪栏最近归哪栏"。
        // 旧版是"第一条右边缘 +12px 覆盖到的栏"，拖到最右栏右侧的空白会兜底回
        // 第一栏 —— 明明贴着右栏放手，卡片却飞去了左边，跨栏经常"没反应"的根源。
        var bestDist = Infinity;
        for (var c = 0; c < cols.length; c += 1) {
          var r = cols[c].getBoundingClientRect();
          var dist = x < r.left ? r.left - x : x > r.right ? x - r.right : 0;
          if (dist < bestDist) {
            bestDist = dist;
            colEl = cols[c];
          }
        }
      }
      if (!colEl) return null;
      var column = Number(colEl.getAttribute('data-col'));
      if (!isFinite(column)) return null;
      // 同一栏连续划过时复用上次量好的中线，避免每个事件都读一遍布局。
      if (!drag.rects || drag.rects.col !== colEl) {
        drag.rects = { col: colEl, list: measureColumn(colEl), rect: colEl.getBoundingClientRect() };
      }
      var list = drag.rects.list;
      var colRect = colEl.getBoundingClientRect();

      var relX = clamp(x - colRect.left, 0, colRect.width);
      var fracX = relX / Math.max(1, colRect.width);

      // 排除当前正在拖拽的卡片自身
      var candidates = list.filter(function (it) { return it.el !== drag.el; });

      if (candidates.length === 0) {
        return {
          colEl: colEl,
          column: column,
          before: null,
          position: 0,
          x: 0,
          w: 12,
          splitPartner: null,
          splitSide: null
        };
      }

      // 1. 直接命中测试：光标当前是否直接落在某张卡片的有效矩形边界内
      var directHit = null;
      for (var i = 0; i < candidates.length; i += 1) {
        var it = candidates[i];
        if (x >= it.left - 6 && x <= it.right + 6 && y >= it.top && y <= it.bottom) {
          directHit = it;
          break;
        }
      }

      if (directHit) {
        var hitCard = directHit;
        var hitMod = hitCard.mod;
        var hitW = hitMod && hitMod.w != null ? hitMod.w : (hitMod ? widthToCols(hitMod.width) : 12);
        var hitX = hitMod && hitMod.x != null ? hitMod.x : (hitMod && hitMod.explicitSide && hitW === 6 ? 6 : 0);
        var isDraggedFull = (!drag.mod.width || drag.mod.width === 'full') && (!drag.mod.w || drag.mod.w >= 12);
        var edgeZone = Math.max(32, Math.min(68, hitCard.height * 0.28));

        // 顶边缘：上方插入
        if (y < hitCard.top + edgeZone) {
          var useFullRowTop = isDraggedFull && (fracX >= 0.30 && fracX <= 0.70);
          return {
            colEl: colEl,
            column: column,
            before: hitCard.el,
            position: candidates.indexOf(hitCard),
            x: useFullRowTop ? 0 : (hitW === 6 ? hitX : 0),
            w: useFullRowTop ? 12 : (hitW === 6 ? 6 : 12),
            splitPartner: null,
            splitSide: null
          };
        }

        // 底边缘：下方插入
        if (y > hitCard.bottom - edgeZone) {
          var useFullRowBottom = isDraggedFull && (fracX >= 0.30 && fracX <= 0.70);
          return {
            colEl: colEl,
            column: column,
            before: hitCard.el.nextElementSibling,
            position: candidates.indexOf(hitCard) + 1,
            x: useFullRowBottom ? 0 : (hitW === 6 ? hitX : 0),
            w: useFullRowBottom ? 12 : (hitW === 6 ? 6 : 12),
            splitPartner: null,
            splitSide: null
          };
        }

        // 整栏卡片压到窄卡片身上：跟它并排、宽度也跟它一样。
        // 「我想把这两个并一起」最常见的就是这个动作，旧版会把它铺成整行盖在下面。
        if (hitW < 12 && isDraggedFull) {
          var besideX = x < hitCard.midX ? hitX - hitW : hitX + hitW;
          if (besideX < 0) besideX = hitX + hitW;
          if (besideX + hitW > 12) besideX = hitX - hitW;
          return {
            colEl: colEl,
            column: column,
            before: null,
            position: candidates.indexOf(hitCard),
            x: clamp(besideX, 0, 12 - hitW),
            y: hitMod && hitMod.y != null ? hitMod.y : null,
            w: hitW,
            h: (hitMod && hitMod.h) || 1,
            splitPartner: null,
            splitSide: null
          };
        }

        // 卡片主体区域：
        if (hitW === 6) {
          // 当前命中的已经是半栏卡片，在同侧内根据中线上下堆叠
          if (y < hitCard.mid) {
            return {
              colEl: colEl,
              column: column,
              before: hitCard.el,
              position: candidates.indexOf(hitCard),
              x: hitX,
              w: 6,
              splitPartner: null,
              splitSide: null
            };
          } else {
            return {
              colEl: colEl,
              column: column,
              before: hitCard.el.nextElementSibling,
              position: candidates.indexOf(hitCard) + 1,
              x: hitX,
              w: 6,
              splitPartner: null,
              splitSide: null
            };
          }
        }

        // hitW >= 12（当前卡片是全宽卡片）：
        // 只有在光标明显偏向左边缘或右边缘时才触发拆分，中间宽裕区域自由上下纵向放置
        if (fracX > 0.68) {
          return {
            colEl: colEl,
            column: column,
            before: hitCard.el.nextElementSibling,
            position: candidates.indexOf(hitCard) + 1,
            x: 6,
            w: 6,
            splitPartner: hitCard,
            splitSide: 'right'
          };
        } else if (fracX < 0.32) {
          return {
            colEl: colEl,
            column: column,
            before: hitCard.el,
            position: candidates.indexOf(hitCard),
            x: 0,
            w: 6,
            splitPartner: hitCard,
            splitSide: 'left'
          };
        } else {
          // 中间区域：根据中线上下整行插入
          if (y < hitCard.mid) {
            return {
              colEl: colEl,
              column: column,
              before: hitCard.el,
              position: candidates.indexOf(hitCard),
              x: 0,
              w: 12,
              splitPartner: null,
              splitSide: null
            };
          } else {
            return {
              colEl: colEl,
              column: column,
              before: hitCard.el.nextElementSibling,
              position: candidates.indexOf(hitCard) + 1,
              x: 0,
              w: 12,
              splitPartner: null,
              splitSide: null
            };
          }
        }
      }

      // 2. 空白区域命中（光标落在卡片之间的空隙、单侧空白区域或边缘）：
      var isRightSide = fracX >= 0.50;
      var targetSideX = isRightSide ? 6 : 0;

      // 寻找同侧分栏卡片与对侧分栏卡片
      var sameSideCards = candidates.filter(function (it) {
        var itX = it.mod && it.mod.x != null ? it.mod.x : (it.mod && it.mod.explicitSide ? 6 : 0);
        var itW = it.mod && it.mod.w != null ? it.mod.w : widthToCols(it.mod && it.mod.width);
        if (itW >= 12) return false;
        return isRightSide ? (itX >= 4 || it.midX >= colRect.left + colRect.width * 0.48) : (itX < 6 || it.midX < colRect.left + colRect.width * 0.52);
      });

      var oppositeCards = candidates.filter(function (it) {
        var itX = it.mod && it.mod.x != null ? it.mod.x : (it.mod && it.mod.explicitSide ? 6 : 0);
        var itW = it.mod && it.mod.w != null ? it.mod.w : widthToCols(it.mod && it.mod.width);
        if (itW >= 12) return false;
        return isRightSide ? (itX < 6 || it.midX < colRect.left + colRect.width * 0.52) : (itX >= 4 || it.midX >= colRect.left + colRect.width * 0.48);
      });

      // 检查光标是否处于对侧卡片所在高度区间内的同侧空白区（消灭侧边死区）
      var oppositeNeighbor = null;
      for (var op = 0; op < oppositeCards.length; op += 1) {
        if (y >= oppositeCards[op].top - 10 && y <= oppositeCards[op].bottom + 10) {
          oppositeNeighbor = oppositeCards[op];
          break;
        }
      }

      if (oppositeNeighbor) {
        var sameSideBlocking = sameSideCards.filter(function (it) {
          return y >= it.top && y <= it.bottom;
        });
        if (sameSideBlocking.length === 0) {
          var aboveCards = sameSideCards.filter(function (it) {
            return it.bottom <= y + 10;
          });
          var aboveCard = aboveCards.length > 0 ? aboveCards[aboveCards.length - 1] : null;
          var targetY = aboveCard && aboveCard.mod && aboveCard.mod.y != null ? aboveCard.mod.y + 1 : (oppositeNeighbor.mod && oppositeNeighbor.mod.y != null ? oppositeNeighbor.mod.y : 1);
          var beforeEl = aboveCard ? aboveCard.el.nextElementSibling : oppositeNeighbor.el;
          var pos = aboveCard ? candidates.indexOf(aboveCard) + 1 : candidates.indexOf(oppositeNeighbor);
          return {
            colEl: colEl,
            column: column,
            before: beforeEl,
            position: pos,
            x: targetSideX,
            y: targetY,
            w: 6,
            h: 1,
            oppositeNeighbor: oppositeNeighbor,
            splitPartner: null,
            splitSide: null
          };
        }
      }

      var sideCards = candidates.filter(function (it) {
        var itX = it.mod && it.mod.x != null ? it.mod.x : (it.mod && it.mod.explicitSide ? 6 : 0);
        var itW = it.mod && it.mod.w != null ? it.mod.w : widthToCols(it.mod && it.mod.width);
        if (itW >= 12) return true;
        return isRightSide ? (itX >= 4 || it.midX >= colRect.left + colRect.width * 0.48) : (itX < 6 || it.midX < colRect.left + colRect.width * 0.52);
      });

      if (sideCards.length > 0) {
        var isDraggedFullSide = (!drag.mod.width || drag.mod.width === 'full') && (!drag.mod.w || drag.mod.w >= 12);
        var useFullWSide = isDraggedFullSide && (fracX >= 0.30 && fracX <= 0.70);
        var resSideW = useFullWSide ? 12 : 6;
        var resSideX = useFullWSide ? 0 : targetSideX;

        if (y < sideCards[0].top) {
          return {
            colEl: colEl,
            column: column,
            before: sideCards[0].el,
            position: candidates.indexOf(sideCards[0]),
            x: resSideX,
            y: 0,
            w: resSideW,
            splitPartner: null,
            splitSide: null
          };
        }
        for (var s = 0; s < sideCards.length; s += 1) {
          if (y < sideCards[s].mid) {
            return {
              colEl: colEl,
              column: column,
              before: sideCards[s].el,
              position: candidates.indexOf(sideCards[s]),
              x: resSideX,
              y: sideCards[s].mod && sideCards[s].mod.y != null ? sideCards[s].mod.y : s,
              w: resSideW,
              splitPartner: null,
              splitSide: null
            };
          }
        }
        var lastCard = sideCards[sideCards.length - 1];
        return {
          colEl: colEl,
          column: column,
          before: lastCard.el.nextElementSibling,
          position: candidates.indexOf(lastCard) + 1,
          x: resSideX,
          y: lastCard.mod && lastCard.mod.y != null ? lastCard.mod.y + 1 : sideCards.length,
          w: resSideW,
          splitPartner: null,
          splitSide: null
        };
      }

      // 未命中卡片（在最上方、最下方或空白处）
      if (y < candidates[0].top) {
        var topW = (fracX < 0.40 || fracX > 0.60) ? 6 : 12;
        var topX = fracX > 0.60 ? 6 : 0;
        return {
          colEl: colEl,
          column: column,
          before: candidates[0].el,
          position: 0,
          x: topX,
          w: topW,
          splitPartner: null,
          splitSide: null
        };
      }

      for (var k = 0; k < candidates.length; k += 1) {
        if (y < candidates[k].mid) {
          return {
            colEl: colEl,
            column: column,
            before: candidates[k].el,
            position: k,
            x: fracX > 0.60 ? 6 : 0,
            w: (fracX < 0.40 || fracX > 0.60 ? 6 : 12),
            splitPartner: null,
            splitSide: null
          };
        }
      }

      var bottomW = (fracX < 0.40 || fracX > 0.60) ? 6 : 12;
      var bottomX = fracX > 0.60 ? 6 : 0;
      return {
        colEl: colEl,
        column: column,
        before: null,
        position: candidates.length,
        x: bottomX,
        w: bottomW,
        splitPartner: null,
        splitSide: null
      };
    }

    function updateGap(target, immediate) {
      if (!target || !drag) return;
      if (
        drag.target &&
        drag.target.colEl === target.colEl &&
        drag.target.position === target.position &&
        drag.target.x === target.x &&
        drag.target.y === target.y &&
        drag.target.w === target.w &&
        drag.target.splitPartner === target.splitPartner &&
        drag.target.splitSide === target.splitSide
      ) {
        return;
      }

      if (!drag.gap) {
        drag.gap = el('div', 'drop-gap');
        // 高度就是这张卡片松手后的真实高度（旧版钳到 56–220px，预览会失真）。
        drag.gap.style.height = Math.round(drag.h) + 'px';
      }
      drag.gap.classList.remove(
        'is-quarter-width',
        'is-third-width',
        'is-half-width',
        'is-two-thirds-width',
        'is-three-quarters-width',
        'is-span-full',
        'is-custom-width'
      );
      if (target.w === 6) {
        drag.gap.classList.add('is-half-width');
        // x 可能是 0..6 之间任意值（自由落点），不再只有左右两档。
        drag.gap.style.gridColumn = (clamp(target.x || 0, 0, 6) + 1) + ' / span 6';
      } else if (target.w === 3) {
        drag.gap.classList.add('is-quarter-width');
        drag.gap.style.gridColumn = (target.x + 1) + ' / span 3';
      } else if (target.w === 4) {
        drag.gap.classList.add('is-third-width');
        drag.gap.style.gridColumn = (target.x + 1) + ' / span 4';
      } else if (target.w === 8) {
        drag.gap.classList.add('is-two-thirds-width');
        drag.gap.style.gridColumn = (target.x + 1) + ' / span 8';
      } else if (target.w === 9) {
        drag.gap.classList.add('is-three-quarters-width');
        drag.gap.style.gridColumn = (target.x + 1) + ' / span 9';
      } else {
        drag.gap.style.gridColumn = '1 / -1';
      }
      if (target.w < 12 && target.y != null) {
        drag.gap.style.gridRow = (target.y + 1) + ' / span ' + (target.h || 1);
      } else {
        drag.gap.style.gridRow = '';
      }

      // 槽里写上"松手后这里会出现什么"：图标 + 标题 + 宽度档位。
      // 虚线框从"有个洞"变成"这张卡会落在这"，落点不再靠猜。
      var gapSpec = specOf(drag.mod.type);
      var gapRow = el('span', 'drop-gap-row');
      gapRow.appendChild(el('span', 'drop-gap-icon', gapSpec.icon || '▫'));
      gapRow.appendChild(el('span', 'drop-gap-label', gapSpec.label));
      if (target.w < 12) {
        var wLabel = target.w === 6 ? '半栏'
          : target.w === 3 ? '1/4 栏'
          : target.w === 4 ? '1/3 栏'
          : target.w === 8 ? '2/3 栏'
          : target.w === 9 ? '3/4 栏'
          : target.w + ' 栏';
        // 落点是任意 0..12-w 的列号，不再只有"左半 / 右半"两档，
        // 所以这里说"靠左 / 居中 / 靠右"，比硬写"左侧"诚实。
        var sideWord = target.x <= 0 ? '靠左' : (target.x + target.w >= 12 ? '靠右' : '居中');
        gapRow.appendChild(el('span', 'drop-gap-hint', wLabel + ' · ' + sideWord));
      } else {
        gapRow.appendChild(el('span', 'drop-gap-hint', '整栏'));
      }
      drag.gap.textContent = '';
      drag.gap.appendChild(gapRow);

      if (drag.lastSpanPartner && drag.lastSpanPartner !== (target.oppositeNeighbor ? target.oppositeNeighbor.el : null)) {
        drag.lastSpanPartner.style.gridRow = drag.lastSpanPartnerOrigRow || '';
        drag.lastSpanPartner = null;
      }
      if (target.oppositeNeighbor && target.oppositeNeighbor.el) {
        if (!drag.lastSpanPartner) {
          drag.lastSpanPartner = target.oppositeNeighbor.el;
          drag.lastSpanPartnerOrigRow = target.oppositeNeighbor.el.style.gridRow;
        }
        var spanCount = Math.max(2, (target.y || 1) + (target.h || 1));
        target.oppositeNeighbor.el.style.gridRow = '1 / span ' + spanCount;
      }

      var move = function () {
        var addBtn = target.colEl.querySelector('.dash-add');
        if (target.before && target.before.parentNode === target.colEl) {
          target.colEl.insertBefore(drag.gap, target.before);
        } else if (addBtn) {
          target.colEl.insertBefore(drag.gap, addBtn);
        } else {
          target.colEl.appendChild(drag.gap);
        }
      };
      if (immediate || reducedMotion()) {
        // 自动滚动时不要 FLIP：内容本身在滚，再叠一层位移动画会看着发抖。
        move();
      } else {
        // FLIP 只量受影响的栏：同栏换位只量一栏，跨栏才量两栏。
        var scope = [];
        if (drag.target && drag.target.colEl) scope.push(drag.target.colEl);
        if (scope.indexOf(target.colEl) < 0) scope.push(target.colEl);
        var nodes = [];
        scope.forEach(function (colEl) {
          nodes = nodes.concat(
            Array.prototype.slice.call(colEl.querySelectorAll('.module, .drop-gap'))
          );
        });
        withFlip(nodes, move);
      }
      // 指针所在的栏单独点亮：拖动中所有栏都有参考虚网格，
      // 不把"当前会落进哪栏"挑出来，跨栏时仍然分不清。
      if (drag.colEl !== target.colEl) {
        if (drag.colEl) drag.colEl.classList.remove('is-drop-col');
        drag.colEl = target.colEl;
        drag.colEl.classList.add('is-drop-col');
      }
      drag.target = target;
    }

    /* — 拖到边缘自动滚动 — */

    /**
     * 指针**停在**栏底部不动时，浏览器一个事件都不会发。事件流一断，就没人去滚了，
     * 所以"拖着东西往下放不进去"——滚动条当然不动。必须自己开一个 rAF 循环持续滚。
     *
     * 两个细节：
     * - 滚完不去重量卡片，而是把缓存的视口中线 `mid -= delta` 平移一下就够了。
     *   滚动不改卡片尺寸，只改它们在视口里的位置，这样滚动过程仍然零布局读取。
     * - 窄屏（≤1180px）每栏 `overflow: visible`，真正滚的是 window，那条路单独处理。
     */
    var EDGE_ZONE_MIN = 40;
    var EDGE_ZONE_MAX = 72;
    var EDGE_SPEED_MIN = 2;
    var EDGE_SPEED_MAX = 14;

    var edgeScroll = null;

    function stopEdgeScroll() {
      if (edgeScroll && edgeScroll.frame) cancelAnimationFrame(edgeScroll.frame);
      edgeScroll = null;
    }

    function shiftCachedMids(colEl, delta) {
      if (!drag.rects || drag.rects.col !== colEl) return;
      for (var i = 0; i < drag.rects.list.length; i += 1) {
        drag.rects.list[i].mid -= delta;
        drag.rects.list[i].top -= delta;
        drag.rects.list[i].bottom -= delta;
      }
    }

    function stepEdgeScroll() {
      if (!drag || !edgeScroll) return;
      var state = edgeScroll;
      if (!state.dir) {
        state.frame = 0;
        return;
      }
      var amount =
        state.dir * (EDGE_SPEED_MIN + (EDGE_SPEED_MAX - EDGE_SPEED_MIN) * state.speed);
      var delta = 0;

      if (state.scrollable) {
        var before = state.col.scrollTop;
        state.col.scrollTop = before + amount;
        delta = state.col.scrollTop - before;
        shiftCachedMids(state.col, delta);
      } else {
        var beforeY = window.scrollY;
        window.scrollBy(0, amount);
        delta = window.scrollY - beforeY;
        if (delta) {
          // 页面整体滚了，这一栏的视口位置也跟着上移。
          state.rect = {
            left: state.rect.left,
            right: state.rect.right,
            width: state.rect.width,
            height: state.rect.height,
            top: state.rect.top - delta,
            bottom: state.rect.bottom - delta
          };
          shiftCachedMids(state.col, delta);
        }
      }

      if (!delta) {
        // 已经到顶 / 到底（或这一栏根本不用滚）。指针一动会重新起循环。
        state.frame = 0;
        return;
      }

      var rect = state.rect;
      var target = computeTarget(rect.left + rect.width / 2, state.y, state.col);
      if (target) updateGap(target, true);
      state.frame = requestAnimationFrame(stepEdgeScroll);
    }

    function updateEdgeScroll(colEl, x, y) {
      if (!drag || !colEl) {
        stopEdgeScroll();
        return;
      }
      if (!edgeScroll || edgeScroll.col !== colEl) {
        stopEdgeScroll();
        edgeScroll = {
          col: colEl,
          rect: colEl.getBoundingClientRect(),
          scrollable: colEl.scrollHeight > colEl.clientHeight + 1,
          dir: 0,
          speed: 0,
          x: x,
          y: y,
          frame: 0
        };
      }
      var state = edgeScroll;
      var rect = state.rect;
      var zone = clamp(rect.height * 0.12, EDGE_ZONE_MIN, EDGE_ZONE_MAX);
      state.x = x;
      state.y = y;

      if (y < rect.top + zone) {
        state.dir = -1;
        // 越靠近边缘越快，sqrt 让起步别太磨叽。
        state.speed = Math.sqrt(clamp((rect.top + zone - y) / zone, 0, 1));
      } else if (y > rect.bottom - zone) {
        state.dir = 1;
        state.speed = Math.sqrt(clamp((y - (rect.bottom - zone)) / zone, 0, 1));
      } else {
        state.dir = 0;
        state.speed = 0;
      }

      if (!state.dir) {
        if (state.frame) {
          cancelAnimationFrame(state.frame);
          state.frame = 0;
        }
        return;
      }
      if (!state.frame) state.frame = requestAnimationFrame(stepEdgeScroll);
    }

    function beginModuleDrag(mod, moduleEl, x, y, offX, offY) {
      var rect = moduleEl.getBoundingClientRect();
      drag = {
        id: mod.id,
        mod: mod,
        el: moduleEl,
        gap: null,
        ghost: makeGhost(mod, rect),
        target: null,
        rects: null,
        h: rect.height,
        colEl: null,
        // 抓取点锚定：影子相对指针的偏移 = 起手那一刻指针在卡片上的位置。
        // 不传就退回旧的右下偏移（理论上来不到这一步，防一手）。
        offX: typeof offX === 'number' ? offX : 14,
        offY: typeof offY === 'number' ? offY : 12
      };
      moduleEl.classList.add('is-dragging');
      document.body.classList.add('is-module-dragging');
      followGhost(x, y);
      // "抓起来了"的确认感：影子从原卡片位置原地浮现（缩放 + 渐入），
      // 而不是凭空出现在指针旁边 —— 起手那一瞬就知道已经攥在手里了。
      if (!reducedMotion() && drag.ghost.firstChild && drag.ghost.firstChild.animate) {
        drag.ghost.firstChild.animate(
          [
            { opacity: 0, transform: 'scale(0.92)' },
            { opacity: 1, transform: 'scale(1)' }
          ],
          { duration: 130, easing: 'cubic-bezier(0.2, 0, 0, 1)' }
        );
      }
    }

    function endDrag(commit) {
      if (!drag) return;
      var state = drag;
      drag = null;
      hoverPoint = null;
      stopEdgeScroll();
      document.body.classList.remove('is-module-dragging');
      if (state.ghost && state.ghost.parentNode) state.ghost.parentNode.removeChild(state.ghost);
      state.el.classList.remove('is-dragging');
      if (state.colEl) state.colEl.classList.remove('is-drop-col');

      if (state.lastSplitPartner && state.lastSplitPartner.el) {
        state.lastSplitPartner.el.style.gridColumn = '';
        state.lastSplitPartner.el.classList.remove('is-half-width');
        state.lastSplitPartner = null;
      }
      if (state.lastSpanPartner) {
        state.lastSpanPartner.style.gridRow = state.lastSpanPartnerOrigRow || '';
        state.lastSpanPartner = null;
      }

      if (commit && state.gap && state.gap.parentNode) {
        var colEl = state.gap.parentNode;
        var column = Number(colEl.getAttribute('data-col'));
        var target = state.target;
        if (isFinite(column)) {
          state.mod.column = column;
          if (target) {
            if (target.splitPartner && target.splitPartner.mod) {
              var partner = target.splitPartner.mod;
              partner.width = 'half';
              partner.w = 6;
              partner.x = target.splitSide === 'right' ? 0 : 6;
              partner.y = partner.y != null ? partner.y : 0;
              partner.explicitSide = true;
              partner.free = true;
            }
            if (target.oppositeNeighbor && target.oppositeNeighbor.mod) {
              target.oppositeNeighbor.mod.h = Math.max(2, (target.y || 1) + (target.h || 1));
            }
            state.mod.x = target.x != null ? target.x : 0;
            state.mod.y = target.y != null ? target.y : null;
            state.mod.w = target.w != null ? target.w : widthToCols(state.mod.width);
            state.mod.explicitSide = state.mod.w < 12;
            // 记下"这是我亲手放的位置"：排版时直接按 (x, y) 落位，不再被自动重排走。
            state.mod.free = true;
            state.mod.h = target.h != null ? target.h : 1;
            if (state.mod.w === 6) state.mod.width = 'half';
            else if (state.mod.w === 3) state.mod.width = 'quarter';
            else if (state.mod.w === 4) state.mod.width = 'third';
            else if (state.mod.w === 8) state.mod.width = 'two-thirds';
            else if (state.mod.w === 9) state.mod.width = 'three-quarters';
            else if (state.mod.w >= 12) state.mod.width = 'full';
          }
          if (state.gap.parentNode) {
            state.gap.parentNode.removeChild(state.gap);
          }
          var colMods = layout.modules.filter(function (item) {
            return item.column === column && item !== state.mod;
          });
          var pos = target && target.position != null ? target.position : colMods.length;
          var anchor = colMods[pos];
          var removeIdx = layout.modules.indexOf(state.mod);
          if (removeIdx >= 0) layout.modules.splice(removeIdx, 1);
          var insertIdx = anchor ? layout.modules.indexOf(anchor) : layout.modules.length;
          layout.modules.splice(insertIdx, 0, state.mod);

          saveLayout(layout);
          render();
          return;
        }
      } else if (state.gap && state.gap.parentNode) {
        state.gap.parentNode.removeChild(state.gap);
      }
    }

    /**
     * 拖动排序走 **pointer events**，不用 HTML5 拖放。
     *
     * 之前用 `dragstart` / `dragover` / `drop`，幽灵卡片总是慢半拍、跟着指针"追"。
     * 原因在浏览器那边：`dragover` 的坐标是拖放循环喂过来的，系统会限频（低于屏幕
     * 刷新率），快速移动时还会丢掉中间几个点。`pointermove` 是合成器按刷新率派发的，
     * 坐标就是真实指针位置 —— 于是幽灵卡片才真的"贴在指针上"。
     *
     * 顺带还甩掉了 HTML5 拖放的一堆包袱：必须给每个 dragover 都 preventDefault、
     * 自带一层不可控的半透明拖影、拖到窗口外就断流。
     *
     * 命中测试和插槽更新仍然合并到一帧一次：指针事件可能比屏幕刷新还密（高刷鼠标
     * 能到 1000Hz），每个都算一遍纯属浪费。幽灵卡片本身不合并（见 followGhost）。
     */
    /**
     * 起手之后的整条拖动流水线（arm → move → commit/cancel），标题栏和卡片身体
     * 两条起手路径共用。差别只有两个：阈值（身体更容易误触，放宽到 6px）和
     * 抓取点（身体起手时指针可能落在卡片中部，锚点要跟着算）。
     */
    function armCardDrag(startEvent, mod, moduleEl, threshold) {
      var startX = startEvent.clientX;
      var startY = startEvent.clientY;
      // 抓取点必须在 pointerdown 这一刻量：拖到阈值才 arm，如果那时再量，
      // 指针已经走了一段，锚点就带着这段误差（快速甩动时影子会跳）。
      var grabRect = moduleEl.getBoundingClientRect();
      var grabDX = clamp(startEvent.clientX - grabRect.left, 0, grabRect.width);
      var grabDY = clamp(startEvent.clientY - grabRect.top, 0, grabRect.height);
      var armed = false;
      var frame = 0;

      function flush() {
        frame = 0;
        if (!drag || !hoverPoint) return;
        var target = computeTarget(hoverPoint.x, hoverPoint.y, hoverPoint.target);
        updateGap(target);
        updateEdgeScroll(target && target.colEl, hoverPoint.x, hoverPoint.y);
      }

      function onMove(moveEvent) {
        if (!armed) {
          var dx = moveEvent.clientX - startX;
          var dy = moveEvent.clientY - startY;
          if (dx * dx + dy * dy < threshold * threshold) return;
          armed = true;
          beginModuleDrag(mod, moduleEl, moveEvent.clientX, moveEvent.clientY, grabDX, grabDY);
        }
        if (!drag) return;
        followGhost(moveEvent.clientX, moveEvent.clientY);
        hoverPoint = { x: moveEvent.clientX, y: moveEvent.clientY, target: moveEvent.target };
        if (!frame) frame = requestAnimationFrame(flush);
      }

      function detach() {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onCancel);
        window.removeEventListener('keydown', onKey, true);
        window.removeEventListener('blur', onCancel);
        if (frame) {
          cancelAnimationFrame(frame);
          frame = 0;
        }
      }

      function onUp() {
        detach();
        if (!armed) return; // 只是点了一下，什么都没发生
        // 最后一段位移可能还没被 rAF 消化，落点以松手那一刻为准。
        if (hoverPoint) {
          var point = hoverPoint;
          drag.rects = null;
          updateGap(computeTarget(point.x, point.y, point.target));
        }
        endDrag(true);
      }

      // 放弃拖动：`pointercancel`（系统抢走指针）、窗口失焦、按 Esc。
      // 这条路上不能提交，否则"拖到一半改主意"会把卡片留在半路。
      function onCancel() {
        detach();
        if (armed) endDrag(false);
      }

      function onKey(keyEvent) {
        if (keyEvent.key !== 'Escape') return;
        keyEvent.preventDefault();
        keyEvent.stopPropagation();
        onCancel();
      }

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onCancel);
      // 指针跑到窗口外松手时可能收不到 pointerup，别让幽灵卡片留在屏幕上。
      window.addEventListener('blur', onCancel);
      window.addEventListener('keydown', onKey, true);
    }

    function wireModuleDrag(mod, moduleEl, head) {
      head.addEventListener('pointerdown', function (event) {
        if (event.button !== 0 || event.isPrimary === false) return;
        // 标题栏里的按钮（⋯ 菜单）自己响应，别顺手把卡片拖起来。
        if (event.target && event.target.closest && event.target.closest('button')) return;
        // 挡掉文本选择：不然按住标题栏拖会顺手把标题选蓝。
        event.preventDefault();
        armCardDrag(event, mod, moduleEl, DRAG_THRESHOLD);
      });

      // 卡片身体也能起手（仅鼠标）：不用再瞄准窄窄的标题栏。
      // 触屏不走这条 —— 手指按在内容上仍以滚动为先，排序走标题栏或 ⋯ 菜单。
      moduleEl.addEventListener('pointerdown', function (event) {
        if (event.pointerType !== 'mouse' || event.button !== 0 || event.isPrimary === false) return;
        var node = event.target;
        if (!node || !node.closest) return;
        // 标题栏（及其中的按钮）走上面那条路，这里别重复接手。
        if (node === head || head.contains(node)) return;
        // 交互元素和尺寸把手有自己的手势语义，让位。
        if (node.closest('button, a, input, textarea, select, label, [contenteditable="true"], .module-resize, .module-resize-x, .module-resize-xy, .pop')) return;
        // 滚动区里的按住拖动 = 滚动，别抢。pointerdown 只读这一次布局，无妨。
        var bodyEl = node.closest('.module-body');
        if (bodyEl && bodyEl.scrollHeight > bodyEl.clientHeight + 1) return;
        // 阻止原生文本选择：一旦选区开始，后面的 pointermove 拦不住它。
        event.preventDefault();
        armCardDrag(event, mod, moduleEl, BODY_DRAG_THRESHOLD);
      });
    }

    function moveModule(id, column, position) {
      var index = -1;
      for (var i = 0; i < layout.modules.length; i += 1) {
        if (layout.modules[i].id === id) {
          index = i;
          break;
        }
      }
      if (index < 0) return;
      var mod = layout.modules[index];
      layout.modules.splice(index, 1);
      mod.column = column;
      mod.y = null;
      var siblings = layout.modules.filter(function (item) {
        return item.column === column;
      });
      var anchor = siblings[position];
      var insertAt;
      if (anchor) {
        insertAt = layout.modules.indexOf(anchor);
      } else if (siblings.length) {
        insertAt = layout.modules.indexOf(siblings[siblings.length - 1]) + 1;
      } else {
        insertAt = layout.modules.length;
      }
      layout.modules.splice(insertAt, 0, mod);
    }

    /* — 弹出面板 — */

    function closePop() {
      if (pop) {
        if (typeof pop._cleanup === 'function') pop._cleanup();
        if (pop.parentNode) pop.parentNode.removeChild(pop);
      }
      pop = null;
    }

    function openPop(anchor, build) {
      closePop();
      pop = el('div', 'pop');
      pop.setAttribute('role', 'dialog');
      build(pop);
      document.body.appendChild(pop);
      var rect = anchor.getBoundingClientRect();
      var width = pop.offsetWidth;
      var height = pop.offsetHeight;
      var left = clamp(rect.left + rect.width - width, 8, Math.max(8, window.innerWidth - width - 8));
      var top = rect.bottom + 6;
      if (top + height > window.innerHeight - 8) {
        // 下面放不下就翻到上面；上下都放不下（列表比窗口还长）就贴着视口底部，
        // 由 .pop 的 max-height 自己滚 —— 总之不能被窗口裁掉。
        var above = rect.top - height - 6;
        top = above >= 8 ? above : Math.max(8, window.innerHeight - height - 8);
      }
      pop.style.left = left + 'px';
      pop.style.top = top + 'px';
      setTimeout(function () {
        document.addEventListener('pointerdown', onDocDown, true);
      }, 0);
      function onDocDown(event) {
        if (pop && !pop.contains(event.target) && !anchor.contains(event.target)) {
          document.removeEventListener('pointerdown', onDocDown, true);
          closePop();
        }
      }
      pop._cleanup = function () {
        document.removeEventListener('pointerdown', onDocDown, true);
      };
      return pop;
    }

    function menuItem(label, onClick, extra) {
      var item = el('button', 'pop-item' + (extra && extra.active ? ' is-active' : ''));
      item.type = 'button';
      item.appendChild(el('span', 'pop-item-label', label));
      if (extra && extra.hint) item.appendChild(el('span', 'pop-item-hint', extra.hint));
      item.addEventListener('click', function () {
        onClick();
      });
      return item;
    }

    function openSourcePop(anchor, mod, moduleEl) {
      var spec = specOf(mod.type);
      var sources = typeof spec.sources === 'function' ? spec.sources(mod) : spec.sources || [];
      openPop(anchor, function (container) {
        container.appendChild(el('div', 'pop-title', '数据来源'));
        if (!sources.length) {
          container.appendChild(el('div', 'pop-empty', '这个模块没有可选来源。'));
          return;
        }
        sources.forEach(function (source) {
          var active =
            (mod.source && mod.source.mode) === source.mode &&
            (source.value === undefined || (mod.source && mod.source.value === source.value));
          var row = menuItem(source.label, function () {
            if (source.needsValue) {
              renderSourceValues(container, mod, source, moduleEl);
              return;
            }
            mod.source = { mode: source.mode };
            if (source.value !== undefined) mod.source.value = source.value;
            saveLayout(layout);
            closePop();
            render();
          }, { active: active, hint: source.hint });
          container.appendChild(row);
        });
      });
    }

    function renderSourceValues(container, mod, source, moduleEl) {
      container.textContent = '';
      container.appendChild(el('div', 'pop-title', source.label));
      var options = source.options || [];
      if (!options.length) {
        container.appendChild(el('div', 'pop-empty', '还没有可选的' + (source.valueLabel || '值') + '。'));
        return;
      }
      if (!options.length) {
        container.appendChild(el('div', 'pop-empty', '还没有可选的' + (source.valueLabel || '值') + '。'));
        return;
      }
      if (source.geocode) {
        // 地理编码搜索：输入 → 异步候选（带省份）→ 点选写入来源。
        container.appendChild(el('div', 'pop-title', source.label));
        var box = el('input', 'pop-search');
        box.type = 'text';
        box.placeholder = '输入城市名，如 乌鲁木齐';
        box.setAttribute('aria-label', '搜索城市');
        container.appendChild(box);
        var resultList = el('div', 'pop-multi');
        container.appendChild(resultList);
        var timer = null;
        box.addEventListener('input', function () {
          if (timer) clearTimeout(timer);
          var q = box.value.trim();
          if (!q) { resultList.textContent = ''; return; }
          timer = setTimeout(function () {
            resultList.textContent = '';
            resultList.appendChild(el('div', 'pop-empty', '搜索中…'));
            Promise.resolve(source.search(q)).then(function (options) {
              resultList.textContent = '';
              if (!options.length) {
                resultList.appendChild(el('div', 'pop-empty', '没有匹配的城市。'));
                return;
              }
              options.forEach(function (option) {
                resultList.appendChild(
                  menuItem(option.label, function () {
                    mod.source = { mode: source.mode, value: option.value, lat: option.lat, lon: option.lon };
                    saveLayout(layout);
                    closePop();
                    render();
                  })
                );
              });
            }).catch(function (err) {
              resultList.textContent = '';
              resultList.appendChild(el('div', 'pop-empty', '搜索失败：' + ((err && err.message) || '网络不可用')));
            });
          }, 300);
        });
        setTimeout(function () { box.focus(); }, 0);
        return;
      }
      if (source.multi) {
        // 多选来源（自选网站）：勾选即时可见，「完成」写入模块配置。
        var working = (mod.source && mod.source.siteIds || []).slice();
        var list = el('div', 'pop-multi');
        options.forEach(function (option) {
          var row = el('button', 'pop-item');
          row.type = 'button';
          row.setAttribute('data-pick-id', option.value);
          row.appendChild(el('span', 'pop-item-label', option.label));
          var mark = el('span', 'pop-item-hint', working.indexOf(option.value) >= 0 ? '✓' : '');
          row.appendChild(mark);
          row.addEventListener('click', function () {
            var at = working.indexOf(option.value);
            if (at >= 0) working.splice(at, 1);
            else working.push(option.value);
            mark.textContent = at >= 0 ? '' : '✓';
          });
          list.appendChild(row);
        });
        container.appendChild(list);
        var done = el('button', 'pop-item pop-item-done', '完成（' + working.length + ' 个）');
        done.type = 'button';
        done.setAttribute('data-pick-done', '');
        done.addEventListener('click', function () {
          mod.source = { mode: source.mode, siteIds: working };
          saveLayout(layout);
          closePop();
          render();
        });
        container.appendChild(done);
        return;
      }
      var wrap = options.length > 10 ? el('div', 'pop-multi') : container;
      options.forEach(function (option) {
        var active = (mod.source && mod.source.mode) === source.mode && mod.source.value === option.value;
        (options.length > 10 ? wrap : container).appendChild(
          menuItem(option.label, function () {
            mod.source = { mode: source.mode, value: option.value };
            saveLayout(layout);
            closePop();
            render();
          }, { active: active })
        );
      });
      if (options.length > 10) container.appendChild(wrap);
    }

    function openModuleMenu(anchor, mod, moduleEl) {
      var column = mod.column;
      var siblings = layout.modules.filter(function (item) {
        return item.column === column;
      });
      var position = siblings.indexOf(mod);
      openPop(anchor, function (container) {
        container.appendChild(el('div', 'pop-title', specOf(mod.type).label));
        container.appendChild(
          menuItem('数据来源…', function () {
            openSourcePop(anchor, mod, moduleEl);
          }, { hint: describeSource(mod) })
        );
        container.appendChild(
          menuItem('适应内容高度', function () {
            mod.height = null;
            saveLayout(layout);
            closePop();
            applyHeight(moduleEl, mod);
          }, { active: !mod.height })
        );
        container.appendChild(el('div', 'pop-group-title', '宽度与跨栏'));
        container.appendChild(
          menuItem('1/4 四分之一 (25%)', function () {
            mod.width = 'quarter';
            mod.w = 3;
            mod.x = null;
            mod.y = null;
            mod.h = 1;
            mod.explicitSide = false;
            saveLayout(layout);
            closePop();
            render();
          }, { active: mod.width === 'quarter', hint: '单栏并排 4 个' })
        );
        container.appendChild(
          menuItem('1/3 三分之一 (33%)', function () {
            mod.width = 'third';
            mod.w = 4;
            mod.x = null;
            mod.y = null;
            mod.h = 1;
            mod.explicitSide = false;
            saveLayout(layout);
            closePop();
            render();
          }, { active: mod.width === 'third', hint: '单栏并排 3 个' })
        );
        container.appendChild(
          menuItem('半栏并排 (50%)', function () {
            mod.width = 'half';
            mod.w = 6;
            mod.x = null;
            mod.y = null;
            mod.h = 1;
            mod.explicitSide = false;
            saveLayout(layout);
            closePop();
            render();
          }, { active: mod.width === 'half', hint: '适合小卡片左右并排' })
        );
        container.appendChild(
          menuItem('2/3 三分之二 (67%)', function () {
            mod.width = 'two-thirds';
            mod.w = 8;
            mod.x = null;
            mod.y = null;
            saveLayout(layout);
            closePop();
            render();
          }, { active: mod.width === 'two-thirds', hint: '宽窄搭配' })
        );
        container.appendChild(
          menuItem('3/4 四分之三 (75%)', function () {
            mod.width = 'three-quarters';
            mod.w = 9;
            mod.x = null;
            mod.y = null;
            saveLayout(layout);
            closePop();
            render();
          }, { active: mod.width === 'three-quarters' })
        );
        container.appendChild(
          menuItem('整栏 (100%)', function () {
            mod.width = 'full';
            mod.w = 12;
            mod.x = 0;
            mod.y = null;
            mod.h = 1;
            saveLayout(layout);
            closePop();
            render();
          }, { active: !mod.width || mod.width === 'full' })
        );
        container.appendChild(
          menuItem('全宽通栏 (跨所有栏)', function () {
            mod.width = 'span-full';
            saveLayout(layout);
            closePop();
            render();
          }, { active: mod.width === 'span-full', hint: '横跨顶部通栏' })
        );
        container.appendChild(
          menuItem('自定义百分比…', function () {
            var curr = typeof mod.width === 'number' ? mod.width : (mod.width === 'half' ? 50 : (mod.width === 'quarter' ? 25 : (mod.width === 'third' ? 33 : 100)));
            var val = window.prompt('请输入卡片在栏内的宽度百分比 (15 ~ 100)：', String(curr));
            if (val == null) return;
            var num = parseInt(val.replace(/%/g, '').trim(), 10);
            if (isFinite(num) && num >= 15 && num <= 100) {
              mod.width = num;
              mod.w = clamp(Math.round((num / 100) * 12), 2, 12);
              mod.x = null;
              mod.y = null;
              saveLayout(layout);
              closePop();
              render();
            } else if (val.trim()) {
              alert('请输入 15 到 100 之间的数字');
            }
          }, {
            active: typeof mod.width === 'number',
            hint: typeof mod.width === 'number' ? mod.width + '%' : '自由精确比例'
          })
        );
        container.appendChild(el('div', 'pop-group-title', '2D 布局与堆叠 (Grafana)'));
        container.appendChild(
          menuItem('排在右侧 (并排下层堆叠)', function () {
            mod.width = 'half';
            mod.w = 6;
            mod.x = 6;
            mod.y = null;
            mod.h = 1;
            mod.explicitSide = true;
            saveLayout(layout);
            closePop();
            render();
          }, { active: mod.x === 6, hint: '右半栏堆叠' })
        );
        container.appendChild(
          menuItem('排在左侧 (并排下层堆叠)', function () {
            mod.width = 'half';
            mod.w = 6;
            mod.x = 0;
            mod.y = null;
            mod.h = 1;
            mod.explicitSide = true;
            saveLayout(layout);
            closePop();
            render();
          }, { active: mod.x === 0 && mod.w === 6, hint: '左半栏堆叠' })
        );
        container.appendChild(
          menuItem('跨双行高 (占满两侧高度)', function () {
            mod.h = mod.h === 2 ? 1 : 2;
            saveLayout(layout);
            closePop();
            render();
          }, { active: mod.h === 2, hint: '与上下堆叠卡片对齐' })
        );
        container.appendChild(
          menuItem('跨三行高 (三倍高度)', function () {
            mod.h = mod.h === 3 ? 1 : 3;
            saveLayout(layout);
            closePop();
            render();
          }, { active: mod.h === 3, hint: '与 3 张堆叠卡片对齐' })
        );
        container.appendChild(
          menuItem('自适应多行高 (自动对齐)', function () {
            mod.h = null;
            saveLayout(layout);
            closePop();
            render();
          }, { active: !mod.h, hint: '自动对齐相邻堆叠卡片' })
        );
        // 拖拽在触屏上不可用（HTML5 拖放不认 touch），所以位置也提供菜单入口。
        if (position > 0) {
          container.appendChild(
            menuItem('上移', function () {
              moveModule(mod.id, column, position - 1);
              saveLayout(layout);
              closePop();
              render();
            })
          );
        }
        if (position >= 0 && position < siblings.length - 1) {
          container.appendChild(
            menuItem('下移', function () {
              moveModule(mod.id, column, position + 1);
              saveLayout(layout);
              closePop();
              render();
            })
          );
        }
        if (column > 0) {
          container.appendChild(
            menuItem('移到左栏', function () {
              moveModule(mod.id, column - 1, 9999);
              saveLayout(layout);
              closePop();
              render();
            })
          );
        }
        if (column < layout.columns.length - 1) {
          container.appendChild(
            menuItem('移到右栏', function () {
              moveModule(mod.id, column + 1, 9999);
              saveLayout(layout);
              closePop();
              render();
            })
          );
        }
        container.appendChild(
          menuItem('本栏自动整理', function () {
            // 自由摆放会留空（这就是"停在原地"的代价）。这里把这栏的卡片交还给
            // 自动排版：按顺序从左上角重新排紧，空隙收回。
            layout.modules.forEach(function (item) {
              if (item.column !== column) return;
              item.free = false;
              item.explicitSide = false;
              item.y = null;
              item.x = null;
            });
            saveLayout(layout);
            closePop();
            render();
          }, { hint: '把这一栏的卡片重新排紧，收回空隙' })
        );
        container.appendChild(
          menuItem('删除模块', function () {
            layout.modules = layout.modules.filter(function (item) {
              return item.id !== mod.id;
            });
            saveLayout(layout);
            closePop();
            render();
          }, { hint: '不会删数据' })
        );
      });
    }

    function describeSource(mod) {
      var spec = specOf(mod.type);
      var sources = typeof spec.sources === 'function' ? spec.sources(mod) : spec.sources || [];
      for (var i = 0; i < sources.length; i += 1) {
        if (sources[i].mode !== (mod.source && mod.source.mode)) continue;
        if (sources[i].value !== undefined) {
          if (sources[i].value === (mod.source && mod.source.value)) return sources[i].label;
          continue;
        }
        if ((mod.source && mod.source.mode) === 'custom') {
          return '自选 ' + ((mod.source && mod.source.siteIds) || []).length + ' 个网站';
        }
        if (sources[i].needsValue) {
          var options = sources[i].options || [];
          for (var j = 0; j < options.length; j += 1) {
            if (options[j].value === mod.source.value) return options[j].label;
          }
          return sources[i].label;
        }
        return sources[i].label;
      }
      return '';
    }

    var ADD_GROUPS = [
      { title: '记录', types: ['capture'] },
      { title: '浏览', types: ['notes', 'pinned', 'sites', 'annotations', 'weather', 'hitokoto', 'rates'] },
      { title: '管理', types: ['checkins', 'reminders', 'countdown', 'pomodoro'] }
    ];

    function openAddPop(anchor, columnIndex) {
      openPop(anchor, function (container) {
        container.appendChild(el('div', 'pop-title', '添加模块'));
        ADD_GROUPS.forEach(function (group) {
          var present = group.types.filter(function (type) { return types[type]; });
          if (!present.length) return;
          container.appendChild(el('div', 'pop-group-title', group.title));
          present.forEach(function (type) {
            var spec = types[type];
          var item = el('button', 'pop-item pop-add-item');
          item.type = 'button';
          item.setAttribute('data-add-type', type);
          item.appendChild(el('span', 'pop-add-icon', spec.icon || '▫'));
          var main = el('span', 'pop-add-main');
          main.appendChild(el('span', 'pop-item-label', spec.label));
          if (spec.desc) main.appendChild(el('span', 'pop-item-hint', spec.desc));
          item.appendChild(main);
          item.addEventListener('click', function () {
            var module = {
              id: 'm-' + type + '-' + Date.now().toString(36),
              type: type,
              column: columnIndex,
              height: spec.defaultHeight || null,
              source: spec.defaultSource ? clone(spec.defaultSource) : {}
            };
            layout.modules.push(module);
            saveLayout(layout);
            closePop();
            render();
          });
          container.appendChild(item);
          });
        });
      });
    }

    /* — 渲染 — */

    function buildModule(mod, index) {
      var spec = specOf(mod.type);
      var moduleEl = el('section', 'module');
      moduleEl.setAttribute('data-module-id', mod.id);
      moduleEl.setAttribute('data-module-type', mod.type);
      moduleEl.setAttribute('aria-label', spec.label);

      var head = el('header', 'module-head');
      head.setAttribute('title', '拖动可以换位置');
      head.appendChild(el('span', 'module-grip', '⠿'));
      head.appendChild(el('span', 'module-icon', spec.icon || '▫'));
      head.appendChild(el('span', 'module-title', spec.label));

      var sourceLabel = describeSource(mod);
      var sourceEl = el('span', 'module-source', sourceLabel);
      sourceEl.hidden = !sourceLabel;
      head.appendChild(sourceEl);

      var menuBtn = el('button', 'module-menu-btn', '⋯');
      menuBtn.type = 'button';
      menuBtn.setAttribute('aria-label', spec.label + ' 模块设置');
      menuBtn.setAttribute('data-module-menu', mod.id);
      menuBtn.addEventListener('click', function (event) {
        event.stopPropagation();
        openModuleMenu(menuBtn, mod, moduleEl);
      });
      head.appendChild(menuBtn);

      wireModuleDrag(mod, moduleEl, head);

      var body = el('div', 'module-body');
      if (spec.legacyId && mod.id === 'm-' + mod.type) body.id = spec.legacyId;

      var handle = el('div', 'module-resize');
      handle.setAttribute('role', 'separator');
      handle.setAttribute('aria-orientation', 'horizontal');
      handle.setAttribute('aria-label', spec.label + ' 高度');
      handle.tabIndex = 0;
      handle.title = '上下拖动调整高度';
      handle.addEventListener('pointerdown', function (event) {
        beginHeightDrag(moduleEl, mod, event);
      });
      handle.addEventListener('keydown', function (event) {
        var step = event.shiftKey ? 64 : 16;
        if (event.key === 'ArrowUp') mod.height = Math.max(MIN_MODULE_PX, (mod.height || moduleEl.getBoundingClientRect().height) - step);
        else if (event.key === 'ArrowDown') mod.height = (mod.height || moduleEl.getBoundingClientRect().height) + step;
        else return;
        event.preventDefault();
        applyHeight(moduleEl, mod);
        saveLayout(layout);
      });

      var handleW = el('div', 'module-resize-x');
      handleW.setAttribute('role', 'separator');
      handleW.setAttribute('aria-orientation', 'vertical');
      handleW.setAttribute('aria-label', spec.label + ' 宽度');
      handleW.tabIndex = 0;
      handleW.title = '左右拖动调整宽度（半栏 / 整栏 / 全宽）';
      handleW.addEventListener('pointerdown', function (event) {
        beginWidthDrag(moduleEl, mod, event);
      });
      handleW.addEventListener('keydown', function (event) {
        if (event.key === 'ArrowLeft') {
          mod.width = 'half';
          mod.w = 6;
          mod.x = null;
          mod.y = null;
          mod.explicitSide = false;
        } else if (event.key === 'ArrowRight') {
          mod.width = mod.width === 'full' ? 'span-full' : 'full';
          mod.w = mod.width === 'full' ? 12 : null;
          mod.x = null;
          mod.y = null;
          mod.explicitSide = false;
        } else return;
        event.preventDefault();
        applyWidth(moduleEl, mod);
        saveLayout(layout);
        render();
      });

      var handleCorner = el('div', 'module-resize-xy');
      handleCorner.title = '拖动同时调整宽高';
      handleCorner.addEventListener('pointerdown', function (event) {
        beginCornerDrag(moduleEl, mod, event);
      });

      moduleEl.appendChild(head);
      moduleEl.appendChild(body);
      moduleEl.appendChild(handle);
      moduleEl.appendChild(handleW);
      moduleEl.appendChild(handleCorner);
      applyHeight(moduleEl, mod);
      applyWidth(moduleEl, mod);

      try {
        renderBody(mod, body, moduleEl);
      } catch (err) {
        console.error('[Self-Hub] module render failed: ' + mod.type, err);
        body.appendChild(el('div', 'empty', '这个模块渲染失败了，可以删掉重加。'));
      }
      return moduleEl;
    }

    /**
     * 重绘会重建整个 DOM，输入框里没提交的文字不能跟着没。
     *
     * `render()` 不只在自己拖完布局时跑：工作台恢复备份会把布局写回 storage、
     * 这一页接住后 `adopt()` 整页重画；点分类 chip 换来源、增删模块也一样。
     * 用户正在写的速记被这类重画清掉，看起来就是"我明明打了字，它自己没了"。
     * 按 id 把值（和光标位置）存下来，画完填回去。
     */
    /**
     * 草稿的 key 要带上模块 id：同一个模块类型可以放两张（比如两个「记一笔」），
     * 它们的输入框 id 相同，只按 id 存会把两份草稿写串。
     */
    function draftKey(field) {
      var holder = field.closest ? field.closest('[data-module-id]') : null;
      var moduleId = holder ? holder.getAttribute('data-module-id') : '';
      return moduleId ? moduleId + '::' + field.id : field.id;
    }

    function fieldByDraftKey(key) {
      var sep = key.indexOf('::');
      if (sep <= 0) return document.getElementById(key);
      var holder = root.querySelector('[data-module-id="' + key.slice(0, sep) + '"]');
      return holder ? holder.querySelector('[id="' + key.slice(sep + 2) + '"]') : null;
    }

    function snapshotDrafts() {
      var drafts = [];
      Array.prototype.forEach.call(root.querySelectorAll('input[id], textarea[id]'), function (field) {
        if (!field.value) return;
        var draft = {
          id: draftKey(field),
          value: field.value,
          start: null,
          end: null,
          focused: document.activeElement === field
        };
        try {
          draft.start = field.selectionStart;
          draft.end = field.selectionEnd;
        } catch (err) {
          /* number / email 之类的类型没有选区，忽略 */
        }
        drafts.push(draft);
      });
      return drafts;
    }

    function restoreDrafts(drafts) {
      if (!drafts || !drafts.length) return;
      drafts.forEach(function (draft) {
        var field = fieldByDraftKey(draft.id);
        if (!field || !root.contains(field)) return;
        field.value = draft.value;
        if (!draft.focused || draft.start == null) return;
        try {
          field.focus();
          field.setSelectionRange(draft.start, draft.end);
        } catch (err) {
          /* 同上 */
        }
      });
    }

    function render() {
      if (drag) endDrag(false);
      closePop();
      var drafts = snapshotDrafts();
      root.textContent = '';
      cols = [];
      var columnCount = layout.columns.length;

      var fullModules = layout.modules.filter(function (item) {
        return item.width === 'span-full';
      });
      fullModules.forEach(function (mod) {
        root.appendChild(buildModule(mod, mod.column));
      });

      for (var i = 0; i < columnCount; i += 1) {
        var columnEl = el('section', 'dash-col');
        columnEl.setAttribute('data-col', String(i));
        var mods = layout.modules.filter(function (item) {
          return item.column === i && item.width !== 'span-full';
        });
        packColumnModules(mods);
        mods.forEach(function (mod) {
          columnEl.appendChild(buildModule(mod, i));
        });

        var add = el('button', 'dash-add', '＋ 添加模块');
        add.type = 'button';
        add.setAttribute('data-add-col', String(i));
        add.addEventListener('click', function (index) {
          return function (event) {
            openAddPop(event.currentTarget, index);
          };
        }(i));
        columnEl.appendChild(add);

        // 拖动 / 命中测试都挂在卡片自己的标题栏上（见 wireModuleDrag）：
        // 每张卡片一个 pointerdown，比整页监听 dragover 便宜得多。
        root.appendChild(columnEl);
        cols.push(columnEl);

        if (i < columnCount - 1) {
          var resizer = el('div', 'col-resizer');
          resizer.setAttribute('role', 'separator');
          resizer.setAttribute('aria-orientation', 'vertical');
          resizer.setAttribute('aria-label', '调整这一栏宽度');
          resizer.addEventListener('pointerdown', function (index) {
            return function (event) {
              beginColumnDrag(index, event);
            };
          }(i));
          root.appendChild(resizer);
        }
      }

      if (!layout.modules.length) {
        var empty = el('div', 'dash-empty');
        empty.appendChild(el('div', 'dash-empty-title', '面板是空的'));
        empty.appendChild(el('div', 'dash-empty-sub', '点任意一栏底部的「＋ 添加模块」，把笔记、网站、提醒放回来。'));
        root.appendChild(empty);
      }

      // 画完再填回草稿：顺序不能反，反了填进的是马上要被替换掉的旧节点。
      restoreDrafts(drafts);
      applyWidths();
    }

    function addColumn() {
      if (layout.columns.length >= 6) return false;
      var newId = 'c' + (layout.columns.length + 1);
      layout.columns.push({ id: newId, fr: 1.0 });
      saveLayout(layout);
      render();
      return true;
    }

    function removeColumn() {
      if (layout.columns.length <= 1) return false;
      var lastIdx = layout.columns.length - 1;
      layout.modules.forEach(function (m) {
        if (m.column >= lastIdx) m.column = lastIdx - 1;
      });
      layout.columns.pop();
      saveLayout(layout);
      render();
      return true;
    }

    function refreshBodies(onlyTypes) {
      var wanted = onlyTypes && onlyTypes.length ? onlyTypes : null;
      // 和 render() 一样：局部重画也不能把没提交的输入清掉。
      var drafts = snapshotDrafts();
      Array.prototype.forEach.call(root.querySelectorAll('.module'), function (moduleEl) {
        var mod = moduleById(moduleEl.getAttribute('data-module-id'));
        if (!mod) return;
        if (wanted && wanted.indexOf(mod.type) < 0) return;
        var body = moduleEl.querySelector('.module-body');
        if (!body) return;
        moduleEl.hidden = false;
        body.textContent = '';
        try {
          renderBody(mod, body, moduleEl);
        } catch (err) {
          console.error('[Self-Hub] module refresh failed: ' + mod.type, err);
        }
        var sourceLabel = describeSource(mod);
        var sourceEl = moduleEl.querySelector('.module-source');
        if (sourceEl) {
          sourceEl.textContent = sourceLabel;
          sourceEl.hidden = !sourceLabel;
        }
      });
      restoreDrafts(drafts);
    }

    window.addEventListener('resize', function () {
      applyWidths();
    });
    render();

    return {
      /**
       * 内存里的布局（会被 `render()` 的自动排版就地改写）。
       * 想判断"这条 storage 变更是不是自己写的"，用 `isOwnWrite`，别拿它比 —— 见那里的注释。
       */
      getLayout: function () {
        return layout;
      },
      getColumnCount: function () {
        return layout.columns.length;
      },
      addColumn: addColumn,
      removeColumn: removeColumn,
      render: render,
      /**
       * Take a layout that came from outside this page.
       *
       * The workbench writes `selfhub_newtab_layout` back when the user restores a backup,
       * so the new tab must be able to adopt that instead of keeping the copy it loaded at
       * boot — otherwise the next card the user drags would write the pre-restore layout
       * straight back over the restored one.
       */
      adopt: function (next) {
        var clean = normalize(next);
        if (!clean) return false;
        layout = clean;
        // 记成"已持有"：同一条外部变更重复派发时不必再重画一遍。
        lastSavedJson = stableStringify(clean);
        render();
        return true;
      },
      /** 这条 storage 变更是不是本页自己写的回声（见 stableStringify 的注释）。 */
      isOwnWrite: isOwnWrite,
      refreshBodies: refreshBodies,
      save: function () {
        saveLayout(layout);
      },
      reset: function () {
        layout = clone(DEFAULT_LAYOUT);
        saveLayout(layout);
        render();
      }
    };
  }

  window.SelfHubDashboard = {
    DEFAULT_LAYOUT: DEFAULT_LAYOUT,
    LAYOUT_KEY: LAYOUT_KEY,
    loadLayout: loadLayout,
    saveLayout: saveLayout,
    normalize: normalize,
    stableStringify: stableStringify,
    mount: mount
  };
})();
