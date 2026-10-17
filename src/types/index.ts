export type ItemType = 'site' | 'server' | 'secret' | 'checkin' | 'note' | 'handwriting' | 'reminder';

export interface NavSite {
  id: string;
  title: string;
  url: string;
  category: string;
  description?: string;
  icon?: string;
  tags?: string[];
  pinned?: boolean;
  visitCount?: number;
  lastVisited?: number;
  expiresAt?: number; // Optional expiration (e.g. temporary promo link)
  createdAt: number;
}

export interface ServerDeployment {
  id: string;
  name: string;
  domain?: string;
  publicIp: string;
  internalIp?: string;
  port?: number;
  env: 'prod' | 'test' | 'dev';
  sshUser?: string;
  sshPort?: number;
  sshCommand?: string;
  deployPath?: string;
  healthUrl?: string;
  /** 'unknown' means "never probed" — the UI must not claim it is running. */
  status?: 'online' | 'offline' | 'checking' | 'unknown';
  /** Last probe result, shown on the card. */
  lastCheckedAt?: number;
  lastCheckMessage?: string;
  lastLatencyMs?: number;
  notes?: string;
  expiresAt?: number; // VPS expiration / renewal timestamp
  renewalCost?: string; // e.g. "¥199 / 年"
  createdAt: number;
}

export interface SecretItem {
  id: string;
  name: string;
  category: 'api_key' | 'ssh_key' | 'db_credential' | 'token' | 'other';
  encryptedValue: string; // Base64 ciphertext
  iv: string;
  salt: string;
  maskedPreview: string; // e.g. "sk-proj-••••••••4a9b"
  description?: string;
  tags?: string[];
  expiresAt?: number; // Expiration timestamp for API tokens / keys
  updatedAt: number;
}

export interface CheckInRun {
  /** Local date, YYYY-MM-DD. One entry per day. */
  date: string;
  /** Exact run timestamp. */
  at: number;
  status: 'success' | 'failed';
  message: string;
}

export interface CheckInTask {
  id: string;
  name: string;
  url: string;
  method: 'GET' | 'POST';
  type: 'http' | 'redirect';
  headers?: Record<string, string>;
  body?: string;
  lastRun?: number;
  lastStatus?: 'success' | 'failed' | 'pending';
  lastMessage?: string;
  /** Derived from `history`; kept for display compatibility. */
  streakDays?: number;
  /** Per-day run log (source of truth for the streak). */
  history?: CheckInRun[];
  createdAt: number;
}

export interface QuickNote {
  id: string;
  title: string;
  content: string; // Rich Markdown supported with code blocks & commands
  category?: string;
  tags?: string[];
  pinned?: boolean;
  updatedAt: number;
}

export interface ReminderItem {
  id: string;
  title: string;
  category: 'subscription' | 'server' | 'domain' | 'cert' | 'other';
  targetDate: number; // Expiration or renewal timestamp
  recurring?: 'monthly' | 'yearly' | 'weekly' | 'once';
  cost?: string; // e.g. "$20 / 月", "¥199 / 年"
  url?: string; // Renewal URL
  notes?: string;
  completed?: boolean;
  autoRollover?: boolean; // When true, automatically rolls over to next cycle upon expiration
  createdAt: number;
}

export interface HandwritingNote {
  id: string;
  title: string;
  dataUrl: string; // Base64 PNG image
  tags?: string[];
  createdAt: number;
}

export interface ObsidianConfig {
  enabled: boolean;
  bucket: string;
  endpoint: string; // e.g. oss-cn-hangzhou.aliyuncs.com
  region: string;
  accessKeyId: string;
  accessKeySecret: string;
  prefix: string; // e.g. "ObsidianVault/"
}

export interface ObsidianNote {
  key: string;
  title: string;
  path: string;
  size: number;
  lastModified: number;
  content?: string;
}

// 五彩划词笔记 (Wucai Highlight)
export interface WucaiHighlight {
  id: string;
  pageTitle: string;
  pageUrl: string;
  text: string;
  note?: string; // 个人批注思考
  color: 'yellow' | 'green' | 'blue' | 'purple' | 'red';
  tags?: string[];
  createdAt: number;
  updatedAt?: number;
}

export interface WucaiConfig {
  enabled: boolean;
  token: string; // 五彩个人访问令牌 OpenAPI Token
  lastSyncTime?: number;
}

// 有道云笔记 (Youdao Note)
export interface YoudaoNote {
  id: string;
  title: string;
  folder: string; // 目录路径
  content: string; // Markdown / 笔记文本
  size: number;
  updatedAt: number;
}

export interface YoudaoConfig {
  enabled: boolean;
  token: string;
  cookie?: string; // YNOTE_SKEY
  lastSyncTime?: number;
}

// 统一收件箱 (Inbox Item - N07)
export interface InboxItem {
  id: string;
  content: string;
  url?: string;
  title?: string;
  type: 'text' | 'url' | 'snippet';
  status: 'inbox' | 'processed' | 'archived';
  targetType?: 'note' | 'site' | 'project';
  targetId?: string;
  createdAt: number;
}

// 项目资料空间 (Project Workspace - N08)
export interface ProjectItem {
  id: string;
  name: string;
  description: string;
  status: 'active' | 'planning' | 'paused' | 'completed';
  repoUrl?: string;
  deployUrl?: string;
  tags?: string[];
  noteIds?: string[];      // Associated note IDs
  siteIds?: string[];      // Associated site IDs
  serverIds?: string[];    // Associated server IDs
  reminderIds?: string[];  // Associated reminder IDs
  decisions?: { date: number; title: string; note: string }[];
  createdAt: number;
  updatedAt: number;
}

// 网页划线与批注 (Web Highlighting & Annotation - R1/R2)
export interface WebPageAnnotation {
  id: string;
  pageUrl: string;
  pageTitle: string;
  text: string;
  note?: string;
  color: 'yellow' | 'green' | 'blue' | 'purple' | 'red';
  tags?: string[];
  anchor?: {
    prefix?: string;
    suffix?: string;
    startOffset?: number;
    endOffset?: number;
  };
  projectId?: string;
  createdAt: number;
  updatedAt: number;
}

// GoTab 替代：新标签页偏好设置 (R2)
export interface GoTabPreferences {
  searchEngine: 'google' | 'baidu' | 'bing' | 'github' | 'v2ex';
  wallpaperType: 'default' | 'minimal' | 'gradient' | 'custom';
  customWallpaperUrl?: string;
  showQuickNotes: boolean;
  showProjects: boolean;
  dockLayout: 'dense' | 'comfortable';
}

// 加密备份载荷格式 (N02, N03)
export interface EncryptedBackupPayload {
  schemaVersion: number;
  app: 'self-hub';
  encryptedData: string; // Base64 ciphertext
  iv: string;
  salt: string;
  createdAt: number;
  summary: {
    sitesCount: number;
    notesCount: number;
    secretsCount: number;
    projectsCount: number;
    inboxCount: number;
  };
}

export interface AiConfig {
  provider: 'gemini' | 'deepseek' | 'openai' | 'custom';
  apiKey: string;
  baseUrl: string;
  model: string;
}

export interface CloudflareSyncConfig {
  enabled: boolean;
  workerUrl: string; // e.g. https://api.example.com/sync
  syncKey: string;
  autoSync: boolean;
  lastSyncTime?: number;
}

export interface WebdavSyncConfig {
  enabled: boolean;
  /** e.g. https://toi.teracloud.jp/dav/ */
  url: string;
  username: string;
  password: string;
  /** Directory inside the WebDAV root for Self-Hub files. */
  pathPrefix: string;
  lastBackupAt?: number;
}

export type { FeatureFlags } from '../lib/features';

import type { FeatureFlags } from '../lib/features';

export interface HubState {
  schemaVersion?: number;
  theme: 'dark' | 'light';
  sites: NavSite[];
  servers: ServerDeployment[];
  secrets: SecretItem[];
  checkIns: CheckInTask[];
  reminders: ReminderItem[];
  notes: QuickNote[];
  handwritings: HandwritingNote[];
  inbox?: InboxItem[];
  projects?: ProjectItem[];
  annotations?: WebPageAnnotation[];
  gotabPrefs?: GoTabPreferences;
  obsidianConfig: ObsidianConfig;
  obsidianNotes?: ObsidianNote[];
  wucaiConfig?: WucaiConfig;
  wucaiHighlights?: WucaiHighlight[];
  youdaoConfig?: YoudaoConfig;
  youdaoNotes?: YoudaoNote[];
  aiConfig: AiConfig;
  cloudflareSync: CloudflareSyncConfig;
  webdavConfig: WebdavSyncConfig;
  /** Optional module switches (see lib/features.ts). */
  features?: Partial<FeatureFlags>;
  categories: string[];
}



