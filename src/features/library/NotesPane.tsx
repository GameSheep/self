import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, FileText, Folder, FolderPlus, Save, Trash2, X } from 'lucide-react';
import type { QuickNote } from '../../types';
import { ConfirmButton, EmptyState, PageHeader, inputClass, useDirtyGuard } from '../../shared/ui';
import { MarkdownEditor, type EditorMode } from '../../components/MarkdownEditor';

export interface NotesPaneProps {
  notes: QuickNote[];
  /** Explicit folder paths (so an empty folder survives a reload). */
  folders?: string[];
  onAddNote: (note: QuickNote) => void;
  onUpdateNote: (note: QuickNote) => void;
  onDeleteNote: (id: string) => void;
  onAddFolder?: (path: string) => void;
  onRemoveFolder?: (path: string) => void;
}

// Own key, not NotesView's: the two draft systems have different schemas and
// sharing one key let a keystroke in one pane overwrite the other pane's
// crash-recovery draft.
const DRAFT_KEY = 'selfhub_note_draft_pane';

interface Draft {
  noteId: string | null;
  text: string;
  folder?: string;
  at: number;
}

interface TreeNode {
  name: string;
  path: string;
  children: TreeNode[];
  /** Notes directly in this folder. */
  count: number;
}

function readDraft(): Draft | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Draft;
    return parsed?.text ? parsed : null;
  } catch {
    return null;
  }
}

function writeDraft(draft: Draft | null) {
  try {
    if (draft) localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
    else localStorage.removeItem(DRAFT_KEY);
  } catch {
    /* storage full: the editor still works, only crash recovery is lost */
  }
}

/** Build the folder tree from explicit paths plus whatever the notes reference. */
function buildTree(notes: QuickNote[], folders: string[]): TreeNode[] {
  const root: TreeNode = { name: '', path: '', children: [], count: 0 };
  const ensure = (path: string): TreeNode => {
    const parts = path.split('/').filter(Boolean);
    let node = root;
    let walked = '';
    for (const part of parts) {
      walked = walked ? `${walked}/${part}` : part;
      let child = node.children.find((entry) => entry.name === part);
      if (!child) {
        child = { name: part, path: walked, children: [], count: 0 };
        node.children.push(child);
      }
      node = child;
    }
    return node;
  };
  for (const folder of folders) if (folder.trim()) ensure(folder.trim());
  for (const note of notes) if (note.folder?.trim()) ensure(note.folder.trim()).count += 1;
  const sort = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => a.name.localeCompare(b.name));
    nodes.forEach((node) => sort(node.children));
  };
  sort(root.children);
  return root.children;
}

/** Every note under `path` (including subfolders). */
function notesIn(notes: QuickNote[], path: string): QuickNote[] {
  if (!path) return notes;
  return notes.filter((note) => note.folder === path || (note.folder ?? '').startsWith(`${path}/`));
}

/** Short age for the note list's second line; empty for missing/pre-2000 fixtures. */
function noteAge(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0 || new Date(ts).getFullYear() < 2000) return '';
  const diff = Math.max(0, Date.now() - ts);
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 30 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  return new Date(ts).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
}

/**
 * 笔记 (3.2 + 文件夹树)。
 *
 * The editor is still one big textarea; what changed is the left column: a **multi-level folder
 * tree** (folders are `/`-separated paths, so moving a note is one string change). Selecting a
 * folder filters the list; a new note is created in the selected folder.
 */
export const NotesPane: React.FC<NotesPaneProps> = ({
  notes,
  folders = [],
  onAddNote,
  onUpdateNote,
  onDeleteNote,
  onAddFolder,
  onRemoveFolder
}) => {
  const sorted = useMemo(
    () => [...notes].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)),
    [notes]
  );
  const tree = useMemo(() => buildTree(sorted, folders), [sorted, folders]);
  const allFolderPaths = useMemo(() => {
    const paths = new Set<string>(folders.filter(Boolean));
    for (const note of sorted) {
      const folder = note.folder?.trim();
      if (!folder) continue;
      const parts = folder.split('/').filter(Boolean);
      for (let i = 1; i <= parts.length; i += 1) paths.add(parts.slice(0, i).join('/'));
    }
    return Array.from(paths).sort();
  }, [folders, sorted]);

  const [selectedFolder, setSelectedFolder] = useState('');
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [selectedId, setSelectedId] = useState<string>(sorted[0]?.id ?? '');
  const [text, setText] = useState('');
  const [dirty, setDirty] = useState(false);
  const [restorable, setRestorable] = useState<Draft | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [newFolder, setNewFolder] = useState<string | null>(null);
  const [browsing, setBrowsing] = useState(false);
  /** 编辑 / 预览两态；本地笔记以前只有裸 textarea，是全站唯一没有渲染的编辑器。 */
  const [editorMode, setEditorMode] = useState<EditorMode>('edit');
  /** 列表分页：1000 篇笔记不该一次画 1000 个 DOM 节点（照抄 AnnotationsPane）。 */
  const [visibleCount, setVisibleCount] = useState(100);

  // 切换笔记 / 新建 / 点文件夹之前都要过这道闸：旧实现直接 setSelectedId，
  // useEffect 立刻用新笔记覆盖 textarea，正在写的内容在会话内就没了。
  // 草稿虽然 800ms 后会写本机，但「写了什么」不该靠崩溃恢复来兜底。
  const { request: requestLeave, dialog: guardDialog } = useDirtyGuard({
    isDirty: dirty,
    title: '这篇笔记还没有保存',
    message: '切换会离开当前编辑。内容已自动暂存为草稿，可稍后从顶部横幅恢复；留在本页可先按 Ctrl/⌘ + Enter 保存。'
  });

  /** 换一篇笔记：脏时先过守卫，避免编辑中的内容被静默覆盖。 */
  const switchTo = (id: string, after?: () => void) => {
    requestLeave().then((ok) => {
      if (!ok) return;
      setSelectedId(id);
      after?.();
    });
  };

  const visibleNotes = useMemo(() => {
    const inFolder = notesIn(sorted, selectedFolder);
    const needle = query.trim().toLowerCase();
    if (!needle) return inFolder;
    return inFolder.filter((note) =>
      `${note.title} ${note.content} ${(note.tags || []).join(' ')}`.toLowerCase().includes(needle)
    );
  }, [sorted, selectedFolder, query]);
  const selected = sorted.find((note) => note.id === selectedId) ?? null;

  useEffect(() => {
    const draft = readDraft();
    if (draft) setRestorable(draft);
  }, []);

  useEffect(() => {
    if (!selected) {
      setText('');
      setDirty(false);
      return;
    }
    setText(selected.title ? `${selected.title}\n\n${selected.content}` : selected.content);
    setDirty(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id]);

  useEffect(() => {
    if (!dirty) return;
    const timer = setTimeout(() => {
      writeDraft({ noteId: selected?.id ?? null, text, folder: selectedFolder, at: Date.now() });
    }, 800);
    return () => clearTimeout(timer);
  }, [text, dirty, selected?.id, selectedFolder]);

  const save = () => {
    const raw = text.trim();
    if (!raw) return;
    const lines = raw.split('\n');
    const title = (lines[0] || '').replace(/^#+\s*/, '').trim().slice(0, 80) || '未命名笔记';
    // A single line IS the title — keeping it as the body too made reopening
    // the editor show the title twice ("标题\n\n标题").
    const body = lines.length > 1 ? lines.slice(1).join('\n').trim() : '';
    if (selected) {
      onUpdateNote({ ...selected, title, content: body, updatedAt: Date.now() });
    } else {
      const note: QuickNote = {
        id: `note-${Date.now()}`,
        title,
        content: body,
        category: '速记',
        folder: selectedFolder || undefined,
        tags: [],
        updatedAt: Date.now()
      };
      onAddNote(note);
      setSelectedId(note.id);
    }
    writeDraft(null);
    setDirty(false);
    setSavedAt(Date.now());
  };

  const startNew = () => {
    requestLeave().then((ok) => {
      if (!ok) return;
      setBrowsing(false);
      setSelectedId('');
      setText('');
      setDirty(false);
      setEditorMode('edit');
      setTimeout(() => {
        (document.querySelector('[data-testid="notes-textarea"]') as HTMLTextAreaElement | null)?.focus();
      }, 0);
    });
  };

  const createFolder = () => {
    const path = (newFolder ?? '').trim().replace(/^\/+|\/+$/g, '');
    if (!path) return;
    onAddFolder?.(path);
    setSelectedFolder(path);
    setExpanded((prev) => {
      const next = { ...prev };
      const parts = path.split('/');
      for (let i = 1; i <= parts.length; i += 1) next[parts.slice(0, i).join('/')] = true;
      return next;
    });
    setNewFolder('');
  };

  const renderTree = (nodes: TreeNode[], depth = 0): React.ReactNode =>
    nodes.map((node) => {
      const isOpen = expanded[node.path] ?? true;
      const active = selectedFolder === node.path;
      return (
        <div key={node.path}>
          <div
            className={`flex items-center gap-1 rounded-lg pr-1 ${
              active ? 'bg-sh-surface2 text-sh-fg' : 'text-sh-muted hover:text-sh-fg'
            }`}
            style={{ paddingLeft: `${depth * 12}px` }}
          >
            <button
              onClick={() => setExpanded((prev) => ({ ...prev, [node.path]: !isOpen }))}
              aria-label={isOpen ? '收起' : '展开'}
              className="p-0.5 rounded hover:bg-sh-surface"
              data-folder-toggle={node.path}
            >
              {node.children.length > 0 ? (
                isOpen ? (
                  <ChevronDown className="w-3 h-3" aria-hidden />
                ) : (
                  <ChevronRight className="w-3 h-3" aria-hidden />
                )
              ) : (
                <span className="inline-block w-3" />
              )}
            </button>
            <button
              onClick={() => {
                setSelectedFolder(node.path);
                const first = notesIn(sorted, node.path)[0];
                if (first) switchTo(first.id);
              }}
              data-folder-path={node.path}
              className="flex-1 min-w-0 flex items-center gap-1.5 py-1 text-left text-[11px]"
            >
              <Folder className="w-3 h-3 shrink-0" aria-hidden />
              <span className="truncate">{node.name}</span>
              <span className="text-[10px] text-sh-subtle">{notesIn(sorted, node.path).length}</span>
            </button>
            {onRemoveFolder && (
              <button
                onClick={() => {
                  onRemoveFolder(node.path);
                  if (selectedFolder === node.path) setSelectedFolder('');
                }}
                aria-label={`删除文件夹 ${node.path}`}
                data-folder-remove={node.path}
                className="p-0.5 rounded text-sh-subtle hover:text-sh-danger"
              >
                <X className="w-3 h-3" aria-hidden />
              </button>
            )}
          </div>
          {isOpen && node.children.length > 0 && renderTree(node.children, depth + 1)}
        </div>
      );
    });

  return (
    <div data-testid="notes-pane">
      {guardDialog}
      <PageHeader
        title="笔记"
        description="直接写或粘贴内容，第一行是标题。Ctrl/⌘ + Enter 保存。"
        actions={
          <button
            onClick={startNew}
            className="sh-tap px-3 py-1.5 rounded-lg bg-sh-accent text-sh-accent-fg text-sm font-medium"
            data-testid="notes-new-empty"
          >
            新建笔记
          </button>
        }
      />

      {restorable && (
        <div
          className="mb-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2 rounded-xl border border-sh-warn/50 bg-sh-warn/10 px-3 py-2 text-[11px] text-sh-warn"
          data-testid="notes-draft-banner"
        >
          <span>检测到上次未保存的草稿（{new Date(restorable.at).toLocaleString()}）。</span>
          <span className="flex items-center gap-2">
            <button
              onClick={() => {
                setText(restorable.text);
                if (restorable.folder) setSelectedFolder(restorable.folder);
                setDirty(true);
                setRestorable(null);
                writeDraft(null);
              }}
              data-testid="notes-draft-restore"
              className="px-2 py-1 rounded bg-sh-warn text-black font-semibold"
            >
              恢复
            </button>
            <button
              onClick={() => {
                writeDraft(null);
                setRestorable(null);
              }}
              data-testid="notes-draft-discard"
              className="px-2 py-1 rounded border border-sh-line"
            >
              丢弃
            </button>
          </span>
        </div>
      )}

      <button onClick={() => setBrowsing(!browsing)} aria-expanded={browsing} aria-controls="notes-browser"
        className="lg:hidden sh-tap mb-3 inline-flex items-center gap-2 text-sm text-sh-muted" data-testid="notes-browse-toggle">
        {browsing ? <ChevronDown className="w-4 h-4" aria-hidden /> : <ChevronRight className="w-4 h-4" aria-hidden />}
        {browsing ? '返回编辑' : '笔记列表与文件夹'} <span className="text-xs text-sh-subtle">{sorted.length} 篇</span>
      </button>
      <div className="grid grid-cols-1 lg:grid-cols-[248px_minmax(0,1fr)] gap-4">
        <aside id="notes-browser" className={`${browsing ? 'block' : 'hidden'} lg:block min-w-0 space-y-3`} aria-label="笔记文件夹">
          <div className="flex items-center gap-1.5">
            <input
              value={newFolder ?? ''}
              onChange={(e) => setNewFolder(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  createFolder();
                }
              }}
              placeholder="新建文件夹（可写 a/b 建多层）"
              aria-label="新建文件夹"
              data-testid="notes-new-folder-input"
              className={`${inputClass} flex-1 min-w-0`}
            />
            <button
              onClick={createFolder}
              disabled={!(newFolder ?? '').trim()}
              data-testid="notes-new-folder-add"
              aria-label="新建文件夹"
              className="p-1.5 rounded-lg border border-sh-line text-sh-muted hover:text-sh-fg disabled:opacity-50"
            >
              <FolderPlus className="w-3.5 h-3.5" aria-hidden />
            </button>
          </div>

          <div className="space-y-0.5 max-h-[52vh] overflow-y-auto" data-testid="notes-folder-tree">
            <button
              onClick={() => setSelectedFolder('')}
              data-folder-path=""
              className={`w-full flex items-center gap-1.5 px-2 py-1 rounded-lg text-left text-[11px] ${
                selectedFolder === '' ? 'bg-sh-surface2 text-sh-fg' : 'text-sh-muted hover:text-sh-fg'
              }`}
            >
              <Folder className="w-3 h-3 shrink-0" aria-hidden />
              <span className="flex-1">全部笔记</span>
              <span className="text-[10px] text-sh-subtle">{sorted.length}</span>
            </button>
            {renderTree(tree)}
          </div>

          <div className="space-y-0.5 max-h-[36vh] overflow-y-auto border-t border-sh-line pt-1.5">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索笔记"
              aria-label="搜索笔记"
              data-testid="notes-search"
              className={`${inputClass} mb-1`}
            />
            <div className="mb-1 flex items-center justify-between gap-2 border-b border-sh-line px-1 pb-1.5">
              <span className="truncate text-[11px] font-semibold text-sh-muted">
                {selectedFolder || '笔记列表'}
              </span>
              <span className="shrink-0 font-mono text-[10px] tabular-nums text-sh-subtle">
                {visibleNotes.length} 篇
              </span>
            </div>
            {visibleNotes.length === 0 ? (
              <p className="px-1 py-2 text-[11px] text-sh-subtle">这个文件夹还没有笔记，右边直接写。</p>
            ) : (
              visibleNotes.slice(0, visibleCount).map((note) => {
                const selectedNote = note.id === selectedId;
                const meta = [note.folder || '根目录', noteAge(note.updatedAt)].filter(Boolean).join(' · ');
                return (
                  <div
                    key={note.id}
                    data-testid={`note-row-${note.id}`}
                    data-selected={selectedNote ? 'true' : 'false'}
                    className={`group flex items-start gap-2 rounded-lg border px-2 py-2 transition-colors ${
                      selectedNote
                        ? 'border-sh-line-strong bg-sh-surface'
                        : 'border-transparent hover:border-sh-line hover:bg-sh-surface2/50'
                    }`}
                  >
                    <FileText
                      className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${selectedNote ? 'text-sh-fg' : 'text-sh-subtle'}`}
                      aria-hidden
                    />
                    <button
                      onClick={() => switchTo(note.id, () => setBrowsing(false))}
                      aria-label={note.title || '未命名笔记'}
                      aria-current={selectedNote ? 'true' : undefined}
                      title={note.title || '未命名笔记'}
                      className="sh-tap min-w-0 flex-1 text-left"
                    >
                      <span className="line-clamp-2 text-[13px] font-semibold leading-snug text-sh-fg">
                        {note.title || '未命名笔记'}
                      </span>
                      {meta && (
                        <span className={`mt-1 block truncate text-[10px] ${selectedNote ? 'text-sh-muted' : 'text-sh-subtle'}`}>
                          {meta}
                        </span>
                      )}
                    </button>
                    <ConfirmButton
                      onConfirm={() => {
                        onDeleteNote(note.id);
                        if (note.id === selectedId) setSelectedId('');
                      }}
                      confirmLabel="确认删除？"
                      aria-label={`删除 ${note.title || '未命名笔记'}`}
                      data-testid={`note-delete-${note.id}`}
                      className="mt-0.5 shrink-0 rounded p-1 text-sh-subtle opacity-100 transition-opacity hover:text-sh-danger lg:opacity-0 lg:group-hover:opacity-100 focus:opacity-100"
                    >
                      <Trash2 className="w-3 h-3" aria-hidden />
                    </ConfirmButton>
                  </div>
                );
              })
            )}
            {visibleNotes.length > visibleCount && (
              <button
                onClick={() => setVisibleCount((count) => count + 200)}
                data-testid="notes-show-more"
                className="w-full py-1.5 text-[11px] text-sh-muted hover:text-sh-fg"
              >
                再显示 200 篇（还有 {visibleNotes.length - visibleCount} 篇）
              </button>
            )}
          </div>
        </aside>

        <section className={`${browsing ? 'hidden' : 'block'} lg:block min-w-0 rounded-xl border border-sh-line bg-sh-surface p-3 space-y-3`} data-testid="notes-editor">
          <div className="flex flex-wrap items-center gap-2">
            <label className="min-w-0 flex items-center gap-1.5 text-xs text-sh-muted">
              所在文件夹
              <select
                value={selected?.folder ?? selectedFolder}
                onChange={(e) => {
                  const folder = e.target.value;
                  if (selected) {
                    onUpdateNote({ ...selected, folder: folder || undefined, updatedAt: Date.now() });
                  } else {
                    setSelectedFolder(folder);
                  }
                }}
                data-testid="notes-note-folder"
                className="min-w-0 bg-sh-surface2 border border-sh-line rounded px-2 py-1 text-xs text-sh-fg max-w-[200px]"
              >
                <option value="">（根目录）</option>
                {allFolderPaths.map((path) => (
                  <option key={path} value={path}>
                    {path}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <MarkdownEditor
            value={text}
            onChange={(next) => {
              setText(next);
              setDirty(true);
            }}
            noteKey={selected?.id ?? '__new__'}
            onSave={save}
            mode={editorMode}
            onModeChange={setEditorMode}
            dirty={dirty}
            placeholder="直接把内容粘进来…&#10;第一行会成为标题，其余是正文。支持 Markdown；Ctrl/⌘ + Enter 保存。"
            textareaTestId="notes-textarea"
          />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-[11px] text-sh-subtle" data-testid="notes-status">
              {dirty ? '有未保存的修改（草稿已本机暂存）' : savedAt ? '已保存' : selected ? '已载入所选笔记' : '新的一篇'}
              {selectedFolder ? ` · 存到 ${selectedFolder}` : ''} · {text.length} 字符
            </span>
            <div className="flex items-center gap-2">
              {selected && (
                <ConfirmButton
                  onConfirm={() => {
                    onDeleteNote(selected.id);
                    setSelectedId('');
                    writeDraft(null);
                  }}
                  confirmLabel="删除后不可恢复，确认？"
                  confirmDetail={selected.title || '未命名笔记'}
                  data-testid="notes-delete-current"
                  className="px-2.5 py-1 rounded-lg border border-sh-line text-[11px] text-sh-danger"
                >
                  删除这篇
                </ConfirmButton>
              )}
              <button
                onClick={save}
                disabled={!text.trim()}
                data-testid="notes-save"
                className="sh-tap inline-flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-sh-accent text-sh-accent-fg text-sm font-semibold disabled:opacity-50"
              >
                <Save className="w-3.5 h-3.5" aria-hidden />
                保存
              </button>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
};

export default NotesPane;
