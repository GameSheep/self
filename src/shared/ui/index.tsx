/**
 * Shared UI primitives (P1-02).
 *
 * Before this, every view invented its own button, its own empty state and its
 * own "saving / saved / failed" text — so "did that save?" looked different in
 * each module, and the same success colour could mean two different things.
 * These primitives are deliberately small: no state, no context, no theming
 * engine. They only fix the vocabulary (tone, size, feedback state) so that a
 * status means the same thing on every page.
 */
import React from 'react';
import clsx from 'clsx';
import { AlertTriangle, Check, Info, Loader2, X } from 'lucide-react';
/* -------------------------------------------------------------------------- */
/* Button                                                                     */
/* -------------------------------------------------------------------------- */

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Show a spinner and block repeat clicks while an async action runs. */
  busy?: boolean;
  icon?: React.ReactNode;
}

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-sh-accent text-sh-accent-fg hover:opacity-90 font-semibold',
  secondary: 'bg-sh-surface2 text-sh-fg border border-sh-line hover:border-sh-line-strong',
  ghost: 'text-sh-muted hover:text-sh-fg hover:bg-sh-surface2',
  danger: 'bg-sh-danger text-white hover:opacity-90 font-semibold'
};

const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: 'px-2.5 py-1 text-[11px] rounded-lg gap-1.5',
  md: 'px-3 py-1.5 text-xs rounded-xl gap-1.5'
};

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', busy = false, icon, className, children, disabled, ...rest },
  ref
) {
  return (
    <button
      ref={ref}
      type={rest.type ?? 'button'}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className={clsx(
        'inline-flex items-center justify-center transition-colors disabled:opacity-50 disabled:cursor-not-allowed',
        BUTTON_SIZES[size],
        BUTTON_VARIANTS[variant],
        className
      )}
      {...rest}
    >
      {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" aria-hidden /> : icon}
      {children}
    </button>
  );
});

/* -------------------------------------------------------------------------- */
/* Status                                                                     */
/* -------------------------------------------------------------------------- */

export type StatusTone = 'neutral' | 'ok' | 'warn' | 'danger' | 'info';

const TONE_TEXT: Record<StatusTone, string> = {
  neutral: 'text-sh-muted',
  ok: 'text-sh-ok',
  warn: 'text-sh-warn',
  danger: 'text-sh-danger',
  info: 'text-sh-info'
};

const TONE_BORDER: Record<StatusTone, string> = {
  neutral: 'border-sh-line',
  ok: 'border-sh-ok/50',
  warn: 'border-sh-warn/50',
  danger: 'border-sh-danger/50',
  info: 'border-sh-info/50'
};

/**
 * Status is never colour-only: every tone also carries its own text label, and
 * the icons differ. A colour-blind user can still tell "检测通过" from "检测失败".
 */
export function StatusPill({
  tone = 'neutral',
  label,
  className,
  title
}: {
  tone?: StatusTone;
  label: React.ReactNode;
  className?: string;
  title?: string;
}) {
  const Icon = tone === 'ok' ? Check : tone === 'danger' || tone === 'warn' ? AlertTriangle : Info;
  return (
    <span
      title={title}
      data-tone={tone}
      className={clsx(
        'inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] font-medium shrink-0',
        TONE_BORDER[tone],
        TONE_TEXT[tone],
        className
      )}
    >
      <Icon className="w-3 h-3 shrink-0" aria-hidden />
      {label}
    </span>
  );
}

export function StatusDot({ tone = 'neutral', label }: { tone?: StatusTone; label: string }) {
  return (
    <span className={clsx('inline-flex items-center gap-1.5 text-[11px]', TONE_TEXT[tone])}>
      <span
        aria-hidden
        className={clsx(
          'w-1.5 h-1.5 rounded-full shrink-0',
          tone === 'ok' && 'bg-sh-ok',
          tone === 'warn' && 'bg-sh-warn',
          tone === 'danger' && 'bg-sh-danger',
          tone === 'info' && 'bg-sh-info',
          tone === 'neutral' && 'bg-sh-subtle'
        )}
      />
      {label}
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* Field                                                                      */
/* -------------------------------------------------------------------------- */

export interface FieldProps {
  label: string;
  htmlFor?: string;
  hint?: string;
  error?: string;
  required?: boolean;
  children: React.ReactNode;
  className?: string;
}

/** Label + control + hint + error. Forms always have a visible label. */
export function Field({ label, htmlFor, hint, error, required, children, className }: FieldProps) {
  return (
    <div className={clsx('min-w-0', className)}>
      <label htmlFor={htmlFor} className="block text-[11px] font-medium text-sh-muted mb-1">
        {label}
        {required && <span className="text-sh-danger ml-0.5">*</span>}
      </label>
      {children}
      {hint && !error && <p className="mt-1 text-[11px] text-sh-subtle leading-relaxed">{hint}</p>}
      {error && (
        <p className="mt-1 text-[11px] text-sh-danger leading-relaxed" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export const inputClass =
  'w-full bg-sh-surface2 border border-sh-line rounded-lg px-3 py-1.5 text-xs text-sh-fg placeholder:text-sh-subtle focus:outline-none focus:border-sh-line-strong';

/* -------------------------------------------------------------------------- */
/* EmptyState                                                                 */
/* -------------------------------------------------------------------------- */

export interface EmptyStateProps {
  icon?: React.ReactNode;
  title: string;
  description?: string;
  /** The next concrete step. An empty state without one is a dead end. */
  action?: React.ReactNode;
  className?: string;
}

export function EmptyState({ icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div
      className={clsx(
        'flex flex-col items-center justify-center text-center gap-2 rounded-xl border border-dashed border-sh-line bg-sh-surface/40 px-4 py-8',
        className
      )}
    >
      {icon && <div className="text-sh-subtle">{icon}</div>}
      <div className="text-xs font-medium text-sh-fg">{title}</div>
      {description && <p className="text-[11px] text-sh-muted max-w-sm leading-relaxed">{description}</p>}
      {action && <div className="mt-1 flex items-center gap-2">{action}</div>}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* SaveFeedback                                                               */
/* -------------------------------------------------------------------------- */

export type SaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';

/**
 * One vocabulary for persistence, used by every connection form and preference
 * control. `saved` may only be passed when the writer actually confirmed the
 * write — the whole point of P1-08 is that a green tick never lies.
 */
export function SaveFeedback({
  state,
  message,
  onRetry,
  className
}: {
  state: SaveState;
  message?: string;
  onRetry?: () => void;
  className?: string;
}) {
  if (state === 'idle') return null;
  const map: Record<Exclude<SaveState, 'idle'>, { text: string; className: string; icon: React.ReactNode }> = {
    dirty: { text: message || '有未保存的修改', className: 'text-sh-warn', icon: <AlertTriangle className="w-3 h-3" /> },
    saving: { text: message || '保存中…', className: 'text-sh-muted', icon: <Loader2 className="w-3 h-3 animate-spin" /> },
    saved: { text: message || '已保存', className: 'text-sh-ok', icon: <Check className="w-3 h-3" /> },
    error: { text: message || '保存失败', className: 'text-sh-danger', icon: <AlertTriangle className="w-3 h-3" /> }
  };
  const view = map[state];
  return (
    <span className={clsx('inline-flex items-center gap-1 text-[11px]', view.className, className)} role="status">
      {view.icon}
      {view.text}
      {state === 'error' && onRetry && (
        <button className="underline hover:no-underline" onClick={onRetry}>
          重试
        </button>
      )}
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* ConfirmDialog                                                              */
/* -------------------------------------------------------------------------- */

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'default' | 'danger';
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Replaces `window.confirm`. Native confirm cannot show a list of affected
 * items ("删除该项目会移除 3 条关联，但不删除它们") and cannot be styled to
 * match the destructive action.
 */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = '确定',
  cancelLabel = '取消',
  tone = 'default',
  busy,
  onConfirm,
  onCancel
}: ConfirmDialogProps) {
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCancel();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, onCancel]);

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center p-4"
      style={{ background: 'var(--sh-overlay)' }}
      onClick={onCancel}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-2xl border border-sh-line bg-sh-surface p-4 space-y-3 shadow-2xl"
      >
        <div className="flex items-start justify-between gap-3">
          <h3 className={clsx('text-sm font-semibold', tone === 'danger' ? 'text-sh-danger' : 'text-sh-fg')}>{title}</h3>
          <button onClick={onCancel} className="p-1 rounded-lg text-sh-subtle hover:text-sh-fg" aria-label="关闭">
            <X className="w-4 h-4" />
          </button>
        </div>
        {description && <div className="text-xs text-sh-muted leading-relaxed">{description}</div>}
        <div className="flex items-center justify-end gap-2 pt-1">
          <Button variant="secondary" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button variant={tone === 'danger' ? 'danger' : 'primary'} onClick={onConfirm} busy={busy}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* VaultStateBadge                                                            */
/* -------------------------------------------------------------------------- */

/**
 * 金库状态的唯一口径。之前金库页、侧栏、设置页各自措辞——设置页甚至在
 * 「已设主密码但金库锁定」时显示「主密码：未设置」（它只看会话解锁变量）。
 * 三个事实分开表达：没设过主密码 / 设了但锁定 / 已解锁。
 */
export function VaultStateBadge({
  hasMasterAuth,
  unlocked,
  className
}: {
  hasMasterAuth: boolean;
  unlocked: boolean;
  className?: string;
}) {
  const tone: StatusTone = !hasMasterAuth ? 'neutral' : unlocked ? 'ok' : 'warn';
  const label = !hasMasterAuth ? '未设置主密码' : unlocked ? '金库已解锁' : '金库已锁定';
  return <StatusPill tone={tone} label={label} className={className} data-vault-state={!hasMasterAuth ? 'none' : unlocked ? 'unlocked' : 'locked'} />;
}

/* -------------------------------------------------------------------------- */
/* Page scaffolding                                                           */
/* -------------------------------------------------------------------------- */

export function PageHeader({
  title,
  description,
  actions
}: {
  title: string;
  description?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
      <div className="min-w-0">
        <h1 className="text-[22px] leading-tight font-semibold text-sh-fg">{title}</h1>
        {description && <p className="text-xs text-sh-muted mt-1 leading-relaxed max-w-2xl">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2 flex-wrap">{actions}</div>}
    </div>
  );
}

export function Section({
  title,
  description,
  actions,
  children,
  className
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={clsx('rounded-2xl border border-sh-line bg-sh-surface p-4', className)}>
      <div className="flex flex-wrap items-start justify-between gap-2 mb-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-sh-fg">{title}</h2>
          {description && <p className="text-[11px] text-sh-muted mt-0.5 leading-relaxed">{description}</p>}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* ConfirmButton                                                              */
/* -------------------------------------------------------------------------- */

export interface ConfirmButtonProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'onClick' | 'children'> {
  /** Runs on the second click, when the armed state is confirmed. */
  onConfirm: () => void;
  /** Label shown in the armed state; defaults to 确认？ */
  confirmLabel?: string;
  /** How long the armed state stays before reverting (ms). */
  revertMs?: number;
  children?: React.ReactNode;
  className?: string;
  /** Extra text appended while armed, e.g. the item name being destroyed. */
  confirmDetail?: React.ReactNode;
}

/**
 * Two-click inline confirmation for destructive actions, replacing both
 * `window.confirm()` (which is unstyleable, unreadable to tests and steals
 * focus) and dialogs for low-stakes single-item deletes.
 *
 * First click arms the button: it turns red and asks 确认？. Second click runs
 * `onConfirm`. Escape, blur or `revertMs` (default 3s) disarm it, so a stray
 * hover-click cannot destroy anything and a changed mind needs no dialog.
 */
export function ConfirmButton({
  onConfirm,
  confirmLabel = '确认删除？',
  revertMs = 3000,
  children,
  className,
  confirmDetail,
  disabled,
  ...rest
}: ConfirmButtonProps) {
  const [armed, setArmed] = React.useState(false);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(() => {
    if (!armed) return;
    timer.current = setTimeout(() => setArmed(false), revertMs);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setArmed(false);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      if (timer.current) clearTimeout(timer.current);
      window.removeEventListener('keydown', onKey);
    };
  }, [armed, revertMs]);

  return (
    <button
      {...rest}
      disabled={disabled}
      data-armed={armed || undefined}
      aria-label={armed ? confirmLabel : rest['aria-label']}
      className={clsx(
        'transition-colors',
        armed ? 'bg-sh-danger/15 text-sh-danger border border-sh-danger/60 font-semibold' : '',
        className
      )}
      onClick={(e) => {
        if (disabled) return;
        e.stopPropagation();
        if (armed) {
          setArmed(false);
          onConfirm();
        } else {
          setArmed(true);
        }
      }}
      onBlur={() => setArmed(false)}
    >
      {armed ? (
        <>
          {confirmLabel}
          {confirmDetail != null && <span className="ml-1 font-normal">{confirmDetail}</span>}
        </>
      ) : (
        children
      )}
    </button>
  );
}

/* -------------------------------------------------------------------------- */
/* useDirtyGuard                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Interception for "this pane has unsaved edits and the user is about to
 * navigate away from it" — the guard NotesPane lacked when switching notes
 * silently overwrote the textarea mid-edit.
 *
 * ```tsx
 * const { request, dialog } = useDirtyGuard({ isDirty, message: '…' });
 * const openNote = (id: string) => {
 *   request().then((ok) => ok && setSelectedId(id));
 * };
 * return (<>{dialog}<button onClick={() => request().then(ok => ok && close())} /></>);
 * ```
 *
 * `request()` resolves `true` when the pane may be left (not dirty, or the user
 * accepted the discard) and `false` when the action must be aborted. The dialog
 * is a real ConfirmDialog, so it is stylable, keyboard-closable and assertable
 * in Playwright — none of which `window.confirm` offers.
 */
export function useDirtyGuard(options: {
  isDirty: boolean;
  title?: string;
  message?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
}): { request: () => Promise<boolean>; dialog: React.ReactNode } {
  const { isDirty, title = '有未保存的修改', message, confirmLabel = '放弃修改', cancelLabel = '留在本页' } = options;
  const [open, setOpen] = React.useState(false);
  const resolveRef = React.useRef<((ok: boolean) => void) | null>(null);

  React.useEffect(() => {
    if (!open) return;
    // If the dirty flag clears while the dialog is up (autosave landed), the
    // guard's premise is gone — answer true instead of trapping the user.
    if (!isDirty) {
      setOpen(false);
      resolveRef.current?.(true);
      resolveRef.current = null;
    }
  }, [open, isDirty]);

  const request = React.useCallback((): Promise<boolean> => {
    if (!isDirty) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      // A pending request always wins: the older one is answered false so a
      // double click cannot leave two dialogs fighting over one state.
      resolveRef.current?.(false);
      resolveRef.current = resolve;
      setOpen(true);
    });
  }, [isDirty]);

  const settle = (ok: boolean) => {
    setOpen(false);
    resolveRef.current?.(ok);
    resolveRef.current = null;
  };

  const dialog = (
    <ConfirmDialog
      open={open}
      tone="danger"
      title={title}
      description={message ?? '当前内容还没有保存，离开会丢失这次修改（草稿仍保留在本机，刷新后可恢复）。'}
      confirmLabel={confirmLabel}
      cancelLabel={cancelLabel}
      onConfirm={() => settle(true)}
      onCancel={() => settle(false)}
    />
  );

  return { request, dialog };
}
