import React, { useState } from 'react';
import { 
  BookOpen, 
  Highlighter, 
  FileText, 
  Share2, 
  Search, 
  Plus, 
  Save, 
  Trash2, 
  ExternalLink, 
  RefreshCw, 
  Check, 
  Copy, 
  HardDrive, 
  Sparkles, 
  Folder, 
  Clock, 
  ArrowRight, 
  ArrowUpRight,
  ShieldCheck,
  Edit3,
  Eye,
  Tag,
  CheckCircle2,
  AlertCircle,
  Network,
  Download
} from 'lucide-react';
import { ObsidianConfig, ObsidianNote, WucaiHighlight, WucaiConfig, YoudaoNote, YoudaoConfig, QuickNote } from '../../types';
import { saveObsidianNote, createObsidianNote, deleteObsidianNote, testOssConnection, fetchObsidianNotes } from '../../lib/s3Client';
import { formatWucaiToObsidianMarkdown } from '../../lib/wucaiClient';
import { formatYoudaoToObsidianMarkdown } from '../../lib/youdaoClient';

interface DataInteropViewProps {
  obsidianConfig: ObsidianConfig;
  obsidianNotes: ObsidianNote[];
  onUpdateObsidianNotes: (notes: ObsidianNote[]) => void;
  wucaiConfig: WucaiConfig;
  wucaiHighlights: WucaiHighlight[];
  onUpdateWucaiHighlights: (highlights: WucaiHighlight[]) => void;
  onUpdateWucaiConfig: (config: WucaiConfig) => void;
  youdaoConfig: YoudaoConfig;
  youdaoNotes: YoudaoNote[];
  onUpdateYoudaoNotes: (notes: YoudaoNote[]) => void;
  onUpdateYoudaoConfig: (config: YoudaoConfig) => void;
  onAddQuickNote: (note: QuickNote) => void;
  onOpenSettings: () => void;
}

export const DataInteropView: React.FC<DataInteropViewProps> = ({
  obsidianConfig,
  obsidianNotes,
  onUpdateObsidianNotes,
  wucaiConfig,
  wucaiHighlights,
  onUpdateWucaiHighlights,
  onUpdateWucaiConfig,
  youdaoConfig,
  youdaoNotes,
  onUpdateYoudaoNotes,
  onUpdateYoudaoConfig,
  onAddQuickNote,
  onOpenSettings
}) => {
  const [activePlatform, setActivePlatform] = useState<'obsidian' | 'wucai' | 'youdao' | 'topology'>('obsidian');
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 3000);
  };

  // -------------------------------------------------------------
  // Platform 1: Obsidian 阿里云 OSS States
  // -------------------------------------------------------------
  const [selectedObsidianKey, setSelectedObsidianKey] = useState<string>(obsidianNotes[0]?.key || '');
  const [obsidianSearch, setObsidianSearch] = useState('');
  const [isEditingObsidian, setIsEditingObsidian] = useState(false);
  const [editObsidianContent, setEditObsidianContent] = useState(obsidianNotes[0]?.content || '');
  const [isSavingObsidian, setIsSavingObsidian] = useState(false);

  // New Obsidian Note modal state
  const [isCreateObsidianModalOpen, setIsCreateObsidianModalOpen] = useState(false);
  const [newObsidianPath, setNewObsidianPath] = useState('');
  const [newObsidianContent, setNewObsidianContent] = useState('');

  // Live OSS Connection testing states
  const [isTestingOss, setIsTestingOss] = useState(false);
  const [ossTestResult, setOssTestResult] = useState<{ success: boolean; message: string; isRealOss: boolean } | null>(null);
  const [showCorsGuide, setShowCorsGuide] = useState(false);
  const [isRefreshingOss, setIsRefreshingOss] = useState(false);

  const handleTestOss = async () => {
    setIsTestingOss(true);
    try {
      const res = await testOssConnection(obsidianConfig);
      setOssTestResult(res);
      if (!res.success && res.message.includes('CORS')) {
        setShowCorsGuide(true);
      }
    } finally {
      setIsTestingOss(false);
    }
  };

  const handleRefreshOssNotes = async () => {
    setIsRefreshingOss(true);
    try {
      const notes = await fetchObsidianNotes(obsidianConfig, obsidianNotes);
      onUpdateObsidianNotes(notes);
      showToast(`🔄 已从阿里云 OSS 同步拉取，当前共 ${notes.length} 篇笔记`);
    } finally {
      setIsRefreshingOss(false);
    }
  };

  const currentObsidianNote = obsidianNotes.find((n) => n.key === selectedObsidianKey) || obsidianNotes[0];

  const filteredObsidianNotes = obsidianNotes.filter(
    (n) => n.title.toLowerCase().includes(obsidianSearch.toLowerCase()) || n.path.toLowerCase().includes(obsidianSearch.toLowerCase())
  );

  const handleSelectObsidianNote = (note: ObsidianNote) => {
    setSelectedObsidianKey(note.key);
    setEditObsidianContent(note.content || '');
    setIsEditingObsidian(false);
  };

  const handleSaveObsidian = async () => {
    if (!currentObsidianNote) return;
    setIsSavingObsidian(true);
    try {
      const res = await saveObsidianNote(obsidianConfig, currentObsidianNote.key, editObsidianContent, obsidianNotes);
      if (res.success) {
        onUpdateObsidianNotes(res.notes);
        setIsEditingObsidian(false);
        showToast(`✅ ${res.message}`);
      }
    } finally {
      setIsSavingObsidian(false);
    }
  };

  const handleCreateObsidianNote = async () => {
    if (!newObsidianPath.trim()) return;
    const res = await createObsidianNote(obsidianConfig, newObsidianPath, newObsidianContent, obsidianNotes);
    if (res.success) {
      onUpdateObsidianNotes(res.notes);
      setSelectedObsidianKey(res.note.key);
      setEditObsidianContent(res.note.content || '');
      setIsCreateObsidianModalOpen(false);
      setNewObsidianPath('');
      setNewObsidianContent('');
      showToast(`✅ 已新建并推送至阿里云 OSS: ${res.note.title}`);
    }
  };

  const handleDeleteObsidian = async (key: string) => {
    if (!confirm('确认从阿里云 OSS 笔记库删除此笔记？')) return;
    const res = await deleteObsidianNote(obsidianConfig, key, obsidianNotes);
    if (res.success) {
      onUpdateObsidianNotes(res.notes);
      if (selectedObsidianKey === key) {
        setSelectedObsidianKey(res.notes[0]?.key || '');
        setEditObsidianContent(res.notes[0]?.content || '');
      }
      showToast('🗑️ 已删除该笔记');
    }
  };

  // -------------------------------------------------------------
  // Platform 2: 五彩划词助手 (Wucai) States
  // -------------------------------------------------------------
  const [wucaiSearch, setWucaiSearch] = useState('');
  const [wucaiColorFilter, setWucaiColorFilter] = useState<string>('all');
  const [editingWucaiId, setEditingWucaiId] = useState<string | null>(null);
  const [editWucaiNote, setEditWucaiNote] = useState('');
  const [isWucaiTokenModalOpen, setIsWucaiTokenModalOpen] = useState(false);
  const [wucaiTokenInput, setWucaiTokenInput] = useState(wucaiConfig.token || '');

  // Add highlight modal
  const [isAddWucaiModalOpen, setIsAddWucaiModalOpen] = useState(false);
  const [newWucaiTitle, setNewWucaiTitle] = useState('');
  const [newWucaiUrl, setNewWucaiUrl] = useState('');
  const [newWucaiText, setNewWucaiText] = useState('');
  const [newWucaiNote, setNewWucaiNote] = useState('');
  const [newWucaiColor, setNewWucaiColor] = useState<'yellow' | 'green' | 'blue' | 'purple' | 'red'>('yellow');
  const [newWucaiTags, setNewWucaiTags] = useState('');

  const filteredWucaiHighlights = wucaiHighlights.filter((hl) => {
    const matchesSearch = 
      hl.pageTitle.toLowerCase().includes(wucaiSearch.toLowerCase()) ||
      hl.text.toLowerCase().includes(wucaiSearch.toLowerCase()) ||
      (hl.note && hl.note.toLowerCase().includes(wucaiSearch.toLowerCase())) ||
      (hl.tags && hl.tags.some(t => t.toLowerCase().includes(wucaiSearch.toLowerCase())));
    const matchesColor = wucaiColorFilter === 'all' || hl.color === wucaiColorFilter;
    return matchesSearch && matchesColor;
  });

  const handleStartEditWucai = (hl: WucaiHighlight) => {
    setEditingWucaiId(hl.id);
    setEditWucaiNote(hl.note || '');
  };

  const handleSaveWucaiEdit = (id: string) => {
    const next = wucaiHighlights.map((hl) =>
      hl.id === id ? { ...hl, note: editWucaiNote, updatedAt: Date.now() } : hl
    );
    onUpdateWucaiHighlights(next);
    setEditingWucaiId(null);
    showToast('✅ 五彩批注已更新');
  };

  const handleDeleteWucai = (id: string) => {
    onUpdateWucaiHighlights(wucaiHighlights.filter((h) => h.id !== id));
    showToast('🗑️ 划词批注已删除');
  };

  const handleSyncWucaiToObsidian = async (hl: WucaiHighlight) => {
    const { path, content } = formatWucaiToObsidianMarkdown(hl);
    const res = await createObsidianNote(obsidianConfig, path, content, obsidianNotes);
    if (res.success) {
      onUpdateObsidianNotes(res.notes);
      showToast(`🚀 已将五彩划词转换为 Obsidian 笔记并推送到阿里云 OSS: ${path}`);
    }
  };

  const handleSyncWucaiToNotes = (hl: WucaiHighlight) => {
    onAddQuickNote({
      id: `qn-${Date.now()}`,
      title: `[五彩摘录] ${hl.pageTitle}`,
      content: `> ${hl.text}\n\n**批注思考**:\n${hl.note || '无'}\n\n[原文链接](${hl.pageUrl})`,
      category: '常用工具',
      tags: hl.tags || ['五彩划词'],
      updatedAt: Date.now()
    });
    showToast('📥 已转存至个人知识文档');
  };

  const handleSaveWucaiToken = () => {
    onUpdateWucaiConfig({
      ...wucaiConfig,
      enabled: true,
      token: wucaiTokenInput
    });
    setIsWucaiTokenModalOpen(false);
    showToast('✅ 五彩 OpenAPI 访问令牌已更新');
  };

  const handleCreateWucaiHighlight = () => {
    if (!newWucaiText.trim()) return;
    const item: WucaiHighlight = {
      id: `wc-${Date.now()}`,
      pageTitle: newWucaiTitle.trim() || '手动网页摘录',
      pageUrl: newWucaiUrl.trim() || 'https://',
      text: newWucaiText.trim(),
      note: newWucaiNote.trim(),
      color: newWucaiColor,
      tags: newWucaiTags.split(/[,，\s]+/).filter(Boolean),
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    onUpdateWucaiHighlights([item, ...wucaiHighlights]);
    setIsAddWucaiModalOpen(false);
    setNewWucaiTitle('');
    setNewWucaiUrl('');
    setNewWucaiText('');
    setNewWucaiNote('');
    showToast('✅ 已录入五彩划词标注');
  };

  const [isSyncingExtension, setIsSyncingExtension] = useState(false);

  const handleSyncFromExtension = () => {
    setIsSyncingExtension(true);
    let received = false;

    const listener = (event: MessageEvent) => {
      if (event.data && event.data.type === 'SELFHUB_RECEIVE_EXTENSION_DATA') {
        received = true;
        window.removeEventListener('message', listener);
        setIsSyncingExtension(false);
        const extAnnotations = event.data.annotations || [];
        if (extAnnotations.length === 0) {
          showToast('ℹ️ 自研扩展内暂无保存的网页批注');
          return;
        }

        const newItems: WucaiHighlight[] = extAnnotations.map((a: any) => ({
          id: a.id || `ext-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          pageUrl: a.url || '',
          pageTitle: a.pageTitle || '网页划词批注',
          text: a.selectedText || a.text || '',
          color: (a.color as any) || 'yellow',
          note: a.thought || a.note || '',
          createdAt: a.createdAt || Date.now(),
          tags: a.tags || ['浏览器划词']
        }));

        const existingIds = new Set(wucaiHighlights.map((h) => h.id));
        const merged = [...wucaiHighlights];
        let addedCount = 0;
        for (const item of newItems) {
          if (!existingIds.has(item.id)) {
            merged.unshift(item);
            addedCount++;
          }
        }
        onUpdateWucaiHighlights(merged);
        showToast(`🎉 成功从浏览器扩展同步 ${addedCount} 条全新批注！`);
      }
    };

    window.addEventListener('message', listener);
    window.postMessage({ type: 'SELFHUB_REQUEST_EXTENSION_DATA' }, '*');

    setTimeout(() => {
      if (!received) {
        window.removeEventListener('message', listener);
        setIsSyncingExtension(false);
        showToast('⚠️ 未检测到浏览器扩展响应。请确保已在 chrome://extensions 加载 selfhub 扩展并刷新当前页面');
      }
    }, 1200);
  };

  const handleExportAllToMarkdown = () => {
    if (wucaiHighlights.length === 0) {
      showToast('暂无划词批注可导出');
      return;
    }
    let md = `# 网页划词与深度批注汇总 (SelfHub Highlights)\n\n*导出时间: ${new Date().toLocaleString()}*\n\n---\n\n`;
    wucaiHighlights.forEach((hl, idx) => {
      md += `### ${idx + 1}. [${hl.pageTitle || hl.pageUrl}](${hl.pageUrl})\n\n`;
      md += `> ${hl.text}\n\n`;
      if (hl.note) {
        md += `💡 **批注思考**: ${hl.note}\n\n`;
      }
      md += `*标签: #${hl.color} · 记录于 ${new Date(hl.createdAt).toLocaleDateString()}*\n\n---\n\n`;
    });

    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `SelfHub_Web_Highlights_${new Date().toISOString().slice(0, 10)}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast('📄 已成功导出 Obsidian Markdown 文件');
  };

  // -------------------------------------------------------------
  // Platform 3: 有道云笔记 States
  // -------------------------------------------------------------
  const [selectedYoudaoId, setSelectedYoudaoId] = useState<string>(youdaoNotes[0]?.id || '');
  const [youdaoSearch, setYoudaoSearch] = useState('');
  const [isEditingYoudao, setIsEditingYoudao] = useState(false);
  const [editYoudaoTitle, setEditYoudaoTitle] = useState(youdaoNotes[0]?.title || '');
  const [editYoudaoContent, setEditYoudaoContent] = useState(youdaoNotes[0]?.content || '');

  // Add Youdao modal
  const [isAddYoudaoModalOpen, setIsAddYoudaoModalOpen] = useState(false);
  const [newYoudaoTitle, setNewYoudaoTitle] = useState('');
  const [newYoudaoFolder, setNewYoudaoFolder] = useState('/工作/架构设计/');
  const [newYoudaoContent, setNewYoudaoContent] = useState('');

  const currentYoudaoNote = youdaoNotes.find((n) => n.id === selectedYoudaoId) || youdaoNotes[0];

  const filteredYoudaoNotes = youdaoNotes.filter(
    (n) => n.title.toLowerCase().includes(youdaoSearch.toLowerCase()) || n.folder.toLowerCase().includes(youdaoSearch.toLowerCase())
  );

  const handleSelectYoudaoNote = (note: YoudaoNote) => {
    setSelectedYoudaoId(note.id);
    setEditYoudaoTitle(note.title);
    setEditYoudaoContent(note.content);
    setIsEditingYoudao(false);
  };

  const handleSaveYoudaoEdit = () => {
    if (!currentYoudaoNote) return;
    const next = youdaoNotes.map((n) =>
      n.id === currentYoudaoNote.id
        ? { ...n, title: editYoudaoTitle, content: editYoudaoContent, updatedAt: Date.now(), size: new Blob([editYoudaoContent]).size }
        : n
    );
    onUpdateYoudaoNotes(next);
    setIsEditingYoudao(false);
    showToast('✅ 有道云笔记修改已保存');
  };

  const handleSyncYoudaoToObsidian = async (note: YoudaoNote) => {
    const { path, content } = formatYoudaoToObsidianMarkdown(note);
    const res = await createObsidianNote(obsidianConfig, path, content, obsidianNotes);
    if (res.success) {
      onUpdateObsidianNotes(res.notes);
      showToast(`🔄 已迁移至阿里云 OSS Obsidian 笔记库: ${path}`);
    }
  };

  const handleSyncYoudaoToNotes = (note: YoudaoNote) => {
    onAddQuickNote({
      id: `qn-${Date.now()}`,
      title: `[有道迁移] ${note.title}`,
      content: note.content,
      category: '深度知识',
      tags: ['有道云', note.folder.replace(/\//g, '')].filter(Boolean),
      updatedAt: Date.now()
    });
    showToast('📥 已转存至个人知识库');
  };

  const handleCreateYoudaoNote = () => {
    if (!newYoudaoTitle.trim()) return;
    const item: YoudaoNote = {
      id: `yd-${Date.now()}`,
      title: newYoudaoTitle.trim(),
      folder: newYoudaoFolder.trim(),
      content: newYoudaoContent.trim(),
      size: new Blob([newYoudaoContent]).size,
      updatedAt: Date.now()
    };
    onUpdateYoudaoNotes([item, ...youdaoNotes]);
    setSelectedYoudaoId(item.id);
    setEditYoudaoTitle(item.title);
    setEditYoudaoContent(item.content);
    setIsAddYoudaoModalOpen(false);
    setNewYoudaoTitle('');
    setNewYoudaoContent('');
    showToast('✅ 已新建有道云笔记');
  };

  const handleDeleteYoudao = (id: string) => {
    onUpdateYoudaoNotes(youdaoNotes.filter((n) => n.id !== id));
    showToast('🗑️ 有道笔记已删除');
  };

  return (
    <div className="space-y-6">
      {/* Toast Notification */}
      {toastMessage && (
        <div className="fixed bottom-6 right-6 z-50 px-4 py-2.5 rounded-xl bg-zinc-900 border border-zinc-700 text-zinc-100 text-xs font-mono shadow-2xl flex items-center gap-2 animate-in fade-in slide-in-from-bottom-2">
          <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
          <span>{toastMessage}</span>
        </div>
      )}

      {/* Main Header & Platform Segment Tabs */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 p-5 rounded-2xl bg-[#121316] border border-[#22242a]">
        <div>
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-purple-950/60 border border-purple-800/60 flex items-center justify-center text-purple-400">
              <Share2 className="w-5 h-5" />
            </div>
            <div>
              <h1 className="text-base font-bold text-zinc-100 flex items-center gap-2">
                多平台数据互通中枢 (Data Interop Hub)
                <span className="px-2 py-0.5 rounded-full text-[10px] font-mono bg-purple-950/70 border border-purple-800/60 text-purple-300">
                  三端联动
                </span>
              </h1>
              <p className="text-xs text-zinc-400 mt-0.5">
                实时查看与直接编辑 <span className="text-zinc-200 font-medium">阿里云 OSS (Obsidian)</span> · <span className="text-zinc-200 font-medium">五彩划词助手</span> · <span className="text-zinc-200 font-medium">有道云笔记</span>
              </p>
            </div>
          </div>
        </div>

        {/* Platform Switching Tabs */}
        <div className="flex items-center gap-1.5 p-1 bg-zinc-900/90 rounded-xl border border-zinc-800">
          <button
            onClick={() => setActivePlatform('obsidian')}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium flex items-center gap-2 transition-all ${
              activePlatform === 'obsidian'
                ? 'bg-purple-950/80 text-purple-300 border border-purple-800/80 shadow-sm'
                : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            <BookOpen className="w-3.5 h-3.5" />
            <span>Obsidian (阿里OSS)</span>
            <span className="px-1.5 py-0.2 rounded text-[10px] font-mono bg-purple-900/50 text-purple-200">
              {obsidianNotes.length}
            </span>
          </button>

          <button
            onClick={() => setActivePlatform('wucai')}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium flex items-center gap-2 transition-all ${
              activePlatform === 'wucai'
                ? 'bg-amber-950/80 text-amber-300 border border-amber-800/80 shadow-sm'
                : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            <Highlighter className="w-3.5 h-3.5" />
            <span>五彩划词助手</span>
            <span className="px-1.5 py-0.2 rounded text-[10px] font-mono bg-amber-900/50 text-amber-200">
              {wucaiHighlights.length}
            </span>
          </button>

          <button
            onClick={() => setActivePlatform('youdao')}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium flex items-center gap-2 transition-all ${
              activePlatform === 'youdao'
                ? 'bg-sky-950/80 text-sky-300 border border-sky-800/80 shadow-sm'
                : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            <FileText className="w-3.5 h-3.5" />
            <span>有道云笔记</span>
            <span className="px-1.5 py-0.2 rounded text-[10px] font-mono bg-sky-900/50 text-sky-200">
              {youdaoNotes.length}
            </span>
          </button>

          <button
            onClick={() => setActivePlatform('topology')}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium flex items-center gap-2 transition-all ${
              activePlatform === 'topology'
                ? 'bg-emerald-950/80 text-emerald-300 border border-emerald-800/80 shadow-sm'
                : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            <Network className="w-3.5 h-3.5" />
            <span>数据流转拓扑</span>
          </button>
        </div>
      </div>

      {/* ========================================================================= */}
      {/* TAB 1: OBSIDIAN 阿里云 OSS (查看 + 在线编辑 + 保存回 OSS) */}
      {/* ========================================================================= */}
      {activePlatform === 'obsidian' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 min-h-[640px]">
          {/* Left Column: Note Explorer */}
          <div className="lg:col-span-4 flex flex-col rounded-2xl bg-[#121316] border border-[#22242a] p-4">
            <div className="flex items-center justify-between gap-2 pb-3 border-b border-[#1e2026]">
              <div className="flex items-center gap-2">
                <HardDrive className="w-4 h-4 text-purple-400" />
                <span className="text-xs font-semibold text-zinc-200">Bucket: {obsidianConfig.bucket || '未配置'}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  onClick={handleTestOss}
                  disabled={isTestingOss}
                  className="px-2 py-1 rounded-lg bg-zinc-900 border border-zinc-800 text-zinc-300 hover:text-white text-[11px] font-mono flex items-center gap-1 disabled:opacity-50"
                  title="探测阿里云 OSS 真实直连与 CORS 状态"
                >
                  <RefreshCw className={`w-3 h-3 text-emerald-400 ${isTestingOss ? 'animate-spin' : ''}`} />
                  <span>{isTestingOss ? '探测中...' : '测连通'}</span>
                </button>
                <button
                  onClick={handleRefreshOssNotes}
                  disabled={isRefreshingOss}
                  className="p-1 rounded-lg bg-zinc-900 border border-zinc-800 text-zinc-400 hover:text-white text-xs"
                  title="从 OSS 刷新文件列表"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${isRefreshingOss ? 'animate-spin' : ''}`} />
                </button>
                <button
                  onClick={() => setIsCreateObsidianModalOpen(true)}
                  className="px-2.5 py-1 rounded-lg bg-purple-600 hover:bg-purple-500 text-white text-xs font-medium flex items-center gap-1 shadow-sm"
                  title="新建笔记到 OSS"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>新建</span>
                </button>
                <button
                  onClick={onOpenSettings}
                  className="p-1 rounded-lg bg-zinc-900 border border-zinc-800 text-zinc-400 hover:text-zinc-200"
                  title="配置 OSS 鉴权"
                >
                  <HardDrive className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            {/* Live OSS Connection Status Banner */}
            {ossTestResult && (
              <div className={`mt-2.5 p-2.5 rounded-xl border text-xs font-mono flex items-start gap-2 ${
                ossTestResult.success && ossTestResult.isRealOss
                  ? 'bg-emerald-950/40 border-emerald-800/60 text-emerald-300'
                  : 'bg-amber-950/40 border-amber-800/60 text-amber-300'
              }`}>
                {ossTestResult.success && ossTestResult.isRealOss ? (
                  <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                ) : (
                  <AlertCircle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                )}
                <div className="flex-1 min-w-0">
                  <p className="leading-snug">{ossTestResult.message}</p>
                  {!ossTestResult.isRealOss && (
                    <button
                      onClick={() => setShowCorsGuide(!showCorsGuide)}
                      className="text-[11px] underline text-amber-200 hover:text-white mt-1 block"
                    >
                      {showCorsGuide ? '收起 CORS 跨域配置指南' : '👉 查看阿里云控制台 1 分钟开通 CORS 指南'}
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* CORS Guide Drawer */}
            {showCorsGuide && (
              <div className="mt-2.5 p-3 rounded-xl bg-[#090a0c] border border-amber-800/60 text-[11px] text-zinc-300 font-mono space-y-1.5 leading-relaxed animate-in fade-in">
                <div className="font-bold text-amber-400 flex items-center justify-between">
                  <span>阿里云 OSS 跨域 (CORS) 设置三步法:</span>
                  <button onClick={() => setShowCorsGuide(false)} className="text-zinc-500 hover:text-white">✕</button>
                </div>
                <p>1. 登录阿里云控制台 ➔ 对象存储 OSS ➔ 存储桶 ({obsidianConfig.bucket || '您的存储桶'})</p>
                <p>2. 左侧菜单「数据安全」➔「跨域设置 (CORS)」➔ 点击「创建规则」</p>
                <p>3. 填入参数：</p>
                <div className="p-2 rounded bg-black/60 border border-zinc-800 text-[10px] space-y-0.5 text-zinc-400">
                  <p><b className="text-zinc-200">来源 (AllowedOrigin):</b> * 或 您的实际访问域名</p>
                  <p><b className="text-zinc-200">允许 Methods:</b> GET, PUT, DELETE, HEAD</p>
                  <p><b className="text-zinc-200">允许 Headers:</b> *</p>
                  <p><b className="text-zinc-200">暴露 Headers:</b> ETag, x-oss-request-id</p>
                </div>
              </div>
            )}

            <div className="relative my-3">
              <Search className="w-3.5 h-3.5 text-zinc-500 absolute left-3 top-2.5" />
              <input
                type="text"
                value={obsidianSearch}
                onChange={(e) => setObsidianSearch(e.target.value)}
                placeholder="搜索云端 Obsidian 笔记..."
                className="w-full bg-zinc-900 border border-zinc-800 rounded-xl pl-8 pr-3 py-1.5 text-xs text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-purple-600"
              />
            </div>

            {/* Note items list */}
            <div className="flex-1 overflow-y-auto space-y-2 pr-1">
              {filteredObsidianNotes.map((note) => {
                const isSelected = note.key === currentObsidianNote?.key;
                return (
                  <div
                    key={note.key}
                    onClick={() => handleSelectObsidianNote(note)}
                    className={`p-3 rounded-xl border cursor-pointer transition-all ${
                      isSelected
                        ? 'bg-purple-950/30 border-purple-800/80 shadow-sm'
                        : 'bg-zinc-900/50 border-zinc-800/60 hover:border-zinc-700'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2 mb-1">
                      <div className="flex items-center gap-2 min-w-0">
                        <FileText className={`w-3.5 h-3.5 shrink-0 ${isSelected ? 'text-purple-400' : 'text-zinc-400'}`} />
                        <h3 className={`text-xs font-semibold truncate ${isSelected ? 'text-purple-200' : 'text-zinc-200'}`}>
                          {note.title}
                        </h3>
                      </div>
                      <span className="text-[10px] font-mono text-zinc-500 shrink-0">
                        {(note.size / 1024).toFixed(1)} KB
                      </span>
                    </div>
                    <p className="text-[11px] text-zinc-500 font-mono truncate">{note.path}</p>
                    <div className="flex items-center justify-between text-[10px] text-zinc-500 mt-2 pt-1.5 border-t border-zinc-800/50">
                      <span>{new Date(note.lastModified).toLocaleDateString()}</span>
                      <span className="text-emerald-500/80 font-mono text-[9px]">OSS 同步中</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Right Column: Note Reader & Live Editor */}
          <div className="lg:col-span-8 flex flex-col rounded-2xl bg-[#121316] border border-[#22242a] overflow-hidden">
            {currentObsidianNote ? (
              <>
                {/* Note Header Bar */}
                <div className="p-4 border-b border-[#1e2026] flex flex-wrap items-center justify-between gap-3 bg-[#0f1013]">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <FileText className="w-4 h-4 text-purple-400 shrink-0" />
                      <h2 className="text-sm font-bold text-zinc-100 truncate">{currentObsidianNote.title}</h2>
                    </div>
                    <p className="text-[11px] text-zinc-500 font-mono truncate mt-0.5">{currentObsidianNote.path}</p>
                  </div>

                  <div className="flex items-center gap-2">
                    {/* View / Edit Mode Switch */}
                    <div className="flex items-center p-0.5 rounded-lg bg-zinc-900 border border-zinc-800 text-xs">
                      <button
                        onClick={() => {
                          setIsEditingObsidian(false);
                          setEditObsidianContent(currentObsidianNote.content || '');
                        }}
                        className={`px-2.5 py-1 rounded-md flex items-center gap-1.5 ${
                          !isEditingObsidian ? 'bg-zinc-800 text-zinc-100 font-medium' : 'text-zinc-400 hover:text-zinc-200'
                        }`}
                      >
                        <Eye className="w-3.5 h-3.5" />
                        <span>阅读</span>
                      </button>
                      <button
                        onClick={() => {
                          setIsEditingObsidian(true);
                          setEditObsidianContent(currentObsidianNote.content || '');
                        }}
                        className={`px-2.5 py-1 rounded-md flex items-center gap-1.5 ${
                          isEditingObsidian ? 'bg-purple-950/80 text-purple-300 font-medium border border-purple-800/60' : 'text-zinc-400 hover:text-zinc-200'
                        }`}
                      >
                        <Edit3 className="w-3.5 h-3.5" />
                        <span>编辑</span>
                      </button>
                    </div>

                    {isEditingObsidian && (
                      <button
                        onClick={handleSaveObsidian}
                        disabled={isSavingObsidian}
                        className="px-3 py-1 rounded-lg bg-purple-600 hover:bg-purple-500 text-white text-xs font-semibold flex items-center gap-1.5 shadow-sm disabled:opacity-50"
                      >
                        <Save className="w-3.5 h-3.5" />
                        <span>{isSavingObsidian ? '保存至 OSS...' : '保存修改'}</span>
                      </button>
                    )}

                    <button
                      onClick={() => handleDeleteObsidian(currentObsidianNote.key)}
                      className="p-1.5 rounded-lg bg-zinc-900 border border-zinc-800 text-zinc-400 hover:text-rose-400"
                      title="从 OSS 删除笔记"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>

                {/* Editor or Reader Body */}
                <div className="flex-1 p-5 overflow-y-auto">
                  {isEditingObsidian ? (
                    <div className="h-full flex flex-col space-y-3">
                      <div className="flex items-center justify-between text-xs text-zinc-500 font-mono border-b border-zinc-800/80 pb-2">
                        <span>支持标准 Markdown 语法 · 修改将直接同步至阿里云 OSS ({obsidianConfig.bucket})</span>
                        <span>{editObsidianContent.length} 字符</span>
                      </div>
                      <textarea
                        value={editObsidianContent}
                        onChange={(e) => setEditObsidianContent(e.target.value)}
                        placeholder="在此直接修改 Obsidian Markdown 笔记内容..."
                        className="w-full flex-1 min-h-[480px] p-4 bg-[#0a0b0d] border border-zinc-800/80 rounded-xl font-mono text-xs text-zinc-200 leading-relaxed focus:outline-none focus:border-purple-600 resize-none select-text"
                      />
                    </div>
                  ) : (
                    <div className="font-mono text-xs text-zinc-300 leading-relaxed whitespace-pre-wrap select-text bg-[#090a0c] p-6 rounded-xl border border-zinc-800/60 min-h-[480px]">
                      {currentObsidianNote.content || '暂无正文内容'}
                    </div>
                  )}
                </div>
              </>
            ) : (
              <div className="flex-1 flex flex-col items-center justify-center p-12 text-zinc-500">
                <BookOpen className="w-10 h-10 mb-3 opacity-40" />
                <p className="text-xs">未选择笔记</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* TAB 2: 五彩划词助手 (Wucai) (直接操作高亮、批注、一键转 Obsidian OSS) */}
      {/* ========================================================================= */}
      {activePlatform === 'wucai' && (
        <div className="space-y-4">
          {/* Controls Bar */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4 rounded-2xl bg-[#121316] border border-[#22242a]">
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative">
                <Search className="w-3.5 h-3.5 text-zinc-500 absolute left-3 top-2.5" />
                <input
                  type="text"
                  value={wucaiSearch}
                  onChange={(e) => setWucaiSearch(e.target.value)}
                  placeholder="搜索划词文本、思考、原文标题..."
                  className="w-64 bg-zinc-900 border border-zinc-800 rounded-xl pl-8 pr-3 py-1.5 text-xs text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-amber-600"
                />
              </div>

              {/* Color filter */}
              <div className="flex items-center gap-1 p-1 bg-zinc-900 rounded-xl border border-zinc-800">
                {['all', 'yellow', 'green', 'blue', 'purple'].map((col) => (
                  <button
                    key={col}
                    onClick={() => setWucaiColorFilter(col)}
                    className={`px-2 py-0.5 rounded text-[10px] font-mono capitalize ${
                      wucaiColorFilter === col ? 'bg-zinc-800 text-zinc-100 font-bold' : 'text-zinc-500 hover:text-zinc-300'
                    }`}
                  >
                    {col === 'all' ? '全部' : col}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={handleSyncFromExtension}
                disabled={isSyncingExtension}
                className="px-3 py-1.5 rounded-xl bg-indigo-950/70 border border-indigo-700/80 hover:bg-indigo-900 text-indigo-200 text-xs flex items-center gap-1.5 shadow-sm transition-all"
                title="通过浏览器扩展 Bridge 直接同步提取当前已划词高亮与批注"
              >
                <RefreshCw className={`w-3.5 h-3.5 text-indigo-400 ${isSyncingExtension ? 'animate-spin' : ''}`} />
                <span>{isSyncingExtension ? '同步中...' : '插件一键同步'}</span>
              </button>

              <button
                onClick={handleExportAllToMarkdown}
                className="px-3 py-1.5 rounded-xl bg-zinc-900 border border-zinc-800 text-zinc-300 hover:text-white text-xs flex items-center gap-1.5"
                title="导出所有划词为完整 Obsidian Markdown 离线文档"
              >
                <Download className="w-3.5 h-3.5 text-sky-400" />
                <span>导出 .md</span>
              </button>

              <button
                onClick={() => setIsWucaiTokenModalOpen(true)}
                className="px-3 py-1.5 rounded-xl bg-zinc-900 border border-zinc-800 text-zinc-300 hover:text-white text-xs flex items-center gap-1.5"
              >
                <Sparkles className="w-3.5 h-3.5 text-amber-400" />
                <span>配置五彩 Token</span>
              </button>

              <a
                href="https://doc.wucai.site/obsidian/"
                target="_blank"
                rel="noreferrer"
                className="px-3 py-1.5 rounded-xl bg-zinc-900 border border-zinc-800 text-amber-300 hover:text-white text-xs flex items-center gap-1.5"
                title="查看五彩官方 Obsidian 插件教程"
              >
                <ExternalLink className="w-3.5 h-3.5 text-amber-400" />
                <span>官方 Obsidian 插件教程</span>
              </a>

              <button
                onClick={() => setIsAddWucaiModalOpen(true)}
                className="px-3 py-1.5 rounded-xl bg-amber-500 hover:bg-amber-400 text-zinc-950 font-semibold text-xs flex items-center gap-1.5 shadow-sm"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>录入划词</span>
              </button>
            </div>
          </div>

          {/* Educational Practice Tip */}
          <div className="p-3.5 rounded-xl bg-amber-950/20 border border-amber-800/40 text-xs text-amber-200/90 flex items-start gap-2.5 leading-relaxed">
            <Sparkles className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
            <div>
              <span className="font-semibold text-amber-300">五彩官方 Obsidian 联动逻辑：</span>
              在你的本地 Obsidian 安装官方五彩插件后，网页划词与思考会自动保存为你 Obsidian 里的 Markdown 剪藏文件；再由 Remotely Save 插件增量同步到阿里云 OSS。在此面板中，你也可以直接修改批注，或点击「同步至 Obsidian OSS」生成标准笔记！
            </div>
          </div>

          {/* Highlights Grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {filteredWucaiHighlights.map((hl) => {
              const isEditing = editingWucaiId === hl.id;
              const colorBorder = 
                hl.color === 'yellow' ? 'border-l-amber-400' :
                hl.color === 'green' ? 'border-l-emerald-400' :
                hl.color === 'blue' ? 'border-l-sky-400' :
                hl.color === 'purple' ? 'border-l-purple-400' : 'border-l-rose-400';

              return (
                <div
                  key={hl.id}
                  className={`p-4 rounded-2xl bg-[#121316] border border-[#22242a] border-l-4 ${colorBorder} space-y-3 flex flex-col justify-between shadow-sm`}
                >
                  <div>
                    {/* Header: Origin Page */}
                    <div className="flex items-start justify-between gap-2 mb-2">
                      <a
                        href={hl.pageUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="text-xs font-semibold text-zinc-200 hover:text-amber-400 flex items-center gap-1.5 line-clamp-1"
                      >
                        <span>{hl.pageTitle}</span>
                        <ArrowUpRight className="w-3 h-3 shrink-0" />
                      </a>
                      <span className="text-[10px] font-mono text-zinc-500 shrink-0">
                        {new Date(hl.createdAt).toLocaleDateString()}
                      </span>
                    </div>

                    {/* Quoted Highlight text */}
                    <blockquote className="p-3 rounded-xl bg-[#0a0b0d] border border-zinc-800/80 text-xs text-zinc-300 leading-relaxed italic border-l-2 border-l-amber-500/80">
                      "{hl.text}"
                    </blockquote>

                    {/* User's Note / Thought */}
                    <div className="mt-3">
                      <div className="flex items-center justify-between text-[11px] font-semibold text-amber-400/90 mb-1">
                        <span className="flex items-center gap-1">
                          <Edit3 className="w-3 h-3" />
                          个人思考与批注
                        </span>
                        {!isEditing && (
                          <button
                            onClick={() => handleStartEditWucai(hl)}
                            className="text-[10px] text-zinc-500 hover:text-zinc-300 underline"
                          >
                            修改批注
                          </button>
                        )}
                      </div>

                      {isEditing ? (
                        <div className="space-y-2">
                          <textarea
                            value={editWucaiNote}
                            onChange={(e) => setEditWucaiNote(e.target.value)}
                            className="w-full p-2.5 rounded-lg bg-zinc-900 border border-zinc-700 text-xs text-zinc-100 font-sans focus:outline-none focus:border-amber-500"
                            rows={3}
                          />
                          <div className="flex justify-end gap-2">
                            <button
                              onClick={() => setEditingWucaiId(null)}
                              className="px-2.5 py-1 rounded bg-zinc-800 text-zinc-300 text-xs"
                            >
                              取消
                            </button>
                            <button
                              onClick={() => handleSaveWucaiEdit(hl.id)}
                              className="px-2.5 py-1 rounded bg-amber-500 text-zinc-950 font-semibold text-xs"
                            >
                              保存批注
                            </button>
                          </div>
                        </div>
                      ) : (
                        <p className="text-xs text-zinc-400 bg-zinc-900/40 p-2.5 rounded-xl border border-zinc-800/40">
                          {hl.note || '暂无批注思考'}
                        </p>
                      )}
                    </div>

                    {/* Tags */}
                    {hl.tags && hl.tags.length > 0 && (
                      <div className="flex flex-wrap gap-1.5 mt-2.5">
                        {hl.tags.map((t) => (
                          <span key={t} className="px-2 py-0.5 rounded-md text-[10px] font-mono bg-zinc-900 text-zinc-400 border border-zinc-800">
                            #{t}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Actions Bar */}
                  <div className="flex items-center justify-between pt-3 border-t border-zinc-800/60 mt-3 text-xs">
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => handleSyncWucaiToObsidian(hl)}
                        className="px-2.5 py-1 rounded-lg bg-purple-950/60 hover:bg-purple-900/80 border border-purple-800/60 text-purple-300 font-medium text-[11px] flex items-center gap-1 shadow-sm"
                        title="格式化并保存至阿里云 OSS 的 Obsidian 库"
                      >
                        <BookOpen className="w-3 h-3 text-purple-400" />
                        <span>同步至 Obsidian OSS</span>
                      </button>

                      <button
                        onClick={() => handleSyncWucaiToNotes(hl)}
                        className="px-2 py-1 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-zinc-300 text-[11px] flex items-center gap-1"
                        title="复制入个人知识文档"
                      >
                        <FileText className="w-3 h-3 text-zinc-400" />
                        <span>存入知识库</span>
                      </button>
                    </div>

                    <button
                      onClick={() => handleDeleteWucai(hl.id)}
                      className="p-1.5 rounded-lg text-zinc-500 hover:text-rose-400"
                      title="删除划词"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* TAB 3: 有道云笔记 (查看 + 修改 + 迁移/同步至 Obsidian OSS) */}
      {/* ========================================================================= */}
      {activePlatform === 'youdao' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 min-h-[640px]">
          {/* Left Column: Youdao Folder & Note Explorer */}
          <div className="lg:col-span-4 flex flex-col rounded-2xl bg-[#121316] border border-[#22242a] p-4">
            <div className="flex items-center justify-between gap-2 pb-3 border-b border-[#1e2026]">
              <div className="flex items-center gap-2">
                <FileText className="w-4 h-4 text-sky-400" />
                <span className="text-xs font-semibold text-zinc-200">有道云历史资产 ({youdaoNotes.length})</span>
              </div>
              <button
                onClick={() => setIsAddYoudaoModalOpen(true)}
                className="px-2.5 py-1 rounded-lg bg-sky-600 hover:bg-sky-500 text-white text-xs font-medium flex items-center gap-1 shadow-sm"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>新建</span>
              </button>
            </div>

            {/* Educational Practice Tip */}
            <div className="my-2.5 p-2.5 rounded-xl bg-sky-950/20 border border-sky-800/40 text-[11px] text-sky-200/90 leading-relaxed">
              <span className="font-semibold text-sky-300">有道云笔记迁移方案：</span>
              建议使用开源工具 <code className="px-1 py-0.5 rounded bg-black/40 text-sky-300 font-mono">youdaonote-pull</code> 一次性把所有历史笔记拉取为本地 Markdown 文件夹，直接放入 Obsidian 库同步到阿里云 OSS。选中文档点击「推送到 Obsidian OSS」也可单篇直推云端！
            </div>

            <div className="relative my-3">
              <Search className="w-3.5 h-3.5 text-zinc-500 absolute left-3 top-2.5" />
              <input
                type="text"
                value={youdaoSearch}
                onChange={(e) => setYoudaoSearch(e.target.value)}
                placeholder="搜索有道云笔记标题、目录..."
                className="w-full bg-zinc-900 border border-zinc-800 rounded-xl pl-8 pr-3 py-1.5 text-xs text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-sky-600"
              />
            </div>

            {/* Note items list */}
            <div className="flex-1 overflow-y-auto space-y-2 pr-1">
              {filteredYoudaoNotes.map((note) => {
                const isSelected = note.id === currentYoudaoNote?.id;
                return (
                  <div
                    key={note.id}
                    onClick={() => handleSelectYoudaoNote(note)}
                    className={`p-3 rounded-xl border cursor-pointer transition-all ${
                      isSelected
                        ? 'bg-sky-950/30 border-sky-800/80 shadow-sm'
                        : 'bg-zinc-900/50 border-zinc-800/60 hover:border-zinc-700'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2 mb-1">
                      <div className="flex items-center gap-2 min-w-0">
                        <Folder className={`w-3.5 h-3.5 shrink-0 ${isSelected ? 'text-sky-400' : 'text-zinc-500'}`} />
                        <h3 className={`text-xs font-semibold truncate ${isSelected ? 'text-sky-200' : 'text-zinc-200'}`}>
                          {note.title}
                        </h3>
                      </div>
                      <span className="text-[10px] font-mono text-zinc-500 shrink-0">
                        {(note.size / 1024).toFixed(1)} KB
                      </span>
                    </div>
                    <p className="text-[11px] text-zinc-500 font-mono truncate">{note.folder}</p>
                    <div className="flex items-center justify-between text-[10px] text-zinc-500 mt-2 pt-1.5 border-t border-zinc-800/50">
                      <span>{new Date(note.updatedAt).toLocaleDateString()}</span>
                      <span className="text-sky-400 font-mono text-[9px]">可迁移至 OSS</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Right Column: Note Reader & Live Editor */}
          <div className="lg:col-span-8 flex flex-col rounded-2xl bg-[#121316] border border-[#22242a] overflow-hidden">
            {currentYoudaoNote ? (
              <>
                {/* Note Header Bar */}
                <div className="p-4 border-b border-[#1e2026] flex flex-wrap items-center justify-between gap-3 bg-[#0f1013]">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <FileText className="w-4 h-4 text-sky-400 shrink-0" />
                      <h2 className="text-sm font-bold text-zinc-100 truncate">{currentYoudaoNote.title}</h2>
                    </div>
                    <p className="text-[11px] text-zinc-500 font-mono truncate mt-0.5">{currentYoudaoNote.folder}</p>
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => handleSyncYoudaoToObsidian(currentYoudaoNote)}
                      className="px-3 py-1.5 rounded-lg bg-purple-950/70 hover:bg-purple-900 border border-purple-800/70 text-purple-300 font-medium text-xs flex items-center gap-1.5 shadow-sm"
                      title="将当前有道笔记转换并保存至阿里云 OSS Obsidian 库"
                    >
                      <BookOpen className="w-3.5 h-3.5 text-purple-400" />
                      <span>推送到 Obsidian OSS</span>
                    </button>

                    <button
                      onClick={() => handleSyncYoudaoToNotes(currentYoudaoNote)}
                      className="px-2.5 py-1.5 rounded-lg bg-zinc-900 border border-zinc-800 text-zinc-300 text-xs flex items-center gap-1"
                    >
                      <span>存入知识库</span>
                    </button>

                    {/* View / Edit Mode Switch */}
                    <div className="flex items-center p-0.5 rounded-lg bg-zinc-900 border border-zinc-800 text-xs">
                      <button
                        onClick={() => {
                          setIsEditingYoudao(false);
                          setEditYoudaoTitle(currentYoudaoNote.title);
                          setEditYoudaoContent(currentYoudaoNote.content);
                        }}
                        className={`px-2 py-1 rounded-md flex items-center gap-1 ${
                          !isEditingYoudao ? 'bg-zinc-800 text-zinc-100 font-medium' : 'text-zinc-400'
                        }`}
                      >
                        <Eye className="w-3.5 h-3.5" />
                        <span>阅读</span>
                      </button>
                      <button
                        onClick={() => {
                          setIsEditingYoudao(true);
                          setEditYoudaoTitle(currentYoudaoNote.title);
                          setEditYoudaoContent(currentYoudaoNote.content);
                        }}
                        className={`px-2 py-1 rounded-md flex items-center gap-1 ${
                          isEditingYoudao ? 'bg-sky-950/80 text-sky-300 font-medium border border-sky-800/60' : 'text-zinc-400'
                        }`}
                      >
                        <Edit3 className="w-3.5 h-3.5" />
                        <span>编辑</span>
                      </button>
                    </div>

                    {isEditingYoudao && (
                      <button
                        onClick={handleSaveYoudaoEdit}
                        className="px-3 py-1 rounded-lg bg-sky-600 hover:bg-sky-500 text-white text-xs font-semibold flex items-center gap-1 shadow-sm"
                      >
                        <Save className="w-3.5 h-3.5" />
                        <span>保存</span>
                      </button>
                    )}

                    <button
                      onClick={() => handleDeleteYoudao(currentYoudaoNote.id)}
                      className="p-1.5 rounded-lg bg-zinc-900 border border-zinc-800 text-zinc-400 hover:text-rose-400"
                      title="删除有道笔记"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>

                {/* Editor or Reader Body */}
                <div className="flex-1 p-5 overflow-y-auto">
                  {isEditingYoudao ? (
                    <div className="h-full flex flex-col space-y-3">
                      <input
                        type="text"
                        value={editYoudaoTitle}
                        onChange={(e) => setEditYoudaoTitle(e.target.value)}
                        className="w-full p-2.5 rounded-xl bg-zinc-900 border border-zinc-800 text-sm font-bold text-zinc-100 focus:outline-none focus:border-sky-600"
                        placeholder="笔记标题"
                      />
                      <textarea
                        value={editYoudaoContent}
                        onChange={(e) => setEditYoudaoContent(e.target.value)}
                        placeholder="在此直接修改有道云笔记内容..."
                        className="w-full flex-1 min-h-[440px] p-4 bg-[#0a0b0d] border border-zinc-800/80 rounded-xl font-mono text-xs text-zinc-200 leading-relaxed focus:outline-none focus:border-sky-600 resize-none select-text"
                      />
                    </div>
                  ) : (
                    <div className="font-mono text-xs text-zinc-300 leading-relaxed whitespace-pre-wrap select-text bg-[#090a0c] p-6 rounded-xl border border-zinc-800/60 min-h-[480px]">
                      {currentYoudaoNote.content || '暂无正文内容'}
                    </div>
                  )}
                </div>
              </>
            ) : (
              <div className="flex-1 flex flex-col items-center justify-center p-12 text-zinc-500">
                <FileText className="w-10 h-10 mb-3 opacity-40" />
                <p className="text-xs">未选择有道笔记</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* TAB 4: 数据流转拓扑与连接架构 (Topology & Connections) */}
      {/* ========================================================================= */}
      {activePlatform === 'topology' && (
        <div className="p-6 rounded-2xl bg-[#121316] border border-[#22242a] space-y-6">
          <div className="max-w-2xl">
            <h2 className="text-sm font-semibold text-zinc-100 flex items-center gap-2">
              <Network className="w-4 h-4 text-emerald-400" />
              个人多平台全链路数据互通架构
            </h2>
            <p className="text-xs text-zinc-400 mt-1">
              通过 Self-Hub 统一边缘总线，彻底消灭孤岛：外网直接操作五彩划词、有道历史笔记与阿里云 OSS 上的 Obsidian 库，支持双向无缝流转。
            </p>
          </div>

          {/* Interactive Topology Cards */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="p-4 rounded-xl bg-zinc-900/60 border border-amber-800/40 space-y-3">
              <div className="flex items-center gap-2">
                <Highlighter className="w-4 h-4 text-amber-400" />
                <h3 className="text-xs font-semibold text-zinc-200">输入端：五彩划词助手</h3>
              </div>
              <p className="text-xs text-zinc-400 leading-relaxed">
                日常阅读网页技术文章时的精炼划词、思考火花。通过 OpenAPI Token 实时挂载入库。
              </p>
              <div className="p-2.5 rounded-lg bg-black/40 border border-zinc-800 font-mono text-[11px] text-amber-400 flex items-center justify-between">
                <span>状态: 已接入 ({wucaiHighlights.length} 标注)</span>
                <span className="text-emerald-400">活跃</span>
              </div>
            </div>

            <div className="p-4 rounded-xl bg-zinc-900/60 border border-sky-800/40 space-y-3">
              <div className="flex items-center gap-2">
                <FileText className="w-4 h-4 text-sky-400" />
                <h3 className="text-xs font-semibold text-zinc-200">输入端：有道云笔记</h3>
              </div>
              <p className="text-xs text-zinc-400 leading-relaxed">
                历史积累的代码片段、工作备忘与系统运维知识。可在中枢直接修改，支持一键打包转入 OSS。
              </p>
              <div className="p-2.5 rounded-lg bg-black/40 border border-zinc-800 font-mono text-[11px] text-sky-400 flex items-center justify-between">
                <span>状态: 已挂载 ({youdaoNotes.length} 篇文档)</span>
                <span className="text-emerald-400">活跃</span>
              </div>
            </div>

            <div className="p-4 rounded-xl bg-zinc-900/60 border border-purple-800/40 space-y-3">
              <div className="flex items-center gap-2">
                <HardDrive className="w-4 h-4 text-purple-400" />
                <h3 className="text-xs font-semibold text-zinc-200">最终归宿：阿里云 OSS (Obsidian)</h3>
              </div>
              <p className="text-xs text-zinc-400 leading-relaxed">
                作为全局唯一的 Markdown 真理之源。本地 Obsidian 客户端通过 Remotely Save 自动增量拉取。
              </p>
              <div className="p-2.5 rounded-lg bg-black/40 border border-zinc-800 font-mono text-[11px] text-purple-400 flex items-center justify-between">
                <span>Bucket: {obsidianConfig.bucket}</span>
                <span className="text-emerald-400">可读可写</span>
              </div>
            </div>
          </div>

          {/* Cloudflare Edge Bridge Banner */}
          <div className="p-4 rounded-xl bg-gradient-to-r from-purple-950/20 via-zinc-900 to-amber-950/20 border border-zinc-800 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div>
              <div className="text-xs font-semibold text-zinc-200 flex items-center gap-1.5">
                <ShieldCheck className="w-4 h-4 text-emerald-400" />
                <span>Zero-Knowledge 客户端端到端加固</span>
              </div>
              <p className="text-[11px] text-zinc-400 mt-0.5">
                所有连接密钥（OSS Secret、五彩 Token、有道 Cookie）均通过本地 PBKDF2 + AES-256-GCM 保护，永远不离开你的受信任设备。
              </p>
            </div>
            <button
              onClick={onOpenSettings}
              className="px-3.5 py-1.5 rounded-xl bg-zinc-100 text-zinc-900 font-semibold text-xs hover:bg-white transition-colors shrink-0"
            >
              配置外部云凭据
            </button>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* MODAL 1: 新建 Obsidian 笔记 */}
      {/* ========================================================================= */}
      {isCreateObsidianModalOpen && (
        <div 
          onClick={() => setIsCreateObsidianModalOpen(false)}
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in"
        >
          <div 
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-xl bg-[#121316] border border-zinc-800 rounded-2xl p-6 shadow-2xl space-y-4"
          >
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-zinc-100 flex items-center gap-2">
                <BookOpen className="w-4 h-4 text-purple-400" />
                新建笔记并直接推送至阿里云 OSS
              </h3>
              <button onClick={() => setIsCreateObsidianModalOpen(false)} className="text-zinc-500 hover:text-white">✕</button>
            </div>

            <div className="space-y-3">
              <div>
                <label className="block text-xs text-zinc-400 font-mono mb-1">文件相对路径 (如 Projects/MyNewDoc.md 或 Daily/2026-10-16.md)</label>
                <input
                  type="text"
                  value={newObsidianPath}
                  onChange={(e) => setNewObsidianPath(e.target.value)}
                  placeholder="Notes/架构设计思路.md"
                  className="w-full bg-zinc-900 border border-zinc-800 rounded-xl px-3 py-2 text-xs text-zinc-100 font-mono focus:outline-none focus:border-purple-600"
                />
              </div>

              <div>
                <label className="block text-xs text-zinc-400 font-mono mb-1">Markdown 初始正文</label>
                <textarea
                  value={newObsidianContent}
                  onChange={(e) => setNewObsidianContent(e.target.value)}
                  placeholder="# 笔记标题&#10;&#10;在此输入笔记正文..."
                  rows={8}
                  className="w-full bg-zinc-900 border border-zinc-800 rounded-xl p-3 text-xs text-zinc-100 font-mono focus:outline-none focus:border-purple-600"
                />
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                onClick={() => setIsCreateObsidianModalOpen(false)}
                className="px-3.5 py-1.5 rounded-xl bg-zinc-800 text-zinc-300 text-xs"
              >
                取消
              </button>
              <button
                onClick={handleCreateObsidianNote}
                className="px-4 py-1.5 rounded-xl bg-purple-600 hover:bg-purple-500 text-white font-semibold text-xs shadow-sm"
              >
                创建并写入 OSS
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* MODAL 2: 录入五彩划词标注 */}
      {/* ========================================================================= */}
      {isAddWucaiModalOpen && (
        <div 
          onClick={() => setIsAddWucaiModalOpen(false)}
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in"
        >
          <div 
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-xl bg-[#121316] border border-zinc-800 rounded-2xl p-6 shadow-2xl space-y-4"
          >
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-zinc-100 flex items-center gap-2">
                <Highlighter className="w-4 h-4 text-amber-400" />
                手动录入五彩划词批注
              </h3>
              <button onClick={() => setIsAddWucaiModalOpen(false)} className="text-zinc-500 hover:text-white">✕</button>
            </div>

            <div className="space-y-3">
              <div>
                <label className="block text-xs text-zinc-400 font-mono mb-1">网页文章标题</label>
                <input
                  type="text"
                  value={newWucaiTitle}
                  onChange={(e) => setNewWucaiTitle(e.target.value)}
                  placeholder="例如: Cloudflare 边缘计算最佳实践"
                  className="w-full bg-zinc-900 border border-zinc-800 rounded-xl px-3 py-2 text-xs text-zinc-100 focus:outline-none focus:border-amber-600"
                />
              </div>

              <div>
                <label className="block text-xs text-zinc-400 font-mono mb-1">原文 URL 链接</label>
                <input
                  type="text"
                  value={newWucaiUrl}
                  onChange={(e) => setNewWucaiUrl(e.target.value)}
                  placeholder="https://..."
                  className="w-full bg-zinc-900 border border-zinc-800 rounded-xl px-3 py-2 text-xs text-zinc-100 font-mono focus:outline-none focus:border-amber-600"
                />
              </div>

              <div>
                <label className="block text-xs text-zinc-400 font-mono mb-1">划线重点内容 (*必填)</label>
                <textarea
                  value={newWucaiText}
                  onChange={(e) => setNewWucaiText(e.target.value)}
                  placeholder="粘贴网页中划出的重点段落..."
                  rows={3}
                  className="w-full bg-zinc-900 border border-zinc-800 rounded-xl p-3 text-xs text-zinc-100 focus:outline-none focus:border-amber-600"
                />
              </div>

              <div>
                <label className="block text-xs text-zinc-400 font-mono mb-1">个人思考与批注</label>
                <textarea
                  value={newWucaiNote}
                  onChange={(e) => setNewWucaiNote(e.target.value)}
                  placeholder="输入你对这段话的看法、启示或实现思路..."
                  rows={2}
                  className="w-full bg-zinc-900 border border-zinc-800 rounded-xl p-3 text-xs text-zinc-100 focus:outline-none focus:border-amber-600"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-zinc-400 font-mono mb-1">高亮色标</label>
                  <select
                    value={newWucaiColor}
                    onChange={(e) => setNewWucaiColor(e.target.value as any)}
                    className="w-full bg-zinc-900 border border-zinc-800 rounded-xl px-3 py-2 text-xs text-zinc-100"
                  >
                    <option value="yellow">🟡 黄色重点</option>
                    <option value="green">🟢 绿色精句</option>
                    <option value="blue">🔵 蓝色架构</option>
                    <option value="purple">🟣 紫色灵感</option>
                    <option value="red">🔴 红色预警</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-zinc-400 font-mono mb-1">标签 (逗号分隔)</label>
                  <input
                    type="text"
                    value={newWucaiTags}
                    onChange={(e) => setNewWucaiTags(e.target.value)}
                    placeholder="架构, 前端, 安全"
                    className="w-full bg-zinc-900 border border-zinc-800 rounded-xl px-3 py-2 text-xs text-zinc-100"
                  />
                </div>
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                onClick={() => setIsAddWucaiModalOpen(false)}
                className="px-3.5 py-1.5 rounded-xl bg-zinc-800 text-zinc-300 text-xs"
              >
                取消
              </button>
              <button
                onClick={handleCreateWucaiHighlight}
                className="px-4 py-1.5 rounded-xl bg-amber-500 hover:bg-amber-400 text-zinc-950 font-semibold text-xs shadow-sm"
              >
                确认录入
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* MODAL 3: 配置五彩 Token */}
      {/* ========================================================================= */}
      {isWucaiTokenModalOpen && (
        <div 
          onClick={() => setIsWucaiTokenModalOpen(false)}
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in"
        >
          <div 
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-md bg-[#121316] border border-zinc-800 rounded-2xl p-6 shadow-2xl space-y-4"
          >
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-zinc-100 flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-amber-400" />
                配置五彩 OpenAPI 个人访问令牌
              </h3>
              <button onClick={() => setIsWucaiTokenModalOpen(false)} className="text-zinc-500 hover:text-white">✕</button>
            </div>

            <p className="text-xs text-zinc-400">
              在五彩插件个人中心（doc.wucai.site / wucai.site）设置中复制个人访问令牌，配置后可直接跨端调取与双向修改划词。
            </p>

            <div>
              <label className="block text-xs text-zinc-400 font-mono mb-1">OpenAPI Token</label>
              <input
                type="password"
                value={wucaiTokenInput}
                onChange={(e) => setWucaiTokenInput(e.target.value)}
                placeholder="wc_pat_••••••••"
                className="w-full bg-zinc-900 border border-zinc-800 rounded-xl px-3 py-2 text-xs text-zinc-100 font-mono focus:outline-none focus:border-amber-600"
              />
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                onClick={() => setIsWucaiTokenModalOpen(false)}
                className="px-3.5 py-1.5 rounded-xl bg-zinc-800 text-zinc-300 text-xs"
              >
                取消
              </button>
              <button
                onClick={handleSaveWucaiToken}
                className="px-4 py-1.5 rounded-xl bg-amber-500 text-zinc-950 font-semibold text-xs shadow-sm"
              >
                保存令牌
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* MODAL 4: 新建有道云笔记 */}
      {/* ========================================================================= */}
      {isAddYoudaoModalOpen && (
        <div 
          onClick={() => setIsAddYoudaoModalOpen(false)}
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in"
        >
          <div 
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-xl bg-[#121316] border border-zinc-800 rounded-2xl p-6 shadow-2xl space-y-4"
          >
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-zinc-100 flex items-center gap-2">
                <FileText className="w-4 h-4 text-sky-400" />
                新建有道云笔记
              </h3>
              <button onClick={() => setIsAddYoudaoModalOpen(false)} className="text-zinc-500 hover:text-white">✕</button>
            </div>

            <div className="space-y-3">
              <div>
                <label className="block text-xs text-zinc-400 font-mono mb-1">笔记标题</label>
                <input
                  type="text"
                  value={newYoudaoTitle}
                  onChange={(e) => setNewYoudaoTitle(e.target.value)}
                  placeholder="例如: 生产机负载均衡配置指南"
                  className="w-full bg-zinc-900 border border-zinc-800 rounded-xl px-3 py-2 text-xs text-zinc-100 focus:outline-none focus:border-sky-600"
                />
              </div>

              <div>
                <label className="block text-xs text-zinc-400 font-mono mb-1">目录路径</label>
                <input
                  type="text"
                  value={newYoudaoFolder}
                  onChange={(e) => setNewYoudaoFolder(e.target.value)}
                  placeholder="/工作/架构设计/"
                  className="w-full bg-zinc-900 border border-zinc-800 rounded-xl px-3 py-2 text-xs text-zinc-100 font-mono focus:outline-none focus:border-sky-600"
                />
              </div>

              <div>
                <label className="block text-xs text-zinc-400 font-mono mb-1">Markdown 正文</label>
                <textarea
                  value={newYoudaoContent}
                  onChange={(e) => setNewYoudaoContent(e.target.value)}
                  placeholder="# 标题&#10;&#10;输入正文内容..."
                  rows={6}
                  className="w-full bg-zinc-900 border border-zinc-800 rounded-xl p-3 text-xs text-zinc-100 font-mono focus:outline-none focus:border-sky-600"
                />
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                onClick={() => setIsAddYoudaoModalOpen(false)}
                className="px-3.5 py-1.5 rounded-xl bg-zinc-800 text-zinc-300 text-xs"
              >
                取消
              </button>
              <button
                onClick={handleCreateYoudaoNote}
                className="px-4 py-1.5 rounded-xl bg-sky-600 hover:bg-sky-500 text-white font-semibold text-xs shadow-sm"
              >
                创建笔记
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
