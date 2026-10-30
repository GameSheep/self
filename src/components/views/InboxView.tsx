import React, { useRef, useState } from 'react';
import { 
  Inbox, 
  Plus, 
  ExternalLink, 
  FileText, 
  Globe, 
  FolderPlus, 
  Check, 
  Trash2, 
  Archive, 
  Sparkles, 
  Clock, 
  Tag, 
  ArrowRight,
  Code2,
  CheckCircle2,
  Search,
  Edit3,
  Filter,
  X,
  Layers
} from 'lucide-react';
import { InboxItem, QuickNote, NavSite, ProjectItem } from '../../types';
import { ConfirmDialog } from '../../shared/ui';
import type { BatchPreview, ConversionResult } from '../../hooks/useInboxActions';

interface InboxViewProps {
  inbox: InboxItem[];
  onAddInboxItem: (item: InboxItem) => void;
  onUpdateInboxItem: (item: InboxItem) => void;
  onDeleteInboxItem: (id: string) => void;
  /** Returns the real outcome: the target id, or why nothing was created. */
  onConvertToNote: (item: InboxItem) => ConversionResult;
  onConvertToSite: (item: InboxItem) => ConversionResult;
  projects?: ProjectItem[];
  onAssignToProject?: (itemId: string, projectId: string) => ConversionResult;
  /** What a batch conversion would do, for the preview step. */
  onPreviewBatch?: (items: InboxItem[], target: 'note' | 'site') => BatchPreview;
  /** Run a batch; failures come back per item instead of aborting everything. */
  onConvertMany?: (
    items: InboxItem[],
    target: 'note' | 'site'
  ) => { results: Array<{ id: string; result: ConversionResult }> };
  /** Open the entity an already-converted item points at. */
  onOpenTarget?: (type: 'note' | 'site' | 'project', id: string) => void;
}

export const InboxView: React.FC<InboxViewProps> = ({
  inbox,
  onAddInboxItem,
  onUpdateInboxItem,
  onDeleteInboxItem,
  onConvertToNote,
  onConvertToSite,
  projects = [],
  onAssignToProject,
  onPreviewBatch,
  onConvertMany,
  onOpenTarget
}) => {
  const [filter, setFilter] = useState<'inbox' | 'processed' | 'all'>('inbox');
  const [typeFilter, setTypeFilter] = useState<'all' | 'url' | 'text' | 'snippet'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [quickInput, setQuickInput] = useState('');
  const [quickTitle, setQuickTitle] = useState('');
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  /**
   * Items converted during this session stay in the current list so the user can
   * see the outcome and open the original target. Cleared when the filter
   * changes, at which point the normal status filter applies again.
   */
  const [justProcessed, setJustProcessed] = useState<Set<string>>(() => new Set());

  // Edit Modal State
  const [editingItem, setEditingItem] = useState<InboxItem | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editContent, setEditContent] = useState('');
  const [editType, setEditType] = useState<'text' | 'url' | 'snippet'>('text');

  // One timer handle per view: without clearing, a second toast within 2.5s was
  // cut short by the first toast's timer.
  const toastTimerRef = useRef<number | null>(null);
  const showToast = (msg: string) => {
    setToastMessage(msg);
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToastMessage(null), 2500);
  };

  const isUrl = (text: string) => /^https?:\/\//i.test(text.trim());

  const handleQuickAdd = () => {
    if (!quickInput.trim()) return;

    const trimmed = quickInput.trim();
    const itemType = isUrl(trimmed) ? 'url' : trimmed.includes('```') ? 'snippet' : 'text';
    const autoTitle = quickTitle.trim() || (isUrl(trimmed) ? trimmed.replace(/^https?:\/\//, '').split('/')[0] : trimmed.slice(0, 30));

    const newItem: InboxItem = {
      id: `inbox-${Date.now()}`,
      title: autoTitle,
      content: trimmed,
      url: isUrl(trimmed) ? trimmed : undefined,
      type: itemType,
      status: 'inbox',
      createdAt: Date.now()
    };

    onAddInboxItem(newItem);
    setQuickInput('');
    setQuickTitle('');
    showToast('📥 已存入收件箱');
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      handleQuickAdd();
    }
  };

  const handleOpenEdit = (item: InboxItem) => {
    setEditingItem(item);
    setEditTitle(item.title || '');
    setEditContent(item.content);
    setEditType(item.type);
  };

  const handleSaveEdit = () => {
    if (!editingItem) return;
    const trimmedTitle = editTitle.trim() || editingItem.title || '碎片速记';
    const trimmedContent = editContent.trim();
    if (!trimmedContent) {
      showToast('⚠️ 内容不能为空');
      return;
    }
    // Only a URL-typed item keeps its url field; editing the title of a text item
    // must not wipe an existing url (or leave type='url' with no url).
    const detectedUrl = isUrl(trimmedContent)
      ? trimmedContent
      : editType === 'url'
        ? editingItem.url
        : undefined;

    onUpdateInboxItem({
      ...editingItem,
      title: trimmedTitle,
      content: trimmedContent,
      url: detectedUrl,
      type: editType
    });
    setEditingItem(null);
    showToast('💾 碎片资料已更新');
  };

  const handleBatchMarkAllProcessed = () => {
    const pending = inbox.filter(i => i.status === 'inbox');
    if (pending.length === 0) return;
    if (confirm(`确定将当前 ${pending.length} 个待整理项目全部标记为已处理？`)) {
      pending.forEach(item => {
        onUpdateInboxItem({ ...item, status: 'processed' });
      });
      showToast(`已批量处理 ${pending.length} 项`);
    }
  };

  /**
   * Batch conversion replaces the old "mark everything processed" shortcut as
   * the primary batch action. It shows what will be created first, then reports
   * partial failures per item instead of pretending the whole batch succeeded.
   */
  const [batchTarget, setBatchTarget] = useState<'note' | 'site' | null>(null);
  const [batchReport, setBatchReport] = useState<string | null>(null);

  const batchPreview: BatchPreview | null = batchTarget
    ? (onPreviewBatch?.(inbox.filter((i) => i.status === 'inbox'), batchTarget) ?? null)
    : null;

  const runBatch = () => {
    if (!batchTarget) return;
    const pending = inbox.filter((i) => i.status === 'inbox');
    if (!onConvertMany) return;
    const { results } = onConvertMany(pending, batchTarget);
    const ok = results.filter((r) => r.result.ok).length;
    const reused = results.filter((r) => r.result.reused).length;
    const failed = results.filter((r) => !r.result.ok);
    setBatchTarget(null);
    if (failed.length === 0) {
      showToast(`已处理 ${ok} 项${reused > 0 ? `（其中 ${reused} 项此前已转换，打开原目标）` : ''}`);
      setBatchReport(null);
    } else {
      setBatchReport(
        `完成 ${ok - reused} 项，另有 ${failed.length} 项未处理（内容已保留在收件箱）：` +
          failed
            .slice(0, 3)
            .map((f) => f.result.error || '未知原因')
            .join('；')
      );
    }
  };

  const handleBatchClearProcessed = () => {
    const processed = inbox.filter(i => i.status === 'processed');
    if (processed.length === 0) return;
    if (confirm(`确定彻底清除 ${processed.length} 个已处理碎片？`)) {
      processed.forEach(item => {
        onDeleteInboxItem(item.id);
      });
      showToast(`🗑️ 已清空 ${processed.length} 项已处理碎片`);
    }
  };

  const filteredItems = inbox.filter((item) => {
    // An item converted while the user is looking at the 待整理 list must not
    // vanish from under the cursor: it stays visible with its "打开原目标"
    // action until the filter changes, which is what makes the repeat action
    // discoverable instead of a dead end.
    if (justProcessed.has(item.id)) return true;
    if (filter !== 'all' && item.status !== filter) return false;
    if (typeFilter !== 'all' && item.type !== typeFilter) return false;
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      const matchTitle = item.title ? item.title.toLowerCase().includes(q) : false;
      const matchContent = item.content.toLowerCase().includes(q);
      const matchUrl = item.url ? item.url.toLowerCase().includes(q) : false;
      return matchTitle || matchContent || matchUrl;
    }
    return true;
  });

  const pendingCount = inbox.filter((i) => i.status === 'inbox').length;
  const processedCount = inbox.filter((i) => i.status === 'processed').length;

  return (
    <div className="space-y-5">
      {/* Toast Alert */}
      {toastMessage && (
        <div className="fixed bottom-6 right-6 z-50 px-4 py-2.5 rounded-xl bg-zinc-900 border border-zinc-700 text-zinc-100 text-xs font-mono shadow-2xl flex items-center gap-2 animate-in fade-in slide-in-from-bottom-2">
          <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
          <span>{toastMessage}</span>
        </div>
      )}

      {/* View Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-sh-surface p-4 sm:p-5 rounded-2xl border border-sh-line">
        <div>
          <h2 className="text-sm sm:text-base font-semibold text-zinc-100 flex items-center gap-2">
            <Inbox className="w-4 h-4 text-indigo-400" />
            <span>统一极速收件箱 (Quick Inbox)</span>
            <span className="px-2 py-0.5 rounded-full text-[10px] font-mono bg-indigo-950/70 text-indigo-300 border border-indigo-800/60">
              待整理: {pendingCount}
            </span>
          </h2>
          <p className="text-xs text-zinc-400 mt-0.5">
            快速倾倒临时灵感、网页链接、代码片段，后续无缝分流至「知识文档」、「常用书签」或「项目空间」
          </p>
        </div>

        {/* Batch Operations */}
        <div className="flex items-center gap-2">
          {pendingCount > 0 && onConvertMany && (
            <>
              <button
                onClick={() => setBatchTarget('note')}
                data-testid="inbox-batch-note"
                className="px-2.5 py-1.5 rounded-xl bg-zinc-900 border border-zinc-800 hover:border-zinc-700 text-[11px] text-zinc-300 hover:text-white transition-colors"
              >
                批量转为笔记 ({pendingCount})
              </button>
              <button
                onClick={() => setBatchTarget('site')}
                data-testid="inbox-batch-site"
                className="px-2.5 py-1.5 rounded-xl bg-zinc-900 border border-zinc-800 hover:border-zinc-700 text-[11px] text-zinc-300 hover:text-white transition-colors"
              >
                批量存为书签
              </button>
            </>
          )}
          {pendingCount > 0 && (
            <button
              onClick={handleBatchMarkAllProcessed}
              className="px-2.5 py-1.5 rounded-xl bg-zinc-900 border border-zinc-800 hover:border-zinc-700 text-[11px] text-zinc-300 hover:text-white transition-colors"
            >
              全部标记已处理
            </button>
          )}
          {processedCount > 0 && (
            <button
              onClick={handleBatchClearProcessed}
              className="px-2.5 py-1.5 rounded-xl bg-zinc-900 border border-zinc-800 hover:border-rose-900/60 text-[11px] text-zinc-400 hover:text-rose-400 transition-colors"
            >
              清空已处理 ({processedCount})
            </button>
          )}
        </div>
      </div>

      {batchReport && (
        <div
          data-testid="inbox-batch-report"
          className="rounded-2xl border border-amber-900/50 bg-amber-950/30 p-3 text-[11px] text-amber-300 leading-relaxed flex items-start justify-between gap-3"
        >
          <span>{batchReport}</span>
          <button onClick={() => setBatchReport(null)} className="shrink-0" aria-label="关闭">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      <ConfirmDialog
        open={batchTarget !== null}
        title="批量转换预览"
        description={
          batchPreview ? (
            <ul className="space-y-1">
              <li>共选中 {batchPreview.total} 项待整理内容。</li>
              <li>将新建 {batchPreview.willCreate} 条，写入 {batchPreview.destination}。</li>
              {batchPreview.alreadyConverted > 0 && (
                <li>{batchPreview.alreadyConverted} 项此前已转换，将打开原目标而不重复创建。</li>
              )}
              {batchPreview.notConvertible > 0 && (
                <li className="text-amber-400">{batchPreview.notConvertible} 项没有可识别的网址，无法存为书签，将保持原样。</li>
              )}
              <li>失败的项目会保留在收件箱，并说明原因。</li>
            </ul>
          ) : null
        }
        confirmLabel="开始转换"
        onConfirm={runBatch}
        onCancel={() => setBatchTarget(null)}
      />

      {/* Filter and Search Bar */}
      <div className="p-3 bg-sh-surface rounded-2xl border border-sh-line flex flex-col md:flex-row md:items-center justify-between gap-3">
        {/* Search */}
        <div className="relative flex-1 max-w-md">
          <Search className="w-3.5 h-3.5 text-zinc-500 absolute left-3 top-2.5" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="搜索碎片内容、网址或标题..."
            aria-label="搜索碎片"
            className="w-full bg-zinc-900 border border-zinc-800 rounded-xl pl-8 pr-3 py-1.5 text-xs text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-indigo-500"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              className="absolute right-2.5 top-2 text-zinc-500 hover:text-zinc-300"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        {/* Filters */}
        <div className="flex flex-wrap items-center gap-2">
          {/* Status filter */}
          <div className="flex items-center gap-1 p-1 bg-zinc-900 rounded-xl border border-zinc-800 text-xs">
            <button
              onClick={() => { setFilter('inbox'); setJustProcessed(new Set()); }}
              className={`px-2.5 py-1 rounded-lg text-xs transition-all ${
                filter === 'inbox' ? 'bg-indigo-950/80 text-indigo-200 border border-indigo-800/80 font-medium' : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              待整理 ({pendingCount})
            </button>
            <button
              onClick={() => { setFilter('processed'); setJustProcessed(new Set()); }}
              className={`px-2.5 py-1 rounded-lg text-xs transition-all ${
                filter === 'processed' ? 'bg-zinc-800 text-zinc-200 font-medium' : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              已分流 ({processedCount})
            </button>
            <button
              onClick={() => { setFilter('all'); setJustProcessed(new Set()); }}
              className={`px-2.5 py-1 rounded-lg text-xs transition-all ${
                filter === 'all' ? 'bg-zinc-800 text-zinc-200 font-medium' : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              全部 ({inbox.length})
            </button>
          </div>

          {/* Type filter */}
          <div className="flex items-center gap-1 p-1 bg-zinc-900 rounded-xl border border-zinc-800 text-[11px] font-mono">
            {(['all', 'url', 'text', 'snippet'] as const).map(t => (
              <button
                key={t}
                onClick={() => { setTypeFilter(t); setJustProcessed(new Set()); }}
                className={`px-2 py-0.5 rounded-lg capitalize transition-colors ${
                  typeFilter === t ? 'bg-zinc-800 text-zinc-100 font-bold' : 'text-zinc-500 hover:text-zinc-300'
                }`}
              >
                {t === 'all' ? '全部类型' : t === 'url' ? '链接' : t === 'text' ? '速记' : '代码'}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Quick Capture Dock */}
      <div className="p-4 rounded-2xl bg-sh-surface border border-sh-line space-y-3">
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={quickTitle}
            onChange={(e) => setQuickTitle(e.target.value)}
            placeholder="摘要标题 (可选，留空将自动推断)..."
            className="flex-1 bg-zinc-900 border border-zinc-800 rounded-xl px-3 py-2 text-xs text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-indigo-500"
          />
        </div>

        <div className="relative">
          <textarea
            value={quickInput}
            onChange={(e) => setQuickInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="粘贴任意文字、网址 (如 https://...) 或代码片段... 按 Ctrl+Enter 极速存入"
            rows={3}
            className="w-full bg-sh-bg border border-zinc-800/80 rounded-xl p-3 text-xs text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-indigo-500 font-mono resize-none"
          />
          <div className="flex items-center justify-between mt-2 pt-1">
            <span className="text-[11px] text-zinc-500 font-mono">
              提示: 输入 https:// 开头将自动识别为链接并支持一键转为书签
            </span>
            <button
              onClick={handleQuickAdd}
              disabled={!quickInput.trim()}
              className="px-4 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-semibold text-xs flex items-center gap-1.5 shadow-sm disabled:opacity-50 transition-colors"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>快速存入 (Ctrl+Enter)</span>
            </button>
          </div>
        </div>
      </div>

      {/* Inbox Items Feed */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
        {filteredItems.length === 0 ? (
          <div className="col-span-full py-16 text-center text-zinc-500 font-mono text-xs bg-sh-surface/50 rounded-2xl border border-zinc-800/50">
            <Inbox className="w-8 h-8 mx-auto mb-2 opacity-40 text-indigo-400" />
            <p>收件箱空空如也，所有碎片资料已整理完毕！</p>
          </div>
        ) : (
          filteredItems.map((item) => {
            const isProcessed = item.status === 'processed';

            return (
              <div
                key={item.id}
                className={`p-4 rounded-2xl border transition-all flex flex-col justify-between space-y-3 ${
                  isProcessed
                    ? 'bg-zinc-900/30 border-zinc-800/50 opacity-70'
                    : 'bg-sh-surface border-sh-line hover:border-zinc-700 shadow-sm'
                }`}
              >
                <div>
                  {/* Top Item Type Bar */}
                  <div className="flex items-center justify-between gap-2 mb-2">
                    <div className="flex items-center gap-2">
                      <span className={`px-2 py-0.5 rounded text-[10px] font-mono flex items-center gap-1 ${
                        item.type === 'url' ? 'bg-sky-950/60 text-sky-400 border border-sky-800/50' :
                        item.type === 'snippet' ? 'bg-amber-950/60 text-amber-400 border border-amber-800/50' :
                        'bg-purple-950/60 text-purple-400 border border-purple-800/50'
                      }`}>
                        {item.type === 'url' && <Globe className="w-3 h-3" />}
                        {item.type === 'snippet' && <Code2 className="w-3 h-3" />}
                        {item.type === 'text' && <FileText className="w-3 h-3" />}
                        <span>{item.type === 'url' ? 'URL链接' : item.type === 'snippet' ? '代码' : '速记'}</span>
                      </span>

                      <h3 className="text-xs font-semibold text-zinc-200 line-clamp-1">
                        {item.title}
                      </h3>
                    </div>

                    <span className="text-[10px] font-mono text-zinc-500 shrink-0">
                      {new Date(item.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </div>

                  {/* Body Content */}
                  {item.url ? (
                    <>
                      <a
                        href={item.url}
                        target="_blank"
                        rel="noreferrer"
                        className="text-xs font-mono text-sky-400 hover:underline flex items-center gap-1.5 break-all p-2.5 rounded-xl bg-zinc-900/60 border border-zinc-800/80 mb-2"
                      >
                        <ExternalLink className="w-3.5 h-3.5 shrink-0" />
                        <span>{item.url}</span>
                      </a>
                      {/*
                        A capture can be both: text the user typed *and* a link it came
                        from. Rendering only the link hid the text entirely — which is
                        how 「记一笔」 ended up looking like it saved nothing.
                      */}
                      {item.content && item.content.trim() && item.content.trim() !== item.url.trim() ? (
                        <div className="p-3 rounded-xl bg-sh-bg border border-zinc-800/60 font-mono text-xs text-zinc-300 leading-relaxed whitespace-pre-wrap select-text max-h-36 overflow-y-auto">
                          {item.content}
                        </div>
                      ) : null}
                    </>
                  ) : (
                    <div className="p-3 rounded-xl bg-sh-bg border border-zinc-800/60 font-mono text-xs text-zinc-300 leading-relaxed whitespace-pre-wrap select-text max-h-36 overflow-y-auto">
                      {item.content}
                    </div>
                  )}
                </div>

                {/* Triage Action Toolbar */}
                <div className="flex flex-wrap items-center justify-between gap-2 pt-2.5 border-t border-zinc-800/60 text-xs">
                  <div className="flex items-center gap-1.5">
                    {/* Convert to Note — or open the note it already produced. */}
                    {item.status !== 'inbox' && item.targetType === 'note' && item.targetId && onOpenTarget ? (
                      <button
                        onClick={() => onOpenTarget('note', item.targetId!)}
                        data-testid={`inbox-open-target-${item.id}`}
                        className="px-2.5 py-1 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-purple-300 text-[11px] flex items-center gap-1"
                        title="打开此前生成的笔记，不会重复创建"
                      >
                        <FileText className="w-3 h-3 text-purple-400" />
                        <span>打开原笔记</span>
                      </button>
                    ) : (
                      <button
                        onClick={() => {
                          const result = onConvertToNote(item);
                          if (!result.ok) {
                            showToast(result.error || '转换失败，内容仍保留在收件箱');
                            return;
                          }
                          setJustProcessed((prev) => new Set(prev).add(item.id));
                          showToast(result.reused ? '该条目此前已转换，已打开原笔记' : '已转为笔记');
                          if (result.reused && result.targetId && onOpenTarget) onOpenTarget('note', result.targetId);
                        }}
                        data-testid={`inbox-convert-note-${item.id}`}
                        className="px-2.5 py-1 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-purple-300 text-[11px] flex items-center gap-1"
                        title="转为长期知识笔记并记录目标引用"
                      >
                        <FileText className="w-3 h-3 text-purple-400" />
                        <span>转为笔记</span>
                      </button>
                    )}

                    {/* Convert to Site (if URL) — or open the saved bookmark. */}
                    {item.status !== 'inbox' && item.targetType === 'site' && item.targetId && onOpenTarget ? (
                      <button
                        onClick={() => onOpenTarget('site', item.targetId!)}
                        className="px-2.5 py-1 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-sky-300 text-[11px] flex items-center gap-1"
                        title="打开此前的收藏，不会重复创建"
                      >
                        <Globe className="w-3 h-3 text-sky-400" />
                        <span>打开原收藏</span>
                      </button>
                    ) : (
                      item.url && (
                        <button
                          onClick={() => {
                            const result = onConvertToSite(item);
                            if (!result.ok) {
                              showToast(result.error || '转换失败，内容仍保留在收件箱');
                              return;
                            }
                            setJustProcessed((prev) => new Set(prev).add(item.id));
                            showToast(result.reused ? '该条目此前已存为书签，已打开原收藏' : '已存为书签');
                            if (result.reused && result.targetId && onOpenTarget) onOpenTarget('site', result.targetId);
                          }}
                          data-testid={`inbox-convert-site-${item.id}`}
                          className="px-2.5 py-1 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-sky-300 text-[11px] flex items-center gap-1"
                          title="添加到快捷导航收藏"
                        >
                          <Globe className="w-3 h-3 text-sky-400" />
                          <span>存为书签</span>
                        </button>
                      )
                    )}

                    {/* Assign to Project */}
                    {projects.length > 0 && onAssignToProject && (
                      <select
                        onChange={(e) => {
                          if (!e.target.value) return;
                          const result = onAssignToProject(item.id, e.target.value);
                          showToast(result.ok ? '已关联到项目' : result.error || '关联失败');
                        }}
                        defaultValue=""
                        className="px-2 py-1 rounded-lg bg-zinc-900 border border-zinc-800 text-zinc-400 text-[11px] focus:outline-none"
                      >
                        <option value="" disabled>关联项目...</option>
                        {projects.map((p) => (
                          <option key={p.id} value={p.id}>{p.name}</option>
                        ))}
                      </select>
                    )}
                  </div>

                  <div className="flex items-center gap-1">
                    {/* Inline Edit Button */}
                    <button
                      onClick={() => handleOpenEdit(item)}
                      className="p-1.5 rounded-lg text-zinc-500 hover:text-zinc-200 transition-colors"
                      title="编辑碎片内容与类型"
                      aria-label="编辑碎片内容与类型"
                    >
                      <Edit3 className="w-3.5 h-3.5" aria-hidden />
                    </button>

                    {item.status === 'inbox' ? (
                      <button
                        onClick={() => {
                          onUpdateInboxItem({ ...item, status: 'processed' });
                          showToast('已标记为已处理');
                        }}
                        className="p-1.5 rounded-lg text-zinc-500 hover:text-emerald-400"
                        title="标为已处理"
                        aria-label="标为已处理"
                      >
                        <Check className="w-3.5 h-3.5" aria-hidden />
                      </button>
                    ) : (
                      <button
                        onClick={() => {
                          onUpdateInboxItem({ ...item, status: 'inbox' });
                          showToast('已重新移回待整理');
                        }}
                        className="p-1.5 rounded-lg text-zinc-500 hover:text-indigo-400"
                        title="重新放回收件箱"
                        aria-label="重新放回收件箱"
                      >
                        <Inbox className="w-3.5 h-3.5" aria-hidden />
                      </button>
                    )}

                    <button
                      onClick={() => {
                        const preview = (item.title || item.content).slice(0, 40);
                        if (confirm(`确定彻底删除该碎片吗？此操作不可撤销。\n\n${preview}`)) {
                          onDeleteInboxItem(item.id);
                          showToast('🗑️ 已删除');
                        }
                      }}
                      className="p-1.5 rounded-lg text-zinc-500 hover:text-rose-400"
                      title="删除此碎片"
                      aria-label="删除此碎片"
                    >
                      <Trash2 className="w-3.5 h-3.5" aria-hidden />
                    </button>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* In-place Item Edit Modal */}
      {editingItem && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm animate-in fade-in">
          <div className="w-full max-w-lg bg-sh-surface border border-sh-line rounded-2xl p-5 shadow-2xl space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-zinc-800">
              <div className="flex items-center gap-2">
                <Edit3 className="w-4 h-4 text-indigo-400" />
                <h3 className="text-sm font-semibold text-zinc-100">编辑碎片灵感</h3>
              </div>
              <button
                onClick={() => setEditingItem(null)}
                aria-label="关闭编辑"
                className="p-1 rounded-lg text-zinc-500 hover:text-zinc-300"
              >
                <X className="w-4 h-4" aria-hidden />
              </button>
            </div>

            <div className="space-y-3">
              <div>
                <label className="block text-[11px] font-mono text-zinc-400 mb-1">标题 / 描述</label>
                <input
                  type="text"
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  className="w-full bg-zinc-900 border border-zinc-800 rounded-xl px-3 py-2 text-xs text-zinc-100 focus:outline-none focus:border-indigo-500"
                />
              </div>

              <div>
                <label className="block text-[11px] font-mono text-zinc-400 mb-1">类型识别</label>
                <div className="grid grid-cols-3 gap-2">
                  {(['text', 'url', 'snippet'] as const).map(t => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => setEditType(t)}
                      className={`py-1.5 rounded-xl border text-xs capitalize transition-colors ${
                        editType === t
                          ? 'bg-indigo-950/80 border-indigo-700 text-indigo-200 font-medium'
                          : 'bg-zinc-900 border-zinc-800 text-zinc-400 hover:text-zinc-200'
                      }`}
                    >
                      {t === 'url' ? '网页链接 (URL)' : t === 'snippet' ? '代码片段' : '纯文本笔记'}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-[11px] font-mono text-zinc-400 mb-1">正文内容 (支持 Markdown / 代码)</label>
                <textarea
                  value={editContent}
                  onChange={(e) => setEditContent(e.target.value)}
                  rows={5}
                  className="w-full bg-sh-bg border border-zinc-800 rounded-xl p-3 text-xs font-mono text-zinc-200 focus:outline-none focus:border-indigo-500 resize-none"
                />
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-zinc-800/80">
              <button
                onClick={() => setEditingItem(null)}
                className="px-3.5 py-1.5 rounded-xl bg-zinc-900 hover:bg-zinc-800 text-xs text-zinc-400 hover:text-white"
              >
                取消
              </button>
              <button
                onClick={handleSaveEdit}
                className="px-4 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-medium text-xs shadow-sm"
              >
                保存修改
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
