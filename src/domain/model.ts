/**
 * v3 domain model (P2-01).
 * This is the model described in docs/SELF_HUB_DEVELOPMENT.md §6. It is
 * deliberately separate from `src/types/index.ts`: the v2 `HubState` is the
 * · *current* on-disk format and must keep working untouched while P2 is built
 */

/** Model version written into every v3 record set. */
export const MODEL_VERSION = 3;

export type ItemKind = 'note' | 'webpage' | 'drawing' | 'attachment' | 'bookmark';

export type LocalDate = string; // YYYY-MM-DD in the user's timezone

export interface LibraryScoped {
  libraryId: string;
  id: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
  /** Soft delete. Absent means live. */
  deletedAt?: number;
}

/** Unified list/filter/reference row for every library item. */
export interface ItemMeta extends LibraryScoped {
  kind: ItemKind;
  title: string;
  tags: string[];
  projectIds: string[];
  /** Where the item came from, e.g. { type: 'oss', key } or { type: 'wucai', id }. */
  sourceRef?: { type: string; id?: string; key?: string };
  /** Title/filename of the origin, shown in the list without loading a body. */
  sourceTitle?: string;
}

export interface NoteBody {
  libraryId: string;
  itemId: string;
  markdown: string;
  revision: number;
  updatedAt: number;
}

export interface Bookmark {
  libraryId: string;
  itemId: string;
  url: string;
  groupId?: string;
  position?: number;
  pinned?: boolean;
  visitCount?: number;
  lastVisited?: number;
}

export interface WebPage {
  libraryId: string;
  itemId: string;
  canonicalUrl: string;
  originalUrl: string;
  pageTitle: string;
  capturedAt: number;
  snapshotAttachmentId?: string;
}

export type AnchorState = 'attached' | 'ambiguous' | 'orphaned';

export interface Annotation {
  libraryId: string;
  id: string;
  pageItemId: string;
  /** The quoted原文, kept verbatim even when the anchor cannot be resolved. */
  quote: string;
  /** The user's own comment, kept separate from the quote. */
  comment?: string;
  color: string;
  tags: string[];
  anchor?: {
    prefix?: string;
    suffix?: string;
    startOffset?: number;
    endOffset?: number;
  };
  anchorState: AnchorState;
  revision: number;
  createdAt: number;
  updatedAt: number;
  deletedAt?: number;
}

export type InboxStatus = 'inbox' | 'processed' | 'archived';

export interface InboxEntry {
  libraryId: string;
  id: string;
  rawText: string;
  url?: string;
  status: InboxStatus;
  /** Where the conversion landed, so a repeat opens it instead of re-creating. */
  resultRefs: Array<{ type: 'note' | 'bookmark' | 'project'; id: string; at: number }>;
  /** Idempotency key for the capture that produced this entry. */
  operationId: string;
  source: 'home' | 'inbox' | 'extension' | 'ai';
  createdAt: number;
  updatedAt: number;
  deletedAt?: number;
}

export interface EntityLink {
  libraryId: string;
  id: string;
  fromType: string;
  fromId: string;
  toType: string;
  toId: string;
  relation: string;
  createdAt: number;
}

export interface Project extends LibraryScoped {
  name: string;
  description: string;
  status: 'active' | 'planning' | 'paused' | 'completed';
  repoUrl?: string;
  deployUrl?: string;
  decisions: Array<{ date: number; title: string; note: string }>;
}

export interface Server extends LibraryScoped {
  name: string;
  env: 'prod' | 'test' | 'dev';
  addresses: { publicIp?: string; internalIp?: string; domain?: string; port?: number };
  sshOptions?: { user?: string; port?: number; command?: string };
  healthUrl?: string;
  lastProbe?: {
    observedAt: number;
    latencyMs?: number;
    outcome: 'unknown' | 'online' | 'offline';
    safeMessage?: string;
  };
  expiresOn?: LocalDate;
  timezone?: string;
  notes?: string;
}

export interface ResourceAsset extends LibraryScoped {
  kind: 'domain' | 'subscription' | 'cert';
  name: string;
  provider?: string;
  managementUrl?: string;
  expiresOn?: LocalDate;
  timezone?: string;
  cost?: string;
}

export interface Credential extends LibraryScoped {
  name: string;
  category: 'api_key' | 'ssh_key' | 'db_credential' | 'token' | 'other';
  /** Existing AES-GCM envelope; P1/P2 never re-encrypt without a migration. */
  encryptedValue: string;
  iv: string;
  salt: string;
  cryptoVersion: number;
  maskedPreview: string;
  expiresOn?: LocalDate;
}

/**
 * 域名 in the v3 library.
 *
 * Only `name` is required — a domain whose registrar or nameservers are unknown is still a
 * domain worth remembering before it expires.
 */
export interface DomainRow extends LibraryScoped {
  name: string;
  registrar?: string;
  dns?: string;
  url?: string;
  note?: string;
  startAt?: number;
  expireAt?: number;
}

export interface Reminder extends LibraryScoped {
  title: string;  /** Local date the reminder is anchored to; the instant is derived from it. */
  dueOn: LocalDate;
  timezone: string;
  recurrence: 'monthly' | 'yearly' | 'weekly' | 'once';
  anchorDay?: number;
  status: 'open' | 'completed' | 'paused';
  resourceRef?: { type: string; id: string };
  occurrences: Array<{ dueOn: LocalDate; at: number; action: 'completed' | 'renewed' | 'skipped'; nextDueOn?: LocalDate }>;
}

export interface CheckInTask extends LibraryScoped {
  name: string;
  targetUrl: string;
  method: 'GET' | 'POST';
  executionMode: 'http' | 'open_page';
  /** Credential id, never an inline Authorization value. */
  secretRef?: string;
  schedulePolicy?: { enabled: boolean; kind: 'daily' | 'weekly' | 'interval'; at?: string; everyMinutes?: number };
}

export interface CheckInRun {
  libraryId: string;
  id: string;
  taskId: string;
  scheduledFor?: number;
  startedAt: number;
  finishedAt?: number;
  outcome: 'never' | 'http_success' | 'http_failure' | 'opened_page';
  safeMessage?: string;
}

export interface AttachmentMeta {
  libraryId: string;
  id: string;
  itemId: string;
  name: string;
  mime: string;
  size: number;
  hash?: string;
  location: 'local' | 'remote';
  localBlobId?: string;
  remoteRef?: string;
  availability: 'available' | 'missing' | 'not-downloaded';
}

export interface RemoteDocument {
  libraryId: string;
  id: string;
  connectionId: string;
  key: string;
  etag?: string;
  modifiedAt?: number;
  size?: number;
  cachedBodyRef?: string;
  cacheState: 'not-cached' | 'cached' | 'stale';
}

export interface Connection {
  libraryId: string;
  id: string;
  provider: string;
  displayName: string;
  /** Non-sensitive configuration only. */
  publicConfig: Record<string, string>;
  credentialRef?: string;
  configVersion: number;
  verification?: {
    at: number;
    ok: boolean;
    message: string;
    fingerprint: string;
    /**
     * The `configVersion` that was probed.
     *
     * §8.2: a test result is bound to a configuration version, and editing the
     * address, key or path immediately makes it "待测试" again. Storing the
     * version here is what makes that check structural instead of a promise.
     */
    configVersion?: number;
    capabilities?: string[];
    environment?: 'web' | 'extension';
  };
}

export interface ConnectionCredential {
  libraryId: string;
  id: string;
  encryptedEnvelope: string;
  iv: string;
  salt: string;
  keyMode: 'master' | 'device';
  cryptoVersion: number;
  updatedAt: number;
}

export type PurposeId = 'backup' | 'remote-vault' | 'source-import' | 'cloud-ai';

export interface PurposeBinding {
  libraryId: string;
  id: string;
  purpose: PurposeId;
  connectionId: string;
  enabled: boolean;
  options: Record<string, string>;
  configVersion: number;
}

export type JobState = 'queued' | 'running' | 'succeeded' | 'failed' | 'conflict' | 'cancelled' | 'waiting-unlock';

export interface Preferences {
  libraryId: string;
  homeBlocks: Array<{ id: string; hidden?: boolean; collapsed?: boolean }>;
  navPins: string[];
  theme: 'dark' | 'light' | 'system';
  density: 'comfortable' | 'compact';
  searchEngines: string[];
  onboardingVersion: number;
}

export interface MigrationReport {
  libraryId: string;
  id: string;
  from: string;
  to: string;
  phase: string;
  counts: Record<string, number>;
  conflicts: Array<{ kind: string; detail: string }>;
  unknownFields: string[];
  mappingRef?: string;
  checkpoint?: string;
  createdAt: number;
}
