import React, { useState } from 'react';
import { 
  FolderKanban, 
  Plus, 
  ExternalLink, 
  GitBranch, 
  FileText, 
  Server, 
  Globe, 
  Clock, 
  Trash2, 
  Edit3, 
  CheckCircle2, 
  AlertCircle, 
  Calendar, 
  Save, 
  ArrowRight,
  ShieldCheck,
  Tag,
  Download,
  Terminal,
  Activity,
  X,
  Link2,
  Unlink
} from 'lucide-react';
import { ProjectItem, QuickNote, NavSite, ServerDeployment, ReminderItem } from '../../types';

interface ProjectsViewProps {
  projects: ProjectItem[];
  notes: QuickNote[];
  sites: NavSite[];
  servers: ServerDeployment[];
  reminders: ReminderItem[];
  onAddProject: (project: ProjectItem) => void;
  onUpdateProject: (project: ProjectItem) => void;
  onDeleteProject: (id: string) => void;
  onNavigateTab: (tab: string, itemId?: string) => void;
}

export const ProjectsView: React.FC<ProjectsViewProps> = ({
  projects,
  notes,
  sites,
  servers,
  reminders,
  onAddProject,
  onUpdateProject,
  onDeleteProject,
  onNavigateTab
}) => {
  const [selectedProjectId, setSelectedProjectId] = useState<string>(projects[0]?.id || '');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingProject, setEditingProject] = useState<ProjectItem | null>(null);

  // Form states
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [status, setStatus] = useState<'active' | 'planning' | 'paused' | 'completed'>('active');
  const [repoUrl, setRepoUrl] = useState('');
  const [deployUrl, setDeployUrl] = useState('');
  const [tagsStr, setTagsStr] = useState('');

  // Decision add state
  const [decisionTitle, setDecisionTitle] = useState('');
  const [decisionNote, setDecisionNote] = useState('');
  const [isAddingDecision, setIsAddingDecision] = useState(false);

  // Asset linker state
  const [activeLinkerType, setActiveLinkerType] = useState<'notes' | 'sites' | 'servers' | 'reminders' | null>(null);
  const [linkerSearch, setLinkerSearch] = useState('');

  const selectedProject = projects.find((p) => p.id === selectedProjectId) || projects[0];

  const handleToggleLink = (type: 'note' | 'site' | 'server' | 'reminder', id: string) => {
    if (!selectedProject) return;
    const key = type === 'note' ? 'noteIds' : type === 'site' ? 'siteIds' : type === 'server' ? 'serverIds' : 'reminderIds';
    const currentList = selectedProject[key] || [];
    const exists = currentList.includes(id);
    const updatedList = exists ? currentList.filter(item => item !== id) : [...currentList, id];

    onUpdateProject({
      ...selectedProject,
      [key]: updatedList,
      updatedAt: Date.now()
    });
  };

  const handleDeleteDecision = (index: number) => {
    if (!selectedProject) return;
    const current = selectedProject.decisions || [];
    onUpdateProject({
      ...selectedProject,
      decisions: current.filter((_, i) => i !== index),
      updatedAt: Date.now()
    });
  };

  const handleOpenAdd = () => {
    setEditingProject(null);
    setName('');
    setDescription('');
    setStatus('active');
    setRepoUrl('');
    setDeployUrl('');
    setTagsStr('');
    setIsModalOpen(true);
  };

  const handleOpenEdit = (project: ProjectItem) => {
    setEditingProject(project);
    setName(project.name);
    setDescription(project.description);
    setStatus(project.status);
    setRepoUrl(project.repoUrl || '');
    setDeployUrl(project.deployUrl || '');
    setTagsStr((project.tags || []).join(', '));
    setIsModalOpen(true);
  };

  const handleSaveProject = () => {
    if (!name.trim()) return;

    const tags = tagsStr.split(/[,，\s]+/).map(t => t.trim()).filter(Boolean);

    if (editingProject) {
      onUpdateProject({
        ...editingProject,
        name: name.trim(),
        description: description.trim(),
        status,
        repoUrl: repoUrl.trim() || undefined,
        deployUrl: deployUrl.trim() || undefined,
        tags,
        updatedAt: Date.now()
      });
    } else {
      const newProj: ProjectItem = {
        id: `proj-${Date.now()}`,
        name: name.trim(),
        description: description.trim(),
        status,
        repoUrl: repoUrl.trim() || undefined,
        deployUrl: deployUrl.trim() || undefined,
        tags,
        noteIds: [],
        siteIds: [],
        serverIds: [],
        reminderIds: [],
        decisions: [],
        createdAt: Date.now(),
        updatedAt: Date.now()
      };
      onAddProject(newProj);
      setSelectedProjectId(newProj.id);
    }

    setIsModalOpen(false);
  };

  const handleAddDecision = () => {
    if (!decisionTitle.trim() || !selectedProject) return;

    const updated = {
      ...selectedProject,
      decisions: [
        {
          date: Date.now(),
          title: decisionTitle.trim(),
          note: decisionNote.trim()
        },
        ...(selectedProject.decisions || [])
      ],
      updatedAt: Date.now()
    };

    onUpdateProject(updated);
    setDecisionTitle('');
    setDecisionNote('');
    setIsAddingDecision(false);
  };

  const handleExportProjectMarkdown = (project: ProjectItem) => {
    const md = `# 项目资料清单：${project.name}
> 状态: ${project.status} | 导出时间: ${new Date().toLocaleString()}

### 📖 项目简介
${project.description}

- 仓库地址: ${project.repoUrl || '暂无'}
- 部署入口: ${project.deployUrl || '暂无'}
- 标签: ${(project.tags || []).join(', ')}

---

### 📝 关联文档 (${(project.noteIds || []).length})
${(project.noteIds || []).map(id => {
  const n = notes.find(item => item.id === id);
  return n ? `- [${n.title}]: ${n.category || '知识文档'}` : '';
}).filter(Boolean).join('\n') || '暂无关联文档'}

---

### 🌐 关联站点 (${(project.siteIds || []).length})
${(project.siteIds || []).map(id => {
  const s = sites.find(item => item.id === id);
  return s ? `- [${s.title}](${s.url})` : '';
}).filter(Boolean).join('\n') || '暂无关联站点'}

---

### 🖥️ 关联服务器 (${(project.serverIds || []).length})
${(project.serverIds || []).map(id => {
  const s = servers.find(item => item.id === id);
  return s ? `- ${s.name} (${s.publicIp}:${s.port || 22}) [${s.env}]` : '';
}).filter(Boolean).join('\n') || '暂无关联服务器'}

---

### 💡 架构决策日志
${(project.decisions || []).map(d => `#### ${new Date(d.date).toLocaleDateString()} - ${d.title}\n${d.note}`).join('\n\n') || '暂无决策记录'}
`;

    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Project-${project.name}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-5">
      {/* View Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-[#121316] p-4 sm:p-5 rounded-2xl border border-[#22242a]">
        <div>
          <h2 className="text-sm sm:text-base font-semibold text-zinc-100 flex items-center gap-2">
            <FolderKanban className="w-4 h-4 text-emerald-400" />
            <span>自研项目资料空间 (Project Spaces)</span>
            <span className="text-xs font-mono text-zinc-400">({projects.length} 个项目)</span>
          </h2>
          <p className="text-xs text-zinc-400 mt-0.5">
            以自研与业务项目为核心，跨端聚合关联文档、部署服务器、日常站点与关键架构决策记录
          </p>
        </div>

        <button
          onClick={handleOpenAdd}
          className="px-3.5 py-1.5 rounded-xl bg-zinc-100 text-zinc-900 font-semibold text-xs flex items-center gap-1.5 shadow-sm hover:bg-white transition-colors"
        >
          <Plus className="w-3.5 h-3.5" />
          <span>新建项目空间</span>
        </button>
      </div>

      {/* Main 2-Column Split Workspace */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 min-h-[640px]">
        {/* Left Column: Projects Directory List */}
        <div className="lg:col-span-4 flex flex-col rounded-2xl bg-[#121316] border border-[#22242a] p-4 space-y-2.5">
          <div className="text-xs font-semibold text-zinc-300 pb-2 border-b border-zinc-800 flex items-center justify-between">
            <span>我的项目列表</span>
            <span className="text-[11px] font-mono text-zinc-500">{projects.length} 个</span>
          </div>

          <div className="flex-1 overflow-y-auto space-y-2">
            {projects.map((project) => {
              const isSelected = project.id === selectedProject?.id;
              const statusColor = 
                project.status === 'active' ? 'bg-emerald-950/60 text-emerald-400 border-emerald-800/60' :
                project.status === 'planning' ? 'bg-sky-950/60 text-sky-400 border-sky-800/60' :
                project.status === 'paused' ? 'bg-amber-950/60 text-amber-400 border-amber-800/60' :
                'bg-zinc-800 text-zinc-400 border-zinc-700';

              return (
                <div
                  key={project.id}
                  onClick={() => setSelectedProjectId(project.id)}
                  className={`p-3.5 rounded-xl border cursor-pointer transition-all ${
                    isSelected
                      ? 'bg-emerald-950/20 border-emerald-700/80 shadow-sm'
                      : 'bg-zinc-900/50 border-zinc-800/60 hover:border-zinc-700'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2 mb-1.5">
                    <h3 className={`text-xs font-semibold truncate ${isSelected ? 'text-emerald-200' : 'text-zinc-200'}`}>
                      {project.name}
                    </h3>
                    <span className={`px-1.5 py-0.5 rounded text-[9px] font-mono border capitalize ${statusColor}`}>
                      {project.status === 'active' ? '活跃中' : project.status === 'planning' ? '规划中' : project.status === 'paused' ? '暂停' : '归档'}
                    </span>
                  </div>

                  <p className="text-[11px] text-zinc-400 line-clamp-2 leading-relaxed mb-2">
                    {project.description}
                  </p>

                  <div className="flex items-center justify-between text-[10px] text-zinc-500 font-mono border-t border-zinc-800/60 pt-2">
                    <span>关联: {(project.noteIds?.length || 0) + (project.siteIds?.length || 0) + (project.serverIds?.length || 0)} 项</span>
                    <span>{new Date(project.updatedAt).toLocaleDateString()}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Right Column: Project Aggregated Detail Dashboard */}
        <div className="lg:col-span-8 flex flex-col rounded-2xl bg-[#121316] border border-[#22242a] overflow-hidden">
          {selectedProject ? (
            <div className="flex-1 flex flex-col p-5 space-y-5 overflow-y-auto">
              {/* Project Detail Header */}
              <div className="flex flex-wrap items-center justify-between gap-3 pb-4 border-b border-zinc-800">
                <div>
                  <div className="flex items-center gap-2.5">
                    <h2 className="text-base font-bold text-zinc-100">{selectedProject.name}</h2>
                    <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-emerald-950/60 text-emerald-400 border border-emerald-800/60 capitalize">
                      {selectedProject.status}
                    </span>
                  </div>
                  <p className="text-xs text-zinc-400 mt-1 max-w-2xl leading-relaxed">
                    {selectedProject.description}
                  </p>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    onClick={() => handleExportProjectMarkdown(selectedProject)}
                    className="px-2.5 py-1.5 rounded-xl bg-zinc-900 border border-zinc-800 text-zinc-300 hover:text-white text-xs flex items-center gap-1.5"
                    title="导出完整项目清单为 Markdown"
                  >
                    <Download className="w-3.5 h-3.5" />
                    <span>导出 Markdown</span>
                  </button>

                  <button
                    onClick={() => handleOpenEdit(selectedProject)}
                    className="p-1.5 rounded-lg bg-zinc-900 border border-zinc-800 text-zinc-400 hover:text-white"
                    title="编辑项目"
                  >
                    <Edit3 className="w-3.5 h-3.5" />
                  </button>

                  <button
                    onClick={() => {
                      if (confirm(`确认删除项目空间「${selectedProject.name}」？关联资产仍将保留在各自主模块中。`)) {
                        onDeleteProject(selectedProject.id);
                      }
                    }}
                    className="p-1.5 rounded-lg bg-zinc-900 border border-zinc-800 text-zinc-400 hover:text-rose-400"
                    title="删除项目"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>

              {/* Links & Quick Jump Strip */}
              {(selectedProject.repoUrl || selectedProject.deployUrl) && (
                <div className="flex flex-wrap items-center gap-3 p-3 rounded-xl bg-zinc-900/60 border border-zinc-800">
                  {selectedProject.repoUrl && (
                    <a
                      href={selectedProject.repoUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-xs text-zinc-300 hover:text-white flex items-center gap-1.5 font-mono"
                    >
                      <GitBranch className="w-3.5 h-3.5 text-zinc-400" />
                      <span>代码仓库: {selectedProject.repoUrl.replace(/^https?:\/\//, '')}</span>
                      <ExternalLink className="w-3 h-3 text-zinc-500" />
                    </a>
                  )}

                  {selectedProject.deployUrl && (
                    <a
                      href={selectedProject.deployUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-xs text-emerald-400 hover:underline flex items-center gap-1.5 font-mono"
                    >
                      <Globe className="w-3.5 h-3.5" />
                      <span>线上服务: {selectedProject.deployUrl}</span>
                      <ExternalLink className="w-3 h-3 text-emerald-500" />
                    </a>
                  )}
                </div>
              )}

              {/* Aggregated Hub: Notes, Sites, Servers, Reminders (All 4 Quadrants) */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* 1. Associated Notes */}
                <div className="p-4 rounded-xl bg-[#090a0c] border border-zinc-800/80 space-y-2.5">
                  <div className="flex items-center justify-between text-xs font-semibold text-zinc-300 pb-2 border-b border-zinc-800">
                    <span className="flex items-center gap-1.5">
                      <FileText className="w-3.5 h-3.5 text-purple-400" />
                      关联文档与规程 ({(selectedProject.noteIds || []).length})
                    </span>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => {
                          setActiveLinkerType('notes');
                          setLinkerSearch('');
                        }}
                        className="text-[10px] text-purple-400 hover:text-purple-300 font-medium flex items-center gap-0.5 bg-purple-950/40 px-2 py-0.5 rounded border border-purple-800/50"
                      >
                        <Plus className="w-2.5 h-2.5" />
                        <span>关联文档</span>
                      </button>
                      <button
                        onClick={() => onNavigateTab('notes')}
                        className="text-[10px] text-zinc-500 hover:text-purple-300 flex items-center gap-0.5"
                      >
                        <span>去文档库</span>
                        <ArrowRight className="w-2.5 h-2.5" />
                      </button>
                    </div>
                  </div>

                  <div className="space-y-1.5 max-h-48 overflow-y-auto">
                    {(selectedProject.noteIds || []).length === 0 ? (
                      <p className="text-[11px] text-zinc-500 italic py-2">暂无关联笔记，点击右上角「关联文档」添加</p>
                    ) : (
                      (selectedProject.noteIds || []).map((id) => {
                        const note = notes.find((n) => n.id === id);
                        if (!note) return null;
                        return (
                          <div
                            key={id}
                            className="p-2 rounded-lg bg-zinc-900/60 hover:bg-zinc-800/80 border border-zinc-800 flex items-center justify-between text-xs transition-colors group"
                          >
                            <span 
                              onClick={() => onNavigateTab('notes', id)}
                              className="text-zinc-200 font-medium truncate cursor-pointer hover:underline flex-1"
                            >
                              {note.title}
                            </span>
                            <div className="flex items-center gap-2 ml-2 shrink-0">
                              <span className="text-[10px] font-mono text-zinc-500">{note.category}</span>
                              <button
                                onClick={() => handleToggleLink('note', id)}
                                className="text-zinc-500 hover:text-red-400 opacity-60 group-hover:opacity-100"
                                title="解除关联"
                              >
                                <X className="w-3 h-3" />
                              </button>
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>

                {/* 2. Associated Sites */}
                <div className="p-4 rounded-xl bg-[#090a0c] border border-zinc-800/80 space-y-2.5">
                  <div className="flex items-center justify-between text-xs font-semibold text-zinc-300 pb-2 border-b border-zinc-800">
                    <span className="flex items-center gap-1.5">
                      <Globe className="w-3.5 h-3.5 text-sky-400" />
                      关联站点与入口 ({(selectedProject.siteIds || []).length})
                    </span>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => {
                          setActiveLinkerType('sites');
                          setLinkerSearch('');
                        }}
                        className="text-[10px] text-sky-400 hover:text-sky-300 font-medium flex items-center gap-0.5 bg-sky-950/40 px-2 py-0.5 rounded border border-sky-800/50"
                      >
                        <Plus className="w-2.5 h-2.5" />
                        <span>关联站点</span>
                      </button>
                      <button
                        onClick={() => onNavigateTab('sites')}
                        className="text-[10px] text-zinc-500 hover:text-sky-300 flex items-center gap-0.5"
                      >
                        <span>去网站</span>
                        <ArrowRight className="w-2.5 h-2.5" />
                      </button>
                    </div>
                  </div>

                  <div className="space-y-1.5 max-h-48 overflow-y-auto">
                    {(selectedProject.siteIds || []).length === 0 ? (
                      <p className="text-[11px] text-zinc-500 italic py-2">暂无关联站点，点击右上角「关联站点」添加</p>
                    ) : (
                      (selectedProject.siteIds || []).map((id) => {
                        const site = sites.find((s) => s.id === id);
                        if (!site) return null;
                        return (
                          <div
                            key={id}
                            className="p-2 rounded-lg bg-zinc-900/60 hover:bg-zinc-800/80 border border-zinc-800 flex items-center justify-between text-xs transition-colors group"
                          >
                            <a
                              href={site.url}
                              target="_blank"
                              rel="noreferrer"
                              className="text-zinc-200 font-medium truncate hover:text-sky-300 hover:underline flex-1 flex items-center gap-1.5"
                            >
                              <span>{site.title}</span>
                              <ExternalLink className="w-2.5 h-2.5 text-zinc-500" />
                            </a>
                            <div className="flex items-center gap-2 ml-2 shrink-0">
                              <span className="text-[10px] font-mono text-zinc-500">{site.category}</span>
                              <button
                                onClick={() => handleToggleLink('site', id)}
                                className="text-zinc-500 hover:text-red-400 opacity-60 group-hover:opacity-100"
                                title="解除关联"
                              >
                                <X className="w-3 h-3" />
                              </button>
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>

                {/* 3. Associated Servers */}
                <div className="p-4 rounded-xl bg-[#090a0c] border border-zinc-800/80 space-y-2.5">
                  <div className="flex items-center justify-between text-xs font-semibold text-zinc-300 pb-2 border-b border-zinc-800">
                    <span className="flex items-center gap-1.5">
                      <Server className="w-3.5 h-3.5 text-emerald-400" />
                      部署主机与实例 ({(selectedProject.serverIds || []).length})
                    </span>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => {
                          setActiveLinkerType('servers');
                          setLinkerSearch('');
                        }}
                        className="text-[10px] text-emerald-400 hover:text-emerald-300 font-medium flex items-center gap-0.5 bg-emerald-950/40 px-2 py-0.5 rounded border border-emerald-800/50"
                      >
                        <Plus className="w-2.5 h-2.5" />
                        <span>关联主机</span>
                      </button>
                      <button
                        onClick={() => onNavigateTab('servers')}
                        className="text-[10px] text-zinc-500 hover:text-emerald-300 flex items-center gap-0.5"
                      >
                        <span>去服务器</span>
                        <ArrowRight className="w-2.5 h-2.5" />
                      </button>
                    </div>
                  </div>

                  <div className="space-y-1.5 max-h-48 overflow-y-auto">
                    {(selectedProject.serverIds || []).length === 0 ? (
                      <p className="text-[11px] text-zinc-500 italic py-2">暂无关联主机，点击右上角「关联主机」添加</p>
                    ) : (
                      (selectedProject.serverIds || []).map((id) => {
                        const srv = servers.find((s) => s.id === id);
                        if (!srv) return null;
                        return (
                          <div
                            key={id}
                            className="p-2 rounded-lg bg-zinc-900/60 border border-zinc-800 flex items-center justify-between text-xs group"
                          >
                            <div className="truncate flex-1">
                              <span className="text-zinc-200 font-medium">{srv.name}</span>
                              <span className="text-[10px] font-mono text-zinc-400 ml-2">({srv.publicIp})</span>
                            </div>
                            <div className="flex items-center gap-2 ml-2 shrink-0">
                              <span className="text-[9px] font-mono px-1 rounded bg-emerald-950/60 text-emerald-400 border border-emerald-800/50">
                                {srv.env}
                              </span>
                              <button
                                onClick={() => handleToggleLink('server', id)}
                                className="text-zinc-500 hover:text-red-400 opacity-60 group-hover:opacity-100"
                                title="解除关联"
                              >
                                <X className="w-3 h-3" />
                              </button>
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>

                {/* 4. Associated Reminders */}
                <div className="p-4 rounded-xl bg-[#090a0c] border border-zinc-800/80 space-y-2.5">
                  <div className="flex items-center justify-between text-xs font-semibold text-zinc-300 pb-2 border-b border-zinc-800">
                    <span className="flex items-center gap-1.5">
                      <Clock className="w-3.5 h-3.5 text-amber-400" />
                      关联提醒与续费 ({(selectedProject.reminderIds || []).length})
                    </span>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => {
                          setActiveLinkerType('reminders');
                          setLinkerSearch('');
                        }}
                        className="text-[10px] text-amber-400 hover:text-amber-300 font-medium flex items-center gap-0.5 bg-amber-950/40 px-2 py-0.5 rounded border border-amber-800/50"
                      >
                        <Plus className="w-2.5 h-2.5" />
                        <span>关联提醒</span>
                      </button>
                      <button
                        onClick={() => onNavigateTab('reminders')}
                        className="text-[10px] text-zinc-500 hover:text-amber-300 flex items-center gap-0.5"
                      >
                        <span>去提醒</span>
                        <ArrowRight className="w-2.5 h-2.5" />
                      </button>
                    </div>
                  </div>

                  <div className="space-y-1.5 max-h-48 overflow-y-auto">
                    {(selectedProject.reminderIds || []).length === 0 ? (
                      <p className="text-[11px] text-zinc-500 italic py-2">暂无关联提醒，点击右上角「关联提醒」添加</p>
                    ) : (
                      (selectedProject.reminderIds || []).map((id) => {
                        const rem = reminders.find((r) => r.id === id);
                        if (!rem) return null;
                        const daysLeft = Math.ceil((rem.targetDate - Date.now()) / (1000 * 60 * 60 * 24));
                        return (
                          <div
                            key={id}
                            className="p-2 rounded-lg bg-zinc-900/60 border border-zinc-800 flex items-center justify-between text-xs group"
                          >
                            <span className="text-zinc-200 font-medium truncate flex-1">{rem.title}</span>
                            <div className="flex items-center gap-2 ml-2 shrink-0">
                              <span className={`text-[10px] font-mono ${daysLeft <= 7 ? 'text-red-400' : 'text-zinc-400'}`}>
                                {daysLeft > 0 ? `剩 ${daysLeft} 天` : '已到期'}
                              </span>
                              <button
                                onClick={() => handleToggleLink('reminder', id)}
                                className="text-zinc-500 hover:text-red-400 opacity-60 group-hover:opacity-100"
                                title="解除关联"
                              >
                                <X className="w-3 h-3" />
                              </button>
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>
              </div>

              {/* Decision Log Timeline (架构与技术决策记录) */}
              <div className="p-4 rounded-xl bg-[#090a0c] border border-zinc-800/80 space-y-3">
                <div className="flex items-center justify-between text-xs font-semibold text-zinc-300 pb-2 border-b border-zinc-800">
                  <span className="flex items-center gap-1.5">
                    <Activity className="w-3.5 h-3.5 text-indigo-400" />
                    架构与关键业务决策日志 (Decision Log)
                  </span>
                  <button
                    onClick={() => setIsAddingDecision(!isAddingDecision)}
                    className="text-[11px] text-indigo-300 hover:text-indigo-200 flex items-center gap-1"
                  >
                    <Plus className="w-3 h-3" />
                    <span>记录新决策</span>
                  </button>
                </div>

                {isAddingDecision && (
                  <div className="p-3 rounded-xl bg-zinc-900/80 border border-indigo-800/60 space-y-2 animate-in fade-in">
                    <input
                      type="text"
                      value={decisionTitle}
                      onChange={(e) => setDecisionTitle(e.target.value)}
                      placeholder="决策主题 (如: 采用 D1 替代外部自建数据库)..."
                      className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-xs text-zinc-100 focus:outline-none focus:border-indigo-500"
                    />
                    <textarea
                      value={decisionNote}
                      onChange={(e) => setDecisionNote(e.target.value)}
                      placeholder="决策原因、权衡取舍与落地影响..."
                      rows={2}
                      className="w-full bg-zinc-950 border border-zinc-800 rounded-lg p-2.5 text-xs text-zinc-100 focus:outline-none focus:border-indigo-500"
                    />
                    <div className="flex justify-end gap-2">
                      <button
                        onClick={() => setIsAddingDecision(false)}
                        className="px-2.5 py-1 rounded bg-zinc-800 text-zinc-400 text-xs"
                      >
                        取消
                      </button>
                      <button
                        onClick={handleAddDecision}
                        className="px-3 py-1 rounded bg-indigo-600 text-white font-medium text-xs shadow-sm"
                      >
                        记录
                      </button>
                    </div>
                  </div>
                )}

                <div className="space-y-2.5">
                  {(selectedProject.decisions || []).length === 0 ? (
                    <p className="text-[11px] text-zinc-500 italic py-2">暂无决策记录，点击右上角即可添加</p>
                  ) : (
                    (selectedProject.decisions || []).map((dec, i) => (
                      <div key={i} className="pl-3 border-l-2 border-indigo-500/80 space-y-0.5 group relative">
                        <div className="flex items-center justify-between text-xs">
                          <span className="font-semibold text-zinc-200">{dec.title}</span>
                          <div className="flex items-center gap-2">
                            <span className="text-[10px] font-mono text-zinc-500">
                              {new Date(dec.date).toLocaleDateString()}
                            </span>
                            <button
                              onClick={() => handleDeleteDecision(i)}
                              className="text-zinc-600 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity"
                              title="删除此条决策"
                            >
                              <Trash2 className="w-3 h-3" />
                            </button>
                          </div>
                        </div>
                        <p className="text-[11px] text-zinc-400 leading-relaxed">{dec.note}</p>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center p-12 text-zinc-500">
              <FolderKanban className="w-10 h-10 mb-2 opacity-40" />
              <p className="text-xs">未选择项目</p>
            </div>
          )}
        </div>
      </div>

      {/* Add / Edit Project Modal */}
      {isModalOpen && (
        <div
          onClick={() => setIsModalOpen(false)}
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-lg bg-[#121316] border border-zinc-800 rounded-2xl p-6 shadow-2xl space-y-4"
          >
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-zinc-100 flex items-center gap-2">
                <FolderKanban className="w-4 h-4 text-emerald-400" />
                <span>{editingProject ? '编辑项目空间' : '新建自研项目空间'}</span>
              </h3>
              <button onClick={() => setIsModalOpen(false)} className="text-zinc-500 hover:text-white">✕</button>
            </div>

            <div className="space-y-3">
              <div>
                <label className="block text-xs text-zinc-400 font-mono mb-1">项目名称</label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="如: 个人云端工作台 / API 聚合网关"
                  className="w-full bg-zinc-900 border border-zinc-800 rounded-xl px-3 py-2 text-xs text-zinc-100 focus:outline-none focus:border-emerald-500"
                />
              </div>

              <div>
                <label className="block text-xs text-zinc-400 font-mono mb-1">项目简述与目标</label>
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="阐明该项目解决什么问题、核心技术栈与部署目标..."
                  rows={3}
                  className="w-full bg-zinc-900 border border-zinc-800 rounded-xl p-3 text-xs text-zinc-100 focus:outline-none focus:border-emerald-500"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-zinc-400 font-mono mb-1">生命周期状态</label>
                  <select
                    value={status}
                    onChange={(e) => setStatus(e.target.value as any)}
                    className="w-full bg-zinc-900 border border-zinc-800 rounded-xl px-3 py-2 text-xs text-zinc-100"
                  >
                    <option value="active">活跃进行中 (active)</option>
                    <option value="planning">构思规划中 (planning)</option>
                    <option value="paused">已暂停 (paused)</option>
                    <option value="completed">已归档完成 (completed)</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs text-zinc-400 font-mono mb-1">标签分类 (逗号分隔)</label>
                  <input
                    type="text"
                    value={tagsStr}
                    onChange={(e) => setTagsStr(e.target.value)}
                    placeholder="架构, 前端, Docker"
                    className="w-full bg-zinc-900 border border-zinc-800 rounded-xl px-3 py-2 text-xs text-zinc-100"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs text-zinc-400 font-mono mb-1">代码仓库 URL</label>
                <input
                  type="text"
                  value={repoUrl}
                  onChange={(e) => setRepoUrl(e.target.value)}
                  placeholder="https://github.com/..."
                  className="w-full bg-zinc-900 border border-zinc-800 rounded-xl px-3 py-2 text-xs text-zinc-100 font-mono"
                />
              </div>

              <div>
                <label className="block text-xs text-zinc-400 font-mono mb-1">线上部署域名 / 入口</label>
                <input
                  type="text"
                  value={deployUrl}
                  onChange={(e) => setDeployUrl(e.target.value)}
                  placeholder="https://example.com"
                  className="w-full bg-zinc-900 border border-zinc-800 rounded-xl px-3 py-2 text-xs text-zinc-100 font-mono"
                />
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                onClick={() => setIsModalOpen(false)}
                className="px-3.5 py-1.5 rounded-xl bg-zinc-800 text-zinc-300 text-xs"
              >
                取消
              </button>
              <button
                onClick={handleSaveProject}
                className="px-4 py-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-semibold text-xs shadow-sm"
              >
                保存项目
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Interactive Asset Linker Modal (N08) */}
      {activeLinkerType && selectedProject && (
        <div
          onClick={() => setActiveLinkerType(null)}
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-lg bg-[#121316] border border-zinc-800 rounded-2xl p-6 shadow-2xl space-y-4 max-h-[80vh] flex flex-col"
          >
            <div className="flex items-center justify-between border-b border-zinc-800 pb-3">
              <h3 className="text-sm font-semibold text-zinc-100 flex items-center gap-2">
                <Link2 className="w-4 h-4 text-emerald-400" />
                <span>
                  {activeLinkerType === 'notes' && '关联现有知识文档到当前项目'}
                  {activeLinkerType === 'sites' && '关联常用网址与线上入口到当前项目'}
                  {activeLinkerType === 'servers' && '关联部署服务器与主机到当前项目'}
                  {activeLinkerType === 'reminders' && '关联到期与续费提醒到当前项目'}
                </span>
              </h3>
              <button
                onClick={() => setActiveLinkerType(null)}
                className="text-zinc-500 hover:text-white p-1"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <input
              type="text"
              value={linkerSearch}
              onChange={(e) => setLinkerSearch(e.target.value)}
              placeholder="快速搜索过滤资产..."
              className="w-full bg-zinc-900 border border-zinc-800 rounded-xl px-3 py-2 text-xs text-zinc-100 outline-none focus:border-emerald-500"
            />

            <div className="flex-1 overflow-y-auto space-y-2 pr-1 min-h-[200px]">
              {/* If Notes */}
              {activeLinkerType === 'notes' && (
                notes
                  .filter(n => !linkerSearch || n.title.toLowerCase().includes(linkerSearch.toLowerCase()))
                  .map(n => {
                    const isLinked = (selectedProject.noteIds || []).includes(n.id);
                    return (
                      <div
                        key={n.id}
                        onClick={() => handleToggleLink('note', n.id)}
                        className={`p-2.5 rounded-xl border flex items-center justify-between text-xs cursor-pointer transition-colors ${
                          isLinked ? 'bg-purple-950/30 border-purple-700/80 text-purple-200' : 'bg-zinc-900/50 border-zinc-800 hover:border-zinc-700 text-zinc-300'
                        }`}
                      >
                        <div className="truncate flex-1">
                          <div className="font-semibold">{n.title}</div>
                          <div className="text-[10px] text-zinc-400">{n.category}</div>
                        </div>
                        <span className={`text-[10px] px-2 py-0.5 rounded font-mono ${isLinked ? 'bg-purple-800 text-white' : 'bg-zinc-800 text-zinc-400'}`}>
                          {isLinked ? '已关联 (点击取消)' : '+ 关联'}
                        </span>
                      </div>
                    );
                  })
              )}

              {/* If Sites */}
              {activeLinkerType === 'sites' && (
                sites
                  .filter(s => !linkerSearch || s.title.toLowerCase().includes(linkerSearch.toLowerCase()) || s.url.includes(linkerSearch))
                  .map(s => {
                    const isLinked = (selectedProject.siteIds || []).includes(s.id);
                    return (
                      <div
                        key={s.id}
                        onClick={() => handleToggleLink('site', s.id)}
                        className={`p-2.5 rounded-xl border flex items-center justify-between text-xs cursor-pointer transition-colors ${
                          isLinked ? 'bg-sky-950/30 border-sky-700/80 text-sky-200' : 'bg-zinc-900/50 border-zinc-800 hover:border-zinc-700 text-zinc-300'
                        }`}
                      >
                        <div className="truncate flex-1">
                          <div className="font-semibold">{s.title}</div>
                          <div className="text-[10px] text-zinc-400 font-mono truncate">{s.url}</div>
                        </div>
                        <span className={`text-[10px] px-2 py-0.5 rounded font-mono ${isLinked ? 'bg-sky-800 text-white' : 'bg-zinc-800 text-zinc-400'}`}>
                          {isLinked ? '已关联 (点击取消)' : '+ 关联'}
                        </span>
                      </div>
                    );
                  })
              )}

              {/* If Servers */}
              {activeLinkerType === 'servers' && (
                servers
                  .filter(srv => !linkerSearch || srv.name.toLowerCase().includes(linkerSearch.toLowerCase()) || srv.publicIp.includes(linkerSearch))
                  .map(srv => {
                    const isLinked = (selectedProject.serverIds || []).includes(srv.id);
                    return (
                      <div
                        key={srv.id}
                        onClick={() => handleToggleLink('server', srv.id)}
                        className={`p-2.5 rounded-xl border flex items-center justify-between text-xs cursor-pointer transition-colors ${
                          isLinked ? 'bg-emerald-950/30 border-emerald-700/80 text-emerald-200' : 'bg-zinc-900/50 border-zinc-800 hover:border-zinc-700 text-zinc-300'
                        }`}
                      >
                        <div className="truncate flex-1">
                          <div className="font-semibold">{srv.name}</div>
                          <div className="text-[10px] text-zinc-400 font-mono">{srv.publicIp} ({srv.env})</div>
                        </div>
                        <span className={`text-[10px] px-2 py-0.5 rounded font-mono ${isLinked ? 'bg-emerald-800 text-white' : 'bg-zinc-800 text-zinc-400'}`}>
                          {isLinked ? '已关联 (点击取消)' : '+ 关联'}
                        </span>
                      </div>
                    );
                  })
              )}

              {/* If Reminders */}
              {activeLinkerType === 'reminders' && (
                reminders
                  .filter(r => !linkerSearch || r.title.toLowerCase().includes(linkerSearch.toLowerCase()))
                  .map(r => {
                    const isLinked = (selectedProject.reminderIds || []).includes(r.id);
                    return (
                      <div
                        key={r.id}
                        onClick={() => handleToggleLink('reminder', r.id)}
                        className={`p-2.5 rounded-xl border flex items-center justify-between text-xs cursor-pointer transition-colors ${
                          isLinked ? 'bg-amber-950/30 border-amber-700/80 text-amber-200' : 'bg-zinc-900/50 border-zinc-800 hover:border-zinc-700 text-zinc-300'
                        }`}
                      >
                        <div className="truncate flex-1">
                          <div className="font-semibold">{r.title}</div>
                          <div className="text-[10px] text-zinc-400 font-mono">到期: {new Date(r.targetDate).toLocaleDateString()}</div>
                        </div>
                        <span className={`text-[10px] px-2 py-0.5 rounded font-mono ${isLinked ? 'bg-amber-800 text-white' : 'bg-zinc-800 text-zinc-400'}`}>
                          {isLinked ? '已关联 (点击取消)' : '+ 关联'}
                        </span>
                      </div>
                    );
                  })
              )}
            </div>

            <div className="flex justify-end pt-2 border-t border-zinc-800">
              <button
                onClick={() => setActiveLinkerType(null)}
                className="px-4 py-1.5 rounded-xl bg-zinc-100 text-zinc-900 font-semibold text-xs"
              >
                完成
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
