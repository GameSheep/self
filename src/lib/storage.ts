import { HubState, WucaiConfig, YoudaoConfig, GoTabPreferences } from '../types';
import { syncStateToIndexedDb } from './indexedDb';

const STORAGE_KEY = 'self_hub_data_v2';
const MASTER_HASH_KEY = 'self_hub_master_auth';
const SCHEMA_VERSION = 2;

export function getStorageKey(): string {
  return STORAGE_KEY;
}

export const INITIAL_STATE: HubState = {
  theme: 'dark',
  categories: ['全部', '常用工具', '技术开发', '运维部署', 'API与服务', '知识资讯'],
  sites: [
    {
      id: 'site-1',
      title: 'GitHub',
      url: 'https://github.com',
      category: '技术开发',
      description: '全球开发者代码托管与开源协作平台',
      icon: 'Code2',
      tags: ['Git', '代码', '开源'],
      pinned: true,
      visitCount: 1,
      createdAt: Date.now()
    },
    {
      id: 'site-2',
      title: 'MDN Web Docs',
      url: 'https://developer.mozilla.org',
      category: '技术开发',
      description: 'Web 标准、JavaScript/CSS 权威技术参考文档',
      icon: 'BookOpen',
      tags: ['Web', '参考', '文档'],
      pinned: true,
      visitCount: 1,
      createdAt: Date.now()
    },
    {
      id: 'site-3',
      title: 'Cloudflare 控制台',
      url: 'https://dash.cloudflare.com',
      category: '运维部署',
      description: 'DNS管理、边缘加速、Pages 部署与网络安全',
      icon: 'Cloud',
      tags: ['CDN', '安全', '部署'],
      pinned: true,
      visitCount: 1,
      createdAt: Date.now()
    },
    {
      id: 'site-4',
      title: 'V2EX',
      url: 'https://v2ex.com',
      category: '知识资讯',
      description: '创意工作者与技术极客交流讨论社区',
      icon: 'Compass',
      tags: ['社区', '资讯'],
      pinned: false,
      visitCount: 1,
      createdAt: Date.now()
    },
    {
      id: 'site-5',
      title: 'DevDocs',
      url: 'https://devdocs.io',
      category: '常用工具',
      description: '全栈开发语言与框架离线 API 极速速查表',
      icon: 'Zap',
      tags: ['工具', '速查'],
      pinned: false,
      visitCount: 1,
      createdAt: Date.now()
    },
    {
      id: 'site-6',
      title: 'Linux Command',
      url: 'https://wangchujiang.com/linux-command/',
      category: '常用工具',
      description: 'Linux 常用命令大全搜索速查工具',
      icon: 'Server',
      tags: ['Linux', '命令'],
      pinned: false,
      visitCount: 1,
      createdAt: Date.now()
    }
  ],
  servers: [],
  secrets: [],
  reminders: [],
  checkIns: [],
  notes: [
    {
      id: 'note-welcome',
      title: '欢迎使用 Self-Hub 个人数字命令中心',
      content: `### 核心功能与操作指南\n\n欢迎使用 **Self-Hub**！这是一个基于 **Local-First（本地优先）** 理念设计的个人数字命令中心与资料管理系统，所有数据默认存储在浏览器本地（IndexedDB + LocalStorage），无任何第三方云端追踪或强制依赖。\n\n#### 1. 快捷键与常用操作\n- **全局搜索**：按下 \`Ctrl+K\`（Mac: \`Cmd+K\`），支持拼音首字母检索，瞬间跳转任意网址、笔记、项目或服务器。\n- **快速捕获**：在「统一收件箱」粘贴文字或链接，按 \`Ctrl+Enter\` 极速存入，支持后续一键转为书签或笔记。\n- **浏览器插件（五彩 & GoTab 替代）**：在 \`chrome://extensions/\` 以开发者模式加载 \`extension/\` 目录，即可获得全网网页划词、5 色荧光笔标注、思考便签，以及全新的极简新标签页。\n\n#### 2. 安全与备份建议\n- **零知识加密金库**：所有密码、Token 与 API 密钥在客户端通过 PBKDF2 (100,000次) + AES-256-GCM 加密，主密码仅存纯内存。\n- **离线安全备份**：点击左下角设置图标，随时可以导出 AES-256 加密的 \`.enc.json\` 离线备份包。\n\n\`\`\`bash\n# 部署与启动命令\nnpm run build    # 构建生产包\nnpm run preview  # 本地启动预览\n\`\`\`\n`,
      category: '使用指南',
      tags: ['入门', '快捷键', '配置指南'],
      pinned: true,
      updatedAt: Date.now()
    }
  ],
  handwritings: [],
  obsidianConfig: {
    enabled: false,
    bucket: '',
    endpoint: 'oss-cn-hangzhou.aliyuncs.com',
    region: 'oss-cn-hangzhou',
    accessKeyId: '',
    accessKeySecret: '',
    prefix: 'vault/'
  },
  obsidianNotes: [],
  wucaiConfig: {
    enabled: false,
    token: ''
  },
  wucaiHighlights: [],
  youdaoConfig: {
    enabled: false,
    token: '',
    cookie: ''
  },
  youdaoNotes: [],
  aiConfig: {
    provider: 'gemini',
    apiKey: '',
    baseUrl: 'https://generativelanguage.googleapis.com',
    model: 'gemini-2.5-flash'
  },
  cloudflareSync: {
    enabled: false,
    workerUrl: '',
    syncKey: '',
    autoSync: false
  },
  webdavConfig: {
    enabled: false,
    url: '',
    username: '',
    password: '',
    pathPrefix: 'selfhub_sync'
  },
  inbox: [],
  projects: [],
  annotations: [],
  gotabPrefs: {
    searchEngine: 'google',
    wallpaperType: 'minimal',
    showQuickNotes: true,
    showProjects: true,
    dockLayout: 'comfortable'
  }
};

export function resetHubStateToClean(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(MASTER_HASH_KEY);
    localStorage.removeItem('self_hub_trusted_device');
    localStorage.removeItem('selfhub_note_draft');
    inMemoryFallbackState = null;
    saveHubState(INITIAL_STATE);
  } catch {}
}

// In-memory recovery buffer if localStorage fails
let inMemoryFallbackState: HubState | null = null;

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function mergeObject<T extends object>(defaults: T, value: unknown): T {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...defaults };
  return { ...defaults, ...(value as Partial<T>) };
}

/**
 * Coerce arbitrary (possibly imported / legacy / hand-edited) data into a complete HubState.
 *
 * Every consumer of a restored backup must go through this: importBackup() and
 * importEncryptedBackup() only validate a subset of the fields, so a backup missing
 * `checkIns`/`handwritings`/`obsidianConfig`/`categories` used to reach the views and
 * crash them (undefined.length) into a blank page.
 */
export function normalizeHubState(raw: unknown): HubState {
  const base: any = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};

  return {
    schemaVersion: SCHEMA_VERSION,
    theme: base.theme === 'light' ? 'light' : 'dark',
    categories:
      Array.isArray(base.categories) && base.categories.length > 0
        ? base.categories.filter((c: unknown) => typeof c === 'string')
        : [...INITIAL_STATE.categories],
    sites: asArray(base.sites),
    servers: asArray(base.servers),
    secrets: asArray(base.secrets),
    checkIns: asArray(base.checkIns),
    reminders: asArray(base.reminders),
    notes: asArray(base.notes),
    handwritings: asArray(base.handwritings),
    inbox: asArray(base.inbox),
    projects: asArray(base.projects),
    annotations: asArray(base.annotations),
    obsidianNotes: asArray(base.obsidianNotes),
    wucaiHighlights: asArray(base.wucaiHighlights),
    youdaoNotes: asArray(base.youdaoNotes),
    obsidianConfig: mergeObject(INITIAL_STATE.obsidianConfig, base.obsidianConfig),
    wucaiConfig: mergeObject(INITIAL_STATE.wucaiConfig as WucaiConfig, base.wucaiConfig),
    youdaoConfig: mergeObject(INITIAL_STATE.youdaoConfig as YoudaoConfig, base.youdaoConfig),
    aiConfig: mergeObject(INITIAL_STATE.aiConfig, base.aiConfig),
    cloudflareSync: mergeObject(INITIAL_STATE.cloudflareSync, base.cloudflareSync),
    webdavConfig: mergeObject(INITIAL_STATE.webdavConfig, base.webdavConfig),
    gotabPrefs: mergeObject(INITIAL_STATE.gotabPrefs as GoTabPreferences, base.gotabPrefs)
  };
}

export function loadHubState(): HubState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      // No seed write here: loadHubState() runs inside a useState initializer
      // (render phase). App seeds storage from an effect instead.
      return normalizeHubState(INITIAL_STATE);
    }
    return normalizeHubState(JSON.parse(raw));
  } catch (err) {
    console.error('Failed to load state from localStorage', err);
    // Keep the damaged payload so the user can still export/salvage it.
    try {
      const damaged = localStorage.getItem(STORAGE_KEY);
      if (damaged) localStorage.setItem(`${STORAGE_KEY}__corrupt_${Date.now()}`, damaged);
    } catch {}
    return normalizeHubState(inMemoryFallbackState || INITIAL_STATE);
  }
}

export function saveHubState(state: HubState): { success: boolean; error?: string } {
  // Never mutate the caller's object (INITIAL_STATE used to be patched in place).
  const payload: HubState = { ...state, schemaVersion: SCHEMA_VERSION };
  inMemoryFallbackState = payload;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    // Asynchronously replicate to persistent IndexedDB
    syncStateToIndexedDb(payload).catch((e) => console.warn('IndexedDB auto-sync error', e));
    return { success: true };
  } catch (err: any) {
    console.error('Failed to save state to localStorage', err);
    // Still try to persist in IndexedDB even if localStorage quota failed!
    syncStateToIndexedDb(payload).catch(() => {});
    const isQuota =
      err?.name === 'QuotaExceededError' ||
      err?.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
      err?.code === 22;
    return {
      success: false,
      error: isQuota
        ? '浏览器本地存储空间已满（LocalStorage 约 5MB）。本次改动只存在于内存中，刷新后会丢失：请先导出备份，再删除部分手绘/大笔记后重试。'
        : `保存失败: ${err?.message || '未知存储错误'}`
    };
  }
}

/**
 * Validate HubState structure integrity (N02)
 */
export function validateHubState(data: any): { isValid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!data || typeof data !== 'object') {
    return { isValid: false, errors: ['备份数据必须为有效的 JSON 对象'] };
  }

  const requiredArrays = [
    'sites', 'servers', 'secrets', 'reminders', 'notes', 'checkIns', 'handwritings'
  ];
  for (const field of requiredArrays) {
    if (data[field] !== undefined && !Array.isArray(data[field])) {
      errors.push(`字段类型错误，应为数组: ${field}`);
    }
  }
  for (const field of ['sites', 'servers', 'secrets', 'reminders', 'notes']) {
    if (!Array.isArray(data[field])) {
      errors.push(`缺少必要数据集合: ${field}`);
    }
  }

  // Check ID integrity and detect duplicate keys
  const seenIds = new Set<string>();
  const checkColl = (items: any[], typeName: string) => {
    if (!Array.isArray(items)) return;
    for (const item of items) {
      if (!item || !item.id) {
        errors.push(`${typeName} 集合中包含缺失唯一标识 ID 的无效条目`);
      } else if (seenIds.has(item.id)) {
        errors.push(`${typeName} 发现重复 ID: ${item.id}`);
      } else {
        seenIds.add(item.id);
      }
    }
  };

  checkColl(data.sites, '常用站点');
  checkColl(data.servers, '部署服务器');
  checkColl(data.secrets, '金库凭据');
  checkColl(data.notes, '知识笔记');
  checkColl(data.reminders, '提醒事项');
  checkColl(data.checkIns, '签到任务');
  checkColl(data.handwritings, '手绘卡片');
  checkColl(data.inbox, '收件箱条目');
  checkColl(data.projects, '项目空间');

  return { isValid: errors.length === 0, errors };
}

export function getMasterAuth(): { hash: string; salt: string } | null {
  try {
    const raw = localStorage.getItem(MASTER_HASH_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function setMasterAuth(hash: string, salt: string): void {
  try {
    localStorage.setItem(MASTER_HASH_KEY, JSON.stringify({ hash, salt }));
  } catch (err) {
    console.error('Failed to set master auth', err);
  }
}

export function exportBackup(state: HubState): void {
  const dataStr = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(state, null, 2));
  const downloadAnchor = document.createElement('a');
  downloadAnchor.setAttribute('href', dataStr);
  downloadAnchor.setAttribute('download', `self-hub-backup-v2-${new Date().toISOString().slice(0, 10)}.json`);
  document.body.appendChild(downloadAnchor);
  downloadAnchor.click();
  downloadAnchor.remove();
}

const ROLLBACK_KEY = 'self_hub_rollback_snapshot';

/** Snapshot the current payload so a bad import can be undone. */
export function snapshotForRollback(): void {
  try {
    const prev = localStorage.getItem(STORAGE_KEY);
    if (prev) sessionStorage.setItem(ROLLBACK_KEY, prev);
  } catch {}
}

export function hasRollbackSnapshot(): boolean {
  try {
    return Boolean(sessionStorage.getItem(ROLLBACK_KEY));
  } catch {
    return false;
  }
}

/** Restore the snapshot captured before the last backup import. */
export function restoreRollbackSnapshot(): HubState | null {
  try {
    const raw = sessionStorage.getItem(ROLLBACK_KEY);
    if (!raw) return null;
    sessionStorage.removeItem(ROLLBACK_KEY);
    const restored = normalizeHubState(JSON.parse(raw));
    saveHubState(restored);
    return restored;
  } catch {
    return null;
  }
}

export function importBackup(jsonString: string): HubState | null {
  try {
    const parsed = JSON.parse(jsonString);
    const validation = validateHubState(parsed);
    if (!validation.isValid) {
      console.warn('Backup validation failed:', validation.errors);
      alert(`❌ 备份格式校验失败:\n${validation.errors.join('\n')}`);
      return null;
    }

    // Save previous snapshot as emergency rollback (readable via restoreRollbackSnapshot)
    snapshotForRollback();

    // Normalised so missing optional collections can never reach the views.
    // Persisting is the caller's job (App persists every committed state change).
    return normalizeHubState(parsed);
  } catch (err) {
    console.error('Failed to import backup', err);
    return null;
  }
}
