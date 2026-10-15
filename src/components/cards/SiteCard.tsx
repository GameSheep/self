import React, { useState } from 'react';
import { ExternalLink, Copy, Check, Globe, Pin, Trash2 } from 'lucide-react';
import { NavSite } from '../../types';

interface SiteCardProps {
  site: NavSite;
  onVisit: (id: string) => void;
  onDelete: (id: string) => void;
  onTogglePin?: (id: string) => void;
}

export const SiteCard: React.FC<SiteCardProps> = ({ site, onVisit, onDelete, onTogglePin }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(site.url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleVisit = () => {
    onVisit(site.id);
    window.open(site.url, '_blank', 'noopener,noreferrer');
  };

  const getFaviconUrl = (url: string) => {
    try {
      const parsed = new URL(url);
      return `https://www.google.com/s2/favicons?domain=${parsed.hostname}&sz=32`;
    } catch {
      return null;
    }
  };

  const favicon = getFaviconUrl(site.url);

  return (
    <div 
      onClick={handleVisit}
      className="group relative flex flex-col justify-between p-3.5 sm:p-4 rounded-xl bg-[#121316] border border-[#22242a] card-hover cursor-pointer shadow-sm select-none"
    >
      <div>
        {/* Header */}
        <div className="flex items-start justify-between gap-2 mb-2">
          <div className="flex items-center gap-2.5 min-w-0 flex-1">
            <div className="w-8 h-8 rounded-lg bg-zinc-900 border border-zinc-800 flex items-center justify-center shrink-0 overflow-hidden">
              {favicon ? (
                <img 
                  src={favicon} 
                  alt="" 
                  className="w-4 h-4 object-contain opacity-90 group-hover:opacity-100"
                  onError={(e) => {
                    (e.target as HTMLElement).style.display = 'none';
                  }}
                />
              ) : (
                <Globe className="w-4 h-4 text-zinc-400" />
              )}
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
              title="复制网址"
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
};
