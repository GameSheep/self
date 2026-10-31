import React, { useEffect, useRef } from 'react';
import { Check, Sparkles, X } from 'lucide-react';
import { inputClass } from './index';

/**
 * 「把一段内容确认入库」的共享确认对话框（S1 收敛）。
 *
 * 录入曾经有四个入口、三种确认模型、四种落点（TopBar AI 向导 / 快捷导航粘贴
 * 识别 / 首页捕捉 / 新标签页）。这里把粘贴识别那条最完整的确认流抽成组件：
 * 候选列表（可改标题与分类）+ 去向三选 + 确认/取消。规则只有一条——
 * 「识别到就自动存」和「让我确认」必须兼容，所以确认的是去向，不是与否。
 *
 * Escape 关闭与首输入框 autoFocus 在这里统一兑现（旧实现两者皆无，Tab 会
 * 走到被遮罩盖住的底层页面）。注意：新标签页是原生 JS 环境，无法复用 React
 * 组件，它的两个录入模块保持各自的原生流程。
 */

export interface CaptureCandidate {
  /** Stable key (通常就是规范化后的 URL)。 */
  key: string;
  title: string;
  category?: string;
  url?: string;
}

export interface CaptureDestinations {
  sites: boolean;
  inbox: boolean;
  note: boolean;
}

export interface CaptureConfirmDialogProps {
  open: boolean;
  count: number;
  /** 识别结果为 0 时的说明（例如：仍可存原文）。 */
  emptyNotice?: string;
  candidates?: CaptureCandidate[];
  categories?: string[];
  onCandidateTitleChange?: (index: number, title: string) => void;
  onCandidateCategoryChange?: (index: number, category: string) => void;
  destinations: CaptureDestinations;
  onDestinationsChange: (next: CaptureDestinations) => void;
  /** 可选的云端分类辅助（只在云 AI 已启用时由调用方传入）。 */
  aiAssist?: { busy: boolean; message?: string | null; onRun: () => void };
  /// 宿主可保留自己的 testid（e2e 契约）。
  testId?: string;
  confirmLabel?: string;
  onConfirm: () => void;
  onClose: () => void;
}

const DESTINATION_LABELS: Array<[keyof CaptureDestinations, string]> = [
  ['sites', '快捷导航（网站）'],
  ['inbox', '收件箱（原文）'],
  ['note', '资料库笔记（原文）']
];

export const CaptureConfirmDialog: React.FC<CaptureConfirmDialogProps> = ({
  open,
  count,
  emptyNotice,
  candidates,
  categories = [],
  onCandidateTitleChange,
  onCandidateCategoryChange,
  destinations,
  onDestinationsChange,
  aiAssist,
  testId = 'capture-confirm-dialog',
  confirmLabel = '确认保存',
  onConfirm,
  onClose
}) => {
  const firstFieldRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    // Esc 关闭 + 初始焦点：键盘用户不再被锁在遮罩外。
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    const focusTimer = setTimeout(() => firstFieldRef.current?.focus(), 0);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      clearTimeout(focusTimer);
    };
  }, [open, onClose]);

  if (!open) return null;
  const categoryOptions = Array.from(new Set([...categories.filter((c) => c !== '全部'), '默认分类']));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" data-testid={testId}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`确认保存 ${count} 项`}
        onKeyDown={(e) => e.stopPropagation()}
        className="w-full max-w-2xl rounded-2xl border border-sh-line bg-sh-surface shadow-2xl"
      >
        <div className="flex items-center justify-between border-b border-sh-line px-4 py-3">
          <h3 className="text-sm font-semibold text-sh-fg">
            识别到 {count} 个网站{count === 0 ? '（这段文字里没有链接）' : ''}
          </h3>
          <button onClick={onClose} aria-label="关闭" className="p-1 rounded hover:bg-sh-surface2">
            <X className="w-4 h-4 text-sh-muted" aria-hidden />
          </button>
        </div>

        <div className="max-h-[40vh] overflow-y-auto px-4 py-3 space-y-2">
          {!candidates || candidates.length === 0 ? (
            <p className="text-xs text-sh-muted">{emptyNotice ?? '没识别出链接。可以改成存到收件箱或笔记，整段原文都会保留。'}</p>
          ) : (
            candidates.map((candidate, index) => (
              <div key={candidate.key} className="rounded-lg border border-sh-line p-2 space-y-1.5" data-candidate={index}>
                <input
                  ref={index === 0 ? firstFieldRef : undefined}
                  value={candidate.title}
                  onChange={(e) => onCandidateTitleChange?.(index, e.target.value)}
                  aria-label="网站标题"
                  data-testid={`paste-candidate-title-${index}`}
                  className={inputClass}
                />
                <div className="flex flex-wrap items-center gap-2">
                  {candidate.url && (
                    <span className="text-[11px] text-sh-subtle font-mono truncate flex-1 min-w-[160px]">{candidate.url}</span>
                  )}
                  {onCandidateCategoryChange && (
                    <select
                      value={candidate.category ?? '默认分类'}
                      onChange={(e) => onCandidateCategoryChange(index, e.target.value)}
                      aria-label="分类"
                      data-testid={`paste-candidate-category-${index}`}
                      className="bg-sh-surface2 border border-sh-line rounded px-2 py-1 text-[11px] text-sh-fg"
                    >
                      {Array.from(new Set([...categoryOptions, candidate.category ?? '默认分类'])).map((cat) => (
                        <option key={cat} value={cat}>
                          {cat}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              </div>
            ))
          )}
        </div>

        <div className="border-t border-sh-line px-4 py-3 space-y-2">
          <p className="text-[11px] text-sh-muted">这些内容存到哪里去？</p>

          {aiAssist && candidates && candidates.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={aiAssist.onRun}
                disabled={aiAssist.busy}
                data-testid="paste-ai-classify"
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-sh-line text-[11px] text-sh-info hover:bg-sh-surface2 disabled:opacity-50"
              >
                <Sparkles className="w-3 h-3" aria-hidden />
                {aiAssist.busy ? '云端分类中…' : '用云端 AI 猜分类（只发送域名）'}
              </button>
              {aiAssist.message && (
                <span className="text-[10px] text-sh-subtle" data-testid="paste-ai-message">
                  {aiAssist.message}
                </span>
              )}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-3">
            {DESTINATION_LABELS.map(([key, label]) => (
              <label key={key} className="inline-flex items-center gap-1.5 text-[11px] text-sh-fg">
                <input
                  type="checkbox"
                  checked={destinations[key]}
                  onChange={(e) => onDestinationsChange({ ...destinations, [key]: e.target.checked })}
                  data-destination={key}
                />
                {label}
              </label>
            ))}
          </div>

          <div className="flex items-center gap-2 pt-1">
            <button
              onClick={onConfirm}
              data-testid="paste-capture-save"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-sh-accent text-sh-accent-fg text-xs font-semibold"
            >
              <Check className="w-3.5 h-3.5" aria-hidden />
              {confirmLabel}
            </button>
            <button onClick={onClose} className="px-3 py-1.5 rounded-lg border border-sh-line text-xs">
              取消
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
