import React, { useState } from 'react';
import { Terminal, Copy, Check, ExternalLink, Server, Trash2, Activity, RefreshCw } from 'lucide-react';
import { ServerDeployment } from '../../types';
import { healthPresentation, probeUrlFor } from '../../lib/serverHealth';
import { ConfirmButton } from '../../shared/ui';
import { showToast as showToastGlobal } from '../../shared/ui/toast';

interface ServerCardProps {
  server: ServerDeployment;
  onDelete: (id: string) => void;
  /** Trigger a fresh health probe for this server. */
  onCheck?: (id: string) => void;
}

export const ServerCard: React.FC<ServerCardProps> = ({ server, onDelete, onCheck }) => {
  const [copied, setCopied] = useState(false);

  const sshCommand = server.sshCommand || `ssh -p ${server.sshPort || 22} ${server.sshUser || 'root'}@${server.publicIp}`;

  const handleCopySsh = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(sshCommand);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      showToastGlobal('复制失败：浏览器拒绝了剪贴板访问，请手动选择复制', 'danger');
    }
  };

  const state = (server.status || 'unknown') as 'online' | 'offline' | 'checking' | 'unknown';
  const presentation = healthPresentation(state);
  const probeTarget = probeUrlFor(server);
  const toneClass =
    presentation.tone === 'ok'
      ? 'bg-sh-ok/10 text-sh-ok border-sh-ok/40'
      : presentation.tone === 'bad'
      ? 'bg-sh-danger/10 text-sh-danger border-sh-danger/40'
      : presentation.tone === 'busy'
      ? 'bg-sh-info/10 text-sh-info border-sh-info/40'
      : 'bg-sh-surface2 text-sh-muted border-sh-line';

  const getEnvBadge = (env: string) => {
    switch (env) {
      case 'prod':
        return <span className="px-1.5 py-0.5 rounded text-[9px] sm:text-[10px] font-mono bg-sh-ok/10 text-sh-ok border border-sh-ok/40 whitespace-nowrap">PROD</span>;
      case 'test':
        return <span className="px-1.5 py-0.5 rounded text-[9px] sm:text-[10px] font-mono bg-sh-warn/10 text-sh-warn border border-sh-warn/40 whitespace-nowrap">TEST</span>;
      default:
        return <span className="px-1.5 py-0.5 rounded text-[9px] sm:text-[10px] font-mono bg-sh-surface2 text-sh-muted border border-sh-line whitespace-nowrap">DEV</span>;
    }
  };

  return (
    <div className="group relative p-3.5 sm:p-4 rounded-xl bg-sh-surface border border-sh-line card-hover shadow-sm flex flex-col justify-between">
      <div>
        {/* Header */}
        <div className="flex items-start justify-between gap-2 mb-2.5">
          <div className="flex items-center gap-2.5 min-w-0 flex-1">
            <div className="w-8 h-8 rounded-lg bg-sh-surface2 border border-sh-line flex items-center justify-center shrink-0 text-sh-muted">
              <Server className="w-4 h-4" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <h3 className="text-xs sm:text-sm font-semibold text-sh-fg truncate">
                  {server.name}
                </h3>
                {getEnvBadge(server.env)}
              </div>
              {server.domain && (
                <a 
                  href={`https://${server.domain}`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-[11px] text-sh-info hover:underline inline-flex items-center gap-1 font-mono mt-0.5 truncate max-w-full"
                >
                  <span className="truncate">{server.domain}</span>
                  <ExternalLink className="w-2.5 h-2.5 shrink-0" />
                </a>
              )}
            </div>
          </div>

          <ConfirmButton
            onConfirm={() => onDelete(server.id)}
            confirmLabel="确认删除？"
            confirmDetail={server.name}
            className="opacity-100 sm:opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-sh-surface2 text-sh-subtle hover:text-sh-danger transition-opacity shrink-0"
            title="删除"
            aria-label={`删除服务器 ${server.name}`}
          >
            <Trash2 className="w-3.5 h-3.5" aria-hidden />
          </ConfirmButton>
        </div>

        {/* Real health status (never claimed without a probe) */}
        <div className="flex items-center justify-between gap-2 mb-2.5">
          <div className="flex items-center gap-1.5 min-w-0">
            <span
              data-server-status={state}
              className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] font-mono whitespace-nowrap ${toneClass}`}
              title={server.lastCheckMessage || presentation.label}
            >
              {state === 'checking' ? (
                <RefreshCw className="w-2.5 h-2.5 animate-spin" />
              ) : (
                <span className="w-1.5 h-1.5 rounded-full bg-current" />
              )}
              {presentation.label}
            </span>
            <span className="text-[10px] text-sh-subtle font-mono truncate" title={server.lastCheckMessage || ''}>
              {server.lastCheckedAt
                ? `${new Date(server.lastCheckedAt).toLocaleTimeString()} · ${server.lastCheckMessage || ''}`
                : probeTarget
                ? '尚未检测'
                : '缺少可探测地址'}
            </span>
          </div>

          <button
            onClick={() => onCheck?.(server.id)}
            disabled={!onCheck || state === 'checking'}
            className="shrink-0 px-2 py-0.5 rounded-md bg-sh-surface2 border border-sh-line text-sh-muted hover:text-sh-fg text-[10px] flex items-center gap-1 disabled:opacity-40"
            title={
              probeTarget
                ? `探测 ${probeTarget.url}`
                : '浏览器无法直连 SSH 端口，请填写「健康检查 URL」或绑定域名后再检测'
            }
          >
            <Activity className="w-2.5 h-2.5" />
            <span>检测</span>
          </button>
        </div>

        {/* Network Info & IP */}
        <div className="bg-sh-surface2/80 rounded-lg p-2.5 border border-sh-line font-mono text-xs space-y-1.5 mb-2.5">
          <div className="flex items-center justify-between text-sh-muted text-[11px]">
            <span className="text-sh-subtle whitespace-nowrap">公网 IP / 端口</span>
            <span className="text-sh-fg truncate font-mono ml-2">
              {server.publicIp}{server.port ? `:${server.port}` : ''}
            </span>
          </div>
          {server.deployPath && (
            <div className="flex items-center justify-between text-sh-muted pt-1 border-t border-sh-line text-[11px]">
              <span className="text-sh-subtle whitespace-nowrap">部署路径</span>
              <span className="text-sh-muted truncate max-w-[160px] sm:max-w-[200px] font-mono ml-2">{server.deployPath}</span>
            </div>
          )}
        </div>
      </div>

      <div>
        {/* SSH Quick Command Box */}
        <div className="flex items-center justify-between gap-1.5 p-2 rounded-lg bg-sh-bg/70 border border-sh-line text-xs font-mono">
          <div className="flex items-center gap-1.5 min-w-0 text-sh-muted">
            <Terminal className="w-3.5 h-3.5 text-sh-subtle shrink-0" />
            <span className="truncate text-[10px] sm:text-[11px]">{sshCommand}</span>
          </div>
          <button
            onClick={handleCopySsh}
            className="px-2 py-1 rounded bg-sh-surface2 hover:bg-sh-line text-sh-fg text-[10px] sm:text-[11px] shrink-0 flex items-center gap-1 transition-colors whitespace-nowrap"
            title="复制 SSH 命令"
          >
            {copied ? <Check className="w-3 h-3 text-sh-ok" /> : <Copy className="w-3 h-3" />}
            <span>{copied ? '已复制' : '复制'}</span>
          </button>
        </div>

        {/* Notes */}
        {server.notes && (
          <p className="text-[10px] sm:text-[11px] text-sh-subtle mt-2 line-clamp-1 leading-normal">
            {server.notes}
          </p>
        )}
      </div>
    </div>
  );
};
