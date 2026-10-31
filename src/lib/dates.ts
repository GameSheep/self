/**
 * Local-time date helpers.
 * `<input type="date">` works in local time while `Date#toISOString()` works in UTC,
 * so mixing them shifted renewal dates by one day for users east of UTC (e.g. 东八区)
 * · browser's local calendar. `toISOString()` is never involved.
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

const MAX_STEPS = 1200; // ~100 years of monthly steps; a hard stop guarantees no infinite loop

/** Last day-of-month for a (0-based) month in a year — 28/29/30/31. */
export function lastDayOfMonth(year: number, monthIndex: number): number {
  return new Date(year, monthIndex + 1, 0).getDate();
}

/**
 * Clamp a day-of-month to the calendar: 31 → 28/29 in February, 31 → 30 in April.
 * Invalid input returns NaN.
 */
export function clampDayOfMonth(year: number, monthIndex: number, day: number): number {
  const requested = Math.trunc(day);
  if (!Number.isFinite(requested) || requested < 1) return NaN;
  if (!Number.isFinite(year) || !Number.isFinite(monthIndex)) return NaN;
  return Math.min(requested, lastDayOfMonth(year, monthIndex));
}

/**
 * Add whole months while keeping the requested day-of-month, clamping into the
 * target month instead of letting JavaScript roll over into the next one.
 * `addMonthsClamped(1 月 31 日, 1, 31)` → 2 月 28 日 (2 月 29 日 in a leap year),
 * · never 3 月 3 日. The time-of-day carried by `ts` is preserved; invalid input
 */
export function addMonthsClamped(ts: number, months: number, anchorDay?: number): number {
  const base = new Date(ts);
  if (Number.isNaN(base.getTime())) return NaN;
  const step = Math.trunc(months);
  if (!Number.isFinite(step)) return NaN;

  const requestedDay = anchorDay === undefined ? base.getDate() : anchorDay;
  // setDate(1) first: otherwise 1 月 31 日 + setMonth would overflow before we clamp.
  const d = new Date(ts);
  d.setDate(1);
  d.setMonth(d.getMonth() + step);
  const day = clampDayOfMonth(d.getFullYear(), d.getMonth(), requestedDay);
  if (Number.isNaN(day)) return NaN;
  d.setDate(day);
  return d.getTime();
}

/** Add whole years, clamping 2 月 29 日 down to 2 月 28 日 in a non-leap year. */
export function addYearsClamped(ts: number, years: number, anchorMonth?: number, anchorDay?: number): number {
  const base = new Date(ts);
  if (Number.isNaN(base.getTime())) return NaN;
  const step = Math.trunc(years);
  if (!Number.isFinite(step)) return NaN;

  const month = anchorMonth === undefined ? base.getMonth() : Math.trunc(anchorMonth);
  const requestedDay = anchorDay === undefined ? base.getDate() : anchorDay;
  const d = new Date(ts);
  d.setDate(1);
  d.setFullYear(d.getFullYear() + step);
  d.setMonth(month);
  const day = clampDayOfMonth(d.getFullYear(), month, requestedDay);
  if (Number.isNaN(day)) return NaN;
  d.setDate(day);
  return d.getTime();
}

/** Identity of a recurrence series: the day (and month, for yearly) it started on. */
export interface RecurrenceAnchor {
  /** 1–31 */
  day: number;
  /** 0-based month; only meaningful for yearly series. */
  month?: number;
}

/** Anchor derived from a date: the series starts wherever the user entered it. */
export function anchorFromDate(ts: number, recurring?: string): RecurrenceAnchor | null {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  return recurring === 'yearly' ? { day: d.getDate(), month: d.getMonth() } : { day: d.getDate() };
}

/**
 * Resolve the anchor to use for `addOneCycle`/`advanceRecurringDate`.
 *
 * The stored anchor is the source of truth. `fallback` (the current due date) is
 * only used for legacy rows that predate `anchorDay`.
 */
export function resolveAnchor(
  storedDay: number | undefined,
  storedMonth: number | undefined,
  fallback: Date | number,
  recurring?: string
): RecurrenceAnchor {
  const fb = fallback instanceof Date ? fallback : new Date(fallback);
  const valid = !Number.isNaN(fb.getTime());
  const day =
    Number.isFinite(storedDay) && (storedDay as number) >= 1 && (storedDay as number) <= 31
      ? Math.trunc(storedDay as number)
      : valid
        ? fb.getDate()
        : NaN;
  const month =
    Number.isFinite(storedMonth) && (storedMonth as number) >= 0 && (storedMonth as number) <= 11
      ? Math.trunc(storedMonth as number)
      : valid
        ? fb.getMonth()
        : NaN;
  return recurring === 'yearly' ? { day, month } : { day };
}

/** Options accepted by the recurrence helpers (kept optional for older callers). */
export interface CycleOptions {
  /** 1–31; the day-of-month the monthly series is anchored to. */
  anchorDay?: number;
  /** 0-based; the month the yearly series is anchored to. */
  anchorMonth?: number;
}

/** Normalise `(recurring, options)` where older callers passed the anchor as a number. */
function readAnchor(
  options: CycleOptions | number | undefined
): { anchorDay?: number; anchorMonth?: number } {
  if (typeof options === 'number') return { anchorDay: options };
  return { anchorDay: options?.anchorDay, anchorMonth: options?.anchorMonth };
}

/**
 * Move a date forward by exactly one recurrence cycle.
 *
 * Returns `fromTs` unchanged for unknown/invalid recurrences (no invented
 * "+30 days" cycle), and NaN-safe for invalid input.
 *
 * The `options` argument may also be a plain number, which is read as `anchorDay`
 * (the previous signature: `addOneCycle(ts, 'monthly', 31)`).
 */
export function addOneCycle(fromTs: number, recurring: string, options?: CycleOptions | number): number {
  const base = new Date(fromTs);
  if (Number.isNaN(base.getTime())) return fromTs;
  const { anchorDay, anchorMonth } = readAnchor(options);

  if (recurring === 'monthly') {
    const day = anchorDay ?? base.getDate();
    return addMonthsClamped(fromTs, 1, day);
  }
  if (recurring === 'yearly') {
    const month = anchorMonth ?? base.getMonth();
    const day = anchorDay ?? base.getDate();
    return addYearsClamped(fromTs, 1, month, day);
  }
  if (recurring === 'weekly') {
    return fromTs + 7 * MS_PER_DAY;
  }
  return fromTs;
}

export function isSupportedRecurrence(recurring: string | undefined): boolean {
  return recurring === 'monthly' || recurring === 'yearly' || recurring === 'weekly';
}

/**
 * Timestamp of the `steps`-th cycle after `fromTs`, computing directly from the
 * anchor so clamping never accumulates (2 月 28 日 is still the 31st's series).
 * Returns NaN when the recurrence is unknown or the input is invalid.
 */
export function occurrenceAt(fromTs: number, recurring: string, steps: number, options?: CycleOptions | number): number {
  const { anchorDay, anchorMonth } = readAnchor(options);
  if (recurring === 'weekly') return fromTs + steps * 7 * MS_PER_DAY;
  if (recurring === 'monthly') return addMonthsClamped(fromTs, steps, anchorDay);
  if (recurring === 'yearly') {
    const month = anchorMonth ?? new Date(fromTs).getMonth();
    return addYearsClamped(fromTs, steps, month, anchorDay);
  }
  return NaN;
}

/**
 * Advance `fromTs` by whole recurrence cycles until it reaches `nowTs`, so an
 * expired series catches up in one call.
 * Returns null for unknown/invalid recurrences instead of looping forever, and
 */
export function advanceRecurringDate(
  fromTs: number,
  recurring: string,
  nowTs: number,
  options?: CycleOptions | number
): Date | null {
  const base = new Date(fromTs);
  if (Number.isNaN(base.getTime())) return null;
  if (!isSupportedRecurrence(recurring)) return null;

  let last: number | null = null;
  for (let step = 1; step <= MAX_STEPS; step++) {
    const ts = occurrenceAt(fromTs, recurring, step, options);
    if (!Number.isFinite(ts)) return null;
    if (ts > nowTs) break;
    last = ts;
  }
  return last === null ? null : new Date(last);
}

/** {@link advanceRecurringDate} as a number, for callers that store timestamps. */
export function advanceRecurringTimestamp(
  fromTs: number,
  recurring: string,
  nowTs: number,
  options?: CycleOptions | number
): number | null {
  const next = advanceRecurringDate(fromTs, recurring, nowTs, options);
  return next ? next.getTime() : null;
}

/**
 * The due date the *next* period lands on when the user renews the occurrence
 * that is currently listed: exactly one anchored cycle, never a jump to the
 * furthest future cycle. Catch-up is `advanceRecurringDate`'s job.
 */
export function adjacentRenewal(targetTs: number, recurring: string, options?: CycleOptions | number): number | null {
  const next = addOneCycle(targetTs, recurring, options);
  if (!Number.isFinite(next) || next <= targetTs) return null;
  return next;
}

/**
 * The next occurrence strictly after `ts` for an active (possibly overdue)
 * series. Used by the auto-rollover path, which must not invent an occurrence
 * the user never acted on.
 */
export function nextOccurrenceAfter(
  fromTs: number,
  recurring: string,
  ts: number,
  options?: CycleOptions | number
): number | null {
  const catchUp = advanceRecurringTimestamp(fromTs, recurring, ts, options);
  if (catchUp === null) {
    const first = occurrenceAt(fromTs, recurring, 1, options);
    return Number.isFinite(first) ? first : null;
  }
  const next = addOneCycle(catchUp, recurring, options);
  return Number.isFinite(next) ? next : null;
}

/**
 * Compact relative time for list rows ("3 分钟前"); the absolute date stays
 * available on hover via title attributes in the views.
 */
export function formatRelative(ts: number): string {
  if (!ts) return '时间未知';
  const diff = Date.now() - ts;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)} 小时前`;
  if (diff < 30 * 86_400_000) return `${Math.round(diff / 86_400_000)} 天前`;
  return new Date(ts).toLocaleDateString();
}
