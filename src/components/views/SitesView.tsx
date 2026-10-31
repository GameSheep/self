/**
 * 快捷导航 (P1-04).
 *
 * Responsibilities:
 * - open a site by clicking its body (new tab, rel="noreferrer"), never by a
 *   management action: edit / move / copy / pin / reorder / delete all live in
 *   the per-site ⋯ menu and are confirmed or reported inline;
 * - grouping + stable ordering. The design requires a non-drag alternative, so
 *   上移 / 下移 / 移动到分组 and drag-and-drop both call the same helpers in
 *   `src/features/navigation/siteOrdering.ts` and write real `order` numbers;
 * - make "filter my saved sites" and "search the web" two visibly different
 *   things. The local filter never issues a request; the external box states
 *   which engine the query goes to and only fires on an explicit action;
 * - import bookmarks through a preview dialog that can be undone in one batch.
 */
import React, { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronDown,
  Compass,
  Globe,
  LayoutGrid,
  List,
  Pencil,
  Plus,
  Search,
  Sparkles,
  Upload
} from 'lucide-react';
import { NavSite, QuickNote, AiConfig } from '../../types';
import { SiteCard } from '../cards/SiteCard';
import { PasteCapture } from '../../features/navigation/PasteCapture';
import {
  Button,
  ConfirmButton,
  ConfirmDialog,
  EmptyState,
  Field,
  PageHeader,
  StatusPill,
  inputClass
} from '../../shared/ui';
import { matchesQuery } from '../../lib/searchEngine';
import {
  BookmarkImportDialog,
  BookmarkImportResult,
  normalizeUrl
} from '../../features/navigation/BookmarkImportDialog';
import {
  categoryKey,
  moveSite,
  moveSiteOnto,
  moveSiteToCategory,
  renumberCategory,
  sortSites
} from '../../features/navigation/siteOrdering';

const PAGE_SIZE = 60;
const ALL = '全部';

/**
 * External search engines. Kept next to the UI so the label the user sees and
 * the URL that actually receives the query cannot drift apart.
 */
export const SEARCH_ENGINES = [
  { id: 'google', name: 'Google', url: 'https://www.google.com/search?q=' },
  { id: 'bing', name: 'Bing', url: 'https://www.bing.com/search?q=' },
  { id: 'baidu', name: '百度', url: 'https://www.baidu.com/s?wd=' }
] as const;

type SearchEngineId = (typeof SEARCH_ENGINES)[number]['id'];

/**
 * True when a group's members already carry exactly 0..n-1. Used to keep `order`
 * values contiguous without rewriting an untouched group (which would change
 * object identity for every site and re-render the whole grid on any edit).
 */
function isContiguouslyNumbered(sites: NavSite[], category: string): boolean {
  const group = sortSites(sites.filter((site) => categoryKey(site) === category));
  if (group.length === 0) return true;
  return group.every((site, index) => site.order === index);
}

interface SitesViewProps {
  sites: NavSite[];
  categories: string[];
  onVisit: (id: string) => void;
  onDelete: (id: string) => void;
  onOpenAddModal: (type?: 'site' | 'server' | 'secret' | 'checkin' | 'note') => void;
  /** Paste-to-recognise: writes sites / inbox / note after the user confirms destinations. */
  onPasteRecognized?: {
    onAddSites: (sites: NavSite[]) => void;
    onCaptureInbox: (raw: string) => void;
    onAddNote: (note: QuickNote) => void;
    /** Passed through so the dialog can offer cloud classification only when it is enabled. */
    aiConfig?: AiConfig;
  };
  /**
   * Batch writer. App wires this to `useSiteActions.importBookmarks`, which
   * replaces the sites collection with the array it receives (and merges the
   * categories). Every reorder / pin / move / import goes through it.
   */
  onImportBookmarks: (newSites: NavSite[]) => void;
}

export const SitesView: React.FC<SitesViewProps> = ({
  sites,
  categories,
  onVisit,
  onDelete,
  onOpenAddModal,
  onPasteRecognized,
  onImportBookmarks
}) => {
  const [viewMode, setViewMode] = useState<'grid' | 'list'>(() => {
    // 视图与折叠是用户偏好：侧栏折叠都持久化了，这两项没理由每次刷新都重置。
    try {
      return localStorage.getItem('selfhub_sites_view') === 'list' ? 'list' : 'grid';
    } catch {
      return 'grid';
    }
  });
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState(ALL);
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>(() => {
    try {
      return JSON.parse(localStorage.getItem('selfhub_sites_collapsed') ?? '{}') as Record<string, boolean>;
    } catch {
      return {};
    }
  });
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  /** 列表视图的多选：导入 500 书签后「逐个 ⋯ → 移动」是体力活，批量是正解。 */
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const toggleSelected = (id: string) =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const batchMove = (category: string) => {
    let result = sites;
    for (const id of selectedIds) result = moveSiteToCategory(result, id, category);
    commit(result);
    setSelectedIds(new Set());
  };

  const batchPin = () => {
    commit(sites.map((site) => (selectedIds.has(site.id) ? { ...site, pinned: true } : site)));
    setSelectedIds(new Set());
  };

  const batchDelete = () => {
    commit(sites.filter((site) => !selectedIds.has(site.id)));
    setSelectedIds(new Set());
  };

  useEffect(() => {
    try {
      localStorage.setItem('selfhub_sites_view', viewMode);
    } catch {
      /* 只丢偏好，不丢数据 */
    }
  }, [viewMode]);

  useEffect(() => {
    try {
      localStorage.setItem('selfhub_sites_collapsed', JSON.stringify(collapsedGroups));
    } catch {
      /* 只丢偏好，不丢数据 */
    }
  }, [collapsedGroups]);

  // Per-site management state.
  const [editing, setEditing] = useState<NavSite | null>(null);
  const [moving, setMoving] = useState<NavSite | null>(null);
  const [deleting, setDeleting] = useState<NavSite | null>(null);
  const [adding, setAdding] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [copyFailedId, setCopyFailedId] = useState<string | null>(null);
  const [copyNotice, setCopyNotice] = useState('');

  // Drag and drop.
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const dragBlockedRef = useRef(false);

  // External (web) search — deliberately separate from the local filter above.
  const [engine, setEngine] = useState<SearchEngineId>('google');
  const [webQuery, setWebQuery] = useState('');

  const deferredQuery = useDeferredValue(searchQuery);

  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [deferredQuery, selectedCategory]);

  /* ---------------------------------------------------------------------- */
  /* Data                                                                   */
  /* ---------------------------------------------------------------------- */

  // One sorted view of the whole library: numbered sites first, everything else
  // in array order, with a stable tie-break so a render never reshuffles it.
  const orderedSites = useMemo(() => sortSites(sites), [sites]);

  const groups = useMemo(() => {
    const map = new Map<string, NavSite[]>();
    orderedSites.forEach((site) => {
      const key = categoryKey(site);
      const bucket = map.get(key);
      if (bucket) bucket.push(site);
      else map.set(key, [site]);
    });
    return map;
  }, [orderedSites]);

  const groupNames = useMemo(() => Array.from(groups.keys()), [groups]);

  /**
   * The left-hand category rail: every configured category first, then any
   * category that only exists on a site (for example after an import). `全部`
   * is always first and is never duplicated.
   */
  const categoryTabs = useMemo(() => {
    const seen = new Set<string>();
    const names: string[] = [];
    const add = (value: string) => {
      const name = value.trim();
      if (!name || name === ALL || seen.has(name)) return;
      seen.add(name);
      names.push(name);
    };
    categories.forEach(add);
    groupNames.forEach(add);
    return [ALL, ...names];
  }, [categories, groupNames]);

  /**
   * Real, assignable groups. `全部` is the "no filter" tab, not a group a site can
   * belong to, so it must never be offered as a move/create target.
   */
  const tagOptions = useMemo(() => {
    const set = new Set<string>();
    categories.forEach((category) => {
      if (category && category !== ALL) set.add(category);
    });
    sites.forEach((site) => set.add(categoryKey(site)));
    return Array.from(set);
  }, [categories, sites]);

  const localMatches = useMemo(() => {
    const query = deferredQuery.trim();
    return orderedSites.filter((site) => {
      if (selectedCategory !== ALL && categoryKey(site) !== selectedCategory) return false;
      if (!query) return true;
      // Title + URL + description + tags, with the shared pinyin-aware matcher.
      const haystack = [
        site.title || '',
        site.url || '',
        site.description || '',
        (site.tags || []).join(' '),
        categoryKey(site)
      ].join(' ');
      return matchesQuery(haystack, query);
    });
  }, [orderedSites, selectedCategory, deferredQuery]);

  const filteredByGroup = useMemo(() => {
    const map = new Map<string, NavSite[]>();
    localMatches.forEach((site) => {
      const key = categoryKey(site);
      const bucket = map.get(key);
      if (bucket) bucket.push(site);
      else map.set(key, [site]);
    });
    return map;
  }, [localMatches]);

  const activeCategories = useMemo(
    () => (selectedCategory === ALL ? groupNames : [selectedCategory]),
    [selectedCategory, groupNames]
  );

  /* ---------------------------------------------------------------------- */
  /* Writers                                                                */
  /* ---------------------------------------------------------------------- */

  /** Every mutation funnels through here so `order` is always contiguous. */
  const commit = useCallback(
    (next: NavSite[]) => {
      const touched = new Set(next.filter((s) => s.order !== undefined).map((s) => categoryKey(s)));
      if (touched.size === 0) {
        onImportBookmarks(sortSites(next));
        return;
      }
      const alreadyNumbered = new Set(
        sortSites(next)
          .filter((site) => typeof site.order === 'number')
          .map((site) => categoryKey(site))
      );
      const needsRenumber = Array.from(touched).filter(
        (category) => !alreadyNumbered.has(category) || !isContiguouslyNumbered(next, category)
      );
      if (needsRenumber.length === 0) {
        onImportBookmarks(sortSites(next));
        return;
      }
      let normalized = sortSites(next);
      needsRenumber.forEach((category) => {
        normalized = renumberCategory(normalized, category);
      });
      onImportBookmarks(normalized);
    },
    [onImportBookmarks]
  );

  const handleMove = useCallback(
    (site: NavSite, direction: -1 | 1) => {
      commit(moveSite(sites, site.id, direction));
    },
    [commit, sites]
  );

  const handleTogglePin = useCallback(
    (site: NavSite) => {
      commit(sites.map((s) => (s.id === site.id ? { ...s, pinned: !s.pinned } : s)));
    },
    [commit, sites]
  );

  const handleSaveEdit = useCallback(
    (id: string, patch: Partial<NavSite>) => {
      // A category change is a move: let moveSiteToCategory place the record at
      // the end of the target group, then apply the remaining fields on top.
      const base =
        patch.category !== undefined
          ? moveSiteToCategory(sites, id, patch.category)
          : sites;
      const next = base.map((site) =>
        site.id === id
          ? {
              ...site,
              ...patch,
              // These are managed by the ordering helpers / visit counter.
              id: site.id,
              category: site.category,
              order: site.order,
              visitCount: site.visitCount,
              lastVisited: site.lastVisited
            }
          : site
      );
      commit(next);
    },
    [commit, sites]
  );

  const handleMoveToCategory = useCallback(
    (site: NavSite, category: string) => {
      commit(moveSiteToCategory(sites, site.id, category));
    },
    [commit, sites]
  );

  const handleDelete = useCallback(
    (site: NavSite) => {
      onDelete(site.id);
    },
    [onDelete]
  );

  const handleOpen = useCallback(
    (site: NavSite) => {
      onVisit(site.id);
      window.open(site.url, '_blank', 'noopener,noreferrer');
    },
    [onVisit]
  );

  /**
   * Copy reports success/failure in the page (StatusPill / inline text) rather
   * than with `alert()`, which used to be the only feedback for a failed copy.
   */
  const handleCopyLink = useCallback(async (site: NavSite) => {
    try {
      await navigator.clipboard.writeText(site.url);
      setCopiedId(site.id);
      setCopyFailedId(null);
      setCopyNotice(`已复制 ${site.title || site.url} 的链接`);
      window.setTimeout(() => setCopiedId((current) => (current === site.id ? null : current)), 2000);
    } catch {
      setCopyFailedId(site.id);
      setCopiedId(null);
      setCopyNotice(`复制失败：浏览器拒绝了剪贴板访问，请手动复制 ${site.url}`);
    }
  }, []);

  /* ---------------------------------------------------------------------- */
  /* Drag and drop — same helpers as the buttons                           */
  /* ---------------------------------------------------------------------- */

  const handleDragStart = useCallback((site: NavSite) => (e: React.DragEvent) => {
    e.dataTransfer.effectAllowed = 'move';
    setDragId(site.id);
    dragBlockedRef.current = true;
  }, []);

  const handleDragEnd = useCallback(() => {
    setDragId(null);
    setDropTarget(null);
    // A drag that happens to end over the card must not be read as a click.
    window.setTimeout(() => {
      dragBlockedRef.current = false;
    }, 0);
  }, []);

  const handleDrop = useCallback(
    (target: NavSite) => (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const sourceId = dragId;
      setDragId(null);
      setDropTarget(null);
      if (!sourceId || sourceId === target.id) return;
      // Same helper the 上移 / 下移 buttons end up in, so a drop and repeated
      // button presses produce identical `order` values.
      commit(moveSiteOnto(sites, sourceId, target.id));
    },
    [commit, dragId, sites]
  );

  /* ---------------------------------------------------------------------- */
  /* Bookmark import                                                        */
  /* ---------------------------------------------------------------------- */

  const handleImport = useCallback(
    (incoming: NavSite[], options: { allowDuplicates: boolean }): BookmarkImportResult => {
      const known = new Set(sites.map((site) => normalizeUrl(site.url)));
      const added: NavSite[] = [];
      let skipped = 0;

      incoming.forEach((candidate) => {
        const key = normalizeUrl(candidate.url);
        // Default: an existing URL is never touched (skipped, not overwritten).
        // With `allowDuplicates` the user explicitly asked for a copy, so the
        // duplicate check is bypassed instead of silently dropping the row the
        // preview promised to import.
        if (!options.allowDuplicates && known.has(key)) {
          skipped += 1;
          return;
        }
        known.add(key);
        // Never reuse an id that already exists.
        const id = sites.some((site) => site.id === candidate.id) ? `${candidate.id}-${added.length}` : candidate.id;
        added.push({ ...candidate, id });
      });

      if (added.length > 0) commit([...sites, ...added]);
      return { added: added.length, addedIds: added.map((site) => site.id), skipped };
    },
    [commit, sites]
  );

  const handleUndoImport = useCallback(
    (ids: string[]): number => {
      const doomed = new Set(ids);
      const remaining = sites.filter((site) => !doomed.has(site.id));
      const removed = sites.length - remaining.length;
      if (removed > 0) commit(remaining);
      return removed;
    },
    [commit, sites]
  );

  /* ---------------------------------------------------------------------- */
  /* Render helpers                                                         */
  /* ---------------------------------------------------------------------- */

  const toggleGroup = (cat: string) => setCollapsedGroups((prev) => ({ ...prev, [cat]: !prev[cat] }));

  const runWebSearch = () => {
    const query = webQuery.trim();
    if (!query) return;
    const target = SEARCH_ENGINES.find((e) => e.id === engine) ?? SEARCH_ENGINES[0];
    // Explicit action only: the local filter above never reaches this code path.
    window.open(`${target.url}${encodeURIComponent(query)}`, '_blank', 'noopener,noreferrer');
  };

  const menuActions = {
    onEdit: setEditing,
    onMoveToCategory: setMoving,
    onCopyLink: (site: NavSite) => void handleCopyLink(site),
    onTogglePin: handleTogglePin,
    onMove: handleMove,
    onDelete: setDeleting
  };

  const renderCard = (site: NavSite) => {
    const group = groups.get(categoryKey(site)) || [];
    const index = group.findIndex((entry) => entry.id === site.id);
    return (
      <SiteCard
        key={site.id}
        site={site}
        layout={viewMode === 'grid' ? 'card' : 'row'}
        onOpen={handleOpen}
        {...menuActions}
        canMoveUp={index > 0}
        canMoveDown={index >= 0 && index < group.length - 1}
        copied={copiedId === site.id}
        copyFailed={copyFailedId === site.id}
        draggable
        dragging={dragId === site.id}
        dropHint={dropTarget === site.id && dragId !== null && dragId !== site.id}
        onDragStart={handleDragStart(site)}
        onDragOver={(e) => {
          e.preventDefault();
          if (dropTarget !== site.id) setDropTarget(site.id);
        }}
        onDrop={handleDrop(site)}
        onDragEnd={handleDragEnd}
      />
    );
  };

  const hasSites = sites.length > 0;
  const hasLocalMatches = localMatches.length > 0;

  return (
    <div className="space-y-5">
      <PageHeader
        title="快捷导航"
        description={`${sites.length} 个网站 · 点击打开，更多操作在 ⋯ 菜单中。`}
        actions={
          <div className="flex items-center flex-wrap gap-2">
            <Button
              variant="secondary"
              icon={<Upload className="w-3.5 h-3.5" />}
              data-testid="open-bookmark-import"
              onClick={() => setImportOpen(true)}
            >
              导入书签
            </Button>
            {onPasteRecognized && <Button
              variant="secondary"
              icon={<Sparkles className="w-3.5 h-3.5" />}
              data-testid="nav-ai-focus"
              aria-expanded={pasteOpen}
              aria-controls="site-paste-panel"
              onClick={() => setPasteOpen(!pasteOpen)}
            >
              {pasteOpen ? '收起粘贴' : '粘贴识别'}
            </Button>}
            <Button
              variant="primary"
              icon={<Plus className="w-3.5 h-3.5" />}
              data-testid="new-site"
              onClick={() => onOpenAddModal?.('site')}
              title="与顶栏「新建」同一套表单——建网站不再有两个字段不一致的入口"
            >
              新建网站
            </Button>
            <div className="flex items-center bg-sh-surface2 p-0.5 rounded-lg border border-sh-line text-xs">
              <button
                type="button"
                onClick={() => {
                  setViewMode('grid');
                  setSelectedIds(new Set());
                }}
                aria-pressed={viewMode === 'grid'}
                className={`p-1.5 rounded ${viewMode === 'grid' ? 'bg-sh-surface text-sh-fg' : 'text-sh-muted hover:text-sh-fg'}`}
                title="网格卡片视图"
              >
                <LayoutGrid className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={() => setViewMode('list')}
                aria-pressed={viewMode === 'list'}
                className={`p-1.5 rounded ${viewMode === 'list' ? 'bg-sh-surface text-sh-fg' : 'text-sh-muted hover:text-sh-fg'}`}
                title="紧凑列表视图"
              >
                <List className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        }
      />

      {/* 粘贴识别 (2): recognise links locally, then confirm where the content goes. */}
      {onPasteRecognized && (
        <div id="site-paste-panel" hidden={!pasteOpen}>
        <PasteCapture
          categories={categories}
          aiConfig={onPasteRecognized.aiConfig}
          onAddSites={onPasteRecognized.onAddSites}
          onCaptureInbox={onPasteRecognized.onCaptureInbox}
          onAddNote={onPasteRecognized.onAddNote}
        />
        </div>
      )}

      {/*
        Browse layout: categories are a vertical rail on the left at desktop
        widths, and a horizontal scroller on phones. The sites — the reason this
        page exists — keep the whole right-hand column.
      */}
      <div
        className={
          hasSites
            ? 'grid gap-5 lg:grid-cols-[12.5rem_minmax(0,1fr)] lg:items-start'
            : 'grid gap-5'
        }
      >
        {hasSites && (
          <aside data-testid="site-category-rail" className="min-w-0 lg:sticky lg:top-20">
            <nav aria-label="网站分类" className="rounded-2xl border border-sh-line bg-sh-surface p-1.5">
              <div className="hidden items-center justify-between px-2.5 pb-1.5 pt-1 lg:flex">
                <span className="text-[11px] font-semibold text-sh-muted">分类</span>
                <span className="font-mono text-[10px] tabular-nums text-sh-subtle">{categoryTabs.length - 1} 组</span>
              </div>
              <div className="flex gap-1 overflow-x-auto pb-0.5 lg:flex-col lg:overflow-visible lg:pb-0">
                {categoryTabs.map((cat) => {
                  const count = cat === ALL ? sites.length : groups.get(cat)?.length ?? 0;
                  const active = selectedCategory === cat;
                  return (
                    <button
                      key={cat}
                      type="button"
                      data-testid={`site-category-${cat}`}
                      aria-current={active ? 'page' : undefined}
                      onClick={() => setSelectedCategory(cat)}
                      className={`group flex shrink-0 items-center gap-2 rounded-xl px-2.5 py-2 text-left text-xs font-medium transition-colors lg:w-full ${
                        active
                          ? 'bg-sh-accent text-sh-accent-fg'
                          : 'text-sh-muted hover:bg-sh-surface2 hover:text-sh-fg'
                      }`}
                    >
                      <span className="truncate">{cat}</span>
                      <span
                        className={`ml-auto shrink-0 rounded-md px-1.5 py-0.5 font-mono text-[10px] tabular-nums ${
                          active
                            ? 'bg-white/15 text-sh-accent-fg dark:bg-black/10'
                            : 'bg-sh-surface2 text-sh-subtle group-hover:text-sh-fg'
                        }`}
                      >
                        {count}
                      </span>
                    </button>
                  );
                })}
              </div>
            </nav>
            <p className="hidden px-1.5 pt-2 text-[10px] leading-4 text-sh-subtle lg:block">
              选一个分类，右侧只显示这一组网站。
            </p>
          </aside>
        )}

        <div data-testid="site-content" className="min-w-0 space-y-4">
          {/* Local filter — clearly labelled as local, and never a network request. */}
          <section className="space-y-3" aria-label="筛选网站">
            <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
              <div className="w-full sm:max-w-sm">
                <label htmlFor="site-local-filter" className="mb-1 block text-[11px] font-medium text-sh-muted">
                  在快捷导航中筛选
                </label>
                <div className="relative">
                  <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-sh-subtle" aria-hidden />
                  <input
                    id="site-local-filter"
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="输入名称、网址或标签…"
                    className={`${inputClass} pl-8`}
                  />
                </div>
                <p className="mt-1 text-[10px] leading-4 text-sh-subtle">
                  这里输入的内容只在本机筛选，不会发送给搜索引擎。
                </p>
              </div>
              {hasSites && (
                <p className="pb-2 text-[11px] tabular-nums text-sh-subtle" role="status" aria-live="polite">
                  {hasLocalMatches ? `${localMatches.length} / ${sites.length} 个网站` : `0 / ${sites.length} 个网站`}
                </p>
              )}
            </div>

            {/* External search — separate box, visible engine tabs, explicit action. */}
            <details className="group rounded-xl border border-sh-line bg-sh-surface">
              <summary className="flex cursor-pointer list-none items-center gap-2 rounded-xl px-3 py-2.5 text-xs text-sh-muted transition-colors hover:text-sh-fg [&::-webkit-details-marker]:hidden">
                <Globe className="h-3.5 w-3.5" aria-hidden />
                <span>去网上搜索</span>
                <span className="ml-auto text-[10px] text-sh-subtle">明确提交后才发送</span>
                <ChevronDown className="h-3.5 w-3.5 text-sh-subtle transition-transform group-open:rotate-180" aria-hidden />
              </summary>
              <div className="space-y-2.5 border-t border-sh-line p-3">
                <div className="flex flex-col gap-2 xl:flex-row xl:items-center">
                  <div className="flex items-center gap-1" role="tablist" aria-label="外部搜索引擎">
                    {SEARCH_ENGINES.map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        role="tab"
                        aria-selected={engine === item.id}
                        data-testid={`engine-${item.id}`}
                        onClick={() => setEngine(item.id)}
                        className={`px-2.5 py-1 rounded-lg text-[11px] transition-colors ${
                          engine === item.id
                            ? 'bg-sh-surface2 border border-sh-line text-sh-fg font-semibold'
                            : 'text-sh-muted hover:text-sh-fg'
                        }`}
                      >
                        {item.name}
                      </button>
                    ))}
                  </div>
                  <div className="flex flex-1 flex-wrap items-center gap-2 sm:flex-nowrap min-w-0">
                    <input
                      type="text"
                      value={webQuery}
                      onChange={(e) => setWebQuery(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') runWebSearch();
                      }}
                      placeholder="外部搜索关键词（回车才会发送）"
                      aria-label="外部搜索关键词"
                      data-testid="web-search-input"
                      className={inputClass}
                    />
                    <Button
                      variant="secondary"
                      data-testid="web-search-submit"
                      onClick={runWebSearch}
                      icon={<Globe className="w-3.5 h-3.5" />}
                    >
                      用 {SEARCH_ENGINES.find((e) => e.id === engine)?.name} 搜索
                    </Button>
                  </div>
                </div>
                <p className="text-[11px] text-sh-subtle">
                  点“用 {SEARCH_ENGINES.find((e) => e.id === engine)?.name} 搜索”或按回车后，关键词会发送到该搜索引擎的外部网站。
                </p>
              </div>
            </details>

            {copyNotice && (
              <div className="flex items-center gap-2 text-[11px] text-sh-muted" role="status">
                <StatusPill tone={copyFailedId ? 'danger' : 'ok'} label={copyFailedId ? '复制失败' : '已复制'} />
                <span className="truncate">{copyNotice}</span>
              </div>
            )}
          </section>

          {!hasSites && (
            <EmptyState
              icon={<Compass className="w-6 h-6" />}
              title="还没有保存任何网站"
              description="先添加一个常用网站，或从浏览器导出的书签 HTML 批量导入。导入前会先给你看清楚数量和重复项。"
              action={
                <>
                  <Button variant="primary" icon={<Plus className="w-3.5 h-3.5" />} onClick={() => onOpenAddModal?.('site')}>
                    添加第一个网站
                  </Button>
                  <Button variant="secondary" icon={<Upload className="w-3.5 h-3.5" />} onClick={() => setImportOpen(true)}>
                    导入书签
                  </Button>
                </>
              }
            />
          )}

          {hasSites && !hasLocalMatches && (
            <EmptyState
              icon={<Search className="w-6 h-6" />}
              title="没有匹配的网站"
              description={
                searchQuery
                  ? `本机筛选“${searchQuery}”没有结果。可以清空筛选，或用上面的外部搜索框到搜索引擎查找。`
                  : '当前分组下没有网站，换个分组看看。'
              }
              action={
                searchQuery ? (
                  <Button variant="secondary" onClick={() => setSearchQuery('')}>
                    清空筛选
                  </Button>
                ) : (
                  <Button variant="secondary" onClick={() => setSelectedCategory(ALL)}>
                    查看全部
                  </Button>
                )
              }
            />
          )}

          {/* Grouped, foldable sections */}
          {hasLocalMatches &&
            (() => {
              let budget = visibleCount;
              return activeCategories.map((cat) => {
                const groupSitesAll = filteredByGroup.get(cat) || [];
                if (groupSitesAll.length === 0) return null;

                const groupSites = groupSitesAll.slice(0, Math.max(0, budget));
                budget -= groupSites.length;
                if (groupSites.length === 0) return null;

                const isCollapsed = Boolean(collapsedGroups[cat]);

                return (
                  <div key={cat} className="space-y-3">
                    <button
                      type="button"
                      onClick={() => toggleGroup(cat)}
                      aria-expanded={!isCollapsed}
                      className="flex w-full items-center justify-between gap-3 border-b border-sh-line px-1 py-2.5 text-left select-none"
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="truncate text-xs font-semibold text-sh-fg">{cat}</span>
                        <span className="rounded bg-sh-surface2 px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-sh-muted">
                          {groupSitesAll.length}
                        </span>
                      </span>
                      <span className="shrink-0 text-[11px] text-sh-subtle">{isCollapsed ? '展开' : '折叠'}</span>
                    </button>

                    {/* Dense list: no `overflow-hidden`, it would clip the row's ⋯ menu. */}
                    {!isCollapsed &&
                      (viewMode === 'grid' ? (
                        <div data-testid="site-grid" className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
                          {groupSites.map(renderCard)}
                        </div>
                      ) : (
                        <div className="rounded-xl border border-sh-line bg-sh-surface divide-y divide-sh-line">
                          {groupSites.map((site) => (
                            <div key={site.id} className="flex items-start gap-1.5 pr-1.5">
                              <label className="flex items-center self-stretch pl-3 cursor-pointer" title="选择以批量整理">
                                <input
                                  type="checkbox"
                                  aria-label={`选择 ${site.title}`}
                                  data-testid={`site-select-${site.id}`}
                                  checked={selectedIds.has(site.id)}
                                  onChange={() => toggleSelected(site.id)}
                                />
                              </label>
                              <div className="flex-1 min-w-0">{renderCard(site)}</div>
                            </div>
                          ))}
                        </div>
                      ))}
                  </div>
                );
              });
            })()}

          {/* 批量条：列表视图勾选后浮现。移动/置顶走与单个操作同一套 commit，
              删除是两击确认——批量也一样要有下限防护。 */}
          {viewMode === 'list' && selectedIds.size > 0 && (
            <div
              className="sticky top-2 z-20 flex flex-wrap items-center gap-2 rounded-xl border border-sh-line-strong bg-sh-surface2 p-2.5 text-xs shadow-lg"
              data-testid="site-batch-bar"
            >
              <span className="font-medium text-sh-fg">已选 {selectedIds.size} 条</span>
              <select
                aria-label="移动到分组"
                defaultValue=""
                onChange={(e) => {
                  if (e.target.value) batchMove(e.target.value);
                }}
                className="bg-sh-surface border border-sh-line rounded-lg px-2 py-1 text-[11px] text-sh-fg"
              >
                <option value="">移动到分组…</option>
                {tagOptions.map((group) => (
                  <option key={group} value={group}>
                    {group}
                  </option>
                ))}
              </select>
              <Button size="sm" variant="secondary" onClick={batchPin}>
                置顶所选
              </Button>
              <ConfirmButton
                onConfirm={batchDelete}
                confirmLabel={`确认删除所选 ${selectedIds.size} 条？`}
                className="px-2 py-1 rounded-lg border border-sh-line text-[11px] text-sh-danger hover:bg-sh-danger/10"
              >
                删除所选
              </ConfirmButton>
              <Button size="sm" variant="ghost" onClick={() => setSelectedIds(new Set())}>
                取消选择
              </Button>
            </div>
          )}

          {localMatches.length > visibleCount && (
            <div className="flex flex-col items-center gap-2 py-4">
              <span className="text-[11px] text-sh-subtle font-mono">
                已显示 {Math.min(visibleCount, localMatches.length)} / {localMatches.length} 个站点
              </span>
              <Button variant="secondary" onClick={() => setVisibleCount((c) => c + PAGE_SIZE * 2)}>
                加载更多
              </Button>
            </div>
          )}
        </div>
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Dialogs                                                            */}
      {/* ------------------------------------------------------------------ */}

      {/* 「新建」不再有本地第二套表单：PageHeader 与空状态都走全局 AddItemModal，
          编辑仍用本地对话框（编辑场景它更快，且没有跨类型选择的需要）。 */}

      {editing && (
        <SiteEditorDialog
          mode="edit"
          site={editing}
          groups={tagOptions}
          onCancel={() => setEditing(null)}
          onSubmit={(values) => {
            handleSaveEdit(editing.id, {
              title: values.title.trim(),
              url: values.url,
              category: values.category.trim() || categoryKey(editing),
              description: values.description?.trim() || undefined,
              tags: values.tags?.length ? values.tags : undefined
            });
            setEditing(null);
          }}
        />
      )}

      {moving && (
        <MoveToGroupDialog
          site={moving}
          groups={tagOptions.filter((group) => group !== categoryKey(moving))}
          onCancel={() => setMoving(null)}
          onSubmit={(category) => {
            handleMoveToCategory(moving, category);
            setMoving(null);
          }}
        />
      )}

      <ConfirmDialog
        open={Boolean(deleting)}
        tone="danger"
        title={deleting ? `删除「${deleting.title || deleting.url}」？` : ''}
        description={
          deleting ? (
            <>
              将从快捷导航中移除这个网站条目：<span className="font-mono">{deleting.url}</span>
              （分组「{categoryKey(deleting)}」、访问次数 {deleting.visitCount || 0} 次的记录会一起删除）。
              <br />
              不会删除浏览器书签，也不会影响其它网站；此操作无法撤销。
            </>
          ) : null
        }
        confirmLabel="删除这个网站"
        onConfirm={() => {
          if (deleting) handleDelete(deleting);
          setDeleting(null);
        }}
        onCancel={() => setDeleting(null)}
      />

      <BookmarkImportDialog
        open={importOpen}
        sites={sites}
        onImport={handleImport}
        onUndo={handleUndoImport}
        onClose={() => setImportOpen(false)}
      />
    </div>
  );
};

/* -------------------------------------------------------------------------- */
/* Inline create / edit dialog                                                */
/* -------------------------------------------------------------------------- */

interface SiteEditorValues {
  title: string;
  url: string;
  category: string;
  description?: string;
  tags?: string[];
}

const SiteEditorDialog: React.FC<{
  mode: 'create' | 'edit';
  site?: NavSite;
  groups: string[];
  onCancel: () => void;
  onSubmit: (values: SiteEditorValues) => void;
}> = ({ mode, site, groups, onCancel, onSubmit }) => {
  const [title, setTitle] = useState(site?.title || '');
  const [url, setUrl] = useState(site?.url || '');
  const [category, setCategory] = useState(site?.category || groups[0] || '默认分类');
  const [description, setDescription] = useState(site?.description || '');
  const [tags, setTags] = useState((site?.tags || []).join(', '));
  const [error, setError] = useState('');

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) {
      setError('名称不能为空，它用来在这张网格里认出这个网站。');
      return;
    }
    const normalized = /^https?:\/\//i.test(url.trim()) ? url.trim() : `https://${url.trim()}`;
    try {
      // eslint-disable-next-line no-new
      new URL(normalized);
    } catch {
      setError('网址格式不正确，例如 https://example.com');
      return;
    }
    onSubmit({
      title,
      url: normalized,
      category,
      description,
      tags: tags
        .split(/[,，]/)
        .map((tag) => tag.trim())
        .filter(Boolean)
    });
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center p-4"
      style={{ background: 'var(--sh-overlay)' }}
      onClick={onCancel}
      role="dialog"
      aria-modal="true"
      aria-label={mode === 'create' ? '新建网站' : '编辑网站'}
    >
      <form
        onSubmit={submit}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-2xl border border-sh-line bg-sh-surface p-4 space-y-3 shadow-2xl"
      >
        <h3 className="text-sm font-semibold text-sh-fg flex items-center gap-2">
          <Pencil className="w-4 h-4 text-sh-info" aria-hidden />
          {mode === 'create' ? '新建网站' : '编辑网站'}
        </h3>
        <p className="text-[11px] text-sh-muted">名称和网址是必填项，分组、描述、标签可以后补。</p>

        <Field label="名称" htmlFor="site-editor-title" required>
          <input
            id="site-editor-title"
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="例如: GitHub 个人中心"
            className={inputClass}
          />
        </Field>
        <Field label="网址" htmlFor="site-editor-url" required>
          <input
            id="site-editor-url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://..."
            className={`${inputClass} font-mono`}
          />
        </Field>
        <Field label="分组" htmlFor="site-editor-category" hint="可以直接输入新的分组名。">
          <input
            id="site-editor-category"
            list="site-editor-groups"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className={inputClass}
          />
          <datalist id="site-editor-groups">
            {groups.map((group) => (
              <option key={group} value={group} />
            ))}
          </datalist>
        </Field>
        <Field label="描述（可选）" htmlFor="site-editor-desc">
          <input
            id="site-editor-desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className={inputClass}
          />
        </Field>
        <Field label="标签（可选）" htmlFor="site-editor-tags" hint="用逗号分隔。本机筛选会匹配标签。">
          <input
            id="site-editor-tags"
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            className={inputClass}
          />
        </Field>

        {error && (
          <p className="text-[11px] text-sh-danger" role="alert">
            {error}
          </p>
        )}

        <div className="flex items-center justify-end gap-2 pt-1">
          <Button variant="secondary" onClick={onCancel}>
            取消
          </Button>
          <Button variant="primary" type="submit">
            {mode === 'create' ? '保存网站' : '保存修改'}
          </Button>
        </div>
      </form>
    </div>
  );
};

const MoveToGroupDialog: React.FC<{
  site: NavSite;
  groups: string[];
  onCancel: () => void;
  onSubmit: (category: string) => void;
}> = ({ site, groups, onCancel, onSubmit }) => {
  const [value, setValue] = useState(groups[0] || '');
  const [isNew, setIsNew] = useState(groups.length === 0);

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center p-4"
      style={{ background: 'var(--sh-overlay)' }}
      onClick={onCancel}
      role="dialog"
      aria-modal="true"
      aria-label="移动到分组"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-sm rounded-2xl border border-sh-line bg-sh-surface p-4 space-y-3 shadow-2xl"
      >
        <h3 className="text-sm font-semibold text-sh-fg">移动到分组</h3>
        <p className="text-[11px] text-sh-muted">
          把「{site.title || site.url}」从「{categoryKey(site)}」移到别处，它会排在该分组末尾。
        </p>

        {groups.length > 0 && (
          <div className="space-y-1">
            {groups.map((group) => (
              <label key={group} className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-sh-surface2 cursor-pointer text-xs text-sh-fg">
                <input
                  type="radio"
                  name="move-target"
                  checked={!isNew && value === group}
                  onChange={() => {
                    setIsNew(false);
                    setValue(group);
                  }}
                />
                {group}
              </label>
            ))}
            <label className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-sh-surface2 cursor-pointer text-xs text-sh-fg">
              {/* Clear the prefilled name: submitting a "new group" that still
                  holds the first existing group's name would silently move the
                  site into that group instead. */}
              <input type="radio" name="move-target" checked={isNew} onChange={() => { setIsNew(true); setValue(''); }} />
              新建分组…
            </label>
          </div>
        )}

        {isNew && (
          <Field label="新分组名称" htmlFor="move-new-group">
            <input
              id="move-new-group"
              autoFocus
              value={value}
              onChange={(e) => setValue(e.target.value)}
              className={inputClass}
            />
          </Field>
        )}

        <div className="flex items-center justify-end gap-2 pt-1">
          <Button variant="secondary" onClick={onCancel}>
            取消
          </Button>
          <Button variant="primary" disabled={!value.trim()} onClick={() => onSubmit(value.trim())}>
            移动
          </Button>
        </div>
      </div>
    </div>
  );
};

export default SitesView;
