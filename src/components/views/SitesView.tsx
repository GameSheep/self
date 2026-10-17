import React, { useState, useMemo, useDeferredValue } from 'react';
import { 
  Globe, 
  Plus, 
  Search, 
  LayoutGrid, 
  List, 
  ChevronDown, 
  ChevronRight, 
  ExternalLink, 
  Copy, 
  Check, 
  Trash2, 
  Pin,
  Sparkles,
  Upload
} from 'lucide-react';
import { NavSite } from '../../types';
import { SiteCard } from '../cards/SiteCard';

/** Normalise a URL for duplicate detection (ignore protocol, www, trailing slash). */
function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.hostname.replace(/^www\./, '')}${u.pathname.replace(/\/$/, '')}${u.search}`.toLowerCase();
  } catch {
    return raw.trim().toLowerCase();
  }
}

interface SitesViewProps {
  sites: NavSite[];
  categories: string[];
  onVisit: (id: string) => void;
  onDelete: (id: string) => void;
  onOpenAddModal: () => void;
  onOpenAiIngest: () => void;
  onImportBookmarks: (newSites: NavSite[]) => void;
}

export const SitesView: React.FC<SitesViewProps> = ({
  sites,
  categories,
  onVisit,
  onDelete,
  onOpenAddModal,
  onOpenAiIngest,
  onImportBookmarks
}) => {
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('全部');
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const toggleGroup = (cat: string) => {
    setCollapsedGroups(prev => ({ ...prev, [cat]: !prev[cat] }));
  };

  const handleCopy = async (e: React.MouseEvent, site: NavSite) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(site.url);
      setCopiedId(site.id);
      setTimeout(() => setCopiedId(null), 2000);
    } catch {
      alert('复制失败：浏览器拒绝了剪贴板访问，请手动复制。');
    }
  };

  // Typing in the search box must not block on filtering thousands of bookmarks.
  const deferredQuery = useDeferredValue(searchQuery);

  // Render a page at a time: mounting 300+ cards took ~500ms of main thread,
  // which froze the tab for imported bookmark libraries.
  const PAGE_SIZE = 60;
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  React.useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [deferredQuery, selectedCategory]);

  // Filtered sites
  const filteredSites = useMemo(() => {
    const q = deferredQuery.trim().toLowerCase();
    return sites.filter(s => {
      const matchCat = selectedCategory === '全部' || s.category === selectedCategory;
      if (!matchCat) return false;
      if (!q) return true;
      return (
        (s.title || '').toLowerCase().includes(q) ||
        (s.url || '').toLowerCase().includes(q) ||
        (s.description ? s.description.toLowerCase().includes(q) : false)
      );
    });
  }, [sites, selectedCategory, deferredQuery]);

  // Group by category
  const activeCategories = useMemo(
    () =>
      selectedCategory === '全部'
        ? Array.from(new Set(sites.map(s => s.category || '默认分类')))
        : [selectedCategory],
    [sites, selectedCategory]
  );

  // Chrome / GoTab HTML bookmarks importer
  const handleBookmarkUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onerror = () => alert('❌ 读取书签文件失败，请确认文件完整后重试。');
    reader.onload = (event) => {
      const htmlText = event.target?.result as string;
      const parser = new DOMParser();
      const doc = parser.parseFromString(htmlText, 'text/html');
      const anchors = doc.querySelectorAll('a');

      // De-duplicate against both the file itself and the existing library,
      // otherwise importing the same export twice doubles every bookmark.
      const existingUrls = new Set(sites.map(s => normalizeUrl(s.url)));
      const seen = new Set<string>();
      const imported: NavSite[] = [];
      let duplicates = 0;

      anchors.forEach((a, i) => {
        const href = a.getAttribute('href');
        const title = a.textContent?.trim();
        if (!href || !href.startsWith('http') || !title) return;
        const key = normalizeUrl(href);
        if (seen.has(key) || existingUrls.has(key)) {
          duplicates++;
          return;
        }
        seen.add(key);
        imported.push({
          id: `site-bm-${Date.now()}-${i}`,
          title,
          url: href,
          category: '浏览器书签导入',
          visitCount: 0,
          createdAt: Date.now()
        });
      });

      if (imported.length > 0) {
        onImportBookmarks(imported);
        alert(
          `✅ 成功导入 ${imported.length} 个网址` +
            (duplicates > 0 ? `，已自动跳过 ${duplicates} 个重复书签。` : '。')
        );
      } else {
        alert(
          duplicates > 0
            ? `未导入新书签：文件中的 ${duplicates} 个链接已存在于资料库中。`
            : '未在文件中检测到有效书签超链接'
        );
      }
      // Allow re-selecting the same file.
      e.target.value = '';
    };
    reader.readAsText(file);
  };

  return (
    <div className="space-y-5">
      
      {/* View Header with Control Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-[#121316] p-3 sm:p-4 rounded-2xl border border-[#22242a]">
        <div>
          <h2 className="text-sm font-semibold text-zinc-100 flex items-center gap-2">
            <Globe className="w-4 h-4 text-sky-400 shrink-0" />
            <span>网站与平台工作区</span>
            <span className="text-xs font-mono text-zinc-400">({sites.length} 个站点)</span>
          </h2>
          <p className="text-xs text-zinc-400 mt-0.5">
            支持分类折叠、高密度数据列表、书签一键导入与快捷检索
          </p>
        </div>

        {/* Toolbar */}
        <div className="flex items-center flex-wrap gap-2">
          {/* Chrome/GoTab HTML Bookmarks Importer */}
          <label className="px-2.5 py-1.5 rounded-xl bg-zinc-900 border border-zinc-800 text-zinc-300 hover:text-white text-xs flex items-center gap-1.5 cursor-pointer transition-colors">
            <Upload className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">导入 GoTab/Chrome 书签</span>
            <input type="file" accept=".html" onChange={handleBookmarkUpload} className="hidden" />
          </label>

          <button
            onClick={onOpenAiIngest}
            className="px-2.5 py-1.5 rounded-xl bg-zinc-900 border border-zinc-800 text-amber-400 hover:text-amber-300 text-xs flex items-center gap-1.5 transition-colors"
          >
            <Sparkles className="w-3.5 h-3.5" />
            <span>AI 分拣</span>
          </button>

          <button
            onClick={onOpenAddModal}
            className="px-3 py-1.5 rounded-xl bg-zinc-100 text-zinc-900 hover:bg-white text-xs font-semibold flex items-center gap-1.5 transition-colors shadow-sm"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>添加网站</span>
          </button>

          {/* View Mode Toggle */}
          <div className="flex items-center bg-zinc-900 p-0.5 rounded-lg border border-zinc-800 text-xs ml-1">
            <button
              onClick={() => setViewMode('grid')}
              className={`p-1 rounded ${viewMode === 'grid' ? 'bg-zinc-800 text-white' : 'text-zinc-400 hover:text-zinc-200'}`}
              title="网格卡片视图"
            >
              <LayoutGrid className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => setViewMode('list')}
              className={`p-1 rounded ${viewMode === 'list' ? 'bg-zinc-800 text-white' : 'text-zinc-400 hover:text-zinc-200'}`}
              title="紧凑列表视图 (适合海量内容)"
            >
              <List className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>

      {/* Filter & Category Strip */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 bg-[#121316] p-2.5 rounded-xl border border-[#22242a]">
        <div className="flex items-center gap-1 overflow-x-auto pb-1 sm:pb-0 scrollbar-none">
          {categories.map((cat) => (
            <button
              key={cat}
              onClick={() => setSelectedCategory(cat)}
              className={`px-3 py-1 rounded-lg text-xs font-medium whitespace-nowrap transition-colors shrink-0 ${
                selectedCategory === cat
                  ? 'bg-zinc-100 text-zinc-900 shadow-sm font-semibold'
                  : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/60'
              }`}
            >
              {cat}
            </button>
          ))}
        </div>

        <div className="relative w-full sm:w-64 shrink-0">
          <Search className="w-3.5 h-3.5 text-zinc-400 absolute left-2.5 top-2.5" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="搜索网址或标题..."
            className="w-full bg-zinc-900 border border-zinc-800 rounded-lg pl-8 pr-3 py-1 text-xs text-zinc-200 focus:outline-none focus:border-zinc-700"
          />
        </div>
      </div>

      {/* Grouped Foldable Accordion Sections */}
      {(() => {
        let budget = visibleCount;
        return activeCategories.map((cat) => {
        const groupSitesAll = filteredSites.filter(s => (s.category || '默认分类') === cat);
        if (groupSitesAll.length === 0) return null;

        const groupSites = groupSitesAll.slice(0, Math.max(0, budget));
        budget -= groupSites.length;
        if (groupSites.length === 0) return null;

        const isCollapsed = Boolean(collapsedGroups[cat]);

        return (
          <div key={cat} className="space-y-3">
            {/* Folder Header */}
            <div 
              onClick={() => toggleGroup(cat)}
              className="flex items-center justify-between px-3 py-2 rounded-xl bg-zinc-900/40 hover:bg-zinc-900/80 border border-zinc-800/60 cursor-pointer select-none transition-colors"
            >
              <div className="flex items-center gap-2">
                {isCollapsed ? <ChevronRight className="w-4 h-4 text-zinc-400" /> : <ChevronDown className="w-4 h-4 text-zinc-400" />}
                <span className="text-xs font-semibold text-zinc-200">{cat}</span>
                <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-zinc-800 text-zinc-400 border border-zinc-700/60">
                  {groupSites.length}
                </span>
              </div>
              <span className="text-[11px] text-zinc-400">
                {isCollapsed ? '点击展开' : '点击折叠'}
              </span>
            </div>

            {/* Folder Content */}
            {!isCollapsed && (
              <div>
                {viewMode === 'grid' ? (
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
                    {groupSites.map((site) => (
                      <SiteCard
                        key={site.id}
                        site={site}
                        onVisit={onVisit}
                        onDelete={onDelete}
                      />
                    ))}
                  </div>
                ) : (
                  /* Compact Dense List View */
                  <div className="rounded-xl border border-zinc-800/80 bg-[#121316] overflow-hidden divide-y divide-zinc-800/60">
                    {groupSites.map((site) => {
                      const isCopied = copiedId === site.id;
                      return (
                        <div
                          key={site.id}
                          onClick={() => {
                            onVisit(site.id);
                            window.open(site.url, '_blank', 'noopener,noreferrer');
                          }}
                          className="px-3.5 py-2.5 hover:bg-zinc-900/80 cursor-pointer flex items-center justify-between gap-3 text-xs transition-colors group"
                        >
                          <div className="flex items-center gap-3 min-w-0 flex-1">
                            <div className="w-6 h-6 rounded-md bg-zinc-900 border border-zinc-800 flex items-center justify-center shrink-0">
                              <Globe className="w-3.5 h-3.5 text-zinc-400 group-hover:text-sky-400" />
                            </div>
                            <div className="min-w-0 flex-1">
                              <span className="font-semibold text-zinc-200 group-hover:text-white truncate block">
                                {site.title}
                              </span>
                              <span className="text-[10px] text-zinc-400 font-mono truncate block">
                                {site.url}
                              </span>
                            </div>
                          </div>

                          <div className="flex items-center gap-3 shrink-0">
                            <span className="text-[10px] font-mono text-zinc-400 hidden sm:inline">
                              {site.visitCount || 0} 次访问
                            </span>
                            <button
                              onClick={(e) => handleCopy(e, site)}
                              className="p-1 rounded hover:bg-zinc-800 text-zinc-400 hover:text-white"
                              title="复制网址"
                            >
                              {isCopied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                            </button>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                if (confirm(`确定删除 ${site.title} 吗？`)) onDelete(site.id);
                              }}
                              className="p-1 rounded hover:bg-zinc-800 text-zinc-400 hover:text-red-400"
                              title="删除"
                            >
                              <Trash2 className="w-3 h-3" />
                            </button>
                            <ExternalLink className="w-3 h-3 text-zinc-400 group-hover:text-white" />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        );
        });
      })()}

      {filteredSites.length > visibleCount && (
        <div className="flex flex-col items-center gap-2 py-4">
          <span className="text-[11px] text-zinc-500 font-mono">
            已显示 {Math.min(visibleCount, filteredSites.length)} / {filteredSites.length} 个站点
          </span>
          <button
            onClick={() => setVisibleCount((c) => c + PAGE_SIZE * 2)}
            className="px-4 py-2 rounded-xl bg-zinc-900 border border-zinc-800 text-zinc-300 hover:text-white hover:border-zinc-700 text-xs font-medium transition-colors"
          >
            加载更多
          </button>
        </div>
      )}

    </div>
  );
};
