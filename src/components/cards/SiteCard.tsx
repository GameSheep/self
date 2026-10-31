/**
 * Quick-navigation site card (P1-04).
 * The defect this file fixes: the old card put 复制 / 删除 / 置顶 buttons directly
 * next to the whole-card "open" click target, so a mis-click while managing a
 * · Now the card body is the *only* open target. Every management action lives
 */
import React, { useEffect, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Check,
  Copy,
  ExternalLink,
  FolderInput,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Trash2
} from 'lucide-react';
import { NavSite } from '../../types';
import { StatusPill } from '../../shared/ui';
import { SiteIcon } from '../SiteIcon';

export interface SiteMenuActions {
  onEdit: (site: NavSite) => void;
  onMoveToCategory: (site: NavSite) => void;
  onCopyLink: (site: NavSite) => void;
  onTogglePin: (site: NavSite) => void;
  onMove: (site: NavSite, direction: -1 | 1) => void;
  onDelete: (site: NavSite) => void;
}

interface SiteCardProps extends SiteMenuActions {
  site: NavSite;
  /** 'card' is the grid tile, 'row' is the dense list line. Both share the menu. */
  layout?: 'card' | 'row';
  onOpen: (site: NavSite) => void;
  /** Disabled state for 上移 / 下移 at the edges of a group. */
  canMoveUp?: boolean;
  canMoveDown?: boolean;
  copied?: boolean;
  copyFailed?: boolean;
  draggable?: boolean;
  dragging?: boolean;
  /** True while a dragged card hovers over this one. */
  dropHint?: boolean;
  onDragStart?: (e: React.DragEvent) => void;
  onDragOver?: (e: React.DragEvent) => void;
  onDrop?: (e: React.DragEvent) => void;
  onDragEnd?: () => void;
}

const getHostname = (url: string): string => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url.replace(/^https?:\/\//, '').split('/')[0] || '';
  }
};

export const SiteCard: React.FC<SiteCardProps> = React.memo(function SiteCard({
  site,
  layout = 'card',
  onOpen,
  onEdit,
  onMoveToCategory,
  onCopyLink,
  onTogglePin,
  onMove,
  onDelete,
  canMoveUp = true,
  canMoveDown = true,
  copied = false,
  copyFailed = false,
  draggable = false,
  dragging = false,
  dropHint = false,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDocDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDocDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  const hostname = getHostname(site.url);
  const initial = (site.title || hostname || '?').trim().charAt(0).toUpperCase() || '?';
  const hue = React.useMemo(() => {
    let h = 0;
    for (let i = 0; i < hostname.length; i++) h = (h * 31 + hostname.charCodeAt(i)) % 360;
    return h;
  }, [hostname]);

  /** A menu action runs and must never reach the card's open handler. */
  const runAction = (event: React.MouseEvent | React.KeyboardEvent, action: () => void) => {
    event.preventDefault();
    event.stopPropagation();
    setMenuOpen(false);
    action();
  };

  const menu = menuOpen && (
    <div
      data-testid="site-menu"
      role="menu"
      aria-label={`${site.title} 的操作菜单`}
      onClick={(e) => e.stopPropagation()}
      className="absolute right-2 top-10 z-30 w-44 rounded-xl border border-sh-line bg-sh-surface p-1 shadow-2xl"
    >
      <MenuItem icon={<Pencil className="w-3.5 h-3.5" />} label="编辑" onClick={(e) => runAction(e, () => onEdit(site))} />
      <MenuItem
        icon={<FolderInput className="w-3.5 h-3.5" />}
        label="移动到分组"
        onClick={(e) => runAction(e, () => onMoveToCategory(site))}
      />
      <MenuItem
        icon={copied ? <Check className="w-3.5 h-3.5 text-sh-ok" /> : <Copy className="w-3.5 h-3.5" />}
        label={copyFailed ? '复制失败，重试' : copied ? '已复制链接' : '复制链接'}
        onClick={(e) => runAction(e, () => onCopyLink(site))}
      />
      <MenuItem
        icon={site.pinned ? <PinOff className="w-3.5 h-3.5" /> : <Pin className="w-3.5 h-3.5" />}
        label={site.pinned ? '取消置顶' : '置顶'}
        onClick={(e) => runAction(e, () => onTogglePin(site))}
      />
      <div className="my-1 border-t border-sh-line" />
      <MenuItem
        icon={<ArrowUp className="w-3.5 h-3.5" />}
        label="上移"
        disabled={!canMoveUp}
        onClick={(e) => runAction(e, () => onMove(site, -1))}
      />
      <MenuItem
        icon={<ArrowDown className="w-3.5 h-3.5" />}
        label="下移"
        disabled={!canMoveDown}
        onClick={(e) => runAction(e, () => onMove(site, 1))}
      />
      <div className="my-1 border-t border-sh-line" />
      <MenuItem
        icon={<Trash2 className="w-3.5 h-3.5" />}
        label="删除"
        destructive
        onClick={(e) => runAction(e, () => onDelete(site))}
      />
    </div>
  );

  const siteName = (
    <span data-testid="site-title" className="truncate">
      {site.title || site.url}
    </span>
  );

  if (layout === 'row') {
    return (
      <div
        ref={rootRef}
        data-site-id={site.id}
        data-pinned={site.pinned ? 'true' : 'false'}
        draggable={draggable}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDrop={onDrop}
        onDragEnd={onDragEnd}
        className={`relative flex items-center gap-3 px-3 py-2 hover:bg-sh-surface2/70 transition-colors ${
          dragging ? 'opacity-40' : ''
        } ${dropHint ? 'ring-1 ring-inset ring-sh-info' : ''}`}
      >
        <button
          type="button"
          onClick={() => onOpen(site)}
          className="flex items-center gap-3 min-w-0 flex-1 text-left"
          aria-label={`打开 ${site.title || site.url}`}
        >
          {/* Auto-recognized favicon (site's own /favicon.ico), colored initial fallback. */}
          <SiteIcon url={site.url} title={site.title} size={24} rounded="md" />
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5 text-xs font-semibold text-sh-fg">
              {site.pinned && <Pin className="w-3 h-3 text-sh-warn shrink-0" aria-hidden />}
              {siteName}
            </span>
            <span className="text-[10px] text-sh-subtle font-mono truncate block">{site.url}</span>
          </span>
        </button>
        <span className="text-[10px] text-sh-subtle font-mono hidden sm:inline shrink-0">
          {site.visitCount || 0} 次访问
        </span>
        <SiteMenuButton open={menuOpen} setOpen={setMenuOpen} title={site.title} />
        {menu}
      </div>
    );
  }

  return (
    <div
      ref={rootRef}
      data-site-id={site.id}
      data-pinned={site.pinned ? 'true' : 'false'}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      className={`group relative flex flex-col justify-between p-3.5 rounded-xl bg-sh-surface border border-sh-line card-hover shadow-sm select-none ${
        dragging ? 'opacity-40' : ''
      } ${dropHint ? 'ring-2 ring-sh-info' : ''}`}
    >
      <button
        type="button"
        onClick={() => onOpen(site)}
        className="text-left flex-1 min-w-0"
        aria-label={`打开 ${site.title || site.url}`}
      >
        <div className="flex items-start gap-2.5">
          {/* Auto-recognized favicon (site's own /favicon.ico), colored initial fallback. */}
          <SiteIcon url={site.url} title={site.title} size={32} rounded="lg" />
          <span className="min-w-0 flex-1 pr-8">
            <span className="flex items-center gap-1.5 text-xs sm:text-sm font-semibold text-sh-fg">
              {site.pinned && <Pin className="w-3 h-3 text-sh-warn shrink-0" aria-hidden />}
              {siteName}
            </span>
            <span className="block text-[10px] sm:text-[11px] text-sh-subtle truncate font-mono mt-0.5">
              {site.url.replace(/^https?:\/\//, '').replace(/\/$/, '')}
            </span>
          </span>
        </div>
        {site.description && (
          <span className="block text-[11px] text-sh-muted line-clamp-2 mt-2 leading-relaxed">{site.description}</span>
        )}
      </button>

      <span className="absolute right-2 top-2">
        <SiteMenuButton open={menuOpen} setOpen={setMenuOpen} title={site.title} />
      </span>
      {menu}

      <div className="flex items-center justify-between text-[11px] text-sh-subtle pt-2 border-t border-sh-line mt-2 gap-2">
        <span className="px-1.5 py-0.5 rounded bg-sh-surface2 border border-sh-line text-sh-muted text-[9px] sm:text-[10px] whitespace-nowrap truncate max-w-[120px]">
          {site.category || '默认分类'}
        </span>
        <span className="flex items-center gap-1.5 shrink-0">
          {copyFailed && <StatusPill tone="danger" label="复制失败" />}
          {site.visitCount !== undefined && site.visitCount > 0 && (
            <span className="font-mono text-[9px] sm:text-[10px]">{site.visitCount} 次</span>
          )}
          <ExternalLink className="w-3 h-3" aria-hidden />
        </span>
      </div>
    </div>
  );
});

const SiteMenuButton: React.FC<{ open: boolean; setOpen: (next: boolean) => void; title: string }> = ({
  open,
  setOpen,
  title
}) => (
  <button
    type="button"
    data-testid="site-menu-button"
    aria-haspopup="menu"
    aria-expanded={open}
    // stopPropagation on both handlers: keyboard activation (Enter/Space) on this
    // button must not bubble into the card's open action either.
    onClick={(e) => {
      e.preventDefault();
      e.stopPropagation();
      setOpen(!open);
    }}
    onKeyDown={(e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        e.stopPropagation();
        setOpen(!open);
      }
    }}
    className="sh-tap p-1.5 rounded-lg text-sh-subtle hover:text-sh-fg hover:bg-sh-surface2 transition-colors"
    title={`${title} 的更多操作`}
    aria-label={`${title} 的更多操作`}
  >
    <MoreHorizontal className="w-4 h-4" aria-hidden />
  </button>
);

const MenuItem: React.FC<{
  icon: React.ReactNode;
  label: string;
  onClick: (e: React.MouseEvent) => void;
  disabled?: boolean;
  destructive?: boolean;
}> = ({ icon, label, onClick, disabled, destructive }) => (
  <button
    type="button"
    role="menuitem"
    disabled={disabled}
    onClick={onClick}
    className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-[11px] text-left transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
      destructive ? 'text-sh-danger hover:bg-sh-danger/10' : 'text-sh-fg hover:bg-sh-surface2'
    }`}
  >
    <span className="shrink-0" aria-hidden>
      {icon}
    </span>
    {label}
  </button>
);

SiteCard.displayName = 'SiteCard';

export default SiteCard;
