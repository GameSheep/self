/**
 * Home page rules (P1-03).
 * The home page is the first thing a user sees, and the old dashboard filled it
 * with empty operations cards that demanded configuration before they said
 * · are the only home settings, and they never change whether a background
 */
import type { CheckInTask, HubState, NavSite, ReminderItem } from '../types';
import { daysUntil } from '../lib/dates';

export type HomeBlockId = 'sites' | 'capture' | 'continue' | 'todo' | 'ops';

export interface HomeBlockPreference {
  id: HomeBlockId;
  hidden?: boolean;
  collapsed?: boolean;
}

export interface HomeBlockDef {
  id: HomeBlockId;
  label: string;
  description: string;
}

export const HOME_BLOCK_DEFS: HomeBlockDef[] = [
  { id: 'sites', label: '常用网站', description: '置顶与最近常访问的网站入口。' },
  { id: 'capture', label: '快速记录', description: '一行输入，先存收件箱，稍后再整理。' },
  { id: 'continue', label: '继续工作', description: '最近编辑或阅读过的资料。' },
  { id: 'todo', label: '待处理事项', description: '7 天内提醒、待整理收件箱、失败任务。' },
  { id: 'ops', label: '资源摘要', description: '主机检测与金库状态；没有数据时不显示。' }
];

export const DEFAULT_HOME_BLOCKS: HomeBlockPreference[] = HOME_BLOCK_DEFS.map((b) => ({ id: b.id }));

/** Coerce persisted preferences: keep known ids, drop duplicates, append missing. */
export function normalizeHomeBlocks(raw: unknown): HomeBlockPreference[] {
  const list = Array.isArray(raw) ? raw : [];
  const seen = new Set<HomeBlockId>();
  const out: HomeBlockPreference[] = [];
  for (const entry of list) {
    const id = (entry as HomeBlockPreference)?.id;
    if (!HOME_BLOCK_DEFS.some((d) => d.id === id) || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      hidden: Boolean((entry as HomeBlockPreference).hidden),
      collapsed: Boolean((entry as HomeBlockPreference).collapsed)
    });
  }
  for (const def of HOME_BLOCK_DEFS) {
    if (!seen.has(def.id)) out.push({ id: def.id });
  }
  return out;
}

function swap(list: HomeBlockPreference[], index: number, delta: number): HomeBlockPreference[] {
  const target = index + delta;
  if (target < 0 || target >= list.length) return list;
  const next = [...list];
  const [item] = next.splice(index, 1);
  next.splice(target, 0, item);
  return next;
}

/**
 * Move a block one position. Keyboard and button users get the same result as a
 * drag, which is why the alternative exists at all.
 */
export function moveHomeBlock(list: HomeBlockPreference[], id: HomeBlockId, delta: number): HomeBlockPreference[] {
  const index = list.findIndex((b) => b.id === id);
  if (index === -1) return list;
  return swap(list, index, delta);
}

export function toggleHomeBlock(
  list: HomeBlockPreference[],
  id: HomeBlockId,
  field: 'hidden' | 'collapsed'
): HomeBlockPreference[] {
  return list.map((block) => (block.id === id ? { ...block, [field]: !block[field] } : block));
}

/* -------------------------------------------------------------------------- */
/* Quick access sites                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Pinned first, then most-visited, then newest. Deterministic so the grid does
 * not reshuffle between two renders with identical data.
 */
export function selectHomeSites(state: HubState, limit = 12, category?: string): NavSite[] {
  const all = state.sites || [];
  // Filter on the full list *before* ranking: picking a group tab must not
  // shrink to "whatever survived the top-12 cut of 全部".
  const pool = category && category !== '全部' ? all.filter((s) => s.category === category) : [...all];
  pool.sort((a, b) => {
    if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
    const visits = (b.visitCount || 0) - (a.visitCount || 0);
    if (visits !== 0) return visits;
    return (b.createdAt || 0) - (a.createdAt || 0);
  });
  return pool.slice(0, limit);
}

/* -------------------------------------------------------------------------- */
/* Pending work                                                                */
/* -------------------------------------------------------------------------- */

export type PendingKind = 'reminder' | 'inbox' | 'task';

export interface PendingItem {
  key: string;
  kind: PendingKind;
  title: string;
  detail: string;
  /** Route to open for this item. */
  route: string;
  /** Sort weight: smaller is more urgent. */
  order: number;
  /** Negative days = overdue. */
  days?: number;
}

export const TODO_HORIZON_DAYS = 7;

/** Reminders due within the horizon, overdue first. */
export function selectPendingReminders(state: HubState, now = Date.now()): PendingItem[] {
  return (state.reminders || [])
    .filter((r: ReminderItem) => !r.completed)
    .map((r) => {
      const days = daysUntil(r.targetDate, now);
      return { reminder: r, days };
    })
    .filter(({ days }) => Number.isFinite(days) && days <= TODO_HORIZON_DAYS)
    .sort((a, b) => a.days - b.days)
    .map(({ reminder, days }) => ({
      key: `reminder:${reminder.id}`,
      kind: 'reminder' as const,
      title: reminder.title,
      detail: days < 0 ? `已过期 ${Math.abs(days)} 天` : days === 0 ? '今天到期' : `${days} 天后到期`,
      route: '#/reminders',
      order: days
    }));
}

/** Check-in tasks whose most recent run failed. */
export function selectFailedTasks(state: HubState): PendingItem[] {
  return (state.checkIns || [])
    .filter((task: CheckInTask) => task.lastStatus === 'failed')
    .map((task) => ({
      key: `task:${task.id}`,
      kind: 'task' as const,
      title: task.name,
      detail: task.lastMessage ? `上次失败：${task.lastMessage}` : '上次执行失败',
      route: '#/tools/checkins',
      order: 1
    }));
}

/**
 * Everything on the home page that is waiting for the user. Capped because the
 * block is a prompt to act, not a second inbox view.
 */
export function selectPending(state: HubState, now = Date.now(), limit = 6): PendingItem[] {
  const pendingInbox = (state.inbox || []).filter((i) => i.status === 'inbox').length;
  const items: PendingItem[] = [
    ...selectPendingReminders(state, now),
    ...selectFailedTasks(state)
  ];
  if (pendingInbox > 0) {
    items.push({
      key: 'inbox',
      kind: 'inbox',
      title: `${pendingInbox} 条内容待整理`,
      detail: '打开收件箱，保存为笔记、收藏或归档',
      route: '#/inbox',
      order: 2
    });
  }
  return items.sort((a, b) => a.order - b.order).slice(0, limit);
}

export interface OpsSummary {
  serversTotal: number;
  serversNeverChecked: number;
  serversOffline: number;
  expiringAssets: number;
  vaultLocked: boolean;
  secretsTotal: number;
}

/** Operations summary; the home block hides itself when there is nothing to say. */
export function selectOpsSummary(state: HubState, isUnlocked: boolean, now = Date.now()): OpsSummary {
  const servers = state.servers || [];
  const neverChecked = servers.filter((s) => !s.lastCheckedAt).length;
  const offline = servers.filter((s) => s.status === 'offline').length;

  const expiring = [
    ...servers.filter((s) => Number.isFinite(daysUntil(s.expiresAt || NaN, now)) && daysUntil(s.expiresAt || NaN, now) <= 30),
    ...(state.secrets || []).filter((s) => Number.isFinite(daysUntil(s.expiresAt || NaN, now)) && daysUntil(s.expiresAt || NaN, now) <= 30),
    ...(state.reminders || [])
      .filter((r) => !r.completed && (r.category === 'subscription' || r.category === 'domain' || r.category === 'cert'))
      .filter((r) => Number.isFinite(daysUntil(r.targetDate, now)) && daysUntil(r.targetDate, now) <= 30)
  ].length;

  return {
    serversTotal: servers.length,
    serversNeverChecked: neverChecked,
    serversOffline: offline,
    expiringAssets: expiring,
    vaultLocked: !isUnlocked,
    secretsTotal: (state.secrets || []).length
  };
}
