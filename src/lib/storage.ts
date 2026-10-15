import { HubState } from '../types';
import { syncStateToIndexedDb } from './indexedDb';

const STORAGE_KEY = 'self_hub_data_v2';
const MASTER_HASH_KEY = 'self_hub_master_auth';

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

export function loadHubState(): HubState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      saveHubState(INITIAL_STATE);
      return INITIAL_STATE;
    }
    const parsed = JSON.parse(raw);
    return { ...INITIAL_STATE, ...parsed };
  } catch (err) {
    console.error('Failed to load state from localStorage', err);
    return inMemoryFallbackState || INITIAL_STATE;
  }
}

export function saveHubState(state: HubState): { success: boolean; error?: string } {
  state.schemaVersion = 2;
  inMemoryFallbackState = state;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    // Asynchronously replicate to persistent IndexedDB
    syncStateToIndexedDb(state).catch((e) => console.warn('IndexedDB auto-sync error', e));
    return { success: true };
  } catch (err: any) {
    console.error('Failed to save state to localStorage', err);
    // Still try to persist in IndexedDB even if localStorage quota failed!
    syncStateToIndexedDb(state).catch(() => {});
    return {
      success: false,
      error: err?.name === 'QuotaExceededError' 
        ? 'LocalStorage 空间超出限制，数据已自动备份至 IndexedDB 底座与内存' 
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

  const requiredArrays = ['sites', 'servers', 'secrets', 'reminders', 'notes'];
  for (const field of requiredArrays) {
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

export function importBackup(jsonString: string): HubState | null {
  try {
    const parsed = JSON.parse(jsonString);
    const validation = validateHubState(parsed);
    if (!validation.isValid) {
      console.warn('Backup validation failed:', validation.errors);
      alert(`❌ 备份格式校验失败:\n${validation.errors.join('\n')}`);
      return null;
    }

    // Save previous snapshot as emergency rollback
    try {
      const prev = localStorage.getItem(STORAGE_KEY);
      if (prev) sessionStorage.setItem('self_hub_rollback_snapshot', prev);
    } catch {}

    saveHubState(parsed);
    return parsed;
  } catch (err) {
    console.error('Failed to import backup', err);
    return null;
  }
}
