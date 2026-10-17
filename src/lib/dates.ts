/**
 * Local-time date helpers.
 *
 * `<input type="date">` works in local time while `Date#toISOString()` works in UTC,
 * so mixing them shifted renewal dates by one day for users east of UTC (e.g. 东八区)
 * and produced the off-by-one "D-0天" countdown.
 */

export const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Midnight of the local day containing `ts` (invalid input returns NaN). */
export function startOfLocalDay(ts: number): number {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return NaN;
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Whole local days from today to `targetTs`: 0 = today, 1 = tomorrow, -1 = yesterday. */
export function daysUntil(targetTs: number, nowTs: number = Date.now()): number {
  const target = startOfLocalDay(targetTs);
  const today = startOfLocalDay(nowTs);
  if (Number.isNaN(target) || Number.isNaN(today)) return NaN;
  return Math.round((target - today) / MS_PER_DAY);
}

export function formatCountdown(targetTs: number, nowTs: number = Date.now()): string {
  const days = daysUntil(targetTs, nowTs);
  if (Number.isNaN(days)) return '日期无效';
  if (days === 0) return '今天到期';
  if (days < 0) return `已过期 ${Math.abs(days)} 天`;
  return `剩余 ${days} 天`;
}

/** Local `YYYY-MM-DD` for `<input type="date" value=...>`. */
export function toDateInputValue(ts: number): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Parse `YYYY-MM-DD` as *local* midnight. Returns NaN when unparseable. */
export function parseDateInputValue(value: string): number {
  if (!value) return NaN;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (m) {
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0).getTime();
  }
  return new Date(value).getTime();
}

export type Recurrence = 'monthly' | 'yearly' | 'weekly' | 'once';

const MAX_STEPS = 1200; // ~100 years of weekly steps; a hard stop guarantees no infinite loop

/**
 * Advance `fromTs` by whole recurrence cycles until it reaches `nowTs`.
 * Returns null for unknown/invalid recurrences instead of looping forever.
 */
export function advanceRecurringDate(fromTs: number, recurring: string, nowTs: number): Date | null {
  const next = new Date(fromTs);
  if (Number.isNaN(next.getTime())) return null;
  if (recurring !== 'monthly' && recurring !== 'yearly' && recurring !== 'weekly') return null;

  let steps = 0;
  while (next.getTime() < nowTs && steps < MAX_STEPS) {
    if (recurring === 'monthly') next.setMonth(next.getMonth() + 1);
    else if (recurring === 'yearly') next.setFullYear(next.getFullYear() + 1);
    else next.setDate(next.getDate() + 7);
    steps++;
  }
  if (steps >= MAX_STEPS) return null;
  return next;
}

/** Move a date forward by exactly one recurrence cycle. */
export function addOneCycle(fromTs: number, recurring: string): number {
  const d = new Date(fromTs);
  if (Number.isNaN(d.getTime())) return fromTs;
  if (recurring === 'monthly') d.setMonth(d.getMonth() + 1);
  else if (recurring === 'yearly') d.setFullYear(d.getFullYear() + 1);
  else if (recurring === 'weekly') d.setDate(d.getDate() + 7);
  else return fromTs;
  return d.getTime();
}

/** The next renewal timestamp after `nowTs`, starting from the item's due date. */
export function nextRenewal(targetTs: number, recurring: string, nowTs: number = Date.now()): number | null {
  const base = Number(targetTs);
  if (!Number.isFinite(base)) return null;
  if (recurring === 'once') return null;
  if (base >= nowTs) return addOneCycle(base, recurring);
  const advanced = advanceRecurringDate(base, recurring, nowTs + 1);
  return advanced ? advanced.getTime() : addOneCycle(base, recurring);
}
