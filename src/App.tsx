import React, { useState, useEffect } from 'react';
import { HubState, NavSite, ServerDeployment, SecretItem, CheckInTask, QuickNote, HandwritingNote, ReminderItem, InboxItem, ProjectItem } from './types';
import { loadHubState, saveHubState } from './lib/storage';
import { getTrustedSession, clearTrustedSession } from './lib/crypto';
import { Sidebar } from './components/Sidebar';
import { Navbar } from './components/Navbar';
import { DashboardOverview } from './components/views/DashboardOverview';
import { SitesView } from './components/views/SitesView';
import { RemindersView } from './components/views/RemindersView';
import { NotesView } from './components/views/NotesView';
import { InboxView } from './components/views/InboxView';
import { ProjectsView } from './components/views/ProjectsView';
import { ServerCard } from './components/cards/ServerCard';
import { SecretCard } from './components/cards/SecretCard';
import { CheckInCard } from './components/cards/CheckInCard';
import { HandwritingCard } from './components/cards/HandwritingCard';
import { ObsidianCard } from './components/cards/ObsidianCard';
import { DataInteropView } from './components/views/DataInteropView';
import { GlobalSearch } from './components/GlobalSearch';
import { AiIngestModal } from './components/modals/AiIngestModal';
import { MasterKeyModal } from './components/modals/MasterKeyModal';
import { AddItemModal } from './components/modals/AddItemModal';
import { SettingsModal } from './components/modals/SettingsModal';
import { executeCheckIn } from './lib/automation';
import { Server, ShieldCheck, CheckSquare, Plus, Lock } from 'lucide-react';

export function App() {
  const [state, setState] = useState<HubState>(() => loadHubState());
  const [activeTab, setActiveTab] = useState<'dashboard' | 'inbox' | 'projects' | 'sites' | 'servers' | 'secrets' | 'reminders' | 'notes' | 'checkin' | 'obsidian' | 'handwriting'>('dashboard');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [masterPassword, setMasterPassword] = useState<string | null>(null);

  // Modals state
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [isAiIngestOpen, setIsAiIngestOpen] = useState(false);
  const [isMasterKeyOpen, setIsMasterKeyOpen] = useState(false);
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);

  // Check trusted device session on mount (auto-unlock on user's authorized browser!)
  useEffect(() => {
    const session = getTrustedSession();
    if (session.isValid && session.password) {
      setMasterPassword(session.password);
    }
  }, []);

  // Sync theme class to document root
  useEffect(() => {
    const isDark = (state.theme || 'dark') === 'dark';
    document.documentElement.classList.toggle('dark', isDark);
  }, [state.theme]);

  const handleToggleTheme = () => {
    const nextTheme = (state.theme || 'dark') === 'dark' ? 'light' : 'dark';
    updateState((prev) => ({ ...prev, theme: nextTheme }));
    document.documentElement.classList.toggle('dark', nextTheme === 'dark');
  };

  // Sync state changes to local storage
  const updateState = (updater: (prev: HubState) => HubState) => {
    setState((prev) => {
      const next = updater(prev);
      saveHubState(next);
      return next;
    });
  };

  // Keyboard shortcut listener (Ctrl+K / Cmd+K)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setIsSearchOpen((prev) => !prev);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Ensure window resets scroll position when switching tabs
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'instant' });
  }, [activeTab]);

  // Handlers for adding and mutating assets
  const handleAddSite = (site: NavSite) => {
    updateState((prev) => ({
      ...prev,
      sites: [site, ...prev.sites]
    }));
  };

  const handleDeleteSite = (id: string) => {
    updateState((prev) => ({
      ...prev,
      sites: prev.sites.filter((s) => s.id !== id)
    }));
  };

  const handleVisitSite = (id: string) => {
    updateState((prev) => ({
      ...prev,
      sites: prev.sites.map((s) =>
        s.id === id ? { ...s, visitCount: (s.visitCount || 0) + 1, lastVisited: Date.now() } : s
      )
    }));
  };

  const handleImportBookmarks = (newSites: NavSite[]) => {
    updateState((prev) => ({
      ...prev,
      sites: [...newSites, ...prev.sites]
    }));
  };

  const handleAddServer = (server: ServerDeployment) => {
    updateState((prev) => ({
      ...prev,
      servers: [server, ...prev.servers]
    }));
  };

  const handleDeleteServer = (id: string) => {
    updateState((prev) => ({
      ...prev,
      servers: prev.servers.filter((s) => s.id !== id)
    }));
  };

  const handleAddSecret = (secret: SecretItem) => {
    updateState((prev) => ({
      ...prev,
      secrets: [secret, ...prev.secrets]
    }));
  };

  const handleDeleteSecret = (id: string) => {
    updateState((prev) => ({
      ...prev,
      secrets: prev.secrets.filter((s) => s.id !== id)
    }));
  };

  const handleAddCheckIn = (task: CheckInTask) => {
    updateState((prev) => ({
      ...prev,
      checkIns: [task, ...prev.checkIns]
    }));
  };

  const handleDeleteCheckIn = (id: string) => {
    updateState((prev) => ({
      ...prev,
      checkIns: prev.checkIns.filter((c) => c.id !== id)
    }));
  };

  const handleRunCheckIn = async (id: string) => {
    const task = state.checkIns.find((c) => c.id === id);
    if (!task) return;

    const result = await executeCheckIn(task);

    updateState((prev) => ({
      ...prev,
      checkIns: prev.checkIns.map((c) =>
        c.id === id
          ? {
              ...c,
              lastRun: Date.now(),
              lastStatus: result.success ? 'success' : 'failed',
              lastMessage: result.message,
              streakDays: result.success ? (c.streakDays || 0) + 1 : c.streakDays
            }
          : c
      )
    }));
  };

  const handleRunAllCheckIns = async () => {
    for (const task of state.checkIns) {
      await handleRunCheckIn(task.id);
    }
  };

  const handleSaveHandwriting = (note: HandwritingNote) => {
    updateState((prev) => ({
      ...prev,
      handwritings: [note, ...prev.handwritings]
    }));
  };

  const handleDeleteHandwriting = (id: string) => {
    updateState((prev) => ({
      ...prev,
      handwritings: prev.handwritings.filter((h) => h.id !== id)
    }));
  };

  const handleAddReminder = (reminder: ReminderItem) => {
    updateState((prev) => ({
      ...prev,
      reminders: [reminder, ...(prev.reminders || [])]
    }));
  };

  const handleDeleteReminder = (id: string) => {
    updateState((prev) => ({
      ...prev,
      reminders: (prev.reminders || []).filter((r) => r.id !== id)
    }));
  };

  const handleUpdateReminder = (reminder: ReminderItem) => {
    updateState((prev) => ({
      ...prev,
      reminders: (prev.reminders || []).map((r) => (r.id === reminder.id ? reminder : r))
    }));
  };

  const handleToggleReminderComplete = (id: string) => {
    updateState((prev) => ({
      ...prev,
      reminders: (prev.reminders || []).map((r) =>
        r.id === id ? { ...r, completed: !r.completed } : r
      )
    }));
  };

  const handleAddNote = (note: QuickNote) => {
    updateState((prev) => ({
      ...prev,
      notes: [note, ...(prev.notes || [])]
    }));
  };

  const handleUpdateNote = (note: QuickNote) => {
    updateState((prev) => ({
      ...prev,
      notes: (prev.notes || []).map((n) => (n.id === note.id ? note : n))
    }));
  };

  const handleDeleteNote = (id: string) => {
    updateState((prev) => ({
      ...prev,
      notes: (prev.notes || []).filter((n) => n.id !== id)
    }));
  };

  // Inbox Handlers (N07)
  const handleAddInboxItem = (item: InboxItem) => {
    updateState((prev) => ({
      ...prev,
      inbox: [item, ...(prev.inbox || [])]
    }));
  };

  const handleUpdateInboxItem = (item: InboxItem) => {
    updateState((prev) => ({
      ...prev,
      inbox: (prev.inbox || []).map((i) => (i.id === item.id ? item : i))
    }));
  };

  const handleDeleteInboxItem = (id: string) => {
    updateState((prev) => ({
      ...prev,
      inbox: (prev.inbox || []).filter((i) => i.id !== id)
    }));
  };

  const handleConvertToNoteFromInbox = (item: InboxItem) => {
    const newNote: QuickNote = {
      id: `note-${Date.now()}`,
      title: item.title || (item.content.length > 20 ? item.content.slice(0, 20) + '...' : item.content),
      content: item.content + (item.url ? `\n\n来源链接: ${item.url}` : ''),
      category: '速记',
      tags: ['收件箱转化'],
      updatedAt: Date.now()
    };
    updateState((prev) => ({
      ...prev,
      notes: [newNote, ...(prev.notes || [])],
      inbox: (prev.inbox || []).map((i) => i.id === item.id ? { ...i, status: 'processed', targetType: 'note', targetId: newNote.id } : i)
    }));
  };

  const handleConvertToSiteFromInbox = (item: InboxItem) => {
    const targetUrl = item.url || (item.content.startsWith('http') ? item.content : `https://${item.content}`);
    const newSite: NavSite = {
      id: `site-${Date.now()}`,
      title: item.title || '收件箱新存网址',
      url: targetUrl,
      category: '常用推荐',
      description: item.content !== targetUrl ? item.content : '从统一收件箱快速收藏',
      icon: 'Globe',
      createdAt: Date.now()
    };
    updateState((prev) => ({
      ...prev,
      sites: [newSite, ...prev.sites],
      inbox: (prev.inbox || []).map((i) => i.id === item.id ? { ...i, status: 'processed', targetType: 'site', targetId: newSite.id } : i)
    }));
  };

  const handleAssignToProject = (itemId: string, projectId: string) => {
    updateState((prev) => ({
      ...prev,
      inbox: (prev.inbox || []).map((i) => i.id === itemId ? { ...i, targetType: 'project', targetId: projectId, status: 'processed' } : i)
    }));
  };

  // Projects Handlers (N08)
  const handleAddProject = (project: ProjectItem) => {
    updateState((prev) => ({
      ...prev,
      projects: [project, ...(prev.projects || [])]
    }));
  };

  const handleUpdateProject = (project: ProjectItem) => {
    updateState((prev) => ({
      ...prev,
      projects: (prev.projects || []).map((p) => (p.id === project.id ? project : p))
    }));
  };

  const handleDeleteProject = (id: string) => {
    updateState((prev) => ({
      ...prev,
      projects: (prev.projects || []).filter((p) => p.id !== id)
    }));
  };

  const handleBatchImport = (data: {
    sites: NavSite[];
    servers: ServerDeployment[];
    secrets: SecretItem[];
    notes: QuickNote[];
    reminders: ReminderItem[];
  }) => {
    updateState((prev) => ({
      ...prev,
      sites: [...data.sites, ...prev.sites],
      servers: [...data.servers, ...prev.servers],
      secrets: [...data.secrets, ...prev.secrets],
      notes: [...data.notes, ...(prev.notes || [])],
      reminders: [...data.reminders, ...(prev.reminders || [])]
    }));
  };

  const handleLockVault = () => {
    setMasterPassword(null);
    clearTrustedSession();
  };

  return (
    <div className="flex h-screen overflow-hidden bg-[#090a0c] text-zinc-100 font-sans selection:bg-zinc-800">
      
      {/* Left Linear-style Navigation Dock */}
      <Sidebar
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        collapsed={sidebarCollapsed}
        setCollapsed={setSidebarCollapsed}
        theme={state.theme || 'dark'}
        onToggleTheme={handleToggleTheme}
        onOpenSearch={() => setIsSearchOpen(true)}
        onOpenAiIngest={() => setIsAiIngestOpen(true)}
        onOpenAddModal={() => setIsAddModalOpen(true)}
        onOpenSettings={() => setIsSettingsOpen(true)}
        onOpenMasterKeyModal={() => setIsMasterKeyOpen(true)}
        isUnlocked={Boolean(masterPassword)}
        onLockVault={handleLockVault}
        siteCount={state.sites.length}
        serverCount={state.servers.length}
        secretCount={state.secrets.length}
        checkInCount={state.checkIns.length}
        reminderCount={(state.reminders || []).length}
        notesCount={(state.notes || []).length}
        inboxCount={(state.inbox || []).filter((i) => i.status === 'inbox').length}
        projectCount={(state.projects || []).length}
      />

      {/* Main Command Workspace */}
      <div className="flex-1 flex flex-col min-w-0 overflow-y-auto">
        <Navbar
          activeTab={activeTab === 'dashboard' ? 'all' : (activeTab as any)}
          setActiveTab={(t) => setActiveTab(t === 'all' ? 'dashboard' : t)}
          theme={state.theme || 'dark'}
          onToggleTheme={handleToggleTheme}
          onOpenSearch={() => setIsSearchOpen(true)}
          onOpenAiIngest={() => setIsAiIngestOpen(true)}
          onOpenAddModal={() => setIsAddModalOpen(true)}
          onOpenSettings={() => setIsSettingsOpen(true)}
          onOpenMasterKeyModal={() => setIsMasterKeyOpen(true)}
          isUnlocked={Boolean(masterPassword)}
          onLockVault={handleLockVault}
          siteCount={state.sites.length}
          serverCount={state.servers.length}
          secretCount={state.secrets.length}
          reminderCount={(state.reminders || []).length}
          inboxCount={(state.inbox || []).filter((i) => i.status === 'inbox').length}
          projectCount={(state.projects || []).length}
        />

        <main className="flex-1 p-3 sm:p-6 lg:p-8 max-w-7xl w-full mx-auto">
          {/* VIEW 1: Dashboard Overview (Bento Command Center) */}
          {activeTab === 'dashboard' && (
            <DashboardOverview
              state={state}
              onNavigateTab={(tab) => setActiveTab(tab)}
              masterPassword={masterPassword}
              onRequireUnlock={() => setIsMasterKeyOpen(true)}
              onVisitSite={handleVisitSite}
              onRunCheckIn={handleRunCheckIn}
              onRunAllCheckIns={handleRunAllCheckIns}
            />
          )}

          {/* VIEW: Unified Inbox (N07) */}
          {activeTab === 'inbox' && (
            <InboxView
              inbox={state.inbox || []}
              onAddInboxItem={handleAddInboxItem}
              onUpdateInboxItem={handleUpdateInboxItem}
              onDeleteInboxItem={handleDeleteInboxItem}
              onConvertToNote={handleConvertToNoteFromInbox}
              onConvertToSite={handleConvertToSiteFromInbox}
              projects={state.projects || []}
              onAssignToProject={handleAssignToProject}
            />
          )}

          {/* VIEW: Projects Workspace (N08) */}
          {activeTab === 'projects' && (
            <ProjectsView
              projects={state.projects || []}
              notes={state.notes || []}
              sites={state.sites || []}
              servers={state.servers || []}
              reminders={state.reminders || []}
              onAddProject={handleAddProject}
              onUpdateProject={handleUpdateProject}
              onDeleteProject={handleDeleteProject}
              onNavigateTab={(tab) => setActiveTab(tab as any)}
            />
          )}

          {/* VIEW 2: Sites & Bookmarks Workspace (Dense List / Grid / Folders) */}
          {activeTab === 'sites' && (
            <SitesView
              sites={state.sites}
              categories={state.categories}
              onVisit={handleVisitSite}
              onDelete={handleDeleteSite}
              onOpenAddModal={() => setIsAddModalOpen(true)}
              onOpenAiIngest={() => setIsAiIngestOpen(true)}
              onImportBookmarks={handleImportBookmarks}
            />
          )}

          {/* VIEW 3: Servers & Deployments Workspace */}
          {activeTab === 'servers' && (
            <div className="space-y-4">
              <div className="flex items-center justify-between bg-[#121316] p-4 rounded-2xl border border-[#22242a]">
                <div>
                  <h2 className="text-sm font-semibold text-zinc-100 flex items-center gap-2">
                    <Server className="w-4 h-4 text-emerald-400" />
                    自研项目部署与服务器主机 ({state.servers.length})
                  </h2>
                  <p className="text-xs text-zinc-400 mt-0.5">监控健康状态、公网IP/端口与一键快速唤起 SSH 连接</p>
                </div>
                <button
                  onClick={() => setIsAddModalOpen(true)}
                  className="px-3 py-1.5 rounded-xl bg-zinc-100 text-zinc-900 font-semibold text-xs flex items-center gap-1.5 shadow-sm hover:bg-white"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>添加服务</span>
                </button>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3.5">
                {state.servers.map((server) => (
                  <ServerCard key={server.id} server={server} onDelete={handleDeleteServer} />
                ))}
              </div>
            </div>
          )}

          {/* VIEW 4: Security Vault Workspace */}
          {activeTab === 'secrets' && (
            <div className="space-y-4">
              <div className="flex items-center justify-between bg-[#121316] p-4 rounded-2xl border border-[#22242a]">
                <div>
                  <h2 className="text-sm font-semibold text-zinc-100 flex items-center gap-2">
                    <ShieldCheck className="w-4 h-4 text-amber-400" />
                    零知识加密安全金库 ({state.secrets.length})
                  </h2>
                  <p className="text-xs text-zinc-400 mt-0.5">API Key、Token、服务器密码通过 PBKDF2 + AES-256-GCM 客户端加密保护</p>
                </div>
                <div className="flex items-center gap-2">
                  {!masterPassword && (
                    <button
                      onClick={() => setIsMasterKeyOpen(true)}
                      className="px-3 py-1.5 rounded-xl bg-amber-950/60 border border-amber-800/60 text-amber-400 text-xs flex items-center gap-1.5 font-medium"
                    >
                      <Lock className="w-3.5 h-3.5" />
                      <span>解锁金库</span>
                    </button>
                  )}
                  <button
                    onClick={() => setIsAddModalOpen(true)}
                    className="px-3 py-1.5 rounded-xl bg-zinc-100 text-zinc-900 font-semibold text-xs flex items-center gap-1.5 shadow-sm hover:bg-white"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>新建凭据</span>
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3.5">
                {state.secrets.map((secret) => (
                  <SecretCard
                    key={secret.id}
                    secret={secret}
                    masterPassword={masterPassword}
                    onRequireUnlock={() => setIsMasterKeyOpen(true)}
                    onDelete={handleDeleteSecret}
                  />
                ))}
              </div>
            </div>
          )}

          {/* VIEW 5: Reminders & Subscriptions Countdown Workspace */}
          {activeTab === 'reminders' && (
            <RemindersView
              reminders={state.reminders || []}
              onAddReminder={handleAddReminder}
              onUpdateReminder={handleUpdateReminder}
              onDeleteReminder={handleDeleteReminder}
              onToggleComplete={handleToggleReminderComplete}
            />
          )}

          {/* VIEW 6: Rich Knowledge Notes Workspace */}
          {activeTab === 'notes' && (
            <NotesView
              notes={state.notes || []}
              onAddNote={handleAddNote}
              onUpdateNote={handleUpdateNote}
              onDeleteNote={handleDeleteNote}
            />
          )}

          {/* VIEW 7: Automation & Check-in Workspace */}
          {activeTab === 'checkin' && (
            <div className="space-y-4">
              <div className="flex items-center justify-between bg-[#121316] p-4 rounded-2xl border border-[#22242a]">
                <div>
                  <h2 className="text-sm font-semibold text-zinc-100 flex items-center gap-2">
                    <CheckSquare className="w-4 h-4 text-sky-400" />
                    自动化签到与打卡中心 ({state.checkIns.length})
                  </h2>
                  <p className="text-xs text-zinc-400 mt-0.5">支持真实 HTTP 请求打卡与油猴自动化模拟点击脚本一键生成</p>
                </div>
                <button
                  onClick={() => setIsAddModalOpen(true)}
                  className="px-3 py-1.5 rounded-xl bg-zinc-100 text-zinc-900 font-semibold text-xs flex items-center gap-1.5 shadow-sm hover:bg-white"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>新建签到</span>
                </button>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3.5">
                {state.checkIns.map((task) => (
                  <CheckInCard key={task.id} task={task} onRun={handleRunCheckIn} onDelete={handleDeleteCheckIn} />
                ))}
              </div>
            </div>
          )}

          {/* VIEW 6: Multi-Platform Data Interop (Obsidian OSS + Wucai + Youdao) */}
          {activeTab === 'obsidian' && (
            <DataInteropView
              obsidianConfig={state.obsidianConfig}
              obsidianNotes={state.obsidianNotes || []}
              onUpdateObsidianNotes={(notes) => updateState((prev) => ({ ...prev, obsidianNotes: notes }))}
              wucaiConfig={state.wucaiConfig || { enabled: true, token: '' }}
              wucaiHighlights={state.wucaiHighlights || []}
              onUpdateWucaiHighlights={(hl) => updateState((prev) => ({ ...prev, wucaiHighlights: hl }))}
              onUpdateWucaiConfig={(cfg) => updateState((prev) => ({ ...prev, wucaiConfig: cfg }))}
              youdaoConfig={state.youdaoConfig || { enabled: true, token: '' }}
              youdaoNotes={state.youdaoNotes || []}
              onUpdateYoudaoNotes={(yd) => updateState((prev) => ({ ...prev, youdaoNotes: yd }))}
              onUpdateYoudaoConfig={(cfg) => updateState((prev) => ({ ...prev, youdaoConfig: cfg }))}
              onAddQuickNote={handleAddNote}
              onOpenSettings={() => setIsSettingsOpen(true)}
            />
          )}

          {/* VIEW 7: Handwriting & Scribble Canvas */}
          {activeTab === 'handwriting' && (
            <HandwritingCard
              onSaveNote={handleSaveHandwriting}
              savedNotes={state.handwritings}
              onDeleteNote={handleDeleteHandwriting}
            />
          )}
        </main>

        {/* Footer */}
        <footer className="border-t border-[#18191e] py-4 text-center text-xs text-zinc-400 font-mono">
          <div className="flex items-center justify-center gap-3">
            <span>Self-Hub · Local-First</span>
            <span>•</span>
            <span>Zero-Knowledge AES-256</span>
            <span>•</span>
            <span>Local IndexedDB + Storage</span>
          </div>
        </footer>
      </div>

      {/* Global Modals */}
      <GlobalSearch
        isOpen={isSearchOpen}
        onClose={() => setIsSearchOpen(false)}
        sites={state.sites}
        servers={state.servers}
        secrets={state.secrets}
        notes={state.notes || []}
        reminders={state.reminders || []}
        obsidianNotes={state.obsidianNotes || []}
        projects={state.projects || []}
        inbox={state.inbox || []}
        masterPassword={masterPassword}
        onRequireUnlock={() => setIsMasterKeyOpen(true)}
        onSelectSite={(url) => window.open(url, '_blank')}
        onSelectServer={(srv) => {
          navigator.clipboard.writeText(srv.sshCommand || `ssh ${srv.sshUser || 'root'}@${srv.publicIp}`);
          alert(`已复制服务器 SSH 命令: ${srv.sshCommand}`);
        }}
        onSelectNote={() => {
          setActiveTab('notes');
          setIsSearchOpen(false);
        }}
        onSelectProject={() => {
          setActiveTab('projects');
          setIsSearchOpen(false);
        }}
        onSelectInbox={() => {
          setActiveTab('inbox');
          setIsSearchOpen(false);
        }}
      />

      <AiIngestModal
        isOpen={isAiIngestOpen}
        onClose={() => setIsAiIngestOpen(false)}
        categories={state.categories}
        aiConfig={state.aiConfig}
        masterPassword={masterPassword}
        onRequireUnlock={() => setIsMasterKeyOpen(true)}
        onBatchImport={handleBatchImport}
      />

      <MasterKeyModal
        isOpen={isMasterKeyOpen}
        onClose={() => setIsMasterKeyOpen(false)}
        onSuccess={(pwd) => setMasterPassword(pwd)}
      />

      <AddItemModal
        isOpen={isAddModalOpen}
        onClose={() => setIsAddModalOpen(false)}
        categories={state.categories}
        masterPassword={masterPassword}
        onRequireUnlock={() => setIsMasterKeyOpen(true)}
        onAddSite={handleAddSite}
        onAddServer={handleAddServer}
        onAddSecret={handleAddSecret}
        onAddCheckIn={handleAddCheckIn}
        onAddNote={(note) => updateState((prev) => ({ ...prev, notes: [note, ...prev.notes] }))}
      />

      <SettingsModal
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        obsidianConfig={state.obsidianConfig}
        onUpdateObsidian={(cfg) => updateState((prev) => ({ ...prev, obsidianConfig: cfg }))}
        aiConfig={state.aiConfig}
        onUpdateAi={(cfg) => updateState((prev) => ({ ...prev, aiConfig: cfg }))}
        state={state}
        onRestoreState={(restored) => setState(restored)}
        masterPassword={masterPassword}
      />
    </div>
  );
}

export default App;
