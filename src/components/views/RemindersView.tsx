import React, { useState, useEffect, useRef } from 'react';
import {
  Clock,
  Plus,
  ExternalLink,
  Trash2,
  AlertTriangle,
  CreditCard,
  Server,
  Globe,
  ShieldAlert,
  Pencil,
  RefreshCw,
  Check,
  Bell,
  History
} from 'lucide-react';
import { ReminderItem, ReminderOccurrence } from '../../types';
import {
  daysUntil,
  parseDateInputValue,
  toDateInputValue,
  adjacentRenewal,
  anchorFromDate,
  resolveAnchor,
  addOneCycle
} from '../../lib/dates';
import { notificationPermission, requestNotificationPermission, notificationsSupported } from '../../lib/reminderNotifier';
import { isExtensionContext } from '../../lib/extensionBridge';
import { renewReminderOccurrence } from '../../hooks/useReminderActions';
import { Button, EmptyState, StatusPill, inputClass } from '../../shared/ui';
import { showToast as showToastGlobal } from '../../shared/ui/toast';

interface RemindersViewProps {
  reminders: ReminderItem[];
  onAddReminder: (reminder: ReminderItem) => void;
  onUpdateReminder?: (reminder: ReminderItem) => void;
  onDeleteReminder: (id: string) => void;
  onToggleComplete?: (id: string) => void;
  /** 续期. Optional so the old call shape keeps working. */
  onRenewReminder?: (id: string) => void;
}

type Category = ReminderItem['category'];
type Recurring = NonNullable<ReminderItem['recurring']>;

const CATEGORY_LABEL: Record<Category, string> = {
  subscription: 'Plus/软件订阅',
  server: 'VPS/服务器',
  domain: '域名到期',
  cert: 'Token/证书',
  other: '其他时效'
};

/**
 * 行左侧 3px 状态轨的颜色：逾期红、临期黄、完成绿、普通用分隔线灰。
 * 用 CSS 变量而不是写死的色值，深浅主题各自取色（和荧光笔标注的色轨同一做法）。
 */
const TONE_RAIL: Record<'danger' | 'warn' | 'ok' | 'neutral', string> = {
  danger: 'var(--sh-danger)',
  warn: 'var(--sh-warn)',
  ok: 'var(--sh-ok)',
  neutral: 'var(--sh-line-strong)'
};

/** Human-readable recurrence rule, including *why* the next date is what it is. */
export function describeRecurrence(reminder: ReminderItem): string {
  const anchor = resolveAnchor(reminder.anchorDay, reminder.anchorMonth, reminder.targetDate, reminder.recurring);
  switch (reminder.recurring) {
    case 'monthly':
      return Number.isFinite(anchor.day) ? `每月 · 锚定 ${anchor.day} 日` : '每月';
    case 'yearly':
      return Number.isFinite(anchor.day)
        ? `每年 · 锚定 ${(anchor.month ?? new Date(reminder.targetDate).getMonth()) + 1} 月 ${anchor.day} 日`
        : '每年';
    case 'weekly':
      return '每周';
    default:
      return '一次性';
  }
}

/** One-line explanation of the clamping rule when the anchor is a month-end day. */
export function recurrenceHint(reminder: ReminderItem): string | null {
  const anchor = resolveAnchor(reminder.anchorDay, reminder.anchorMonth, reminder.targetDate, reminder.recurring);
  if (!Number.isFinite(anchor.day)) return null;
  const due = new Date(reminder.targetDate);
  const dueDay = due.getDate();
  if (reminder.recurring === 'monthly' && anchor.day > 28 && dueDay !== anchor.day) {
    return `${anchor.day} 日在短月会顺延到当月最后一天，之后仍回到 ${anchor.day} 日`;
  }
  if (reminder.recurring === 'yearly' && anchor.day === 29 && (anchor.month ?? due.getMonth()) === 1) {
    return dueDay === 29 ? '2 月 29 日：非闰年顺延到 2 月 28 日，闰年回到 2 月 29 日' : '非闰年顺延到 2 月 28 日，闰年回到 2 月 29 日';
  }
  return null;
}

function actionLabel(occurrence: ReminderOccurrence): string {
  if (occurrence.action === 'renewed') return '已续期';
  if (occurrence.action === 'skipped') return '已跳过';
  return '已完成本次';
}

export const RemindersView: React.FC<RemindersViewProps> = ({
  reminders,
  onAddReminder,
  onUpdateReminder,
  onDeleteReminder,
  onToggleComplete,
  onRenewReminder
}) => {
  const [isModalOpen, setIsModalOpen] = useState(false);
  /** 当前展开「历史」的行：一次只展开一条，折叠着的行高保持常量。 */
  const [expandedHistoryId, setExpandedHistoryId] = useState<string | null>(null);
  // 委托全局 toast：tone 按内容推断（失败/无效→danger，⚠→warn），emoji 前缀剥离。
  const showToast = (msg: string) => {
    showToastGlobal(msg, /失败|无效|无法/.test(msg) ? 'danger' : /⚠|已取消|未再次/.test(msg) ? 'warn' : 'ok');
  };

  // Form states (Create)
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState<Category>('subscription');
  const [targetDateStr, setTargetDateStr] = useState('');
  const [recurring, setRecurring] = useState<Recurring>('monthly');
  const [cost, setCost] = useState('');
  const [url, setUrl] = useState('');
  const [notes, setNotes] = useState('');
  const [autoRollover, setAutoRollover] = useState(true);

  // Form states (Edit)
  const [editingReminder, setEditingReminder] = useState<ReminderItem | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editCategory, setEditCategory] = useState<Category>('subscription');
  const [editTargetDateStr, setEditTargetDateStr] = useState('');
  const [editRecurring, setEditRecurring] = useState<Recurring>('monthly');
  const [editCost, setEditCost] = useState('');
  const [editUrl, setEditUrl] = useState('');
  const [editNotes, setEditNotes] = useState('');
  const [editAutoRollover, setEditAutoRollover] = useState(false);

  const now = Date.now();

  // Auto-catchup on mount: advance expired items whose owner asked for
  // autoRollover. Uses the *anchor*, so 1 月 31 日 catches up to 3 月 31 日 even if
  // the previous cycle was clamped to 2 月 28 日. No occurrence is invented: the
  // user did not renew it, the series simply moved on.
  const rolledOverRef = useRef(false);
  useEffect(() => {
    if (rolledOverRef.current || !onUpdateReminder) return;
    rolledOverRef.current = true;
    const nowTs = Date.now();
    reminders.forEach((r) => {
      if (!r.autoRollover || !r.recurring || r.recurring === 'once') return;
      const base = Number(r.targetDate);
      if (!Number.isFinite(base) || base >= nowTs) return;
      const anchor = resolveAnchor(r.anchorDay, r.anchorMonth, base, r.recurring);
      const options = r.recurring === 'yearly' ? { anchorDay: anchor.day, anchorMonth: anchor.month } : { anchorDay: anchor.day };
      // Largest occurrence still <= now, then strictly one cycle further.
      let cursor = base;
      let steps = 0;
      while (steps < 1200) {
        const candidate = addOneCycle(cursor, r.recurring, options);
        if (!Number.isFinite(candidate) || candidate <= cursor) break;
        cursor = candidate;
        steps++;
        if (cursor > nowTs) break;
      }
      if (cursor <= base) return;
      onUpdateReminder({ ...r, targetDate: cursor, anchorDay: anchor.day, ...(r.recurring === 'yearly' ? { anchorMonth: anchor.month } : {}) });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const daysLeftOf = (targetDate: number) => daysUntil(targetDate, now);

  // 逾期 / 7 天内 / 之后 — computed before any filter so the three groups always
  // render with their own counts (the old view hid "upcoming" behind "urgent").
  const sorted = [...reminders].sort((a, b) => a.targetDate - b.targetDate);
  const overdue = sorted.filter((r) => !r.completed && daysLeftOf(r.targetDate) < 0);
  const within7 = sorted.filter((r) => !r.completed && daysLeftOf(r.targetDate) >= 0 && daysLeftOf(r.targetDate) <= 7);
  const later = sorted.filter((r) => !r.completed && daysLeftOf(r.targetDate) > 7);
  const done = sorted.filter((r) => r.completed);
  const urgentCount = overdue.length + within7.length;

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title || !targetDateStr) return;

    const targetTimestamp = parseDateInputValue(targetDateStr);
    if (isNaN(targetTimestamp)) return;

    const anchor = anchorFromDate(targetTimestamp, recurring);
    onAddReminder({
      id: `rem-${Date.now()}`,
      title,
      category,
      targetDate: targetTimestamp,
      recurring,
      cost,
      url,
      notes,
      autoRollover,
      completed: false,
      createdAt: Date.now(),
      ...(anchor
        ? recurring === 'yearly'
          ? { anchorDay: anchor.day, anchorMonth: anchor.month }
          : { anchorDay: anchor.day }
        : {})
    });

    setIsModalOpen(false);
    setTitle('');
    setCost('');
    setUrl('');
    setNotes('');
    setTargetDateStr('');
    setAutoRollover(true);
    showToast('✅ 提醒事项已创建');
  };

  const handleOpenEdit = (item: ReminderItem) => {
    setEditingReminder(item);
    setEditTitle(item.title);
    setEditCategory(item.category);
    setEditTargetDateStr(toDateInputValue(item.targetDate));
    setEditRecurring(item.recurring || 'monthly');
    setEditCost(item.cost || '');
    setEditUrl(item.url || '');
    setEditNotes(item.notes || '');
    setEditAutoRollover(Boolean(item.autoRollover));
  };

  const handleSaveEdit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingReminder || !editTitle.trim() || !editTargetDateStr) return;

    const targetTimestamp = parseDateInputValue(editTargetDateStr);
    if (isNaN(targetTimestamp)) return;

    const anchor = anchorFromDate(targetTimestamp, editRecurring);
    const updated: ReminderItem = {
      ...editingReminder,
      title: editTitle.trim(),
      category: editCategory,
      targetDate: targetTimestamp,
      recurring: editRecurring,
      cost: editCost.trim(),
      url: editUrl.trim(),
      notes: editNotes.trim(),
      autoRollover: editAutoRollover,
      ...(anchor
        ? editRecurring === 'yearly'
          ? { anchorDay: anchor.day, anchorMonth: anchor.month }
          : { anchorDay: anchor.day }
        : {})
    };

    if (onUpdateReminder) {
      onUpdateReminder(updated);
      showToast('💾 提醒已成功修改更新');
    }
    setEditingReminder(null);
  };

  /** 完成本次 — records this occurrence; deliberately does not move the date. */
  const handleComplete = (item: ReminderItem) => {
    const alreadyDone = (item.occurrences || []).some((o) => o.action === 'completed' && o.dueAt === item.targetDate);
    if (onToggleComplete) onToggleComplete(item.id);
    if (item.completed) {
      showToast(`↩️【${item.title}】已取消完成标记，本次到期仍在列表中`);
    } else if (alreadyDone) {
      showToast(`【${item.title}】本次已完成过，重复点击不会移动到期日`);
    } else {
      showToast(`✅【${item.title}】已完成本次（到期日保持不变）`);
    }
  };

  /** 续期 — computes the next due date and records the renewal. */
  const handleRenew = (item: ReminderItem) => {
    const recurring = item.recurring;
    if (!recurring || recurring === 'once') {
      if (onToggleComplete && !item.completed) onToggleComplete(item.id);
      showToast(`✅【${item.title}】是一次性事项，已标记完成（没有下一期）`);
      return;
    }

    const anchor = resolveAnchor(item.anchorDay, item.anchorMonth, item.targetDate, recurring);
    const options = recurring === 'yearly' ? { anchorDay: anchor.day, anchorMonth: anchor.month } : { anchorDay: anchor.day };
    // Exactly the next period, so the toast states the date the user just asked for.
    const nextTs = adjacentRenewal(item.targetDate, recurring, options);
    if (nextTs === null) {
      showToast(`⚠️【${item.title}】的周期设置无效，无法计算下一期`);
      return;
    }

    const alreadyRenewed = (item.occurrences || []).some((o) => o.action === 'renewed' && o.dueAt === item.targetDate);
    if (onRenewReminder) {
      onRenewReminder(item.id);
    } else if (onUpdateReminder) {
      // Fallback for callers that only wire updateReminder: same idempotent shape.
      const renewed = renewReminderOccurrence(item);
      onUpdateReminder(renewed.renewed ? renewed.reminder : { ...item, targetDate: renewed.nextDueAt, completed: false });
    }

    if (alreadyRenewed) {
      showToast(`【${item.title}】本次已续期过，到期日未再次顺延`);
    } else {
      showToast(`🎉 已续期到 ${new Date(nextTs).toLocaleDateString()}（到期日已更新）`);
    }
  };

  const getCategoryIcon = (cat: string) => {
    switch (cat) {
      case 'subscription': return <CreditCard className="w-3.5 h-3.5 text-sh-info" />;
      case 'server': return <Server className="w-3.5 h-3.5 text-sh-ok" />;
      case 'domain': return <Globe className="w-3.5 h-3.5 text-sh-info" />;
      case 'cert': return <ShieldAlert className="w-3.5 h-3.5 text-sh-warn" />;
      default: return <Clock className="w-3.5 h-3.5 text-sh-muted" />;
    }
  };

  /**
   * 提醒是「越攒越多」的列表，所以和收件箱、网页批注同一套口径：一条一行，
   * 行高是常量、条数是变量。旧版一张 `p-4` 卡片（标题行 + 到期块 + 说明 +
   * 历史 + 按钮行，200px 上下）一屏三列只放得下六条，翻两屏才扫完一轮。
   *
   * 行的主信息是标题；周期锚定规则和备注收进第二行至多一行；右侧依次是
   * 金额、到期日（`YYYY-MM-DD` 等宽字体，宽度恒定）、状态 pill。完成/续期
   * 是这个页面的主操作，常显；编辑/删除悬停浮现；续期历史默认折叠，
   * 但始终在 DOM 里（tests/e2e/reminder-recurrence.spec.ts 按记录数断言）。
   */
  const renderRow = (item: ReminderItem) => {
    const daysLeft = daysLeftOf(item.targetDate);
    const isUrgent = daysLeft <= 7 && !item.completed;
    const hint = recurrenceHint(item);
    const occurrences = (item.occurrences || []).slice(0, 3);
    const tone = item.completed ? 'ok' : daysLeft < 0 ? 'danger' : isUrgent ? 'warn' : 'neutral';
    const statusLabel = item.completed
      ? '本次已完成'
      : daysLeft < 0
        ? `已逾期 ${Math.abs(daysLeft)} 天`
        : daysLeft === 0
          ? '今天到期'
          : `${daysLeft} 天后到期`;
    const expanded = expandedHistoryId === item.id;

    return (
      <li
        key={item.id}
        data-testid={`reminder-row-${item.id}`}
        data-group={item.completed ? 'done' : daysLeft < 0 ? 'overdue' : daysLeft <= 7 ? 'within7' : 'later'}
        className="group flex flex-wrap items-center gap-x-3 gap-y-1 py-1.5 pr-3 transition-colors hover:bg-sh-surface2/50"
        style={{ borderLeft: `3px solid ${TONE_RAIL[tone]}`, paddingLeft: 10 }}
      >
        <div className="min-w-0 flex-1 basis-48" data-testid={`reminder-row-text-${item.id}`}>
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="shrink-0" title={CATEGORY_LABEL[item.category]}>
              {getCategoryIcon(item.category)}
            </span>
            <span
              className={`truncate text-xs font-medium ${item.completed ? 'text-sh-subtle line-through' : 'text-sh-fg'}`}
              title={item.title}
            >
              {item.title}
            </span>
            {item.autoRollover && !item.completed && (
              <span className="shrink-0 text-[10px] text-sh-info" title="过期后自动把到期日推进到下一期">
                自动顺延
              </span>
            )}
          </div>

          {/* 第二行至多一行：锚定规则（钉死不截断，规则是短的）+ 备注（截断）。
              月末顺延的完整解释挂在 title 上，展开时不用占行。 */}
          <div className="mt-0.5 flex min-w-0 items-baseline gap-1.5 text-[10px] leading-4 text-sh-subtle">
            <span className="shrink-0" title={hint ?? undefined}>{describeRecurrence(item)}</span>
            {item.notes && (
              <span className="truncate" title={item.notes}>{item.notes}</span>
            )}
          </div>
        </div>

        {item.cost && (
          <span className="hidden shrink-0 self-center font-mono text-[10px] tabular-nums text-sh-subtle sm:block" title="续费金额">
            {item.cost}
          </span>
        )}

        <span
          className="shrink-0 self-center font-mono text-[11px] tabular-nums text-sh-muted"
          title={`到期日 ${toDateInputValue(item.targetDate)}${hint ? `（${hint}）` : ''}`}
        >
          {toDateInputValue(item.targetDate)}
        </span>

        <StatusPill tone={tone} label={statusLabel} className="self-center" />

        <div
          data-testid="reminder-row-actions"
          className="flex w-full shrink-0 flex-wrap items-center justify-end gap-1 lg:w-auto"
        >
          <button
            data-testid={`reminder-complete-${item.id}`}
            onClick={() => handleComplete(item)}
            title="记录本次已处理，到期日保持不变"
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium text-sh-muted transition-colors hover:bg-sh-surface2 hover:text-sh-fg"
          >
            <Check className="w-3 h-3" aria-hidden />
            {item.completed ? '已完成本次' : '完成本次'}
          </button>

          <button
            data-testid={`reminder-renew-${item.id}`}
            onClick={() => handleRenew(item)}
            title="标记已续费并把到期日推进到下一期"
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium text-sh-muted transition-colors hover:bg-sh-surface2 hover:text-sh-fg"
          >
            <RefreshCw className="w-3 h-3" aria-hidden />
            续期到下期
          </button>

          {item.url && (
            <a
              href={item.url}
              target="_blank"
              rel="noreferrer"
              title={`打开官方控制台：${item.url}`}
              aria-label={`打开 ${item.title} 的官方控制台`}
              className="rounded p-1 text-sh-info transition-colors hover:text-sh-fg"
            >
              <ExternalLink className="w-3 h-3" aria-hidden />
            </a>
          )}

          {occurrences.length > 0 && (
            <button
              data-testid={`reminder-history-${item.id}`}
              onClick={() => setExpandedHistoryId(expanded ? null : item.id)}
              aria-expanded={expanded}
              title="展开或收起这条提醒的处理记录"
              className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[10px] text-sh-subtle transition-colors hover:bg-sh-surface2 hover:text-sh-fg"
            >
              <History className="w-3 h-3" aria-hidden />
              {occurrences.length}
            </button>
          )}

          {/* 编辑/删除低频且危险，悬停才浮现；`lg:` 以下常显，否则触屏没有悬停。 */}
          <button
            data-testid={`reminder-edit-${item.id}`}
            onClick={() => handleOpenEdit(item)}
            title="编辑修改提醒"
            aria-label={`编辑提醒 ${item.title}`}
            className="rounded p-1 text-sh-muted transition-colors transition-opacity hover:bg-sh-surface2 hover:text-sh-fg max-lg:opacity-100 lg:opacity-0 lg:group-hover:opacity-100 lg:group-focus-within:opacity-100"
          >
            <Pencil className="w-3 h-3" aria-hidden />
          </button>
          <button
            data-testid={`reminder-delete-${item.id}`}
            onClick={() => {
              if (confirm(`确定删除提醒 ${item.title} 吗？`)) onDeleteReminder(item.id);
            }}
            title="删除"
            aria-label={`删除提醒 ${item.title}`}
            className="rounded p-1 text-sh-muted transition-colors transition-opacity hover:bg-sh-surface2 hover:text-sh-danger max-lg:opacity-100 lg:opacity-0 lg:group-hover:opacity-100 lg:group-focus-within:opacity-100"
          >
            <Trash2 className="w-3 h-3" aria-hidden />
          </button>
        </div>

        {/* 处理记录：默认折叠（行高才是常量），点「历史」展开。始终渲染，
            因为 reminder-recurrence.spec 按出现的记录条数断言幂等行为。 */}
        {occurrences.length > 0 && (
          <ul
            data-testid={`reminder-occurrences-${item.id}`}
            className={`w-full basis-full space-y-0.5 pl-[9px] ${expanded ? '' : 'hidden'}`}
          >
            {occurrences.map((o) => (
              <li
                key={`${o.at}-${o.dueAt}`}
                data-occurrence={o.dueAt}
                data-action={o.action}
                className="text-[10px] text-sh-subtle font-mono"
              >
                {toDateInputValue(o.dueAt)} · {actionLabel(o)}
                {o.action === 'renewed' && o.nextDueAt ? ` → ${toDateInputValue(o.nextDueAt)}` : ''}
              </li>
            ))}
          </ul>
        )}
      </li>
    );
  };

  const renderGroup = (testId: string, heading: string, count: number, items: ReminderItem[], tone: 'danger' | 'warn' | 'neutral' | 'ok') => (
    <section data-testid={testId} data-count={count} className="space-y-2">
      <div className="flex items-center gap-2">
        <h3 className="text-xs font-semibold text-sh-fg">{heading}</h3>
        <StatusPill tone={tone} label={`${count} 项`} />
      </div>
      {items.length === 0 ? (
        <p className="text-[11px] text-sh-subtle px-1">暂无</p>
      ) : (
        <ul className="divide-y divide-sh-line border-y border-sh-line">{items.map(renderRow)}</ul>
      )}
    </section>
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-sh-surface p-4 sm:p-5 rounded-2xl border border-sh-line">
        <div>
          <div className="flex items-center gap-2">
            <Clock className="w-5 h-5 text-sh-warn shrink-0" />
            <h2 className="text-sm sm:text-base font-semibold text-sh-fg">提醒</h2>
            {urgentCount > 0 && <StatusPill tone="danger" label={`${urgentCount} 项 7 天内到期`} />}
          </div>
          <p className="text-xs text-sh-muted mt-1">
            按「逾期 / 7 天内 / 之后」分组。<strong>完成本次</strong>只记录这一次，<strong>续期</strong>才会把到期日推到下一期。
          </p>
        </div>

        <button
          onClick={() => setIsModalOpen(true)}
          className="px-3.5 py-2 rounded-xl bg-sh-accent text-sh-accent-fg font-semibold text-xs flex items-center gap-1.5 hover:opacity-90 shadow-sm shrink-0 self-start sm:self-auto sh-tap"
        >
          <Plus className="w-3.5 h-3.5" />
          <span>新建提醒事项</span>
        </button>
      </div>

      <NotificationBanner />

      {reminders.length === 0 ? (
        <EmptyState
          icon={<Clock className="w-5 h-5" />}
          title="还没有任何提醒"
          description="先建一条：例如「ChatGPT Plus 每月 31 日续费」，到期前 3 天会在这里提示。"
          action={
            <Button variant="primary" size="sm" onClick={() => setIsModalOpen(true)} icon={<Plus className="w-3.5 h-3.5" />}>
              新建第一条提醒
            </Button>
          }
        />
      ) : (
        <div className="space-y-6">
          {renderGroup('reminder-group-overdue', '逾期', overdue.length, overdue, 'danger')}
          {renderGroup('reminder-group-within7', '7 天内', within7.length, within7, 'warn')}
          {renderGroup('reminder-group-later', '之后', later.length, later, 'neutral')}
          {done.length > 0 && renderGroup('reminder-group-done', '已完成本次（下次到期仍会提醒）', done.length, done, 'ok')}
        </div>
      )}

      {isModalOpen && (
        <div
          onClick={() => setIsModalOpen(false)}
          className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-black/80 backdrop-blur-sm"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-lg bg-sh-surface border border-sh-line rounded-2xl p-5 shadow-2xl flex flex-col space-y-4 max-h-[90vh] overflow-y-auto"
          >
            <div className="flex items-center justify-between pb-3 border-b border-sh-line">
              <h3 className="text-sm font-semibold text-sh-fg flex items-center gap-2">
                <Clock className="w-4 h-4 text-sh-warn" />
                新建提醒
              </h3>
              <button onClick={() => setIsModalOpen(false)} className="text-sh-muted hover:text-sh-fg text-xs">
                关闭
              </button>
            </div>

            <form onSubmit={handleCreate} className="space-y-3">
              <div>
                <label className="block text-xs text-sh-muted mb-1">提醒事项名称</label>
                <input
                  type="text"
                  required
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="例如: ChatGPT Plus 续期 / 阿里云香港服务器到期"
                  className={inputClass}
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <div>
                  <label className="block text-xs text-sh-muted mb-1">类别</label>
                  <select value={category} onChange={(e) => setCategory(e.target.value as Category)} className={inputClass}>
                    <option value="subscription">Plus/软件订阅</option>
                    <option value="server">VPS/服务器</option>
                    <option value="domain">域名到期</option>
                    <option value="cert">Token/证书口令</option>
                    <option value="other">其他时效提醒</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-sh-muted mb-1">到期 / 续费截止日期</label>
                  <input
                    type="date"
                    required
                    value={targetDateStr}
                    onChange={(e) => setTargetDateStr(e.target.value)}
                    className={`${inputClass} font-mono`}
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <div>
                  <label className="block text-xs text-sh-muted mb-1">续期周期</label>
                  <select value={recurring} onChange={(e) => setRecurring(e.target.value as Recurring)} className={inputClass}>
                    <option value="monthly">每月续费</option>
                    <option value="yearly">按年续费</option>
                    <option value="weekly">按周续费</option>
                    <option value="once">一次性（不循环）</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-sh-muted mb-1">续费金额（可选）</label>
                  <input
                    type="text"
                    value={cost}
                    onChange={(e) => setCost(e.target.value)}
                    placeholder="$20/月 或 ¥199/年"
                    className={`${inputClass} font-mono`}
                  />
                </div>
              </div>

              <p className="text-[11px] text-sh-subtle">
                周期锚定你填写的「日」。例如填 1 月 31 日：2 月按 2 月最后一天（28/29 日）计，3 月仍回到 31 日。
              </p>

              <div className="flex items-center gap-2 p-2 bg-sh-surface2 rounded-xl border border-sh-line">
                <input
                  type="checkbox"
                  id="autoRollover"
                  checked={autoRollover}
                  onChange={(e) => setAutoRollover(e.target.checked)}
                  className="rounded border-sh-line"
                />
                <label htmlFor="autoRollover" className="text-xs text-sh-fg cursor-pointer">
                  过期后自动把到期日推进到下一期（不写入续期记录）
                </label>
              </div>

              <div>
                <label className="block text-xs text-sh-muted mb-1">续费网址（URL）</label>
                <input
                  type="text"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://..."
                  className={`${inputClass} font-mono`}
                />
              </div>

              <div>
                <label className="block text-xs text-sh-muted mb-1">备忘与扣款说明</label>
                <textarea
                  rows={2}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="例如: 绑定了招行外币卡扣费，提前查额度…"
                  className={`${inputClass} resize-none`}
                />
              </div>

              <div className="flex items-center justify-end gap-2 pt-2 border-t border-sh-line">
                <Button variant="ghost" onClick={() => setIsModalOpen(false)}>
                  取消
                </Button>
                <Button type="submit" variant="primary">
                  保存提醒
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}

      {editingReminder && (
        <div
          onClick={() => setEditingReminder(null)}
          className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-black/80 backdrop-blur-sm"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-lg bg-sh-surface border border-sh-line rounded-2xl p-5 shadow-2xl flex flex-col space-y-4 max-h-[90vh] overflow-y-auto"
          >
            <div className="flex items-center justify-between pb-3 border-b border-sh-line">
              <h3 className="text-sm font-semibold text-sh-fg flex items-center gap-2">
                <Pencil className="w-4 h-4 text-sh-ok" />
                编辑提醒
              </h3>
              <button onClick={() => setEditingReminder(null)} className="text-sh-muted hover:text-sh-fg text-xs">
                关闭
              </button>
            </div>

            <form onSubmit={handleSaveEdit} className="space-y-3">
              <div>
                <label className="block text-xs text-sh-muted mb-1">提醒事项名称</label>
                <input type="text" required value={editTitle} onChange={(e) => setEditTitle(e.target.value)} className={inputClass} />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <div>
                  <label className="block text-xs text-sh-muted mb-1">类别</label>
                  <select value={editCategory} onChange={(e) => setEditCategory(e.target.value as Category)} className={inputClass}>
                    <option value="subscription">Plus/软件订阅</option>
                    <option value="server">VPS/服务器</option>
                    <option value="domain">域名到期</option>
                    <option value="cert">Token/证书口令</option>
                    <option value="other">其他时效提醒</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-sh-muted mb-1">到期 / 续费截止日期</label>
                  <input
                    type="date"
                    required
                    value={editTargetDateStr}
                    onChange={(e) => setEditTargetDateStr(e.target.value)}
                    className={`${inputClass} font-mono`}
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <div>
                  <label className="block text-xs text-sh-muted mb-1">续期周期</label>
                  <select value={editRecurring} onChange={(e) => setEditRecurring(e.target.value as Recurring)} className={inputClass}>
                    <option value="monthly">每月续费</option>
                    <option value="yearly">按年续费</option>
                    <option value="weekly">按周续费</option>
                    <option value="once">一次性（不循环）</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-sh-muted mb-1">续费金额</label>
                  <input type="text" value={editCost} onChange={(e) => setEditCost(e.target.value)} placeholder="$20/月" className={`${inputClass} font-mono`} />
                </div>
              </div>

              <p className="text-[11px] text-sh-subtle">
                改动到期日会重新锚定周期（以新日期为准），已有记录保留。
              </p>

              <div className="flex items-center gap-2 p-2 bg-sh-surface2 rounded-xl border border-sh-line">
                <input
                  type="checkbox"
                  id="editAutoRollover"
                  checked={editAutoRollover}
                  onChange={(e) => setEditAutoRollover(e.target.checked)}
                  className="rounded border-sh-line"
                />
                <label htmlFor="editAutoRollover" className="text-xs text-sh-fg cursor-pointer">
                  过期后自动把到期日推进到下一期
                </label>
              </div>

              <div>
                <label className="block text-xs text-sh-muted mb-1">续费网址（URL）</label>
                <input type="text" value={editUrl} onChange={(e) => setEditUrl(e.target.value)} placeholder="https://..." className={`${inputClass} font-mono`} />
              </div>

              <div>
                <label className="block text-xs text-sh-muted mb-1">备忘与扣款说明</label>
                <textarea rows={2} value={editNotes} onChange={(e) => setEditNotes(e.target.value)} className={`${inputClass} resize-none`} />
              </div>

              <div className="flex items-center justify-end gap-2 pt-2 border-t border-sh-line">
                <Button variant="ghost" onClick={() => setEditingReminder(null)}>
                  取消
                </Button>
                <Button type="submit" variant="primary">
                  保存更新
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

/**
 * Notification capability strip.
 *
 * States exactly what can happen in this environment — and never promises a
 * reminder while the browser is closed. The permission is only requested when the
 * user presses the button; a first visit never triggers a permission prompt.
 */
const NotificationBanner: React.FC = () => {
  const inExtension = typeof window !== 'undefined' && isExtensionContext();
  const supported = notificationsSupported();
  const [permission, setPermission] = useState<string>(() =>
    supported ? notificationPermission() : 'unsupported'
  );
  const [busy, setBusy] = useState(false);

  if (!supported) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-sh-line bg-sh-surface2 px-3 py-2 text-[11px] text-sh-muted">
        <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
        <span>当前环境没有系统通知能力：到期项只会在本页显示。</span>
      </div>
    );
  }

  if (inExtension) {
    return (
      <div
        data-testid="notification-strip"
        data-mode="extension"
        className={`flex flex-wrap items-center justify-between gap-2 rounded-xl border px-3 py-2 text-[11px] ${
          permission === 'granted'
            ? 'border-sh-ok/50 bg-sh-surface2 text-sh-ok'
            : 'border-sh-warn/50 bg-sh-surface2 text-sh-warn'
        }`}
      >
        <span className="flex items-center gap-2">
          <Bell className="w-3.5 h-3.5 shrink-0" />
          {permission === 'granted'
            ? '扩展后台提醒已开启：浏览器运行期间可推送系统通知；浏览器关闭后不会提醒。'
            : '扩展可以后台提醒，但需要通知权限。未授权时只在本页显示到期项——浏览器关闭后不会提醒。'}
        </span>
        {permission !== 'granted' && (
          <button
            onClick={async () => {
              setBusy(true);
              try {
                setPermission(await requestNotificationPermission());
              } finally {
                setBusy(false);
              }
            }}
            disabled={busy}
            className="shrink-0 px-2.5 py-1 rounded-lg bg-sh-accent text-sh-accent-fg font-semibold text-[11px] disabled:opacity-50"
          >
            {busy ? '请求中…' : '授权通知权限'}
          </button>
        )}
      </div>
    );
  }

  if (permission === 'granted') {
    return (
      <div
        data-testid="notification-strip"
        data-mode="page-open"
        data-permission="granted"
        className="flex items-center gap-2 rounded-xl border border-sh-ok/50 bg-sh-surface2 px-3 py-2 text-[11px] text-sh-ok"
      >
        <Bell className="w-3.5 h-3.5 shrink-0" />
        <span>已开启：仅在<strong>这个页面打开时</strong>检查并推送到期提醒（每个到期项一次）。关闭页面或浏览器后不会提醒。</span>
      </div>
    );
  }

  if (permission === 'denied') {
    return (
      <div
        data-testid="notification-strip"
        data-mode="page-open"
        data-permission="denied"
        className="flex items-center gap-2 rounded-xl border border-sh-warn/50 bg-sh-surface2 px-3 py-2 text-[11px] text-sh-warn"
      >
        <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
        <span>浏览器已拒绝通知权限：到期项仍会保留在本页列表中。要恢复系统提醒，请在地址栏左侧的站点设置里重新允许「通知」。</span>
      </div>
    );
  }

  return (
    <div
      data-testid="notification-strip"
      data-mode="page-open"
      data-permission="default"
      className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-sh-info/50 bg-sh-surface2 px-3 py-2 text-[11px] text-sh-info"
    >
      <span className="flex items-center gap-2">
        <Bell className="w-3.5 h-3.5 shrink-0" />
        网页版只能在<strong>页面打开时</strong>提醒（不会在浏览器关闭后提醒）。未授权时到期项保留在本页列表里。
      </span>
      <button
        onClick={async () => {
          setBusy(true);
          try {
            setPermission(await requestNotificationPermission());
          } finally {
            setBusy(false);
          }
        }}
        disabled={busy}
        className="shrink-0 px-2.5 py-1 rounded-lg bg-sh-info text-white font-semibold text-[11px] disabled:opacity-50"
      >
        {busy ? '请求中…' : '开启到期提醒'}
      </button>
    </div>
  );
};
