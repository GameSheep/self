import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRight,
  BookOpen,
  Clock,
  ExternalLink,
  FileText,
  FolderKanban,
  Inbox,
  Key,
  PenLine,
  Search,
  Server,
  X
} from 'lucide-react';
import type { HubState, SecretItem } from '../types';
import { loadIndex, type IndexedDoc } from '../lib/vaultIndex';
import { searchEverything, type SearchHit, type SearchKind, type SearchResult } from '../domain/search';

/**
 * Global command palette.
 * Thin by design: the searching itself lives in `domain/search.ts`
 * (`searchEverything`), which is the single place that knows what is searchable and
 */

interface GlobalSearchProps {
  isOpen: boolean;
  onClose: () => void;
  state: HubState;
  /** Bodies from the local vault index, when one has been built. */
  vaultDocs?: IndexedDoc[];
  masterPassword?: string | null;
  onRequireUnlock?: () => void;
  /** The caller decides what "open" means for each kind. */
  onOpenResult: (hit: SearchHit) => void;
  /** Copy a credential; only called when unlocked. */
  onCopySecret?: (secret: SecretItem) => void;
}

const KIND_ICONS: Record<SearchKind, React.ReactNode> = {
  note: <FileText className="w-3.5 h-3.5 text-sh-focus" />,
  annotation: <BookOpen className="w-3.5 h-3.5 text-sh-warn" />,
  drawing: <PenLine className="w-3.5 h-3.5 text-sh-focus" />,
  bookmark: <ExternalLink className="w-3.5 h-3.5 text-sh-info" />,
  server: <Server className="w-3.5 h-3.5 text-sh-ok" />,
  reminder: <Clock className="w-3.5 h-3.5 text-sh-warn" />,
  project: <FolderKanban className="w-3.5 h-3.5 text-sh-ok" />,
  inbox: <Inbox className="w-3.5 h-3.5 text-sh-warn" />,
  secret: <Key className="w-3.5 h-3.5 text-sh-warn" />,
  remote: <BookOpen className="w-3.5 h-3.5 text-sh-focus" />,
  vault: <Search className="w-3.5 h-3.5 text-sh-focus" />
};

/** Snippet with the literal match highlighted (pinyin matches have no offset). */
function Snippet({ hit }: { hit: SearchHit }) {
  if (!hit.snippet) return null;
  const { snippet, matchIndex, matchLength } = hit;
  if (matchIndex === undefined || !matchLength) {
    return <div className="text-[11px] text-sh-muted truncate">{snippet}</div>;
  }
  const end = matchIndex + matchLength;
  return (
    <div className="text-[11px] text-sh-muted truncate" data-search-snippet>
      {snippet.slice(0, matchIndex)}
      <mark className="bg-sh-warn/20 text-sh-warn rounded px-0.5">{snippet.slice(matchIndex, end)}</mark>
      {snippet.slice(end)}
    </div>
  );
}

export const GlobalSearch: React.FC<GlobalSearchProps> = ({
  isOpen,
  onClose,
  state,
  vaultDocs,
  masterPassword,
  onRequireUnlock,
  onOpenResult,
  onCopySecret
}) => {
  const [query, setQuery] = useState('');
  const [activeKind, setActiveKind] = useState<'all' | SearchKind>('all');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [loadedDocs, setLoadedDocs] = useState<IndexedDoc[]>([]);
  const inputRef = useRef<HTMLInputElement | null>(null);

  /**
   * Remote note bodies come from the local vault index, which this dialog reads
   * itself when the caller did not supply it. Loading is deferred to the first open so
   * the palette costs nothing until it is used, and a failure degrades to "not
   * indexed" (reported in the coverage line) instead of an empty-looking search.
   */
  useEffect(() => {
    if (!isOpen || vaultDocs) return;
    let alive = true;
    loadIndex()
      .then((docs) => {
        if (alive) setLoadedDocs(docs);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [isOpen, vaultDocs]);

  const docs = vaultDocs ?? loadedDocs;

  // Keep the keyboard-selected row inside the scrollable viewport: without this,
  // arrow keys past the first screen highlighted rows the user could not see and
  // Enter opened something invisible.
  const listRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!isOpen) return;
    const container = listRef.current;
    if (!container) return;
    container.querySelector('[data-search-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex, isOpen]);

  // Restore focus to the trigger when the palette closes; dropping focus on body
  // forced keyboard users to Tab from the top of the page.
  const triggerRef = useRef<Element | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!isOpen) return;
    triggerRef.current = document.activeElement;
    return () => {
      const el = triggerRef.current;
      if (el && el.isConnected && document.contains(el)) {
        (el as HTMLElement).focus?.();
      }
      triggerRef.current = null;
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    setQuery('');
    setActiveKind('all');
    setSelectedIndex(0);
    // Focus immediately, not on a timer: a user who presses ⌘K and types straight away
    // must not lose the first characters. (The old 30ms delay lost them, and it was
    // only invisible because the home page happened to show the same title.)
    inputRef.current?.focus();
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const handleGlobalKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', handleGlobalKeyDown, true);
    return () => window.removeEventListener('keydown', handleGlobalKeyDown, true);
  }, [isOpen, onClose]);

  const result: SearchResult = useMemo(
    () =>
      searchEverything({
        state,
        vaultDocs: docs,
        query,
        kinds: activeKind === 'all' ? undefined : [activeKind],
        // A single-category view is a deliberate "show me more of this", so it gets a
        // bigger page than the mixed view's 5-per-kind preview.
        limits: activeKind === 'all' ? undefined : { [activeKind]: 50 }
      }),
    [state, docs, query, activeKind]
  );

  /** Flat list in render order, so arrow keys and Enter agree with what is visible. */
  const visibleHits = useMemo(() => result.groups.flatMap((group) => group.hits), [result]);
  const totalForKind = useMemo(() => {
    const map = new Map<SearchKind, number>();
    for (const group of result.groups) map.set(group.kind, group.total);
    return map;
  }, [result]);

  if (!isOpen) return null;

  const activate = (hit: SearchHit) => {
    if (hit.kind === 'secret') {
      const secret = hit.entity as SecretItem | undefined;
      if (!secret) return;
      if (!masterPassword) {
        onRequireUnlock?.();
        return;
      }
      onCopySecret?.(secret);
      onClose();
      return;
    }
    onOpenResult(hit);
    onClose();
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setSelectedIndex((prev) => (prev + 1) % Math.max(1, visibleHits.length));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setSelectedIndex((prev) => (prev - 1 + visibleHits.length) % Math.max(1, visibleHits.length));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const hit = visibleHits[selectedIndex];
      if (hit) activate(hit);
    } else if (event.key === 'Tab') {
      // 最小焦点陷阱：Tab 在面板内循环（输入框 ↔ 关闭/筛选按钮），不再走到
      // 被遮罩盖住的底层页面。
      const panel = panelRef.current;
      if (!panel) return;
      const focusables = Array.from(
        panel.querySelectorAll<HTMLElement>('input, button:not([disabled])')
      ).filter((el) => el.offsetParent !== null);
      if (focusables.length === 0) return;
      event.preventDefault();
      const current = focusables.indexOf(document.activeElement as HTMLElement);
      const next = event.shiftKey
        ? (current <= 0 ? focusables.length - 1 : current - 1)
        : (current === -1 || current === focusables.length - 1 ? 0 : current + 1);
      focusables[next].focus();
    }
  };

  const chips: Array<{ id: 'all' | SearchKind; label: string; count: number }> = [
    { id: 'all', label: '全部', count: result.total },
    ...result.groups.map((group) => ({ id: group.kind, label: group.label, count: group.total }))
  ];

  let runningIndex = -1;

  return (
    <div
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="全局搜索"
      className="fixed inset-0 z-50 flex items-start justify-center pt-14 sm:pt-20 p-3 sm:p-4 bg-[var(--sh-overlay)] backdrop-blur-sm animate-in fade-in"
    >
      <div
        ref={panelRef}
        onClick={(event) => event.stopPropagation()}
        className="w-full max-w-2xl bg-sh-surface border border-sh-line rounded-2xl shadow-2xl overflow-hidden flex flex-col"
      >
        <div className="flex items-center gap-3 px-4 py-3.5 border-b border-sh-line">
          <Search className="w-4 h-4 text-sh-muted shrink-0" />
          <input
            ref={inputRef}
            type="text"
            autoFocus
            role="combobox"
            aria-expanded="true"
            aria-controls="global-search-listbox"
            aria-activedescendant={
              query.trim() !== '' && visibleHits.length > 0 ? `search-option-${selectedIndex}` : undefined
            }
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setSelectedIndex(0);
            }}
            onKeyDown={handleKeyDown}
            placeholder="搜索笔记、批注、收藏、服务器、提醒、项目、收件箱…（支持拼音首字母）"
            aria-label="搜索全部数据"
            data-testid="global-search-input"
            className="w-full bg-transparent text-xs sm:text-sm text-sh-fg placeholder:text-sh-subtle focus:outline-none"
          />
          <div className="flex items-center gap-1.5 shrink-0">
            <kbd className="hidden sm:inline-block px-1.5 py-0.5 text-[10px] font-mono bg-sh-surface2 text-sh-muted rounded border border-sh-line-strong">
              ESC
            </kbd>
            <button onClick={onClose} aria-label="关闭搜索" className="p-1 rounded-lg hover:bg-sh-surface2 text-sh-muted hover:text-sh-fg">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {chips.length > 1 && (
          <div className="flex items-center gap-1 px-3 py-1.5 bg-sh-surface2 border-b border-sh-line text-[11px] overflow-x-auto">
            {chips.map((chip) => (
              <button
                key={chip.id}
                onClick={() => {
                  setActiveKind(chip.id);
                  setSelectedIndex(0);
                }}
                data-search-chip={chip.id}
                data-active={activeKind === chip.id ? 'true' : 'false'}
                className={`px-2.5 py-1 rounded-md transition-colors ${
                  activeKind === chip.id ? 'bg-sh-surface2 text-sh-accent-fg font-semibold' : 'text-sh-muted hover:text-sh-fg'
                }`}
              >
                {chip.label} ({chip.count})
              </button>
            ))}
          </div>
        )}

        <div ref={listRef} id="global-search-listbox" role="listbox" aria-label="搜索结果" className="p-2 max-h-[60vh] overflow-y-auto space-y-1" data-testid="global-search-results">
          {query.trim() === '' ? (
            <div className="p-6 text-center text-xs text-sh-subtle">
              输入关键词开始搜索。批注的原文与你的批注、笔记正文都会被检索；金库只匹配名称，明文不参与搜索。
            </div>
          ) : result.total === 0 ? (
            <div className="p-6 text-center text-xs text-sh-subtle space-y-1">
              <div>没有匹配「{query.trim()}」的结果。</div>
              <div className="text-[10px] text-sh-subtle" data-testid="search-coverage-empty">
                {result.coverage.skipped.join(' ')}
              </div>
            </div>
          ) : (
            result.groups.map((group) => (
              <div key={group.kind} data-search-group={group.kind}>
                <div className="flex items-center justify-between px-2 pt-2 pb-1 text-[10px] text-sh-subtle font-mono">
                  <span>
                    {group.label} · {group.total}
                  </span>
                  {group.total > group.hits.length && (
                    <span data-search-more={group.kind}>还有 {group.total - group.hits.length} 条，可切换到这个分类查看</span>
                  )}
                </div>
                {group.hits.map((hit) => {
                  runningIndex += 1;
                  const index = runningIndex;
                  const isSelected = index === selectedIndex;
                  return (
                    <div
                      key={`${hit.kind}-${hit.id}`}
                      id={`search-option-${index}`}
                      onClick={() => activate(hit)}
                      onMouseEnter={() => setSelectedIndex(index)}
                      data-search-hit={hit.kind}
                      data-search-id={hit.id}
                      data-search-selected={isSelected ? 'true' : undefined}
                      role="option"
                      aria-selected={isSelected}
                      className={`flex items-center justify-between p-2.5 rounded-xl text-xs cursor-pointer transition-colors ${
                        isSelected ? 'bg-sh-surface2 text-sh-accent-fg' : 'text-sh-muted hover:bg-sh-surface2'
                      }`}
                    >
                      <div className="flex items-center gap-3 min-w-0 flex-1">
                        <div className="w-6 h-6 rounded-md bg-sh-surface2 border border-sh-line flex items-center justify-center shrink-0">
                          {KIND_ICONS[hit.kind]}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="font-semibold truncate">{hit.title}</div>
                          <Snippet hit={hit} />
                        </div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0 ml-2">
                        {hit.meta && (
                          <span className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-sh-surface2 text-sh-muted border border-sh-line">
                            {hit.meta}
                          </span>
                        )}
                        {isSelected && <ArrowRight className="w-3.5 h-3.5 text-sh-muted" />}
                      </div>
                    </div>
                  );
                })}
              </div>
            ))
          )}
        </div>

        <div className="px-4 py-2 border-t border-sh-line bg-sh-surface2 text-[10px] text-sh-subtle font-mono space-y-1">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <span>↑↓ 切换</span>
              <span>Enter 打开</span>
              <span>ESC 关闭</span>
            </div>
            <span>已匹配 {result.total} 条</span>
          </div>
          {result.coverage.skipped.length > 0 && (
            <div className="text-sh-subtle" data-testid="search-coverage">
              未覆盖：{result.coverage.skipped.join(' ')}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default GlobalSearch;
