import React, { useMemo, useState } from 'react';
import { ClipboardPaste } from 'lucide-react';
import type { AiConfig, NavSite, QuickNote } from '../../types';
import { recognizePastedSites, toNavSites, type RecognizedSite } from '../../domain/siteCapture';
import { classifyHostsWithAi, CloudAiDisabledError } from '../../domain/classifySites';
import { CaptureConfirmDialog, type CaptureDestinations } from '../../shared/ui/CaptureConfirmDialog';

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
 * Paste anything that contains links; the sites are recognised locally, then a confirmation
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
        <CaptureConfirmDialog
          testId="paste-capture-dialog"
          open={candidates !== null}
          count={recognized}
          candidates={candidates.map((candidate) => ({
            key: candidate.url,
            title: candidate.title,
            category: candidate.category,
            url: candidate.url
          }))}
          categories={categories}
          onCandidateTitleChange={(index, title) =>
            setCandidates((current) => (current ?? []).map((c, i) => (i === index ? { ...c, title } : c)))
          }
          onCandidateCategoryChange={(index, category) =>
            setCandidates((current) => (current ?? []).map((c, i) => (i === index ? { ...c, category } : c)))
          }
          destinations={destinations}
          onDestinationsChange={setDestinations}
          aiAssist={
            cloudAiReady && candidates.length > 0
              ? { busy: aiBusy, message: aiMessage, onRun: () => void classifyWithAi() }
              : undefined
          }
          onConfirm={confirm}
          onClose={close}
        />
      )}
    </section>
  );
};

export default PasteCapture;
