import React, { useCallback, useDeferredValue, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  Bold,
  Italic,
  Strikethrough,
  Code,
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  ListChecks,
  Quote,
  Link2,
  Image as ImageIcon,
  Table as TableIcon,
  AlertOctagon,
  FileCode2,
  Save,
  Eye,
  Columns2,
  PencilLine,
  Loader2
} from 'lucide-react';
import { Markdown } from './Markdown';
import type { MarkdownContext, MarkdownHeading } from '../lib/markdown/render';

export type EditorMode = 'edit' | 'split' | 'preview';

interface MarkdownEditorProps {
  value: string;
  onChange: (next: string) => void;
  /** Stable id of the note being edited; switching it resets the preview scroll. */
  noteKey?: string;
  /** Ctrl/Cmd+S handler. */
  onSave?: () => void;
  mode: EditorMode;
  onModeChange: (mode: EditorMode) => void;
  /** Preview context (wikilinks, tags, images, task toggling). */
  previewCtx?: MarkdownContext;
  dirty?: boolean;
  saving?: boolean;
  placeholder?: string;
  /** Rendered on the right of the status bar. */
  statusRight?: React.ReactNode;
  onHeadings?: (headings: MarkdownHeading[]) => void;
  /**
   * Upload a pasted/dropped file (usually a screenshot) and return the
   * vault-relative path to insert, or null on failure.
   */
  onUploadFile?: (file: File) => Promise<string | null>;
  /** 供宿主页面定位内部 textarea（e2e 用）。 */
  textareaTestId?: string;
}

interface Edit {
  text: string;
  selectionStart: number;
  selectionEnd: number;
}

/* ------------------------------------------------------------- edit helpers */

function wrapSelection(value: string, start: number, end: number, before: string, after: string): Edit {
  const selected = value.slice(start, end);
  const text = value.slice(0, start) + before + selected + after + value.slice(end);
  const caretStart = start + before.length;
  return { text, selectionStart: caretStart, selectionEnd: caretStart + selected.length };
}

function prefixLines(value: string, start: number, end: number, prefix: string | ((index: number) => string)): Edit {
  const lineStart = value.lastIndexOf('\n', start - 1) + 1;
  const lineEnd = value.indexOf('\n', end);
  const stop = lineEnd === -1 ? value.length : lineEnd;
  const block = value.slice(lineStart, stop);
  const lines = block.split('\n');

  // Toggle off when every line already carries the prefix.
  const prefixes = lines.map((_, i) => (typeof prefix === 'function' ? prefix(i) : prefix));
  const alreadyApplied = lines.every((line, i) => line.startsWith(prefixes[i]));
  const nextLines = lines.map((line, i) =>
    alreadyApplied ? line.slice(prefixes[i].length) : `${prefixes[i]}${line}`
  );
  const text = value.slice(0, lineStart) + nextLines.join('\n') + value.slice(stop);
  const delta = nextLines.join('\n').length - block.length;
  return { text, selectionStart: start + (alreadyApplied ? -prefixes[0].length : prefixes[0].length), selectionEnd: end + delta };
}

function insertBlock(value: string, start: number, end: number, block: string): Edit {
  const needsLeadingNewline = start > 0 && value[start - 1] !== '\n';
  const text = `${value.slice(0, start)}${needsLeadingNewline ? '\n' : ''}${block}${value.slice(end)}`;
  const caret = start + (needsLeadingNewline ? 1 : 0);
  return { text, selectionStart: caret, selectionEnd: caret + block.length };
}

/**
 * Remove up to one level of indentation (≤2 spaces or 1 tab) per selected line.
 * `prefixLines('')` was a no-op (startsWith('') is always true and the slice is
 * identity), which made Shift+Tab do nothing at all.
 */
function outdentLines(value: string, start: number, end: number): Edit {
  const lineStart = value.lastIndexOf('\n', start - 1) + 1;
  const lineEnd = value.indexOf('\n', end);
  const stop = lineEnd === -1 ? value.length : lineEnd;
  const block = value.slice(lineStart, stop);
  const lines = block.split('\n');
  let firstStrip = 0;
  const nextLines = lines.map((line, i) => {
    const strip = /^( {1,2}|\t)/.exec(line)?.[0].length || 0;
    if (i === 0) firstStrip = strip;
    return strip > 0 ? line.slice(strip) : line;
  });
  const text = value.slice(0, lineStart) + nextLines.join('\n') + value.slice(stop);
  const delta = nextLines.join('\n').length - block.length;
  return { text, selectionStart: Math.max(lineStart, start - firstStrip), selectionEnd: end + delta };
}

const TABLE_TEMPLATE = `| 列 1 | 列 2 |\n| --- | --- |\n|  |  |\n`;

/* -------------------------------------------------------------- component */

export const MarkdownEditor: React.FC<MarkdownEditorProps> = ({
  value,
  onChange,
  noteKey,
  onSave,
  mode,
  onModeChange,
  previewCtx,
  dirty,
  saving,
  placeholder,
  statusRight,
  onHeadings,
  onUploadFile,
  textareaTestId
}) => {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const previewRef = useRef<HTMLDivElement | null>(null);
  const syncing = useRef<'none' | 'left' | 'right'>('none');

  const [headings, setHeadings] = useState<MarkdownHeading[]>([]);

  /**
   * The preview lags one priority level behind the textarea.
   * Re-rendering a 100k+ character note costs a few hundred milliseconds; without
   * this every keystroke would block on the full markdown re-render.
   */
  const deferredValue = useDeferredValue(value);
  const previewStale = deferredValue !== value;

  const applyEdit = useCallback(
    (edit: Edit, replaceRange?: { start: number; end: number }) => {
      const el = textareaRef.current;
      // Prefer a real browser edit command: programmatically setting a
      // controlled textarea's value wipes the native undo stack, so Ctrl+Z
      // after a toolbar action jumped to some earlier typing state instead of
      // undoing the formatting. execCommand keeps undo working; fall back to
      // the plain assignment when it is unavailable or refuses.
      if (el && replaceRange && typeof document !== 'undefined' && document.execCommand) {
        try {
          el.focus();
          el.setSelectionRange(replaceRange.start, replaceRange.end);
          const ok = document.execCommand('insertText', false, edit.text);
          if (ok && el.value === edit.text) {
            requestAnimationFrame(() => {
              const ta = textareaRef.current;
              if (!ta) return;
              ta.setSelectionRange(edit.selectionStart, edit.selectionEnd);
            });
            return;
          }
        } catch {
          /* fall through to the controlled update */
        }
      }
      onChange(edit.text);
      requestAnimationFrame(() => {
        const ta = textareaRef.current;
        if (!ta) return;
        ta.focus();
        ta.setSelectionRange(edit.selectionStart, edit.selectionEnd);
      });
    },
    [onChange]
  );

  const runAction = useCallback(
    (action: (value: string, start: number, end: number) => Edit) => {
      const el = textareaRef.current;
      if (!el) return;
      const start = el.selectionStart;
      const end = el.selectionEnd;
      applyEdit(action(value, start, end), { start, end });
    },
    [applyEdit, value]
  );

  /* ------------------------------------------------------------ shortcuts */
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget;
    const mod = e.ctrlKey || e.metaKey;

    if (mod && e.key.toLowerCase() === 's') {
      e.preventDefault();
      onSave?.();
      return;
    }
    if (mod && !e.shiftKey && e.key.toLowerCase() === 'b') {
      e.preventDefault();
      runAction((v, s, en) => wrapSelection(v, s, en, '**', '**'));
      return;
    }
    if (mod && !e.shiftKey && e.key.toLowerCase() === 'i') {
      e.preventDefault();
      runAction((v, s, en) => wrapSelection(v, s, en, '*', '*'));
      return;
    }
    if (mod && !e.shiftKey && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      runAction((v, s, en) => wrapSelection(v, s, en, '[', '](https://)'));
      return;
    }
    if (mod && e.shiftKey && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      runAction((v, s, en) => wrapSelection(v, s, en, '[[', ']]'));
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      const start = el.selectionStart;
      const end = el.selectionEnd;
      if (e.shiftKey) {
        // Outdent: every selected line (or the current one) loses one indent level.
        runAction((v, s, en) => outdentLines(v, s, en));
      } else if (start !== end) {
        runAction((v, s, en) => prefixLines(v, s, en, '  '));
      } else {
        applyEdit({ text: `${value.slice(0, start)}  ${value.slice(end)}`, selectionStart: start + 2, selectionEnd: start + 2 });
      }
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      // Continue lists, task lists and quotes.
      const start = el.selectionStart;
      if (start !== el.selectionEnd) return;
      const lineStart = value.lastIndexOf('\n', start - 1) + 1;
      const line = value.slice(lineStart, start);
      const bullet = /^(\s*)([-*+])\s+(?:\[([ xX])\]\s+)?/.exec(line);
      const ordered = /^(\s*)(\d+)[.)]\s+/.exec(line);
      const quote = /^(\s*)>\s?/.exec(line);

      if (bullet && line.trim() === bullet[0].trim()) {
        // Empty item: end the list.
        e.preventDefault();
        applyEdit({ text: value.slice(0, lineStart) + value.slice(start), selectionStart: lineStart, selectionEnd: lineStart });
        return;
      }
      if (bullet) {
        e.preventDefault();
        const marker = bullet[3] !== undefined ? `${bullet[1]}${bullet[2]} [ ] ` : `${bullet[1]}${bullet[2]} `;
        applyEdit({
          text: `${value.slice(0, start)}\n${marker}${value.slice(el.selectionEnd)}`,
          selectionStart: start + 1 + marker.length,
          selectionEnd: start + 1 + marker.length
        });
        return;
      }
      if (ordered) {
        e.preventDefault();
        const marker = `${ordered[1]}${Number(ordered[2]) + 1}. `;
        applyEdit({
          text: `${value.slice(0, start)}\n${marker}${value.slice(el.selectionEnd)}`,
          selectionStart: start + 1 + marker.length,
          selectionEnd: start + 1 + marker.length
        });
        return;
      }
      if (quote) {
        e.preventDefault();
        const marker = `${quote[1]}> `;
        applyEdit({
          text: `${value.slice(0, start)}\n${marker}${value.slice(el.selectionEnd)}`,
          selectionStart: start + 1 + marker.length,
          selectionEnd: start + 1 + marker.length
        });
      }
    }
  };

  /* ------------------------------------------------------- attachment upload */

  const [uploadingCount, setUploadingCount] = useState(0);

  // Latest editor text for async insertions: an upload await can finish after
  // the user typed more, and rebuilding the value from a stale closure would
  // discard those keystrokes (and overwrite earlier inserted attachments).
  const latestValueRef = useRef(value);
  latestValueRef.current = value;

  /** Insert text at the caret and leave the caret after it. */
  const insertAtCaret = useCallback(
    (text: string) => {
      const el = textareaRef.current;
      const current = latestValueRef.current;
      const start = el ? Math.min(el.selectionStart, current.length) : current.length;
      const end = el ? Math.min(el.selectionEnd, current.length) : current.length;
      const next = `${current.slice(0, start)}${text}${current.slice(end)}`;
      latestValueRef.current = next;
      onChange(next);
      const caret = start + text.length;
      requestAnimationFrame(() => {
        const ta = textareaRef.current;
        if (!ta) return;
        ta.focus();
        ta.setSelectionRange(caret, caret);
      });
    },
    [onChange]
  );

  /**
   * Upload pasted/dropped files one by one and insert markdown for each.
   * A screenshot pasted into a note is the single most common Obsidian action;
   * without this the image was silently dropped.
   */
  const uploadFiles = useCallback(
    async (files: File[]) => {
      if (!onUploadFile || files.length === 0) return;
      setUploadingCount((n) => n + files.length);
      try {
        for (const file of files) {
          const path = await onUploadFile(file);
          if (path) {
            const isImage = file.type.startsWith('image/');
            const label = file.name.replace(/\.[^.]+$/, '') || '附件';
            insertAtCaret(isImage ? `![${label}](${path})\n` : `[${file.name}](${path})\n`);
          }
        }
      } finally {
        setUploadingCount((n) => Math.max(0, n - files.length));
      }
    },
    [insertAtCaret, onUploadFile]
  );

  const filesFromClipboard = (data: DataTransfer | null): File[] => {
    if (!data) return [];
    const out: File[] = [];
    for (const item of Array.from(data.items || [])) {
      if (item.kind !== 'file') continue;
      const file = item.getAsFile();
      // Screenshots arrive as image/png without a useful name.
      if (file && (file.type.startsWith('image/') || file.size > 0)) out.push(file);
    }
    if (out.length === 0) {
      for (const file of Array.from(data.files || [])) out.push(file);
    }
    return out;
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (!onUploadFile) return;
    const files = filesFromClipboard(e.clipboardData);
    if (files.length === 0) return;
    e.preventDefault();
    void uploadFiles(files);
  };

  const handleDrop = (e: React.DragEvent<HTMLTextAreaElement>) => {
    if (!onUploadFile) return;
    const files = Array.from(e.dataTransfer?.files || []);
    if (files.length === 0) return;
    e.preventDefault();
    void uploadFiles(files);
  };

  /* ---------------------------------------------------------- scroll sync */  const onTextareaScroll = () => {
    if (mode !== 'split' || syncing.current === 'right') return;
    const el = textareaRef.current;
    const preview = previewRef.current;
    if (!el || !preview) return;
    const max = el.scrollHeight - el.clientHeight;
    const ratio = max > 0 ? el.scrollTop / max : 0;
    syncing.current = 'left';
    preview.scrollTop = ratio * (preview.scrollHeight - preview.clientHeight);
    requestAnimationFrame(() => {
      syncing.current = 'none';
    });
  };

  const onPreviewScroll = () => {
    if (mode !== 'split' || syncing.current === 'left') return;
    const el = textareaRef.current;
    const preview = previewRef.current;
    if (!el || !preview) return;
    const max = preview.scrollHeight - preview.clientHeight;
    const ratio = max > 0 ? preview.scrollTop / max : 0;
    syncing.current = 'right';
    el.scrollTop = ratio * (el.scrollHeight - el.clientHeight);
    requestAnimationFrame(() => {
      syncing.current = 'none';
    });
  };

  useLayoutEffect(() => {
    // Keep the preview pinned to the top when switching notes. Depends on the
    // note identity, not on emptiness: the previous condition (`value.length
    // === 0`) only fired on empty↔non-empty switches, so going from one non-empty
    // note to another kept the old scroll position.
    if (previewRef.current) previewRef.current.scrollTop = 0;
  }, [noteKey]);

  const headingSignature = headings.map((h) => `${h.depth}:${h.id}`).join('|');
  useEffect(() => {
    onHeadings?.(headings);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [headingSignature]);

  const tools: { icon: React.ReactNode; title: string; run: () => void }[] = [
    { icon: <Bold className="w-3.5 h-3.5" />, title: '粗体 (Ctrl+B)', run: () => runAction((v, s, e) => wrapSelection(v, s, e, '**', '**')) },
    { icon: <Italic className="w-3.5 h-3.5" />, title: '斜体 (Ctrl+I)', run: () => runAction((v, s, e) => wrapSelection(v, s, e, '*', '*')) },
    { icon: <Strikethrough className="w-3.5 h-3.5" />, title: '删除线', run: () => runAction((v, s, e) => wrapSelection(v, s, e, '~~', '~~')) },
    { icon: <Code className="w-3.5 h-3.5" />, title: '行内代码', run: () => runAction((v, s, e) => wrapSelection(v, s, e, '`', '`')) },
  ];
  const headingTools: { icon: React.ReactNode; title: string; run: () => void }[] = [
    { icon: <Heading1 className="w-3.5 h-3.5" />, title: '一级标题', run: () => runAction((v, s, e) => prefixLines(v, s, e, '# ')) },
    { icon: <Heading2 className="w-3.5 h-3.5" />, title: '二级标题', run: () => runAction((v, s, e) => prefixLines(v, s, e, '## ')) },
    { icon: <Heading3 className="w-3.5 h-3.5" />, title: '三级标题', run: () => runAction((v, s, e) => prefixLines(v, s, e, '### ')) },
  ];
  const listTools: { icon: React.ReactNode; title: string; run: () => void }[] = [
    { icon: <List className="w-3.5 h-3.5" />, title: '无序列表', run: () => runAction((v, s, e) => prefixLines(v, s, e, '- ')) },
    { icon: <ListOrdered className="w-3.5 h-3.5" />, title: '有序列表', run: () => runAction((v, s, e) => prefixLines(v, s, e, (i) => `${i + 1}. `)) },
    { icon: <ListChecks className="w-3.5 h-3.5" />, title: '任务列表', run: () => runAction((v, s, e) => prefixLines(v, s, e, '- [ ] ')) },
    { icon: <Quote className="w-3.5 h-3.5" />, title: '引用', run: () => runAction((v, s, e) => prefixLines(v, s, e, '> ')) },
    { icon: <AlertOctagon className="w-3.5 h-3.5" />, title: '标注块 (Callout)', run: () => runAction((v, s, e) => prefixLines(v, s, e, '> [!note] ')) },
  ];
  const insertTools: { icon: React.ReactNode; title: string; run: () => void }[] = [
    { icon: <Link2 className="w-3.5 h-3.5" />, title: '链接 (Ctrl+K)', run: () => runAction((v, s, e) => wrapSelection(v, s, e, '[', '](https://)')) },
    { icon: <FileCode2 className="w-3.5 h-3.5" />, title: '内部双链 (Ctrl+Shift+K)', run: () => runAction((v, s, e) => wrapSelection(v, s, e, '[[', ']]')) },
    { icon: <ImageIcon className="w-3.5 h-3.5" />, title: '图片', run: () => runAction((v, s, e) => wrapSelection(v, s, e, '![', '](图片路径.png)')) },
    { icon: <TableIcon className="w-3.5 h-3.5" />, title: '表格', run: () => runAction((v, s, e) => insertBlock(v, s, e, TABLE_TEMPLATE)) },
    { icon: <Code className="w-3.5 h-3.5" />, title: '代码块', run: () => runAction((v, s, e) => insertBlock(v, s, e, '```\n\n```\n')) },
  ];

  const modeButton = (target: EditorMode, icon: React.ReactNode, label: string) => (
    <button
      key={target}
      type="button"
      onClick={() => onModeChange(target)}
      title={label}
      className={`px-2.5 py-1 rounded-md flex items-center gap-1.5 text-[11px] transition-colors ${
        mode === target ? 'bg-sh-surface2 text-sh-fg font-medium' : 'text-sh-muted hover:text-sh-fg'
      }`}
    >
      {icon}
      <span className="hidden sm:inline">{label}</span>
    </button>
  );

  return (
    <div className="md-editor">
      {/* Toolbar */}
      <div className="md-editor-toolbar border-sh-line bg-sh-surface">
        <div className="flex items-center gap-0.5 mr-auto flex-wrap">
          {tools.map((t) => (
            <button key={t.title} type="button" title={t.title} onClick={t.run} className="md-editor-tool">
              {t.icon}
            </button>
          ))}
          <span className="md-editor-sep" />
          {headingTools.map((t) => (
            <button key={t.title} type="button" title={t.title} onClick={t.run} className="md-editor-tool">
              {t.icon}
            </button>
          ))}
          <span className="md-editor-sep" />
          {listTools.map((t) => (
            <button key={t.title} type="button" title={t.title} onClick={t.run} className="md-editor-tool">
              {t.icon}
            </button>
          ))}
          <span className="md-editor-sep" />
          {insertTools.map((t) => (
            <button key={t.title} type="button" title={t.title} onClick={t.run} className="md-editor-tool">
              {t.icon}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-1 p-0.5 rounded-lg bg-sh-surface2 border border-sh-line">
          {modeButton('edit', <PencilLine className="w-3 h-3" />, '编辑')}
          {modeButton('split', <Columns2 className="w-3 h-3" />, '分屏')}
          {modeButton('preview', <Eye className="w-3 h-3" />, '预览')}
        </div>

        {onSave && (
          <button
            type="button"
            onClick={onSave}
            disabled={saving}
            className="ml-2 px-3 py-1 rounded-lg bg-sh-accent text-sh-accent-fg hover:opacity-90 text-[11px] font-semibold flex items-center gap-1.5 disabled:opacity-50"
          >
            {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
            <span>{saving ? '保存中' : '保存'}</span>
          </button>
        )}
      </div>

      {/* Surface */}
      <div className={`md-editor-surface ${mode === 'split' ? 'md-editor-split' : ''}`}>
        {mode !== 'preview' && (
          <textarea
            ref={textareaRef}
            className="md-editor-textarea"
            data-testid={textareaTestId}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={handleKeyDown}
            onScroll={onTextareaScroll}
            onPaste={handlePaste}
            onDrop={handleDrop}
            onDragOver={onUploadFile ? (e) => e.preventDefault() : undefined}
            placeholder={placeholder}
            spellCheck={false}
          />
        )}
        {mode !== 'edit' && (
          <div ref={previewRef} className="md-editor-preview" onScroll={onPreviewScroll}>
            <Markdown content={deferredValue} ctx={previewCtx} onHeadings={setHeadings} />
          </div>
        )}
      </div>

      {uploadingCount > 0 && (
        <div className="px-3 py-1.5 text-[11px] text-sh-info border-t border-sh-line bg-sh-surface flex items-center gap-1.5">
          <Loader2 className="w-3 h-3 animate-spin" />
          正在上传 {uploadingCount} 个附件到 OSS…
        </div>
      )}

      {/* Status bar */}
      <div className="md-editor-status border-sh-line bg-sh-surface">
        <span className="flex items-center gap-3">
          <span>{value.length} 字符</span>
          <span>{value.split('\n').length} 行</span>
          {previewStale && mode === 'split' && <span className="text-sh-info">预览更新中…</span>}
          {dirty ? <span className="text-sh-warn">● 未保存</span> : <span className="text-sh-ok">已同步</span>}
        </span>
        <span className="flex items-center gap-3">{statusRight}</span>
      </div>
    </div>
  );
};

export default MarkdownEditor;
