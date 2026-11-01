import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Download, Highlighter, Pencil, Search, Trash2 } from 'lucide-react';
import type { WebPageAnnotation } from '../../types';
import { ConfirmButton, EmptyState, PageHeader, inputClass } from '../../shared/ui';
import { isExtensionContext, type AnnotationSyncResult } from '../../lib/extensionBridge';
import { useDeferredSearch } from '../../shared/ui';

export interface AnnotationsPaneProps {
  annotations: WebPageAnnotation[];
  onUpdate: (annotation: WebPageAnnotation) => void;
  onDelete: (id: string) => void;
/**
 * Manual 「从扩展同步」 pass, wired from the app shell.
 * The boot import / broadcast listener cover the happy path automatically; this
 */
  onSyncFromExtension?: () => Promise<AnnotationSyncResult>;
}

/**
 * Highlight colors, matching the 划词 toolbar's palette
 * (extension/content.js COLORS). Each annotation carries the color the user
 * picked on the page; the card shows it as the left rail + the 原文 block's
 */
const ANNOTATION_COLORS: Record<WebPageAnnotation['color'], string> = {
  yellow: '#eab308',
  green: '#22c55e',
  blue: '#3b82f6',
  purple: '#a855f7',
  red: '#ef4444'
};

/** Small section label distinguishing 划词原文 from 我的批注. */
const chipClass = 'text-[10px] font-medium text-sh-subtle tracking-wide shrink-0';

/**
 * 页面标识用域名而不是标题：标题经常很长（「XX - 知乎」「Untitled」），
 * 截断后反而认不出来；域名短、稳定，一眼能分辨来源站。完整标题和链接放在
 * `title` 上，鼠标停一下就全都有。
 */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url.replace(/^https?:\/\//, '').split('/')[0] || url;
  }
}

/**
 * 列表里的时间只用来排序定位，不承担"几点几分"的精确性 —— 今天给时间、
 * 今年给月日、更早给年月，宽度基本恒定，列不会因为日期长短而跳动。
 */
function timeLabel(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}/${d.getDate()}`;
  return `${d.getFullYear()}/${d.getMonth() + 1}`;
}

/**
 * 网页批注 (3.3) — a viewing window, not an editor.
 * The user's words: 「这里只是展示窗口，划词肯定是我从其他网站划词存过来，这里只要修改删除，
 */
export const AnnotationsPane: React.FC<AnnotationsPaneProps> = ({ annotations, onUpdate, onDelete, onSyncFromExtension }) => {
  const sorted = useMemo(
    () => [...annotations].sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0)),
    [annotations]
  );
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredSearch(query);
  /** 域名 facet：划词常集中在少数几个站，「只看这个站」是一等需求。 */
  const [domainFilter, setDomainFilter] = useState('');
  const [domainFilterHosts, setDomainFilterHosts] = useState<Set<string> | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftNote, setDraftNote] = useState('');
  /** Bounded first render: a few thousand annotations must not paint a few thousand cards. */
  const [visibleCount, setVisibleCount] = useState(100);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<AnnotationSyncResult | null>(null);
/**
 * One-shot probe on mount, so the diagnosis needs no click.
 * The boot import already pulls the rows in; what it never did was *say*
 * anything when the pane stayed empty. The probe's result line names the
 * · right where the user is looking. Rendered only when it has something to
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
    const needle = deferredQuery.trim().toLowerCase();
    return sorted.filter((item) => {
      if (domainFilterHosts && !domainFilterHosts.has(hostOf(item.pageUrl || ''))) return false;
      if (!needle) return true;
      return `${item.pageTitle} ${item.pageUrl} ${item.text} ${item.note || ''} ${(item.tags || []).join(' ')}`
        .toLowerCase()
        .includes(needle);
    });
  }, [sorted, deferredQuery, domainFilter]);

  /** 按域名聚合计数（降序），超过 6 个只展示前 6 个 + 「其余」归并，防 chip 墙。 */
  const domainFacets = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of sorted) {
      const host = hostOf(item.pageUrl || '');
      counts.set(host, (counts.get(host) ?? 0) + 1);
    }
    const ranked = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
    if (ranked.length <= 7) return ranked.map(([host, count]) => ({ host, count, hosts: [host] }));
    const head = ranked.slice(0, 6).map(([host, count]) => ({ host, count, hosts: [host] }));
    const restHosts = ranked.slice(6).map(([host]) => host);
    head.push({ host: '其他', count: ranked.slice(6).reduce((sum, [, n]) => sum + n, 0), hosts: restHosts });
    return head;
  }, [sorted]);

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

      {sorted.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 mb-3" data-testid="annotations-domain-facets">
          {([{ host: '', count: sorted.length, hosts: [] as string[] }, ...domainFacets] as Array<{
            host: string;
            count: number;
            hosts: string[];
          }>).map(
            (facet) => {
              const active = domainFilter === facet.host;
              return (
                <button
                  key={facet.host || '__all__'}
                  onClick={() => {
                    if (active || !facet.host) { setDomainFilter(''); setDomainFilterHosts(null); }
                    else { setDomainFilter(facet.host); setDomainFilterHosts(new Set(facet.hosts)); }
                  }}
                  data-testid={`annotations-domain-chip-${facet.host || 'all'}`}
                  aria-pressed={active}
                  className={`px-2 py-0.5 rounded-lg text-[11px] border transition-colors ${
                    active ? 'bg-sh-surface2 border-sh-line-strong text-sh-fg' : 'border-sh-line text-sh-muted hover:text-sh-fg'
                  }`}
                >
                  {facet.host || '全部'} ({facet.count})
                </button>
              );
            }
          )}
        </div>
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
        <ul className="divide-y divide-sh-line border-y border-sh-line" data-testid="annotations-list">
          {page.map((item) => {
            const tint = ANNOTATION_COLORS[item.color] ?? ANNOTATION_COLORS.yellow;
            const editing = editingId === item.id;
            return (
              <li
                key={item.id}
                data-annotation-id={item.id}
                data-testid="annotation-row"
                className="group flex flex-wrap items-start gap-x-3 gap-y-1 py-1.5 pr-3 transition-colors hover:bg-sh-surface2/50"
                style={{ borderLeft: `3px solid ${tint}`, paddingLeft: 10 }}
              >
                {/* 原文是这一行的主信息，所以只有它带荧光底色；页面来源退到右侧
                    的小字域名 —— 长标题会把半行吃掉，而且截断后反而认不出来。 */}
                <div className="min-w-0 flex-1 basis-40" data-testid="annotation-row-text">
                  {/* `w-fit` 而不是铺满：底色只包住文字本身，短句不会拖出一条横贯整行的
                      色带 —— 看着才像网页上的荧光笔，而不是表格斑马纹。用 `block w-fit`
                      而非 `inline-block`：行内块会多出一个行盒的下沉空间，每行白长 4px。 */}
                  <p
                    className="block w-fit max-w-full truncate rounded-sm px-1.5 text-xs leading-5 text-sh-fg"
                    style={{ backgroundColor: `${tint}1f` }}
                    title={item.text}
                  >
                    {item.text}
                  </p>

                  {editing ? (
                    <form
                      onSubmit={(event) => {
                        event.preventDefault();
                        onUpdate({ ...item, note: draftNote, updatedAt: Date.now() });
                        setEditingId(null);
                      }}
                      className="mt-1 space-y-1"
                      data-testid={`annotation-editor-${item.id}`}
                    >
                      <textarea
                        value={draftNote}
                        onChange={(e) => setDraftNote(e.target.value)}
                        rows={2}
                        autoFocus
                        aria-label="我的批注"
                        className="w-full bg-sh-surface2 border border-sh-line rounded-lg px-2 py-1.5 text-[11px] text-sh-fg"
                      />
                      <div className="flex items-center gap-1.5">
                        <button
                          type="submit"
                          className="px-2 py-1 rounded bg-sh-accent text-sh-accent-fg text-[11px] font-semibold"
                        >
                          保存
                        </button>
                        <button
                          type="button"
                          onClick={() => setEditingId(null)}
                          className="px-2 py-1 rounded border border-sh-line text-[11px]"
                        >
                          取消
                        </button>
                      </div>
                    </form>
                  ) : (
                    item.note && (
                      <div className="mt-0.5 flex min-w-0 items-baseline gap-1.5">
                        <span className={chipClass}>批注</span>
                        <span className="truncate text-[11px] leading-4 text-sh-muted" title={item.note}>
                          {item.note}
                        </span>
                      </div>
                    )
                  )}
                </div>

                {item.pageUrl && (
                  <a
                    href={item.pageUrl}
                    target="_blank"
                    rel="noreferrer"
                    data-testid={`annotation-link-${item.id}`}
                    title={item.pageTitle ? `${item.pageTitle}\n${item.pageUrl}` : item.pageUrl}
                    className="max-w-[9rem] shrink-0 self-center truncate text-[10px] font-mono text-sh-subtle hover:text-sh-info hover:underline"
                  >
                    {hostOf(item.pageUrl)}
                  </a>
                )}

                <span
                  className="shrink-0 self-center text-[10px] font-mono tabular-nums text-sh-subtle"
                  title={new Date(item.updatedAt || item.createdAt || Date.now()).toLocaleString()}
                >
                  {timeLabel(item.updatedAt || item.createdAt || Date.now())}
                </span>

                {/* 悬停才浮现；`lg:` 以下常显并折到下一行，否则窄屏上会把原文压成两三个字。 */}
                <div
                  data-testid="annotation-row-actions"
                  className="flex w-full shrink-0 items-center justify-end gap-1 transition-opacity max-lg:opacity-100 lg:w-auto lg:opacity-0 lg:group-hover:opacity-100 lg:group-focus-within:opacity-100"
                >
                  <button
                    onClick={() => {
                      setEditingId(item.id);
                      setDraftNote(item.note ?? '');
                    }}
                    data-testid={`annotation-edit-${item.id}`}
                    aria-label="编辑批注"
                    title="编辑我的批注"
                    className="p-1 rounded-lg border border-sh-line text-sh-muted hover:text-sh-fg"
                  >
                    <Pencil className="w-3.5 h-3.5" aria-hidden />
                  </button>
                  <ConfirmButton
                    onConfirm={() => onDelete(item.id)}
                    confirmLabel="确认删除？"
                    confirmDetail={(item.text || '').slice(0, 30)}
                    data-testid={`annotation-delete-${item.id}`}
                    className="p-1 rounded-lg border border-sh-line text-sh-danger hover:bg-sh-danger/10"
                    aria-label="删除批注"
                  >
                    <Trash2 className="w-3.5 h-3.5" aria-hidden />
                  </ConfirmButton>
                </div>
              </li>
            );
          })}
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
