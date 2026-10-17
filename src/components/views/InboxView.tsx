import React, { useState } from 'react';
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

interface InboxViewProps {
  inbox: InboxItem[];
  onAddInboxItem: (item: InboxItem) => void;
  onUpdateInboxItem: (item: InboxItem) => void;
  onDeleteInboxItem: (id: string) => void;
  onConvertToNote: (item: InboxItem) => void;
  onConvertToSite: (item: InboxItem) => void;
  projects?: ProjectItem[];
  onAssignToProject?: (itemId: string, projectId: string) => void;
}

export const InboxView: React.FC<InboxViewProps> = ({
  inbox,
  onAddInboxItem,
  onUpdateInboxItem,
  onDeleteInboxItem,
  onConvertToNote,
  onConvertToSite,
  projects = [],
  onAssignToProject
}) => {
  const [filter, setFilter] = useState<'inbox' | 'processed' | 'all'>('inbox');
  const [typeFilter, setTypeFilter] = useState<'all' | 'url' | 'text' | 'snippet'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [quickInput, setQuickInput] = useState('');
  const [quickTitle, setQuickTitle] = useState('');
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  // Edit Modal State
  const [editingItem, setEditingItem] = useState<InboxItem | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editContent, setEditContent] = useState('');
  const [editType, setEditType] = useState<'text' | 'url' | 'snippet'>('text');

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 2500);
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
      showToast(`✅ 已批量处理 ${pending.length} 项`);
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
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-[#121316] p-4 sm:p-5 rounded-2xl border border-[#22242a]">
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

      {/* Filter and Search Bar */}
      <div className="p-3 bg-[#121316] rounded-2xl border border-[#22242a] flex flex-col md:flex-row md:items-center justify-between gap-3">
        {/* Search */}
        <div className="relative flex-1 max-w-md">
          <Search className="w-3.5 h-3.5 text-zinc-500 absolute left-3 top-2.5" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="搜索碎片内容、网址或标题..."
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
              onClick={() => setFilter('inbox')}
              className={`px-2.5 py-1 rounded-lg text-xs transition-all ${
                filter === 'inbox' ? 'bg-indigo-950/80 text-indigo-200 border border-indigo-800/80 font-medium' : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              待整理 ({pendingCount})
            </button>
            <button
              onClick={() => setFilter('processed')}
              className={`px-2.5 py-1 rounded-lg text-xs transition-all ${
                filter === 'processed' ? 'bg-zinc-800 text-zinc-200 font-medium' : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              已分流 ({processedCount})
            </button>
            <button
              onClick={() => setFilter('all')}
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
                onClick={() => setTypeFilter(t)}
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
      <div className="p-4 rounded-2xl bg-[#121316] border border-[#22242a] space-y-3">
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
            className="w-full bg-[#090a0c] border border-zinc-800/80 rounded-xl p-3 text-xs text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-indigo-500 font-mono resize-none"
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
          <div className="col-span-full py-16 text-center text-zinc-500 font-mono text-xs bg-[#121316]/50 rounded-2xl border border-zinc-800/50">
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
                    : 'bg-[#121316] border-[#22242a] hover:border-zinc-700 shadow-sm'
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
                    <a
                      href={item.url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-xs font-mono text-sky-400 hover:underline flex items-center gap-1.5 break-all p-2.5 rounded-xl bg-zinc-900/60 border border-zinc-800/80 mb-2"
                    >
                      <ExternalLink className="w-3.5 h-3.5 shrink-0" />
                      <span>{item.url}</span>
                    </a>
                  ) : (
                    <div className="p-3 rounded-xl bg-[#090a0c] border border-zinc-800/60 font-mono text-xs text-zinc-300 leading-relaxed whitespace-pre-wrap select-text max-h-36 overflow-y-auto">
                      {item.content}
                    </div>
                  )}
                </div>

                {/* Triage Action Toolbar */}
                <div className="flex flex-wrap items-center justify-between gap-2 pt-2.5 border-t border-zinc-800/60 text-xs">
                  <div className="flex items-center gap-1.5">
                    {/* Convert to Note */}
                    <button
                      onClick={() => {
                        if (item.status === 'processed') {
                          showToast('ℹ️ 该条目已分流过，请勿重复转换（如需再次转换请先恢复为待整理）');
                          return;
                        }
                        // Only convert: the parent already records targetType/targetId.
                        // A second onUpdateInboxItem() with this stale snapshot used to
                        // overwrite targetId with undefined and break the traceability link.
                        onConvertToNote(item);
                        showToast('✅ 已成功转为深度知识笔记');
                      }}
                      disabled={item.status === 'processed'}
                      className="px-2.5 py-1 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-purple-300 text-[11px] flex items-center gap-1 disabled:opacity-45 disabled:cursor-not-allowed"
                      title={item.status === 'processed' ? '已分流，不可重复转换' : '转为长期知识笔记并归档'}
                    >
                      <FileText className="w-3 h-3 text-purple-400" />
                      <span>转为笔记</span>
                    </button>

                    {/* Convert to Site (if URL) */}
                    {item.url && (
                      <button
                        onClick={() => {
                          if (item.status === 'processed') {
                            showToast('ℹ️ 该条目已分流过，请勿重复转换');
                            return;
                          }
                          onConvertToSite(item);
                          showToast('✅ 已存为常用工作台书签');
                        }}
                        disabled={item.status === 'processed'}
                        className="px-2.5 py-1 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-sky-300 text-[11px] flex items-center gap-1 disabled:opacity-45 disabled:cursor-not-allowed"
                        title={item.status === 'processed' ? '已分流，不可重复转换' : '添加到常用网站导航'}
                      >
                        <Globe className="w-3 h-3 text-sky-400" />
                        <span>存为书签</span>
                      </button>
                    )}

                    {/* Assign to Project */}
                    {projects.length > 0 && onAssignToProject && (
                      <select
                        onChange={(e) => {
                          if (e.target.value) {
                            onAssignToProject(item.id, e.target.value);
                            showToast('📁 已关联到项目');
                          }
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
                    >
                      <Edit3 className="w-3.5 h-3.5" />
                    </button>

                    {item.status === 'inbox' ? (
                      <button
                        onClick={() => {
                          onUpdateInboxItem({ ...item, status: 'processed' });
                          showToast('已标记为已处理');
                        }}
                        className="p-1.5 rounded-lg text-zinc-500 hover:text-emerald-400"
                        title="标为已处理"
                      >
                        <Check className="w-3.5 h-3.5" />
                      </button>
                    ) : (
                      <button
                        onClick={() => {
                          onUpdateInboxItem({ ...item, status: 'inbox' });
                          showToast('已重新移回待整理');
                        }}
                        className="p-1.5 rounded-lg text-zinc-500 hover:text-indigo-400"
                        title="重新放回收件箱"
                      >
                        <Inbox className="w-3.5 h-3.5" />
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
                    >
                      <Trash2 className="w-3.5 h-3.5" />
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
          <div className="w-full max-w-lg bg-[#121316] border border-[#262830] rounded-2xl p-5 shadow-2xl space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-zinc-800">
              <div className="flex items-center gap-2">
                <Edit3 className="w-4 h-4 text-indigo-400" />
                <h3 className="text-sm font-semibold text-zinc-100">编辑碎片灵感</h3>
              </div>
              <button
                onClick={() => setEditingItem(null)}
                className="p-1 rounded-lg text-zinc-500 hover:text-zinc-300"
              >
                <X className="w-4 h-4" />
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
                  className="w-full bg-[#090a0c] border border-zinc-800 rounded-xl p-3 text-xs font-mono text-zinc-200 focus:outline-none focus:border-indigo-500 resize-none"
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
