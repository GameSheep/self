import React, { useState } from 'react';
import { BookOpen, Search, FileText, ExternalLink, Calendar, HardDrive, RefreshCw } from 'lucide-react';
import { ObsidianConfig, ObsidianNote } from '../../types';

interface ObsidianCardProps {
  config: ObsidianConfig;
  notes?: ObsidianNote[];
  onOpenSettings: () => void;
}

export const ObsidianCard: React.FC<ObsidianCardProps> = ({ config, notes = [], onOpenSettings }) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedNote, setSelectedNote] = useState<ObsidianNote | null>(null);

  const filteredNotes = notes.filter(
    (n) => n.title.toLowerCase().includes(searchTerm.toLowerCase()) || n.path.toLowerCase().includes(searchTerm.toLowerCase())
  );

  return (
    <div className="p-5 rounded-2xl bg-[#121316] border border-[#22242a] shadow-sm">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-purple-950/40 border border-purple-800/40 flex items-center justify-center text-purple-400">
            <BookOpen className="w-4 h-4" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold text-zinc-100">Obsidian 远程同步库 (阿里云 OSS)</h2>
              <span className={`px-1.5 py-0.5 rounded text-[10px] font-mono ${
                config.enabled ? 'bg-emerald-950/60 text-emerald-400 border border-emerald-800/50' : 'bg-zinc-800 text-zinc-400'
              }`}>
                {config.enabled ? '已启用' : '未挂载'}
              </span>
            </div>
            <p className="text-xs text-zinc-500 font-mono mt-0.5">
              Bucket: {config.bucket || '未配置'} ({notes.length} 篇同步笔记)
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-zinc-500 absolute left-2.5 top-2.5" />
            <input
              type="text"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="搜索 Obsidian 笔记..."
              className="bg-zinc-900 border border-zinc-800 rounded-lg pl-8 pr-3 py-1.5 text-xs text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-zinc-750"
            />
          </div>
          <button
            onClick={onOpenSettings}
            className="p-1.5 rounded-lg bg-zinc-900 border border-zinc-800 text-zinc-400 hover:text-white text-xs"
            title="配置 OSS 鉴权"
          >
            <HardDrive className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Note List Grid */}
      {filteredNotes.length > 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {filteredNotes.map((note) => (
            <div
              key={note.key}
              onClick={() => setSelectedNote(note)}
              className="p-3.5 rounded-xl bg-zinc-900/60 border border-zinc-800/80 hover:border-zinc-700 cursor-pointer transition-colors"
            >
              <div className="flex items-center gap-2 mb-1.5">
                <FileText className="w-4 h-4 text-purple-400 shrink-0" />
                <h3 className="text-xs font-semibold text-zinc-200 truncate">{note.title}</h3>
              </div>
              <p className="text-[11px] text-zinc-500 font-mono truncate mb-2">{note.path}</p>
              <div className="flex items-center justify-between text-[10px] text-zinc-500 border-t border-zinc-800/60 pt-2">
                <span className="flex items-center gap-1">
                  <Calendar className="w-3 h-3" />
                  {new Date(note.lastModified).toLocaleDateString()}
                </span>
                <span>{(note.size / 1024).toFixed(1)} KB</span>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="p-8 text-center border border-dashed border-zinc-800/80 rounded-xl bg-zinc-900/20">
          <FileText className="w-8 h-8 text-zinc-600 mx-auto mb-2" />
          <p className="text-xs text-zinc-400">暂无同步笔记</p>
          <p className="text-[11px] text-zinc-500 mt-1">在右上方设置中配置阿里云 OSS 存储桶或增量同步知识库</p>
        </div>
      )}

      {/* Note Content Reader Modal */}
      {selectedNote && (
        <div 
          onClick={() => setSelectedNote(null)}
          className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-black/80 backdrop-blur-sm animate-in fade-in"
        >
          <div 
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-3xl max-h-[85vh] bg-[#121316] border border-zinc-800 rounded-2xl flex flex-col shadow-2xl overflow-hidden"
          >
            {/* Header */}
            <div className="flex items-center justify-between p-4 border-b border-zinc-800">
              <div className="flex items-center gap-2">
                <FileText className="w-4 h-4 text-purple-400" />
                <h3 className="text-sm font-semibold text-zinc-100">{selectedNote.title}</h3>
                <span className="text-xs text-zinc-500 font-mono">({selectedNote.path})</span>
              </div>
              <button
                onClick={() => setSelectedNote(null)}
                className="px-2.5 py-1 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-xs text-zinc-300"
              >
                关闭
              </button>
            </div>

            {/* Markdown Body */}
            <div className="p-6 overflow-y-auto font-mono text-xs text-zinc-300 leading-relaxed whitespace-pre-wrap select-text bg-[#0e0f12]">
              {selectedNote.content || '无内容'}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
