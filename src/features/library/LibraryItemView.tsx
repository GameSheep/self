import React, { useState } from 'react';
import { AlertTriangle, ArrowLeft, ExternalLink, FileWarning, Pencil } from 'lucide-react';
import type { HubState, NavSite, QuickNote, WebPageAnnotation } from '../../types';
import { NotesView } from '../../components/views/NotesView';
import { ConfirmButton, EmptyState, PageHeader, StatusPill } from '../../shared/ui';
import { Markdown } from '../../components/Markdown';
import { formatRelative } from '../../lib/dates';

export interface LibraryItemViewProps {
  state: HubState;
  /** `kind:nativeId` key from domain/library.ts. */
  itemKey: string;
  onNavigate: (path: string) => void;
  onAddNote: (note: QuickNote) => void;
  onUpdateNote: (note: QuickNote) => void;
  onDeleteNote: (id: string) => void;
  onDeleteHandwriting: (id: string) => void;
  onDeleteSite: (id: string) => void;
  /** 编辑「我的批注」。五彩导入的划词没有本机编辑入口，不传也不报错。 */
  onUpdateAnnotation?: (annotation: WebPageAnnotation) => void;
  onDeleteAnnotation?: (id: string) => void;
}

/**
 * 返回链接必须回到这条资料自己的列表：从批注详情返回落在笔记编辑器，
 * 等于让用户重新找路。
 */
const BACK_ROUTES: Record<string, string> = {
  note: '#/library',
  webpage: '#/library?type=webpage',
  remote: '#/library?view=sources',
  drawing: '#/library',
  bookmark: '#/navigation'
};

function BackLink({ to, onNavigate }: { to: string; onNavigate: (path: string) => void }) {
  return (
    <button
      onClick={() => onNavigate(to)}
      className="inline-flex items-center gap-1.5 text-[11px] text-sh-muted hover:text-sh-fg mb-3"
    >
      <ArrowLeft className="w-3.5 h-3.5" aria-hidden />
      返回资料库
    </button>
  );
}

/**
 * Library item detail (P1-05).
 *
 * Each kind keeps its own presentation, and each one is explicit about what is
 * *not* known:
 * - a note opens the existing Markdown workspace (draft, outline, preview),
 * - an annotation shows the quoted原文 next to the user's own comment, and says
 *   whether a text anchor was recorded at all. An annotation whose anchor cannot
 *   be matched is shown as text rather than being pushed onto a guessed position,
 * - a remote file never renders an empty body as if it had loaded.
 */
export const LibraryItemView: React.FC<LibraryItemViewProps> = ({
  state,
  itemKey,
  onNavigate,
  onAddNote,
  onUpdateNote,
  onDeleteNote,
  onDeleteHandwriting,
  onDeleteSite,
  onUpdateAnnotation,
  onDeleteAnnotation
}) => {
  const [kind, nativeId] = itemKey.split(/:(.+)/) as [string, string];
  const backTo = BACK_ROUTES[kind] ?? '#/library';

  if (kind === 'note') {
    const note = (state.notes || []).find((n) => n.id === nativeId);
    if (!note) {
      return (
        <MissingItem onNavigate={onNavigate} message="这条笔记可能已经被删除。" />
      );
    }
    // Reuse the mature note workspace rather than a second editor: drafts,
    // outline, preview and the unsaved-draft recovery all live there.
    return (
      <div data-testid="library-item-note">
        <BackLink to={backTo} onNavigate={onNavigate} />
        <NotesView
          notes={state.notes || []}
          onAddNote={onAddNote}
          onUpdateNote={onUpdateNote}
          onDeleteNote={onDeleteNote}
          focusNoteId={note.id}
        />
      </div>
    );
  }

  if (kind === 'webpage') {
    const isWucai = nativeId.startsWith('wucai:');
    const id = isWucai ? nativeId.replace(/^wucai:/, '') : nativeId;
    const page = isWucai
      ? null
      : (state.annotations || []).find((a) => a.id === id);
    const highlight = isWucai ? (state.wucaiHighlights || []).find((h) => h.id === id) : null;

    if (!page && !highlight) return <MissingItem onNavigate={onNavigate} message="这条批注可能已经被删除。" />;

    return (
      <WebpageDetail
        /* 换一条批注（含同页兄弟跳转）要重置编辑态，不能让 A 的编辑框带到 B。 */
        key={page?.id ?? highlight?.id ?? nativeId}
        state={state}
        page={page ?? null}
        highlight={highlight ?? null}
        isWucai={isWucai}
        backTo={backTo}
        onNavigate={onNavigate}
        onUpdateAnnotation={onUpdateAnnotation}
        onDeleteAnnotation={onDeleteAnnotation}
      />
    );
  }

  if (kind === 'drawing') {
    const drawing = (state.handwritings || []).find((d) => d.id === nativeId);
    if (!drawing) return <MissingItem onNavigate={onNavigate} message="这张手绘可能已经被删除。" />;
    return (
      <div data-testid="library-item-drawing">
        <BackLink to={backTo} onNavigate={onNavigate} />
        <PageHeader
          title={drawing.title || '未命名手绘'}
          description={`创建于 ${new Date(drawing.createdAt).toLocaleString()}`}
          actions={
            <ConfirmButton
              onConfirm={() => {
                onDeleteHandwriting(drawing.id);
                onNavigate(backTo);
              }}
              confirmLabel="确认删除？"
              className="px-3 py-1.5 rounded-lg border border-sh-danger/50 text-sh-danger text-xs"
              aria-label={`删除手绘 ${drawing.title || '未命名'}`}
            >
              删除
            </ConfirmButton>
          }
        />
        <div className="rounded-2xl border border-sh-line bg-sh-surface p-4">
          <img src={drawing.dataUrl} alt={drawing.title || '手绘'} className="max-w-full rounded-lg border border-sh-line" />
        </div>
      </div>
    );
  }

  if (kind === 'remote') {
    const remote = (state.obsidianNotes || []).find((n) => n.key === nativeId);
    if (!remote) return <MissingItem onNavigate={onNavigate} message="这个远端文件不在当前索引里。" />;
    const cached = typeof remote.content === 'string' && remote.content.length > 0;
    return (
      <div data-testid="library-item-remote">
        <BackLink to={backTo} onNavigate={onNavigate} />
        <PageHeader
          title={remote.title || remote.path || remote.key}
          description={<span className="font-mono text-[11px]">{remote.key}</span>}
          actions={
            <>
              <StatusPill tone="info" label="远端文件" />
              {cached ? <StatusPill tone="ok" label="已缓存正文" /> : <StatusPill tone="warn" label="尚未下载正文" />}
            </>
          }
        />
        {cached ? (
          /* 缓存正文是 Markdown 源码：用渲染器直出，而不是 <pre> 让用户读围栏。 */
          <div className="rounded-2xl border border-sh-line bg-sh-surface p-4">
            <Markdown content={remote.content ?? ''} />
          </div>
        ) : (
          <EmptyState
            icon={<FileWarning className="w-5 h-5" />}
            title="正文还没有下载到本机"
            description="远端文件的事实来源是对象存储。这里不会用空正文冒充加载成功；请在远端笔记库中打开并缓存它。"
            action={
              <button onClick={() => onNavigate('#/library?view=sources')} className="px-3 py-1.5 rounded-lg border border-sh-line text-xs">
                去远端笔记库
              </button>
            }
          />
        )}
      </div>
    );
  }

  if (kind === 'bookmark') {
    const site: NavSite | undefined = (state.sites || []).find((s) => s.id === nativeId);
    if (!site) return <MissingItem onNavigate={onNavigate} message="这个收藏可能已经被删除。" />;
    return (
      <div data-testid="library-item-bookmark">
        <BackLink to={backTo} onNavigate={onNavigate} />
        <PageHeader
          title={site.title}
          description={<span className="font-mono text-[11px]">{site.url}</span>}
          actions={
            <ConfirmButton
              onConfirm={() => {
                onDeleteSite(site.id);
                onNavigate(backTo);
              }}
              confirmLabel="确认删除？"
              className="px-3 py-1.5 rounded-lg border border-sh-danger/50 text-sh-danger text-xs"
              aria-label={`删除收藏 ${site.title}`}
            >
              删除
            </ConfirmButton>
          }
        />
        <div className="rounded-2xl border border-sh-line bg-sh-surface p-4 text-xs text-sh-muted space-y-1">
          <div>分组：{site.category || '未分组'}</div>
          <div>访问次数：{site.visitCount || 0}</div>
          <div>最近访问：{site.lastVisited ? new Date(site.lastVisited).toLocaleString() : '从未'}</div>
          {site.description && <div>备注：{site.description}</div>}
        </div>
      </div>
    );
  }

  return <MissingItem onNavigate={onNavigate} message="资料类型无法识别。" />;
};

/**
 * 批注详情的读改删。用户的原话契约（AnnotationsPane 注释里引用）：
 * 「这里只要修改删除，能够原始链接就行」——旧详情页只有第三件。
 * 编辑/删除只对本机批注开放；五彩导入的划词是外部数据，只展示。
 */
const WebpageDetail: React.FC<{
  state: HubState;
  page: WebPageAnnotation | null;
  highlight: NonNullable<HubState['wucaiHighlights']>[number] | null;
  isWucai: boolean;
  backTo: string;
  onNavigate: (path: string) => void;
  onUpdateAnnotation?: (annotation: WebPageAnnotation) => void;
  onDeleteAnnotation?: (id: string) => void;
}> = ({ state, page, highlight, isWucai, backTo, onNavigate, onUpdateAnnotation, onDeleteAnnotation }) => {
  const [editing, setEditing] = useState(false);
  const [draftNote, setDraftNote] = useState('');

  const title = page?.pageTitle || highlight?.pageTitle || '网页批注';
  const url = page?.pageUrl || highlight?.pageUrl || '';
  const quote = page?.text || highlight?.text || '';
  const comment = page?.note || highlight?.note || '';
  const createdAt = page?.createdAt || highlight?.createdAt || 0;
  const hasAnchor = Boolean(page?.anchor && (page.anchor.prefix || page.anchor.suffix || page.anchor.startOffset !== undefined));

  // Group every annotation on the same page so one page is one reading surface.
  const siblings = (state.annotations || []).filter((a) => a.pageUrl === url);

  const saveNote = () => {
    if (!page || !onUpdateAnnotation) return;
    onUpdateAnnotation({ ...page, note: draftNote, updatedAt: Date.now() });
    setEditing(false);
  };

  return (
    <div data-testid="library-item-webpage">
      <BackLink to={backTo} onNavigate={onNavigate} />
      <PageHeader
        title={title}
        description={
          url ? (
            <a href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sh-info hover:underline">
              打开来源页面 <ExternalLink className="w-3 h-3" aria-hidden />
            </a>
          ) : (
            '未记录来源地址'
          )
        }
        actions={
          <>
            <StatusPill tone="neutral" label={isWucai ? '五彩导入' : '网页采集'} />
            {hasAnchor ? (
              <StatusPill tone="ok" label="已记录定位信息" />
            ) : (
              <StatusPill tone="warn" label="无定位信息，按原文保留" />
            )}
            {page && onUpdateAnnotation && (
              <button
                onClick={() => {
                  setDraftNote(page.note ?? '');
                  setEditing(true);
                }}
                data-testid="annotation-detail-edit"
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-sh-line text-[11px] text-sh-muted hover:text-sh-fg"
              >
                <Pencil className="w-3 h-3" aria-hidden />
                编辑批注
              </button>
            )}
            {page && onDeleteAnnotation && (
              <ConfirmButton
                onConfirm={() => {
                  onDeleteAnnotation(page.id);
                  onNavigate(backTo);
                }}
                confirmLabel="确认删除？"
                data-testid="annotation-detail-delete"
                className="px-2.5 py-1 rounded-lg border border-sh-line text-[11px] text-sh-danger hover:bg-sh-danger/10"
                aria-label="删除这条批注"
              >
                删除
              </ConfirmButton>
            )}
          </>
        }
      />

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_240px] gap-4">
        <div className="space-y-3">
          <section className="rounded-2xl border border-sh-line bg-sh-surface p-4">
            <h2 className="text-sm font-semibold text-sh-fg mb-2">划线原文</h2>
            <blockquote className="border-l-2 border-sh-line-strong pl-3 text-xs text-sh-muted leading-relaxed whitespace-pre-wrap">
              {quote || '（没有保存原文）'}
            </blockquote>
          </section>
          <section className="rounded-2xl border border-sh-line bg-sh-surface p-4">
            <h2 className="text-sm font-semibold text-sh-fg mb-2">我的批注</h2>
            {editing ? (
              <div className="space-y-2" data-testid="annotation-detail-editor">
                <textarea
                  value={draftNote}
                  onChange={(e) => setDraftNote(e.target.value)}
                  rows={4}
                  autoFocus
                  aria-label="我的批注"
                  className="w-full bg-sh-surface2 border border-sh-line rounded-lg px-2 py-1.5 text-xs text-sh-fg"
                />
                <div className="flex items-center gap-1.5">
                  <button
                    onClick={saveNote}
                    data-testid="annotation-detail-save"
                    className="px-2.5 py-1 rounded bg-sh-accent text-sh-accent-fg text-[11px] font-semibold"
                  >
                    保存
                  </button>
                  <button
                    onClick={() => setEditing(false)}
                    className="px-2.5 py-1 rounded border border-sh-line text-[11px]"
                  >
                    取消
                  </button>
                </div>
              </div>
            ) : (
              <p className="text-xs text-sh-muted leading-relaxed whitespace-pre-wrap">{comment || '（没有批注，只有划线）'}</p>
            )}
          </section>
          {(page?.tags?.length || highlight?.tags?.length) ? (
            <div className="flex flex-wrap items-center gap-1.5">
              {(page?.tags || highlight?.tags || []).map((t) => (
                <span key={t} className="text-[10px] px-1.5 py-0.5 rounded border border-sh-line text-sh-muted">
                  {t}
                </span>
              ))}
            </div>
          ) : null}
        </div>

        <aside className="space-y-3">
          <div className="rounded-2xl border border-sh-line bg-sh-surface p-3 text-[11px] text-sh-muted space-y-1">
            <div className="font-semibold text-sh-fg text-xs">记录信息</div>
            <div>采集时间：{createdAt ? new Date(createdAt).toLocaleString() : '未知'}</div>
            <div>更新时间：{formatRelative(page?.updatedAt || highlight?.updatedAt || createdAt)}</div>
            {page?.projectId && <div>关联项目：{state.projects?.find((p) => p.id === page.projectId)?.name || page.projectId}</div>}
          </div>
          <div className="rounded-2xl border border-sh-line bg-sh-surface p-3">
            <div className="font-semibold text-sh-fg text-xs mb-1">同一网页的其他批注</div>
            {siblings.length <= 1 ? (
              <p className="text-[11px] text-sh-subtle">这条网页目前只有一条批注。</p>
            ) : (
              <ul className="space-y-1">
                {siblings
                  .filter((a) => a.id !== page?.id)
                  .map((a) => (
                    <li key={a.id}>
                      <button
                        onClick={() => onNavigate(`#/library/item/${encodeURIComponent(`webpage:${a.id}`)}`)}
                        className="w-full text-left text-[11px] text-sh-muted hover:text-sh-fg truncate"
                      >
                        {a.text.slice(0, 40) || '（空）'}
                      </button>
                    </li>
                  ))}
              </ul>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
};

function MissingItem({ onNavigate, message }: { onNavigate: (path: string) => void; message: string }) {
  return (
    <div data-testid="library-item-missing">
      <BackLink to="#/library" onNavigate={onNavigate} />
      <EmptyState
        icon={<AlertTriangle className="w-5 h-5" />}
        title="找不到这条资料"
        description={`${message} 数据可能已被删除，或链接来自另一台设备。`}
        action={
          <button onClick={() => onNavigate('#/library')} className="px-3 py-1.5 rounded-lg border border-sh-line text-xs">
            返回资料库
          </button>
        }
      />
    </div>
  );
}

export default LibraryItemView;
