/**
 * Check-in history and streaks.
 *
 * The old model only stored `streakDays` and incremented it on every run, so
 * clicking "打卡" twice in one day counted as two days, and there was no record
 * of which days were actually done. History is now the source of truth and the
 * streak is derived from it.
 */
import { CheckInRun, CheckInTask } from '../types';

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
}

/**
 * Record a run for today.
 *
 * - Only one entry per local day: running again replaces today's entry, so a
 *   double click can never inflate the streak.
 * - A run that could not be verified (e.g. "opened the check-in page") is stored
 *   as failed-for-streak but still recorded, with its message explaining why.
 */
export function recordRun(task: CheckInTask, outcome: RunOutcome, now: number = Date.now()): CheckInTask {
  const date = localDateKey(now);
  const counted = outcome.success && outcome.verified !== false;
  const entry: CheckInRun = {
    date,
    at: now,
    status: counted ? 'success' : 'failed',
    message: outcome.message
  };

  const history = [...(task.history || []).filter((h) => h.date !== date), entry]
    .sort((a, b) => b.at - a.at)
    .slice(0, HISTORY_LIMIT);

  return {
    ...task,
    lastRun: now,
    lastStatus: outcome.success ? 'success' : 'failed',
    lastMessage: outcome.message,
    history,
    streakDays: computeStreak(history, now)
  };
}

/**
 * Consecutive days with a successful run, counting back from today.
 * Yesterday still counts as "current" (you may simply not have run it yet today).
 */
export function computeStreak(history: CheckInRun[], now: number = Date.now()): number {
  const successDays = new Set(history.filter((h) => h.status === 'success').map((h) => h.date));
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
