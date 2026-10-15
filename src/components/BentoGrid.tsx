import React, { useState } from 'react';
import { 
  Globe, 
  Server, 
  Key, 
  CheckSquare, 
  Play, 
  Sparkles, 
  BookOpen, 
  PenTool, 
  ShieldCheck, 
  Search,
  Plus,
  Lock
} from 'lucide-react';
import { HubState, HandwritingNote } from '../types';
import { SiteCard } from './cards/SiteCard';
import { ServerCard } from './cards/ServerCard';
import { SecretCard } from './cards/SecretCard';
import { CheckInCard } from './cards/CheckInCard';
import { HandwritingCard } from './cards/HandwritingCard';
import { ObsidianCard } from './cards/ObsidianCard';

interface BentoGridProps {
  state: HubState;
  activeTab: 'all' | 'sites' | 'servers' | 'secrets' | 'checkin' | 'obsidian' | 'handwriting';
  masterPassword: string | null;
  onRequireUnlock: () => void;
  onVisitSite: (id: string) => void;
  onDeleteSite: (id: string) => void;
  onDeleteServer: (id: string) => void;
  onDeleteSecret: (id: string) => void;
  onDeleteCheckIn: (id: string) => void;
  onRunCheckIn: (id: string) => Promise<void>;
  onRunAllCheckIns: () => Promise<void>;
  onSaveHandwriting: (note: HandwritingNote) => void;
  onDeleteHandwriting: (id: string) => void;
  onOpenAddModal: () => void;
  onOpenAiIngest: () => void;
  onOpenSettings: () => void;
}

export const BentoGrid: React.FC<BentoGridProps> = ({
  state,
  activeTab,
  masterPassword,
  onRequireUnlock,
  onVisitSite,
  onDeleteSite,
  onDeleteServer,
  onDeleteSecret,
  onDeleteCheckIn,
  onRunCheckIn,
  onRunAllCheckIns,
  onSaveHandwriting,
  onDeleteHandwriting,
  onOpenAddModal,
  onOpenAiIngest,
  onOpenSettings
}) => {
  const [selectedCategory, setSelectedCategory] = useState('全部');
  const [filterQuery, setFilterQuery] = useState('');
  const [batchCheckingIn, setBatchCheckingIn] = useState(false);

  // Filter sites
  const filteredSites = state.sites.filter(s => {
    const matchCat = selectedCategory === '全部' || s.category === selectedCategory;
    const matchQuery = !filterQuery || s.title.toLowerCase().includes(filterQuery.toLowerCase()) || s.url.toLowerCase().includes(filterQuery.toLowerCase());
    return matchCat && matchQuery;
  });

  // Stats
  const onlineServers = state.servers.filter(s => s.status === 'online').length;
  const completedCheckIns = state.checkIns.filter(c => c.lastStatus === 'success').length;

  const handleRunAll = async () => {
    setBatchCheckingIn(true);
    try {
      await onRunAllCheckIns();
    } finally {
      setBatchCheckingIn(false);
    }
  };

  return (
    <div className="max-w-7xl mx-auto px-3 sm:px-6 lg:px-8 py-4 sm:py-6 space-y-6 sm:space-y-8">
      
      {/* Top Command Metrics Bar (Zero awkward wrapping, perfectly responsive) */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5 sm:gap-3">
        <div className="p-3 sm:p-4 rounded-xl bg-[#121316] border border-[#22242a] shadow-sm flex flex-col justify-between">
          <div className="text-[10px] sm:text-xs text-zinc-400 font-medium truncate">常用网站与平台</div>
          <div className="flex items-baseline gap-1.5 mt-1">
            <span className="text-lg sm:text-2xl font-semibold text-zinc-100 font-mono">{state.sites.length}</span>
            <span className="text-[10px] sm:text-xs text-zinc-400">个收录</span>
          </div>
        </div>

        <div className="p-3 sm:p-4 rounded-xl bg-[#121316] border border-[#22242a] shadow-sm flex flex-col justify-between">
          <div className="text-[10px] sm:text-xs text-zinc-400 font-medium truncate">自研部署与节点</div>
          <div className="flex items-baseline gap-1.5 mt-1">
            <span className="text-lg sm:text-2xl font-semibold text-emerald-400 font-mono">
              {onlineServers}/{state.servers.length}
            </span>
            <span className="text-[10px] sm:text-xs text-emerald-500/80">正常</span>
          </div>
        </div>

        <div className="p-3 sm:p-4 rounded-xl bg-[#121316] border border-[#22242a] shadow-sm flex flex-col justify-between">
          <div className="text-[10px] sm:text-xs text-zinc-400 font-medium truncate">安全金库凭据</div>
          <div className="flex items-baseline gap-1.5 mt-1">
            <span className="text-lg sm:text-2xl font-semibold text-amber-400 font-mono">{state.secrets.length}</span>
            <span className="text-[10px] sm:text-xs text-amber-500/80">AES 加密</span>
          </div>
        </div>

        <div className="p-3 sm:p-4 rounded-xl bg-[#121316] border border-[#22242a] shadow-sm flex items-center justify-between">
          <div className="min-w-0 flex-1">
            <div className="text-[10px] sm:text-xs text-zinc-400 font-medium truncate">今日签到打卡</div>
            <div className="flex items-baseline gap-1.5 mt-1">
              <span className="text-lg sm:text-2xl font-semibold text-zinc-100 font-mono">
                {completedCheckIns}/{state.checkIns.length}
              </span>
              <span className="text-[10px] sm:text-xs text-zinc-400">已完成</span>
            </div>
          </div>
          <button
            onClick={handleRunAll}
            disabled={batchCheckingIn}
            className="px-2.5 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs flex items-center gap-1 font-medium transition-colors shrink-0 whitespace-nowrap ml-2"
          >
            <Play className={`w-3 h-3 shrink-0 ${batchCheckingIn ? 'animate-spin' : ''}`} />
            <span>{batchCheckingIn ? '执行中' : '全部签到'}</span>
          </button>
        </div>
      </div>

      {/* Category Filter Pills & Search Bar */}
      {(activeTab === 'all' || activeTab === 'sites') && (
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 bg-[#121316] p-2 sm:p-2.5 rounded-xl border border-[#22242a]">
          <div className="flex items-center gap-1 overflow-x-auto pb-1 sm:pb-0 scrollbar-none">
            {state.categories.map((cat) => (
              <button
                key={cat}
                onClick={() => setSelectedCategory(cat)}
                className={`px-3 py-1 rounded-lg text-xs font-medium whitespace-nowrap transition-colors shrink-0 ${
                  selectedCategory === cat
                    ? 'bg-zinc-100 text-zinc-900 shadow-sm'
                    : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/60'
                }`}
              >
                {cat}
              </button>
            ))}
          </div>

          <div className="relative w-full sm:w-64 shrink-0">
            <Search className="w-3.5 h-3.5 text-zinc-400 absolute left-2.5 top-2.5" />
            <input
              type="text"
              value={filterQuery}
              onChange={(e) => setFilterQuery(e.target.value)}
              placeholder="快速过滤当前网址..."
              className="w-full bg-zinc-900 border border-zinc-800 rounded-lg pl-8 pr-3 py-1 text-xs text-zinc-200 focus:outline-none focus:border-zinc-700"
            />
          </div>
        </div>
      )}

      {/* SECTION 1: Websites & Bookmarks */}
      {(activeTab === 'all' || activeTab === 'sites') && (
        <section className="space-y-3 sm:space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-xs sm:text-sm font-semibold text-zinc-100 flex items-center gap-2">
              <Globe className="w-4 h-4 text-sky-400 shrink-0" />
              <span>常用网站与平台导航</span>
              <span className="text-[11px] font-mono text-zinc-400">({filteredSites.length})</span>
            </h2>
            <div className="flex items-center gap-2">
              <button
                onClick={onOpenAiIngest}
                className="text-xs text-amber-400/90 hover:text-amber-300 flex items-center gap-1 whitespace-nowrap"
              >
                <Sparkles className="w-3 h-3 shrink-0" />
                <span className="hidden sm:inline">AI 批量整理</span>
              </button>
              <button
                onClick={onOpenAddModal}
                className="text-xs text-zinc-400 hover:text-zinc-200 flex items-center gap-1 whitespace-nowrap"
              >
                <Plus className="w-3 h-3 shrink-0" />
                <span>添加</span>
              </button>
            </div>
          </div>

          {filteredSites.length === 0 ? (
            <div className="p-8 text-center text-xs text-zinc-400 rounded-xl bg-[#121316] border border-[#22242a]">
              暂无匹配网站，可通过右上角【AI 整理】快速粘贴批量导入
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5 sm:gap-3.5">
              {filteredSites.map((site) => (
                <SiteCard
                  key={site.id}
                  site={site}
                  onVisit={onVisitSite}
                  onDelete={onDeleteSite}
                />
              ))}
            </div>
          )}
        </section>
      )}

      {/* SECTION 2: Servers & Deployments */}
      {(activeTab === 'all' || activeTab === 'servers') && (
        <section className="space-y-3 sm:space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-xs sm:text-sm font-semibold text-zinc-100 flex items-center gap-2">
              <Server className="w-4 h-4 text-emerald-400 shrink-0" />
              <span>自研项目部署与服务器资产</span>
              <span className="text-[11px] font-mono text-zinc-400">({state.servers.length})</span>
            </h2>
            <button
              onClick={onOpenAddModal}
              className="text-xs text-zinc-400 hover:text-zinc-200 flex items-center gap-1 whitespace-nowrap"
            >
              <Plus className="w-3 h-3 shrink-0" />
              <span>添加服务</span>
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5 sm:gap-3.5">
            {state.servers.map((server) => (
              <ServerCard
                key={server.id}
                server={server}
                onDelete={onDeleteServer}
              />
            ))}
          </div>
        </section>
      )}

      {/* SECTION 3: Encrypted Secrets Vault */}
      {(activeTab === 'all' || activeTab === 'secrets') && (
        <section className="space-y-3 sm:space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <h2 className="text-xs sm:text-sm font-semibold text-zinc-100 flex items-center gap-2">
                <ShieldCheck className="w-4 h-4 text-amber-400 shrink-0" />
                <span>零知识加密安全金库</span>
              </h2>
              <span className="text-[10px] sm:text-[11px] text-zinc-400 font-mono">
                ({state.secrets.length} 项)
              </span>
            </div>

            <div className="flex items-center gap-2">
              {!masterPassword && (
                <button
                  onClick={onRequireUnlock}
                  className="text-xs text-amber-400 hover:underline flex items-center gap-1 whitespace-nowrap"
                >
                  <Lock className="w-3 h-3 shrink-0" />
                  <span>解锁</span>
                </button>
              )}
              <button
                onClick={onOpenAddModal}
                className="text-xs text-zinc-400 hover:text-zinc-200 flex items-center gap-1 whitespace-nowrap"
              >
                <Plus className="w-3 h-3 shrink-0" />
                <span>录入</span>
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5 sm:gap-3.5">
            {state.secrets.map((secret) => (
              <SecretCard
                key={secret.id}
                secret={secret}
                masterPassword={masterPassword}
                onRequireUnlock={onRequireUnlock}
                onDelete={onDeleteSecret}
              />
            ))}
          </div>
        </section>
      )}

      {/* SECTION 4: Check-in Center */}
      {(activeTab === 'all' || activeTab === 'checkin') && (
        <section className="space-y-3 sm:space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-xs sm:text-sm font-semibold text-zinc-100 flex items-center gap-2">
              <CheckSquare className="w-4 h-4 text-emerald-400 shrink-0" />
              <span>一键自动化签到中心</span>
            </h2>
            <button
              onClick={onOpenAddModal}
              className="text-xs text-zinc-400 hover:text-zinc-200 flex items-center gap-1 whitespace-nowrap"
            >
              <Plus className="w-3 h-3 shrink-0" />
              <span>新建签到</span>
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5 sm:gap-3.5">
            {state.checkIns.map((task) => (
              <CheckInCard
                key={task.id}
                task={task}
                onRun={onRunCheckIn}
                onDelete={onDeleteCheckIn}
              />
            ))}
          </div>
        </section>
      )}

      {/* SECTION 5: Obsidian OSS Reader */}
      {(activeTab === 'all' || activeTab === 'obsidian') && (
        <ObsidianCard
          config={state.obsidianConfig}
          onOpenSettings={onOpenSettings}
        />
      )}

      {/* SECTION 6: Handwriting Scribble Canvas */}
      {(activeTab === 'all' || activeTab === 'handwriting') && (
        <HandwritingCard
          onSaveNote={onSaveHandwriting}
          savedNotes={state.handwritings}
          onDeleteNote={onDeleteHandwriting}
        />
      )}

    </div>
  );
};
