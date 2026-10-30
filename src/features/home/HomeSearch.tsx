import React, { useEffect, useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import type { HubState } from '../../types';
import { searchEverything, SEARCH_KIND_LABELS, type SearchHit } from '../../domain/search';

export interface HomeSearchProps {
  state: HubState;
  /** Open a hit — the same handler the ⌘K dialog uses, so both behave identically. */
  onOpenHit: (hit: SearchHit) => void;
}

/**
 * 首页搜索 (1): one box, everything.
 *
 * It sits at the top of the home page and searches notes, annotations, drawings, bookmarks,
 * servers, reminders, projects, inbox entries and vault names in one go. It is deliberately
 * **not** filtered by the module switches: a hidden module's data should still be findable,
 * otherwise turning a switch off means losing the ability to find what is in it.
 *
 * Results are grouped by kind with the real total per group, so "3 条笔记" is a fact, not a
 * guess from the visible rows.
 */
export const HomeSearch: React.FC<HomeSearchProps> = ({ state, onOpenHit }) => {
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query), 180);
    return () => clearTimeout(timer);
  }, [query]);

  const result = useMemo(() => {
    const needle = debounced.trim();
    if (!needle) return null;
    return searchEverything({ state, query: needle, defaultLimit: 5 });
  }, [state, debounced]);

  const total = result?.groups.reduce((sum, group) => sum + group.total, 0) ?? 0;
  const flat = useMemo(() => (result?.groups ?? []).flatMap((group) => group.hits), [result]);

  return (
    <section
      className="min-w-0"
      data-testid="home-search"
      aria-label="搜索全部数据"
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (flat[0] && query.trim() === debounced.trim()) onOpenHit(flat[0]);
        }}
        className="relative"
      >
        <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-sh-subtle" aria-hidden />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索全部内容…"
          aria-label="搜索全部数据"
          data-testid="home-search-input"
          className="w-full bg-sh-surface border border-sh-line-strong rounded-xl pl-10 pr-3 py-3.5 text-base text-sh-fg focus:outline-none focus:border-sh-line-strong"
        />
      </form>

      {result && (
        <div className="mt-3 rounded-xl border border-sh-line bg-sh-surface p-4" data-testid="home-search-results">
          {total === 0 ? (
            <p className="text-xs text-sh-muted" data-testid="home-search-empty">
              没找到「{debounced.trim()}」。
            </p>
          ) : (
            <div className="space-y-2.5">
              <p className="text-[11px] text-sh-subtle" data-testid="home-search-total">
                共 {total} 条
              </p>
              {result.groups.map((group) => (
                <div key={group.kind} data-search-group={group.kind}>
                  <div className="flex items-center gap-2 mb-1">
                    <h3 className="text-[11px] font-semibold text-sh-muted">{SEARCH_KIND_LABELS[group.kind]}</h3>
                    <span className="text-[10px] text-sh-subtle">{group.total} 条</span>
                  </div>
                  <ul className="space-y-0.5">
                    {group.hits.map((hit) => (
                      <li key={`${hit.kind}:${hit.id}`}>
                        <button
                          onClick={() => onOpenHit(hit)}
                          data-testid={`home-search-hit-${hit.kind}-${hit.id}`}
                          className="w-full text-left px-2 py-1 rounded-lg hover:bg-sh-surface2 transition-colors"
                        >
                          <span className="block text-xs text-sh-fg truncate">{hit.title}</span>
                          {hit.snippet && (
                            <span className="block text-[10px] text-sh-subtle truncate">{hit.snippet}</span>
                          )}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
};

export default HomeSearch;
