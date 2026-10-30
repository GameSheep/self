import React, { useMemo, useState } from 'react';
import { ClipboardPaste, Sparkles, Check, X } from 'lucide-react';
import type { AiConfig, NavSite, QuickNote } from '../../types';
import { recognizePastedSites, toNavSites, type RecognizedSite } from '../../domain/siteCapture';
import { classifyHostsWithAi, CloudAiDisabledError } from '../../domain/classifySites';
import { inputClass } from '../../shared/ui';

export interface PasteCaptureProps {
  categories: string[];
  /** Needed to know whether cloud AI may be offered at all. */
  aiConfig?: AiConfig;
  /** Write the confirmed sites into 快捷导航. */
  onAddSites: (sites: NavSite[]) => void;
  /** Copy the original paste into 收件箱. */
  onCaptureInbox: (raw: string) => void;
  /** Store the paste as a note. */
  onAddNote: (note: QuickNote) => void;
}

interface Destinations {
  sites: boolean;
  inbox: boolean;
  note: boolean;
}

/**
 * 粘贴识别 (2).
 *
 * Paste anything that contains links; the sites are recognised locally, then a confirmation
 * dialog asks **where the content should go** (快捷导航 / 收件箱 / 笔记). Nothing is written
 * until the user confirms — "识别到就自动存" plus "让我确认" is only compatible if confirmation
 * means "confirm the destinations", which is what this does.
 */
export const PasteCapture: React.FC<PasteCaptureProps> = ({
  categories,
  aiConfig,
  onAddSites,
  onCaptureInbox,
  onAddNote
}) => {
  const [raw, setRaw] = useState('');
  const [candidates, setCandidates] = useState<RecognizedSite[] | null>(null);
  const [destinations, setDestinations] = useState<Destinations>({ sites: true, inbox: false, note: false });
  const [savedMessage, setSavedMessage] = useState<string | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiMessage, setAiMessage] = useState<string | null>(null);
  const cloudAiReady = aiConfig?.cloudAiEnabled === true && Boolean(aiConfig?.apiKey);

  /** Optional: ask the cloud for categories. Only the hostnames are sent. */
  const classifyWithAi = async () => {
    if (!candidates || !aiConfig) return;
    setAiBusy(true);
    setAiMessage(null);
    try {
      const result = await classifyHostsWithAi(
        candidates.map((candidate) => candidate.host),
        aiConfig,
        categories
      );
      setCandidates((current) =>
        (current ?? []).map((candidate) => ({
          ...candidate,
          category: result.categories[candidate.host] ?? candidate.category
        }))
      );
      const applied = Object.keys(result.categories).length;
      setAiMessage(
        applied > 0
          ? `云端给出了 ${applied} 个分类（只发送了域名）`
          : '云端没有给出可用的分类，保留了本地判断'
      );
    } catch (error) {
      setAiMessage(
        error instanceof CloudAiDisabledError
          ? '云端 AI 未开启，仍使用本地分类'
          : `云端分类失败：${String((error as Error).message || error)}`
      );
    } finally {
      setAiBusy(false);
    }
  };

  const recognized = useMemo(
    () => (candidates ? candidates.length : 0),
    [candidates]
  );

  const recognize = () => {
    const found = recognizePastedSites(raw, categories);
    setCandidates(found);
    setSavedMessage(null);
  };

  const close = () => {
    setCandidates(null);
    setRaw('');
  };

  const confirm = () => {
    if (!candidates) return;
    const parts: string[] = [];
    if (destinations.sites && candidates.length > 0) {
      onAddSites(toNavSites(candidates));
      parts.push(`${candidates.length} 个网站`);
    }
    if (destinations.inbox && raw.trim()) {
      onCaptureInbox(raw.trim());
      parts.push('收件箱 1 条');
    }
    if (destinations.note && raw.trim()) {
      onAddNote({
        id: `note-${Date.now()}`,
        title: (candidates[0]?.title || '粘贴记录').slice(0, 80),
        content: raw.trim(),
        category: '速记',
        tags: [],
        updatedAt: Date.now()
      });
      parts.push('笔记 1 篇');
    }
    setSavedMessage(parts.length ? `已保存：${parts.join('、')}` : '没有选择任何去处，什么也没保存。');
    close();
  };

  return (
    <section className="rounded-2xl border border-sh-line bg-sh-surface p-4 mb-3" data-testid="paste-capture">
      <div className="flex items-center gap-2 mb-2">
        <ClipboardPaste className="w-4 h-4 text-sh-subtle" aria-hidden />
        <h2 className="text-xs font-semibold text-sh-fg">粘贴识别</h2>
        <span className="text-[11px] text-sh-subtle">粘一段带链接的文字，自动识别出网站</span>
      </div>

      <div className="flex flex-col sm:flex-row gap-2">
        <textarea
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          onPaste={(e) => {
            // Recognise immediately on paste so the dialog is one step away.
            const text = `${e.clipboardData.getData('text')}`;
            if (text.trim()) {
              setTimeout(() => {
                const found = recognizePastedSites(text, categories);
                if (found.length > 0) {
                  setRaw(text);
                  setCandidates(found);
                  setSavedMessage(null);
                }
              }, 0);
            }
          }}
          rows={2}
          placeholder="例如：把收藏夹里的一段贴上，或直接粘贴 https://example.com 这样的链接"
          data-testid="paste-capture-input"
          className="flex-1 bg-sh-surface2 border border-sh-line rounded-xl px-3 py-2 text-xs text-sh-fg focus:outline-none focus:border-sh-line-strong resize-y"
        />
        <button
          onClick={recognize}
          disabled={!raw.trim()}
          data-testid="paste-capture-recognize"
          className="px-3 py-1.5 rounded-lg bg-sh-accent text-sh-accent-fg text-xs font-semibold disabled:opacity-50 self-start"
        >
          识别
        </button>
      </div>

      {savedMessage && (
        <p className="mt-2 text-[11px] text-sh-ok" data-testid="paste-capture-feedback">
          {savedMessage}
        </p>
      )}

      {candidates && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" data-testid="paste-capture-dialog">
          <div className="w-full max-w-2xl rounded-2xl border border-sh-line bg-sh-surface shadow-2xl">
            <div className="flex items-center justify-between border-b border-sh-line px-4 py-3">
              <h3 className="text-sm font-semibold text-sh-fg">
                识别到 {recognized} 个网站{recognized === 0 ? '（这段文字里没有链接）' : ''}
              </h3>
              <button onClick={close} aria-label="关闭" className="p-1 rounded hover:bg-sh-surface2">
                <X className="w-4 h-4 text-sh-muted" aria-hidden />
              </button>
            </div>

            <div className="max-h-[40vh] overflow-y-auto px-4 py-3 space-y-2">
              {candidates.length === 0 ? (
                <p className="text-xs text-sh-muted">没识别出链接。可以改成「存到收件箱」或「存到笔记」，整段原文都会保留。</p>
              ) : (
                candidates.map((candidate, index) => (
                  <div key={candidate.url} className="rounded-lg border border-sh-line p-2 space-y-1.5" data-candidate={index}>
                    <input
                      value={candidate.title}
                      onChange={(e) => {
                        const next = [...candidates];
                        next[index] = { ...candidate, title: e.target.value };
                        setCandidates(next);
                      }}
                      aria-label="网站标题"
                      data-testid={`paste-candidate-title-${index}`}
                      className={inputClass}
                    />
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[11px] text-sh-subtle font-mono truncate flex-1 min-w-[160px]">{candidate.url}</span>
                      <select
                        value={candidate.category}
                        onChange={(e) => {
                          const next = [...candidates];
                          next[index] = { ...candidate, category: e.target.value };
                          setCandidates(next);
                        }}
                        aria-label="分类"
                        data-testid={`paste-candidate-category-${index}`}
                        className="bg-sh-surface2 border border-sh-line rounded px-2 py-1 text-[11px] text-sh-fg"
                      >
                        {Array.from(new Set([...categories.filter((c) => c !== '全部'), candidate.category])).map((cat) => (
                          <option key={cat} value={cat}>
                            {cat}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                ))
              )}
            </div>

            <div className="border-t border-sh-line px-4 py-3 space-y-2">
              <p className="text-[11px] text-sh-muted">这些内容存到哪里去？</p>

              {/* Cloud assist is opt-in per paste and only when cloud AI is enabled. */}
              {cloudAiReady && candidates.length > 0 && (
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    onClick={() => void classifyWithAi()}
                    disabled={aiBusy}
                    data-testid="paste-ai-classify"
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-sh-line text-[11px] text-sh-info hover:bg-sh-surface2 disabled:opacity-50"
                  >
                    <Sparkles className="w-3 h-3" aria-hidden />
                    {aiBusy ? '云端分类中…' : '用云端 AI 猜分类（只发送域名）'}
                  </button>
                  {aiMessage && (
                    <span className="text-[10px] text-sh-subtle" data-testid="paste-ai-message">
                      {aiMessage}
                    </span>
                  )}
                </div>
              )}
              <div className="flex flex-wrap items-center gap-3">
                {(
                  [
                    ['sites', '快捷导航（网站）'],
                    ['inbox', '收件箱（原文）'],
                    ['note', '资料库笔记（原文）']
                  ] as const
                ).map(([key, label]) => (
                  <label key={key} className="inline-flex items-center gap-1.5 text-[11px] text-sh-fg">
                    <input
                      type="checkbox"
                      checked={destinations[key]}
                      onChange={(e) => setDestinations({ ...destinations, [key]: e.target.checked })}
                      data-destination={key}
                    />
                    {label}
                  </label>
                ))}
              </div>
              <div className="flex items-center gap-2 pt-1">
                <button
                  onClick={confirm}
                  data-testid="paste-capture-save"
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-sh-accent text-sh-accent-fg text-xs font-semibold"
                >
                  <Check className="w-3.5 h-3.5" aria-hidden />
                  确认保存
                </button>
                <button onClick={close} className="px-3 py-1.5 rounded-lg border border-sh-line text-xs">
                  取消
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </section>
  );
};

export default PasteCapture;
