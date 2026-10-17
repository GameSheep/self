/**
 * Self-Hub In-Page Web Highlighting & Annotation Engine (Wucai Replacement)
 * Handles text selection, floating toolbar, anchoring, DOM highlights, and annotations.
 */

(() => {
  let activeToolbar = null;
  let activePopover = null;
  let currentSelectionRange = null;

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

    // Copy quote button
    const copyBtn = document.createElement('button');
    copyBtn.className = 'selfhub-btn';
    copyBtn.innerHTML = '📋 引用';
    copyBtn.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      e.preventDefault();
      const text = range.toString().trim();
      const md = `> ${text}\n>\n> —— 摘自 [${document.title}](${window.location.href})`;
      navigator.clipboard.writeText(md).then(() => {
        showToast('已复制 Markdown 引用格式');
        removeToolbar();
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

    // Anchor context (prefix up to 32 chars, suffix up to 32 chars)
    const containerText = range.commonAncestorContainer.textContent || '';
    const prefix = containerText.slice(Math.max(0, range.startOffset - 32), range.startOffset);
    const suffix = containerText.slice(range.endOffset, Math.min(containerText.length, range.endOffset + 32));

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

    // Save to background
    chrome.runtime.sendMessage({
      action: 'SAVE_ANNOTATION',
      annotation
    }, (res) => {
      showToast(`已高亮并存入 Self-Hub (${COLORS.find(c => c.id === color)?.label || ''})`);
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

    popover.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
        <span style="font-weight:600;font-size:12px;color:#a1a1aa;">Self-Hub 批注与思考</span>
        <div style="display:flex;gap:4px;">
          ${COLORS.map(c => `
            <span class="selfhub-color-dot" data-color="${c.id}" style="width:14px;height:14px;background-color:${c.hex};display:inline-block;" title="${c.label}"></span>
          `).join('')}
        </div>
      </div>
      <div style="font-size:11px;color:#71717a;margin-bottom:6px;max-height:40px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
        "${annotation.text}"
      </div>
      <textarea id="selfhub-note-input" placeholder="写下你的批注、技术思考或要点归纳...">${annotation.note || ''}</textarea>
      <div style="display:flex;align-items:center;justify-content:space-between;margin-top:8px;">
        <button id="selfhub-del-btn" style="background:transparent;border:none;color:#ef4444;font-size:11px;cursor:pointer;">删除划线</button>
        <div style="display:flex;gap:6px;">
          <button id="selfhub-cancel-btn" class="selfhub-btn">取消</button>
          <button id="selfhub-save-btn" class="selfhub-btn" style="background:#10b981;border-color:#10b981;color:#000;font-weight:600;">保存批注</button>
        </div>
      </div>
    `;

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
    const saveBtn = popover.querySelector('#selfhub-save-btn');
    const noteInput = popover.querySelector('#selfhub-note-input');
    saveBtn.addEventListener('click', () => {
      annotation.note = noteInput.value.trim();
      annotation.updatedAt = Date.now();
      markEl.setAttribute('title', annotation.note || '点击查看/编辑批注 (Self-Hub)');
      saveUpdatedAnnotation(annotation);
      showToast('批注已更新');
      removePopover();
    });

    // Delete
    const delBtn = popover.querySelector('#selfhub-del-btn');
    delBtn.addEventListener('click', () => {
      if (confirm('确定删除该条划线和批注吗？')) {
        chrome.runtime.sendMessage({
          action: 'DELETE_ANNOTATION',
          id: annotation.id
        }, () => {
          // Unwrap mark
          const parent = markEl.parentNode;
          while (markEl.firstChild) {
            parent.insertBefore(markEl.firstChild, markEl);
          }
          parent.removeChild(markEl);
          showToast('已删除划线');
          removePopover();
        });
      }
    });

    popover.querySelector('#selfhub-cancel-btn').addEventListener('click', removePopover);

    // Position
    const top = window.scrollY + rect.bottom + 8;
    const left = window.scrollX + rect.left;
    popover.style.top = `${top}px`;
    popover.style.left = `${Math.max(10, Math.min(window.innerWidth - 340, left))}px`;
    noteInput.focus();
  }

  function saveUpdatedAnnotation(annotation) {
    chrome.runtime.sendMessage({
      action: 'SAVE_ANNOTATION',
      annotation
    });
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
    chrome.runtime.sendMessage({
      action: 'GET_PAGE_ANNOTATIONS',
      url: window.location.href
    }, (res) => {
      if (!res || !res.annotations || res.annotations.length === 0) return;

      res.annotations.forEach(item => {
        if (!item.text) return;
        highlightTextInDocument(item);
      });
    });
  }

  function highlightTextInDocument(annotation) {
    if (!annotation.text || !annotation.text.trim()) return;

    // Search DOM text nodes with strict tag filtering to prevent script/style mutation
    const treeWalker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode: (node) => {
          const parent = node.parentElement;
          if (!parent) return NodeFilter.FILTER_REJECT;
          const tag = parent.tagName.toUpperCase();
          if (['SCRIPT', 'STYLE', 'TEXTAREA', 'INPUT', 'NOSCRIPT', 'SVG'].includes(tag)) {
            return NodeFilter.FILTER_REJECT;
          }
          if (parent.classList.contains('selfhub-highlight')) {
            return NodeFilter.FILTER_REJECT;
          }
          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );
    let node;
    while ((node = treeWalker.nextNode())) {
      const idx = node.textContent.indexOf(annotation.text);
      if (idx !== -1) {

        const range = document.createRange();
        range.setStart(node, idx);
        range.setEnd(node, idx + annotation.text.length);

        const mark = document.createElement('mark');
        mark.className = `selfhub-highlight selfhub-hl-${annotation.color || 'yellow'}`;
        mark.setAttribute('data-selfhub-id', annotation.id);
        mark.setAttribute('title', annotation.note || '点击查看/编辑批注 (Self-Hub)');
        mark.addEventListener('click', (e) => {
          e.stopPropagation();
          showAnnotationPopover(mark, annotation);
        });

        try {
          range.surroundContents(mark);
        } catch {}
        break; // matched
      }
    }
  }

  // Bridge for Self-Hub Web App (localhost, 127.0.0.1, or any page identified by Self-Hub meta tag/title)
  const isSelfHubApp = window.location.hostname === 'localhost' || 
                       window.location.hostname === '127.0.0.1' || 
                       Boolean(document.querySelector('meta[name="application-name"][content*="Self-Hub"]')) ||
                       document.title.includes('Self-Hub');

  if (isSelfHubApp) {
    window.addEventListener('message', (event) => {
      if (event.data && event.data.type === 'SELFHUB_REQUEST_EXTENSION_DATA') {
        chrome.runtime.sendMessage({ action: 'GET_ALL_ANNOTATIONS' }, (res) => {
          window.postMessage({
            type: 'SELFHUB_RECEIVE_EXTENSION_DATA',
            annotations: res?.annotations || []
          }, '*');
        });
      }
    });
  }

  // Auto restore on load
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', restoreSavedHighlights);
  } else {
    restoreSavedHighlights();
  }

})();
