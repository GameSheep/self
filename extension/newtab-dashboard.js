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
  var MIN_COL_PX = 190;
  var MIN_MODULE_PX = 120;
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
      { id: 'm-quick', type: 'quicknote', column: 0, height: 232, source: { folder: '' } },
      { id: 'm-capture', type: 'capture', column: 1, height: null, source: {} },
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
    if (columns.length < 1 || columns.length > 4) return null;
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
      cleanModules.push({
        id: id,
        type: mod.type,
        column: isFinite(column) ? clamp(column, 0, cleanColumns.length - 1) : 0,
        height: isFinite(Number(mod.height)) && Number(mod.height) > 0 ? Math.round(Number(mod.height)) : null,
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

  function saveLayout(layout) {
    try {
      chrome.storage.local.set({ selfhub_newtab_layout: layout });
    } catch (err) {
      console.warn('[Self-Hub] new tab: cannot persist layout', err);
    }
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
        moduleEl.classList.add('has-fixed-height');
      } else {
        moduleEl.style.height = '';
        moduleEl.classList.remove('has-fixed-height');
      }
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

    function withFlip(nodes, mutate) {
      if (reducedMotion() || !nodes.length) {
        mutate();
        return;
      }
      var before = nodes.map(function (node) {
        return node.getBoundingClientRect().top;
      });
      mutate();
      for (var i = 0; i < nodes.length; i += 1) {
        var dy = before[i] - nodes[i].getBoundingClientRect().top;
        if (!dy) continue;
        // 快速拖动时同一个卡片会在一秒内被重新定位好几次。不掐掉上一段动画，
        // 两段 translateY 会同时跑，卡片就"抖"起来了 —— 这是"卡"的观感来源之一。
        var running = nodes[i].getAnimations();
        for (var j = 0; j < running.length; j += 1) running[j].cancel();
        nodes[i].animate(
          [{ transform: 'translateY(' + dy + 'px)' }, { transform: 'translateY(0px)' }],
          { duration: 150, easing: 'cubic-bezier(0.2, 0, 0, 1)' }
        );
      }
    }

    function makeGhost(mod, rect) {
      var spec = specOf(mod.type);
      var ghost = el('div', 'drag-ghost');
      ghost.style.width = Math.round(rect.width) + 'px';
      var head = el('div', 'module-head');
      head.appendChild(el('span', 'module-grip', '⠿'));
      head.appendChild(el('span', 'module-icon', spec.icon || '▫'));
      head.appendChild(el('span', 'module-title', spec.label));
      ghost.appendChild(head);
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
      drag.ghost.style.transform = 'translate3d(' + (x + 14) + 'px,' + (y + 12) + 'px,0)';
    }

    function measureColumn(colEl) {
      return Array.prototype.slice.call(colEl.querySelectorAll('.module')).map(function (node) {
        var rect = node.getBoundingClientRect();
        return { el: node, mid: rect.top + rect.height / 2 };
      });
    }

    function computeTarget(x, y, fallback) {
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
      if (!colEl) return null;
      var column = Number(colEl.getAttribute('data-col'));
      if (!isFinite(column)) return null;
      // 同一栏连续划过时复用上次量好的中线，避免每个事件都读一遍布局。
      if (!drag.rects || drag.rects.col !== colEl) {
        drag.rects = { col: colEl, list: measureColumn(colEl) };
      }
      var list = drag.rects.list;
      for (var i = 0; i < list.length; i += 1) {
        if (y < list[i].mid) {
          return { colEl: colEl, column: column, before: list[i].el, position: i };
        }
      }
      return { colEl: colEl, column: column, before: null, position: list.length };
    }

    function updateGap(target, immediate) {
      if (!target || !drag) return;
      if (
        drag.target &&
        drag.target.colEl === target.colEl &&
        drag.target.position === target.position
      ) {
        return;
      }
      if (!drag.gap) {
        drag.gap = el('div', 'drop-gap');
        var h = drag.el.getBoundingClientRect().height;
        drag.gap.style.height = Math.round(Math.min(Math.max(h, 56), 220)) + 'px';
      }
      var move = function () {
        var addBtn = target.colEl.querySelector('.dash-add');
        if (target.before) target.colEl.insertBefore(drag.gap, target.before);
        else if (addBtn) target.colEl.insertBefore(drag.gap, addBtn);
        else target.colEl.appendChild(drag.gap);
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
      drag.target = target;
      // 槽位进了布局，各卡片中线全变了，下次划过要重量。
      drag.rects = null;
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

    function beginModuleDrag(mod, moduleEl, x, y) {
      var rect = moduleEl.getBoundingClientRect();
      drag = {
        id: mod.id,
        el: moduleEl,
        gap: null,
        ghost: makeGhost(mod, rect),
        target: null,
        rects: null
      };
      moduleEl.classList.add('is-dragging');
      document.body.classList.add('is-module-dragging');
      followGhost(x, y);
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

      if (commit && state.gap && state.gap.parentNode) {
        var colEl = state.gap.parentNode;
        colEl.insertBefore(state.el, state.gap);
        colEl.removeChild(state.gap);
        var column = Number(colEl.getAttribute('data-col'));
        var position = Array.prototype.indexOf.call(colEl.querySelectorAll('.module'), state.el);
        if (isFinite(column) && position >= 0) {
          moveModule(state.id, column, position);
          saveLayout(layout);
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
    function wireModuleDrag(mod, moduleEl, head) {
      head.addEventListener('pointerdown', function (event) {
        if (event.button !== 0 || event.isPrimary === false) return;
        // 标题栏里的按钮（⋯ 菜单）自己响应，别顺手把卡片拖起来。
        if (event.target && event.target.closest && event.target.closest('button')) return;
        // 挡掉文本选择：不然按住标题栏拖会顺手把标题选蓝。
        event.preventDefault();

        var startX = event.clientX;
        var startY = event.clientY;
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
            if (dx * dx + dy * dy < DRAG_THRESHOLD * DRAG_THRESHOLD) return;
            armed = true;
            beginModuleDrag(mod, moduleEl, moveEvent.clientX, moveEvent.clientY);
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
          if (!armed) return; // 只是点了一下标题栏，什么都没发生
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
      var left = clamp(rect.left + rect.width - width, 8, window.innerWidth - width - 8);
      var top = rect.bottom + 6;
      if (top + height > window.innerHeight - 8) top = Math.max(8, rect.top - height - 6);
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
      options.forEach(function (option) {
        var active = (mod.source && mod.source.mode) === source.mode && mod.source.value === option.value;
        container.appendChild(
          menuItem(option.label, function () {
            mod.source = { mode: source.mode, value: option.value };
            saveLayout(layout);
            closePop();
            render();
          }, { active: active })
        );
      });
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

    function openAddPop(anchor, columnIndex) {
      openPop(anchor, function (container) {
        container.appendChild(el('div', 'pop-title', '添加模块'));
        Object.keys(types).forEach(function (type) {
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

      moduleEl.appendChild(head);
      moduleEl.appendChild(body);
      moduleEl.appendChild(handle);
      applyHeight(moduleEl, mod);

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
    function snapshotDrafts() {
      var drafts = [];
      Array.prototype.forEach.call(root.querySelectorAll('input[id], textarea[id]'), function (field) {
        if (!field.value) return;
        var draft = {
          id: field.id,
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
        var field = document.getElementById(draft.id);
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

      for (var i = 0; i < columnCount; i += 1) {
        var columnEl = el('section', 'dash-col');
        columnEl.setAttribute('data-col', String(i));
        var mods = layout.modules.filter(function (item) {
          return item.column === i;
        });
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
      getLayout: function () {
        return layout;
      },
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
        render();
        return true;
      },
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
    mount: mount
  };
})();
