import React from 'react';
import { isTabAllowed, type FeatureFlags } from '../lib/features';
import { 
  LayoutDashboard, 
  Globe, 
  Server, 
  ShieldCheck, 
  CheckSquare, 
  BookOpen, 
  PenTool, 
  Sparkles, 
  Settings, 
  Search, 
  Lock, 
  Unlock, 
  Plus, 
  ChevronLeft, 
  ChevronRight,
  Clock,
  FileText,
  Sun,
  Moon,
  Share2,
  Inbox,
  FolderKanban
} from 'lucide-react';

interface SidebarProps {
  activeTab: 'dashboard' | 'inbox' | 'projects' | 'sites' | 'servers' | 'secrets' | 'reminders' | 'notes' | 'checkin' | 'obsidian' | 'handwriting';
  setActiveTab: (tab: any) => void;
  collapsed: boolean;
  setCollapsed: (c: boolean) => void;
  theme: 'dark' | 'light';
  onToggleTheme: () => void;
  onOpenSearch: () => void;
  onOpenAiIngest: () => void;
  onOpenAddModal: () => void;
  onOpenSettings: () => void;
  onOpenMasterKeyModal: () => void;
  isUnlocked: boolean;
  onLockVault: () => void;
  siteCount: number;
  features?: Partial<FeatureFlags>;
  serverCount: number;
  secretCount: number;
  checkInCount: number;
  reminderCount: number;
  notesCount: number;
  inboxCount?: number;
  projectCount?: number;
}

export const Sidebar: React.FC<SidebarProps> = ({
  activeTab,
  setActiveTab,
  collapsed,
  setCollapsed,
  theme,
  onToggleTheme,
  onOpenSearch,
  onOpenAiIngest,
  onOpenAddModal,
  onOpenSettings,
  onOpenMasterKeyModal,
  isUnlocked,
  onLockVault,
  siteCount,
  serverCount,
  secretCount,
  checkInCount,
  reminderCount,
  notesCount,
  inboxCount = 0,
  projectCount = 0,
  features
}) => {
  const allItems = [
    { id: 'dashboard', label: '仪表盘总览', icon: LayoutDashboard, badge: null },
    { id: 'inbox', label: '统一收件箱', icon: Inbox, badge: inboxCount > 0 ? `${inboxCount}待办` : null },
    { id: 'projects', label: '自研项目空间', icon: FolderKanban, badge: projectCount > 0 ? projectCount : null },
    { id: 'reminders', label: '倒计时与续费', icon: Clock, badge: reminderCount },
    { id: 'sites', label: '网站与工作台', icon: Globe, badge: siteCount },
    { id: 'servers', label: '自研部署与主机', icon: Server, badge: serverCount },
    { id: 'secrets', label: '加密安全金库', icon: ShieldCheck, badge: secretCount },
    { id: 'notes', label: '深度知识文档', icon: FileText, badge: notesCount },
    { id: 'checkin', label: '自动化与打卡', icon: CheckSquare, badge: checkInCount },
    { id: 'obsidian', label: '多平台数据互通', icon: Share2, badge: 'OSS·五彩' },
    { id: 'handwriting', label: '交互手绘白板', icon: PenTool, badge: null },
  ];
  // Modules switched off in settings disappear from the sidebar entirely.
  const menuItems = allItems.filter((item) => isTabAllowed(item.id, features));

  return (
    <aside
      className={`hidden md:flex flex-col justify-between shrink-0 border-r border-[#1e2026] bg-[#0c0d10] transition-all duration-200 z-30 select-none ${
        collapsed ? 'w-16' : 'w-60'
      }`}
    >
      {/* Top Brand Header */}
      <div>
        <div className="h-16 px-4 flex items-center justify-between border-b border-[#1e2026]">
          {!collapsed ? (
            <div className="flex items-center gap-2.5 min-w-0">
              <div className="w-8 h-8 rounded-lg bg-zinc-900 border border-zinc-700/80 flex items-center justify-center text-zinc-100 font-semibold shadow-inner shrink-0">
                <span className="text-sm font-mono">H</span>
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="font-semibold text-sm tracking-tight text-zinc-100">Self-Hub</span>
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></span>
                </div>
                <div className="text-[10px] text-zinc-400 font-mono truncate">
                  v2.0 · Local-First
                </div>
              </div>
            </div>
          ) : (
            <div className="mx-auto w-8 h-8 rounded-lg bg-zinc-900 border border-zinc-700/80 flex items-center justify-center text-zinc-100 font-semibold shadow-inner">
              <span className="text-sm font-mono">H</span>
            </div>
          )}

          <button
            onClick={() => setCollapsed(!collapsed)}
            className="p-1 rounded-lg hover:bg-zinc-800 text-zinc-400 hover:text-white transition-colors"
            title={collapsed ? '展开侧边栏' : '收起侧边栏'}
          >
            {collapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
          </button>
        </div>

        {/* Global Quick Action Strip */}
        <div className="p-3 border-b border-[#1e2026] space-y-1.5">
          <button
            onClick={onOpenSearch}
            className={`w-full flex items-center gap-2 px-3 py-2 rounded-xl bg-zinc-900/90 border border-zinc-800 text-xs text-zinc-400 hover:text-zinc-200 hover:border-zinc-700 transition-colors shadow-sm ${
              collapsed ? 'justify-center px-0' : 'justify-between'
            }`}
            title="强力拼音/全文检索 (Ctrl+K)"
          >
            <div className="flex items-center gap-2 min-w-0">
              <Search className="w-3.5 h-3.5 text-zinc-400 shrink-0" />
              {!collapsed && <span className="truncate">极速定位...</span>}
            </div>
            {!collapsed && (
              <kbd className="px-1.5 py-0.5 text-[9px] font-mono bg-zinc-800 rounded text-zinc-400 border border-zinc-700">
                Ctrl+K
              </kbd>
            )}
          </button>

          <button
            onClick={onOpenAiIngest}
            className={`w-full flex items-center gap-2 px-3 py-2 rounded-xl bg-zinc-100 text-zinc-900 font-semibold text-xs hover:bg-white transition-colors shadow-sm ${
              collapsed ? 'justify-center px-0' : ''
            }`}
            title="AI 智能分拣杂乱数据"
          >
            <Sparkles className="w-3.5 h-3.5 shrink-0" />
            {!collapsed && <span>AI 智能分拣入库</span>}
          </button>
        </div>

        {/* Navigation Workspaces List */}
        <nav className="p-2 space-y-1">
          {menuItems.map((item) => {
            const Icon = item.icon;
            const isActive = activeTab === item.id;
            return (
              <button
                key={item.id}
                onClick={() => setActiveTab(item.id)}
                className={`w-full flex items-center gap-3 px-3 py-2 rounded-xl text-xs font-medium transition-all ${
                  collapsed ? 'justify-center px-0' : 'justify-between'
                } ${
                  isActive
                    ? 'bg-zinc-800 text-white font-semibold shadow-sm border border-zinc-700/60'
                    : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900'
                }`}
                title={collapsed ? item.label : undefined}
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  <Icon className={`w-4 h-4 shrink-0 ${isActive ? 'text-zinc-100' : 'text-zinc-400'}`} />
                  {!collapsed && <span className="truncate">{item.label}</span>}
                </div>
                {!collapsed && item.badge !== null && (
                  <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-zinc-900 text-zinc-400 border border-zinc-800">
                    {item.badge}
                  </span>
                )}
              </button>
            );
          })}
        </nav>
      </div>

      {/* Bottom Profile / Vault Status, Theme & Settings */}
      <div className="p-3 border-t border-[#1e2026] space-y-2">
        {/* Security Vault Status Pill */}
        {isUnlocked ? (
          <button
            onClick={onLockVault}
            className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-xl bg-emerald-950/30 border border-emerald-800/40 text-emerald-400 hover:bg-emerald-900/30 text-xs transition-colors ${
              collapsed ? 'justify-center px-0' : 'justify-between'
            }`}
            title="受信任设备已解密，点击一键锁定"
          >
            <div className="flex items-center gap-2">
              <Unlock className="w-3.5 h-3.5 shrink-0" />
              {!collapsed && <span>金库已解密</span>}
            </div>
            {!collapsed && <span className="text-[10px] text-emerald-500/80">点击锁定</span>}
          </button>
        ) : (
          <button
            onClick={onOpenMasterKeyModal}
            className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-xl bg-amber-950/30 border border-amber-800/40 text-amber-400 hover:bg-amber-900/30 text-xs transition-colors ${
              collapsed ? 'justify-center px-0' : 'justify-between'
            }`}
            title="安全金库已锁定，点击解锁"
          >
            <div className="flex items-center gap-2">
              <Lock className="w-3.5 h-3.5 shrink-0" />
              {!collapsed && <span>金库锁定中</span>}
            </div>
            {!collapsed && <span className="text-[10px] text-amber-500/80">输入密码</span>}
          </button>
        )}

        {/* Quick Add, Light/Dark Mode Toggle & System Settings */}
        <div className={`flex items-center gap-1.5 ${collapsed ? 'flex-col' : ''}`}>
          <button
            onClick={onOpenAddModal}
            className={`flex-1 flex items-center gap-2 px-3 py-1.5 rounded-xl bg-zinc-900 border border-zinc-800 text-zinc-300 hover:text-white hover:border-zinc-700 text-xs transition-colors ${
              collapsed ? 'w-full justify-center px-0 py-2' : ''
            }`}
            title="手动新建资产"
          >
            <Plus className="w-4 h-4 shrink-0" />
            {!collapsed && <span>新建资产</span>}
          </button>

          {/* Light / Dark Mode Toggle */}
          <button
            onClick={onToggleTheme}
            className="p-1.5 rounded-xl bg-zinc-900 border border-zinc-800 text-zinc-400 hover:text-white hover:border-zinc-700 transition-colors shrink-0"
            title={theme === 'dark' ? '切换为白天明亮模式' : '切换为黑夜暗色模式'}
          >
            {theme === 'dark' ? <Sun className="w-4 h-4 text-amber-400" /> : <Moon className="w-4 h-4 text-sky-400" />}
          </button>

          <button
            onClick={onOpenSettings}
            className="p-1.5 rounded-xl bg-zinc-900 border border-zinc-800 text-zinc-400 hover:text-white hover:border-zinc-700 transition-colors shrink-0"
            title="系统设置与云端集成"
          >
            <Settings className="w-4 h-4" />
          </button>
        </div>
      </div>
    </aside>
  );
};






