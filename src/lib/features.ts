/**
 * Optional feature switches.
 *
 * Not every user needs every module, and a long sidebar is its own kind of
 * complexity. These switches hide a module entirely (nav + routing) rather than
 * half-working: nothing is deleted, turning the switch back on restores it.
 *
 * Core modules (dashboard, sites, reminders, obsidian vault) are intentionally
 * not switchable — they are the product.
 */

export type FeatureId =
  | 'inbox'
  | 'projects'
  | 'servers'
  | 'secrets'
  | 'notes'
  | 'checkin'
  | 'handwriting'
  | 'wucai'
  | 'youdao';

export interface FeatureFlags {
  inbox: boolean;
  projects: boolean;
  servers: boolean;
  secrets: boolean;
  notes: boolean;
  checkin: boolean;
  handwriting: boolean;
  wucai: boolean;
  youdao: boolean;
}

export const DEFAULT_FEATURES: FeatureFlags = {
  inbox: true,
  projects: true,
  servers: true,
  secrets: true,
  notes: true,
  checkin: true,
  handwriting: true,
  wucai: true,
  youdao: true
};

export interface FeatureDef {
  id: FeatureId;
  label: string;
  description: string;
  /** Nav tab this switch controls, when it maps to one. */
  tab?: string;
  /** Advanced modules start collapsed under "更多" in settings. */
  advanced?: boolean;
}

export const FEATURE_DEFS: FeatureDef[] = [
  { id: 'inbox', label: '统一收件箱', description: '碎片信息的中转站，AI 分拣的入口。', tab: 'inbox' },
  { id: 'projects', label: '自研项目空间', description: '按项目归档资料与进度。', tab: 'projects' },
  { id: 'notes', label: '深度知识文档', description: '本地 Markdown 长文。', tab: 'notes' },
  { id: 'handwriting', label: '交互手绘白板', description: '手绘草图与白板。', tab: 'handwriting' },
  { id: 'servers', label: '自研部署与主机', description: '服务器清单与健康探测。', tab: 'servers' },
  { id: 'secrets', label: '加密安全金库', description: 'AES-256 加密凭据。关闭后不再出现在侧边栏，已存数据仍在。', tab: 'secrets' },
  { id: 'checkin', label: '自动化与打卡', description: '定时签到与连续记录。', tab: 'checkin' },
  { id: 'wucai', label: '五彩划词高亮', description: '从五彩拉取高亮笔记。', tab: 'obsidian' },
  { id: 'youdao', label: '有道云笔记', description: '同步有道云笔记。', tab: 'obsidian' }
];

export function isFeatureEnabled(features: Partial<FeatureFlags> | undefined, id: FeatureId): boolean {
  if (!features) return true;
  const value = features[id];
  return value === undefined ? true : Boolean(value);
}

/** Normalise whatever was persisted into a complete flag set. */
export function normalizeFeatures(raw: unknown): FeatureFlags {
  const base = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const out = { ...DEFAULT_FEATURES };
  (Object.keys(DEFAULT_FEATURES) as FeatureId[]).forEach((id) => {
    if (typeof base[id] === 'boolean') out[id] = base[id] as boolean;
  });
  return out;
}

/** Tabs that are always available, regardless of switches. */
export const CORE_TABS = ['dashboard', 'sites', 'reminders', 'obsidian'] as const;

/** True when the tab is reachable given the current switches. */
export function isTabAllowed(tab: string, features: Partial<FeatureFlags> | undefined): boolean {
  if ((CORE_TABS as readonly string[]).includes(tab)) return true;
  const def = FEATURE_DEFS.find((f) => f.tab === tab);
  if (!def) return true;
  return isFeatureEnabled(features, def.id);
}
