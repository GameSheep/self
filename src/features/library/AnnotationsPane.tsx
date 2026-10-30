import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Download, ExternalLink, Highlighter, Pencil, Search, Trash2 } from 'lucide-react';
import type { WebPageAnnotation } from '../../types';
import { EmptyState, PageHeader, inputClass } from '../../shared/ui';
import { isExtensionContext, type AnnotationSyncResult } from '../../lib/extensionBridge';

export interface AnnotationsPaneProps {
  annotations: WebPageAnnotation[];
  onUpdate: (annotation: WebPageAnnotation) => void;
  onDelete: (id: string) => void;
  /**
   * Manual 「从扩展同步」 pass, wired from the app shell.
   *
   * The boot import / broadcast listener cover the happy path automatically; this
   * is the diagnostic escape hatch: its result line says whether the extension
   * answered, how many annotations it holds, and how many were new — so an empty
   * pane is attributable (old build not reloaded / wrong origin / nothing saved).
   */
  onSyncFromExtension?: () => Promise<AnnotationSyncResult>;
}

/**
 * Highlight colors, matching the 划词 toolbar's palette
 * (extension/content.js COLORS). Each annotation carries the color the user
 * picked on the page; the card shows it as the left rail + the 原文 block's
 * marker background, so scanning the list reads like scanning a highlighted
 * page. Hex values (not Tailwind classes) because the same value feeds both a
 * style border and an inline background with alpha.
 */
const ANNOTATION_COLORS: Record<WebPageAnnotation['color'], string> = {
  yellow: '#eab308',
  green: '#22c55e',
  blue: '#3b82f6',
  purple: '#a855f7',
  red: '#ef4444'
};

/** Small section label distinguishing 划词原文 from 我的批注. */
const chipClass = 'text-[10px] font-medium text-sh-subtle tracking-wide';

/**
 * 网页批注 (3.3) — a viewing window, not an editor.
 *
 * The user's words: 「这里只是展示窗口，划词肯定是我从其他网站划词存过来，这里只要修改删除，
 * 能够原始链接就行」. So: the highlight text and my own note are shown as text, the page opens
 * from its original link, and the only actions are edit and delete. There is no 「新建」, no
 * type/source/project filtering, and no "search coverage" paragraph.
 */
export const AnnotationsPane: React.FC<AnnotationsPaneProps> = ({ annotations, onUpdate, onDelete, onSyncFromExtension }) => {
  const sorted = useMemo(
    () => [...annotations].sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0)),
    [annotations]
  );
  const [query, setQuery] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftNote, setDraftNote] = useState('');
  /** Bounded first render: a few thousand annotations must not paint a few thousand cards. */
  const [visibleCount, setVisibleCount] = useState(100);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<AnnotationSyncResult | null>(null);
  /**
   * One-shot probe on mount, so the diagnosis needs no click.
   *
   * The boot import already pulls the rows in; what it never did was *say*
   * anything when the pane stayed empty. The probe's result line names the
   * failure (extension unanswered → stale build / wrong origin / empty vault)
   * right where the user is looking. Rendered only when it has something to
   * say — a connected extension with everything already imported stays silent.
   */
  const [probe, setProbe] = useState<AnnotationSyncResult | null>(null);
  const probeRanRef = useRef(false);
  useEffect(() => {
    if (probeRanRef.current || !onSyncFromExtension || !isExtensionContext()) return;
    probeRanRef.current = true;
    onSyncFromExtension()
      .then(setProbe)
      .catch(() => setProbe({ ok: false, message: '同步探测失败，请点「从扩展同步」重试。' }));
  }, [onSyncFromExtension]);

  const runSync = async () => {
    if (!onSyncFromExtension || syncing) return;
    setSyncing(true);
    setSyncResult(null);
    try {
      setSyncResult(await onSyncFromExtension());
    } finally {
      setSyncing(false);
    }
  };

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return sorted;
    return sorted.filter((item) =>
      `${item.pageTitle} ${item.pageUrl} ${item.text} ${item.note || ''} ${(item.tags || []).join(' ')}`
        .toLowerCase()
        .includes(needle)
    );
  }, [sorted, query]);

  const page = visible.slice(0, visibleCount);

  return (
    <div data-testid="annotations-pane">
      <PageHeader
        title="网页批注"
        description="从别的网页划词存进来的内容。这里只看、只改、只删；新建在划词工具那边。"
      />

      <div className="flex items-center gap-2 mb-3">
        <label className="relative block max-w-xs flex-1">
          <span className="sr-only">搜索批注</span>
          <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-sh-subtle" aria-hidden />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索页面标题、原文或我的批注"
            data-testid="annotations-search"
            className={`${inputClass} pl-8`}
          />
        </label>
        <span className="text-[11px] text-sh-subtle" data-testid="annotations-count">
          共 {sorted.length} 条
        </span>
        {onSyncFromExtension && (
          <button
            onClick={() => void runSync()}
            disabled={syncing}
            data-testid="annotations-sync-extension"
            title="把扩展里保存的批注拉到工作台，并报告同步结果"
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-sh-line text-[11px] text-sh-muted hover:text-sh-fg hover:border-sh-line-strong disabled:opacity-60 shrink-0"
          >
            <Download className={`w-3.5 h-3.5 ${syncing ? 'animate-bounce' : ''}`} aria-hidden />
            {syncing ? '同步中…' : '从扩展同步'}
          </button>
        )}
      </div>

      {probe && (
        <p
          data-testid="annotations-probe-result"
          className={`mb-3 text-[11px] rounded-lg border px-3 py-2 ${
            probe.ok ? 'border-sh-line bg-sh-surface2 text-sh-muted' : 'border-sh-danger/40 bg-sh-danger/10 text-sh-fg'
          }`}
          role="status"
        >
          {probe.message}
        </p>
      )}

      {syncResult && (
        <p
          data-testid="annotations-sync-result"
          className={`mb-3 text-[11px] rounded-lg border px-3 py-2 ${
            syncResult.ok
              ? 'border-sh-line bg-sh-surface2 text-sh-muted'
              : 'border-sh-danger/40 bg-sh-danger/10 text-sh-fg'
          }`}
          role="status"
        >
          {syncResult.message}
        </p>
      )}

      {sorted.length === 0 ? (
        <EmptyState
          icon={<Highlighter className="w-5 h-5" />}
          title="还没有网页批注"
          description="在网页上用划词工具保存后，会出现在这里。如果已经划词保存过，点右上角「从扩展同步」把它拉进来。"
        />
      ) : visible.length === 0 ? (
        <EmptyState title="没有匹配的批注" description="换个关键字试试。" />
      ) : (
        <ul className="space-y-2" data-testid="annotations-list">
          {page.map((item) => (
            <li
              key={item.id}
              data-annotation-id={item.id}
              className="rounded-xl border border-sh-line bg-sh-surface p-3 space-y-2 overflow-hidden"
              style={{ borderLeft: `3px solid ${ANNOTATION_COLORS[item.color] ?? ANNOTATION_COLORS.yellow}` }}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <h3 className="text-xs font-semibold text-sh-fg truncate" title={item.pageTitle}>
                    {item.pageTitle || item.pageUrl}
                  </h3>
                  {item.pageUrl && (
                    <a
                      href={item.pageUrl}
                      target="_blank"
                      rel="noreferrer"
                      data-testid={`annotation-link-${item.id}`}
                      className="inline-flex items-center gap-1 text-[11px] text-sh-info hover:underline truncate max-w-full"
                    >
                      <ExternalLink className="w-3 h-3 shrink-0" aria-hidden />
                      {item.pageUrl}
                    </a>
                  )}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    onClick={() => {
                      setEditingId(item.id);
                      setDraftNote(item.note ?? '');
                    }}
                    data-testid={`annotation-edit-${item.id}`}
                    aria-label="编辑批注"
                    className="p-1.5 rounded-lg border border-sh-line text-sh-muted hover:text-sh-fg"
                  >
                    <Pencil className="w-3.5 h-3.5" aria-hidden />
                  </button>
                  <button
                    onClick={() => onDelete(item.id)}
                    data-testid={`annotation-delete-${item.id}`}
                    aria-label="删除批注"
                    className="p-1.5 rounded-lg border border-sh-line text-sh-danger hover:bg-sh-danger/10"
                  >
                    <Trash2 className="w-3.5 h-3.5" aria-hidden />
                  </button>
                </div>
              </div>

              {/* 划词原文：荧光笔样式——左色条 + 同色浅底 + 正文字号，和网页上的高亮一致。 */}
              <div>
                <span className={`${chipClass} block mb-0.5`}>原文</span>
                <blockquote
                  className="rounded-r-md px-2.5 py-1.5 text-xs text-sh-fg leading-relaxed break-words"
                  style={{
                    backgroundColor: `${ANNOTATION_COLORS[item.color] ?? ANNOTATION_COLORS.yellow}1f`,
                    borderLeft: `2px solid ${ANNOTATION_COLORS[item.color] ?? ANNOTATION_COLORS.yellow}`
                  }}
                >
                  {item.text}
                </blockquote>
              </div>

              {editingId === item.id ? (
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    onUpdate({ ...item, note: draftNote, updatedAt: Date.now() });
                    setEditingId(null);
                  }}
                  className="space-y-1.5"
                  data-testid={`annotation-editor-${item.id}`}
                >
                  <textarea
                    value={draftNote}
                    onChange={(e) => setDraftNote(e.target.value)}
                    rows={2}
                    aria-label="我的批注"
                    className="w-full bg-sh-surface2 border border-sh-line rounded-lg px-2 py-1.5 text-[11px] text-sh-fg"
                  />
                  <div className="flex items-center gap-1.5">
                    <button type="submit" className="px-2 py-1 rounded bg-sh-accent text-sh-accent-fg text-[11px] font-semibold">
                      保存
                    </button>
                    <button type="button" onClick={() => setEditingId(null)} className="px-2 py-1 rounded border border-sh-line text-[11px]">
                      取消
                    </button>
                  </div>
                </form>
              ) : (
                item.note && (
                  /* 我的批注：独立底色块 + 标签，与荧光原文一眼可分。 */
                  <div>
                    <span className={`${chipClass} block mb-0.5`}>我的批注</span>
                    <div className="rounded-lg bg-sh-surface2 border border-sh-line px-2.5 py-1.5 text-xs text-sh-fg leading-relaxed whitespace-pre-wrap break-words">
                      {item.note}
                    </div>
                  </div>
                )
              )}

              <p className="text-[10px] text-sh-subtle">
                {new Date(item.updatedAt || item.createdAt || Date.now()).toLocaleString()}
              </p>
            </li>
          ))}
        </ul>
      )}

      {visible.length > page.length && (
        <div className="mt-3 flex items-center gap-2">
          <span className="text-[11px] text-sh-subtle" data-testid="annotations-remaining">
            还有 {visible.length - page.length} 条
          </span>
          <button
            onClick={() => setVisibleCount((count) => count + 100)}
            data-testid="annotations-show-more"
            className="px-3 py-1.5 rounded-lg border border-sh-line text-[11px] text-sh-muted hover:text-sh-fg"
          >
            显示更多 100 条
          </button>
        </div>
      )}
    </div>
  );
};

export default AnnotationsPane;
