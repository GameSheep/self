/**
 * v3 IndexedDB schema (P2-01) — docs/SELF_HUB_DEVELOPMENT.md §6.4.
 *
 * The database keeps its name (`self_hub_idb`) and moves from version 1 to 2.
 * Every new store is suffixed `_v3` and lives *beside* the old mirror stores
 * (`notes`, `sites`, …) rather than replacing them: the old stores stay readable
 * during the migration window, and a half-finished migration cannot corrupt the
 * records the running app still reads. They are dropped in a later, deliberate
 * step (§13.4), not as a side effect of this upgrade.
 *
 * Key design that everything else depends on (§6.1):
 *   business store PK = ['libraryId', 'id']        (bodies: ['libraryId','itemId'])
 *   device/migration stores PK = 'key' or 'id'     (not library-scoped)
 *
 * Runtime validation lives here too, because §6.4 requires it: "导入和查询在
 * 运行时做 schema 校验，不能只靠 TypeScript 类型断言". A backup file or an
 * extension message is untrusted input even when it looks like our own data.
 */

/** Which key shape a store uses. */
export type KeyShape = 'library-scoped' | 'body' | 'plain';

export interface IndexDef {
  name: string;
  keyPath: string | string[];
  unique?: boolean;
  multiEntry?: boolean;
}

export interface StoreDef {
  name: string;
  keyPath: string | string[];
  keyShape: KeyShape;
  indexes: IndexDef[];
  /**
   * Required top-level keys. Used by the runtime validator; `libraryId` is
   * checked separately because it is structural, not data.
   */
  required: string[];
  /** Keys whose value must be an array of strings when present. */
  stringArrays?: string[];
  /** Keys whose value must be a finite number when present. */
  numbers?: string[];
}

const LIBRARY_AND_ID = ['libraryId', 'id'];

export const V3_STORES: StoreDef[] = [
  {
    name: 'items_v3',
    keyPath: LIBRARY_AND_ID,
    keyShape: 'library-scoped',
    required: ['libraryId', 'id', 'kind', 'title', 'revision', 'createdAt', 'updatedAt'],
    stringArrays: ['tags', 'projectIds'],
    numbers: ['revision', 'createdAt', 'updatedAt'],
    indexes: [
      { name: 'kind_updatedAt', keyPath: ['kind', 'updatedAt'] },
      { name: 'libraryId_updatedAt', keyPath: ['libraryId', 'updatedAt'] },
      { name: 'sourceRef', keyPath: ['libraryId', 'sourceRef.type'] },
      { name: 'tags', keyPath: 'tags', multiEntry: true },
      { name: 'projectIds', keyPath: 'projectIds', multiEntry: true }
    ]
  },
  {
    name: 'note_bodies_v3',
    keyPath: ['libraryId', 'itemId'],
    keyShape: 'body',
    required: ['libraryId', 'itemId', 'markdown', 'revision'],
    numbers: ['revision'],
    indexes: [{ name: 'libraryId_revision', keyPath: ['libraryId', 'revision'] }]
  },
  {
    name: 'bookmarks_v3',
    keyPath: ['libraryId', 'itemId'],
    keyShape: 'body',
    required: ['libraryId', 'itemId', 'url'],
    numbers: ['position', 'visitCount', 'lastVisited'],
    indexes: [
      { name: 'groupId_position', keyPath: ['libraryId', 'groupId', 'position'] },
      { name: 'url', keyPath: ['libraryId', 'url'] }
    ]
  },
  {
    name: 'webpages_v3',
    keyPath: ['libraryId', 'itemId'],
    keyShape: 'body',
    required: ['libraryId', 'itemId', 'canonicalUrl', 'originalUrl', 'pageTitle', 'capturedAt'],
    numbers: ['capturedAt'],
    indexes: [
      { name: 'canonicalUrl', keyPath: ['libraryId', 'canonicalUrl'] },
      { name: 'capturedAt', keyPath: ['libraryId', 'capturedAt'] }
    ]
  },
  {
    name: 'annotations_v3',
    keyPath: LIBRARY_AND_ID,
    keyShape: 'library-scoped',
    required: ['libraryId', 'id', 'pageItemId', 'quote', 'anchorState', 'revision', 'createdAt', 'updatedAt'],
    stringArrays: ['tags'],
    numbers: ['revision', 'createdAt', 'updatedAt'],
    indexes: [
      { name: 'pageItemId', keyPath: ['libraryId', 'pageItemId'] },
      { name: 'updatedAt', keyPath: ['libraryId', 'updatedAt'] }
    ]
  },
  {
    name: 'inbox_v3',
    keyPath: LIBRARY_AND_ID,
    keyShape: 'library-scoped',
    required: ['libraryId', 'id', 'rawText', 'status', 'operationId', 'createdAt', 'updatedAt'],
    numbers: ['createdAt', 'updatedAt'],
    indexes: [
      { name: 'status_createdAt', keyPath: ['libraryId', 'status', 'createdAt'] },
      // Idempotency: a repeated capture must find its entry instead of adding one.
      { name: 'operationId', keyPath: ['libraryId', 'operationId'], unique: true }
    ]
  },
  {
    name: 'projects_v3',
    keyPath: LIBRARY_AND_ID,
    keyShape: 'library-scoped',
    required: ['libraryId', 'id', 'name', 'status', 'revision', 'createdAt', 'updatedAt'],
    numbers: ['revision', 'createdAt', 'updatedAt'],
    indexes: [{ name: 'status_updatedAt', keyPath: ['libraryId', 'status', 'updatedAt'] }]
  },
  {
    name: 'entity_links_v3',
    keyPath: LIBRARY_AND_ID,
    keyShape: 'library-scoped',
    required: ['libraryId', 'id', 'fromType', 'fromId', 'toType', 'toId', 'relation'],
    numbers: ['createdAt'],
    indexes: [
      { name: 'from', keyPath: ['libraryId', 'fromType', 'fromId'] },
      { name: 'to', keyPath: ['libraryId', 'toType', 'toId'] },
      // §6.4: "EntityLink 的组合唯一键" — one link per (from,to,relation).
      { name: 'unique_link', keyPath: ['libraryId', 'fromType', 'fromId', 'toType', 'toId', 'relation'], unique: true }
    ]
  },
  {
    name: 'servers_v3',
    keyPath: LIBRARY_AND_ID,
    keyShape: 'library-scoped',
    required: ['libraryId', 'id', 'name', 'env', 'revision', 'createdAt', 'updatedAt'],
    numbers: ['revision', 'createdAt', 'updatedAt'],
    indexes: [{ name: 'env_name', keyPath: ['libraryId', 'env', 'name'] }]
  },
  {
    name: 'resource_assets_v3',
    keyPath: LIBRARY_AND_ID,
    keyShape: 'library-scoped',
    required: ['libraryId', 'id', 'kind', 'name', 'revision', 'createdAt', 'updatedAt'],
    numbers: ['revision', 'createdAt', 'updatedAt'],
    indexes: [
      { name: 'kind_expiresOn', keyPath: ['libraryId', 'kind', 'expiresOn'] },
      { name: 'expiresOn', keyPath: ['libraryId', 'expiresOn'] }
    ]
  },
  {
    name: 'credentials_v3',
    keyPath: LIBRARY_AND_ID,
    keyShape: 'library-scoped',
    required: ['libraryId', 'id', 'name', 'category', 'encryptedValue', 'iv', 'salt', 'revision'],
    numbers: ['revision', 'cryptoVersion'],
    indexes: [
      { name: 'category_name', keyPath: ['libraryId', 'category', 'name'] },
      { name: 'expiresOn', keyPath: ['libraryId', 'expiresOn'] }
    ]
  },
  {
    name: 'reminders_v3',
    keyPath: LIBRARY_AND_ID,
    keyShape: 'library-scoped',
    required: ['libraryId', 'id', 'title', 'dueOn', 'timezone', 'recurrence', 'status', 'revision'],
    numbers: ['revision', 'createdAt', 'updatedAt'],
    indexes: [
      // §6.4: dueOn + status, so the three groups are one index scan.
      { name: 'dueOn_status', keyPath: ['libraryId', 'dueOn', 'status'] },
      { name: 'resourceRef', keyPath: ['libraryId', 'resourceRef.id'] }
    ]
  },
  {
    name: 'checkins_v3',
    keyPath: LIBRARY_AND_ID,
    keyShape: 'library-scoped',
    required: ['libraryId', 'id', 'name', 'targetUrl', 'method', 'executionMode', 'revision'],
    numbers: ['revision', 'createdAt', 'updatedAt'],
    indexes: [{ name: 'enabled', keyPath: ['libraryId', 'schedulePolicy.enabled'] }]
  },
  {
    // 域名 became its own collection (not a projection over reminders). Only the name is
    // required: a user who just knows the expiry date must still be able to store the domain.
    name: 'domains_v3',
    keyPath: LIBRARY_AND_ID,
    keyShape: 'library-scoped',
    required: ['libraryId', 'id', 'name', 'revision'],
    numbers: ['revision', 'createdAt', 'updatedAt', 'startAt', 'expireAt'],
    indexes: [{ name: 'expireAt', keyPath: ['libraryId', 'expireAt'] }]
  },
  {
    name: 'checkin_runs_v3',
    keyPath: LIBRARY_AND_ID,
    keyShape: 'library-scoped',
    required: ['libraryId', 'id', 'taskId', 'startedAt', 'outcome'],
    numbers: ['startedAt', 'finishedAt', 'scheduledFor'],
    indexes: [{ name: 'task_startedAt', keyPath: ['libraryId', 'taskId', 'startedAt'] }]
  },
  {
    name: 'attachments_v3',
    keyPath: LIBRARY_AND_ID,
    keyShape: 'library-scoped',
    required: ['libraryId', 'id', 'itemId', 'name', 'mime', 'size', 'location', 'availability'],
    numbers: ['size'],
    indexes: [
      { name: 'itemId', keyPath: ['libraryId', 'itemId'] },
      { name: 'availability', keyPath: ['libraryId', 'availability'] }
    ]
  },
  { name: 'blobs_v3', keyPath: ['libraryId', 'id'], keyShape: 'body', required: ['libraryId', 'id'], indexes: [] },
  {
    name: 'remote_documents_v3',
    keyPath: LIBRARY_AND_ID,
    keyShape: 'library-scoped',
    required: ['libraryId', 'id', 'connectionId', 'key', 'cacheState'],
    numbers: ['modifiedAt', 'size'],
    indexes: [
      { name: 'connectionId', keyPath: ['libraryId', 'connectionId'] },
      { name: 'key', keyPath: ['libraryId', 'key'] }
    ]
  },
  {
    name: 'connections_v3',
    keyPath: LIBRARY_AND_ID,
    keyShape: 'library-scoped',
    required: ['libraryId', 'id', 'provider', 'displayName', 'configVersion'],
    numbers: ['configVersion'],
    indexes: [
      { name: 'provider', keyPath: ['libraryId', 'provider'] },
      { name: 'credentialRef', keyPath: ['libraryId', 'credentialRef'] }
    ]
  },
  {
    name: 'connection_credentials_v3',
    keyPath: LIBRARY_AND_ID,
    keyShape: 'library-scoped',
    required: ['libraryId', 'id', 'encryptedEnvelope', 'iv', 'salt', 'keyMode', 'updatedAt'],
    numbers: ['updatedAt', 'cryptoVersion'],
    indexes: [{ name: 'keyMode', keyPath: ['libraryId', 'keyMode'] }]
  },
  {
    name: 'bindings_v3',
    keyPath: LIBRARY_AND_ID,
    keyShape: 'library-scoped',
    required: ['libraryId', 'id', 'purpose', 'connectionId', 'enabled', 'configVersion'],
    numbers: ['configVersion'],
    indexes: [
      { name: 'purpose', keyPath: ['libraryId', 'purpose'] },
      { name: 'connectionId', keyPath: ['libraryId', 'connectionId'] }
    ]
  },
  {
    name: 'jobs_v3',
    keyPath: LIBRARY_AND_ID,
    keyShape: 'library-scoped',
    required: ['libraryId', 'id', 'kind', 'scopeKey', 'state', 'attempt', 'createdAt', 'updatedAt'],
    numbers: ['attempt', 'nextRunAt', 'createdAt', 'updatedAt', 'inputRevision'],
    indexes: [
      // §6.4: "job state + nextRunAt", used to find runnable work after a restart.
      { name: 'state_nextRunAt', keyPath: ['libraryId', 'state', 'nextRunAt'] },
      { name: 'scopeKey', keyPath: ['libraryId', 'scopeKey'] }
    ]
  },
  {
    name: 'settings_v3',
    keyPath: ['libraryId'],
    keyShape: 'body',
    required: ['libraryId'],
    indexes: []
  },
  // Device-level and migration records are intentionally NOT library-scoped.
  { name: 'library_meta_v3', keyPath: 'key', keyShape: 'plain', required: ['key'], indexes: [] },
  { name: 'migrations_v3', keyPath: 'id', keyShape: 'plain', required: ['id', 'from', 'to', 'phase'], indexes: [{ name: 'phase', keyPath: 'phase' }] },
  /**
   * The encrypted pre-migration snapshot of the raw sources.
   *
   * Deliberately in IndexedDB rather than `localStorage`: the snapshot is about the size of
   * the sources, and the reason a user migrates is that the payload outgrew localStorage's
   * ~5 MB. Keeping the snapshot there made the migration fail exactly when it was needed.
   * Not library-scoped — it belongs to the migration, not to a library.
   */
  {
    name: 'migration_snapshots_v3',
    keyPath: 'id',
    keyShape: 'plain',
    required: ['id', 'ciphertext', 'hash', 'createdAt'],
    numbers: ['createdAt'],
    indexes: []
  }
];

export function storeDef(name: string): StoreDef | undefined {
  return V3_STORES.find((s) => s.name === name);
}

/** Stores that hold user content and therefore need a libraryId. */
export function isLibraryScoped(storeName: string): boolean {
  const def = storeDef(storeName);
  return Boolean(def && def.keyShape !== 'plain');
}

export interface ValidationIssue {
  store: string;
  field: string;
  message: string;
}

/**
 * Runtime shape check for one record.
 *
 * Deliberately structural, not exhaustive: it verifies the keys the indexes and
 * the queries depend on. Deep per-provider validation belongs to that provider's
 * adapter, and over-validating here would reject legitimately forward-compatible
 * records written by a newer build.
 */
export function validateRecord(storeName: string, value: unknown): ValidationIssue[] {
  const def = storeDef(storeName);
  if (!def) return [{ store: storeName, field: '', message: `未知集合: ${storeName}` }];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return [{ store: storeName, field: '', message: '记录必须是对象' }];
  }
  const record = value as Record<string, unknown>;
  const issues: ValidationIssue[] = [];

  for (const field of def.required) {
    const v = record[field];
    if (v === undefined || v === null || v === '') {
      issues.push({ store: storeName, field, message: `缺少必填字段 ${field}` });
    }
  }
  for (const field of def.stringArrays || []) {
    const v = record[field];
    if (v !== undefined && (!Array.isArray(v) || v.some((x) => typeof x !== 'string'))) {
      issues.push({ store: storeName, field, message: `${field} 必须是字符串数组` });
    }
  }
  for (const field of def.numbers || []) {
    const v = record[field];
    if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v))) {
      issues.push({ store: storeName, field, message: `${field} 必须是有限数字` });
    }
  }
  if (def.keyShape === 'library-scoped' && record.libraryId === undefined) {
    issues.push({ store: storeName, field: 'libraryId', message: '业务记录必须带 libraryId' });
  }
  return issues;
}

/** Validate a batch, returning only the failures with their array index. */
export function validateRecords(
  storeName: string,
  values: unknown[]
): Array<{ index: number; issues: ValidationIssue[] }> {
  const out: Array<{ index: number; issues: ValidationIssue[] }> = [];
  values.forEach((value, index) => {
    const issues = validateRecord(storeName, value);
    if (issues.length > 0) out.push({ index, issues });
  });
  return out;
}
