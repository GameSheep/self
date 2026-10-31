import React from 'react';
import { CheckCircle2, ExternalLink, Flame, Trash2, Clock } from 'lucide-react';
import { CheckInTask } from '../../types';
import { hasRunToday, recentDays, computeStreak, OUTCOME_LABEL } from '../../lib/checkInHistory';
import { StatusPill,
  ConfirmButton
} from '../../shared/ui';

interface CheckInCardProps {
  task: CheckInTask;
  /** `mode: 'open_page'` opens the site; `'mark_done'` records the user's confirmation. */
  onRun: (id: string, mode: 'open_page' | 'mark_done') => Promise<void>;
  onDelete: (id: string) => void;
}

/**
 * Check-in site card — a plain list entry, not an automation control.
 *
 * The automatic paths (HTTP request, userscript, enable toggle) were removed:
 * the app's job is to hold the list, open the site and remember what happened —
 * the checking itself is the user's gesture on the target site. The card keeps
 * the honest 14-day record: green = you marked it done, amber = you only opened
 * the page, red = URL failed to open.
 */
export const CheckInCard: React.FC<CheckInCardProps> = ({ task, onRun, onDelete }) => {
  const cells = recentDays(task.history || [], 14);
  const today = hasRunToday(task);
  // Derive from history when present: a stored counter can be stale (imported
  // data, or records written by an older version).
  const streak = task.history && task.history.length > 0 ? computeStreak(task.history) : task.streakDays || 0;
  const outcome = task.lastOutcome || 'never';

  return (
    <div className="group relative p-3.5 sm:p-4 rounded-xl bg-sh-surface border border-sh-line shadow-sm flex flex-col justify-between">
      <div>
        {/* Header */}
        <div className="flex items-start justify-between gap-2 mb-2">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 sm:gap-2 flex-wrap">
              <h3 className="text-xs sm:text-sm font-semibold text-sh-fg truncate">{task.name}</h3>
              {today.done ? (
                <StatusPill tone="ok" label="今日已签" />
              ) : (
                <StatusPill tone="neutral" label="今日未签" />
              )}
            </div>
            <a
              href={task.url}
              target="_blank"
              rel="noreferrer"
              className="text-[11px] text-sh-subtle hover:text-sh-fg truncate block mt-0.5 font-mono"
            >
              {task.url.replace(/^https?:\/\//, '')}
            </a>
          </div>

          <ConfirmButton
            onConfirm={() => onDelete(task.id)}
            confirmLabel="确认移除？"
            confirmDetail={task.name}
            className="opacity-100 sm:opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-sh-surface2 text-sh-subtle hover:text-sh-danger transition-opacity shrink-0"
            title="移除"
            aria-label={`移除签到任务 ${task.name}`}
          >
            <Trash2 className="w-3.5 h-3.5" aria-hidden />
          </ConfirmButton>
        </div>

        {/* Last note: what the app actually observed, one line */}
        <div
          className="text-[11px] text-sh-muted bg-sh-surface2 p-2 rounded-lg border border-sh-line my-2 leading-relaxed break-words"
          data-testid={`checkin-last-result-${task.id}`}
        >
          <div className="flex items-center gap-1.5 mb-0.5">
            <Clock className="w-3 h-3 text-sh-subtle shrink-0" aria-hidden />
            {task.lastRun ? (
              <span className="text-sh-subtle font-mono">{new Date(task.lastRun).toLocaleString()}</span>
            ) : (
              <span className="text-sh-subtle">还没有记录</span>
            )}
            {task.lastRun && outcome !== 'never' && (
              <StatusPill tone={outcome === 'http_success' ? 'ok' : outcome === 'opened_page' ? 'warn' : 'danger'} label={OUTCOME_LABEL[outcome]} />
            )}
          </div>
          {task.lastMessage && <p>{task.lastMessage}</p>}
        </div>

        {/* Last 14 days: per-day record */}
        {cells.length > 0 && (
          <div className="flex items-center gap-1 my-2" data-testid="checkin-history">
            <span className="text-[10px] text-sh-subtle font-mono mr-1 shrink-0">近 14 天</span>
            {cells.map((cell) => (
              <span
                key={cell.date}
                title={`${cell.date} · ${
                  cell.status === 'success'
                    ? '已签到'
                    : cell.outcome === 'opened_page'
                      ? '仅打开页面'
                      : cell.status === 'failed'
                        ? '打开失败'
                        : '未签到'
                }`}
                data-day={cell.date}
                data-status={cell.status}
                data-outcome={cell.outcome}
                className={`w-2.5 h-2.5 rounded-sm shrink-0 ${
                  cell.status === 'success'
                    ? 'bg-sh-ok'
                    : cell.outcome === 'opened_page'
                      ? 'bg-sh-warn/70'
                      : cell.status === 'failed'
                        ? 'bg-sh-danger/80'
                        : 'bg-sh-surface2 border border-sh-line'
                } ${cell.isToday ? 'ring-1 ring-offset-1 ring-offset-sh-surface ring-sh-line-strong' : ''}`}
              />
            ))}
          </div>
        )}
      </div>

      {/* Footer & Actions */}
      <div className="flex items-center justify-between gap-2 pt-2 border-t border-sh-line mt-2 text-[11px] text-sh-subtle">
        <div className="flex items-center gap-1.5 font-mono whitespace-nowrap">
          <Flame className="w-3.5 h-3.5 text-sh-warn shrink-0" />
          <span data-testid="checkin-streak">连续 {streak} 天</span>
        </div>

        <div className="flex items-center gap-1.5 shrink-0 flex-wrap justify-end">
          <button
            onClick={() => void onRun(task.id, 'mark_done')}
            disabled={today.done}
            data-testid={`checkin-mark-done-${task.id}`}
            title="签完回来点一下，记作今天已签（以你确认为准）"
            className="p-1 sm:px-2 sm:py-1 rounded border border-sh-line bg-sh-surface2 text-sh-muted hover:text-sh-fg text-[11px] flex items-center gap-1 disabled:opacity-50 disabled:cursor-default"
          >
            <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
            <span className="hidden sm:inline">{today.done ? '已签' : '标记今天已签'}</span>
          </button>

          <button
            onClick={() => void onRun(task.id, 'open_page')}
            data-testid={`checkin-open-page-${task.id}`}
            title="打开这个网站，由你自己完成签到"
            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-sh-accent text-sh-accent-fg text-[11px] font-semibold"
          >
            <ExternalLink className="w-3.5 h-3.5" />
            打开网站
          </button>
        </div>
      </div>
    </div>
  );
};

export default CheckInCard;
