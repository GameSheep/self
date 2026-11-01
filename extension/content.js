/**
 * Self-Hub In-Page Web Highlighting & Annotation Engine (Wucai Replacement)
 * Handles text selection, floating toolbar, anchoring, DOM highlights, and annotations.
 */

(() => {
  let activeToolbar = null;
  let activePopover = null;
  let currentSelectionRange = null;

  /**
   * Protocol envelope for the background command API (P2-04).
   *
   * Content scripts cannot import the shared client (modules are not allowed
   * here), so the envelope is built in this one helper. The response shape is
   * { requestId, ok, data | error }; a failure carries a code so a caller can
   * tell "forbidden" from "broken".
   */
  function newRequestId() {
    // requestId must be a non-empty *string* (protocol.js validates this).
    return 'req-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  /**
   * Human-readable translation for the one error a reload actually causes.
   *
   * After the extension is reloaded/updated in chrome://extensions, tabs opened
   * *before* that keep running the old content-script instance whose
   * `chrome.runtime` binding is dead: every send throws "Extension context
   * invalidated". Nothing on this page can fix it — the tab must be refreshed so
   * the new instance injects. Say that, in the user's language, instead of
   * surfacing Chrome's raw English error.
   */
  function translateSendError(message) {
    if (/Extension context invalidated/i.test(message)) {
      return '扩展刚被重新加载，本页面还是旧实例，刷新这个网页（F5）后重试即可';
    }
    return message || '扩展未响应';
  }

  function sendCommand(command, payload) {
    return new Promise((resolve, reject) => {
      const message = {
        protocolVersion: 1,
        requestId: newRequestId(),
        command,
        payload: payload || {}
      };
      try {
        chrome.runtime.sendMessage(message, (response) => {
          const lastError = chrome.runtime.lastError;
          if (lastError) {
            reject(new Error(translateSendError(lastError.message)));
            return;
          }
          if (!response || typeof response !== 'object') {
            reject(new Error('扩展返回了空响应'));
            return;
          }
          if (!response.ok) {
            const error = new Error(response.error?.message || '命令失败');
            error.code = response.error?.code || 'INTERNAL';
            reject(error);
            return;
          }
          resolve(response.data);
        });
      } catch (err) {
        reject(new Error(translateSendError(err?.message || String(err))));
      }
    });
  }

  /** Every write carries an operationId so a retry cannot duplicate the record. */
  function operationId(prefix) {
    return [
      prefix,
      Date.now().toString(36),
      Math.random().toString(36).slice(2, 8)
    ].join('-');
  }

  const COLORS = [
    { id: 'yellow', hex: '#fde047', label: '黄色' },
    { id: 'green', hex: '#86efac', label: '绿色' },
    { id: 'blue', hex: '#93c5fd', label: '蓝色' },
    { id: 'purple', hex: '#d8b4fe', label: '紫色' },
    { id: 'red', hex: '#fca5a5', label: '红色' }
  ];

  // 1. Listen for mouseup to detect text selection
  document.addEventListener('mouseup', handleMouseUp);
  document.addEventListener('mousedown', (e) => {
    // If click is outside toolbar and popover, dismiss them
    if (activeToolbar && !activeToolbar.contains(e.target)) {
      removeToolbar();
    }
    if (activePopover && !activePopover.contains(e.target)) {
      removePopover();
    }
  });

  // Keyboard shortcut Alt+H to quickly highlight with default yellow
  document.addEventListener('keydown', (e) => {
    if (e.altKey && (e.key === 'h' || e.key === 'H')) {
      const sel = window.getSelection();
      if (sel && sel.toString().trim().length > 0) {
        e.preventDefault();
        saveHighlight('yellow');
      }
    }
  });

  // Handle messages from background service worker
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === 'TRIGGER_HIGHLIGHT_FROM_MENU') {
      saveHighlight('yellow');
    } else if (msg.action === 'SHOW_TOAST') {
      showToast(msg.message);
    } else if (msg.action === 'SCROLL_TO_ANNOTATION') {
      scrollToAnnotation(msg.id);
    }
  });

  function handleMouseUp(e) {
    if (activeToolbar && activeToolbar.contains(e.target)) return;
    if (activePopover && activePopover.contains(e.target)) return;

    setTimeout(() => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.toString().trim().length === 0) {
        removeToolbar();
        return;
      }

      const range = sel.getRangeAt(0);
      currentSelectionRange = range.cloneRange();
      showFloatingToolbar(range);
    }, 20);
  }

  function showFloatingToolbar(range) {
    removeToolbar();

    const rect = range.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return;

    const toolbar = document.createElement('div');
    toolbar.id = 'selfhub-floating-toolbar';

    // Color swatches
    COLORS.forEach(c => {
      const dot = document.createElement('div');
      dot.className = 'selfhub-color-dot';
      dot.style.backgroundColor = c.hex;
      dot.title = `高亮 (${c.label})`;
      dot.addEventListener('mousedown', (e) => {
        e.stopPropagation();
        e.preventDefault();
        saveHighlight(c.id);
      });
      toolbar.appendChild(dot);
    });

    // Divider
    const div = document.createElement('div');
    div.className = 'selfhub-divider';
    toolbar.appendChild(div);

    // Note button
    const noteBtn = document.createElement('button');
    noteBtn.className = 'selfhub-btn';
    noteBtn.innerHTML = '📝 批注';
    noteBtn.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      e.preventDefault();
      saveHighlight('yellow', true);
    });
    toolbar.appendChild(noteBtn);

    // Copy button: plain selected text, no quote formatting.
    const copyBtn = document.createElement('button');
    copyBtn.className = 'selfhub-btn';
    copyBtn.innerHTML = '📋 复制';
    copyBtn.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      e.preventDefault();
      const text = range.toString().trim();
      const done = () => {
        showToast('已复制选中内容');
        removeToolbar();
      };
      navigator.clipboard.writeText(text).then(done).catch(() => {
        // 剪贴板 API 被页面策略拒绝时退回 execCommand，而不是静默失败。
        try {
          const ta = document.createElement('textarea');
          ta.value = text;
          ta.style.position = 'fixed';
          ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          ta.remove();
          done();
        } catch (err) {
          showToast('复制失败，请手动选择复制');
          removeToolbar();
        }
      });
    });
    toolbar.appendChild(copyBtn);

    document.body.appendChild(toolbar);
    activeToolbar = toolbar;

    // Position toolbar above selection
    const top = window.scrollY + rect.top - 46;
    const left = window.scrollX + rect.left + (rect.width / 2) - (toolbar.offsetWidth / 2);

    toolbar.style.top = `${Math.max(10, top)}px`;
    toolbar.style.left = `${Math.max(10, Math.min(window.innerWidth - toolbar.offsetWidth - 20, left))}px`;
  }

  function removeToolbar() {
    if (activeToolbar) {
      activeToolbar.remove();
      activeToolbar = null;
    }
  }

  function removePopover() {
    if (activePopover) {
      activePopover.remove();
      activePopover = null;
    }
  }

  function saveHighlight(color = 'yellow', openNote = false) {
    if (!currentSelectionRange) return;

    const range = currentSelectionRange;
    const text = range.toString().trim();
    if (!text) return;

    // Anchor context (prefix up to 32 chars, suffix up to 32 chars).
    // Range offsets are character offsets inside a text node, but *child
    // indexes* when the boundary container is an element — slicing the
    // container's whole textContent by them produced garbage context. Read
    // each boundary from its own container instead.
    const boundaryText = (node, offset, side) => {
      if (!node) return '';
      if (node.nodeType === Node.TEXT_NODE) {
        return side === 'before'
          ? node.textContent.slice(Math.max(0, offset - 32), offset)
          : node.textContent.slice(offset, Math.min(node.textContent.length, offset + 32));
      }
      const kids = Array.from(node.childNodes);
      const grab = (child) => child.textContent || '';
      if (side === 'before') {
        let acc = '';
        for (let i = Math.min(offset, kids.length) - 1; i >= 0 && acc.length < 32; i--) {
          acc = grab(kids[i]) + acc;
        }
        return acc.slice(-32);
      }
      let acc = '';
      for (let i = Math.max(offset, 0); i < kids.length && acc.length < 32; i++) {
        acc += grab(kids[i]);
      }
      return acc.slice(0, 32);
    };
    const prefix = boundaryText(range.startContainer, range.startOffset, 'before');
    const suffix = boundaryText(range.endContainer, range.endOffset, 'after');

    const id = `hl-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const annotation = {
      id,
      pageUrl: window.location.href,
      pageTitle: document.title,
      text,
      note: '',
      color,
      tags: [],
      anchor: {
        prefix,
        suffix,
        startOffset: range.startOffset,
        endOffset: range.endOffset
      },
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    // Apply DOM mark
    wrapRangeWithHighlight(range, annotation);

    // Save through the background's command API (single writer).
    sendCommand('SAVE_ANNOTATION', { annotation, operationId: operationId('ann-save') })
      .then(() => {
        showToast(`已高亮并存入 Self-Hub (${COLORS.find(c => c.id === color)?.label || ''})`);
      })
      .catch((err) => {
        showToast(`保存失败：${err.message || '扩展未响应'}`);
      });

    removeToolbar();
    window.getSelection()?.removeAllRanges();

    if (openNote) {
      setTimeout(() => {
        const mark = document.querySelector(`mark[data-selfhub-id="${id}"]`);
        if (mark) {
          showAnnotationPopover(mark, annotation);
        }
      }, 50);
    }
  }

  function wrapRangeWithHighlight(range, annotation) {
    try {
      const mark = document.createElement('mark');
      mark.className = `selfhub-highlight selfhub-hl-${annotation.color}`;
      mark.setAttribute('data-selfhub-id', annotation.id);
      mark.setAttribute('title', annotation.note || '点击查看/编辑批注 (Self-Hub)');

      mark.addEventListener('click', (e) => {
        e.stopPropagation();
        showAnnotationPopover(mark, annotation);
      });

      range.surroundContents(mark);
    } catch (e) {
      // Non-destructive fallback for cross-block / nested element selections
      const textNodes = getTextNodesInRange(range);
      textNodes.forEach(node => {
        const start = (node === range.startContainer) ? range.startOffset : 0;
        const end = (node === range.endContainer) ? range.endOffset : node.textContent.length;
        if (start < end) {
          const subRange = document.createRange();
          subRange.setStart(node, start);
          subRange.setEnd(node, end);
          try {
            const m = document.createElement('mark');
            m.className = `selfhub-highlight selfhub-hl-${annotation.color}`;
            m.setAttribute('data-selfhub-id', annotation.id);
            m.setAttribute('title', annotation.note || '点击查看/编辑批注 (Self-Hub)');
            m.addEventListener('click', (ev) => {
              ev.stopPropagation();
              showAnnotationPopover(m, annotation);
            });
            subRange.surroundContents(m);
          } catch {}
        }
      });
    }
  }

  function getTextNodesInRange(range) {
    const textNodes = [];
    const root = range.commonAncestorContainer;
    const walker = document.createTreeWalker(
      root.nodeType === Node.TEXT_NODE ? root.parentNode : root,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          if (!node.textContent || !node.textContent.trim()) return NodeFilter.FILTER_REJECT;
          const nodeRange = document.createRange();
          nodeRange.selectNodeContents(node);
          return range.compareBoundaryPoints(Range.END_TO_START, nodeRange) < 0 &&
                 range.compareBoundaryPoints(Range.START_TO_END, nodeRange) > 0
            ? NodeFilter.FILTER_ACCEPT
            : NodeFilter.FILTER_REJECT;
        }
      }
    );

    while (walker.nextNode()) {
      textNodes.push(walker.currentNode);
    }
    return textNodes;
  }

  function showAnnotationPopover(markEl, annotation) {
    removePopover();

    const rect = markEl.getBoundingClientRect();
    const popover = document.createElement('div');
    popover.id = 'selfhub-annotation-popover';

    // Built with DOM APIs: annotation.text comes from arbitrary web pages and
    // annotation.note is persisted user input — interpolating either into
    // innerHTML was a stored-XSS sink.
    const header = document.createElement('div');
    header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;';

    const headerTitle = document.createElement('span');
    headerTitle.style.cssText = 'font-weight:600;font-size:12px;color:#71717a;';
    headerTitle.textContent = 'Self-Hub 批注与思考';
    header.appendChild(headerTitle);

    const dotRow = document.createElement('div');
    dotRow.style.cssText = 'display:flex;gap:4px;';
    COLORS.forEach((c) => {
      const dot = document.createElement('span');
      dot.className = 'selfhub-color-dot';
      dot.setAttribute('data-color', c.id);
      dot.title = c.label;
      dot.style.cssText = 'width:14px;height:14px;background-color:' + c.hex + ';display:inline-block;';
      dotRow.appendChild(dot);
    });
    header.appendChild(dotRow);
    popover.appendChild(header);

    const quoted = document.createElement('div');
    quoted.style.cssText = 'font-size:11px;color:#71717a;margin-bottom:6px;max-height:40px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
    quoted.textContent = '"' + (annotation.text || '') + '"';
    popover.appendChild(quoted);

    const noteInput = document.createElement('textarea');
    noteInput.id = 'selfhub-note-input';
    noteInput.placeholder = '写下你的批注、技术思考或要点归纳...';
    noteInput.value = annotation.note || '';
    popover.appendChild(noteInput);

    const footer = document.createElement('div');
    footer.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-top:8px;';

    const delBtn = document.createElement('button');
    delBtn.id = 'selfhub-del-btn';
    delBtn.textContent = '删除划线';
    delBtn.style.cssText = 'background:transparent;border:none;color:#ef4444;font-size:11px;cursor:pointer;';
    footer.appendChild(delBtn);

    const footerRight = document.createElement('div');
    footerRight.style.cssText = 'display:flex;gap:6px;';

    const cancelBtn = document.createElement('button');
    cancelBtn.id = 'selfhub-cancel-btn';
    cancelBtn.className = 'selfhub-btn';
    cancelBtn.textContent = '取消';
    footerRight.appendChild(cancelBtn);

    const saveBtn = document.createElement('button');
    saveBtn.id = 'selfhub-save-btn';
    saveBtn.className = 'selfhub-btn';
    saveBtn.textContent = '保存批注';
    saveBtn.style.cssText = 'background:#10b981;border-color:#10b981;color:#000;font-weight:600;';
    footerRight.appendChild(saveBtn);

    footer.appendChild(footerRight);
    popover.appendChild(footer);

    document.body.appendChild(popover);
    activePopover = popover;

    // Color switch
    popover.querySelectorAll('.selfhub-color-dot').forEach(dot => {
      dot.addEventListener('click', () => {
        const newColor = dot.getAttribute('data-color');
        annotation.color = newColor;
        markEl.className = `selfhub-highlight selfhub-hl-${newColor}`;
        saveUpdatedAnnotation(annotation);
      });
    });

    // Save Note
    saveBtn.addEventListener('click', () => {
      annotation.note = noteInput.value.trim();
      annotation.updatedAt = Date.now();
      markEl.setAttribute('title', annotation.note || '点击查看/编辑批注 (Self-Hub)');
      saveUpdatedAnnotation(annotation);
      showToast('批注已更新');
      removePopover();
    });

    // Delete
    delBtn.addEventListener('click', () => {
      if (confirm('确定删除该条划线和批注吗？')) {
        sendCommand('DELETE_ANNOTATION', {
          id: annotation.id,
          operationId: operationId('ann-del')
        }).then(() => {
          // Unwrap mark
          const parent = markEl.parentNode;
          while (markEl.firstChild) {
            parent.insertBefore(markEl.firstChild, markEl);
          }
          parent.removeChild(markEl);
          showToast('已删除划线');
          removePopover();
        }).catch((err) => {
          showToast(`删除失败：${err.message || '扩展未响应'}`);
        });
      }
    });

    cancelBtn.addEventListener('click', removePopover);

    // Position
    const top = window.scrollY + rect.bottom + 8;
    const left = window.scrollX + rect.left;
    popover.style.top = `${top}px`;
    popover.style.left = `${Math.max(10, Math.min(window.innerWidth - 340, left))}px`;
    noteInput.focus();
  }

  function saveUpdatedAnnotation(annotation) {
    sendCommand('SAVE_ANNOTATION', {
      annotation,
      operationId: operationId('ann-update')
    }).catch((err) => showToast(`保存失败：${err.message || '扩展未响应'}`));
  }

  function scrollToAnnotation(id) {
    const mark = document.querySelector(`mark[data-selfhub-id="${id}"]`);
    if (mark) {
      mark.scrollIntoView({ behavior: 'smooth', block: 'center' });
      mark.style.outline = '3px solid #10b981';
      setTimeout(() => {
        mark.style.outline = '';
      }, 1500);
    }
  }

  function showToast(msg) {
    const existing = document.getElementById('selfhub-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.id = 'selfhub-toast';
    toast.innerText = msg;
    document.body.appendChild(toast);

    setTimeout(() => {
      toast.remove();
    }, 2400);
  }

  // Restore saved highlights for this page on load
  function restoreSavedHighlights() {
    // The background derives the page URL from the sender, so a mismatch between
    // the claimed URL and the real tab is rejected instead of trusted.
    sendCommand('GET_PAGE_ANNOTATIONS', { url: window.location.href })
      .then((data) => {
        console.log('[Self-Hub][debug] restore got', data && data.annotations && data.annotations.length, 'annotations for', location.href);
        if (!data || !Array.isArray(data.annotations) || data.annotations.length === 0) return;
        data.annotations.forEach((item) => {
          if (!item.text) return;
          highlightTextInDocument(item);
        });
      })
      .catch((err) => console.warn('[Self-Hub] restoring highlights failed', err));
  }

  /** 可高亮的文本节点收集（跳过脚本/样式/已包裹的节点）。 */
  function collectTextNodes(root) {
    const nodes = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => {
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        const tag = parent.tagName.toUpperCase();
        if (['SCRIPT', 'STYLE', 'TEXTAREA', 'INPUT', 'NOSCRIPT', 'SVG'].includes(tag)) {
          return NodeFilter.FILTER_REJECT;
        }
        if (parent.closest('.selfhub-highlight')) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    let node;
    while ((node = walker.nextNode())) nodes.push(node);
    return nodes;
  }

  /**
   * 锚定感知的区间查找：在拼接后的全文里找 annotation.text 的所有出现，
   * 用 anchor（prefix/suffix/startOffset）给候选打分——划同一句话两次、
   * 页面改版后偏移漂移，靠上下文而不是只靠首匹配。
   * 返回 { startNode, startOffset, endNode, endOffset } 或 null。
   */
  function findAnchoredRange(annotation, nodes) {
    const boundary = annotation.text;
    const parts = [];
    let total = 0;
    nodes.forEach((node) => {
      parts.push({ node, start: total, text: node.textContent });
      total += node.textContent.length;
    });
    if (!total) return null;

    const haystack = parts.map((p) => p.text).join('');
    const candidates = [];
    let from = 0;
    while (true) {
      const at = haystack.indexOf(boundary, from);
      if (at === -1) break;
      let score = 0;
      if (annotation.anchor && annotation.anchor.prefix && haystack.slice(Math.max(0, at - annotation.anchor.prefix.length), at) === annotation.anchor.prefix) score += 2;
      if (annotation.anchor && annotation.anchor.suffix && haystack.slice(at + boundary.length, at + boundary.length + annotation.anchor.suffix.length) === annotation.anchor.suffix) score += 2;
      if (annotation.anchor && Number.isFinite(annotation.anchor.startOffset)) {
        score += Math.max(0, 1 - Math.abs(at - annotation.anchor.startOffset) / 500);
      }
      candidates.push({ at, score });
      from = at + 1;
    }
    if (!candidates.length) return null;
    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0].at;
    const stop = best + boundary.length;

    // 拼接坐标 → 节点坐标。
    let startNode = null, startOffset = 0, endNode = null, endOffset = 0;
    for (const part of parts) {
      const partEnd = part.start + part.text.length;
      if (!startNode && best < partEnd) {
        startNode = part.node;
        startOffset = best - part.start;
      }
      if (stop <= partEnd && stop > part.start) {
        endNode = part.node;
        endOffset = stop - part.start;
        break;
      }
    }
    if (!startNode || !endNode) return null;
    return { startNode, startOffset, endNode, endOffset };
  }

  /** 把区间（可跨节点）按节点逐段包上 mark，共用同一个批注 id。 */
  function highlightRange(range, annotation) {
    const nodes = [];
    const walker = document.createTreeWalker(
      range.commonAncestorContainer,
      NodeFilter.SHOW_TEXT,
      { acceptNode: (node) => (range.intersectsNode(node) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT) }
    );
    let node;
    while ((node = walker.nextNode())) nodes.push(node);

    nodes.forEach((node) => {
      const startAt = node === range.startContainer ? range.startOffset : 0;
      const endAt = node === range.endContainer ? range.endOffset : node.textContent.length;
      if (endAt <= startAt) return;
      const parent = node.parentElement;
      if (!parent || parent.closest('.selfhub-highlight')) return;

      const slice = document.createTextNode(node.textContent.slice(startAt, endAt));
      const mark = document.createElement('mark');
      mark.className = 'selfhub-highlight selfhub-hl-' + (annotation.color || 'yellow');
      mark.setAttribute('data-selfhub-id', annotation.id);
      mark.setAttribute('title', annotation.note || '点击查看/编辑批注 (Self-Hub)');
      mark.appendChild(slice);
      mark.addEventListener('click', (e) => {
        e.stopPropagation();
        showAnnotationPopover(mark, annotation);
      });
      parent.insertBefore(mark, node);
      const rest = document.createTextNode(node.textContent.slice(endAt));
      if (rest.textContent) parent.insertBefore(rest, node.nextSibling);
      parent.removeChild(node);
    });
  }

  function highlightTextInDocument(annotation) {
    if (!annotation.text || !annotation.text.trim()) return;
    const nodes = collectTextNodes(document.body);
    const rangeSpec = findAnchoredRange(annotation, nodes);
    if (!rangeSpec) return; // 页面改版找不到原文：保持安静，批注仍在库里
    const range = document.createRange();
    range.setStart(rangeSpec.startNode, rangeSpec.startOffset);
    range.setEnd(rangeSpec.endNode, rangeSpec.endOffset);
    highlightRange(range, annotation);
  }

  /*
   * The old `window.postMessage` bridge into the Self-Hub page is gone.
   *
   * It let any page that merely *looked* like the app (localhost, or a page whose
   * title contained "Self-Hub") ask this content script for the whole annotation
   * library. Dev doc §9.2 forbids exactly that: "不依赖万能 postMessage 桥", and a
   * content script must not be able to read the library on behalf of the page it
   * runs in. A content script may only submit captures for its own page.
   *
   * The packed app is itself an extension page, so it talks to the background
   * directly (`GET_ALL_ANNOTATIONS` is allowed for page senders) — no bridge
   * through an untrusted document is needed.
   */
  /*
   * The old `window.postMessage` bridge into the Self-Hub page is gone.
   *
   * It let any page that merely *looked* like the app (localhost, or a page whose
   * title contained "Self-Hub") ask this content script for the whole annotation
   * library. Dev doc §9.2 forbids exactly that: "不依赖万能 postMessage 桥", and a
   * content script must not be able to read the library on behalf of the page it
   * runs in. A content script may only submit captures for its own page.
   *
   * The packed app is itself an extension page, so it talks to the background
   * directly (`GET_ALL_ANNOTATIONS` is allowed for page senders) — no bridge
   * through an untrusted document is needed.
   */

  // Auto restore on load
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', restoreSavedHighlights);
  } else {
    restoreSavedHighlights();
  }

})();
