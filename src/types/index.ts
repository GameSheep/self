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
  /**
   * Explicit display order inside a category. Absent means "keep array order",
   * which is how the previous build behaved; reordering writes real numbers so a
   * refresh cannot shuffle the grid back.
   */
  order?: number;
}

export interface ServerDeployment {
  id: string;
  name: string;
  /**
   * Free-form grouping label ("所属网站/项目"), e.g. `官网` or `api.example.com`.
   *
   * One website often spans several hosts (web + db + cdn); the servers list groups by
   * this so they read as one unit. Not unique, not required — ungrouped servers render
   * under 「未分组」.
   */
  group?: string;
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
  /**
   * Free-form label/value pairs: SSH tunnels, panel URLs, renewal dates, accounts…
   *
   * Deliberately unbounded and allowed to repeat what lives elsewhere — the user asked for a
   * place to *store* things without a modelling debate ("不怕重复，不担心每个地方都存一份").
   */
  extras?: Array<{ id: string; label: string; value: string }>;
  expiresAt?: number; // VPS expiration / renewal timestamp
  renewalCost?: string; // e.g. "¥199 / 年"
  createdAt: number;
}

/**
 * One name/value pair inside a multi-field credential.
 *
 * A real credential is rarely a single string: an OSS/Aliyun pair is AccessKeyId +
 * AccessKeySecret, a DB login is host + user + password. Each field is encrypted
 * independently so revealing one never exposes the others.
 */
export interface SecretField {
  /** Free-form label, e.g. `Access Key ID`, `Secret`, `密码`. */
  label: string;
  encryptedValue: string;
  iv: string;
  salt: string;
  maskedPreview: string;
}

export interface SecretItem {
  id: string;
  name: string;
  category: 'api_key' | 'ssh_key' | 'db_credential' | 'token' | 'other';
  /**
   * The site this credential belongs to (e.g. `github.com`).
   *
   * One site can legitimately hold several credentials (a read-only token and an admin token, an
   * old and a new key), so this is deliberately **not** unique: the vault groups by it.
   */
  website?: string;
  encryptedValue: string; // Base64 ciphertext
  iv: string;
  salt: string;
  maskedPreview: string; // e.g. "sk-proj-••••••••4a9b"
/**
 * Multi-field credential set (key + secret together in one entry).
 * Optional for backward compatibility: entries created before this field existed hold a
 */
  fields?: SecretField[];
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
  /** What the run did. Optional so history written by older versions still loads. */
  outcome?: CheckInOutcome;
}

/** `never` = nothing recorded yet; `opened_page` is explicitly not a success. */
export type CheckInOutcome = 'never' | 'http_success' | 'http_failure' | 'opened_page';

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
  /**
   * Whether the task may run automatically. Defaults to false and is never
   * implied by filling in a URL: an outbound request to a third party is an
   * action the user has to switch on.
   */
  enabled?: boolean;
  /**
   * What the last run actually did. "打开页面" is recorded here and is *not* a
   * success — the app cannot know whether the target counted it.
   */
  lastOutcome?: CheckInOutcome;
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
  /**
   * Folder path, `/`-separated, e.g. `工作/项目A`. Empty/absent means the root.
   *
   * A path (not a parent id) so nesting is expressible without a second entity, and moving a note
   * is one string change.
   */
  folder?: string;
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
  /**
   * Day-of-month the cycle is anchored to (1–31), captured when the reminder is
   * created or first renewed. Renewing 1 月 31 日 must land on 2 月 28/29 日 and
   * then return to 31, which `setMonth(+1)` alone cannot express.
   */
  anchorDay?: number;
  /**
   * 0-based month the yearly cycle is anchored to (0–11), captured together with
   * `anchorDay`. Without it, a 2 月 29 日 series clamped to 2 月 28 日 in a
   * non-leap year could never climb back to 2 月 29 日 in the next leap year.
   */
  anchorMonth?: number;
  /**
   * One record per handled occurrence. "完成本次" and "续期" both append here, so
   * retrying the same occurrence cannot advance the date twice.
   */
  occurrences?: ReminderOccurrence[];
  cost?: string; // e.g. "$20 / 月", "¥199 / 年"
  url?: string; // Renewal URL
  notes?: string;
  completed?: boolean;
  /** When the current occurrence was marked done (mirrors the `occurrences` entry). */
  completedAt?: number;
  autoRollover?: boolean; // When true, automatically rolls over to next cycle upon expiration
  createdAt: number;
}

export interface ReminderOccurrence {
  /** The due date this record refers to (local midnight timestamp). */
  dueAt: number;
  /** When the user acted. */
  at: number;
  action: 'completed' | 'renewed' | 'skipped';
  /** The due date that resulted from a renewal. */
  nextDueAt?: number;
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
  /**
   * Display name for the tab. One OSS/S3 bucket = one tab, so a user with several vaults can
   * tell them apart. `obsidianConfig` above stays the *active* connection (the one the tree and
   * the backup read), so the rest of the app keeps working unchanged.
   */
  label?: string;
  /** Stable id of this connection inside `obsidianConnections`. */
  id?: string;
  /**
   * Whether this bucket has a tab in 远端笔记.
   *
   * Configuring a bucket and *showing* it are two decisions: the connections pane owns the first,
   * and 远端笔记's 「加桶」 just picks an already-configured bucket (so a bucket can exist without
   * being on screen). Undefined means shown.
   */
  showInNotes?: boolean;
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
  /**
   * Idempotency key for the capture that produced this entry. Retrying the same
   * logical submission (double click, reload mid-request) must not create a
   * second copy, so the writer looks up the key before inserting.
   */
  operationId?: string;
  /** Where the text came from: home 快速记录, extension, 收件箱 手动新增. */
  source?: 'home' | 'inbox' | 'extension' | 'ai';
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
  /**
   * Associated credential ids. Only references are stored: the vault value is
   * never decrypted for a project view or for search, and while the vault is
   * locked the UI shows the name plus "需解锁".
   */
  secretIds?: string[];
  decisions?: { date: number; title: string; note: string }[];
  createdAt: number;
  updatedAt: number;
}

/**
 * 域名 (own record, not a projection over reminders).
 *
 * Every field is optional except the name: a user who only knows "example.com expires in March"
 * should still be able to store it, without inventing a registrar or nameservers.
 */
export interface DomainRecord {
  id: string;
  /** The domain itself, e.g. `example.com`. */
  name: string;
  /** When it was bought / started. */
  startAt?: number;
  /** Renewal / expiry date. */
  expireAt?: number;
  /** Where it was bought (registrar). */
  registrar?: string;
  /** Nameservers or a short DNS summary; optional on purpose. */
  dns?: string;
  /** Renewal / management URL. */
  url?: string;
  note?: string;
  createdAt: number;
  updatedAt?: number;
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

export interface AiConfig {
  provider: 'gemini' | 'deepseek' | 'openai' | 'custom';
  /**
   * Must be explicitly enabled before any content is sent to a third-party model.
   * Pasted text often contains API keys, so the default is local-only parsing.
   */
  cloudAiEnabled?: boolean;
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
  /** e.g. https://your-host.example.com/dav/ */
  url: string;
  username: string;
  password: string;
  /** Directory inside the WebDAV root for Self-Hub files. */
  pathPrefix: string;
  lastBackupAt?: number;
}

/**
 * Result of one user-initiated connection test.
 * Separate from "the fields are filled" and from "the background task is on",
 * exact configuration that was probed: editing the URL or key must invalidate a
 */
export interface ConnectionTestRecord {
  at: number;
  ok: boolean;
  message: string;
  /** Hash of the tested config version. Never derived from secret plaintext. */
  fingerprint: string;
  /** What the test actually proved, e.g. ['read', 'write']. */
  capabilities?: string[];
  environment?: 'web' | 'extension';
}

export type { FeatureFlags } from '../lib/features';
export type { BackupPolicy } from '../lib/backupPolicy';
export type { HomeBlockPreference, HomeBlockId } from '../domain/home';

/**
 * The new-tab page's own preferences, carried inside the hub state so backups include them.
 *
 * `layout` is the dashboard engine's own structure (column ratios, module order, per-module
 * height and data source). The workbench stores it verbatim and never interprets it: the
 * engine in `extension/newtab-dashboard.js` validates and normalises whatever it reads back.
 */
export interface NewtabPreferences {
  layout?: Record<string, unknown>;
  /** Site ids the user starred on the new tab (its 常用网站 module). */
  pins?: string[];
}

import type { FeatureFlags } from '../lib/features';
import type { BackupPolicy } from '../lib/backupPolicy';
import type { HomeBlockPreference } from '../domain/home';

export interface HubState {
  schemaVersion?: number;
  theme: 'dark' | 'light';
  sites: NavSite[];
  servers: ServerDeployment[];
  secrets: SecretItem[];
  /**
   * Domains, as their own records.
   *
   * They used to be a projection over 提醒 (a reminder with `category: 'domain'`), which is why
   * clicking 域名 could land on the reminders page. A domain carries facts a reminder has no
   * place for: when it was bought, from whom, and its nameservers.
   */
  domains?: DomainRecord[];
  checkIns: CheckInTask[];
  reminders: ReminderItem[];
  notes: QuickNote[];
  /** Folder paths for 笔记 that exist but may hold no note yet (e.g. `工作/项目A`). */
  noteFolders?: string[];
  handwritings: HandwritingNote[];
  inbox?: InboxItem[];
  projects?: ProjectItem[];
  annotations?: WebPageAnnotation[];
  gotabPrefs?: GoTabPreferences;
  obsidianConfig: ObsidianConfig;
  /**
   * Every OSS/S3 vault the user has configured. `obsidianConfig` is the active one; switching a
   * tab swaps which entry is active, so browsing code keeps reading a single config.
   */
  obsidianConnections?: ObsidianConfig[];
  obsidianNotes?: ObsidianNote[];
  wucaiConfig?: WucaiConfig;
  wucaiHighlights?: WucaiHighlight[];
  youdaoConfig?: YoudaoConfig;
  youdaoNotes?: YoudaoNote[];
  aiConfig: AiConfig;
  cloudflareSync: CloudflareSyncConfig;
  webdavConfig: WebdavSyncConfig;
  /**
   * Where the whole-state snapshot goes, and whether the automatic task runs.
   * Separate from the connection fields on purpose: filling in a URL must never
   * start a background task (see lib/backupPolicy.ts).
   */
  backupPolicy?: BackupPolicy;
  /**
   * Home page layout: block order, collapsed and hidden state. A preference, so
   * hiding a block never disables the feature behind it.
   */
  homeBlocks?: HomeBlockPreference[];
/**
 * New-tab page preferences: the module dashboard's layout and the sites the user
 * starred there.
 * These two live in `chrome.storage.local` because the new tab is a separate
 * · extension page and is their only writer — the workbench never authors them.
 */
  newtabPreferences?: NewtabPreferences;
  /**
   * Last connection test per integration id, bound to the tested config version.
   * Absent means "never tested" — which is not the same as "configured".
   */
  connectionTests?: Record<string, ConnectionTestRecord>;
  /**
   * Purpose enablement, keyed by purpose id (`backup`, `remote-vault`,
   * `source-import`, `cloud-ai`). Filling in a connection's fields must never
   * flip one of these: they are separate, explicit decisions.
   */
  purposes?: Record<string, boolean>;
  /**
   * Ids created by the explicit 「体验示例」 action, so the batch can be removed
   * without touching anything the user made (see src/domain/sampleData.ts).
   */
  sampleBatch?: string[];
  /** Optional module switches (see lib/features.ts). */
  features?: Partial<FeatureFlags>;
  categories: string[];
}

