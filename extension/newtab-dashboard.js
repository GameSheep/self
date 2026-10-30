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

    /* — 列宽 — */

    function applyWidths() {
      if (!cols.length) return;
      var narrow = window.innerWidth <= 1180;
      if (narrow) {
        cols.forEach(function (col) {
          col.style.flex = '1 1 auto';
          col.style.width = 'auto';
        });
        return;
      }
      var gaps = RESIZER_PX * (cols.length - 1);
      var avail = Math.max(320, root.clientWidth - gaps);
      var sum = layout.columns.reduce(function (acc, column) {
        return acc + column.fr;
      }, 0) || 1;
      layout.columns.forEach(function (column, index) {
        var width = Math.max(120, Math.round((avail * column.fr) / sum));
        cols[index].style.flex = '0 0 ' + width + 'px';
        cols[index].style.width = width + 'px';
      });
    }

    function beginColumnDrag(index, event) {
      event.preventDefault();
      var left = cols[index];
      var right = cols[index + 1];
      if (!left || !right) return;
      var startX = event.clientX;
      var a = left.getBoundingClientRect().width;
      var b = right.getBoundingClientRect().width;
      var sumPx = a + b;
      var sumFr = layout.columns[index].fr + layout.columns[index + 1].fr;
      var minPx = Math.min(MIN_COL_PX, sumPx / 2);
      document.body.classList.add('is-col-resizing');

      function onMove(moveEvent) {
        var nextA = clamp(a + (moveEvent.clientX - startX), minPx, sumPx - minPx);
        layout.columns[index].fr = (sumFr * nextA) / sumPx;
        layout.columns[index + 1].fr = (sumFr * (sumPx - nextA)) / sumPx;
        applyWidths();
      }
      function onUp() {
        document.body.classList.remove('is-col-resizing');
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        saveLayout(layout);
      }
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
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
      var moved = false;
      document.body.classList.add('is-module-resizing');

      function onMove(moveEvent) {
        var dy = moveEvent.clientY - startY;
        if (!moved && Math.abs(dy) < 3) return;
        moved = true;
        mod.height = Math.max(MIN_MODULE_PX, Math.round(startH + dy));
        applyHeight(moduleEl, mod);
      }
      function onUp() {
        document.body.classList.remove('is-module-resizing');
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        if (moved) saveLayout(layout);
      }
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    }

    /* — 拖拽排序 — */

    var dragId = null;
    var dropLine = el('div', 'drop-line');

    function clearDropLine() {
      if (dropLine.parentNode) dropLine.parentNode.removeChild(dropLine);
    }

    function positionDropLine(columnEl, clientY) {
      var modules = Array.prototype.slice.call(columnEl.querySelectorAll('.module'));
      var before = null;
      for (var i = 0; i < modules.length; i += 1) {
        var rect = modules[i].getBoundingClientRect();
        if (clientY < rect.top + rect.height / 2) {
          before = modules[i];
          break;
        }
      }
      if (before) columnEl.insertBefore(dropLine, before);
      else columnEl.insertBefore(dropLine, columnEl.querySelector('.dash-add'));
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
      head.draggable = true;
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

      head.addEventListener('dragstart', function (event) {
        dragId = mod.id;
        moduleEl.classList.add('is-dragging');
        try {
          event.dataTransfer.setData('text/plain', mod.id);
          event.dataTransfer.effectAllowed = 'move';
        } catch (err) {
          /* some contexts do not expose dataTransfer */
        }
      });
      head.addEventListener('dragend', function () {
        dragId = null;
        moduleEl.classList.remove('is-dragging');
        clearDropLine();
      });

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

    function render() {
      closePop();
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

        // 注意：这里必须用 `event.currentTarget`，不能用闭包里的 `columnEl`。
        // `var` 是函数作用域，三个栏共用同一个变量，闭包拿到的永远是最后一栏。
        columnEl.addEventListener('dragover', function (index) {
          return function (event) {
            if (!dragId) return;
            event.preventDefault();
            positionDropLine(event.currentTarget, event.clientY);
          };
        }(i));
        columnEl.addEventListener('drop', function (index) {
          return function (event) {
            if (!dragId) return;
            event.preventDefault();
            var column = event.currentTarget;
            var before = dropLine.parentNode === column ? dropLine.nextElementSibling : null;
            var targetModules = Array.prototype.slice.call(column.querySelectorAll('.module'));
            var position = targetModules.length;
            if (before && before.classList && before.classList.contains('module')) {
              position = targetModules.indexOf(before);
            }
            moveModule(dragId, index, position);
            dragId = null;
            clearDropLine();
            saveLayout(layout);
            render();
          };
        }(i));

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

      applyWidths();
    }

    function refreshBodies(onlyTypes) {
      var wanted = onlyTypes && onlyTypes.length ? onlyTypes : null;
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
    }

    window.addEventListener('resize', applyWidths);
    render();

    return {
      getLayout: function () {
        return layout;
      },
      render: render,
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
    loadLayout: loadLayout,
    saveLayout: saveLayout,
    mount: mount
  };
})();
