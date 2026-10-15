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

interface NotesViewProps {
  notes: QuickNote[];
  onAddNote: (note: QuickNote) => void;
  onUpdateNote: (note: QuickNote) => void;
  onDeleteNote: (id: string) => void;
}

export const NotesView: React.FC<NotesViewProps> = ({
  notes,
  onAddNote,
  onUpdateNote,
  onDeleteNote
}) => {
  const [selectedNoteId, setSelectedNoteId] = useState<string>(notes[0]?.id || '');
  const [searchQuery, setSearchQuery] = useState('');
  const [isEditing, setIsEditing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [editorMode, setEditorMode] = useState<'split' | 'edit' | 'preview'>('split');

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
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed && parsed.content && (!selectedNote || parsed.content !== selectedNote.content)) {
          setHasUnsavedDraft(true);
        }
      }
    } catch {}
  }, [selectedNoteId]);

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

  const handleRestoreDraft = () => {
    try {
      const saved = localStorage.getItem('selfhub_note_draft');
      if (!saved) return;
      const parsed = JSON.parse(saved);
      if (parsed) {
        setEditingExistingId(parsed.id || null);
        setEditTitle(parsed.title || '');
        setEditContent(parsed.content || '');
        setEditCategory(parsed.category || '通用知识');
        setEditTags(parsed.tags || '');
        setIsEditing(true);
        setHasUnsavedDraft(false);
      }
    } catch {}
  };

  const handleDiscardDraft = () => {
    localStorage.removeItem('selfhub_note_draft');
    setHasUnsavedDraft(false);
    setDraftSavedAt(null);
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
    setIsEditing(true);
  };

  const handleStartNew = () => {
    setEditingExistingId(null);
    setEditTitle('新建知识笔记');
    setEditContent('### 笔记标题\n\n- 记录详细知识点、技术规范、代码片段与部署备忘...\n\n```bash\n# 示例指令\necho "Hello World"\n```\n');
    setEditCategory('常用技术');
    setEditTags('架构, 备忘');
    setIsEditing(true);
  };

  const handleSave = () => {
    if (!editTitle.trim()) return;

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
  };

  const handleCopyContent = () => {
    if (!selectedNote) return;
    navigator.clipboard.writeText(selectedNote.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="space-y-4">
      {/* Draft Recovery Alert */}
      {hasUnsavedDraft && (
        <div className="p-3.5 bg-amber-950/40 border border-amber-800/60 rounded-2xl flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs text-amber-200">
          <div className="flex items-center gap-2">
            <AlertCircle className="w-4 h-4 text-amber-400 shrink-0" />
            <span>检测到本地存在上次未提交的编辑草稿，是否恢复？</span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={handleRestoreDraft}
              className="px-3 py-1 rounded-lg bg-amber-500 hover:bg-amber-400 text-zinc-950 font-semibold transition-colors"
            >
              恢复草稿
            </button>
            <button
              onClick={handleDiscardDraft}
              className="px-3 py-1 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition-colors"
            >
              放弃草稿
            </button>
          </div>
        </div>
      )}

      {/* View Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-[#121316] p-4 sm:p-5 rounded-2xl border border-[#22242a]">
        <div>
          <h2 className="text-sm sm:text-base font-semibold text-zinc-100 flex items-center gap-2">
            <FileText className="w-4 h-4 text-purple-400" />
            <span>深度知识库与长文档手册</span>
            <span className="text-xs font-mono text-zinc-400">({notes.length} 篇备忘)</span>
          </h2>
          <p className="text-xs text-zinc-400 mt-1">
            完整保存深度架构文档、Linux 指令规范、Docker 编排配置与长文资料，支持实时分屏预览、代码一键复制与 Markdown 导出
          </p>
        </div>

        <button
          onClick={handleStartNew}
          className="px-3.5 py-2 rounded-xl bg-zinc-100 text-zinc-900 font-semibold text-xs flex items-center gap-1.5 hover:bg-white shadow-sm shrink-0"
        >
          <Plus className="w-3.5 h-3.5" />
          <span>新建知识文档</span>
        </button>
      </div>

      {/* 2-Column Responsive Workspace */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 h-[calc(100vh-230px)] min-h-[550px]">
        
        {/* Left Column: Note Navigation List (4 cols) */}
        <div className="lg:col-span-4 bg-[#121316] border border-[#22242a] rounded-2xl p-3 flex flex-col overflow-hidden">
          {/* Search bar */}
          <div className="relative mb-3">
            <Search className="w-3.5 h-3.5 text-zinc-400 absolute left-2.5 top-2.5" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="全文检索文档标题、内容或标签..."
              className="w-full bg-zinc-900 border border-zinc-800 rounded-lg pl-8 pr-3 py-1.5 text-xs text-zinc-100 focus:outline-none focus:border-zinc-700"
            />
          </div>

          {/* Notes Scrollable List */}
          <div className="flex-1 overflow-y-auto space-y-1.5 pr-1">
            {filteredNotes.length === 0 ? (
              <div className="py-12 text-center text-xs text-zinc-500 font-mono">
                无匹配文档
              </div>
            ) : (
              filteredNotes.map((note) => {
                const isSelected = selectedNote?.id === note.id;
                return (
                  <div
                    key={note.id}
                    onClick={() => {
                      setSelectedNoteId(note.id);
                      setIsEditing(false);
                    }}
                    className={`p-3 rounded-xl cursor-pointer transition-all border ${
                      isSelected
                        ? 'bg-zinc-800/90 border-zinc-700 text-white shadow-sm'
                        : 'bg-zinc-900/40 border-zinc-800/50 hover:bg-zinc-800/40 text-zinc-300'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-1 mb-1">
                      <h4 className="text-xs font-semibold truncate flex-1">{note.title}</h4>
                      {note.pinned && <Pin className="w-3 h-3 text-amber-400 shrink-0" />}
                    </div>

                    <p className="text-[11px] text-zinc-400 line-clamp-2 leading-relaxed">
                      {note.content.replace(/^[#*-`\s]+/gm, '')}
                    </p>

                    <div className="flex items-center justify-between mt-2 pt-2 border-t border-zinc-800/40 text-[10px] text-zinc-400">
                      <span className="px-1.5 py-0.2 rounded bg-zinc-900 border border-zinc-800 font-mono">
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
        <div className="lg:col-span-8 bg-[#121316] border border-[#22242a] rounded-2xl flex flex-col overflow-hidden">
          {isEditing ? (
            /* Editing Mode */
            <div className="flex-1 flex flex-col p-4 sm:p-5 space-y-3 overflow-y-auto">
              {/* Header with Title & Mode Switcher */}
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-zinc-800">
                <input
                  type="text"
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  placeholder="文档标题..."
                  className="bg-transparent text-sm sm:text-base font-semibold text-zinc-100 focus:outline-none flex-1"
                />

                <div className="flex items-center gap-2 shrink-0">
                  {/* Mode switcher tabs */}
                  <div className="flex items-center bg-zinc-900 rounded-lg p-0.5 border border-zinc-800">
                    <button
                      type="button"
                      onClick={() => setEditorMode('split')}
                      className={`px-2 py-1 rounded text-[11px] flex items-center gap-1 transition-colors ${
                        editorMode === 'split' ? 'bg-zinc-800 text-white font-medium' : 'text-zinc-400 hover:text-zinc-200'
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
                        editorMode === 'edit' ? 'bg-zinc-800 text-white font-medium' : 'text-zinc-400 hover:text-zinc-200'
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
                        editorMode === 'preview' ? 'bg-zinc-800 text-white font-medium' : 'text-zinc-400 hover:text-zinc-200'
                      }`}
                      title="预览渲染效果"
                    >
                      <Eye className="w-3 h-3" />
                      <span className="hidden sm:inline">预览</span>
                    </button>
                  </div>

                  <button
                    onClick={() => setIsEditing(false)}
                    className="px-3 py-1 rounded-lg bg-zinc-900 hover:bg-zinc-800 text-xs text-zinc-400 hover:text-white"
                  >
                    取消
                  </button>
                  <button
                    onClick={handleSave}
                    className="px-3.5 py-1 rounded-lg bg-zinc-100 text-zinc-900 hover:bg-white text-xs font-semibold flex items-center gap-1 shadow-sm"
                  >
                    <Save className="w-3.5 h-3.5" />
                    <span>保存</span>
                  </button>
                </div>
              </div>

              {/* Metadata inputs */}
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div>
                  <label className="block text-[11px] text-zinc-400 mb-1">所属分类</label>
                  <input
                    type="text"
                    value={editCategory}
                    onChange={(e) => setEditCategory(e.target.value)}
                    placeholder="例如: 生产部署 / Linux安全"
                    className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-1.5 text-xs text-zinc-100 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-[11px] text-zinc-400 mb-1">标签 (逗号分隔)</label>
                  <input
                    type="text"
                    value={editTags}
                    onChange={(e) => setEditTags(e.target.value)}
                    placeholder="架构, Docker, 备忘"
                    className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-1.5 text-xs text-zinc-100 focus:outline-none"
                  />
                </div>
              </div>

              {/* Main Content Pane (Adaptive split/edit/preview) */}
              <div className="flex-1 min-h-[350px] flex flex-col pt-1">
                {editorMode === 'split' ? (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3 flex-1">
                    <div className="flex flex-col">
                      <div className="text-[11px] text-zinc-500 mb-1 font-mono flex items-center justify-between">
                        <span>Markdown 源码</span>
                        <span>{editContent.length} 字符</span>
                      </div>
                      <textarea
                        value={editContent}
                        onChange={(e) => setEditContent(e.target.value)}
                        placeholder="使用 Markdown 自由记录详细内容..."
                        className="flex-1 w-full bg-zinc-900/90 border border-zinc-800 rounded-xl p-3.5 text-xs font-mono text-zinc-200 leading-relaxed focus:outline-none focus:border-zinc-700 resize-none min-h-[300px]"
                      />
                    </div>
                    <div className="flex flex-col">
                      <div className="text-[11px] text-zinc-500 mb-1 font-mono">实时渲染预览</div>
                      <div className="flex-1 bg-[#0d0e11] border border-zinc-800/80 rounded-xl p-4 overflow-y-auto text-xs min-h-[300px]">
                        <MarkdownViewer content={editContent} />
                      </div>
                    </div>
                  </div>
                ) : editorMode === 'edit' ? (
                  <div className="flex flex-col flex-1">
                    <div className="text-[11px] text-zinc-500 mb-1 font-mono flex items-center justify-between">
                      <span>Markdown 源码</span>
                      <span>{editContent.length} 字符</span>
                    </div>
                    <textarea
                      value={editContent}
                      onChange={(e) => setEditContent(e.target.value)}
                      placeholder="使用 Markdown 自由记录详细内容..."
                      className="flex-1 w-full bg-zinc-900/90 border border-zinc-800 rounded-xl p-3.5 text-xs font-mono text-zinc-200 leading-relaxed focus:outline-none focus:border-zinc-700 resize-none min-h-[350px]"
                    />
                  </div>
                ) : (
                  <div className="flex flex-col flex-1">
                    <div className="text-[11px] text-zinc-500 mb-1 font-mono">预览渲染效果</div>
                    <div className="flex-1 bg-[#0d0e11] border border-zinc-800/80 rounded-xl p-5 overflow-y-auto text-xs min-h-[350px]">
                      <MarkdownViewer content={editContent} />
                    </div>
                  </div>
                )}
              </div>

              {/* Editor Status Footer */}
              <div className="pt-2 border-t border-zinc-800/60 flex items-center justify-between text-[11px] font-mono text-zinc-500">
                <div className="flex items-center gap-2">
                  {draftSavedAt ? (
                    <span className="flex items-center gap-1 text-emerald-400/90">
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
              <div className="p-4 sm:p-5 border-b border-zinc-800 flex items-center justify-between gap-3 bg-zinc-900/20">
                <div className="min-w-0">
                  <h3 className="text-sm sm:text-base font-semibold text-zinc-100 truncate">
                    {selectedNote.title}
                  </h3>
                  <div className="flex items-center gap-2 mt-1 text-[11px] text-zinc-400">
                    <span className="px-1.5 py-0.2 rounded bg-zinc-800 font-mono text-zinc-300">
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
                    className="px-2.5 py-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 text-xs text-zinc-300 flex items-center gap-1 border border-zinc-800 transition-colors"
                    title="导出为标准 Obsidian/GitHub Markdown 文件"
                  >
                    <Download className="w-3 h-3 text-sky-400" />
                    <span>导出 .md</span>
                  </button>
                  <button
                    onClick={handleCopyContent}
                    className="px-2.5 py-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 text-xs text-zinc-300 flex items-center gap-1 border border-zinc-800 transition-colors"
                    title="复制全篇正文"
                  >
                    {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                    <span>{copied ? '已复制' : '复制全文'}</span>
                  </button>
                  <button
                    onClick={() => handleStartEdit(selectedNote)}
                    className="px-2.5 py-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 text-xs text-zinc-300 flex items-center gap-1 border border-zinc-800 transition-colors"
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
                    className="p-1.5 rounded-lg hover:bg-zinc-800 text-zinc-400 hover:text-red-400 transition-colors"
                    title="删除"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>

              {/* Rich Markdown Rendered Body */}
              <div className="flex-1 p-5 sm:p-6 overflow-y-auto leading-relaxed select-text bg-[#0d0e11]">
                <MarkdownViewer content={selectedNote.content} />
              </div>

              {/* Footer Tags & Info */}
              {selectedNote.tags && selectedNote.tags.length > 0 && (
                <div className="px-5 py-2.5 border-t border-zinc-800/60 bg-zinc-900/10 flex items-center gap-2 overflow-x-auto text-xs">
                  <Tag className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
                  {selectedNote.tags.map((t, idx) => (
                    <span
                      key={idx}
                      className="px-2 py-0.5 rounded-md bg-zinc-900 text-zinc-400 border border-zinc-800 text-[11px] font-mono"
                    >
                      #{t}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div className="flex-1 flex items-center justify-center text-xs text-zinc-400">
              请在左侧选择一篇文档，或点击右上角新建知识文档
            </div>
          )}
        </div>

      </div>

    </div>
  );
};

// =========================================================================
// Custom High-Performance Lightweight Markdown Viewer Component
// =========================================================================
function MarkdownViewer({ content }: { content: string }) {
  if (!content) {
    return <p className="text-zinc-500 italic text-xs">暂无正文内容...</p>;
  }

  // Parse lines into blocks
  const lines = content.split('\n');
  const elements: React.ReactNode[] = [];
  let inCodeBlock = false;
  let codeBuffer: string[] = [];
  let codeLang = '';

  const renderInline = (text: string): React.ReactNode => {
    // Basic inline formatting: **bold**, `code`, [link](url)
    const parts: React.ReactNode[] = [];
    const regex = /(\*\*.*?\*\*|`.*?`|\[.*?\]\(.*?\))/g;
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(text)) !== null) {
      if (match.index > lastIndex) {
        parts.push(text.slice(lastIndex, match.index));
      }
      const token = match[0];
      if (token.startsWith('**') && token.endsWith('**')) {
        parts.push(
          <strong key={match.index} className="text-zinc-100 font-semibold">
            {token.slice(2, -2)}
          </strong>
        );
      } else if (token.startsWith('`') && token.endsWith('`')) {
        parts.push(
          <code
            key={match.index}
            className="px-1.5 py-0.5 rounded bg-zinc-800 text-indigo-300 font-mono text-[11px]"
          >
            {token.slice(1, -1)}
          </code>
        );
      } else if (token.startsWith('[') && token.includes('](')) {
        const linkMatch = token.match(/\[(.*?)\]\((.*?)\)/);
        if (linkMatch) {
          parts.push(
            <a
              key={match.index}
              href={linkMatch[2]}
              target="_blank"
              rel="noreferrer"
              className="text-sky-400 hover:underline"
            >
              {linkMatch[1]}
            </a>
          );
        }
      }
      lastIndex = match.index + token.length;
    }

    if (lastIndex < text.length) {
      parts.push(text.slice(lastIndex));
    }

    return parts.length > 0 ? parts : text;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Code block delimiters
    if (line.trim().startsWith('```')) {
      if (inCodeBlock) {
        // End of code block
        const codeText = codeBuffer.join('\n');
        elements.push(
          <CodeSnippetBlock key={`code-${i}`} code={codeText} lang={codeLang} />
        );
        codeBuffer = [];
        codeLang = '';
        inCodeBlock = false;
      } else {
        // Start of code block
        inCodeBlock = true;
        codeLang = line.trim().slice(3).trim();
      }
      continue;
    }

    if (inCodeBlock) {
      codeBuffer.push(line);
      continue;
    }

    // Headings
    if (line.startsWith('# ')) {
      elements.push(
        <h1 key={i} className="text-lg font-bold text-zinc-100 mt-4 mb-2 pb-1.5 border-b border-zinc-800">
          {renderInline(line.slice(2))}
        </h1>
      );
    } else if (line.startsWith('## ')) {
      elements.push(
        <h2 key={i} className="text-base font-semibold text-zinc-150 mt-3 mb-1.5 text-zinc-200">
          {renderInline(line.slice(3))}
        </h2>
      );
    } else if (line.startsWith('### ')) {
      elements.push(
        <h3 key={i} className="text-sm font-semibold text-zinc-300 mt-2.5 mb-1">
          {renderInline(line.slice(4))}
        </h3>
      );
    } else if (line.startsWith('> ')) {
      // Blockquote
      elements.push(
        <blockquote key={i} className="border-l-2 border-indigo-500 bg-indigo-950/20 px-3.5 py-1.5 my-2 rounded-r text-zinc-300 italic text-xs">
          {renderInline(line.slice(2))}
        </blockquote>
      );
    } else if (/^[-*]\s+\[( |x)\]\s+/i.test(line)) {
      // Checklist
      const isChecked = /^[-*]\s+\[x\]/i.test(line);
      const itemText = line.replace(/^[-*]\s+\[( |x)\]\s+/i, '');
      elements.push(
        <div key={i} className="flex items-center gap-2 my-1 text-xs text-zinc-300">
          <input
            type="checkbox"
            checked={isChecked}
            readOnly
            className="rounded border-zinc-700 bg-zinc-800 text-indigo-500 focus:ring-0"
          />
          <span className={isChecked ? 'line-through text-zinc-500' : ''}>
            {renderInline(itemText)}
          </span>
        </div>
      );
    } else if (line.trim().startsWith('- ') || line.trim().startsWith('* ')) {
      // Bullet list
      elements.push(
        <div key={i} className="flex items-start gap-2 my-1 text-xs text-zinc-300">
          <span className="text-indigo-400 mt-1 shrink-0">•</span>
          <span>{renderInline(line.trim().slice(2))}</span>
        </div>
      );
    } else if (/^\d+\.\s+/.test(line.trim())) {
      // Numbered list
      const numMatch = line.trim().match(/^(\d+)\.\s+(.*)/);
      if (numMatch) {
        elements.push(
          <div key={i} className="flex items-start gap-2 my-1 text-xs text-zinc-300">
            <span className="font-mono text-indigo-400 shrink-0">{numMatch[1]}.</span>
            <span>{renderInline(numMatch[2])}</span>
          </div>
        );
      }
    } else if (line.trim() === '---' || line.trim() === '***') {
      elements.push(<hr key={i} className="my-4 border-zinc-800" />);
    } else if (line.trim() === '') {
      elements.push(<div key={i} className="h-2" />);
    } else {
      elements.push(
        <p key={i} className="text-xs text-zinc-300 leading-relaxed my-1">
          {renderInline(line)}
        </p>
      );
    }
  }

  // Handle unclosed code block if file ends inside code fence
  if (inCodeBlock && codeBuffer.length > 0) {
    elements.push(
      <CodeSnippetBlock key="code-unclosed" code={codeBuffer.join('\n')} lang={codeLang} />
    );
  }

  return <div className="space-y-0.5">{elements}</div>;
}

function CodeSnippetBlock({ code, lang }: { code: string; lang: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="my-3 rounded-xl border border-zinc-800 bg-[#090a0c] overflow-hidden">
      <div className="px-3.5 py-1.5 bg-zinc-900/80 border-b border-zinc-800/80 flex items-center justify-between text-[11px] font-mono text-zinc-400">
        <span>{lang || 'code'}</span>
        <button
          onClick={handleCopy}
          className="flex items-center gap-1 hover:text-zinc-200 transition-colors"
        >
          {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
          <span>{copied ? '已复制' : '复制代码'}</span>
        </button>
      </div>
      <pre className="p-3.5 overflow-x-auto text-xs font-mono text-zinc-200 leading-relaxed">
        <code>{code}</code>
      </pre>
    </div>
  );
}
