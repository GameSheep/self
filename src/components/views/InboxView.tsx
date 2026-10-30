import React, { useRef, useState } from 'react';
import {
  Inbox,
  Plus,
  FileText,
  Globe,
  Check,
  Trash2,
  Code2,
  CheckCircle2,
  Search,
  Edit3,
  X
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

  /** Dense list: same-day rows show only the time, older ones just the date. */
  const timeLabel = (ts: number) => {
    const d = new Date(ts);
    return d.toDateString() === new Date().toDateString()
      ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : `${d.getMonth() + 1}/${d.getDate()}`;
  };

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
          {/* Hidden on phones: the subtitle is four lines of chrome above a list
              that is the only thing worth screen space there. */}
          <p className="hidden sm:block text-xs text-zinc-400 mt-0.5">
            快速倾倒临时灵感、网页链接、代码片段，后续无缝分流至「知识文档」、「常用书签」或「项目空间」
          </p>
        </div>

        {/* Batch Operations — wraps: with `whitespace-nowrap` on the buttons a
            narrow card would otherwise clip the last one. */}
        <div className="flex flex-wrap items-center gap-2">
          {pendingCount > 0 && onConvertMany && (
            <>
              <button
                onClick={() => setBatchTarget('note')}
                data-testid="inbox-batch-note"
                className="px-2.5 py-1.5 rounded-xl bg-zinc-900 border border-zinc-800 hover:border-zinc-700 text-[11px] text-zinc-300 hover:text-white transition-colors whitespace-nowrap"
              >
                批量转为笔记 ({pendingCount})
              </button>
              <button
                onClick={() => setBatchTarget('site')}
                data-testid="inbox-batch-site"
                className="px-2.5 py-1.5 rounded-xl bg-zinc-900 border border-zinc-800 hover:border-zinc-700 text-[11px] text-zinc-300 hover:text-white transition-colors whitespace-nowrap"
              >
                批量存为书签
              </button>
            </>
          )}
          {pendingCount > 0 && (
            <button
              onClick={handleBatchMarkAllProcessed}
              className="px-2.5 py-1.5 rounded-xl bg-zinc-900 border border-zinc-800 hover:border-zinc-700 text-[11px] text-zinc-300 hover:text-white transition-colors whitespace-nowrap"
            >
              全部标记已处理
            </button>
          )}
          {processedCount > 0 && (
            <button
              onClick={handleBatchClearProcessed}
              className="px-2.5 py-1.5 rounded-xl bg-zinc-900 border border-zinc-800 hover:border-rose-900/60 text-[11px] text-zinc-400 hover:text-rose-400 transition-colors whitespace-nowrap"
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

      {/* Quick Capture Dock — one compact strip, not a three-row form. */}
      <div className="p-3 rounded-2xl bg-sh-surface border border-sh-line">
        <textarea
          value={quickInput}
          onChange={(e) => setQuickInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="粘贴文字、网址 (https://…) 或代码片段，Ctrl+Enter 存入；https:// 开头自动识别为链接"
          aria-label="快速存入收件箱"
          rows={2}
          className="w-full bg-sh-bg border border-zinc-800/80 rounded-xl p-2.5 text-xs text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-indigo-500 font-mono resize-none"
        />
        <div className="flex items-center gap-2 mt-2">
          <input
            type="text"
            value={quickTitle}
            onChange={(e) => setQuickTitle(e.target.value)}
            placeholder="摘要标题 (可选，留空自动取内容开头)"
            aria-label="摘要标题"
            className="flex-1 min-w-0 bg-zinc-900 border border-zinc-800 rounded-xl px-3 py-1.5 text-xs text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-indigo-500"
          />
          <button
            onClick={handleQuickAdd}
            disabled={!quickInput.trim()}
            className="px-3 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-semibold text-xs flex items-center gap-1.5 shadow-sm disabled:opacity-50 transition-colors shrink-0"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>快速存入</span>
          </button>
        </div>
      </div>

      {/* Items feed: one dense row per item, not one card per item.
          The card grid spent 200–350px on every entry — three of them filled the
          screen, so a backlog that grows daily became unreadable long before it
          got long. A row carries the summary plus at most one detail line; the
          actions reveal on hover (always visible on narrow/touch screens). */}
      <div className="bg-sh-surface rounded-2xl border border-sh-line divide-y divide-zinc-800/60 overflow-hidden">
        {filteredItems.length === 0 ? (
          <div className="py-14 text-center text-zinc-500 font-mono text-xs">
            <Inbox className="w-7 h-7 mx-auto mb-2 opacity-40 text-indigo-400" />
            <p>收件箱空空如也，所有碎片资料已整理完毕！</p>
          </div>
        ) : (
          filteredItems.map((item) => {
            // First line: title if the capture has one, otherwise the content.
            const summary = (item.title || item.content || item.url || '').trim() || '未命名碎片';
            // Second line: whichever of url / content the summary did not show.
            const detail =
              item.url && item.url !== summary
                ? item.url
                : (item.content || '').trim() !== summary
                  ? (item.content || '').trim()
                  : '';
            const done = item.status !== 'inbox';

            return (
              <div
                key={item.id}
                data-testid="inbox-row"
                className={`group flex flex-wrap items-center gap-x-3 gap-y-1 px-3 sm:px-4 py-2 transition-colors ${
                  done ? 'bg-zinc-900/20' : 'hover:bg-zinc-900/40'
                }`}
              >
                {/* Type chip: colour carries the kind, the icon confirms it. */}
                <span
                  className={`shrink-0 w-6 h-6 rounded-lg flex items-center justify-center border ${
                    item.type === 'url'
                      ? 'bg-sky-950/60 text-sky-400 border-sky-800/50'
                      : item.type === 'snippet'
                        ? 'bg-amber-950/60 text-amber-400 border-amber-800/50'
                        : 'bg-purple-950/60 text-purple-400 border-purple-800/50'
                  }`}
                  title={item.type === 'url' ? '链接' : item.type === 'snippet' ? '代码' : '速记'}
                >
                  {item.type === 'url' ? (
                    <Globe className="w-3.5 h-3.5" aria-hidden />
                  ) : item.type === 'snippet' ? (
                    <Code2 className="w-3.5 h-3.5" aria-hidden />
                  ) : (
                    <FileText className="w-3.5 h-3.5" aria-hidden />
                  )}
                </span>

                {/* Summary + one detail line, both clamped: a row stays a row.
                    `basis-40` is what stops a narrow screen from crushing the
                    text to "第 2 …" — the action cluster is what wraps instead. */}
                <div className="min-w-0 flex-1 basis-40" data-testid="inbox-row-text">
                  {item.url && item.url === summary ? (
                    <a
                      href={item.url}
                      target="_blank"
                      rel="noreferrer"
                      className="block truncate text-xs leading-5 text-sky-400/90 hover:text-sky-400 hover:underline"
                      title={item.url}
                    >
                      {summary}
                    </a>
                  ) : (
                    <p className={`truncate text-xs leading-5 ${done ? 'text-zinc-400' : 'text-zinc-200'}`}>{summary}</p>
                  )}
                  {detail && (
                    <p className="truncate text-[11px] leading-4 text-zinc-500 mt-0.5 font-mono">
                      {item.url && item.url === detail ? (
                        <a
                          href={item.url}
                          target="_blank"
                          rel="noreferrer"
                          className="text-sky-400/80 hover:text-sky-400 hover:underline"
                        >
                          {detail}
                        </a>
                      ) : (
                        detail
                      )}
                    </p>
                  )}
                </div>

                {done && item.targetType && (
                  <span className="shrink-0 hidden md:inline px-1.5 py-0.5 rounded text-[10px] font-mono text-emerald-400/90 bg-emerald-950/40 border border-emerald-900/50">
                    {item.targetType === 'site' ? '已存书签' : '已转笔记'}
                  </span>
                )}

                <span
                  className="shrink-0 text-[10px] font-mono text-zinc-500 tabular-nums"
                  title={new Date(item.createdAt).toLocaleString()}
                >
                  {timeLabel(item.createdAt)}
                </span>

                {/* Actions: hidden until hover on wide pointer screens, always on
                    otherwise; focus-within keeps them up once you tab in. Below
                    `lg` they wrap onto their own line rather than eating the
                    summary's width. */}
                <div data-testid="inbox-row-actions" className="shrink-0 flex items-center gap-1 w-full justify-end lg:w-auto max-lg:opacity-100 lg:opacity-0 lg:group-hover:opacity-100 lg:group-focus-within:opacity-100 transition-opacity">
                  {/* Convert to Note — or open the note it already produced. */}
                  {done && item.targetType === 'note' && item.targetId && onOpenTarget ? (
                    <button
                      onClick={() => onOpenTarget('note', item.targetId!)}
                      data-testid={`inbox-open-target-${item.id}`}
                      className="px-2 py-1 rounded-lg border border-zinc-800 text-[11px] text-purple-300 hover:border-purple-800/60 transition-colors"
                      title="打开此前生成的笔记，不会重复创建"
                    >
                      打开原笔记
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
                      className="px-2 py-1 rounded-lg border border-zinc-800 text-[11px] text-purple-300 hover:border-purple-800/60 transition-colors"
                      title="转为长期知识笔记并记录目标引用"
                    >
                      转为笔记
                    </button>
                  )}

                  {/* Convert to Site (if URL) — or open the saved bookmark. */}
                  {done && item.targetType === 'site' && item.targetId && onOpenTarget ? (
                    <button
                      onClick={() => onOpenTarget('site', item.targetId!)}
                      className="px-2 py-1 rounded-lg border border-zinc-800 text-[11px] text-sky-300 hover:border-sky-800/60 transition-colors"
                      title="打开此前的收藏，不会重复创建"
                    >
                      打开原收藏
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
                        className="px-2 py-1 rounded-lg border border-zinc-800 text-[11px] text-sky-300 hover:border-sky-800/60 transition-colors"
                        title="添加到快捷导航收藏"
                      >
                        存为书签
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
                      aria-label="关联到项目"
                      className="max-w-28 truncate px-1.5 py-1 rounded-lg bg-zinc-900 border border-zinc-800 text-zinc-400 text-[11px] focus:outline-none"
                    >
                      <option value="" disabled>关联项目...</option>
                      {projects.map((p) => (
                        <option key={p.id} value={p.id}>{p.name}</option>
                      ))}
                    </select>
                  )}

                  <button
                    onClick={() => handleOpenEdit(item)}
                    className="p-1 rounded-lg text-zinc-500 hover:text-zinc-200 transition-colors"
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
                      className="p-1 rounded-lg text-zinc-500 hover:text-emerald-400"
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
                      className="p-1 rounded-lg text-zinc-500 hover:text-indigo-400"
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
                    className="p-1 rounded-lg text-zinc-500 hover:text-rose-400"
                    title="删除此碎片"
                    aria-label="删除此碎片"
                  >
                    <Trash2 className="w-3.5 h-3.5" aria-hidden />
                  </button>
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
              <div className="flex flex-wrap items-center gap-2">
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
