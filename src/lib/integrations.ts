/**
 * Integration registry — the single source of truth for every external connection.
 *
 * Before this file, each integration had its own bespoke settings block, its own
 * mutable state in the modal, and its own "is it configured?" logic copy-pasted
 * into the overview. Adding one connection meant touching four places, which is
 * how the settings ended up scattered.
 *
 * Now: add an entry here, and the settings UI, the overview status board and the
 * batch save all pick it up automatically.
 */
import { HubState } from '../types';

export type IntegrationId = 'oss' | 'webdav' | 'ai' | 'wucai' | 'youdao';

export type SettingsSection = 'overview' | 'storage' | 'sync' | 'content' | 'ai' | 'data';

export interface IntegrationField {
  key: string;
  label: string;
  type?: 'text' | 'password' | 'select';
  placeholder?: string;
  hint?: string;
  options?: { value: string; label: string }[];
  mono?: boolean;
  /** Required for `isConfigured` to be true. */
  required?: boolean;
}

export interface IntegrationDef {
  id: IntegrationId;
  title: string;
  description: string;
  section: SettingsSection;
  fields: IntegrationField[];
  /** Read the current raw values out of state (strings only). */
  read: (state: HubState) => Record<string, string>;
  /** Return a new state with these values applied; unrelated fields preserved. */
  write: (state: HubState, values: Record<string, string>) => HubState;
  /** True when enough fields are filled to actually work. */
  isConfigured: (state: HubState) => boolean;
  /** Short status line shown in the overview and on the card. */
  describe: (state: HubState) => string;
  /** Extra target/derived line (path preview etc.). Receives the draft values. */
  target?: (state: HubState, values?: Record<string, string>) => string;
}

function filled(value?: string): boolean {
  return Boolean(value && value.trim());
}

export const INTEGRATIONS: IntegrationDef[] = [
  {
    id: 'oss',
    title: '阿里云 OSS',
    description: '存放 Obsidian Markdown 笔记库的 Bucket。笔记、附件与全量备份都基于它。',
    section: 'storage',
    fields: [
      { key: 'bucket', label: 'Bucket 名称', placeholder: '例如: my-obsidian-vault', mono: true, required: true },
      {
        key: 'endpoint',
        label: 'Endpoint（地域节点）',
        placeholder: 'oss-cn-hangzhou.aliyuncs.com',
        mono: true,
        required: true
      },
      {
        key: 'prefix',
        label: '同步目录前缀',
        placeholder: '留空即可，或填 vault/',
        hint: '留空会列出整个桶；填 vault/ 则只看该目录。',
        mono: true
      },
      { key: 'accessKeyId', label: 'AccessKey ID', placeholder: 'LTAI5t...', mono: true, required: true },
      { key: 'accessKeySecret', label: 'AccessKey Secret', type: 'password', placeholder: '••••••••••••', required: true }
    ],
    read: (s) => ({
      bucket: s.obsidianConfig.bucket,
      endpoint: s.obsidianConfig.endpoint,
      prefix: s.obsidianConfig.prefix,
      accessKeyId: s.obsidianConfig.accessKeyId,
      accessKeySecret: s.obsidianConfig.accessKeySecret
    }),
    write: (s, v) => ({
      ...s,
      obsidianConfig: {
        ...s.obsidianConfig,
        bucket: v.bucket ?? s.obsidianConfig.bucket,
        endpoint: v.endpoint ?? s.obsidianConfig.endpoint,
        prefix: v.prefix ?? s.obsidianConfig.prefix,
        accessKeyId: v.accessKeyId ?? s.obsidianConfig.accessKeyId,
        accessKeySecret: v.accessKeySecret ?? s.obsidianConfig.accessKeySecret,
        enabled: filled(v.bucket ?? s.obsidianConfig.bucket) && filled(v.accessKeyId ?? s.obsidianConfig.accessKeyId)
      }
    }),
    isConfigured: (s) =>
      Boolean(s.obsidianConfig.enabled && filled(s.obsidianConfig.bucket) && filled(s.obsidianConfig.accessKeyId)),
    describe: (s) => (s.obsidianConfig.bucket ? `${s.obsidianConfig.bucket} · 前缀「${s.obsidianConfig.prefix || '整桶'}」` : '未填写 Bucket'),
    target: (s) => (s.obsidianConfig.bucket ? `${s.obsidianConfig.bucket}.${s.obsidianConfig.endpoint}` : '')
  },

  {
    id: 'webdav',
    title: 'WebDAV 备份',
    description: '用 InfiniCLOUD / TeraCloud / Nextcloud 等网盘作为备份位置。多数服务器没有 CORS 头，需在扩展环境使用。',
    section: 'storage',
    fields: [
      { key: 'url', label: '服务器地址', placeholder: 'https://toi.teracloud.jp/dav/', mono: true, required: true },
      { key: 'username', label: '连接 ID / 用户名', placeholder: 'your-account-id', mono: true, required: true },
      { key: 'password', label: '应用密码', type: 'password', placeholder: 'app password', required: true },
      { key: 'pathPrefix', label: '目录（自动创建）', placeholder: 'selfhub_sync', mono: true }
    ],
    read: (s) => ({
      url: s.webdavConfig?.url || '',
      username: s.webdavConfig?.username || '',
      password: s.webdavConfig?.password || '',
      pathPrefix: s.webdavConfig?.pathPrefix || 'selfhub_sync'
    }),
    write: (s, v) => ({
      ...s,
      webdavConfig: {
        ...(s.webdavConfig || { enabled: false, url: '', username: '', password: '', pathPrefix: 'selfhub_sync' }),
        url: v.url ?? s.webdavConfig?.url ?? '',
        username: v.username ?? s.webdavConfig?.username ?? '',
        password: v.password ?? s.webdavConfig?.password ?? '',
        pathPrefix: v.pathPrefix ?? s.webdavConfig?.pathPrefix ?? 'selfhub_sync',
        enabled: filled(v.url ?? s.webdavConfig?.url) && filled(v.username ?? s.webdavConfig?.username)
      }
    }),
    isConfigured: (s) =>
      Boolean(s.webdavConfig?.enabled && filled(s.webdavConfig.url) && filled(s.webdavConfig.username) && filled(s.webdavConfig.password)),
    describe: (s) => (s.webdavConfig?.url ? s.webdavConfig.url : '未配置'),
    target: (_s, v) => {
      const url = (v?.url ?? '').replace(/\/+$/, '');
      const prefix = (v?.pathPrefix ?? '').replace(/^\/+|\/+$/g, '');
      return url ? `${url}/${prefix ? `${prefix}/` : ''}state.json` : '';
    }
  },

  {
    id: 'ai',
    title: 'AI 模型',
    description: '用于收件箱智能分拣与内容提炼。Key 只存在本机。',
    section: 'ai',
    fields: [
      {
        key: 'provider',
        label: '服务商',
        type: 'select',
        options: [
          { value: 'gemini', label: 'Google Gemini' },
          { value: 'deepseek', label: 'DeepSeek' },
          { value: 'openai', label: 'OpenAI' },
          { value: 'custom', label: '自定义 OpenAI 兼容端点' }
        ]
      },
      { key: 'apiKey', label: 'API Key', type: 'password', placeholder: 'AIzaSy... 或 sk-...', required: true },
      { key: 'baseUrl', label: 'Base URL（自定义端点时填写）', placeholder: 'https://api.example.com/v1', mono: true },
      { key: 'model', label: '模型名称', placeholder: 'gemini-2.5-flash / deepseek-chat', mono: true }
    ],
    read: (s) => ({
      provider: s.aiConfig.provider,
      apiKey: s.aiConfig.apiKey,
      baseUrl: s.aiConfig.baseUrl,
      model: s.aiConfig.model
    }),
    write: (s, v) => ({
      ...s,
      aiConfig: {
        ...s.aiConfig,
        provider: (v.provider as HubState['aiConfig']['provider']) ?? s.aiConfig.provider,
        apiKey: v.apiKey ?? s.aiConfig.apiKey,
        baseUrl: v.baseUrl ?? s.aiConfig.baseUrl,
        model: v.model ?? s.aiConfig.model
      }
    }),
    isConfigured: (s) => filled(s.aiConfig.apiKey),
    describe: (s) => (filled(s.aiConfig.apiKey) ? `${s.aiConfig.provider} · ${s.aiConfig.model || '默认模型'}` : '未填写 API Key')
  },

  {
    id: 'wucai',
    title: '五彩（Wucai）划词高亮',
    description: '填入 API Token 后可拉取划词高亮，并在「多平台数据互通」里检索。',
    section: 'content',
    fields: [{ key: 'token', label: 'API Token', type: 'password', placeholder: 'wc_pat_••••••••', required: true }],
    read: (s) => ({ token: s.wucaiConfig?.token || '' }),
    write: (s, v) => ({
      ...s,
      wucaiConfig: {
        ...(s.wucaiConfig || { enabled: false, token: '' }),
        token: v.token ?? s.wucaiConfig?.token ?? '',
        enabled: filled(v.token ?? s.wucaiConfig?.token)
      }
    }),
    isConfigured: (s) => filled(s.wucaiConfig?.token),
    describe: (s) => (filled(s.wucaiConfig?.token) ? '已填写 Token' : '未填写 Token')
  },

  {
    id: 'youdao',
    title: '有道云笔记',
    description: '可选：同步有道云笔记的标题与目录。',
    section: 'content',
    fields: [
      { key: 'token', label: '访问令牌', type: 'password', placeholder: '可选', required: false },
      { key: 'cookie', label: 'YNOTE_SKEY（可选）', type: 'password', placeholder: '可选' }
    ],
    read: (s) => ({ token: s.youdaoConfig?.token || '', cookie: s.youdaoConfig?.cookie || '' }),
    write: (s, v) => ({
      ...s,
      youdaoConfig: {
        ...(s.youdaoConfig || { enabled: false, token: '' }),
        token: v.token ?? s.youdaoConfig?.token ?? '',
        cookie: v.cookie ?? s.youdaoConfig?.cookie ?? '',
        enabled: filled(v.token ?? s.youdaoConfig?.token)
      }
    }),
    isConfigured: (s) => filled(s.youdaoConfig?.token),
    describe: (s) => (filled(s.youdaoConfig?.token) ? '已填写令牌' : '未配置')
  }
];

export function integrationById(id: IntegrationId): IntegrationDef | undefined {
  return INTEGRATIONS.find((i) => i.id === id);
}

/** Apply a partial value patch for one integration, returning the new state. */
export function applyIntegrationValues(
  state: HubState,
  id: IntegrationId,
  values: Record<string, string>
): HubState {
  const def = integrationById(id);
  if (!def) return state;
  return def.write(state, values);
}

