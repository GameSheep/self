import React, { useEffect, useState } from 'react';
import clsx from 'clsx';
import { AlertTriangle, Check, Info, X } from 'lucide-react';

/**
 * 全站唯一的轻提示：`showToast(message, tone)`，在 App 挂一次 <ToastHost />。
 * tone 决定图标和颜色——警告是三角，成功才是勾；不用 Context，因为调用方
 * 都是深层回调，传 props 会把十几个组件串成 toast 链。
 */

export type ToastTone = 'ok' | 'warn' | 'danger' | 'info';

interface ToastItem {
  id: number;
  message: string;
  tone: ToastTone;
}

const TONE_STYLE: Record<ToastTone, { icon: React.ReactNode; className: string }> = {
  ok: { icon: <Check className="w-4 h-4 text-sh-ok shrink-0" aria-hidden />, className: 'border-sh-ok/40' },
  warn: { icon: <AlertTriangle className="w-4 h-4 text-sh-warn shrink-0" aria-hidden />, className: 'border-sh-warn/50' },
  danger: { icon: <AlertTriangle className="w-4 h-4 text-sh-danger shrink-0" aria-hidden />, className: 'border-sh-danger/50' },
  info: { icon: <Info className="w-4 h-4 text-sh-info shrink-0" aria-hidden />, className: 'border-sh-info/50' }
};

const TOAST_MS = 3000;
let nextId = 1;
let listener: ((items: ToastItem[]) => void) | null = null;
let items: ToastItem[] = [];
let removeTimer: ReturnType<typeof setTimeout> | null = null;

function emit() {
  listener?.(items);
}

export function showToast(message: string, tone: ToastTone = 'ok') {
  // 单条展示：新消息顶掉旧消息。队列会让人读不过来，单人工具一次一件事。
  // 旧文案带着 📥💾🗑️✅⚠️ 一类前缀——图标和颜色现在由 tone 表达，前缀剥离。
  const clean = message.replace(/^[\p{Extended_Pictographic}\u2139\u2190-\u21ff\u2600-\u27bf\uFE0F\u200d\s]+/u, '').trim() || message;
  if (removeTimer) clearTimeout(removeTimer);
  items = [{ id: nextId++, message: clean, tone }];
  emit();
  removeTimer = setTimeout(() => {
    items = [];
    emit();
  }, TOAST_MS);
}

export function dismissToast() {
  if (removeTimer) clearTimeout(removeTimer);
  items = [];
  emit();
}

/** 挂在 App 顶层一次。没有消息时不渲染任何东西。 */
export const ToastHost: React.FC = () => {
  const [current, setCurrent] = useState<ToastItem | null>(null);

  useEffect(() => {
    listener = (list) => setCurrent(list[list.length - 1] ?? null);
    return () => {
      listener = null;
    };
  }, []);

  if (!current) return null;
  const style = TONE_STYLE[current.tone];
  return (
    <div className="fixed bottom-6 right-6 z-[70] max-w-sm" role="status" aria-live="polite">
      <div
        data-toast-tone={current.tone}
        className={clsx(
          'flex items-start gap-2 px-4 py-2.5 rounded-xl bg-sh-surface border shadow-2xl text-sh-fg text-xs leading-relaxed',
          style.className
        )}
      >
        {style.icon}
        <span className="min-w-0 break-words">{current.message}</span>
        <button
          onClick={dismissToast}
          aria-label="关闭提示"
          className="shrink-0 text-sh-subtle hover:text-sh-fg"
        >
          <X className="w-3.5 h-3.5" aria-hidden />
        </button>
      </div>
    </div>
  );
};
