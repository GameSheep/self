import type { DomainRecord, HubState } from '../types';

/**
 * 域名 as first-class records.
 * Why this exists: 域名 used to be a *projection* over 提醒 — a reminder with
 * `category: 'domain'`. The page therefore only ever offered 「新建到期提醒」, and pressing it
 */

export function normalizeDomainName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '');
}

export function createDomain(input: {
  name: string;
  startAt?: number;
  expireAt?: number;
  registrar?: string;
  dns?: string;
  url?: string;
  note?: string;
}): DomainRecord {
  const name = normalizeDomainName(input.name) || input.name.trim();
  return {
    id: `dom-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    name,
    startAt: input.startAt,
    expireAt: input.expireAt,
    registrar: input.registrar?.trim() || undefined,
    dns: input.dns?.trim() || undefined,
    url: input.url?.trim() || undefined,
    note: input.note?.trim() || undefined,
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
}

/**
 * Copy `category: 'domain'` reminders into domain records (idempotent).
 *
 * Matching is by normalised name, so running it on every boot cannot duplicate rows. The
 * reminder is left untouched — deleting it would change what 「今天要处理」 shows, which is a
 * separate decision the user has not asked for.
 */
export function migrateDomainReminders(state: HubState): HubState {
  const existing = new Set((state.domains ?? []).map((domain) => normalizeDomainName(domain.name)));
  const additions: DomainRecord[] = [];

  for (const reminder of state.reminders ?? []) {
    if (reminder.category !== 'domain') continue;
    const name = normalizeDomainName(reminder.title);
    if (!name || existing.has(name)) continue;
    existing.add(name);
    additions.push({
      id: `dom-migrated-${reminder.id}`,
      name,
      expireAt: reminder.targetDate,
      url: reminder.url,
      note: '由提醒迁移而来',
      createdAt: reminder.createdAt ?? Date.now(),
      updatedAt: Date.now()
    });
  }

  if (additions.length === 0) return state;
  return { ...state, domains: [...(state.domains ?? []), ...additions] };
}

/** Days until expiry; negative means overdue. Null when there is no date. */
export function daysUntilExpiry(domain: DomainRecord, now = Date.now()): number | null {
  if (!domain.expireAt) return null;
  const day = 86_400_000;
  return Math.floor((startOfDay(domain.expireAt) - startOfDay(now)) / day);
}

function startOfDay(value: number): number {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}
