/**
 * IndexedDB implementation of the repository contract (P2-01).
 * This is the P2 fact source. It is written now, beside the v2 payload, so the
 * migration in P2-02 has something verified to migrate *into*.
 * · resolves on that event only, never on a request's `onsuccess`.
 */
import type { EntityLink, InboxEntry, ItemMeta, NoteBody, Project } from '../domain/model';
import { MODEL_VERSION } from '../domain/model';
import {
  requestToPromise,
  runV3Transaction,
  toKeyRange,
  type TxContext
} from '../infrastructure/storage/idbV3';
import { validateRecord } from './schema';
import { NotFoundError, appError, fail, ok, toAppError, type Result } from './errors';
import {
  emitChange,
  type CaptureInboxInput,
  type CaptureInboxOutput,
  type ChangeEvent,
  type ConvertInboxOutput,
  type ConvertTarget,
  type CreateProjectInput,
  type HubRepository,
  type ListItemsOptions,
  type RepositoryKind,
  type SaveNoteInput,
  type SaveNoteOutput,
  validationFailure
} from './contract';

const ITEMS = 'items_v3';
const BODIES = 'note_bodies_v3';
const INBOX = 'inbox_v3';
const ATTACHMENTS = 'attachments_v3';
const LINKS = 'entity_links_v3';
const PROJECTS = 'projects_v3';
const SETTINGS = 'settings_v3';
const LIBRARY_META = 'library_meta_v3';

const CONTENT_REVISION_KEY = (libraryId: string) => `content-revision:${libraryId}`;

function revisionKey(libraryId: string): string {
  return `revision:${libraryId}`;
}

export interface IndexedDbRepositoryOptions {
  libraryId: string;
  /** Injectable clock so tests do not depend on wall time. */
  now?: () => number;
  /** Injectable id factory so tests can assert on stable ids. */
  newId?: (prefix: string) => string;
}

function defaultNewId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export class IndexedDbRepository implements HubRepository {
  readonly kind: RepositoryKind = 'indexeddb';
  ready = false;

  private readonly libraryId: string;
  private readonly now: () => number;
  private readonly newId: (prefix: string) => string;
  private readonly listeners = new Set<(e: ChangeEvent) => void>();
  private contentRevision = 0;

  constructor(options: IndexedDbRepositoryOptions) {
    this.libraryId = options.libraryId;
    this.now = options.now ?? (() => Date.now());
    this.newId = options.newId ?? defaultNewId;
  }

  async init(): Promise<Result<void>> {
    try {
      await runV3Transaction([LIBRARY_META], 'readwrite', async (ctx) => {
        const store = ctx.store(LIBRARY_META);
        const existing = await requestToPromise(store.get(CONTENT_REVISION_KEY(this.libraryId)));
        if (!existing) {
          store.put({ key: CONTENT_REVISION_KEY(this.libraryId), value: 0, libraryId: this.libraryId, at: this.now() });
          store.put({ key: revisionKey(this.libraryId), value: 0, libraryId: this.libraryId, at: this.now() });
        }
      });
      const revision = await this.getContentRevision();
      if (revision.ok) this.contentRevision = revision.value;
      this.ready = true;
      return ok(undefined);
    } catch (err) {
      return fail(toAppError(err, '无法初始化本地数据库'));
    }
  }

  close(): void {
    this.ready = false;
    this.listeners.clear();
  }

  subscribe(listener: (event: ChangeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async getContentRevision(): Promise<Result<number>> {
    try {
      const value = await runV3Transaction([LIBRARY_META], 'readonly', async (ctx) => {
        const row = (await requestToPromise(
          ctx.store(LIBRARY_META).get(CONTENT_REVISION_KEY(this.libraryId))
        )) as { value?: number } | undefined;
        return Number(row?.value) || 0;
      });
      this.contentRevision = value.value;
      return ok(value.value);
    } catch (err) {
      return fail(toAppError(err, '无法读取本地数据版本'));
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Reads                                                                   */
  /* ---------------------------------------------------------------------- */

  async listItems(options: ListItemsOptions = {}): Promise<Result<ItemMeta[]>> {
    try {
      const result = await runV3Transaction([ITEMS], 'readonly', async (ctx) => {
        const store = ctx.store(ITEMS);
        const rows = await requestToPromise(store.getAll() as IDBRequest<ItemMeta[]>);
        return rows.filter((row) => this.itemMatches(row, options));
      });
      let rows = result.value;
      if (options.limit && options.limit > 0) rows = rows.slice(0, options.limit);
      rows.sort((a, b) => b.updatedAt - a.updatedAt);
      return ok(rows);
    } catch (err) {
      return fail(toAppError(err, '无法读取资料列表'));
    }
  }

  private itemMatches(item: ItemMeta, options: ListItemsOptions): boolean {
    if (item.libraryId !== this.libraryId) return false;
    if (!options.includeDeleted && item.deletedAt) return false;
    if (options.kind && item.kind !== options.kind) return false;
    if (options.projectId && !(item.projectIds || []).includes(options.projectId)) return false;
    if (options.search) {
      const needle = options.search.toLowerCase();
      const haystack = `${item.title} ${(item.tags || []).join(' ')}`.toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    return true;
  }

  async getNote(
    itemId: string,
    options: { includeDeleted?: boolean } = {}
  ): Promise<Result<{ item: ItemMeta; body: NoteBody } | undefined>> {
    try {
      const result = await runV3Transaction([ITEMS, BODIES], 'readonly', async (ctx) => {
        const item = (await requestToPromise(
          ctx.store(ITEMS).get([this.libraryId, itemId])
        )) as ItemMeta | undefined;
        if (!item) return undefined;
        // A soft-deleted row is not readable as a normal note: the recycle bin
        // uses an explicit flag rather than every caller remembering to check.
        if (item.deletedAt && !options.includeDeleted) return undefined;
        const body = (await requestToPromise(
          ctx.store(BODIES).get([this.libraryId, itemId])
        )) as NoteBody | undefined;
        if (!body) return undefined;
        return { item, body };
      });
      return ok(result.value);
    } catch (err) {
      return fail(toAppError(err, '无法读取笔记'));
    }
  }

  async listLinks(options: { fromId?: string; toId?: string } = {}): Promise<Result<EntityLink[]>> {
    try {
      const result = await runV3Transaction([LINKS], 'readonly', async (ctx) => {
        const rows = await requestToPromise(ctx.store(LINKS).getAll() as IDBRequest<EntityLink[]>);
        return rows.filter(
          (row) =>
            row.libraryId === this.libraryId &&
            (!options.fromId || row.fromId === options.fromId) &&
            (!options.toId || row.toId === options.toId)
        );
      });
      return ok(result.value);
    } catch (err) {
      return fail(toAppError(err, '无法读取关联关系'));
    }
  }

  async listInbox(status?: InboxEntry['status']): Promise<Result<InboxEntry[]>> {
    try {
      const result = await runV3Transaction([INBOX], 'readonly', async (ctx) => {
        const rows = await requestToPromise(ctx.store(INBOX).getAll() as IDBRequest<InboxEntry[]>);
        return rows
          .filter((row) => row.libraryId === this.libraryId && (!status || row.status === status))
          .sort((a, b) => b.createdAt - a.createdAt);
      });
      return ok(result.value);
    } catch (err) {
      return fail(toAppError(err, '无法读取收件箱'));
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Writes                                                                  */
  /* ---------------------------------------------------------------------- */

  private assertValid(store: string, value: unknown): void {
    const issues = validateRecord(store, value);
    if (issues.length > 0) throw new Error(issues.map((i) => `${i.field}: ${i.message}`).join('; '));
  }

  /** Read the project ids that actually exist, to reject dangling references. */
  private async existingProjectIds(ctx: TxContext, ids: string[]): Promise<Set<string>> {
    const found = new Set<string>();
    for (const id of ids) {
      const row = await requestToPromise(ctx.store(PROJECTS).get([this.libraryId, id]));
      if (row) found.add(id);
    }
    return found;
  }

  async saveNote(input: SaveNoteInput): Promise<Result<SaveNoteOutput>> {
    const title = (input.title || '').trim();
    if (!title) {
      return fail(appError('VALIDATION', '笔记标题不能为空。', { safeDetail: 'empty title' }));
    }
    // `undefined` means "leave the links alone"; an array replaces them.
    const projectIds = input.projectIds === undefined ? undefined : Array.from(new Set(input.projectIds));
    const idsToVerify = projectIds ?? [];

    try {
      const result = await runV3Transaction([ITEMS, BODIES, PROJECTS, LINKS, LIBRARY_META], 'readwrite', async (ctx) => {
        // Referential check first: a dangling project reference is a rejection,
        // not something to store and clean up later. Because it happens inside
        // the same transaction, the item and body writes below never survive a
        // failure here.
        if (idsToVerify.length > 0) {
          const existing = await this.existingProjectIds(ctx, idsToVerify);
          const missing = idsToVerify.filter((id) => !existing.has(id));
          if (missing.length > 0) {
            throw new Error(`引用的项目不存在: ${missing.join(', ')}`);
          }
        }

        const now = this.now();
        const id = input.id ?? this.newId('note');
        const itemStore = ctx.store(ITEMS);
        const previous = (await requestToPromise(itemStore.get([this.libraryId, id]))) as ItemMeta | undefined;
        const revision = (previous?.revision ?? 0) + 1;
        const effectiveProjectIds = projectIds ?? previous?.projectIds ?? [];

        const item: ItemMeta = {
          libraryId: this.libraryId,
          id,
          kind: 'note',
          title,
          tags: input.tags ?? previous?.tags ?? [],
          projectIds: effectiveProjectIds,
          revision,
          createdAt: previous?.createdAt ?? now,
          updatedAt: now
        };
        const body: NoteBody = {
          libraryId: this.libraryId,
          itemId: id,
          markdown: input.markdown,
          revision,
          updatedAt: now
        };

        this.assertValid(ITEMS, item);
        this.assertValid(BODIES, body);
        itemStore.put(item);
        ctx.store(BODIES).put(body);

        // Only touch links when the caller stated the desired set.
        if (projectIds !== undefined) {
          const linkStore = ctx.store(LINKS);
          const existingLinks = (await requestToPromise(linkStore.getAll() as IDBRequest<EntityLink[]>)).filter(
            (link) =>
              link.libraryId === this.libraryId &&
              link.fromType === 'item' &&
              link.fromId === id &&
              link.relation === 'project'
          );
          for (const link of existingLinks) linkStore.delete([this.libraryId, link.id]);
          for (const projectId of projectIds) {
            const link: EntityLink = {
              libraryId: this.libraryId,
              id: `${id}::project::${projectId}`,
              fromType: 'item',
              fromId: id,
              toType: 'project',
              toId: projectId,
              relation: 'project',
              createdAt: now
            };
            this.assertValid(LINKS, link);
            linkStore.put(link);
          }
        }

        return { item, body };
      });

      const revision = await this.bumpContentRevision(result.value.item.id);
      if (!revision.ok) return fail(revision.error);
      return ok({ ...result.value, contentRevision: revision.value });
    } catch (err) {
      return fail(validationFailure(err));
    }
  }

  async deleteNote(itemId: string): Promise<Result<{ contentRevision: number }>> {
    try {
      await runV3Transaction([ITEMS, LINKS], 'readwrite', async (ctx) => {
        const itemStore = ctx.store(ITEMS);
        const item = (await requestToPromise(itemStore.get([this.libraryId, itemId]))) as ItemMeta | undefined;
        if (!item) throw new NotFoundError(`笔记不存在: ${itemId}`);
        // Soft delete: the recycle bin keeps it for 30 days (§6.1).
        itemStore.put({ ...item, deletedAt: this.now(), revision: item.revision + 1, updatedAt: this.now() });

        const linkStore = ctx.store(LINKS);
        const links = (await requestToPromise(linkStore.getAll() as IDBRequest<EntityLink[]>)).filter(
          (link) => link.libraryId === this.libraryId && link.fromId === itemId
        );
        for (const link of links) linkStore.delete([this.libraryId, link.id]);
      });
      const revision = await this.bumpContentRevision(itemId);
      if (!revision.ok) return fail(revision.error);
      return ok({ contentRevision: revision.value });
    } catch (err) {
      // A missing record is NOT_FOUND, not a data-shape problem; conflating them
      // sends the caller down the wrong recovery path.
      return fail(err instanceof NotFoundError ? toAppError(err) : validationFailure(err));
    }
  }

  async createProject(input: CreateProjectInput): Promise<Result<{ id: string; contentRevision: number }>> {
    const name = (input.name || '').trim();
    if (!name) return fail(appError('VALIDATION', '项目名称不能为空。', { safeDetail: 'empty name' }));
    try {
      const result = await runV3Transaction([PROJECTS], 'readwrite', async (ctx) => {
        const now = this.now();
        const id = input.id ?? this.newId('proj');
        const project: Project = {
          libraryId: this.libraryId,
          id,
          name,
          description: input.description ?? '',
          status: 'active',
          decisions: [],
          revision: 1,
          createdAt: now,
          updatedAt: now
        };
        this.assertValid(PROJECTS, project);
        ctx.store(PROJECTS).put(project);
        return { id };
      });
      const revision = await this.bumpContentRevision(result.value.id);
      if (!revision.ok) return fail(revision.error);
      return ok({ id: result.value.id, contentRevision: revision.value });
    } catch (err) {
      return fail(validationFailure(err));
    }
  }

  async captureInbox(input: CaptureInboxInput): Promise<Result<CaptureInboxOutput>> {
    const rawText = (input.rawText || '').trim();
    if (!rawText) return fail(appError('VALIDATION', '没有可记录的内容。', { safeDetail: 'empty capture' }));
    if (!input.operationId) {
      return fail(appError('VALIDATION', '记录缺少幂等键，无法保证不重复。', { safeDetail: 'missing operationId' }));
    }
    try {
      let created = false;
      const result = await runV3Transaction([INBOX], 'readwrite', async (ctx) => {
        const store = ctx.store(INBOX);
        const all = await requestToPromise(store.getAll() as IDBRequest<InboxEntry[]>);
        const existing = all.find(
          (row) => row.libraryId === this.libraryId && row.operationId === input.operationId
        );
        if (existing) return { entry: existing };
        const now = this.now();
        const entry: InboxEntry = {
          libraryId: this.libraryId,
          id: this.newId('inbox'),
          rawText,
          url: input.url,
          status: 'inbox',
          resultRefs: [],
          operationId: input.operationId,
          source: input.source,
          createdAt: now,
          updatedAt: now
        };
        this.assertValid(INBOX, entry);
        store.put(entry);
        created = true;
        return { entry };
      });
      const revision = created
        ? await this.bumpContentRevision(result.value.entry.id)
        : await this.getContentRevision();
      if (!revision.ok) return fail(revision.error);
      return ok({ entry: result.value.entry, created, contentRevision: revision.value });
    } catch (err) {
      return fail(validationFailure(err));
    }
  }

  async convertInboxEntry(entryId: string, target: ConvertTarget): Promise<Result<ConvertInboxOutput>> {
    try {
      let created = false;
      const result = await runV3Transaction(
        [INBOX, ITEMS, BODIES, LIBRARY_META],
        'readwrite',
        async (ctx) => {
          const inboxStore = ctx.store(INBOX);
          const entry = (await requestToPromise(inboxStore.get([this.libraryId, entryId]))) as InboxEntry | undefined;
          if (!entry) throw new Error(`收件箱条目不存在: ${entryId}`);

          // Already converted to this kind: return the existing target instead of
          // creating a second copy. This is the P1-05 rule, enforced in storage
          // rather than in whichever component happens to render the button.
          const previous = (entry.resultRefs || []).find((ref) => ref.type === target.type);
          if (previous) {
            return { entry, targetId: previous.id };
          }

          const now = this.now();
          const targetId = this.newId(target.type === 'note' ? 'note' : 'bookmark');
          const item: ItemMeta = {
            libraryId: this.libraryId,
            id: targetId,
            kind: target.type === 'note' ? 'note' : 'bookmark',
            title: target.title,
            tags: target.type === 'note' ? target.tags ?? [] : [],
            projectIds: [],
            revision: 1,
            createdAt: now,
            updatedAt: now
          };
          this.assertValid(ITEMS, item);
          ctx.store(ITEMS).put(item);
          if (target.type === 'note') {
            const body: NoteBody = {
              libraryId: this.libraryId,
              itemId: targetId,
              markdown: target.markdown,
              revision: 1,
              updatedAt: now
            };
            this.assertValid(BODIES, body);
            ctx.store(BODIES).put(body);
          }

          const updated: InboxEntry = {
            ...entry,
            status: 'processed',
            resultRefs: [...(entry.resultRefs || []), { type: target.type, id: targetId, at: now }],
            updatedAt: now
          };
          this.assertValid(INBOX, updated);
          inboxStore.put(updated);
          created = true;
          return { entry: updated, targetId };
        }
      );
      const revision = created
        ? await this.bumpContentRevision(result.value.targetId)
        : await this.getContentRevision();
      if (!revision.ok) return fail(revision.error);
      return ok({ entry: result.value.entry, targetId: result.value.targetId, created, contentRevision: revision.value });
    } catch (err) {
      return fail(err instanceof NotFoundError ? toAppError(err) : validationFailure(err));
    }
  }

  /**
   * Bump the library's content revision in its own transaction.
   *
   * Deliberately a separate commit: the revision is a *notification* that a write
   * landed, and folding it into the business transaction would mean a revision
   * could be observed for a write that was later aborted. A reader that sees a
   * revision only ever sees it after the data is durable.
   */
  private async bumpContentRevision(id: string): Promise<Result<number>> {
    try {
      const result = await runV3Transaction([LIBRARY_META], 'readwrite', async (ctx) => {
        const store = ctx.store(LIBRARY_META);
        const key = CONTENT_REVISION_KEY(this.libraryId);
        const row = (await requestToPromise(store.get(key))) as { value?: number } | undefined;
        const next = (Number(row?.value) || 0) + 1;
        store.put({ key, value: next, libraryId: this.libraryId, at: this.now() });
        const revKey = revisionKey(this.libraryId);
        const revRow = (await requestToPromise(store.get(revKey))) as { value?: number } | undefined;
        store.put({ key: revKey, value: (Number(revRow?.value) || 0) + 1, libraryId: this.libraryId, at: this.now() });
        return next;
      });
      this.contentRevision = result.value;
      emitChange(this.listeners, {
        contentRevision: result.value,
        stores: [],
        ids: [id]
      });
      return ok(result.value);
    } catch (err) {
      return fail(toAppError(err, '无法更新数据版本'));
    }
  }

  /** Diagnostics only: which v3 stores currently hold rows for this library. */
  async debugCounts(): Promise<Record<string, number>> {
    const stores = [ITEMS, BODIES, INBOX, LINKS, PROJECTS, ATTACHMENTS, SETTINGS];
    const out: Record<string, number> = {};
    for (const store of stores) {
      try {
        const result = await runV3Transaction([store], 'readonly', async (ctx) => {
          const rows = await requestToPromise(ctx.store(store).getAll() as IDBRequest<Array<{ libraryId?: string }>>);
          return rows.filter((row) => row.libraryId === this.libraryId).length;
        });
        out[store] = result.value;
      } catch {
        out[store] = -1;
      }
    }
    out.__modelVersion = MODEL_VERSION;
    return out;
  }
}
