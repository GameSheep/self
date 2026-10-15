import React from 'react';
import { 
  Globe, 
  Server, 
  Key, 
  CheckSquare, 
  BookOpen, 
  Clock, 
  Play, 
  ArrowRight, 
  Terminal, 
  Copy, 
  Check, 
  Shield, 
  Lock, 
  ExternalLink,
  Flame,
  FileText,
  AlertTriangle,
  DollarSign
} from 'lucide-react';
import { HubState, SecretItem } from '../../types';
import { decryptText } from '../../lib/crypto';

interface DashboardOverviewProps {
  state: HubState;
  onNavigateTab: (tab: any) => void;
  masterPassword: string | null;
  onRequireUnlock: () => void;
  onVisitSite: (id: string) => void;
  onRunCheckIn: (id: string) => Promise<void>;
  onRunAllCheckIns: () => Promise<void>;
}

export const DashboardOverview: React.FC<DashboardOverviewProps> = ({
  state,
  onNavigateTab,
  masterPassword,
  onRequireUnlock,
  onVisitSite,
  onRunCheckIn,
  onRunAllCheckIns
}) => {
  const [copiedId, setCopiedId] = React.useState<string | null>(null);
  const [batchRunning, setBatchRunning] = React.useState(false);

  const handleCopyText = (id: string, text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const handleCopySecret = async (secret: SecretItem) => {
    if (!masterPassword) {
      onRequireUnlock();
      return;
    }
    try {
      const plain = await decryptText(secret.encryptedValue, secret.iv, secret.salt, masterPassword);
      handleCopyText(secret.id, plain);
    } catch {
      onRequireUnlock();
    }
  };

  const handleRunAll = async () => {
    setBatchRunning(true);
    try {
      await onRunAllCheckIns();
    } finally {
      setBatchRunning(false);
    }
  };

  const now = Date.now();
  const getDaysLeft = (targetDate: number) => Math.ceil((targetDate - now) / (1000 * 60 * 60 * 24));

  // Top Pinned / Most Visited Sites
  const quickAccessSites = state.sites
    .slice()
    .sort((a, b) => ((b.visitCount || 0) + (b.pinned ? 100 : 0)) - ((a.visitCount || 0) + (a.pinned ? 100 : 0)))
    .slice(0, 8);

  const onlineServers = state.servers.filter(s => s.status === 'online').length;
  const completedCheckIns = state.checkIns.filter(c => c.lastStatus === 'success').length;

  const urgentReminders = (state.reminders || [])
    .slice()
    .sort((a, b) => a.targetDate - b.targetDate)
    .slice(0, 4);

  return (
    <div className="space-y-6">
      
      {/* 1. Quick Access Top Dock (秒开置顶常用栏) */}
      <div className="p-4 rounded-2xl bg-[#121316] border border-[#22242a] shadow-sm">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-sky-400"></span>
            <h3 className="text-xs font-semibold text-zinc-300">快速秒开 · 常用与置顶</h3>
          </div>
          <button
            onClick={() => onNavigateTab('sites')}
            className="text-xs text-zinc-400 hover:text-white flex items-center gap-1 transition-colors"
          >
            全部网址 ({state.sites.length}) <ArrowRight className="w-3 h-3" />
          </button>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-2">
          {quickAccessSites.map((site) => (
            <div
              key={site.id}
              onClick={() => {
                onVisitSite(site.id);
                window.open(site.url, '_blank', 'noopener,noreferrer');
              }}
              className="p-2.5 rounded-xl bg-zinc-900/80 border border-zinc-800 hover:border-zinc-700 hover:bg-zinc-800/80 cursor-pointer transition-all flex flex-col items-center text-center group select-none"
            >
              <div className="w-7 h-7 rounded-lg bg-black/50 border border-zinc-800 flex items-center justify-center mb-1.5 overflow-hidden">
                <Globe className="w-3.5 h-3.5 text-zinc-400 group-hover:text-sky-400 transition-colors" />
              </div>
              <span className="text-xs font-medium text-zinc-200 group-hover:text-white truncate w-full">
                {site.title}
              </span>
              <span className="text-[10px] text-zinc-400 font-mono mt-0.5">
                {site.visitCount || 0} 次
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* 2. Urgent Expiry & Countdown Alert Strip */}
      {urgentReminders.length > 0 && (
        <div className="p-4 rounded-2xl bg-[#121316] border border-[#22242a] shadow-sm">
          <div className="flex items-center justify-between pb-2 mb-2 border-b border-zinc-800/80">
            <div className="flex items-center gap-2">
              <Clock className="w-4 h-4 text-amber-400" />
              <h3 className="text-xs font-semibold text-zinc-200">服务续费与时效倒计时</h3>
            </div>
            <button
              onClick={() => onNavigateTab('reminders')}
              className="text-xs text-zinc-400 hover:text-white flex items-center gap-1"
            >
              全部提醒 ({state.reminders?.length || 0}) <ArrowRight className="w-3 h-3" />
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5">
            {urgentReminders.map((rem) => {
              const days = getDaysLeft(rem.targetDate);
              const isUrgent = days <= 7;
              return (
                <div
                  key={rem.id}
                  onClick={() => onNavigateTab('reminders')}
                  className={`p-3 rounded-xl border cursor-pointer transition-colors flex items-center justify-between gap-2 ${
                    isUrgent ? 'bg-red-950/20 border-red-900/50 hover:border-red-700' : 'bg-zinc-900/60 border-zinc-800/80 hover:border-zinc-700'
                  }`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-medium text-zinc-200 truncate">{rem.title}</div>
                    <div className="text-[10px] text-zinc-400 font-mono truncate mt-0.5">
                      {rem.cost ? `${rem.cost} · ` : ''}到期: {new Date(rem.targetDate).toLocaleDateString()}
                    </div>
                  </div>

                  <span className={`px-2 py-0.5 rounded text-[11px] font-mono font-bold shrink-0 ${
                    isUrgent ? 'bg-red-950 text-red-400 border border-red-800 animate-pulse' : 'bg-zinc-800 text-emerald-400 border border-zinc-700'
                  }`}>
                    {days < 0 ? '已到期' : `D-${days}天`}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* 3. Bento Dashboard Core Widgets (2x2 Grid) */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        
        {/* WIDGET A: Servers & DevOps Monitor */}
        <div className="p-4 rounded-2xl bg-[#121316] border border-[#22242a] shadow-sm flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between pb-3 border-b border-zinc-800/80 mb-3">
              <div className="flex items-center gap-2">
                <div className="w-6 h-6 rounded-md bg-emerald-950/60 border border-emerald-800/50 flex items-center justify-center text-emerald-400">
                  <Server className="w-3.5 h-3.5" />
                </div>
                <h3 className="text-xs font-semibold text-zinc-100">基础设施与部署监控</h3>
                <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-emerald-950/60 text-emerald-400 border border-emerald-800/40">
                  {onlineServers}/{state.servers.length} 运行中
                </span>
              </div>
              <button
                onClick={() => onNavigateTab('servers')}
                className="text-xs text-zinc-400 hover:text-white flex items-center gap-1"
              >
                管理 <ArrowRight className="w-3 h-3" />
              </button>
            </div>

            <div className="space-y-2">
              {state.servers.length > 0 ? (
                state.servers.slice(0, 3).map((server) => {
                  const sshCmd = server.sshCommand || `ssh ${server.sshUser || 'root'}@${server.publicIp}`;
                  const isCopied = copiedId === server.id;
                  return (
                    <div key={server.id} className="p-2.5 rounded-xl bg-zinc-900/60 border border-zinc-800/80 flex items-center justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0"></span>
                          <span className="text-xs font-medium text-zinc-200 truncate">{server.name}</span>
                          <span className="text-[9px] font-mono uppercase px-1 rounded bg-zinc-800 text-zinc-400">{server.env}</span>
                        </div>
                        <div className="text-[11px] text-zinc-400 font-mono truncate mt-0.5 ml-3">
                          {server.publicIp}:{server.port}
                        </div>
                      </div>

                      <button
                        onClick={() => handleCopyText(server.id, sshCmd)}
                        className="px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-[11px] font-mono flex items-center gap-1 transition-colors shrink-0"
                        title="一键复制 SSH 连接指令"
                      >
                        {isCopied ? <Check className="w-3 h-3 text-emerald-400" /> : <Terminal className="w-3 h-3 text-zinc-400" />}
                        <span>{isCopied ? '已复制' : 'SSH'}</span>
                      </button>
                    </div>
                  );
                })
              ) : (
                <div 
                  onClick={() => onNavigateTab('servers')}
                  className="p-4 rounded-xl border border-dashed border-zinc-800/80 bg-zinc-900/30 text-center cursor-pointer hover:border-emerald-800/50 transition-colors"
                >
                  <Server className="w-5 h-5 text-zinc-600 mx-auto mb-1" />
                  <p className="text-xs text-zinc-400">暂未配置服务器主机</p>
                  <p className="text-[11px] text-zinc-500 mt-0.5">点击前往添加主机与一键 SSH 指令</p>
                </div>
              )}
            </div>
          </div>

          <div className="pt-3 border-t border-zinc-800/60 mt-3 flex items-center justify-between text-[11px] text-zinc-400 font-mono">
            <span>存储: 本地离线优先 / IndexedDB</span>
            <span className="text-emerald-400">安全就绪</span>
          </div>
        </div>

        {/* WIDGET B: Zero-Knowledge Secret Vault */}
        <div className="p-4 rounded-2xl bg-[#121316] border border-[#22242a] shadow-sm flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between pb-3 border-b border-zinc-800/80 mb-3">
              <div className="flex items-center gap-2">
                <div className="w-6 h-6 rounded-md bg-amber-950/60 border border-amber-800/50 flex items-center justify-center text-amber-400">
                  <Key className="w-3.5 h-3.5" />
                </div>
                <h3 className="text-xs font-semibold text-zinc-100">安全金库凭据 (AES-256)</h3>
                <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-amber-950/60 text-amber-400 border border-amber-800/40">
                  {state.secrets.length} 项加密
                </span>
              </div>
              <button
                onClick={() => onNavigateTab('secrets')}
                className="text-xs text-zinc-400 hover:text-white flex items-center gap-1"
              >
                金库全览 <ArrowRight className="w-3 h-3" />
              </button>
            </div>

            <div className="space-y-2">
              {state.secrets.length > 0 ? (
                state.secrets.slice(0, 3).map((secret) => {
                  const isCopied = copiedId === secret.id;
                  return (
                    <div key={secret.id} className="p-2.5 rounded-xl bg-zinc-900/60 border border-zinc-800/80 flex items-center justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="text-xs font-medium text-zinc-200 truncate">{secret.name}</div>
                        <div className="text-[11px] text-zinc-400 font-mono truncate mt-0.5">
                          {secret.maskedPreview}
                        </div>
                      </div>

                      <button
                        onClick={() => handleCopySecret(secret)}
                        className="px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-[11px] font-mono flex items-center gap-1 transition-colors shrink-0"
                        title="解密并复制"
                      >
                        {isCopied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3 text-zinc-400" />}
                        <span>{isCopied ? '已复制' : '复制Key'}</span>
                      </button>
                    </div>
                  );
                })
              ) : (
                <div 
                  onClick={() => onNavigateTab('secrets')}
                  className="p-4 rounded-xl border border-dashed border-zinc-800/80 bg-zinc-900/30 text-center cursor-pointer hover:border-amber-800/50 transition-colors"
                >
                  <Key className="w-5 h-5 text-zinc-600 mx-auto mb-1" />
                  <p className="text-xs text-zinc-400">金库凭据库为空</p>
                  <p className="text-[11px] text-zinc-500 mt-0.5">设置主密码，离线加密存储 API Key 与 Token</p>
                </div>
              )}
            </div>
          </div>

          <div className="pt-3 border-t border-zinc-800/60 mt-3 flex items-center justify-between text-[11px]">
            <div className="flex items-center gap-1 text-zinc-400">
              <Shield className="w-3.5 h-3.5 text-emerald-400" />
              <span>端到端零知识本地解密</span>
            </div>
            {!masterPassword ? (
              <button onClick={onRequireUnlock} className="text-amber-400 hover:underline flex items-center gap-1">
                <Lock className="w-3 h-3" />
                解锁金库
              </button>
            ) : (
              <span className="text-emerald-400">已授权解密</span>
            )}
          </div>
        </div>

        {/* WIDGET C: Automation & Daily Check-in */}
        <div className="p-4 rounded-2xl bg-[#121316] border border-[#22242a] shadow-sm flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between pb-3 border-b border-zinc-800/80 mb-3">
              <div className="flex items-center gap-2">
                <div className="w-6 h-6 rounded-md bg-sky-950/60 border border-sky-800/50 flex items-center justify-center text-sky-400">
                  <CheckSquare className="w-3.5 h-3.5" />
                </div>
                <h3 className="text-xs font-semibold text-zinc-100">日常自动化与签到中心</h3>
                <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-sky-950/60 text-sky-400 border border-sky-800/40">
                  {completedCheckIns}/{state.checkIns.length} 已签
                </span>
              </div>
              <button
                onClick={handleRunAll}
                disabled={batchRunning || state.checkIns.length === 0}
                className="px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 text-zinc-200 text-xs flex items-center gap-1 transition-colors"
              >
                <Play className={`w-3 h-3 ${batchRunning ? 'animate-spin' : ''}`} />
                <span>一键全签</span>
              </button>
            </div>

            <div className="space-y-2">
              {state.checkIns.length > 0 ? (
                state.checkIns.slice(0, 3).map((task) => (
                  <div key={task.id} className="p-2.5 rounded-xl bg-zinc-900/60 border border-zinc-800/80 flex items-center justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="text-xs font-medium text-zinc-200 truncate">{task.name}</span>
                        <span className="text-[10px] font-mono text-orange-400 flex items-center gap-0.5">
                          <Flame className="w-2.5 h-2.5" /> {task.streakDays || 1}天
                        </span>
                      </div>
                      <div className="text-[11px] text-zinc-400 truncate mt-0.5">
                        {task.lastMessage || '待执行打卡'}
                      </div>
                    </div>

                    <button
                      onClick={() => onRunCheckIn(task.id)}
                      className="px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-[11px] flex items-center gap-1 transition-colors shrink-0"
                    >
                      <Play className="w-2.5 h-2.5" />
                      <span>执行</span>
                    </button>
                  </div>
                ))
              ) : (
                <div 
                  onClick={() => onNavigateTab('checkin')}
                  className="p-4 rounded-xl border border-dashed border-zinc-800/80 bg-zinc-900/30 text-center cursor-pointer hover:border-sky-800/50 transition-colors"
                >
                  <CheckSquare className="w-5 h-5 text-zinc-600 mx-auto mb-1" />
                  <p className="text-xs text-zinc-400">暂无打卡或签到任务</p>
                  <p className="text-[11px] text-zinc-500 mt-0.5">点击前往添加日常自动化签到</p>
                </div>
              )}
            </div>
          </div>

          <div className="pt-3 border-t border-zinc-800/60 mt-3 flex items-center justify-between text-[11px] text-zinc-400">
            <span>支持直连 API 与油猴模拟点击</span>
            <button onClick={() => onNavigateTab('checkin')} className="text-zinc-300 hover:text-white flex items-center gap-1">
              查看全部 ({state.checkIns.length}) <ArrowRight className="w-3 h-3" />
            </button>
          </div>
        </div>

        {/* WIDGET D: Obsidian S3 Cloud Vault Reader */}
        <div className="p-4 rounded-2xl bg-[#121316] border border-[#22242a] shadow-sm flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between pb-3 border-b border-zinc-800/80 mb-3">
              <div className="flex items-center gap-2">
                <div className="w-6 h-6 rounded-md bg-purple-950/60 border border-purple-800/50 flex items-center justify-center text-purple-400">
                  <BookOpen className="w-3.5 h-3.5" />
                </div>
                <h3 className="text-xs font-semibold text-zinc-100">Obsidian 远程同步流 (阿里云 OSS)</h3>
              </div>
              <button
                onClick={() => onNavigateTab('obsidian')}
                className="text-xs text-zinc-400 hover:text-white flex items-center gap-1"
              >
                笔记库 <ArrowRight className="w-3 h-3" />
              </button>
            </div>

            <div className="space-y-2">
              {(state.obsidianNotes || []).length > 0 ? (
                (state.obsidianNotes || []).slice(0, 3).map((note) => (
                  <div
                    key={note.key}
                    onClick={() => onNavigateTab('obsidian')}
                    className="p-2.5 rounded-xl bg-zinc-900/60 border border-zinc-800/80 hover:border-zinc-700 cursor-pointer flex items-center justify-between gap-2 transition-colors"
                  >
                    <div className="min-w-0 flex-1 flex items-center gap-2">
                      <FileText className="w-3.5 h-3.5 text-purple-400 shrink-0" />
                      <span className="text-xs font-medium text-zinc-200 truncate">{note.title}</span>
                    </div>
                    <span className="text-[10px] text-zinc-400 font-mono shrink-0">
                      {new Date(note.lastModified).toLocaleDateString()}
                    </span>
                  </div>
                ))
              ) : (
                <div
                  onClick={() => onNavigateTab('obsidian')}
                  className="p-4 rounded-xl border border-dashed border-zinc-800/80 bg-zinc-900/30 text-center cursor-pointer hover:border-purple-800/50 transition-colors"
                >
                  <FileText className="w-5 h-5 text-zinc-600 mx-auto mb-1" />
                  <p className="text-xs text-zinc-400">暂无已同步的 Obsidian 笔记</p>
                  <p className="text-[11px] text-zinc-500 mt-0.5">点击前往「知识跨平台中枢」挂载阿里云 OSS 存储桶</p>
                </div>
              )}
            </div>
          </div>

          <div className="pt-3 border-t border-zinc-800/60 mt-3 flex items-center justify-between text-[11px] text-zinc-400 font-mono">
            <span>Bucket: {state.obsidianConfig.bucket || '未挂载'}</span>
            <span className="text-purple-400">增量实时挂载</span>
          </div>
        </div>

      </div>

    </div>
  );
};
