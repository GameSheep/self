import React, { useState, useEffect, useRef } from 'react';
import { 
  Search, 
  ExternalLink, 
  Server, 
  Key, 
  BookOpen, 
  Clock, 
  FileText, 
  ArrowRight, 
  X, 
  Copy, 
  Check,
  FolderKanban,
  Inbox
} from 'lucide-react';
import { NavSite, ServerDeployment, SecretItem, ObsidianNote, ReminderItem, QuickNote, ProjectItem, InboxItem } from '../types';
import { matchesQuery } from '../lib/searchEngine';
import { decryptText } from '../lib/crypto';
import { loadIndex, searchIndex, type IndexedDoc } from '../lib/vaultIndex';

interface GlobalSearchProps {
  isOpen: boolean;
  onClose: () => void;
  sites: NavSite[];
  servers: ServerDeployment[];
  secrets: SecretItem[];
  notes: QuickNote[];
  reminders: ReminderItem[];
  obsidianNotes: ObsidianNote[];
  projects?: ProjectItem[];
  inbox?: InboxItem[];
  masterPassword: string | null;
  onRequireUnlock: () => void;
  onSelectSite: (url: string) => void;
  onSelectServer: (server: ServerDeployment) => void;
  onSelectNote?: (note: QuickNote) => void;
  onSelectProject?: (proj: ProjectItem) => void;
  onSelectInbox?: (item: InboxItem) => void;
  /** Open a note from the OSS vault by its key (full-text index hit). */
  onSelectVaultNote?: (key: string) => void;
}

export const GlobalSearch: React.FC<GlobalSearchProps> = ({
  isOpen,
  onClose,
  sites,
  servers,
  secrets,
  notes,
  reminders,
  obsidianNotes,
  projects = [],
  inbox = [],
  masterPassword,
  onRequireUnlock,
  onSelectSite,
  onSelectServer,
  onSelectNote,
  onSelectProject,
  onSelectInbox,
  onSelectVaultNote
}) => {
  const [query, setQuery] = useState('');
  const [activeFilter, setActiveFilter] = useState<'all' | 'site' | 'server' | 'secret' | 'reminder' | 'note' | 'project' | 'inbox'>('all');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [indexDocs, setIndexDocs] = useState<IndexedDoc[]>([]);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Pull the local full-text index the first time the palette opens.
  useEffect(() => {
    if (!isOpen || indexDocs.length > 0) return;
    let alive = true;
    loadIndex().then((docs) => {
      if (alive) setIndexDocs(docs);
    });
    return () => {
      alive = false;
    };
  }, [isOpen, indexDocs.length]);

  useEffect(() => {
    if (isOpen) {
      setTimeout(() => inputRef.current?.focus(), 50);
      setQuery('');
      setSelectedIndex(0);
      setActiveFilter('all');
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', handleGlobalKeyDown, true);
    return () => window.removeEventListener('keydown', handleGlobalKeyDown, true);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const q = query.trim();

  // Multi-entity search with Pinyin & full-text matching
  const matchedSites = sites
    .filter(s => matchesQuery(`${s.title} ${s.url} ${s.category} ${s.description || ''} ${(s.tags || []).join(' ')}`, q))
    .slice(0, 6);

  const matchedServers = servers
    .filter(srv => matchesQuery(`${srv.name} ${srv.publicIp} ${srv.domain || ''} ${srv.sshUser || ''} ${srv.notes || ''} ${srv.env}`, q))
    .slice(0, 5);

  const matchedSecrets = secrets
    .filter(sec => matchesQuery(`${sec.name} ${sec.description || ''} ${sec.category} ${(sec.tags || []).join(' ')}`, q))
    .slice(0, 4);

  const matchedReminders = reminders
    .filter(rem => matchesQuery(`${rem.title} ${rem.cost || ''} ${rem.notes || ''} ${rem.category}`, q))
    .slice(0, 4);

  const matchedNotes = notes
    .filter(n => matchesQuery(`${n.title} ${n.content} ${n.category || ''} ${(n.tags || []).join(' ')}`, q))
    .slice(0, 4);

  const matchedObsidian = obsidianNotes
    .filter(n => matchesQuery(`${n.title} ${n.path} ${n.content || ''}`, q))
    .slice(0, 4);

  const matchedProjects = projects
    .filter(p => matchesQuery(`${p.name} ${p.description} ${(p.tags || []).join(' ')} ${p.status}`, q))
    .slice(0, 4);

  const matchedInbox = inbox
    .filter(i => matchesQuery(`${i.content} ${i.title || ''} ${i.url || ''} ${i.type}`, q))
    .slice(0, 4);

  /**
   * Full-text hits over the local vault index. Grouped separately from the
   * filename-based `obsidianNotes` matches, which only see loaded metadata.
   */
  const matchedVault = q.length >= 2 ? searchIndex(indexDocs, q, 6) : [];

  // Group all results based on activeFilter
  const allResults = [
    ...(activeFilter === 'all' || activeFilter === 'project' ? matchedProjects.map(p => ({ type: 'project' as const, item: p, title: p.name, sub: p.description, category: `项目·${p.status}` })) : []),
    ...(activeFilter === 'all' || activeFilter === 'inbox' ? matchedInbox.map(i => ({ type: 'inbox' as const, item: i, title: i.title || i.content.slice(0, 30), sub: i.url || i.content, category: '收件箱' })) : []),
    ...(activeFilter === 'all' || activeFilter === 'site' ? matchedSites.map(s => ({ type: 'site' as const, item: s, title: s.title, sub: s.url, category: s.category })) : []),
    ...(activeFilter === 'all' || activeFilter === 'server' ? matchedServers.map(srv => ({ type: 'server' as const, item: srv, title: srv.name, sub: `${srv.publicIp}:${srv.port} (${srv.sshUser})`, category: srv.env.toUpperCase() })) : []),
    ...(activeFilter === 'all' || activeFilter === 'secret' ? matchedSecrets.map(sec => ({ type: 'secret' as const, item: sec, title: sec.name, sub: sec.maskedPreview, category: 'AES加密' })) : []),
    ...(activeFilter === 'all' || activeFilter === 'reminder' ? matchedReminders.map(rem => ({ type: 'reminder' as const, item: rem, title: rem.title, sub: `到期日: ${new Date(rem.targetDate).toLocaleDateString()} ${rem.cost || ''}`, category: '时效提醒' })) : []),
    ...(activeFilter === 'all' || activeFilter === 'note' ? matchedVault.map(hit => ({ type: 'vault' as const, item: hit, title: hit.title, sub: hit.snippet, category: `正文·${hit.key.split('/').slice(0, -1).join('/') || '根目录'}` })) : []),
    ...(activeFilter === 'all' || activeFilter === 'note' ? matchedNotes.map(n => ({ type: 'note' as const, item: n, title: n.title, sub: n.content.slice(0, 60), category: n.category || '知识文档' })) : []),
    ...(activeFilter === 'all' || activeFilter === 'note' ? matchedObsidian.map(obs => ({ type: 'obsidian' as const, item: obs, title: obs.title, sub: obs.path, category: 'Obsidian' })) : [])
  ];

  const handleExecute = async (res: typeof allResults[0]) => {
    if (res.type === 'site') {
      onSelectSite((res.item as NavSite).url);
    } else if (res.type === 'server') {
      onSelectServer(res.item as ServerDeployment);
    } else if (res.type === 'secret') {
      const sec = res.item as SecretItem;
      if (!masterPassword) {
        onRequireUnlock();
        return;
      }
      try {
        const plain = await decryptText(sec.encryptedValue, sec.iv, sec.salt, masterPassword);
        navigator.clipboard.writeText(plain);
        setCopiedId(sec.id);
        setTimeout(() => setCopiedId(null), 2000);
      } catch {
        onRequireUnlock();
      }
    } else if (res.type === 'reminder') {
      const rem = res.item as ReminderItem;
      if (rem.url) window.open(rem.url, '_blank');
    } else if (res.type === 'note' && onSelectNote) {
      onSelectNote(res.item as QuickNote);
    } else if (res.type === 'project' && onSelectProject) {
      onSelectProject(res.item as ProjectItem);
    } else if (res.type === 'inbox' && onSelectInbox) {
      onSelectInbox(res.item as InboxItem);
    } else if (res.type === 'vault' && onSelectVaultNote) {
      onSelectVaultNote((res.item as { key: string }).key);
    }
    onClose();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex(prev => (prev + 1) % Math.max(1, allResults.length));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex(prev => (prev - 1 + allResults.length) % Math.max(1, allResults.length));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const current = allResults[selectedIndex];
      if (current) handleExecute(current);
    }
  };

  return (
    <div 
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-start justify-center pt-14 sm:pt-20 p-3 sm:p-4 bg-black/80 backdrop-blur-sm animate-in fade-in"
    >
      <div 
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-2xl bg-[#121316] border border-zinc-800 rounded-2xl shadow-2xl overflow-hidden flex flex-col"
      >
        {/* Search Input Bar */}
        <div className="flex items-center gap-3 px-4 py-3.5 border-b border-zinc-800">
          <Search className="w-4 h-4 text-zinc-400 shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelectedIndex(0);
            }}
            onKeyDown={handleKeyDown}
            placeholder="强力拼音/英文/全文检索 (如: github, cf, chat, vps, 1.2.3.4, 密码)..."
            className="w-full bg-transparent text-xs sm:text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none"
          />
          <div className="flex items-center gap-1.5 shrink-0">
            <kbd className="hidden sm:inline-block px-1.5 py-0.5 text-[10px] font-mono bg-zinc-800 text-zinc-400 rounded border border-zinc-700">
              ESC
            </kbd>
            <button
              onClick={onClose}
              className="p-1 rounded-lg hover:bg-zinc-800 text-zinc-400 hover:text-white"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Faceted Filter Filter Strip */}
        <div className="flex items-center gap-1 px-3 py-1.5 bg-zinc-900/60 border-b border-zinc-800 text-[11px] overflow-x-auto scrollbar-none">
          <button
            onClick={() => setActiveFilter('all')}
            className={`px-2.5 py-1 rounded-md transition-colors ${activeFilter === 'all' ? 'bg-zinc-800 text-white font-semibold' : 'text-zinc-400 hover:text-zinc-200'}`}
          >
            全部 ({allResults.length})
          </button>
          <button
            onClick={() => setActiveFilter('site')}
            className={`px-2.5 py-1 rounded-md transition-colors ${activeFilter === 'site' ? 'bg-zinc-800 text-white font-semibold' : 'text-zinc-400 hover:text-zinc-200'}`}
          >
            网站 ({matchedSites.length})
          </button>
          <button
            onClick={() => setActiveFilter('server')}
            className={`px-2.5 py-1 rounded-md transition-colors ${activeFilter === 'server' ? 'bg-zinc-800 text-white font-semibold' : 'text-zinc-400 hover:text-zinc-200'}`}
          >
            服务器 ({matchedServers.length})
          </button>
          <button
            onClick={() => setActiveFilter('project')}
            className={`px-2.5 py-1 rounded-md transition-colors ${activeFilter === 'project' ? 'bg-zinc-800 text-white font-semibold' : 'text-zinc-400 hover:text-zinc-200'}`}
          >
            项目 ({matchedProjects.length})
          </button>
          <button
            onClick={() => setActiveFilter('inbox')}
            className={`px-2.5 py-1 rounded-md transition-colors ${activeFilter === 'inbox' ? 'bg-zinc-800 text-white font-semibold' : 'text-zinc-400 hover:text-zinc-200'}`}
          >
            收件箱 ({matchedInbox.length})
          </button>
          <button
            onClick={() => setActiveFilter('secret')}
            className={`px-2.5 py-1 rounded-md transition-colors ${activeFilter === 'secret' ? 'bg-zinc-800 text-white font-semibold' : 'text-zinc-400 hover:text-zinc-200'}`}
          >
            金库 ({matchedSecrets.length})
          </button>
          <button
            onClick={() => setActiveFilter('reminder')}
            className={`px-2.5 py-1 rounded-md transition-colors ${activeFilter === 'reminder' ? 'bg-zinc-800 text-white font-semibold' : 'text-zinc-400 hover:text-zinc-200'}`}
          >
            提醒 ({matchedReminders.length})
          </button>
          <button
            onClick={() => setActiveFilter('note')}
            className={`px-2.5 py-1 rounded-md transition-colors ${activeFilter === 'note' ? 'bg-zinc-800 text-white font-semibold' : 'text-zinc-400 hover:text-zinc-200'}`}
          >
            知识文档 ({matchedNotes.length + matchedObsidian.length})
          </button>
        </div>

        {/* Results List */}
        <div className="p-2 max-h-[60vh] overflow-y-auto space-y-1" data-testid="global-search-results">
          {allResults.length === 0 ? (
            <div className="p-8 text-center text-xs text-zinc-500">
              未找到匹配资产，支持输入拼音首字母（如 ali 匹配阿里云，gh 匹配 GitHub）
            </div>
          ) : (
            allResults.map((res, idx) => {
              const isSelected = idx === selectedIndex;
              return (
                <div
                  key={`${res.type}-${idx}`}
                  onClick={() => handleExecute(res)}
                  onMouseEnter={() => setSelectedIndex(idx)}
                  className={`flex items-center justify-between p-2.5 rounded-xl text-xs cursor-pointer transition-colors ${
                    isSelected ? 'bg-zinc-800 text-white' : 'text-zinc-300 hover:bg-zinc-900'
                  }`}
                >
                  <div className="flex items-center gap-3 min-w-0 flex-1">
                    <div className="w-6 h-6 rounded-md bg-zinc-900 border border-zinc-800 flex items-center justify-center shrink-0">
                      {res.type === 'site' && <ExternalLink className="w-3.5 h-3.5 text-sky-400" />}
                      {res.type === 'server' && <Server className="w-3.5 h-3.5 text-emerald-400" />}
                      {res.type === 'secret' && <Key className="w-3.5 h-3.5 text-amber-400" />}
                      {res.type === 'reminder' && <Clock className="w-3.5 h-3.5 text-orange-400" />}
                      {res.type === 'note' && <FileText className="w-3.5 h-3.5 text-purple-400" />}
                      {res.type === 'obsidian' && <BookOpen className="w-3.5 h-3.5 text-purple-400" />}
                      {res.type === 'project' && <FolderKanban className="w-3.5 h-3.5 text-emerald-400" />}
                      {res.type === 'inbox' && <Inbox className="w-3.5 h-3.5 text-amber-400" />}
                    </div>

                    <div className="min-w-0 flex-1">
                      <div className="font-semibold truncate">{res.title}</div>
                      <div className="text-[11px] text-zinc-400 font-mono truncate">{res.sub}</div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0 ml-2">
                    <span className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-zinc-900 text-zinc-400 border border-zinc-800">
                      {res.category}
                    </span>
                    {isSelected && <ArrowRight className="w-3.5 h-3.5 text-zinc-400" />}
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Footer shortcuts info */}
        <div className="flex items-center justify-between px-4 py-2 border-t border-zinc-800/80 bg-zinc-900/40 text-[10px] text-zinc-500 font-mono">
          <div className="flex items-center gap-3">
            <span>↑↓ 切换</span>
            <span>Enter 执行</span>
            <span>ESC 关闭</span>
          </div>
          <span>支持拼音首字母检索 · Command Palette</span>
        </div>

      </div>
    </div>
  );
};
