import React from 'react';
import { FileText, Hash, Link2, Search } from 'lucide-react';
import type { SearchHit } from '../lib/vaultIndex';

interface VaultSearchResultsProps {
  hits: SearchHit[];
  query: string;
  loading?: boolean;
  onOpen: (key: string) => void;
  /** Shown when the index is empty so the user knows what to do. */
  indexEmpty?: boolean;
  onCreateIndex?: () => void;
  totalNoteCount?: number;
}

const FIELD_META: Record<SearchHit['field'], { label: string; icon: React.ReactNode; className: string }> = {
  title: { label: '标题', icon: <FileText className="w-3 h-3" />, className: 'text-purple-300 bg-purple-950/50 border-purple-800/60' },
  content: { label: '正文', icon: <Search className="w-3 h-3" />, className: 'text-sky-300 bg-sky-950/50 border-sky-800/60' },
  tag: { label: '标签', icon: <Hash className="w-3 h-3" />, className: 'text-cyan-300 bg-cyan-950/50 border-cyan-800/60' },
  link: { label: '链接', icon: <Link2 className="w-3 h-3" />, className: 'text-amber-300 bg-amber-950/50 border-amber-800/60' }
};

/** Highlight the matched span inside a snippet. */
export function Highlighted({ text, index, length }: { text: string; index: number; length: number }) {
  if (index < 0 || index >= text.length || length <= 0) return <>{text}</>;
  const end = Math.min(text.length, index + length);
  return (
    <>
      {text.slice(0, index)}
      <mark className="bg-amber-400/30 text-amber-100 rounded px-0.5">{text.slice(index, end)}</mark>
      {text.slice(end)}
    </>
  );
}

/**
 * Full-text search results over the local vault index.
 * Kept separate from DataInteropView so the view file does not grow further.
 */
export const VaultSearchResults: React.FC<VaultSearchResultsProps> = ({
  hits,
  query,
  loading,
  onOpen,
  indexEmpty,
  onCreateIndex,
  totalNoteCount
}) => {
  if (indexEmpty) {
    return (
      <div className="py-8 px-3 text-center text-[11px] text-zinc-500 leading-relaxed">
        <p className="mb-2 text-zinc-400">还没有全文索引，无法搜索笔记正文</p>
        <p className="mb-3">
          全文搜索会把每篇笔记的正文缓存在本机 IndexedDB（约 {totalNoteCount || '若干'} 篇，首次需要一点时间），
          之后可按内容、标签、双链检索。
        </p>
        {onCreateIndex && (
          <button
            type="button"
            onClick={onCreateIndex}
            className="px-3 py-1.5 rounded-lg bg-sky-600 hover:bg-sky-500 text-white text-[11px] font-semibold"
          >
            建立全文索引
          </button>
        )}
      </div>
    );
  }

  if (hits.length === 0) {
    return (
      <div className="py-10 text-center text-xs text-zinc-500">
        {loading ? '搜索中…' : `没有匹配「${query}」的内容`}
      </div>
    );
  }

  return (
    <div className="space-y-0.5" data-testid="vault-search-results">
      {hits.map((hit) => {
        const meta = FIELD_META[hit.field];
        return (
          <button
            key={`${hit.field}:${hit.key}`}
            type="button"
            data-oss-hit={hit.key}
            onClick={() => onOpen(hit.key)}
            className="w-full text-left px-2 py-1.5 rounded-lg hover:bg-zinc-800/70 transition-colors"
            title={hit.key}
          >
            <div className="flex items-center gap-1.5 min-w-0">
              <span className={`shrink-0 inline-flex items-center gap-0.5 px-1 py-0 rounded border text-[9px] ${meta.className}`}>
                {meta.icon}
                {meta.label}
              </span>
              <span className="text-xs text-zinc-200 truncate">{hit.title}</span>
            </div>
            <div className="mt-0.5 text-[11px] text-zinc-500 leading-snug line-clamp-2 break-all">
              <Highlighted text={hit.snippet} index={hit.matchIndex} length={hit.matchLength} />
            </div>
          </button>
        );
      })}
    </div>
  );
};

export default VaultSearchResults;
