/**
 * HubState ⇄ v3 library adapter (P2 切库 phase 1).
 * The app's fact source is still the v2 `HubState` payload in localStorage. Everything
 * P2 built — the v3 schema, the migration, v3 backups, restore, migration packages —
 * · per-device and must be re-entered and re-tested on a new machine. The adapter
 */
import type { HubState } from '../types';
import type {
  Annotation,
  Bookmark,
  CheckInRun,
  CheckInTask,
  Credential,
  DomainRow,
  EntityLink,
  InboxEntry,
  ItemMeta,
  NoteBody,
  Project,
  RemoteDocument,
  Reminder,
  Server,
  AttachmentMeta,
  WebPage
} from '../domain/model';
import { runV3Transaction, requestToPromise } from '../infrastructure/storage/idbV3';
import { storeDef, validateRecords } from './schema';
import { fail, ok, toAppError, type Result } from './errors';

const STORES = {
  items: 'items_v3',
  noteBodies: 'note_bodies_v3',
  bookmarks: 'bookmarks_v3',
  webpages: 'webpages_v3',
  annotations: 'annotations_v3',
  inbox: 'inbox_v3',
  projects: 'projects_v3',
  links: 'entity_links_v3',
  servers: 'servers_v3',
  credentials: 'credentials_v3',
  domains: 'domains_v3',
  reminders: 'reminders_v3',
  checkins: 'checkins_v3',
  checkinRuns: 'checkin_runs_v3',
  remoteDocs: 'remote_documents_v3',
  blobs: 'blobs_v3',
  attachments: 'attachments_v3',
  settings: 'settings_v3'
} as const;

/** Every store a library write touches (settings is written last, in the same tx). */
const LIBRARY_STORES = Object.values(STORES);

/**
 * Per-library, per-store hash of the record set this adapter last wrote successfully.
 * Lets a save skip the read+compare for stores whose input did not change — the difference
 * between ~500 ms and a few ms on a 6,600-record library (measured, see
 * · may not match what we think) and never shared across libraries.
 */
const writtenHashes = new Map<string, Map<string, string>>();

export interface AdapterReport {
  /** Records that could not be mapped and were left out. */
  dropped: number;
  /** Links whose target no longer exists (kept in the original as dangling refs). */
  danglingLinks: number;
  /** Device-local configuration that intentionally did not move. */
  leftOnDevice: string[];
  problems: string[];
}

export interface AdapterWriteResult {
  revision: number;
  counts: Record<string, number>;
  /** Records actually put (changed or new). */
  written: Record<string, number>;
  /** Old records removed because the new state no longer has them. */
  deleted: Record<string, number>;
  report: AdapterReport;
}

export interface AdapterReadResult {
  /** Business data + preferences; connection configs are absent by design. */
  state: Partial<HubState>;
  counts: Record<string, number>;
  report: AdapterReport;
}

/** Local `YYYY-MM-DD`, matching the v3 model's `LocalDate`. */
export function toLocalDate(ts: number | undefined): string | undefined {
  if (!ts || !Number.isFinite(ts)) return undefined;
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function fromLocalDate(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = new Date(`${value}T00:00:00`).getTime();
  return Number.isFinite(parsed) ? parsed : fallback;
}

function nowOf(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function strArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

/**
 * Deterministic row base.
 * The fallback timestamps must **not** be `Date.now()`: a missing `createdAt` would then
 * differ on every call, so a record would look "changed" on every save and the
 */
function baseRow(libraryId: string, id: string, source: Record<string, unknown>, _now: number) {
  const updatedAt = nowOf(source.updatedAt, nowOf(source.createdAt, 0));
  const createdAt = nowOf(source.createdAt, updatedAt);
  return {
    libraryId,
    id,
    revision: 1,
    createdAt,
    updatedAt,
    /** Transitional: the v2 row this came from (see the file header). */
    legacy: source
  };
}

export interface ToRecordsOptions {
  libraryId: string;
  now?: () => number;
  /**
   * Proceed even when some rows fail runtime validation.
   *
   * Default is `false`, and that is the important part for a switch: a row that cannot
   * be represented must stop the whole write, because "switched to v3, silently minus
   * one bookmark" is a data-loss event nobody would notice. Passing `true` is a
   * deliberate "I have read the report" decision.
   */
  allowDrop?: boolean;
}

/** Map a whole HubState into v3 records, one array per store. */
export function toV3Records(state: HubState, options: ToRecordsOptions): {
  records: Record<string, unknown[]>;
  report: AdapterReport;
} {
  const libraryId = options.libraryId;
  const now = options.now ? options.now() : Date.now();
  const report: AdapterReport = { dropped: 0, danglingLinks: 0, leftOnDevice: [], problems: [] };
  const out: Record<string, unknown[]> = Object.fromEntries(LIBRARY_STORES.map((store) => [store, []]));

  const push = (store: string, record: unknown) => {
    out[store].push(record);
  };

  // --- items: notes ---------------------------------------------------------
  const noteProjects = new Map<string, string[]>();
  for (const project of state.projects ?? []) {
    for (const noteId of project.noteIds ?? []) {
      if (!noteProjects.has(noteId)) noteProjects.set(noteId, []);
      noteProjects.get(noteId)!.push(project.id);
    }
  }
  for (const note of state.notes ?? []) {
    const row = baseRow(libraryId, note.id, note as unknown as Record<string, unknown>, now);
    push(STORES.items, {
      ...row,
      kind: 'note',
      title: note.title || '(无标题)',
      tags: strArray(note.tags),
      projectIds: noteProjects.get(note.id) ?? []
    } satisfies ItemMeta);
    push(STORES.noteBodies, {
      libraryId,
      itemId: note.id,
      markdown: note.content ?? '',
      revision: 1,
      updatedAt: row.updatedAt
    } satisfies NoteBody);
  }

  // --- items: bookmarks (sites) --------------------------------------------
  for (const site of state.sites ?? []) {
    if (!site.url || !site.url.trim()) {
      // A bookmark without a URL is not representable in any model; say so instead of
      // writing a row that can never be opened. Counted as dropped so the switch stops.
      report.dropped += 1;
      report.problems.push(`bookmark:${site.id} 没有网址，无法作为收藏写入`);
      continue;
    }
    const row = baseRow(libraryId, site.id, site as unknown as Record<string, unknown>, now);
    push(STORES.items, {
      ...row,
      kind: 'bookmark',
      title: site.title || site.url,
      tags: strArray(site.tags),
      projectIds: [],
      sourceTitle: site.url
    } satisfies ItemMeta);
    push(STORES.bookmarks, {
      libraryId,
      itemId: site.id,
      url: site.url,
      groupId: site.category,
      position: typeof site.order === 'number' ? site.order : 0,
      pinned: Boolean(site.pinned),
      visitCount: nowOf(site.visitCount, 0),
      lastVisited: site.lastVisited
    } satisfies Bookmark);
  }

  // --- items: annotations (local + wucai) ---------------------------------
  const annotationRows: Array<{ item: ItemMeta; page: WebPage; annotation: Annotation }> = [];
  for (const annotation of state.annotations ?? []) {
    annotationRows.push(mapAnnotation(libraryId, annotation as unknown as Record<string, unknown>, 'local', now));
  }
  for (const highlight of state.wucaiHighlights ?? []) {
    annotationRows.push(mapAnnotation(libraryId, highlight as unknown as Record<string, unknown>, 'wucai', now));
  }
  for (const entry of annotationRows) {
    push(STORES.items, entry.item);
    push(STORES.webpages, entry.page);
    push(STORES.annotations, entry.annotation);
  }

  // --- items: drawings (handwritings) --------------------------------------
  for (const drawing of state.handwritings ?? []) {
    const row = baseRow(libraryId, drawing.id, drawing as unknown as Record<string, unknown>, now);
    push(STORES.items, {
      ...row,
      kind: 'drawing',
      title: drawing.title || '(无标题手绘)',
      tags: strArray(drawing.tags),
      projectIds: []
    } satisfies ItemMeta);
    const blobId = `blob:${drawing.id}`;
    push(STORES.blobs, { libraryId, id: blobId, dataUrl: drawing.dataUrl ?? '' });
    push(STORES.attachments, {
      libraryId,
      id: `att:${drawing.id}`,
      itemId: drawing.id,
      name: `${drawing.title || drawing.id}.png`,
      mime: 'image/png',
      size: (drawing.dataUrl ?? '').length,
      location: 'local',
      localBlobId: blobId,
      availability: drawing.dataUrl ? 'available' : 'missing'
    } satisfies AttachmentMeta);
  }

  // --- projects + links ----------------------------------------------------
  const knownIds = new Set<string>([
    ...(state.notes ?? []).map((note) => note.id),
    ...(state.sites ?? []).map((site) => site.id),
    ...(state.servers ?? []).map((server) => server.id),
    ...(state.reminders ?? []).map((reminder) => reminder.id),
    ...(state.secrets ?? []).map((secret) => secret.id)
  ]);
  for (const project of state.projects ?? []) {
    const row = baseRow(libraryId, project.id, project as unknown as Record<string, unknown>, now);
    push(STORES.projects, {
      ...row,
      name: project.name,
      description: project.description ?? '',
      status: project.status ?? 'active',
      repoUrl: project.repoUrl,
      deployUrl: project.deployUrl,
      decisions: (project.decisions ?? []).map((decision) => ({
        date: nowOf(decision.date, 0),
        title: decision.title,
        note: decision.note
      }))
    } satisfies Project);

    const refs: Array<[string, string[] | undefined]> = [
      ['note', project.noteIds],
      ['bookmark', project.siteIds],
      ['server', project.serverIds],
      ['reminder', project.reminderIds],
      ['credential', project.secretIds]
    ];
    for (const [toType, ids] of refs) {
      for (const toId of ids ?? []) {
        if (!knownIds.has(toId)) {
          // Old data points at deleted rows; keep it in `legacy`, report the count.
          report.danglingLinks += 1;
          continue;
        }
        push(STORES.links, {
          libraryId,
          id: `link:${project.id}:${toType}:${toId}`,
          fromType: 'project',
          fromId: project.id,
          toType,
          toId,
          relation: 'related',
          createdAt: nowOf(project.createdAt, 0)
        } satisfies EntityLink);
      }
    }
  }

  // --- servers -------------------------------------------------------------
  for (const server of state.servers ?? []) {
    const row = baseRow(libraryId, server.id, server as unknown as Record<string, unknown>, now);
    push(STORES.servers, {
      ...row,
      name: server.name,
      env: server.env ?? 'prod',
      addresses: {
        publicIp: server.publicIp,
        internalIp: server.internalIp,
        domain: server.domain,
        port: server.port
      },
      sshOptions: { user: server.sshUser, port: server.sshPort, command: server.sshCommand },
      healthUrl: server.healthUrl,
      lastProbe: server.lastCheckedAt
        ? {
            observedAt: server.lastCheckedAt,
            latencyMs: server.lastLatencyMs,
            outcome:
              server.status === 'online' ? 'online' : server.status === 'offline' ? 'offline' : 'unknown',
            safeMessage: server.lastCheckMessage
          }
        : undefined,
      expiresOn: toLocalDate(server.expiresAt),
      notes: server.notes
    } satisfies Server);
  }

  // --- credentials (vault ciphertext, unchanged) ---------------------------
  for (const secret of state.secrets ?? []) {
    const row = baseRow(libraryId, secret.id, secret as unknown as Record<string, unknown>, now);
    push(STORES.credentials, {
      ...row,
      name: secret.name,
      category: secret.category ?? 'other',
      // Ciphertext is copied verbatim: P1/P2 never re-encrypt without a migration.
      encryptedValue: secret.encryptedValue,
      iv: secret.iv,
      salt: secret.salt,
      cryptoVersion: 1,
      maskedPreview: secret.maskedPreview,
      expiresOn: toLocalDate(secret.expiresAt)
    } satisfies Credential);
  }

  // --- reminders -----------------------------------------------------------
  for (const reminder of state.reminders ?? []) {
    const row = baseRow(libraryId, reminder.id, reminder as unknown as Record<string, unknown>, now);
    const occurrences = (reminder.occurrences ?? []).map((occurrence) => ({
      dueOn: toLocalDate(occurrence.dueAt) ?? toLocalDate(reminder.targetDate) ?? '',
      at: nowOf(occurrence.at, 0),
      action: occurrence.action,
      nextDueOn: toLocalDate(occurrence.nextDueAt)
    }));
    push(STORES.reminders, {
      ...row,
      title: reminder.title,
      dueOn: toLocalDate(reminder.targetDate) ?? '',
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      recurrence: reminder.recurring ?? 'once',
      anchorDay: reminder.anchorDay,
      status: reminder.completed ? 'completed' : 'open',
      occurrences
    } satisfies Reminder);
  }

  // --- domains -------------------------------------------------------------
  for (const domain of state.domains ?? []) {
    const row = baseRow(libraryId, domain.id, domain as unknown as Record<string, unknown>, now);
    push(STORES.domains, {
      ...row,
      name: domain.name,
      registrar: domain.registrar,
      dns: domain.dns,
      url: domain.url,
      note: domain.note,
      startAt: nowOf(domain.startAt, 0) || undefined,
      expireAt: nowOf(domain.expireAt, 0) || undefined
    } satisfies DomainRow);
  }

  // --- check-ins + runs ---------------------------------------------------
  for (const task of state.checkIns ?? []) {
    const row = baseRow(libraryId, task.id, task as unknown as Record<string, unknown>, now);
    push(STORES.checkins, {
      ...row,
      name: task.name,
      targetUrl: task.url,
      method: task.method ?? 'GET',
      executionMode: task.type === 'redirect' ? 'open_page' : 'http',
      schedulePolicy: { enabled: task.enabled !== false, kind: 'daily' }
    } satisfies CheckInTask);
    for (const [index, run] of (task.history ?? []).entries()) {
      push(STORES.checkinRuns, {
        libraryId,
        id: `${task.id}:run:${index}`,
        taskId: task.id,
        startedAt: nowOf(run.at, 0),
        finishedAt: nowOf(run.at, 0),
        outcome: run.status === 'success' ? 'http_success' : 'http_failure',
        safeMessage: run.message
      } satisfies CheckInRun);
    }
  }

  // --- inbox ---------------------------------------------------------------
  for (const entry of state.inbox ?? []) {
    const row = baseRow(libraryId, entry.id, entry as unknown as Record<string, unknown>, now);
    push(STORES.inbox, {
      ...row,
      rawText: entry.content ?? '',
      url: entry.url,
      status: entry.status ?? 'inbox',
      resultRefs: entry.targetId
        ? [{ type: (entry.targetType ?? 'note') as 'note' | 'bookmark' | 'project', id: entry.targetId, at: row.updatedAt }]
        : [],
      operationId: entry.operationId || `legacy:${entry.id}`,
      source: entry.source ?? 'inbox'
    } satisfies InboxEntry);
  }

  // --- remote documents (index + cached body) -----------------------------
  for (const note of state.obsidianNotes ?? []) {
    // The cached body lives in a blob, not in the metadata record: a remote index row
    // should stay small, and the body is what makes it searchable when the network is
    // gone. Without this the body would only survive in `legacy`.
    const cachedBodyRef = note.content ? `remote:${note.key}` : undefined;
    if (note.content) {
      push(STORES.blobs, { libraryId, id: cachedBodyRef, text: note.content });
    }
    push(STORES.remoteDocs, {
      libraryId,
      id: note.key,
      connectionId: 'oss',
      key: note.key,
      etag: undefined,
      modifiedAt: note.lastModified,
      size: note.size,
      cachedBodyRef,
      cacheState: note.content ? 'cached' : 'not-cached',
      legacy: note
    } satisfies RemoteDocument & { legacy: unknown });
  }

  // --- preferences ---------------------------------------------------------
  push(STORES.settings, {
    libraryId,
    homeBlocks: state.homeBlocks ?? [],
    navPins: [],
    theme: state.theme ?? 'dark',
    density: 'comfortable',
    searchEngines: [],
    onboardingVersion: 1
  });

  // Device-local: connections/secrets, flags that belong to this browser.
  report.leftOnDevice = [
    'OSS / WebDAV / AI / 五彩 / 有道 / 同步连接与密钥（按设备重新填写并测试）',
    '设备信任材料与会话（从不进入库）',
    '模块开关与示例批次标记（本机偏好）'
  ];

  // Validate before anything is written: a shape error must not reach a transaction.
  for (const [store, rows] of Object.entries(out)) {
    if (rows.length === 0) continue;
    const issues = validateRecords(store, rows);
    if (issues.length > 0) {
      report.dropped += issues.length;
      report.problems.push(
        `${store}: ${issues.length} 条记录未通过运行时校验（例：第 ${issues[0].index} 条 ${issues[0].issues[0]?.field}）`
      );
      out[store] = rows.filter((_, index) => !issues.some((issue) => issue.index === index));
    }
  }

  return { records: out, report };
}

function mapAnnotation(
  libraryId: string,
  source: Record<string, unknown>,
  origin: 'local' | 'wucai',
  now: number
): { item: ItemMeta; page: WebPage; annotation: Annotation } {
  const id = String(source.id ?? '');
  const row = baseRow(libraryId, id, source, now);
  const pageUrl = String(source.pageUrl ?? '');
  const pageTitle = String(source.pageTitle ?? '');
  const text = String(source.text ?? '');
  const note = typeof source.note === 'string' && source.note ? source.note : undefined;
  const anchor = source.anchor as Annotation['anchor'] | undefined;
  const projectIds = typeof source.projectId === 'string' && source.projectId ? [source.projectId] : [];

  return {
    item: {
      ...row,
      kind: 'webpage',
      title: pageTitle || pageUrl || '(未命名网页)',
      tags: strArray(source.tags),
      projectIds,
      sourceRef: { type: origin, id },
      sourceTitle: pageUrl
    },
    page: {
      libraryId,
      itemId: id,
      canonicalUrl: pageUrl,
      originalUrl: pageUrl,
      pageTitle,
      capturedAt: row.createdAt
    },
    annotation: {
      libraryId,
      id,
      pageItemId: id,
      quote: text,
      comment: note,
      color: String(source.color ?? 'yellow'),
      tags: strArray(source.tags),
      anchor,
      // Old anchors were never validated against the page; "ambiguous" is the honest
      // state until the anchor can be resolved again.
      anchorState: anchor ? 'attached' : 'ambiguous',
      revision: 1,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      // Same transitional snapshot as the item row: the annotation record is what the
      // reader restores from, so it has to carry it too.
      legacy: source
    } as Annotation & { legacy: Record<string, unknown> }
  };
}

/* -------------------------------------------------------------------------- */
/* Write / read                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Replace this library's business data with `state`.
 *
 * One transaction across every store, so a failure leaves the previous library intact
 * rather than half rewritten (§6.4). Success is reported only after `oncomplete`.
 */
export async function writeLibrary(
  state: HubState,
  options: ToRecordsOptions
): Promise<Result<AdapterWriteResult>> {
  const libraryId = options.libraryId;
  const { records, report } = toV3Records(state, options);
  // Refuse rather than drop: see `allowDrop`. This happens *before* the transaction, so
  // a refused switch cannot have touched the existing library.
  if (report.dropped > 0 && !options.allowDrop) {
    return fail(
      toAppError(
        Object.assign(new Error(report.problems.join('; ')), {
          code: 'VALIDATION',
          userMessage: `有 ${report.dropped} 条记录无法写入 v3 模型，本次没有切换。请先查看报告（${report.problems[0] ?? ''}）。`,
          retryable: false,
          suggestedAction: 'review_report'
        }),
        '无法写入本机 v3 库'
      )
    );
  }
  const counts: Record<string, number> = {};
  for (const [store, rows] of Object.entries(records)) counts[store] = rows.length;
  const written: Record<string, number> = {};
  const deleted: Record<string, number> = {};

  try {
    const hashes: Record<string, string> = {};
    const revision = await runV3Transaction(LIBRARY_STORES, 'readwrite', async (ctx) => {
      for (const store of LIBRARY_STORES) {
        const objectStore = ctx.store(store);
        const nextRows = records[store] ?? [];
        const def = storeDef(store);
        const keyPath = Array.isArray(def?.keyPath) ? (def.keyPath as string[]) : null;

        // Settings is one row per library, replaced in place.
        if (store === STORES.settings) {
          written[store] = 0;
          continue;
        }
        if (!keyPath) continue;

/**
 * Skip stores whose input cannot have changed since our last successful write.
 * The read+compare below is what a save costs, and it is not free: on a 6,600-record
 * library a no-op save measured ~500 ms, almost all of it reading every row back and
 * · The adapter is the only writer of a v3 library (migrations create a *new* library,
 */
/**
 * `JSON.stringify` here, not `stableJson`.
 * Both are safe for this decision, in opposite ways: a *false* "different" only costs
 * one store's read, while a false "same" is impossible — different content cannot
 */
        const inputHash = JSON.stringify(nextRows);
        hashes[store] = inputHash;
        if (writtenHashes.get(libraryId)?.get(store) === inputHash) {
          written[store] = 0;
          deleted[store] = 0;
          continue;
        }

/**
 * Incremental write.
 * Replacing the whole library on every save (the first version) means a one-note
 * edit rewrites thousands of records: slow on a real library, and it makes every
 * · save look like a bulk operation to anything watching revision numbers. Here only
 */
        const range = IDBKeyRange.bound([libraryId], [libraryId, []]);
        const [existingKeys, existingValues] = await Promise.all([
          requestToPromise(objectStore.getAllKeys(range) as IDBRequest<IDBValidKey[]>),
          requestToPromise(objectStore.getAll(range) as IDBRequest<unknown[]>)
        ]);
        const existingByKey = new Map<string, { key: IDBValidKey; json: string }>();
        existingKeys.forEach((key, index) => {
          // Both sides use `JSON.stringify`, for the same reason as `inputHash`: identical
          // content in a different key order counts as changed and costs one needless write,
          // which is safe; the reverse (different content, same string) cannot happen. On
          // 6,600 records this was worth ~70 ms per save over the order-insensitive
          // comparator, and the read-back plus this comparison is what a save now costs.
          existingByKey.set(JSON.stringify(key), { key, json: JSON.stringify(existingValues[index]) });
        });

        let put = 0;
        let removed = 0;
        const nextKeys = new Set<string>();
        for (const row of nextRows) {
          const record = row as Record<string, unknown>;
          const key = keyPath.map((field) => record[field] as string);
          const keyId = JSON.stringify(key);
          nextKeys.add(keyId);
          const existing = existingByKey.get(keyId);
          if (existing && existing.json === JSON.stringify(record)) continue;
          objectStore.put(record);
          put += 1;
        }
        for (const [keyId, entry] of existingByKey) {
          if (nextKeys.has(keyId)) continue;
          objectStore.delete(entry.key);
          removed += 1;
        }
        written[store] = put;
        deleted[store] = removed;
      }

      // `settings_v3` has keyPath ['libraryId'], so its key is the *array* [libraryId].
      // Reading it with the bare string always missed, which pinned the content revision
      // at 1 forever (caught by the incremental-write test).
      const previous = (await requestToPromise(
        ctx.store(STORES.settings).get([libraryId]) as IDBRequest<{ contentRevision?: number } | undefined>
      )) ?? { contentRevision: 0 };
      const next = (nowOf(previous.contentRevision, 0) || 0) + 1;
      for (const row of records[STORES.settings]) {
        ctx.store(STORES.settings).put({ ...(row as Record<string, unknown>), contentRevision: next });
      }
      return next;
    });
    // Record the input hashes only after the transaction committed: a rolled-back write must
    // not make the next save believe the library already holds it.
    writtenHashes.set(libraryId, new Map(Object.entries(hashes)));
    return ok({ revision: revision.value, counts, written, deleted, report });
  } catch (err) {
    writtenHashes.delete(libraryId);
    return fail(toAppError(err, '无法写入本机 v3 库'));
  }
}

/** Key-order-stable JSON, so a record compares equal regardless of field order. */
function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(',')}}`;
}

/** Read this library's business data back into HubState shape. */
export async function readLibrary(libraryId: string): Promise<Result<AdapterReadResult>> {
  const report: AdapterReport = { dropped: 0, danglingLinks: 0, leftOnDevice: [], problems: [] };
  try {
    const snapshot = await runV3Transaction(LIBRARY_STORES, 'readonly', async (ctx) => {
      const read = async <T>(store: string): Promise<T[]> =>
        requestToPromise(ctx.store(store).getAll() as IDBRequest<T[]>);
      return {
        items: await read<ItemMeta & { legacy?: Record<string, unknown> }>(STORES.items),
        bodies: await read<NoteBody>(STORES.noteBodies),
        bookmarks: await read<Bookmark>(STORES.bookmarks),
        annotations: await read<Annotation & { legacy?: Record<string, unknown> }>(STORES.annotations),
        inbox: await read<InboxEntry & { legacy?: Record<string, unknown> }>(STORES.inbox),
        projects: await read<Project & { legacy?: Record<string, unknown> }>(STORES.projects),
        servers: await read<Server & { legacy?: Record<string, unknown> }>(STORES.servers),
        credentials: await read<Credential & { legacy?: Record<string, unknown> }>(STORES.credentials),
        reminders: await read<Reminder & { legacy?: Record<string, unknown> }>(STORES.reminders),
    domains: await read<DomainRow & { legacy?: Record<string, unknown> }>(STORES.domains),
        checkins: await read<CheckInTask & { legacy?: Record<string, unknown> }>(STORES.checkins),
        runs: await read<CheckInRun>(STORES.checkinRuns),
        remoteDocs: await read<RemoteDocument & { legacy?: Record<string, unknown> }>(STORES.remoteDocs),
        blobs: await read<{ libraryId: string; id: string; text?: string; dataUrl?: string }>(STORES.blobs),
        settings: await read<Record<string, unknown>>(STORES.settings)
      };
    });
    const value = snapshot.value;
    const libraryRows = <T extends { libraryId?: string }>(rows: T[]) => rows.filter((row) => row.libraryId === libraryId);
    const counts: Record<string, number> = {};

/**
 * Prefer the preserved v2 row.
 * The adapter writes both the v3 fields *and* the original row (`legacy`). Reading
 * back the original when it exists is what makes the round trip exact: synthesising
 * · from v3 fields would add defaults the user never had (`tags: []` on a note that
 */
    const preserved = <T>(legacy: unknown, fallback: T): T => {
      if (legacy && typeof legacy === 'object' && Object.keys(legacy as Record<string, unknown>).length > 0) {
        return legacy as T;
      }
      return fallback;
    };

    const bodies = new Map(libraryRows(value.bodies).map((body) => [body.itemId, body]));
    const bookmarks = new Map(libraryRows(value.bookmarks).map((bookmark) => [bookmark.itemId, bookmark]));
    const items = libraryRows(value.items);

    const notes: HubState['notes'] = [];
    const sites: HubState['sites'] = [];
    for (const item of items) {
      if (item.deletedAt) continue;
      if (item.kind === 'note') {
        const body = bodies.get(item.id);
        notes.push(
          preserved(item.legacy, {
            id: item.id,
            title: item.title,
            content: body?.markdown ?? '',
            tags: item.tags,
            updatedAt: item.updatedAt
          } as HubState['notes'][number])
        );
      } else if (item.kind === 'bookmark') {
        const bookmark = bookmarks.get(item.id);
        sites.push(
          preserved(item.legacy, {
            id: item.id,
            title: item.title,
            url: bookmark?.url ?? '',
            category: bookmark?.groupId ?? '默认',
            pinned: bookmark?.pinned,
            visitCount: bookmark?.visitCount,
            lastVisited: bookmark?.lastVisited,
            order: bookmark?.position,
            createdAt: item.createdAt
          } as HubState['sites'][number])
        );
      }
    }
    notes.sort((a, b) => b.updatedAt - a.updatedAt);
    sites.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

    const annotations: NonNullable<HubState['annotations']> = [];
    const wucaiHighlights: NonNullable<HubState['wucaiHighlights']> = [];
    for (const annotation of libraryRows(value.annotations)) {
      if (annotation.deletedAt) continue;
      const item = items.find((entry) => entry.id === annotation.pageItemId);
      const legacy = annotation.legacy ?? {};
      const row = preserved(annotation.legacy, {
        ...legacy,
        id: annotation.id,
        pageTitle: item?.title ?? '',
        pageUrl: String((item as { sourceTitle?: string } | undefined)?.sourceTitle ?? ''),
        text: annotation.quote,
        note: annotation.comment,
        color: annotation.color,
        tags: annotation.tags,
        anchor: annotation.anchor,
        createdAt: annotation.createdAt,
        updatedAt: annotation.updatedAt
      });
      if (item?.sourceRef?.type === 'wucai') wucaiHighlights.push(row as never);
      else annotations.push(row as never);
    }

    const handwritings: HubState['handwritings'] = items
      .filter((item) => item.kind === 'drawing' && !item.deletedAt)
      .map((item) =>
        preserved(item.legacy, {
          id: item.id,
          title: item.title,
          dataUrl: String((item.legacy ?? {}).dataUrl ?? ''),
          tags: item.tags,
          createdAt: item.createdAt
        })
      ) as HubState['handwritings'];

    const projects = libraryRows(value.projects).map((project) =>
      preserved(project.legacy, {
        id: project.id,
        name: project.name,
        description: project.description,
        status: project.status,
        repoUrl: project.repoUrl,
        deployUrl: project.deployUrl,
        decisions: project.decisions,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt
      })
    ) as NonNullable<HubState['projects']>;

    const servers = libraryRows(value.servers).map((server) => {
      const legacy = (server.legacy ?? {}) as Record<string, unknown>;
      return preserved(server.legacy, {
        id: server.id,
        name: server.name,
        env: server.env,
        publicIp: server.addresses?.publicIp ?? String(legacy.publicIp ?? ''),
        internalIp: server.addresses?.internalIp,
        domain: server.addresses?.domain,
        port: server.addresses?.port,
        sshUser: server.sshOptions?.user,
        sshPort: server.sshOptions?.port,
        sshCommand: server.sshOptions?.command,
        healthUrl: server.healthUrl,
        notes: server.notes,
        status: server.lastProbe?.outcome === 'online' ? 'online' : server.lastProbe?.outcome === 'offline' ? 'offline' : 'unknown',
        lastCheckedAt: server.lastProbe?.observedAt,
        lastLatencyMs: server.lastProbe?.latencyMs,
        lastCheckMessage: server.lastProbe?.safeMessage,
        expiresAt: server.expiresOn ? fromLocalDate(server.expiresOn, 0) : undefined,
        createdAt: server.createdAt
      });
    }) as HubState['servers'];

    const secrets = libraryRows(value.credentials).map((credential) =>
      preserved(credential.legacy, {
        id: credential.id,
        name: credential.name,
        category: credential.category,
        encryptedValue: credential.encryptedValue,
        iv: credential.iv,
        salt: credential.salt,
        maskedPreview: credential.maskedPreview,
        expiresAt: credential.expiresOn ? fromLocalDate(credential.expiresOn, 0) : undefined,
        updatedAt: credential.updatedAt
      })
    ) as HubState['secrets'];

    const domains = libraryRows(value.domains).map((domain) =>
      preserved(domain.legacy, {
        id: domain.id,
        name: domain.name,
        startAt: domain.startAt,
        expireAt: domain.expireAt,
        registrar: domain.registrar,
        dns: domain.dns,
        url: domain.url,
        note: domain.note,
        createdAt: domain.createdAt,
        updatedAt: domain.updatedAt
      })
    ) as HubState['domains'];

    const reminders = libraryRows(value.reminders).map((reminder) =>
      preserved(reminder.legacy, {
        id: reminder.id,
        title: reminder.title,
        targetDate: reminder.legacy
          ? nowOf((reminder.legacy as Record<string, unknown>).targetDate, fromLocalDate(reminder.dueOn, 0))
          : fromLocalDate(reminder.dueOn, 0),
        recurring: reminder.recurrence,
        anchorDay: reminder.anchorDay,
        completed: reminder.status === 'completed',
        occurrences: (reminder.occurrences ?? []).map((occurrence) => ({
          dueAt: fromLocalDate(occurrence.dueOn, 0),
          at: occurrence.at,
          action: occurrence.action,
          nextDueAt: occurrence.nextDueOn ? fromLocalDate(occurrence.nextDueOn, 0) : undefined
        })),
        createdAt: reminder.createdAt
      })
    ) as HubState['reminders'];

    const runsByTask = new Map<string, CheckInRun[]>();
    for (const run of libraryRows(value.runs)) {
      if (!runsByTask.has(run.taskId)) runsByTask.set(run.taskId, []);
      runsByTask.get(run.taskId)!.push(run);
    }
    const checkIns = libraryRows(value.checkins).map((task) =>
      preserved(task.legacy, {
        id: task.id,
        name: task.name,
        url: task.targetUrl,
        method: task.method,
        type: task.executionMode === 'open_page' ? 'redirect' : 'http',
        enabled: task.schedulePolicy?.enabled ?? true,
        history: (runsByTask.get(task.id) ?? []).map((run) => ({
          at: run.startedAt,
          status: run.outcome === 'http_success' ? 'success' : 'failed',
          message: run.safeMessage ?? ''
        })),
        createdAt: task.createdAt
      })
    ) as HubState['checkIns'];

    const inbox = libraryRows(value.inbox).map((entry) =>
      preserved(entry.legacy, {
        id: entry.id,
        content: entry.rawText,
        url: entry.url,
        status: entry.status,
        targetType: entry.resultRefs[0]?.type,
        targetId: entry.resultRefs[0]?.id,
        operationId: entry.operationId,
        source: entry.source,
        createdAt: entry.createdAt
      })
    ) as NonNullable<HubState['inbox']>;

    const obsidianNotes = libraryRows(value.remoteDocs).map((doc) => {
      const row = preserved(doc.legacy, {
        key: doc.key,
        title: String((doc.legacy ?? {}).title ?? doc.key),
        path: doc.key,
        size: doc.size ?? 0,
        lastModified: doc.modifiedAt ?? 0
      }) as Record<string, unknown>;
      // Bodies written by the migration (no `legacy`) come back from the blob store.
      const ref = doc.cachedBodyRef ?? `remote:${doc.key}`;
      const cached = libraryRows(value.blobs).find((blob) => blob.id === ref);
      if (!row.content && cached && typeof (cached as { text?: unknown }).text === 'string') {
        return { ...row, content: (cached as { text: string }).text };
      }
      return row;
    }) as unknown as NonNullable<HubState['obsidianNotes']>;

    const settings = value.settings.find((row) => row.libraryId === libraryId) as
      | { homeBlocks?: HubState['homeBlocks']; theme?: HubState['theme'] }
      | undefined;

    counts.items = items.length;
    counts.notes = notes.length;
    counts.sites = sites.length;
    counts.annotations = annotations.length + wucaiHighlights.length;
    counts.handwritings = handwritings.length;
    counts.projects = projects.length;
    counts.servers = servers.length;
    counts.credentials = secrets.length;
    counts.reminders = reminders.length;
    counts.checkIns = checkIns.length;
    counts.inbox = inbox.length;
    counts.obsidianNotes = obsidianNotes.length;

    return ok({
      state: {
        notes,
        sites,
        annotations,
        wucaiHighlights,
        handwritings,
        projects,
        servers,
        secrets,
        domains,
        reminders,
        checkIns,
        inbox,
        obsidianNotes,
        categories: Array.from(new Set(sites.map((site) => site.category).filter(Boolean))),
        theme: settings?.theme ?? 'dark',
        homeBlocks: settings?.homeBlocks
      },
      counts,
      report
    });
  } catch (err) {
    return fail(toAppError(err, '无法读取本机 v3 库'));
  }
}

/**
 * Compose a full HubState from a v3 library read plus this device's configuration.
 *
 * The v3 library is the business data; the connection objects (and the module switches)
 * stay on the device. This is the function a switched app would call on boot.
 */
export function mergeDeviceConfig(library: Partial<HubState>, device: HubState): HubState {
  return {
    ...device,
    ...library,
    // Never let a library read blank the device's own connections or flags.
    obsidianConfig: device.obsidianConfig,
    webdavConfig: device.webdavConfig,
    aiConfig: device.aiConfig,
    wucaiConfig: device.wucaiConfig,
    youdaoConfig: device.youdaoConfig,
    cloudflareSync: device.cloudflareSync,
    features: device.features,
    purposes: device.purposes,
    sampleBatch: device.sampleBatch,
    backupPolicy: device.backupPolicy
  };
}
