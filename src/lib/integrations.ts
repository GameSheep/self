/**
 * Integration registry — the single source of truth for every external connection.
 * Before this file, each integration had its own bespoke settings block, its own
 * mutable state in the modal, and its own "is it configured?" logic copy-pasted
 * · said "not configured". `write()` now only ever stores an enable flag the user
 */
import { HubState, ObsidianConfig } from '../types';

export type BaseIntegrationId = 'oss' | 'webdav' | 'ai' | 'wucai' | 'youdao';
/**
 * One card per configured OSS bucket: the first keeps the historical id `oss`, the rest carry
 * `oss:<connection id>`, so per-connection drafts, tests and saves do not collide.
 */
export type IntegrationId = BaseIntegrationId | `oss:${string}`;

/** A remote ability the app actually calls. Declared only when wired. */
export type IntegrationCapability =
  | 'listFiles'
  | 'readFile'
  | 'writeFile'
  | 'snapshotBackup'
  | 'cloudIngest'
  | 'sourceImport';

/**
 * What a *probe* is allowed to prove. Deliberately a smaller, weaker vocabulary
 * than `IntegrationCapability`: a listing request proves "can list", never
 * "can write".
 */
export type TestCapability = 'list' | 'read' | 'invoke';

/** Purposes a connection can be bound to (see `HubState.purposes`). */
export type IntegrationPurpose = 'backup' | 'remote-vault' | 'source-import' | 'cloud-ai' | 'note-source';

export interface IntegrationField {
  key: string;
  label: string;
  type?: 'text' | 'password' | 'select' | 'toggle';
  placeholder?: string;
  hint?: string;
  options?: { value: string; label: string }[];
  mono?: boolean;
  /** Required for the "fields are complete" fact. Not an enable switch. */
  required?: boolean;
  /** Shown in red under the control — used for privacy-relevant switches. */
  warning?: string;
}

export interface IntegrationDef {
  id: IntegrationId;
  title: string;
  description: string;
  fields: IntegrationField[];
  /** Read the current raw values out of state (strings only). */
  read: (state: HubState) => Record<string, string>;
  /**
   * Return a new state with these values applied; unrelated fields preserved.
   * Enable flags only change when the caller passes an explicit `enabled` value.
   */
  write: (state: HubState, values: Record<string, string>) => HubState;
  /** Short status line shown in the overview and on the card. */
  describe: (state: HubState) => string;
  /** Extra target/derived line (path preview etc.). Receives the draft values. */
  target?: (state: HubState, values?: Record<string, string>) => string;
  /**
   * What this connection can do once it is enabled and working. Empty for a
   * connection whose remote calls are not wired up: the UI must then say
   * 「当前不支持拉取」 instead of pretending.
   */
  capabilities: IntegrationCapability[];
  /** The purpose this connection is offered for; never inferred from fields. */
  purpose: IntegrationPurpose;
  /**
   * What a probe is allowed to prove. Kept narrower than `capabilities` on
   * purpose: a PROPFIND proves authentication, not write access, and the result
   * text must never claim more than the probe did.
   */
  testCapabilities: TestCapability[];
  /**
   * Fields that belong to the previous value of a select and must be cleared
   * when it changes (a leftover model name produces provider 400s).
   */
  resetOnChange?: Record<string, string[]>;
}

function filled(value?: string): boolean {
  return Boolean(value && value.trim());
}

/** Explicit switches only ever move when the caller passes a value. */
function applyToggle(raw: string | undefined, current: boolean): boolean {
  if (raw === undefined) return current;
  return raw === 'true';
}

const ENABLE_HINT = '填写字段不会自动启用连接：需要打开这个开关并点「保存连接」。';

export const INTEGRATIONS: IntegrationDef[] = [
  {
    id: 'oss',
    title: '阿里云 OSS',
    description: '存放 Obsidian Markdown 笔记库的 Bucket。笔记、附件与全量备份都基于它。',
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
      { key: 'accessKeySecret', label: 'AccessKey Secret', type: 'password', placeholder: '••••••••••••', required: true },
      {
        key: 'enabled',
        label: '启用这个连接',
        type: 'toggle',
        hint: ENABLE_HINT,
        warning: '开启后，笔记库读写与「整站备份」都会使用这个 Bucket。'
      }
    ],
    read: (s) => ({
      bucket: s.obsidianConfig.bucket,
      endpoint: s.obsidianConfig.endpoint,
      prefix: s.obsidianConfig.prefix,
      accessKeyId: s.obsidianConfig.accessKeyId,
      accessKeySecret: s.obsidianConfig.accessKeySecret,
      enabled: s.obsidianConfig.enabled ? 'true' : 'false'
    }),
    write: (s, v) => {
      const nextConfig: HubState['obsidianConfig'] = {
        ...s.obsidianConfig,
        bucket: v.bucket ?? s.obsidianConfig.bucket,
        endpoint: v.endpoint ?? s.obsidianConfig.endpoint,
        prefix: v.prefix ?? s.obsidianConfig.prefix,
        accessKeyId: v.accessKeyId ?? s.obsidianConfig.accessKeyId,
        accessKeySecret: v.accessKeySecret ?? s.obsidianConfig.accessKeySecret,
        // Previously `filled(bucket) && filled(accessKeyId)`: half a credential
        // pair switched the connection on. Now only the explicit switch does.
        enabled: applyToggle(v.enabled, s.obsidianConfig.enabled)
      };
      /**
       * Editing the active bucket must also update its entry in `obsidianConnections` — otherwise
       * the settings card and the 远端笔记 tabs would hold two different copies of the same bucket.
       */
      const list = s.obsidianConnections ?? [];
      return {
        ...s,
        obsidianConfig: nextConfig,
        obsidianConnections: list.map((entry) =>
          (nextConfig.id && entry.id === nextConfig.id) ||
          (!nextConfig.id && entry.bucket === s.obsidianConfig.bucket && entry.endpoint === s.obsidianConfig.endpoint)
            ? { ...entry, ...nextConfig }
            : entry
        )
      };
    },
    describe: (s) => (s.obsidianConfig.bucket ? `${s.obsidianConfig.bucket} · 前缀「${s.obsidianConfig.prefix || '整桶'}」` : '未填写 Bucket'),
    target: (s) => (s.obsidianConfig.bucket ? `${s.obsidianConfig.bucket}.${s.obsidianConfig.endpoint}` : ''),
    capabilities: ['listFiles', 'readFile', 'writeFile', 'snapshotBackup'],
    purpose: 'remote-vault',
    testCapabilities: ['list']
  },

  {
    id: 'webdav',
    title: 'WebDAV 备份',
    description: '用 InfiniCLOUD / TeraCloud / Nextcloud 等网盘作为备份位置。多数服务器没有 CORS 头，需在扩展环境使用。',
    fields: [
      { key: 'url', label: '服务器地址', placeholder: 'https://your-host.example.com/dav/', mono: true, required: true },
      { key: 'username', label: '连接 ID / 用户名', placeholder: 'your-account-id', mono: true, required: true },
      { key: 'password', label: '应用密码', type: 'password', placeholder: 'app password', required: true },
      { key: 'pathPrefix', label: '目录（自动创建）', placeholder: 'selfhub_sync', mono: true },
      {
        key: 'enabled',
        label: '启用这个连接',
        type: 'toggle',
        hint: ENABLE_HINT,
        warning: '开启后，整站备份会把本地数据写入这个网盘（快照里不含你的密码）。'
      }
    ],
    read: (s) => ({
      url: s.webdavConfig?.url || '',
      username: s.webdavConfig?.username || '',
      password: s.webdavConfig?.password || '',
      pathPrefix: s.webdavConfig?.pathPrefix || 'selfhub_sync',
      enabled: s.webdavConfig?.enabled ? 'true' : 'false'
    }),
    write: (s, v) => ({
      ...s,
      webdavConfig: {
        ...(s.webdavConfig || { enabled: false, url: '', username: '', password: '', pathPrefix: 'selfhub_sync' }),
        url: v.url ?? s.webdavConfig?.url ?? '',
        username: v.username ?? s.webdavConfig?.username ?? '',
        password: v.password ?? s.webdavConfig?.password ?? '',
        pathPrefix: v.pathPrefix ?? s.webdavConfig?.pathPrefix ?? 'selfhub_sync',
        // The bug this replaces: URL + username (no password yet) was enough to
        // set `enabled: true`, so a half-configured connection looked switched on.
        enabled: applyToggle(v.enabled, Boolean(s.webdavConfig?.enabled))
      }
    }),
    describe: (s) => (s.webdavConfig?.url ? s.webdavConfig.url : '未配置'),
    target: (_s, v) => {
      const url = (v?.url ?? '').replace(/\/+$/, '');
      const prefix = (v?.pathPrefix ?? '').replace(/^\/+|\/+$/g, '');
      return url ? `${url}/${prefix ? `${prefix}/` : ''}state.json` : '';
    },
    capabilities: ['snapshotBackup'],
    purpose: 'backup',
    testCapabilities: ['read']
  },

  {
    id: 'ai',
    title: 'AI 模型',
    description: '用于收件箱智能分拣与内容提炼。Key 只存在本机。',
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
        ],
        hint: '切换服务商时，属于上一个服务商的模型名与 Base URL 会被清空。'
      },
      { key: 'apiKey', label: 'API Key', type: 'password', placeholder: 'AIzaSy... 或 sk-...', required: true },
      { key: 'baseUrl', label: 'Base URL（自定义端点时填写）', placeholder: 'https://api.example.com/v1', mono: true },
      { key: 'model', label: '模型名称', placeholder: 'gemini-2.5-flash / deepseek-chat', mono: true },
      {
        key: 'cloudAiEnabled',
        label: '允许把内容发送到云端 AI',
        type: 'toggle',
        hint: '默认关闭。关闭时只用本机离线规则分拣，任何内容都不会离开这台设备。',
        warning:
          '开启后，你粘贴到「AI 智能分拣」的整段文字会发送到所选服务商。这类内容里常常包含 API Key、SSH 密码、数据库连接串——请确认你信任该服务商，并避免粘贴真实凭据。'
      }
    ],
    read: (s) => ({
      provider: s.aiConfig.provider,
      apiKey: s.aiConfig.apiKey,
      baseUrl: s.aiConfig.baseUrl,
      model: s.aiConfig.model,
      cloudAiEnabled: s.aiConfig.cloudAiEnabled === true ? 'true' : 'false'
    }),
    write: (s, v) => ({
      ...s,
      aiConfig: {
        ...s.aiConfig,
        provider: (v.provider as HubState['aiConfig']['provider']) ?? s.aiConfig.provider,
        apiKey: v.apiKey ?? s.aiConfig.apiKey,
        baseUrl: v.baseUrl ?? s.aiConfig.baseUrl,
        model: v.model ?? s.aiConfig.model,
        cloudAiEnabled: applyToggle(v.cloudAiEnabled, s.aiConfig.cloudAiEnabled === true)
      }
    }),
    describe: (s) => (filled(s.aiConfig.apiKey) ? `${s.aiConfig.provider} · ${s.aiConfig.model || '默认模型'}` : '未填写 API Key'),
    capabilities: ['cloudIngest'],
    purpose: 'cloud-ai',
    testCapabilities: ['invoke'],
    // A model name (and a pinned base URL) belong to one provider only: carrying
    // `deepseek-chat` over to Gemini is a guaranteed 400.
    resetOnChange: { provider: ['model', 'baseUrl'] }
  },

  {
    id: 'wucai',
    title: '五彩（Wucai）划词高亮',
    description:
      '填入 API Token 后可手工整理、编辑批注并转成 Obsidian Markdown。远端拉取尚未接通，因此不会显示「已同步」。',
    fields: [{ key: 'token', label: 'API Token', type: 'password', placeholder: 'wc_pat_••••••••', required: true }],
    read: (s) => ({ token: s.wucaiConfig?.token || '' }),
    write: (s, v) => ({
      ...s,
      wucaiConfig: {
        ...(s.wucaiConfig || { enabled: false, token: '' }),
        token: v.token ?? s.wucaiConfig?.token ?? '',
        enabled: applyToggle(v.enabled, Boolean(s.wucaiConfig?.enabled))
      }
    }),
    describe: (s) => (filled(s.wucaiConfig?.token) ? '已填写 Token' : '未填写 Token'),
    // No `sourceImport`: `fetchWucaiHighlights` exists but has no caller, so the
    // app cannot pull anything from Wucai today. Declaring it would be a lie.
    capabilities: [],
    purpose: 'source-import',
    testCapabilities: []
  },

  /**
   * 有道云笔记 is deliberately absent.
   *
   * The user asked to hide everything 有道-related: the settings card, the 远端笔记 tab and its
   * content are gone. The *data* (`youdaoConfig`, `youdaoNotes`) stays in the payload and in
   * exports — nothing is deleted, it is just no longer a surface in the app.
   */
];

export function integrationById(id: IntegrationId): IntegrationDef | undefined {
  const direct = INTEGRATIONS.find((i) => i.id === id);
  if (direct) return direct;
  // `oss:<connection id>` cards are generated per bucket; rebuilding the definition from the id
  // keeps `applyIntegrationValues` and the connection-status helpers working for them.
  if (typeof id === 'string' && id.startsWith('oss:')) {
    const connectionId = id.slice(4);
    return buildOssConnectionDef(
      {
        id: connectionId,
        label: '',
        enabled: false,
        bucket: '',
        endpoint: '',
        region: '',
        accessKeyId: '',
        accessKeySecret: '',
        prefix: ''
      },
      1
    );
  }
  return undefined;
}

/**
 * One card per configured OSS bucket.
 * The user's model: the connections pane holds 「阿里云 OSS」 cards, one per bucket, each with a
 * custom name; 远端笔记 then picks from the buckets already configured there. So the card has to
 */
export function buildOssConnectionDef(connection: ObsidianConfig, index: number): IntegrationDef {
  const id: IntegrationId = index === 0 ? 'oss' : `oss:${connection.id ?? String(index)}`;
  const base = INTEGRATIONS.find((i) => i.id === 'oss')!;
  const title = connection.label?.trim() || connection.bucket || `阿里云 OSS（桶 ${index + 1}）`;
  return {
    ...base,
    id,
    title,
    description: connection.bucket
      ? `桶 ${connection.bucket}${connection.prefix ? ` · 前缀 ${connection.prefix}` : ''}`
      : '一个新桶：填名称、Bucket 与密钥后保存。',
    fields: [
      {
        key: 'label',
        label: '名称（自定义）',
        placeholder: '例如：工作库 / 个人库',
        hint: '显示在这一页的卡片标题与远端笔记的标签上。',
        required: false
      },
      ...base.fields
    ],
    read: (s) => {
      const current = (s.obsidianConnections ?? [s.obsidianConfig])[index] ?? connection;
      return {
        label: current.label ?? '',
        bucket: current.bucket,
        endpoint: current.endpoint,
        prefix: current.prefix,
        accessKeyId: current.accessKeyId,
        accessKeySecret: current.accessKeySecret,
        enabled: current.enabled ? 'true' : 'false'
      };
    },
    write: (s, v) => {
      const list = s.obsidianConnections?.length ? s.obsidianConnections : [s.obsidianConfig];
      const current = list[index] ?? connection;
      const updated: ObsidianConfig = {
        ...current,
        label: v.label !== undefined ? v.label.trim() || undefined : current.label,
        bucket: v.bucket ?? current.bucket,
        endpoint: v.endpoint ?? current.endpoint,
        prefix: v.prefix ?? current.prefix,
        accessKeyId: v.accessKeyId ?? current.accessKeyId,
        accessKeySecret: v.accessKeySecret ?? current.accessKeySecret,
        enabled: applyToggle(v.enabled, current.enabled)
      };
      const nextList = list.map((entry, position) => (position === index ? updated : entry));
      // Keep the *active* config in sync when the edited card is the active bucket.
      const active =
        index === 0 ||
        (s.obsidianConfig.id && s.obsidianConfig.id === updated.id) ||
        (s.obsidianConfig.bucket === current.bucket && s.obsidianConfig.endpoint === current.endpoint);
      return {
        ...s,
        obsidianConnections: nextList,
        obsidianConfig: active ? updated : s.obsidianConfig
      };
    },
    describe: (s) => {
      const current = (s.obsidianConnections ?? [s.obsidianConfig])[index] ?? connection;
      return current.bucket ? `${current.bucket} · 前缀「${current.prefix || '整桶'}」` : '未填写 Bucket';
    },
    target: (s) => {
      const current = (s.obsidianConnections ?? [s.obsidianConfig])[index] ?? connection;
      return current.bucket ? `${current.bucket}.${current.endpoint}` : '';
    }
  };
}

/** Cards for every configured bucket, ready to render in place of the single OSS card. */
export function ossConnectionDefs(state: HubState): IntegrationDef[] {
  const list = state.obsidianConnections?.length ? state.obsidianConnections : [state.obsidianConfig];
  return list.map((connection, index) => buildOssConnectionDef(connection, index));
}

/** Apply a partial value patch for one integration, returning the new state. */
export function applyIntegrationValues(
  state: HubState,
  id: IntegrationId,
  values: Record<string, string>
): HubState {
  /**
   * OSS cards are generated per bucket, so they must be resolved **against this state**: the
   * static registry lookup would write the shared `obsidianConfig` while the card re-reads its own
   * `obsidianConnections[index]` entry — which is exactly how "保存未生效，请重试" appeared.
   */
  if (id === 'oss' || (typeof id === 'string' && id.startsWith('oss:'))) {
    const list = state.obsidianConnections?.length ? state.obsidianConnections : [state.obsidianConfig];
    const index = id === 'oss' ? 0 : list.findIndex((connection) => connection.id === id.slice(4));
    const connection = list[index];
    if (!connection) return state;
    return buildOssConnectionDef(connection, index).write(state, values);
  }
  const def = integrationById(id);
  if (!def) return state;
  return def.write(state, values);
}
