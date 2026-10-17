import React, { useState } from 'react';
import { ExternalLink, Copy, Check, Globe, Pin, Trash2 } from 'lucide-react';
import { NavSite } from '../../types';

interface SiteCardProps {
  site: NavSite;
  onVisit: (id: string) => void;
  onDelete: (id: string) => void;
  onTogglePin?: (id: string) => void;
}

export const SiteCard: React.FC<SiteCardProps> = React.memo(({ site, onVisit, onDelete, onTogglePin }) => {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(site.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopyFailed(true);
      setTimeout(() => setCopyFailed(false), 2500);
    }
  };

  const handleVisit = () => {
    onVisit(site.id);
    window.open(site.url, '_blank', 'noopener,noreferrer');
  };

  /**
   * Local-only icon.
   *
   * This used to point at https://www.google.com/s2/favicons for every bookmark,
   * which (a) sent each saved domain to a third party from an app that advertises
   * "本地离线优先 / 无第三方追踪", (b) fired one network request per card (hundreds
   * for an imported bookmark library) and (c) spammed the console with 404s for
   * domains Google does not know. A deterministic letter tile costs nothing.
   */
  const getHostname = (url: string): string => {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch {
      return url.replace(/^https?:\/\//, '').split('/')[0] || '';
    }
  };

  const hostname = getHostname(site.url);
  const initial = (site.title || hostname || '?').trim().charAt(0).toUpperCase() || '?';
  const hue = React.useMemo(() => {
    let h = 0;
    for (let i = 0; i < hostname.length; i++) h = (h * 31 + hostname.charCodeAt(i)) % 360;
    return h;
  }, [hostname]);

  return (
    <div 
      onClick={handleVisit}
      className="group relative flex flex-col justify-between p-3.5 sm:p-4 rounded-xl bg-[#121316] border border-[#22242a] card-hover cursor-pointer shadow-sm select-none"
    >
      <div>
        {/* Header */}
        <div className="flex items-start justify-between gap-2 mb-2">
          <div className="flex items-center gap-2.5 min-w-0 flex-1">
            <div
              className="w-8 h-8 rounded-lg border border-zinc-800 flex items-center justify-center shrink-0 overflow-hidden font-semibold text-xs select-none"
              style={{
                backgroundColor: `hsl(${hue} 45% 20%)`,
                color: `hsl(${hue} 75% 72%)`
              }}
              title={hostname || site.title}
              aria-hidden="true"
            >
              {initial}
            </div>
            <div className="min-w-0 flex-1">
              <h3 className="text-xs sm:text-sm font-semibold text-zinc-200 group-hover:text-white truncate">
                {site.title}
              </h3>
              <p className="text-[10px] sm:text-[11px] text-zinc-500 truncate font-mono mt-0.5">
                {site.url.replace(/^https?:\/\//, '').replace(/\/$/, '')}
              </p>
            </div>
          </div>

          {/* Quick Actions (visible on mobile, hover on desktop) */}
          <div className="flex items-center gap-0.5 opacity-100 sm:opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
            {onTogglePin && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onTogglePin(site.id);
                }}
                className={`p-1 rounded hover:bg-zinc-800 text-xs ${site.pinned ? 'text-amber-400' : 'text-zinc-500'}`}
                title="固定到置顶"
              >
                <Pin className="w-3 h-3" />
              </button>
            )}
            <button
              onClick={handleCopy}
              className="p-1 rounded hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 text-xs"
              title={copyFailed ? '复制失败，请手动复制' : '复制网址'}
            >
              {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                if (confirm(`确定删除 ${site.title} 吗？`)) {
                  onDelete(site.id);
                }
              }}
              className="p-1 rounded hover:bg-zinc-800 text-zinc-500 hover:text-red-400 text-xs"
              title="删除"
            >
              <Trash2 className="w-3 h-3" />
            </button>
          </div>
        </div>

        {/* Description */}
        {site.description && (
          <p className="text-[11px] sm:text-xs text-zinc-400 line-clamp-2 mt-1 mb-2 leading-relaxed">
            {site.description}
          </p>
        )}
      </div>

      {/* Footer Tags & Meta */}
      <div className="flex items-center justify-between text-[11px] text-zinc-500 pt-2 border-t border-zinc-800/60 mt-2">
        <span className="px-1.5 py-0.5 rounded bg-zinc-900 border border-zinc-800/80 text-zinc-400 text-[9px] sm:text-[10px] whitespace-nowrap truncate max-w-[120px]">
          {site.category || '默认'}
        </span>
        <div className="flex items-center gap-1.5 shrink-0">
          {site.visitCount !== undefined && site.visitCount > 0 && (
            <span className="font-mono text-[9px] sm:text-[10px] text-zinc-500 whitespace-nowrap">
              {site.visitCount} 次
            </span>
          )}
          <ExternalLink className="w-3 h-3 text-zinc-500 group-hover:text-zinc-300 transition-colors" />
        </div>
      </div>
    </div>
  );
});

SiteCard.displayName = 'SiteCard';

export default SiteCard;
