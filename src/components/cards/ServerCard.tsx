import React, { useState } from 'react';
import { Terminal, Copy, Check, ExternalLink, Server, Trash2 } from 'lucide-react';
import { ServerDeployment } from '../../types';

interface ServerCardProps {
  server: ServerDeployment;
  onDelete: (id: string) => void;
}

export const ServerCard: React.FC<ServerCardProps> = ({ server, onDelete }) => {
  const [copied, setCopied] = useState(false);

  const sshCommand = server.sshCommand || `ssh -p ${server.sshPort || 22} ${server.sshUser || 'root'}@${server.publicIp}`;

  const handleCopySsh = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(sshCommand);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const getEnvBadge = (env: string) => {
    switch (env) {
      case 'prod':
        return <span className="px-1.5 py-0.5 rounded text-[9px] sm:text-[10px] font-mono bg-emerald-950/60 text-emerald-400 border border-emerald-800/50 whitespace-nowrap">PROD</span>;
      case 'test':
        return <span className="px-1.5 py-0.5 rounded text-[9px] sm:text-[10px] font-mono bg-amber-950/60 text-amber-400 border border-amber-800/50 whitespace-nowrap">TEST</span>;
      default:
        return <span className="px-1.5 py-0.5 rounded text-[9px] sm:text-[10px] font-mono bg-zinc-800 text-zinc-400 border border-zinc-700/50 whitespace-nowrap">DEV</span>;
    }
  };

  return (
    <div className="group relative p-3.5 sm:p-4 rounded-xl bg-[#121316] border border-[#22242a] card-hover shadow-sm flex flex-col justify-between">
      <div>
        {/* Header */}
        <div className="flex items-start justify-between gap-2 mb-2.5">
          <div className="flex items-center gap-2.5 min-w-0 flex-1">
            <div className="w-8 h-8 rounded-lg bg-zinc-900 border border-zinc-800 flex items-center justify-center shrink-0 text-zinc-300">
              <Server className="w-4 h-4" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <h3 className="text-xs sm:text-sm font-semibold text-zinc-100 truncate">
                  {server.name}
                </h3>
                {getEnvBadge(server.env)}
              </div>
              {server.domain && (
                <a 
                  href={`https://${server.domain}`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-[11px] text-sky-400 hover:underline inline-flex items-center gap-1 font-mono mt-0.5 truncate max-w-full"
                >
                  <span className="truncate">{server.domain}</span>
                  <ExternalLink className="w-2.5 h-2.5 shrink-0" />
                </a>
              )}
            </div>
          </div>

          <button
            onClick={() => {
              if (confirm(`确定删除服务器 ${server.name} 吗？`)) {
                onDelete(server.id);
              }
            }}
            className="opacity-100 sm:opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-zinc-800 text-zinc-500 hover:text-red-400 transition-opacity shrink-0"
            title="删除"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Network Info & IP */}
        <div className="bg-zinc-900/80 rounded-lg p-2.5 border border-zinc-800/80 font-mono text-xs space-y-1.5 mb-2.5">
          <div className="flex items-center justify-between text-zinc-400 text-[11px]">
            <span className="text-zinc-500 whitespace-nowrap">公网 IP / 端口</span>
            <span className="text-zinc-200 truncate font-mono ml-2">
              {server.publicIp}{server.port ? `:${server.port}` : ''}
            </span>
          </div>
          {server.deployPath && (
            <div className="flex items-center justify-between text-zinc-400 pt-1 border-t border-zinc-800/60 text-[11px]">
              <span className="text-zinc-500 whitespace-nowrap">部署路径</span>
              <span className="text-zinc-300 truncate max-w-[160px] sm:max-w-[200px] font-mono ml-2">{server.deployPath}</span>
            </div>
          )}
        </div>
      </div>

      <div>
        {/* SSH Quick Command Box */}
        <div className="flex items-center justify-between gap-1.5 p-2 rounded-lg bg-black/50 border border-zinc-800/90 text-xs font-mono">
          <div className="flex items-center gap-1.5 min-w-0 text-zinc-300">
            <Terminal className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
            <span className="truncate text-[10px] sm:text-[11px]">{sshCommand}</span>
          </div>
          <button
            onClick={handleCopySsh}
            className="px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-[10px] sm:text-[11px] shrink-0 flex items-center gap-1 transition-colors whitespace-nowrap"
            title="复制 SSH 命令"
          >
            {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
            <span>{copied ? '已复制' : '复制'}</span>
          </button>
        </div>

        {/* Notes */}
        {server.notes && (
          <p className="text-[10px] sm:text-[11px] text-zinc-500 mt-2 line-clamp-1 leading-normal">
            {server.notes}
          </p>
        )}
      </div>
    </div>
  );
};
