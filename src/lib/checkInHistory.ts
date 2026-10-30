/**
 * Check-in history and streaks.
 *
 * The old model only stored `streakDays` and incremented it on every run, so
 * clicking "打卡" twice in one day counted as two days, and there was no record
 * of which days were actually done. History is now the source of truth and the
 * streak is derived from it.
 *
 * Only a real HTTP success counts (P1-07 / 开发文档 §11.4): "打开页面手动完成"
 * is recorded with its own outcome and appears in the strip as a non-success, so
 * the streak can never be inflated by merely opening a tab.
 */
import { CheckInOutcome, CheckInRun, CheckInTask } from '../types';

export const HISTORY_LIMIT = 120;

/** Local calendar date key (YYYY-MM-DD) — streaks are a local-time concept. */
export function localDateKey(ts: number = Date.now()): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function dayKeyOffset(fromKey: string, offsetDays: number): string {
  const [y, m, d] = fromKey.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  date.setDate(date.getDate() + offsetDays);
  return localDateKey(date.getTime());
}

export interface RunOutcome {
  success: boolean;
  /** false when we merely opened a page and cannot know the result. */
  verified?: boolean;
  message: string;
  statusCode?: number;
  /** Set explicitly by callers that know the mode (e.g. "打开页面手动完成"). */
  outcome?: CheckInOutcome;
}

/**
 * Map an execution result to the stored outcome. Explicit `outcome` wins, which
 * is how the "打开页面手动完成" path stays out of the success column; otherwise a
 * non-verified run is treated as "opened page" and anything else follows success.
 */
export function outcomeOf(outcome: RunOutcome): CheckInOutcome {
  if (outcome.outcome) return outcome.outcome;
  if (outcome.verified === false) return 'opened_page';
  return outcome.success ? 'http_success' : 'http_failure';
}

/** Only a verified HTTP success counts for the streak. */
export function countsForStreak(outcome: RunOutcome): boolean {
  return outcome.verified !== false && outcome.success === true;
}

/**
 * Record a run for today.
 *
 * - Only one entry per local day: running again replaces today's entry, so a
 *   double click can never inflate the streak.
 * - A run that could not be verified (e.g. "opened the check-in page") is stored
 *   as failed-for-streak but still recorded, with its message explaining why.
 * - `lastOutcome` is always written so the card can say what actually happened.
 */
export function recordRun(task: CheckInTask, outcome: RunOutcome, now: number = Date.now()): CheckInTask {
  const date = localDateKey(now);
  const counted = countsForStreak(outcome);
  const kind = outcomeOf(outcome);
  const entry: CheckInRun = {
    date,
    at: now,
    status: counted ? 'success' : 'failed',
    message: outcome.message,
    outcome: kind
  };

  const history = [...(task.history || []).filter((h) => h.date !== date), entry]
    .sort((a, b) => b.at - a.at)
    .slice(0, HISTORY_LIMIT);

  return {
    ...task,
    lastRun: now,
    lastStatus: counted ? 'success' : 'failed',
    lastMessage: outcome.message,
    lastOutcome: kind,
    history,
    streakDays: computeStreak(history, now)
  };
}

/**
 * Consecutive days with a successful run, counting back from today.
 * Yesterday still counts as "current" (you may simply not have run it yet today).
 */
export function computeStreak(history: CheckInRun[], now: number = Date.now()): number {
  const successDays = new Set(
    history.filter((h) => h.status === 'success' && (h.outcome === undefined || h.outcome === 'http_success')).map((h) => h.date)
  );
  if (successDays.size === 0) return 0;

  const today = localDateKey(now);
  let cursor = successDays.has(today) ? today : dayKeyOffset(today, -1);
  if (!successDays.has(cursor)) return 0;

  let streak = 0;
  while (successDays.has(cursor)) {
    streak++;
    cursor = dayKeyOffset(cursor, -1);
  }
  return streak;
}

export interface DayCell {
  date: string;
  /** success | failed | none (no run recorded) */
  status: 'success' | 'failed' | 'none';
  /** What the run did: http_success / http_failure / opened_page / never. */
  outcome: CheckInOutcome;
  /** 'YYYY-MM-DD' === today */
  isToday: boolean;
}

/** Oldest → newest strip of the last `days` days, for the card's history row. */
export function recentDays(history: CheckInRun[], days = 14, now: number = Date.now()): DayCell[] {
  const byDate = new Map(history.map((h) => [h.date, h]));
  const today = localDateKey(now);
  const cells: DayCell[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const date = dayKeyOffset(today, -i);
    const entry = byDate.get(date);
    cells.push({
      date,
      status: entry ? (entry.status === 'success' ? 'success' : 'failed') : 'none',
      outcome: entry ? entry.outcome || (entry.status === 'success' ? 'http_success' : 'http_failure') : 'never',
      isToday: date === today
    });
  }
  return cells;
}

/** Whether today's run already succeeded (used to disable duplicate runs). */
export function hasRunToday(task: CheckInTask, now: number = Date.now()): { done: boolean; failed: boolean } {
  const today = localDateKey(now);
  const entry = (task.history || []).find((h) => h.date === today);
  if (!entry) return { done: false, failed: false };
  return { done: entry.status === 'success', failed: entry.status === 'failed' };
}

export const OUTCOME_LABEL: Record<CheckInOutcome, string> = {
  never: '未执行过',
  http_success: '已签到',
  http_failure: '执行失败',
  opened_page: '仅打开页面（未校验）'
};
