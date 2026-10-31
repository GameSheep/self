/**
 * Optional feature switches.
 * Not every user needs every module, and a long sidebar is its own kind of
 * complexity. These switches hide a module entirely (nav + routing) rather than
 */

export type FeatureId =
  | 'inbox'
  | 'projects'
  | 'servers'
  | 'secrets'
  | 'notes'
  | 'annotations'
  | 'obsidian'
  | 'checkin'
  | 'handwriting'
  | 'assets'
  | 'wucai'
  | 'youdao';

export interface FeatureFlags {
  inbox: boolean;
  projects: boolean;
  servers: boolean;
  secrets: boolean;
  notes: boolean;
  /** 网页划线 / 批注 collection and its own entry in the sidebar. */
  annotations: boolean;
  /** The OSS markdown library (远端笔记). */
  obsidian: boolean;
  checkin: boolean;
  handwriting: boolean;
  /** 域名与订阅 (a projection over reminders / servers / credentials). */
  assets: boolean;
  wucai: boolean;
  youdao: boolean;
}

export const DEFAULT_FEATURES: FeatureFlags = {
  inbox: true,
  projects: true,
  servers: true,
  secrets: true,
  notes: true,
  annotations: true,
  obsidian: true,
  checkin: true,
  handwriting: true,
  assets: true,
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
  { id: 'projects', label: '项目空间', description: '按项目归档资料与进度。', tab: 'projects' },
  { id: 'notes', label: '资料库与笔记', description: '本地 Markdown 长文，以及全部资料的统一列表。', tab: 'notes' },
  {
    id: 'annotations',
    label: '网页划线批注',
    description: '保存网页高亮与自己的批注，侧边栏有独立入口。关闭后不再显示入口，已存批注仍在。',
    tab: 'notes'
  },
  {
    id: 'obsidian',
    label: '远端笔记（阿里云 OSS）',
    description: '直接浏览与编辑 OSS 上的 Markdown 笔记库。关闭后只隐藏入口，云端文件不动。',
    tab: 'obsidian'
  },
  { id: 'handwriting', label: '手绘白板', description: '手绘草图与白板。', tab: 'handwriting' },
  { id: 'servers', label: '服务器', description: '服务器清单与健康探测。', tab: 'servers' },
  { id: 'secrets', label: '凭证金库', description: 'AES-256 加密凭据。关闭后不再出现在侧边栏，已存数据仍在。', tab: 'secrets' },
  { id: 'assets', label: '域名与订阅', description: '到期资源的集中视图（日期仍来自提醒 / 服务器 / 凭证）。', tab: 'assets' },
  { id: 'checkin', label: '签到', description: '定时签到与连续记录。', tab: 'checkin' },
  { id: 'wucai', label: '五彩划词高亮', description: '从五彩拉取高亮笔记，入口在「远端笔记」里。', tab: 'obsidian' },
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
