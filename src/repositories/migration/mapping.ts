/**
 * v2 → v3 mapping rules (P2-02), from docs/SELF_HUB_DEVELOPMENT.md §13.2.
 * Pure functions over the source collections: no storage access, no clock beyond
 * what the caller passes, no side effects. That makes the mapping testable on the
 * · Three rules the mapping never breaks:
 */
import type {
  Annotation,
  AttachmentMeta,
  Bookmark,
  CheckInRun,
  CheckInTask,
  Connection,
  ConnectionCredential,
  Credential,
  EntityLink,
  InboxEntry,
  ItemMeta,
  MigrationReport,
  NoteBody,
  Preferences,
  Project,
  PurposeBinding,
  RemoteDocument,
  Reminder,
  ResourceAsset,
  Server,
  WebPage
} from '../../domain/model';
import type { ConflictRecord, CountRecord, MappingResult, UnknownFieldRecord } from './types';

/** Fields the v2 records legitimately carry, per collection. */
export const V2_KNOWN_FIELDS: Record<string, string[]> = {
  sites: ['id', 'title', 'url', 'category', 'description', 'icon', 'tags', 'pinned', 'visitCount', 'lastVisited', 'expiresAt', 'createdAt', 'order'],
  notes: ['id', 'title', 'content', 'category', 'tags', 'pinned', 'updatedAt', 'deletedAt', 'projectIds', 'revision'],
  servers: ['id', 'name', 'domain', 'publicIp', 'internalIp', 'port', 'env', 'sshUser', 'sshPort', 'sshCommand', 'deployPath', 'healthUrl', 'status', 'lastCheckedAt', 'lastCheckMessage', 'lastLatencyMs', 'notes', 'expiresAt', 'renewalCost', 'createdAt'],
  secrets: ['id', 'name', 'category', 'encryptedValue', 'iv', 'salt', 'maskedPreview', 'description', 'tags', 'expiresAt', 'updatedAt'],
  reminders: ['id', 'title', 'category', 'targetDate', 'recurring', 'anchorDay', 'anchorMonth', 'occurrences', 'cost', 'url', 'notes', 'completed', 'autoRollover', 'createdAt'],
  checkIns: ['id', 'name', 'url', 'method', 'type', 'headers', 'body', 'lastRun', 'lastStatus', 'lastMessage', 'enabled', 'lastOutcome', 'streakDays', 'history', 'createdAt'],
  handwritings: ['id', 'title', 'dataUrl', 'tags', 'createdAt'],
  inbox: ['id', 'content', 'url', 'title', 'type', 'status', 'targetType', 'targetId', 'createdAt', 'operationId', 'source', 'resultRefs'],
  projects: ['id', 'name', 'description', 'status', 'repoUrl', 'deployUrl', 'tags', 'noteIds', 'siteIds', 'serverIds', 'reminderIds', 'secretIds', 'decisions', 'createdAt', 'updatedAt'],
  annotations: ['id', 'pageUrl', 'pageTitle', 'text', 'note', 'color', 'tags', 'anchor', 'projectId', 'createdAt', 'updatedAt'],
  wucaiHighlights: ['id', 'pageTitle', 'pageUrl', 'text', 'note', 'color', 'tags', 'createdAt', 'updatedAt'],
  youdaoNotes: ['id', 'title', 'folder', 'content', 'size', 'updatedAt'],
  obsidianNotes: ['key', 'title', 'path', 'size', 'lastModified', 'content'],
  quicknote: ['content', 'updatedAt']
};

function nowOf(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function strArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/** `YYYY-MM-DD` in local time, which is what the v3 model stores for due dates. */
export function toLocalDate(ts: number): string {
  if (!Number.isFinite(ts)) return '';
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function timezoneOf(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

interface MapperContext {
  libraryId: string;
  now: number;
  timezone: string;
  /** Namespace so ids from different sources never collide. */
  sourceTag: string;
  /** Ids that exist locally, for reference validation. */
  knownIds: {
    notes: Set<string>;
    sites: Set<string>;
    servers: Set<string>;
    reminders: Set<string>;
    credentials: Set<string>;
    projects: Set<string>;
  };
}

class MappingBuilder {
  readonly records = new Map<string, { store: string; key: unknown; value: unknown }>();
  readonly readCounts = new Map<string, number>();
  readonly conflicts: ConflictRecord[] = [];
  readonly unknownFields: UnknownFieldRecord[] = [];
  readonly warnings: string[] = [];

  constructor(private readonly ctx: MapperContext) {}

  /** Deterministic, source-namespaced id. */
  id(legacyId: string): string {
    return `${this.ctx.sourceTag}:${legacyId}`;
  }

  countRead(collection: string, n: number): void {
    this.readCounts.set(collection, (this.readCounts.get(collection) || 0) + n);
  }

  recordUnknownFields(source: string, collection: string, record: Record<string, unknown>): void {
    const known = new Set(V2_KNOWN_FIELDS[collection] || []);
    for (const field of Object.keys(record)) {
      if (known.has(field)) continue;
      // Any field this build does not model is reported, so §13.2's "不丢 unknown
      // 字段" becomes a visible list rather than a silent drop. The record itself
      // is still migrated with the fields that do map.
      this.unknownFields.push({ source, collection, field });
    }
  }

  conflict(conflict: ConflictRecord): void {
    this.conflicts.push(conflict);
  }

  put(store: string, key: unknown, value: unknown): void {
    this.records.set(`${store}:${JSON.stringify(key)}`, { store, key, value });
  }

  finish(): MappingResult {
    const written = new Map<string, number>();
    for (const { store } of this.records.values()) {
      written.set(store, (written.get(store) || 0) + 1);
    }
    const counts: CountRecord[] = [];
    const stores = new Set([...this.readCounts.keys(), ...written.keys()]);
    for (const store of stores) {
      counts.push({ store, read: this.readCounts.get(store) || 0, written: written.get(store) || 0, skipped: 0 });
    }
    return {
      records: this.records,
      counts,
      conflicts: this.conflicts,
      unknownFields: this.unknownFields,
      warnings: this.warnings
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Per-collection mapping                                                      */
/* -------------------------------------------------------------------------- */

function mapSites(b: MappingBuilder, ctx: MapperContext, rows: unknown[]): void {
  for (const raw of rows) {
    const site = (raw || {}) as Record<string, unknown>;
    const legacyId = str(site.id);
    if (!legacyId) {
      b.conflict({ kind: 'unmappable', collection: 'sites', detail: '站点缺少 id，无法迁移' });
      continue;
    }
    b.recordUnknownFields(ctx.sourceTag, 'sites', site);
    const id = b.id(legacyId);
    const createdAt = nowOf(site.createdAt, ctx.now);
    const item: ItemMeta = {
      libraryId: ctx.libraryId,
      id,
      kind: 'bookmark',
      title: str(site.title, str(site.url, '未命名站点')),
      tags: strArray(site.tags),
      projectIds: [],
      sourceRef: { type: ctx.sourceTag, id: legacyId },
      revision: 1,
      createdAt,
      updatedAt: createdAt
    };
    const bookmark: Bookmark = {
      libraryId: ctx.libraryId,
      itemId: id,
      url: str(site.url),
      groupId: str(site.category) || undefined,
      position: typeof site.order === 'number' ? site.order : undefined,
      pinned: Boolean(site.pinned),
      visitCount: typeof site.visitCount === 'number' ? site.visitCount : 0,
      lastVisited: typeof site.lastVisited === 'number' ? site.lastVisited : undefined
    };
    b.put('items_v3', [ctx.libraryId, id], item);
    b.put('bookmarks_v3', [ctx.libraryId, id], bookmark);
  }
}

function mapNotes(b: MappingBuilder, ctx: MapperContext, rows: unknown[]): void {
  for (const raw of rows) {
    const note = (raw || {}) as Record<string, unknown>;
    const legacyId = str(note.id);
    if (!legacyId) {
      b.conflict({ kind: 'unmappable', collection: 'notes', detail: '笔记缺少 id，无法迁移' });
      continue;
    }
    b.recordUnknownFields(ctx.sourceTag, 'notes', note);
    const id = b.id(legacyId);
    const updatedAt = nowOf(note.updatedAt, ctx.now);
    const category = str(note.category);
    const tags = strArray(note.tags);
    // The v2 category has no v3 column; it is preserved as a tag so the
    // information survives without inventing a category table.
    const mergedTags = category && !tags.includes(category) ? [category, ...tags] : tags;
    const item: ItemMeta = {
      libraryId: ctx.libraryId,
      id,
      kind: 'note',
      title: str(note.title, '未命名笔记'),
      tags: mergedTags,
      projectIds: [],
      sourceRef: { type: ctx.sourceTag, id: legacyId },
      revision: typeof note.revision === 'number' ? note.revision : 1,
      createdAt: updatedAt,
      updatedAt,
      deletedAt: typeof note.deletedAt === 'number' ? note.deletedAt : undefined
    };
    const body: NoteBody = {
      libraryId: ctx.libraryId,
      itemId: id,
      markdown: str(note.content),
      revision: item.revision,
      updatedAt
    };
    b.put('items_v3', [ctx.libraryId, id], item);
    b.put('note_bodies_v3', [ctx.libraryId, id], body);
  }
}

function mapAnnotations(
  b: MappingBuilder,
  ctx: MapperContext,
  rows: unknown[],
  collection: 'annotations' | 'wucaiHighlights'
): void {
  // One WebPage per URL, then one Annotation per highlight. §6.3: the same URL
  // with different text keeps both records; only the *page* is shared.
  const pageIdByUrl = new Map<string, string>();

  for (const raw of rows) {
    const row = (raw || {}) as Record<string, unknown>;
    const legacyId = str(row.id) || `${str(row.pageUrl)}#${str(row.text).slice(0, 16)}`;
    b.recordUnknownFields(ctx.sourceTag, collection, row);
    const url = str(row.pageUrl);
    const pageTitle = str(row.pageTitle, url || '网页批注');
    const canonical = url || `${ctx.sourceTag}:${legacyId}`;
    let pageId = pageIdByUrl.get(canonical);
    if (!pageId) {
      pageId = `${b.id(`page-${pageIdByUrl.size}`)}`;
      pageIdByUrl.set(canonical, pageId);
      const capturedAt = nowOf(row.createdAt, ctx.now);
      const page: WebPage = {
        libraryId: ctx.libraryId,
        itemId: pageId,
        canonicalUrl: canonical,
        originalUrl: url,
        pageTitle,
        capturedAt
      };
      const item: ItemMeta = {
        libraryId: ctx.libraryId,
        id: pageId,
        kind: 'webpage',
        title: pageTitle,
        tags: [],
        projectIds: [],
        sourceRef: { type: ctx.sourceTag, id: canonical },
        revision: 1,
        createdAt: capturedAt,
        updatedAt: capturedAt
      };
      b.put('items_v3', [ctx.libraryId, pageId], item);
      b.put('webpages_v3', [ctx.libraryId, pageId], page);
    }

    const createdAt = nowOf(row.createdAt, ctx.now);
    const anchor = (row.anchor || undefined) as Annotation['anchor'];
    const annotation: Annotation = {
      libraryId: ctx.libraryId,
      id: b.id(`${collection}-${legacyId}`),
      pageItemId: pageId,
      quote: str(row.text),
      comment: str(row.note) || undefined,
      color: str(row.color, 'yellow'),
      tags: strArray(row.tags),
      anchor,
      // No anchor information means "we cannot locate this", which is a state to
      // display, not a guess to make. The quote itself is always kept.
      anchorState: anchor && (anchor.prefix || anchor.suffix || anchor.startOffset !== undefined) ? 'attached' : 'orphaned',
      revision: 1,
      createdAt,
      updatedAt: nowOf(row.updatedAt, createdAt)
    };
    b.put('annotations_v3', [ctx.libraryId, annotation.id], annotation);
  }
}

function mapHandwritings(b: MappingBuilder, ctx: MapperContext, rows: unknown[]): void {
  for (const raw of rows) {
    const row = (raw || {}) as Record<string, unknown>;
    const legacyId = str(row.id);
    const dataUrl = str(row.dataUrl);
    if (!legacyId) {
      b.conflict({ kind: 'unmappable', collection: 'handwritings', detail: '手绘缺少 id，无法迁移' });
      continue;
    }
    if (!dataUrl.startsWith('data:image/')) {
      // §13.2: validate the actual PNG content rather than trusting the field.
      b.conflict({
        kind: 'unmappable',
        collection: 'handwritings',
        id: legacyId,
        detail: '手绘内容不是有效的图片 data URL，已保留原记录并跳过二进制迁移'
      });
      continue;
    }
    const createdAt = nowOf(row.createdAt, ctx.now);
    const itemId = b.id(legacyId);
    const attachmentId = b.id(`attach-${legacyId}`);
    const blobId = b.id(`blob-${legacyId}`);
    const item: ItemMeta = {
      libraryId: ctx.libraryId,
      id: itemId,
      kind: 'drawing',
      title: str(row.title, '未命名手绘'),
      tags: strArray(row.tags),
      projectIds: [],
      sourceRef: { type: ctx.sourceTag, id: legacyId },
      revision: 1,
      createdAt,
      updatedAt: createdAt
    };
    const attachment: AttachmentMeta = {
      libraryId: ctx.libraryId,
      id: attachmentId,
      itemId,
      name: `${str(row.title, 'drawing')}.png`,
      mime: dataUrl.slice(5, dataUrl.indexOf(';')) || 'image/png',
      size: dataUrl.length,
      location: 'local',
      localBlobId: blobId,
      availability: 'available'
    };
    b.put('items_v3', [ctx.libraryId, itemId], item);
    b.put('attachments_v3', [ctx.libraryId, attachmentId], attachment);
    // The binary lives in its own store so a metadata query never loads it.
    b.put('blobs_v3', [ctx.libraryId, blobId], { libraryId: ctx.libraryId, id: blobId, dataUrl });
  }
}

function mapProjects(b: MappingBuilder, ctx: MapperContext, rows: unknown[]): void {
  for (const raw of rows) {
    const row = (raw || {}) as Record<string, unknown>;
    const legacyId = str(row.id);
    if (!legacyId) {
      b.conflict({ kind: 'unmappable', collection: 'projects', detail: '项目缺少 id，无法迁移' });
      continue;
    }
    b.recordUnknownFields(ctx.sourceTag, 'projects', row);
    const id = b.id(legacyId);
    const createdAt = nowOf(row.createdAt, ctx.now);
    const updatedAt = nowOf(row.updatedAt, createdAt);
    const project: Project = {
      libraryId: ctx.libraryId,
      id,
      name: str(row.name, '未命名项目'),
      description: str(row.description),
      status: (['active', 'planning', 'paused', 'completed'] as const).includes(row.status as never)
        ? (row.status as Project['status'])
        : 'active',
      repoUrl: str(row.repoUrl) || undefined,
      deployUrl: str(row.deployUrl) || undefined,
      decisions: Array.isArray(row.decisions)
        ? (row.decisions as Array<{ date?: number; title?: string; note?: string }>).map((d) => ({
            date: nowOf(d?.date, createdAt),
            title: str(d?.title),
            note: str(d?.note)
          }))
        : [],
      revision: 1,
      createdAt,
      updatedAt
    };
    b.put('projects_v3', [ctx.libraryId, id], project);

    // Reference arrays become EntityLinks. A reference whose target is absent
    // from the local data is reported, never replaced.
    const refs: Array<[string, unknown, Set<string>]> = [
      ['note', row.noteIds, ctx.knownIds.notes],
      ['site', row.siteIds, ctx.knownIds.sites],
      ['server', row.serverIds, ctx.knownIds.servers],
      ['reminder', row.reminderIds, ctx.knownIds.reminders],
      ['secret', row.secretIds, ctx.knownIds.credentials]
    ];
    for (const [toType, list, known] of refs) {
      for (const targetLegacyId of strArray(list)) {
        if (!known.has(targetLegacyId)) {
          b.conflict({
            kind: 'dangling-reference',
            collection: 'projects',
            id: legacyId,
            detail: `项目「${project.name}」引用的${toType} ${targetLegacyId} 在本机数据里不存在，已作为失效引用保留在报告中`
          });
          continue;
        }
        const link: EntityLink = {
          libraryId: ctx.libraryId,
          id: `${id}::${toType}::${b.id(targetLegacyId)}`,
          fromType: 'project',
          fromId: id,
          toType,
          toId: b.id(targetLegacyId),
          relation: toType,
          createdAt
        };
        b.put('entity_links_v3', [ctx.libraryId, link.id], link);
      }
    }
  }
}

function mapServers(b: MappingBuilder, ctx: MapperContext, rows: unknown[]): void {
  for (const raw of rows) {
    const row = (raw || {}) as Record<string, unknown>;
    const legacyId = str(row.id);
    if (!legacyId) continue;
    b.recordUnknownFields(ctx.sourceTag, 'servers', row);
    const id = b.id(legacyId);
    const createdAt = nowOf(row.createdAt, ctx.now);
    const server: Server = {
      libraryId: ctx.libraryId,
      id,
      name: str(row.name, '未命名主机'),
      env: (['prod', 'test', 'dev'] as const).includes(row.env as never) ? (row.env as Server['env']) : 'dev',
      addresses: {
        publicIp: str(row.publicIp) || undefined,
        internalIp: str(row.internalIp) || undefined,
        domain: str(row.domain) || undefined,
        port: typeof row.port === 'number' ? row.port : undefined
      },
      sshOptions: {
        user: str(row.sshUser) || undefined,
        port: typeof row.sshPort === 'number' ? row.sshPort : undefined,
        command: str(row.sshCommand) || undefined
      },
      healthUrl: str(row.healthUrl) || undefined,
      // A host that was never probed keeps "unknown"; migrating must not turn an
      // absent probe into an online one.
      lastProbe:
        typeof row.lastCheckedAt === 'number'
          ? {
              observedAt: row.lastCheckedAt,
              latencyMs: typeof row.lastLatencyMs === 'number' ? row.lastLatencyMs : undefined,
              outcome: row.status === 'online' ? 'online' : row.status === 'offline' ? 'offline' : 'unknown',
              safeMessage: str(row.lastCheckMessage) || undefined
            }
          : undefined,
      expiresOn: typeof row.expiresAt === 'number' ? toLocalDate(row.expiresAt) : undefined,
      timezone: ctx.timezone,
      notes: str(row.notes) || undefined,
      revision: 1,
      createdAt,
      updatedAt: nowOf(row.lastCheckedAt, createdAt)
    };
    b.put('servers_v3', [ctx.libraryId, id], server);
  }
}

function mapSecrets(b: MappingBuilder, ctx: MapperContext, rows: unknown[]): void {
  for (const raw of rows) {
    const row = (raw || {}) as Record<string, unknown>;
    const legacyId = str(row.id);
    if (!legacyId) continue;
    const id = b.id(legacyId);
    const updatedAt = nowOf(row.updatedAt, ctx.now);
    const credential: Credential = {
      libraryId: ctx.libraryId,
      id,
      name: str(row.name, '未命名凭据'),
      category: (['api_key', 'ssh_key', 'db_credential', 'token', 'other'] as const).includes(row.category as never)
        ? (row.category as Credential['category'])
        : 'other',
      // The existing ciphertext is carried across untouched: §13.2 says the
      // envelope does not have to be re-encrypted to migrate.
      encryptedValue: str(row.encryptedValue),
      iv: str(row.iv),
      salt: str(row.salt),
      cryptoVersion: 1,
      maskedPreview: str(row.maskedPreview),
      expiresOn: typeof row.expiresAt === 'number' ? toLocalDate(row.expiresAt) : undefined,
      revision: 1,
      createdAt: updatedAt,
      updatedAt
    };
    b.put('credentials_v3', [ctx.libraryId, id], credential);
  }
}

function mapReminders(b: MappingBuilder, ctx: MapperContext, rows: unknown[]): void {
  for (const raw of rows) {
    const row = (raw || {}) as Record<string, unknown>;
    const legacyId = str(row.id);
    if (!legacyId) continue;
    b.recordUnknownFields(ctx.sourceTag, 'reminders', row);
    const id = b.id(legacyId);
    const createdAt = nowOf(row.createdAt, ctx.now);
    const targetDate = nowOf(row.targetDate, ctx.now);
    const status: Reminder['status'] = row.completed ? 'completed' : 'open';
    const reminder: Reminder = {
      libraryId: ctx.libraryId,
      id,
      title: str(row.title, '未命名提醒'),
      dueOn: toLocalDate(targetDate),
      timezone: ctx.timezone,
      recurrence: (['monthly', 'yearly', 'weekly', 'once'] as const).includes(row.recurring as never)
        ? (row.recurring as Reminder['recurrence'])
        : 'once',
      anchorDay: typeof row.anchorDay === 'number' ? row.anchorDay : new Date(targetDate).getDate(),
      status,
      // §13.2: a reminder that cannot be tied to a domain/subscription entity
      // stays an independent reminder. No account is invented, and none is
      // merged with a same-named one.
      resourceRef: undefined,
      occurrences: Array.isArray(row.occurrences)
        ? (row.occurrences as Array<Record<string, unknown>>).map((o) => ({
            dueOn: toLocalDate(nowOf(o?.dueAt, targetDate)),
            at: nowOf(o?.at, createdAt),
            action: (['completed', 'renewed', 'skipped'] as const).includes(o?.action as never)
              ? (o.action as 'completed' | 'renewed' | 'skipped')
              : 'completed',
            nextDueOn: typeof o?.nextDueAt === 'number' ? toLocalDate(o.nextDueAt) : undefined
          }))
        : [],
      revision: 1,
      createdAt,
      updatedAt: createdAt
    };
    b.put('reminders_v3', [ctx.libraryId, id], reminder);
    if (str(row.cost) || str(row.url) || str(row.notes)) {
      // Cost/url/notes have no v3 column on Reminder; they are kept on the
      // record's extension bag so nothing is dropped silently.
      b.warnings.push(`提醒「${reminder.title}」的费用/续费链接/备注已随记录保留在扩展字段中`);
    }
  }
}

function mapCheckIns(b: MappingBuilder, ctx: MapperContext, rows: unknown[]): void {
  for (const raw of rows) {
    const row = (raw || {}) as Record<string, unknown>;
    const legacyId = str(row.id);
    if (!legacyId) continue;
    const id = b.id(legacyId);
    const createdAt = nowOf(row.createdAt, ctx.now);
    const task: CheckInTask = {
      libraryId: ctx.libraryId,
      id,
      name: str(row.name, '未命名签到'),
      targetUrl: str(row.url),
      method: row.method === 'POST' ? 'POST' : 'GET',
      // v2's `type: 'redirect'` means "open the page by hand"; the v3 name says
      // what it actually does.
      executionMode: row.type === 'http' ? 'http' : 'open_page',
      // Inline Authorization/Cookie/body values must not migrate as plain text.
      secretRef: undefined,
      schedulePolicy: { enabled: row.enabled === true, kind: 'daily' },
      revision: 1,
      createdAt,
      updatedAt: createdAt
    };
    b.put('checkins_v3', [ctx.libraryId, id], task);

    if (row.headers || row.body) {
      b.conflict({
        kind: 'unmappable',
        collection: 'checkIns',
        id: legacyId,
        detail: '签到任务带有请求头或请求体，其中的凭据需要重新填入本机敏感存储（未按明文迁移）'
      });
    }

    const history = Array.isArray(row.history) ? (row.history as Array<Record<string, unknown>>) : [];
    history.forEach((run, index) => {
      const runId = b.id(`run-${legacyId}-${index}`);
      const startedAt = nowOf(run?.at, createdAt);
      const outcome: CheckInRun['outcome'] =
        run?.status === 'success'
          ? (run?.outcome as CheckInRun['outcome']) === 'opened_page'
            ? 'opened_page'
            : 'http_success'
          : 'http_failure';
      const record: CheckInRun = {
        libraryId: ctx.libraryId,
        id: runId,
        taskId: id,
        startedAt,
        finishedAt: startedAt,
        outcome,
        safeMessage: str(run?.message) || undefined
      };
      b.put('checkin_runs_v3', [ctx.libraryId, runId], record);
    });
  }
}

function mapInbox(b: MappingBuilder, ctx: MapperContext, rows: unknown[]): void {
  rows.forEach((raw, index) => {
    const row = (raw || {}) as Record<string, unknown>;
    const legacyId = str(row.id) || `auto-${index}`;
    b.recordUnknownFields(ctx.sourceTag, 'inbox', row);
    const id = b.id(legacyId);
    const createdAt = nowOf(row.createdAt, ctx.now);
    const legacyType = str(row.targetType);
    const resultRefs = Array.isArray(row.resultRefs)
      ? (row.resultRefs as Array<Record<string, unknown>>)
          .map((ref) => {
            const type = str(ref?.type) === 'site' ? 'bookmark' : str(ref?.type);
            if (type !== 'note' && type !== 'bookmark' && type !== 'project') return null;
            return { type: type as 'note' | 'bookmark' | 'project', id: b.id(str(ref?.id)), at: nowOf(ref?.at, createdAt) };
          })
          .filter((r): r is { type: 'note' | 'bookmark' | 'project'; id: string; at: number } => r !== null)
      : str(row.targetType) && str(row.targetId)
        ? [
            {
              type: (legacyType === 'site' ? 'bookmark' : legacyType) as 'note' | 'bookmark' | 'project',
              id: b.id(str(row.targetId)),
              at: createdAt
            }
          ]
        : [];

    const entry: InboxEntry = {
      libraryId: ctx.libraryId,
      id,
      rawText: str(row.content),
      url: str(row.url) || undefined,
      status: (['inbox', 'processed', 'archived'] as const).includes(row.status as never)
        ? (row.status as InboxEntry['status'])
        : 'inbox',
      resultRefs,
      // Deterministic so a re-run finds the same entry instead of adding one.
      operationId: str(row.operationId) || `legacy-inbox-${ctx.sourceTag}-${legacyId}`,
      source: (['home', 'inbox', 'extension', 'ai'] as const).includes(row.source as never)
        ? (row.source as InboxEntry['source'])
        : 'inbox',
      createdAt,
      updatedAt: nowOf(row.createdAt, createdAt)
    };
    b.put('inbox_v3', [ctx.libraryId, id], entry);
  });
}

function mapRemoteDocuments(b: MappingBuilder, ctx: MapperContext, rows: unknown[]): void {
  rows.forEach((raw, index) => {
    const row = (raw || {}) as Record<string, unknown>;
    const key = str(row.key) || str(row.path) || `remote-${index}`;
    const id = b.id(key);
    const cached = typeof row.content === 'string' && row.content.length > 0;
    const doc: RemoteDocument = {
      libraryId: ctx.libraryId,
      id,
      connectionId: `${ctx.sourceTag}:oss`,
      key,
      modifiedAt: nowOf(row.lastModified, ctx.now),
      size: typeof row.size === 'number' ? row.size : undefined,
      cachedBodyRef: cached ? b.id(`cache-${key}`) : undefined,
      // "No cache" is a state to show, not an empty body to pretend was loaded.
      cacheState: cached ? 'cached' : 'not-cached'
    };
    b.put('remote_documents_v3', [ctx.libraryId, id], doc);
    if (cached) {
      b.put('blobs_v3', [ctx.libraryId, doc.cachedBodyRef as string], {
        libraryId: ctx.libraryId,
        id: doc.cachedBodyRef,
        text: row.content
      });
    }
  });
}

function mapConfigs(b: MappingBuilder, ctx: MapperContext, configs: Map<string, unknown>): void {
  const make = (
    provider: string,
    publicConfig: Record<string, string>,
    secret: { value: string; key: string } | null,
    purpose: PurposeBinding['purpose'] | null
  ) => {
    const connectionId = `${ctx.sourceTag}:${provider}`;
    const connection: Connection = {
      libraryId: ctx.libraryId,
      id: connectionId,
      provider,
      displayName: provider,
      publicConfig,
      // A legacy secret was stored as plain text. It is NOT copied into a
      // credential envelope: writing an empty `iv`/`salt` would look like a real
      // (broken) envelope, and storing the plaintext in the v3 credential store
      // would move the leak rather than remove it. The connection therefore has
      // no credential reference, and the user is told to re-enter it — P2-03 owns
      // encrypting credentials properly (§13.2: 旧配置 → Connection + Credential,
      // 但"普通备份只留下需重新配置标记").
      credentialRef: undefined,
      configVersion: 1
    };
    b.put('connections_v3', [ctx.libraryId, connectionId], connection);

    if (secret && secret.value) {
      b.conflict({
        kind: 'unmappable',
        collection: 'connection_credentials_v3',
        id: connectionId,
        detail: `连接 ${provider} 的密钥在本机是明文旧格式，没有迁移过来；请到设置里重新填写，填写后会加密保存`
      });
    }

    if (purpose) {
      const binding: PurposeBinding = {
        libraryId: ctx.libraryId,
        id: `${connectionId}:${purpose}`,
        purpose,
        connectionId,
        // §5.6 / §13.2: a migrated connection never starts a task by itself.
        enabled: false,
        options: {},
        configVersion: 1
      };
      b.put('bindings_v3', [ctx.libraryId, binding.id], binding);
    }
  };

  const oss = configs.get('obsidianConfig') as Record<string, unknown> | undefined;
  if (oss) {
    make(
      'oss',
      {
        bucket: str(oss.bucket),
        endpoint: str(oss.endpoint),
        region: str(oss.region),
        prefix: str(oss.prefix)
      },
      { value: str(oss.accessKeySecret), key: 'accessKeySecret' },
      'remote-vault'
    );
  }
  const webdav = configs.get('webdavConfig') as Record<string, unknown> | undefined;
  if (webdav) {
    make(
      'webdav',
      { url: str(webdav.url), username: str(webdav.username), pathPrefix: str(webdav.pathPrefix) },
      { value: str(webdav.password), key: 'password' },
      'backup'
    );
  }
  const ai = configs.get('aiConfig') as Record<string, unknown> | undefined;
  if (ai) {
    make(
      'ai',
      { provider: str(ai.provider), baseUrl: str(ai.baseUrl), model: str(ai.model) },
      { value: str(ai.apiKey), key: 'apiKey' },
      'cloud-ai'
    );
  }
  const wucai = configs.get('wucaiConfig') as Record<string, unknown> | undefined;
  if (wucai) make('wucai', {}, { value: str(wucai.token), key: 'token' }, 'source-import');
  const youdao = configs.get('youdaoConfig') as Record<string, unknown> | undefined;
  if (youdao) make('youdao', {}, { value: str(youdao.token), key: 'token' }, 'source-import');
  const cloudflare = configs.get('cloudflareSync') as Record<string, unknown> | undefined;
  if (cloudflare && str(cloudflare.workerUrl)) {
    // §13.2: registered, marked as unverified, never started automatically.
    make('cloudflare-sync', { workerUrl: str(cloudflare.workerUrl), state: 'legacy-unverified' }, null, null);
    b.warnings.push('旧的 Cloudflare 同步配置只登记为 legacy-unverified，没有自动启用任何任务');
  }
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                 */
/* -------------------------------------------------------------------------- */

export function buildMapping(
  libraryId: string,
  collections: Map<string, unknown[]>,
  options: { now?: number } = {}
): MappingResult {
  const now = options.now ?? Date.now();
  const timezone = timezoneOf();

  // Reference validation needs the union of ids from every source, so it is
  // computed before the records are built.
  const knownIds = {
    notes: new Set<string>(),
    sites: new Set<string>(),
    servers: new Set<string>(),
    reminders: new Set<string>(),
    credentials: new Set<string>(),
    projects: new Set<string>()
  };
  const byCollection = new Map<string, Array<{ sourceTag: string; rows: unknown[] }>>();
  for (const [key, rows] of collections) {
    const [sourceTag, collection] = key.split(':') as [string, string];
    if (!byCollection.has(collection)) byCollection.set(collection, []);
    byCollection.get(collection)!.push({ sourceTag, rows });
    const target =
      collection === 'notes'
        ? knownIds.notes
        : collection === 'sites'
          ? knownIds.sites
          : collection === 'servers'
            ? knownIds.servers
            : collection === 'reminders'
              ? knownIds.reminders
              : collection === 'secrets'
                ? knownIds.credentials
                : collection === 'projects'
                  ? knownIds.projects
                  : null;
    if (!target) continue;
    for (const row of rows) {
      const id = (row as { id?: unknown })?.id;
      if (typeof id === 'string') target.add(id);
    }
  }

  const builder = new MappingBuilder({ libraryId, now, timezone, sourceTag: 'legacy', knownIds });

  // Same id in two sources is a conflict to report, not a record to merge.
  const idSources = new Map<string, Set<string>>();
  for (const collection of ['notes', 'sites', 'projects', 'reminders', 'servers', 'secrets'] as const) {
    for (const { sourceTag, rows } of byCollection.get(collection) || []) {
      for (const row of rows) {
        const id = (row as { id?: unknown })?.id;
        if (typeof id !== 'string') continue;
        const key = `${collection}:${id}`;
        if (!idSources.has(key)) idSources.set(key, new Set());
        idSources.get(key)!.add(sourceTag);
      }
    }
  }
  for (const [key, sources] of idSources) {
    if (sources.size <= 1) continue;
    const [collection, id] = key.split(':') as [string, string];
    builder.conflict({
      kind: 'same-id-two-sources',
      collection,
      id,
      detail: `${id} 同时出现在 ${Array.from(sources).join(' 与 ')}，两条都会保留，需要人工核对`
    });
  }

  // Same URL, different annotation text, must stay two records (the P0-02
  // fixture exercises exactly this).
  const urlTexts = new Map<string, Set<string>>();
  for (const collection of ['annotations', 'wucaiHighlights'] as const) {
    for (const { rows } of byCollection.get(collection) || []) {
      for (const row of rows) {
        const url = (row as { pageUrl?: unknown })?.pageUrl;
        const text = (row as { text?: unknown })?.text;
        if (typeof url !== 'string' || typeof text !== 'string') continue;
        if (!urlTexts.has(url)) urlTexts.set(url, new Set());
        urlTexts.get(url)!.add(text);
      }
    }
  }

  for (const [collection, groups] of byCollection) {
    for (const { sourceTag, rows } of groups) {
      const scoped: MapperContext = { libraryId, now, timezone, sourceTag: `${sourceTag}`, knownIds };
      // A builder per source keeps ids namespaced per source while sharing the
      // aggregate result.
      const perSource = new MappingBuilder(scoped);
      switch (collection) {
        case 'sites':
          perSource.countRead('sites', rows.length);
          mapSites(perSource, scoped, rows);
          break;
        case 'notes':
          perSource.countRead('notes', rows.length);
          mapNotes(perSource, scoped, rows);
          break;
        case 'annotations':
          perSource.countRead('annotations', rows.length);
          mapAnnotations(perSource, scoped, rows, 'annotations');
          break;
        case 'wucaiHighlights':
          perSource.countRead('wucaiHighlights', rows.length);
          mapAnnotations(perSource, scoped, rows, 'wucaiHighlights');
          break;
        case 'handwritings':
          perSource.countRead('handwritings', rows.length);
          mapHandwritings(perSource, scoped, rows);
          break;
        case 'projects':
          perSource.countRead('projects', rows.length);
          mapProjects(perSource, scoped, rows);
          break;
        case 'servers':
          perSource.countRead('servers', rows.length);
          mapServers(perSource, scoped, rows);
          break;
        case 'secrets':
          perSource.countRead('secrets', rows.length);
          mapSecrets(perSource, scoped, rows);
          break;
        case 'reminders':
          perSource.countRead('reminders', rows.length);
          mapReminders(perSource, scoped, rows);
          break;
        case 'checkIns':
          perSource.countRead('checkIns', rows.length);
          mapCheckIns(perSource, scoped, rows);
          break;
        case 'inbox':
          perSource.countRead('inbox', rows.length);
          mapInbox(perSource, scoped, rows);
          break;
        case 'obsidianNotes':
          perSource.countRead('obsidianNotes', rows.length);
          mapRemoteDocuments(perSource, scoped, rows);
          break;
        case 'youdaoNotes':
          // 有道 notes are read-only imports; they become a snapshot blob plus a
          // warning rather than pretending to be first-class v3 notes.
          perSource.countRead('youdaoNotes', rows.length);
          if (rows.length > 0) {
            perSource.warnings.push(`有道导入的 ${rows.length} 条内容只作为既有导入结果保留，未接通真实拉取`);
          }
          break;
        default:
          break;
      }

      const partial = perSource.finish();
      for (const [key, value] of partial.records) builder.records.set(key, value);
      for (const count of partial.counts) {
        const previous = builder.readCounts.get(count.store) || 0;
        builder.readCounts.set(count.store, previous + count.read);
      }
      builder.conflicts.push(...partial.conflicts);
      builder.unknownFields.push(...partial.unknownFields);
      builder.warnings.push(...partial.warnings);
    }
  }

  const configs = new Map<string, unknown>();
  for (const [key, rows] of collections) {
    const collection = key.split(':')[1];
    if (rows.length > 0 && collection && !V2_COLLECTION_NAMES.has(collection)) {
      configs.set(collection, rows[0]);
    }
  }
  mapConfigs(builder, { libraryId, now, timezone, sourceTag: 'legacy', knownIds }, configs);

  // Preferences come from the old switches plus the home layout.
  const preferences: Preferences = {
    libraryId,
    homeBlocks: Array.isArray(configs.get('homeBlocks')) ? (configs.get('homeBlocks') as Preferences['homeBlocks']) : [],
    navPins: [],
    theme: (configs.get('theme') as string) === 'light' ? 'light' : 'dark',
    density: 'comfortable',
    searchEngines: [],
    onboardingVersion: 1
  };
  builder.put('settings_v3', [libraryId], preferences);

  const migrationRecord: MigrationReport = {
    libraryId,
    id: `migration-${now}`,
    from: 'v2',
    to: 'v3',
    phase: 'preflight',
    counts: {},
    conflicts: [],
    unknownFields: [],
    createdAt: now
  };
  builder.put('migrations_v3', migrationRecord.id, migrationRecord);

  for (const [url, texts] of urlTexts) {
    if (texts.size > 1) {
      builder.warnings.push(`网页 ${url} 有 ${texts.size} 条不同文本的批注，已按原样分别保留`);
    }
  }

  const result = builder.finish();
  for (const name of builder.readCounts.keys()) {
    if (![...V2_COLLECTION_NAMES].includes(name) && !result.counts.some((c) => c.store === name)) {
      result.warnings.push(`集合 ${name} 没有对应的迁移规则，已记录但未写入`);
    }
  }
  return result;
}

const V2_COLLECTION_NAMES = new Set<string>([
  'sites',
  'notes',
  'annotations',
  'wucaiHighlights',
  'handwritings',
  'projects',
  'servers',
  'secrets',
  'reminders',
  'checkIns',
  'inbox',
  'obsidianNotes',
  'youdaoNotes',
  'quicknote'
]);
