import React, { useState } from 'react';
import { isTabAllowed, type FeatureFlags } from '../lib/features';
import { 
  ShieldCheck, 
  Sparkles, 
  Search, 
  Plus, 
  Settings, 
  PenTool, 
  Layers, 
  CheckSquare, 
  BookOpen, 
  Lock, 
  Unlock, 
  Radio, 
  Menu, 
  X, 
  Clock, 
  FileText,
  Sun,
  Moon,
  Share2,
  Inbox,
  FolderKanban
} from 'lucide-react';

interface NavbarProps {
  activeTab: 'dashboard' | 'inbox' | 'projects' | 'sites' | 'servers' | 'secrets' | 'reminders' | 'notes' | 'checkin' | 'obsidian' | 'handwriting';
  setActiveTab: (tab: any) => void;
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
  reminderCount?: number;
  inboxCount?: number;
  projectCount?: number;
}

export const Navbar: React.FC<NavbarProps> = ({
  activeTab,
  setActiveTab,
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
  reminderCount,
  inboxCount,
  projectCount,
  features
}) => {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const allNavItems = [
    { id: 'dashboard', label: '仪表盘', icon: Layers, count: null },
    { id: 'inbox', label: '收件箱', icon: Inbox, count: inboxCount || null },
    { id: 'projects', label: '项目空间', icon: FolderKanban, count: projectCount || null },
    { id: 'reminders', label: '倒计时', icon: Clock, count: reminderCount },
    { id: 'sites', label: '网站', icon: Layers, count: siteCount },
    { id: 'servers', label: '部署', icon: Radio, count: serverCount },
    { id: 'secrets', label: '金库', icon: ShieldCheck, count: secretCount },
    { id: 'notes', label: '文档', icon: FileText, count: null },
    { id: 'checkin', label: '签到', icon: CheckSquare, count: null },
    { id: 'obsidian', label: '数据互通', icon: Share2, count: null },
    { id: 'handwriting', label: '画板', icon: PenTool, count: null },
  ];

  // Hidden modules disappear from the tab strip too.
  const navItems = allNavItems.filter((item) => isTabAllowed(item.id, features));

  return (
    <>
      <header className="sticky top-0 z-30 border-b border-[#1f2127] bg-[#090a0c]/90 backdrop-blur-md">
        <div className="max-w-7xl mx-auto px-3 sm:px-6 lg:px-8 h-14 sm:h-16 flex items-center justify-between gap-2 sm:gap-4">
          
          {/* Left: Branding & Domain Badge */}
          <div className="flex items-center gap-2 sm:gap-3 shrink-0">
            <div className="w-7 h-7 sm:w-8 sm:h-8 rounded-lg bg-zinc-900 border border-zinc-700/80 flex items-center justify-center text-zinc-100 font-semibold shadow-inner shrink-0">
              <span className="text-xs sm:text-sm tracking-tight font-mono">H</span>
            </div>
            <div className="flex items-center gap-1.5 sm:gap-2 min-w-0">
              <span className="font-semibold text-xs sm:text-sm tracking-tight text-zinc-100 whitespace-nowrap">Self-Hub</span>
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] sm:text-[10px] font-mono bg-zinc-800/80 text-zinc-400 border border-zinc-700/50 whitespace-nowrap">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse shrink-0"></span>
                <span className="truncate max-w-[90px] sm:max-w-none">Local-First</span>
              </span>
            </div>
          </div>

          {/* Right: Actions & Tools */}
          <div className="flex items-center gap-1 sm:gap-2 shrink-0">
            {/* Global Search Bar Trigger */}
            <button
              onClick={onOpenSearch}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-zinc-900 border border-zinc-800 text-xs text-zinc-400 hover:text-zinc-200 hover:border-zinc-700 transition-colors shadow-sm"
              title="全局极速定位 (Ctrl+K)"
            >
              <Search className="w-3.5 h-3.5 text-zinc-400 shrink-0" />
              <span className="hidden sm:inline whitespace-nowrap">搜索</span>
              <kbd className="hidden md:inline-block px-1 py-0.2 text-[9px] font-mono bg-zinc-800 rounded text-zinc-400 border border-zinc-700/60">
                Ctrl+K
              </kbd>
            </button>

            {/* AI Migration / Smart Ingestion Button */}
            <button
              onClick={onOpenAiIngest}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-zinc-100 text-zinc-900 font-semibold text-xs hover:bg-white transition-colors shadow-sm whitespace-nowrap"
              title="一键粘贴杂乱笔记让 AI 自动整理归类"
            >
              <Sparkles className="w-3.5 h-3.5 text-zinc-900 shrink-0" />
              <span className="hidden sm:inline">AI 整理</span>
            </button>

            {/* Light / Dark Mode Toggle Button */}
            <button
              onClick={onToggleTheme}
              className="p-1.5 rounded-lg bg-zinc-900 border border-zinc-800 text-zinc-400 hover:text-white transition-colors shrink-0"
              title={theme === 'dark' ? '切换为白天明亮模式' : '切换为黑夜暗色模式'}
            >
              {theme === 'dark' ? <Sun className="w-4 h-4 text-amber-400" /> : <Moon className="w-4 h-4 text-sky-400" />}
            </button>

            {/* Master Key Security Lock */}
            {isUnlocked ? (
              <button
                onClick={onLockVault}
                className="flex items-center gap-1 px-2 py-1.5 rounded-lg bg-emerald-950/40 border border-emerald-800/40 text-emerald-400 hover:bg-emerald-900/40 text-xs transition-colors whitespace-nowrap"
                title="已解锁，点击可一键锁定"
              >
                <Unlock className="w-3.5 h-3.5 shrink-0" />
                <span className="hidden md:inline">已解密</span>
              </button>
            ) : (
              <button
                onClick={onOpenMasterKeyModal}
                className="flex items-center gap-1 px-2 py-1.5 rounded-lg bg-amber-950/40 border border-amber-800/40 text-amber-400 hover:bg-amber-900/40 text-xs transition-colors whitespace-nowrap"
                title="已锁定，点击输入主密码解锁"
              >
                <Lock className="w-3.5 h-3.5 shrink-0" />
                <span className="hidden md:inline">金库锁</span>
              </button>
            )}

            {/* Add Item Button */}
            <button
              onClick={onOpenAddModal}
              className="p-1.5 rounded-lg bg-zinc-900 border border-zinc-800 text-zinc-300 hover:text-white hover:border-zinc-700 transition-colors shrink-0"
              title="手动添加新资产"
            >
              <Plus className="w-4 h-4" />
            </button>

            {/* Settings Button */}
            <button
              onClick={onOpenSettings}
              className="p-1.5 rounded-lg bg-zinc-900 border border-zinc-800 text-zinc-300 hover:text-white hover:border-zinc-700 transition-colors shrink-0"
              title="系统设置"
            >
              <Settings className="w-4 h-4" />
            </button>

            {/* Mobile Menu Toggle Button */}
            <button
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
              className="md:hidden p-1.5 rounded-lg bg-zinc-900 border border-zinc-800 text-zinc-300 hover:text-white shrink-0 ml-0.5"
              title="切换视图分类"
            >
              {mobileMenuOpen ? <X className="w-4 h-4" /> : <Menu className="w-4 h-4" />}
            </button>
          </div>

        </div>

        {/* Mobile Horizontal Category Bar (Always scrollable, smooth touch) */}
        <div className="md:hidden border-t border-[#1f2127] bg-[#0c0d10] px-3 py-1.5 overflow-x-auto scrollbar-none flex items-center gap-1.5">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = activeTab === item.id;
            return (
              <button
                key={item.id}
                onClick={() => {
                  setActiveTab(item.id);
                  setMobileMenuOpen(false);
                }}
                className={`px-3 py-1 text-xs font-medium rounded-lg transition-colors flex items-center gap-1.5 whitespace-nowrap shrink-0 ${
                  isActive
                    ? 'bg-zinc-800 text-zinc-100 shadow-sm border border-zinc-700/60'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                <Icon className="w-3 h-3 shrink-0" />
                <span>{item.label}</span>
                {item.count !== null && (
                  <span className="text-[10px] font-mono opacity-60">({item.count})</span>
                )}
              </button>
            );
          })}
        </div>
      </header>

      {/* Mobile Full Screen Drawer / Menu */}
      {mobileMenuOpen && (
        <div 
          onClick={() => setMobileMenuOpen(false)}
          className="md:hidden fixed inset-0 z-40 bg-black/80 backdrop-blur-sm pt-28 p-4"
        >
          <div 
            onClick={(e) => e.stopPropagation()}
            className="bg-[#121316] border border-zinc-800 rounded-2xl p-4 space-y-2 shadow-2xl"
          >
            <div className="text-xs font-semibold text-zinc-400 px-2 pb-2 border-b border-zinc-800 flex items-center justify-between">
              <span>切换视图分类</span>
              <button onClick={() => setMobileMenuOpen(false)}>
                <X className="w-4 h-4 text-zinc-400" />
              </button>
            </div>
            {navItems.map((item) => {
              const Icon = item.icon;
              const isActive = activeTab === item.id;
              return (
                <button
                  key={item.id}
                  onClick={() => {
                    setActiveTab(item.id);
                    setMobileMenuOpen(false);
                  }}
                  className={`w-full px-3 py-2.5 rounded-xl text-xs font-medium flex items-center justify-between transition-colors ${
                    isActive
                      ? 'bg-zinc-800 text-white font-semibold'
                      : 'text-zinc-300 hover:bg-zinc-900'
                  }`}
                >
                  <div className="flex items-center gap-2.5">
                    <Icon className="w-4 h-4 text-zinc-400" />
                    <span>{item.label}</span>
                  </div>
                  {item.count !== null && (
                    <span className="text-[11px] font-mono text-zinc-500">{item.count} 项</span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
};






