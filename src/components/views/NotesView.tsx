import React, { useState, useEffect, useRef } from 'react';
import { 
  FileText, 
  Plus, 
  Search, 
  Copy, 
  Check, 
  Trash2, 
  Edit3, 
  Pin, 
  Calendar, 
  Tag, 
  Save, 
  Eye, 
  Code2,
  Download,
  Columns,
  AlertCircle,
  CheckCircle2
} from 'lucide-react';
import { QuickNote } from '../../types';
import { Markdown } from '../Markdown';

interface NotesViewProps {
  notes: QuickNote[];
  onAddNote: (note: QuickNote) => void;
  onUpdateNote: (note: QuickNote) => void;
  onDeleteNote: (id: string) => void;
  /** Note to reveal when arriving from another view (e.g. a project's linked doc). */
  focusNoteId?: string | null;
  onFocusHandled?: () => void;
}

export const NotesView: React.FC<NotesViewProps> = ({
  notes,
  onAddNote,
  onUpdateNote,
  onDeleteNote,
  focusNoteId,
  onFocusHandled
}) => {
  const [selectedNoteId, setSelectedNoteId] = useState<string>(notes[0]?.id || '');
  const [searchQuery, setSearchQuery] = useState('');
  /** Text pasted into the pane-level paste box (creates a note on submit). */
  const [pasteText, setPasteText] = useState('');
  const [isEditing, setIsEditing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [editorMode, setEditorMode] = useState<'split' | 'edit' | 'preview'>('split');

  // Deep link from projects / inbox / global search: select the target note.
  useEffect(() => {
    if (!focusNoteId) return;
    if (!notes.some((n) => n.id === focusNoteId)) return;
    setSelectedNoteId(focusNoteId);
    setIsEditing(false);
    setSearchQuery('');
    onFocusHandled?.();
  }, [focusNoteId, notes, onFocusHandled]);

  // Editor states
  const [editTitle, setEditTitle] = useState('');
  const [editContent, setEditContent] = useState('');
  const [editCategory, setEditCategory] = useState('');
  const [editTags, setEditTags] = useState('');
  const [draftSavedAt, setDraftSavedAt] = useState<number | null>(null);
  const [hasUnsavedDraft, setHasUnsavedDraft] = useState(false);

  const selectedNote = notes.find(n => n.id === selectedNoteId) || notes[0];

  const filteredNotes = notes.filter(n => {
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    return (
      n.title.toLowerCase().includes(q) ||
      n.content.toLowerCase().includes(q) ||
      (n.category && n.category.toLowerCase().includes(q)) ||
      (n.tags && n.tags.some(t => t.toLowerCase().includes(q)))
    );
  });

  // Track ID of existing note being edited (null when creating new)
  const [editingExistingId, setEditingExistingId] = useState<string | null>(null);

  // Check draft on mount or note change (N06)
  useEffect(() => {
    try {
      const saved = localStorage.getItem('selfhub_note_draft');
      if (!saved) {
        setHasUnsavedDraft(false);
        return;
      }
      const parsed = JSON.parse(saved);
      const pending =
        parsed &&
        typeof parsed.content === 'string' &&
        parsed.content.trim() !== '' &&
        (!selectedNote || parsed.content !== selectedNote.content);
      setHasUnsavedDraft(Boolean(pending));
    } catch {
      setHasUnsavedDraft(false);
    }
  }, [selectedNoteId, selectedNote]);

  // Debounced auto-save draft while typing (N06)
  useEffect(() => {
    if (!isEditing) return;
    const timer = setTimeout(() => {
      try {
        localStorage.setItem(
          'selfhub_note_draft',
          JSON.stringify({
            id: editingExistingId,
            title: editTitle,
            content: editContent,
            category: editCategory,
            tags: editTags,
            savedAt: Date.now()
          })
        );
        setDraftSavedAt(Date.now());
      } catch {}
    }, 800);
    return () => clearTimeout(timer);
  }, [editTitle, editContent, editCategory, editTags, isEditing, editingExistingId]);

  // Snapshot of the editor contents when the editing session began. The cancel
  // and switch guards diff against it so a rename or re-tag counts as unsaved
  // work, not just a content change.
  const editBaselineRef = useRef<{ id: string | null; title: string; content: string; category: string; tags: string } | null>(null);

  const hasUnsavedEditorChanges = (): boolean => {
    if (!isEditing) return false;
    const base = editBaselineRef.current;
    if (!base) return false;
    if (base.id !== editingExistingId) return true;
    return (
      editTitle !== base.title ||
      editContent !== base.content ||
      editCategory !== base.category ||
      editTags !== base.tags
    );
  };

  const handleRestoreDraft = () => {
    try {
      const saved = localStorage.getItem('selfhub_note_draft');
      if (!saved) return;
      const parsed = JSON.parse(saved);
      if (parsed) {
        setEditingExistingId(parsed.id || null);
        // Keep the selection in sync with the note the draft belongs to, otherwise
        // saving the restored draft silently overwrites a *different* note.
        if (parsed.id) setSelectedNoteId(parsed.id);
        setEditTitle(parsed.title || '');
        setEditContent(parsed.content || '');
        setEditCategory(parsed.category || '通用知识');
        setEditTags(parsed.tags || '');
        editBaselineRef.current = {
          id: parsed.id || null,
          title: parsed.title || '',
          content: parsed.content || '',
          category: parsed.category || '通用知识',
          tags: parsed.tags || ''
        };
        setIsEditing(true);
        setHasUnsavedDraft(false);
      }
    } catch {}
  };

  const clearDraft = () => {
    try {
      localStorage.removeItem('selfhub_note_draft');
    } catch {}
    setHasUnsavedDraft(false);
    setDraftSavedAt(null);
  };

  const handleDiscardDraft = () => {
    clearDraft();
  };

  const handleExportMarkdown = (note: QuickNote) => {
    const md = `---
title: "${note.title.replace(/"/g, '\\"')}"
category: "${note.category || '通用'}"
tags: [${(note.tags || []).map(t => `"${t}"`).join(', ')}]
updatedAt: ${new Date(note.updatedAt).toISOString()}
---

# ${note.title}

${note.content}
`;
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${note.title.slice(0, 30).replace(/[\\/:*?"<>|]/g, '_')}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleStartEdit = (note: QuickNote) => {
    setEditingExistingId(note.id);
    setSelectedNoteId(note.id);
    setEditTitle(note.title);
    setEditContent(note.content);
    setEditCategory(note.category || '通用知识');
    setEditTags((note.tags || []).join(', '));
    editBaselineRef.current = {
      id: note.id,
      title: note.title,
      content: note.content,
      category: note.category || '通用知识',
      tags: (note.tags || []).join(', ')
    };
    setIsEditing(true);
  };

  const handleStartNew = () => {
    setEditingExistingId(null);
    setEditTitle('新建知识笔记');
    setEditContent('### 笔记标题\n\n- 记录详细知识点、技术规范、代码片段与部署备忘...\n\n```bash\n# 示例指令\necho "Hello World"\n```\n');
    setEditCategory('常用技术');
    setEditTags('架构, 备忘');
    editBaselineRef.current = {
      id: null,
      title: '新建知识笔记',
      content: '### 笔记标题\n\n- 记录详细知识点、技术规范、代码片段与部署备忘...\n\n```bash\n# 示例指令\necho "Hello World"\n```\n',
      category: '常用技术',
      tags: '架构, 备忘'
    };
    setIsEditing(true);
  };

  const handleSave = () => {
    if (!editTitle.trim()) {
      // Silent returns here made the save button feel dead; say what is missing.
      window.alert('标题不能为空：请填写标题后再保存。');
      return;
    }

    const tagsArray = editTags.split(/[,，\s]+/).map(t => t.trim()).filter(Boolean);

    if (editingExistingId) {
      // Robust update of existing note by ID (never duplicate on title rename - N06)
      const existing = notes.find(n => n.id === editingExistingId) || selectedNote;
      onUpdateNote({
        ...existing,
        id: editingExistingId,
        title: editTitle.trim(),
        content: editContent,
        category: editCategory,
        tags: tagsArray,
        updatedAt: Date.now()
      });
      setSelectedNoteId(editingExistingId);
    } else {
      // Create new
      const newNote: QuickNote = {
        id: `note-${Date.now()}`,
        title: editTitle.trim(),
        content: editContent,
        category: editCategory,
        tags: tagsArray,
        pinned: false,
        updatedAt: Date.now()
      };
      onAddNote(newNote);
      setSelectedNoteId(newNote.id);
    }

    setIsEditing(false);
    setEditingExistingId(null);
    // The content is committed now: a leftover draft would later be offered for
    // "recovery" and could overwrite this or another note.
    clearDraft();
  };

  const handleCopyContent = () => {
    if (!selectedNote) return;
    navigator.clipboard
      .writeText(selectedNote.content)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => {
        window.alert('复制失败：浏览器拒绝了剪贴板访问。请手动选中内容复制。');
      });
  };

  return (
    <div className="space-y-4">
      {/* Draft Recovery Alert */}
      {hasUnsavedDraft && (
        <div className="p-3.5 bg-sh-warn/10 border border-sh-warn/50 rounded-2xl flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs text-sh-warn">
          <div className="flex items-center gap-2">
            <AlertCircle className="w-4 h-4 text-sh-warn shrink-0" />
            <span>检测到本地存在上次未提交的编辑草稿，是否恢复？</span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={handleRestoreDraft}
              className="px-3 py-1 rounded-lg bg-sh-accent text-sh-accent-fg hover:opacity-90 text-sh-accent-fg font-semibold transition-colors"
            >
              恢复草稿
            </button>
            <button
              onClick={handleDiscardDraft}
              className="px-3 py-1 rounded-lg bg-sh-surface2 hover:bg-sh-line text-sh-muted transition-colors"
            >
              放弃草稿
            </button>
          </div>
        </div>
      )}

      {/* View Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-sh-surface p-4 sm:p-5 rounded-2xl border border-sh-line">
        <div>
          <h2 className="text-sm sm:text-base font-semibold text-sh-fg flex items-center gap-2">
            <FileText className="w-4 h-4 text-sh-info" />
            <span>笔记</span>
            <span className="text-xs font-mono text-sh-muted">({notes.length} 篇)</span>
          </h2>
          <p className="text-xs text-sh-muted mt-1">直接粘贴，第一行当标题；支持 Markdown 预览与导出。</p>
        </div>
      </div>

      {/*
        粘贴即入库。
        There is deliberately no 「新建」 button: the pane opens with a text field you can paste
        into immediately, which is how this gets used (copy from a chat, paste, done). The first
        line becomes the title; the whole text is the body.
      */}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const text = pasteText.trim();
          if (!text) return;
          const lines = text.split('\n');
          const title = (lines[0] || '').replace(/^#+\s*/, '').trim().slice(0, 80) || '未命名笔记';
          // Single-line paste: the line is the title, not extra body.
          const body = lines.length > 1 ? lines.slice(1).join('\n').trim() : '';
          const note: QuickNote = {
            id: `note-${Date.now()}`,
            title,
            content: body,
            category: '速记',
            tags: [],
            updatedAt: Date.now()
          };
          onAddNote(note);
          setSelectedNoteId(note.id);
          setPasteText('');
          setIsEditing(false);
        }}
        className="rounded-2xl border border-sh-line bg-sh-surface p-3 space-y-2"
        data-testid="notes-paste"
      >
        <textarea
          value={pasteText}
          onChange={(e) => setPasteText(e.target.value)}
          placeholder="直接把要存的内容粘进来…（第一行会成为标题，Ctrl/⌘ + Enter 保存）"
          rows={4}
          data-testid="notes-paste-input"
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.currentTarget.form?.requestSubmit();
            }
          }}
          className="w-full bg-sh-surface2 border border-sh-line rounded-xl px-3 py-2 text-sm text-sh-fg focus:outline-none focus:border-sh-line-strong resize-y"
        />
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] text-sh-subtle">粘贴的内容会立刻成为一篇笔记，不会经过"新建"流程。</span>
          <button
            type="submit"
            disabled={!pasteText.trim()}
            data-testid="notes-paste-save"
            className="px-3 py-1.5 rounded-lg bg-sh-accent text-sh-accent-fg text-xs font-semibold disabled:opacity-50"
          >
            存为笔记
          </button>
        </div>
      </form>

      {/* 2-Column Responsive Workspace */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 h-[calc(100vh-230px)] min-h-[550px]">
        
        {/* Left Column: Note Navigation List (4 cols) */}
        <div className="lg:col-span-4 bg-sh-surface border border-sh-line rounded-2xl p-3 flex flex-col overflow-hidden">
          {/* Search bar */}
          <div className="relative mb-3">
            <Search className="w-3.5 h-3.5 text-sh-muted absolute left-2.5 top-2.5" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="全文检索文档标题、内容或标签..."
              aria-label="搜索笔记"
              className="w-full bg-sh-surface2 border border-sh-line rounded-lg pl-8 pr-3 py-1.5 text-xs text-sh-fg focus:outline-none focus:border-sh-line-strong"
            />
          </div>

          {/* Notes Scrollable List */}
          <div className="flex-1 overflow-y-auto space-y-1.5 pr-1">
            {filteredNotes.length === 0 ? (
              <div className="py-12 text-center text-xs text-sh-subtle font-mono">
                无匹配文档
              </div>
            ) : (
              filteredNotes.map((note) => {
                const isSelected = selectedNote?.id === note.id;
                return (
                  <div
                    key={note.id}
                    data-testid={`note-row-${note.id}`}
                    onClick={() => {
                      if (hasUnsavedEditorChanges() && !confirm('当前编辑内容尚未保存，切换文档会放弃这些改动，确定继续吗？')) {
                        return;
                      }
                      setSelectedNoteId(note.id);
                      setIsEditing(false);
                    }}
                    className={`p-3 rounded-xl cursor-pointer transition-all border ${
                      isSelected
                        ? 'bg-sh-surface2 border-sh-line-strong text-sh-accent-fg shadow-sm'
                        : 'bg-sh-surface2/60 border-sh-line hover:bg-sh-surface2 text-sh-muted'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-1 mb-1">
                      <h4 className="text-xs font-semibold truncate flex-1">{note.title}</h4>
                      {note.pinned && <Pin className="w-3 h-3 text-sh-warn shrink-0" />}
                    </div>

                    <p className="text-[11px] text-sh-muted line-clamp-2 leading-relaxed">
                      {note.content.replace(/^[#*-`\s]+/gm, '')}
                    </p>

                    <div className="flex items-center justify-between mt-2 pt-2 border-t border-sh-line text-[10px] text-sh-muted">
                      <span className="px-1.5 py-0.2 rounded bg-sh-surface2 border border-sh-line font-mono">
                        {note.category || '笔记'}
                      </span>
                      <span className="font-mono">
                        {new Date(note.updatedAt).toLocaleDateString()}
                      </span>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Right Column: Markdown Reader / Editor Workspace (8 cols) */}
        <div className="lg:col-span-8 bg-sh-surface border border-sh-line rounded-2xl flex flex-col overflow-hidden">
          {isEditing ? (
            /* Editing Mode */
            <div className="flex-1 flex flex-col p-4 sm:p-5 space-y-3 overflow-y-auto">
              {/* Header with Title & Mode Switcher */}
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-sh-line">
                <input
                  type="text"
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  placeholder="文档标题..."
                  className="bg-transparent text-sm sm:text-base font-semibold text-sh-fg focus:outline-none flex-1"
                />

                <div className="flex items-center gap-2 shrink-0">
                  {/* Mode switcher tabs */}
                  <div className="flex items-center bg-sh-surface2 rounded-lg p-0.5 border border-sh-line">
                    <button
                      type="button"
                      onClick={() => setEditorMode('split')}
                      className={`px-2 py-1 rounded text-[11px] flex items-center gap-1 transition-colors ${
                        editorMode === 'split' ? 'bg-sh-surface2 text-sh-accent-fg font-medium' : 'text-sh-muted hover:text-sh-fg'
                      }`}
                      title="双栏分屏对比"
                    >
                      <Columns className="w-3 h-3" />
                      <span className="hidden sm:inline">双栏</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditorMode('edit')}
                      className={`px-2 py-1 rounded text-[11px] flex items-center gap-1 transition-colors ${
                        editorMode === 'edit' ? 'bg-sh-surface2 text-sh-accent-fg font-medium' : 'text-sh-muted hover:text-sh-fg'
                      }`}
                      title="纯源码编辑"
                    >
                      <Code2 className="w-3 h-3" />
                      <span className="hidden sm:inline">编辑</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditorMode('preview')}
                      className={`px-2 py-1 rounded text-[11px] flex items-center gap-1 transition-colors ${
                        editorMode === 'preview' ? 'bg-sh-surface2 text-sh-accent-fg font-medium' : 'text-sh-muted hover:text-sh-fg'
                      }`}
                      title="预览渲染效果"
                    >
                      <Eye className="w-3 h-3" />
                      <span className="hidden sm:inline">预览</span>
                    </button>
                  </div>

                  <button
                    onClick={() => {
                      if (hasUnsavedEditorChanges() && !confirm('当前编辑内容尚未保存，确定放弃吗？')) {
                        return;
                      }
                      setIsEditing(false);
                    }}
                    className="px-3 py-1 rounded-lg bg-sh-surface2 hover:bg-sh-surface2 text-xs text-sh-muted hover:text-sh-fg"
                  >
                    取消
                  </button>
                  <button
                    onClick={handleSave}
                    className="px-3.5 py-1 rounded-lg bg-sh-accent text-sh-accent-fg hover:opacity-90 text-xs font-semibold flex items-center gap-1 shadow-sm"
                  >
                    <Save className="w-3.5 h-3.5" />
                    <span>保存</span>
                  </button>
                </div>
              </div>

              {/* Metadata inputs */}
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div>
                  <label className="block text-[11px] text-sh-muted mb-1">所属分类</label>
                  <input
                    type="text"
                    value={editCategory}
                    onChange={(e) => setEditCategory(e.target.value)}
                    placeholder="例如: 生产部署 / Linux安全"
                    className="w-full bg-sh-surface2 border border-sh-line rounded-lg px-3 py-1.5 text-xs text-sh-fg focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-[11px] text-sh-muted mb-1">标签 (逗号分隔)</label>
                  <input
                    type="text"
                    value={editTags}
                    onChange={(e) => setEditTags(e.target.value)}
                    placeholder="架构, Docker, 备忘"
                    className="w-full bg-sh-surface2 border border-sh-line rounded-lg px-3 py-1.5 text-xs text-sh-fg focus:outline-none"
                  />
                </div>
              </div>

              {/* Main Content Pane (Adaptive split/edit/preview) */}
              <div className="flex-1 min-h-[350px] flex flex-col pt-1">
                {editorMode === 'split' ? (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3 flex-1">
                    <div className="flex flex-col">
                      <div className="text-[11px] text-sh-subtle mb-1 font-mono flex items-center justify-between">
                        <span>Markdown 源码</span>
                        <span>{editContent.length} 字符</span>
                      </div>
                      <textarea
                        value={editContent}
                        onChange={(e) => setEditContent(e.target.value)}
                        placeholder="使用 Markdown 自由记录详细内容..."
                        className="flex-1 w-full bg-sh-surface2/80 border border-sh-line rounded-xl p-3.5 text-xs font-mono text-sh-fg leading-relaxed focus:outline-none focus:border-sh-line-strong resize-none min-h-[300px]"
                      />
                    </div>
                    <div className="flex flex-col">
                      <div className="text-[11px] text-sh-subtle mb-1 font-mono">实时渲染预览</div>
                      <div className="flex-1 bg-sh-bg border border-sh-line rounded-xl p-4 overflow-y-auto text-xs min-h-[300px]">
                        <Markdown content={editContent} />
                      </div>
                    </div>
                  </div>
                ) : editorMode === 'edit' ? (
                  <div className="flex flex-col flex-1">
                    <div className="text-[11px] text-sh-subtle mb-1 font-mono flex items-center justify-between">
                      <span>Markdown 源码</span>
                      <span>{editContent.length} 字符</span>
                    </div>
                    <textarea
                      value={editContent}
                      onChange={(e) => setEditContent(e.target.value)}
                      placeholder="使用 Markdown 自由记录详细内容..."
                      className="flex-1 w-full bg-sh-surface2/80 border border-sh-line rounded-xl p-3.5 text-xs font-mono text-sh-fg leading-relaxed focus:outline-none focus:border-sh-line-strong resize-none min-h-[350px]"
                    />
                  </div>
                ) : (
                  <div className="flex flex-col flex-1">
                    <div className="text-[11px] text-sh-subtle mb-1 font-mono">预览渲染效果</div>
                    <div className="flex-1 bg-sh-bg border border-sh-line rounded-xl p-5 overflow-y-auto text-xs min-h-[350px]">
                      <Markdown content={editContent} />
                    </div>
                  </div>
                )}
              </div>

              {/* Editor Status Footer */}
              <div className="pt-2 border-t border-sh-line flex items-center justify-between text-[11px] font-mono text-sh-subtle">
                <div className="flex items-center gap-2">
                  {draftSavedAt ? (
                    <span className="flex items-center gap-1 text-sh-ok">
                      <CheckCircle2 className="w-3 h-3" />
                      <span>草稿已自动暂存 ({new Date(draftSavedAt).toLocaleTimeString()})</span>
                    </span>
                  ) : (
                    <span>输入时将自动暂存本地草稿...</span>
                  )}
                </div>
                <div>
                  约 {Math.max(1, Math.ceil(editContent.length / 350))} 分钟阅读 · {editContent.split(/\s+/).filter(Boolean).length} 词
                </div>
              </div>
            </div>
          ) : selectedNote ? (
            /* Reader Preview Mode */
            <div className="flex-1 flex flex-col overflow-hidden">
              {/* Header */}
              <div className="p-4 sm:p-5 border-b border-sh-line flex items-center justify-between gap-3 bg-sh-surface2/40">
                <div className="min-w-0">
                  <h3 className="text-sm sm:text-base font-semibold text-sh-fg truncate">
                    {selectedNote.title}
                  </h3>
                  <div className="flex items-center gap-2 mt-1 text-[11px] text-sh-muted">
                    <span className="px-1.5 py-0.2 rounded bg-sh-surface2 font-mono text-sh-muted">
                      {selectedNote.category || '通用'}
                    </span>
                    <span>•</span>
                    <span>更新于: {new Date(selectedNote.updatedAt).toLocaleString()}</span>
                    <span>•</span>
                    <span>{selectedNote.content.length} 字符</span>
                  </div>
                </div>

                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    onClick={() => handleExportMarkdown(selectedNote)}
                    className="px-2.5 py-1.5 rounded-lg bg-sh-surface2 hover:bg-sh-surface2 text-xs text-sh-muted flex items-center gap-1 border border-sh-line transition-colors"
                    title="导出为标准 Obsidian/GitHub Markdown 文件"
                  >
                    <Download className="w-3 h-3 text-sh-info" />
                    <span>导出 .md</span>
                  </button>
                  <button
                    onClick={handleCopyContent}
                    className="px-2.5 py-1.5 rounded-lg bg-sh-surface2 hover:bg-sh-surface2 text-xs text-sh-muted flex items-center gap-1 border border-sh-line transition-colors"
                    title="复制全篇正文"
                  >
                    {copied ? <Check className="w-3 h-3 text-sh-ok" /> : <Copy className="w-3 h-3" />}
                    <span>{copied ? '已复制' : '复制全文'}</span>
                  </button>
                  <button
                    onClick={() => handleStartEdit(selectedNote)}
                    className="px-2.5 py-1.5 rounded-lg bg-sh-surface2 hover:bg-sh-surface2 text-xs text-sh-muted flex items-center gap-1 border border-sh-line transition-colors"
                  >
                    <Edit3 className="w-3 h-3" />
                    <span>编辑</span>
                  </button>
                  <button
                    onClick={() => {
                      if (confirm(`确定删除知识文档 ${selectedNote.title} 吗？`)) {
                        onDeleteNote(selectedNote.id);
                      }
                    }}
                    className="p-1.5 rounded-lg hover:bg-sh-surface2 text-sh-muted hover:text-sh-danger transition-colors"
                    title="删除"
                    aria-label={`删除笔记 ${selectedNote.title}`}
                  >
                    <Trash2 className="w-3.5 h-3.5" aria-hidden />
                  </button>
                </div>
              </div>

              {/* Rich Markdown Rendered Body */}
              <div className="flex-1 p-5 sm:p-6 overflow-y-auto leading-relaxed select-text bg-sh-bg">
                <Markdown content={selectedNote.content} />
              </div>

              {/* Footer Tags & Info */}
              {selectedNote.tags && selectedNote.tags.length > 0 && (
                <div className="px-5 py-2.5 border-t border-sh-line bg-sh-surface2/30 flex items-center gap-2 overflow-x-auto text-xs">
                  <Tag className="w-3.5 h-3.5 text-sh-subtle shrink-0" />
                  {selectedNote.tags.map((t, idx) => (
                    <span
                      key={idx}
                      className="px-2 py-0.5 rounded-md bg-sh-surface2 text-sh-muted border border-sh-line text-[11px] font-mono"
                    >
                      #{t}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div className="flex-1 flex items-center justify-center text-xs text-sh-muted">
              请在左侧选择一篇文档，或点击右上角新建知识文档
            </div>
          )}
        </div>

      </div>

    </div>
  );
};

