import React, { useState } from 'react';
import { CheckCircle2, Clock, AlertCircle, Play, ExternalLink, Flame, Trash2, Code2, Copy, Check, X } from 'lucide-react';
import { CheckInTask } from '../../types';
import { generateUserScript } from '../../lib/automation';

interface CheckInCardProps {
  task: CheckInTask;
  onRun: (id: string) => Promise<void>;
  onDelete: (id: string) => void;
}

export const CheckInCard: React.FC<CheckInCardProps> = ({ task, onRun, onDelete }) => {
  const [running, setRunning] = useState(false);
  const [showScriptModal, setShowScriptModal] = useState(false);
  const [copiedScript, setCopiedScript] = useState(false);

  const handleRun = async () => {
    setRunning(true);
    try {
      await onRun(task.id);
    } finally {
      setRunning(false);
    }
  };

  const scriptCode = generateUserScript(task);

  const handleCopyScript = () => {
    navigator.clipboard.writeText(scriptCode);
    setCopiedScript(true);
    setTimeout(() => setCopiedScript(false), 2000);
  };

  const getStatusBadge = () => {
    switch (task.lastStatus) {
      case 'success':
        return (
          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-emerald-950/60 text-emerald-400 border border-emerald-800/50 whitespace-nowrap">
            <CheckCircle2 className="w-3 h-3 shrink-0" />
            <span>已签到</span>
          </span>
        );
      case 'failed':
        return (
          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-red-950/60 text-red-400 border border-red-800/50 whitespace-nowrap">
            <AlertCircle className="w-3 h-3 shrink-0" />
            <span>失败</span>
          </span>
        );
      default:
        return (
          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-950/60 text-amber-400 border border-amber-800/50 whitespace-nowrap">
            <Clock className="w-3 h-3 shrink-0" />
            <span>待执行</span>
          </span>
        );
    }
  };

  return (
    <div className="group relative p-3.5 sm:p-4 rounded-xl bg-[#121316] border border-[#22242a] card-hover shadow-sm flex flex-col justify-between">
      <div>
        {/* Header */}
        <div className="flex items-start justify-between gap-2 mb-2">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 sm:gap-2">
              <h3 className="text-xs sm:text-sm font-semibold text-zinc-100 truncate">
                {task.name}
              </h3>
              {getStatusBadge()}
            </div>
            <a
              href={task.url}
              target="_blank"
              rel="noreferrer"
              className="text-[11px] text-zinc-500 hover:text-zinc-300 truncate block mt-0.5 font-mono"
            >
              {task.url.replace(/^https?:\/\//, '')}
            </a>
          </div>

          <button
            onClick={() => {
              if (confirm(`确定删除签到任务 ${task.name} 吗？`)) {
                onDelete(task.id);
              }
            }}
            className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-zinc-800 text-zinc-500 hover:text-red-400 transition-opacity shrink-0"
            title="删除"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Message Banner */}
        {task.lastMessage && (
          <div className="text-[11px] text-zinc-400 bg-zinc-900/80 p-2 rounded-lg border border-zinc-800/80 my-2 leading-relaxed break-words">
            {task.lastMessage}
          </div>
        )}
      </div>

      {/* Footer & Actions */}
      <div className="flex items-center justify-between pt-2 border-t border-zinc-800/60 mt-2 text-[11px] text-zinc-500">
        <div className="flex items-center gap-1.5 font-mono whitespace-nowrap">
          <Flame className="w-3.5 h-3.5 text-orange-400 shrink-0" />
          <span className="text-[10px] sm:text-[11px]">连续 {task.streakDays || 1} 天</span>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          {/* Tampermonkey Script Modal Trigger */}
          <button
            onClick={() => setShowScriptModal(true)}
            className="p-1 sm:px-2 sm:py-1 rounded bg-zinc-900 hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 text-[11px] flex items-center gap-1 transition-colors border border-zinc-800"
            title="查看/获取自动模拟点击油猴脚本"
          >
            <Code2 className="w-3 h-3 shrink-0" />
            <span className="hidden sm:inline">油猴脚本</span>
          </button>

          <button
            onClick={handleRun}
            disabled={running}
            className="px-2.5 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs flex items-center gap-1.5 transition-colors font-medium disabled:opacity-50 whitespace-nowrap"
          >
            <Play className={`w-3 h-3 shrink-0 ${running ? 'animate-spin' : ''}`} />
            <span>{running ? '执行中' : '立即签到'}</span>
          </button>
        </div>
      </div>

      {/* Tampermonkey Script View Modal */}
      {showScriptModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in">
          <div className="w-full max-w-2xl bg-[#121316] border border-zinc-800 rounded-2xl p-5 shadow-2xl flex flex-col max-h-[85vh]">
            <div className="flex items-center justify-between pb-3 border-b border-zinc-800 mb-3">
              <div className="flex items-center gap-2">
                <Code2 className="w-4 h-4 text-emerald-400" />
                <h4 className="text-sm font-semibold text-zinc-100">
                  油猴自动模拟点击脚本 · {task.name}
                </h4>
              </div>
              <button
                onClick={() => setShowScriptModal(false)}
                className="p-1 rounded-lg hover:bg-zinc-800 text-zinc-400 hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <p className="text-xs text-zinc-400 leading-relaxed mb-3">
              对于需要登录且有复杂界面的网站，在 Chrome/Edge 安装 <strong>Tampermonkey (油猴插件)</strong>，将下方脚本安装进去。之后每次点击【立即签到】，浏览器打开页面后将<strong>自动寻找按钮并模拟点击签到</strong>！
            </p>

            <pre className="flex-1 overflow-y-auto bg-black/70 p-3.5 rounded-xl border border-zinc-800 text-[11px] font-mono text-zinc-300 leading-relaxed select-all">
              {scriptCode}
            </pre>

            <div className="flex items-center justify-end gap-2 pt-3 border-t border-zinc-800 mt-3">
              <button
                onClick={() => setShowScriptModal(false)}
                className="px-3 py-1.5 rounded-lg bg-zinc-900 text-zinc-300 text-xs hover:bg-zinc-800"
              >
                关闭
              </button>
              <button
                onClick={handleCopyScript}
                className="px-3.5 py-1.5 rounded-lg bg-zinc-100 text-zinc-900 font-semibold text-xs flex items-center gap-1.5 hover:bg-white"
              >
                {copiedScript ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                <span>{copiedScript ? '已复制脚本代码' : '一键复制脚本'}</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
