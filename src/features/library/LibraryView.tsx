import React, { useEffect, useMemo, useState } from 'react';
import { Library, Search, X } from 'lucide-react';
import type { HubState } from '../../types';
import {
  buildLibraryIndex,
  filterLibrary,
  filterLibraryByFeatures,
  libraryFacets,
  KIND_LABELS,
  SOURCE_LABELS,
  type LibraryKind,
  type LibrarySource
} from '../../domain/library';
import { EmptyState, PageHeader, inputClass } from '../../shared/ui';
import { FEATURE_DEFS } from '../../lib/features';
import { formatRelative } from '../../lib/dates';

export interface LibraryViewProps {
  state: HubState;
  onNavigate: (path: string) => void;
  onOpenAddModal: (type?: 'site' | 'server' | 'secret' | 'checkin' | 'note') => void;
  /** Seed filters from the URL so a deep link can open a filtered list. */
  initialFilters?: { type?: string; source?: string; q?: string };
  /**
   * Pin the list to one kind.
   *
   * 全部资料 was removed; the remaining panes are single-collection views (网页批注 today), so the
   * kind filter is not a user choice there — showing the dropdown would re-create the mixed list
   * the redesign deleted.
   */
  lockedKind?: LibraryKind;
}

const KIND_BY_QUERY: Record<string, LibraryKind> = {
  note: 'note',
  webpage: 'webpage',
  drawing: 'drawing',
  remote: 'remote',
  bookmark: 'bookmark'
};

/** Switch id → its human label, for the "hidden by a switch" line. */
const FEATURE_LABELS: Record<string, string> = Object.fromEntries(FEATURE_DEFS.map((def) => [def.id, def.label]));

const SOURCE_BY_QUERY: Record<string, LibrarySource> = {
  local: 'local',
  'web-clip': 'web-clip',
  oss: 'oss',
  wucai: 'wucai',
  youdao: 'youdao'
};

/**
 * 资料库 (P1-05).
 *
 * One list over five existing collections (see domain/library.ts) with explicit
 * source labels, so "where did this come from" is a column rather than a guess.
 * The list is a view: selecting a note opens the existing Markdown workspace,
 * and nothing is copied into a second store.
 *
 * The coverage sentence at the bottom is deliberate. Local search cannot see the
 * body of a remote file that was never downloaded, so the page states what was
 * searched instead of implying the results are complete.
 */
export const LibraryView: React.FC<LibraryViewProps> = ({
  state,
  onNavigate,
  onOpenAddModal,
  initialFilters,
  lockedKind
}) => {
  const [kind, setKind] = useState<LibraryKind | 'all'>(
    lockedKind ?? KIND_BY_QUERY[initialFilters?.type || ''] ?? 'all'
  );
  const [source, setSource] = useState<LibrarySource | 'all'>(SOURCE_BY_QUERY[initialFilters?.source || ''] || 'all');
  const [project, setProject] = useState<string>('all');
  const [tag, setTag] = useState<string>('all');
  const [query, setQuery] = useState(initialFilters?.q || '');

  const indexed = useMemo(() => buildLibraryIndex(state), [state]);
  /**
   * The list honours the module switches.
   *
   * Turning 「网页划线批注」 off used to hide its sidebar entry while its rows stayed in 全部资料,
   * so the switch looked broken. Rows whose module is off are filtered out and counted, so the
   * user can tell "switch hidden 12 rows" from "I have no annotations".
   */
  const { items: all, hidden } = useMemo(
    () => filterLibraryByFeatures(indexed, state.features),
    [indexed, state.features]
  );
  const facets = useMemo(() => libraryFacets(all), [all]);
  const projects = useMemo(() => (state.projects || []).map((p) => p.name), [state.projects]);

  const filtered = useMemo(
    () => filterLibrary(all, { kind, source, project, tag, query }),
    [all, kind, source, project, tag, query]
  );

  const remoteNotDownloaded = all.filter((i) => i.kind === 'remote' && i.partial).length;
  const hasFilters = kind !== 'all' || source !== 'all' || project !== 'all' || tag !== 'all' || query.trim().length > 0;

  /**
   * Bounded first render (§15.4 "初次渲染不超过 100 条").
   *
   * The list used to render every match. With a few thousand annotations and notes
   * that meant the first paint built a DOM node per record — the benchmark spec added
   * alongside this measures it. Showing a page and letting the user ask for more is
   * the cheap fix; virtualization remains the option if pages of 100 are still slow.
   */
  const [visibleCount, setVisibleCount] = useState(100);
  const visible = useMemo(() => filtered.slice(0, visibleCount), [filtered, visibleCount]);
  // Any filter or query change starts from the first page again.
  useEffect(() => {
    setVisibleCount(100);
  }, [kind, source, project, tag, query]);

  const openItem = (key: string) => {
    const item = all.find((i) => i.key === key);
    if (!item) return;
    if (item.kind === 'drawing') {
      onNavigate('#/tools/drawing/new');
      return;
    }
    onNavigate(`#/library/item/${encodeURIComponent(item.key)}`);
  };

  const resetFilters = () => {
    setKind('all');
    setSource('all');
    setProject('all');
    setTag('all');
    setQuery('');
  };

  return (
    <div data-testid="library-view">
      <PageHeader
        title={lockedKind === 'webpage' ? '网页批注' : '资料库'}
        description={
          lockedKind === 'webpage'
            ? '从别的网站划词存进来的内容。这里只做展示与维护：可以改、可以删、可以打开原始链接；新建在划词工具那边。'
            : '笔记、网页批注与远端文件。每类内容在自己的页面里，不再混在一张表里。'
        }
        actions={
          // A single-collection pane does not offer 「新建」: annotations come from the clip tool,
          // and notes are written in the notes pane's own editor.
          lockedKind ? undefined : (
            <button
              onClick={() => onOpenAddModal()}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-sh-accent text-sh-accent-fg text-xs font-semibold sh-tap"
            >
              新建笔记
            </button>
          )
        }
      />

      <div className="grid grid-cols-1 lg:grid-cols-[200px_1fr] gap-4">
        {/* Filters */}
        <aside className="space-y-3" aria-label="资料筛选">
          <label className="relative block">
            <span className="sr-only">在资料中搜索</span>
            <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-sh-subtle" aria-hidden />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="在我的资料中搜索"
              className={`${inputClass} pl-8`}
              data-testid="library-search"
            />
          </label>

          {/* The kind filter is hidden when the pane is already one kind. */}
          {!lockedKind && (
            <FilterGroup
              label="类型"
              value={kind}
              onChange={(v) => setKind(v as LibraryKind | 'all')}
              options={[
                { value: 'all', label: `全部 ${all.length}` },
                ...facets.kinds.map((k) => ({
                  value: k,
                  label: `${KIND_LABELS[k]} ${all.filter((i) => i.kind === k).length}`
                }))
              ]}
            />
          )}

          <FilterGroup
            label="来源"
            value={source}
            onChange={(v) => setSource(v as LibrarySource | 'all')}
            options={[
              { value: 'all', label: '全部来源' },
              ...facets.sources.map((s) => ({ value: s, label: SOURCE_LABELS[s] }))
            ]}
          />

          {projects.length > 0 && (
            <FilterGroup
              label="项目"
              value={project}
              onChange={setProject}
              options={[
                { value: 'all', label: '全部项目' },
                ...projects.map((p) => ({ value: p, label: p })),
                { value: '__none__', label: '未关联项目' }
              ]}
            />
          )}

          {facets.tags.length > 0 && (
            <FilterGroup
              label="标签"
              value={tag}
              onChange={setTag}
              options={[{ value: 'all', label: '全部标签' }, ...facets.tags.map((t) => ({ value: t, label: t }))]}
            />
          )}

          {hasFilters && (
            <button onClick={resetFilters} className="inline-flex items-center gap-1 text-[11px] text-sh-info hover:underline">
              <X className="w-3 h-3" aria-hidden /> 清除筛选
            </button>
          )}
        </aside>

        {/* List */}
        <div className="min-w-0">
          {all.length === 0 ? (
            <EmptyState
              icon={<Library className="w-5 h-5" />}
              title="资料库是空的"
              description="新建一条笔记，或从收件箱把已记录的内容转成正式资料。"
              action={
                <>
                  <button onClick={() => onOpenAddModal()} className="px-3 py-1.5 rounded-lg bg-sh-accent text-sh-accent-fg text-xs font-semibold">
                    新建笔记
                  </button>
                  <button onClick={() => onNavigate('#/inbox')} className="px-3 py-1.5 rounded-lg border border-sh-line text-xs">
                    打开收件箱
                  </button>
                </>
              }
            />
          ) : filtered.length === 0 ? (
            <EmptyState title="没有匹配的资料" description="换一个关键词或放宽筛选条件。" />
          ) : (
            <ul className="rounded-2xl border border-sh-line divide-y divide-sh-line overflow-hidden" data-testid="library-list">
              {visible.map((item) => (
                <li key={item.key}>
                  <button
                    onClick={() => openItem(item.key)}
                    data-library-item={item.key}
                    className="w-full text-left px-3 py-2.5 bg-sh-surface hover:bg-sh-surface2 transition-colors"
                  >
                    <span className="flex items-center justify-between gap-2">
                      <span className="text-xs font-medium text-sh-fg truncate">{item.title}</span>
                      <span className="flex items-center gap-1.5 shrink-0">
                        <span className="text-[10px] px-1.5 py-0.5 rounded border border-sh-line text-sh-muted">
                          {item.kindLabel}
                        </span>
                        <span className="text-[10px] text-sh-subtle">{item.sourceLabel}</span>
                      </span>
                    </span>
                    {item.snippet && <span className="block text-[11px] text-sh-muted truncate mt-0.5">{item.snippet}</span>}
                    <span className="flex items-center gap-2 text-[10px] text-sh-subtle mt-0.5">
                      <span>{formatRelative(item.updatedAt)}</span>
                      {item.projectName && <span>· 项目 {item.projectName}</span>}
                      {item.partial && <span className="text-sh-warn">· 未下载正文</span>}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          {filtered.length > visible.length && (
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2" data-testid="library-more">
              <span className="text-[11px] text-sh-subtle" data-testid="library-visible-count">
                已显示 {visible.length} / {filtered.length} 条
              </span>
              <button
                onClick={() => setVisibleCount((prev) => prev + 100)}
                data-testid="library-show-more"
                className="px-2.5 py-1 rounded-lg border border-sh-line text-[11px] text-sh-fg hover:border-sh-line-strong"
              >
                再显示 100 条
              </button>
            </div>
          )}
          {/* Always rendered: the benchmark spec and the user both need a stable
              "how many matched" number regardless of whether a list or empty state
              is on screen. */}
          <p className="mt-2 text-[11px] text-sh-subtle" data-testid="library-match-count">
            已匹配 {filtered.length} 条{hasFilters ? '（筛选后）' : ''}
          </p>

          {/* A switch is hiding rows: say which one and how many, so the user can tell
              "turned off" from "I have none". */}
          {hidden.length > 0 && (
            <p className="mt-1 text-[11px] text-sh-warn" data-testid="library-hidden-by-switch">
              你的开关隐藏了{' '}
              {hidden
                .map((entry) => `${FEATURE_LABELS[entry.feature] ?? entry.feature} ${entry.count} 条`)
                .join('、')}
              （数据未删除，去设置可重新打开）
            </p>
          )}

          <p className="mt-3 text-[11px] text-sh-subtle leading-relaxed" data-testid="library-coverage">
            搜索范围：本机笔记、网页批注、手绘标题，以及已缓存正文的远端文件。
            {remoteNotDownloaded > 0
              ? ` 另有 ${remoteNotDownloaded} 个远端文件尚未下载正文，只能按标题匹配。`
              : ' 当前没有未缓存正文的远端文件。'}
          </p>
        </div>
      </div>
    </div>
  );
};

function FilterGroup({
  label,
  value,
  onChange,
  options
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <div>
      <div className="text-[10px] font-semibold uppercase tracking-wider text-sh-subtle mb-1">{label}</div>
      <div className="flex flex-wrap gap-1">
        {options.map((option) => (
          <button
            key={option.value}
            onClick={() => onChange(option.value)}
            data-filter={`${label}:${option.value}`}
            className={`px-2 py-0.5 rounded-lg text-[11px] border transition-colors ${
              value === option.value
                ? 'bg-sh-surface2 border-sh-line-strong text-sh-fg'
                : 'border-sh-line text-sh-muted hover:text-sh-fg'
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export default LibraryView;
