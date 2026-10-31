/**
 * Legacy implementation of the repository contract (P2-01).
 * This adapter lets the same contract suite validate the **v2 `localStorage`
 * payload** the app runs on today. It is transitional by design: P1 keeps v2 as
 * · failure, never as success.
 */
import type { EntityLink, InboxEntry, ItemMeta, NoteBody, Project } from '../domain/model';
import { MODEL_VERSION } from '../domain/model';
import { loadHubState, normalizeHubState, saveHubState } from '../lib/storage';
import type { HubState, InboxItem, ProjectItem, QuickNote } from '../types';
import { appError, fail, ok, type Result } from './errors';
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
  type SaveNoteOutput
} from './contract';

const LEGACY_LIBRARY_ID = 'legacy-local';

interface LegacyNote extends QuickNote {
  deletedAt?: number;
  projectIds?: string[];
}

interface LegacyInbox extends InboxItem {
  resultRefs?: Array<{ type: 'note' | 'bookmark' | 'project'; id: string; at: number }>;
}

export interface LegacyRepositoryOptions {
  libraryId?: string;
  now?: () => number;
  newId?: (prefix: string) => string;
}

function defaultNewId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export class LegacyRepository implements HubRepository {
  readonly kind: RepositoryKind = 'legacy';
  ready = false;

  private readonly libraryId: string;
  private readonly now: () => number;
  private readonly newId: (prefix: string) => string;
  private readonly listeners = new Set<(e: ChangeEvent) => void>();
  private state: HubState | null = null;

  constructor(options: LegacyRepositoryOptions = {}) {
    this.libraryId = options.libraryId ?? LEGACY_LIBRARY_ID;
    this.now = options.now ?? (() => Date.now());
    this.newId = options.newId ?? defaultNewId;
  }

  async init(): Promise<Result<void>> {
    try {
      this.state = normalizeHubState(loadHubState());
      this.ready = true;
      return ok(undefined);
    } catch (err) {
      return fail(appError('UNKNOWN', '无法读取本机数据。', { safeDetail: String(err).slice(0, 200) }));
    }
  }

  close(): void {
    this.ready = false;
    this.listeners.clear();
    this.state = null;
  }

  subscribe(listener: (event: ChangeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Re-read from storage so a rejected local edit cannot be observed. */
  private current(): HubState {
    if (!this.state) this.state = normalizeHubState(loadHubState());
    return this.state;
  }

  private notes(): LegacyNote[] {
    return (this.current().notes || []) as LegacyNote[];
  }

  private inbox(): LegacyInbox[] {
    return (this.current().inbox || []) as LegacyInbox[];
  }

  private projects(): ProjectItem[] {
    return this.current().projects || [];
  }

  async getContentRevision(): Promise<Result<number>> {
    const raw = this.current() as HubState & { contentRevision?: number };
    return ok(Number(raw.contentRevision) || 0);
  }

  /* ---------------------------------------------------------------------- */
  /* Mapping helpers                                                         */
  /* ---------------------------------------------------------------------- */

  private projectIdsOf(noteId: string): string[] {
    return this.projects()
      .filter((p) => (p.noteIds || []).includes(noteId))
      .map((p) => p.id);
  }

  private toItem(note: LegacyNote): ItemMeta {
    return {
      libraryId: this.libraryId,
      id: note.id,
      kind: 'note',
      title: note.title,
      tags: note.tags || [],
      projectIds: note.projectIds ?? this.projectIdsOf(note.id),
      revision: Number((note as { revision?: number }).revision) || 1,
      createdAt: note.updatedAt,
      updatedAt: note.updatedAt,
      deletedAt: note.deletedAt
    };
  }

  private toBody(note: LegacyNote): NoteBody {
    return {
      libraryId: this.libraryId,
      itemId: note.id,
      markdown: note.content,
      revision: Number((note as { revision?: number }).revision) || 1,
      updatedAt: note.updatedAt
    };
  }

  private toEntry(item: LegacyInbox): InboxEntry {
    // v2 calls a bookmark target `site`; the v3 model calls the same thing
    // `bookmark` (a bookmark is an ItemMeta row plus a URL, not a separate
    // concept). Translate at this boundary so both sides keep their own name.
    const legacyType = item.targetType;
    const targetType: 'note' | 'bookmark' | 'project' | undefined =
      legacyType === 'site' ? 'bookmark' : legacyType;
    const refs =
      item.resultRefs ??
      (targetType && item.targetId ? [{ type: targetType, id: item.targetId, at: item.createdAt }] : []);
    return {
      libraryId: this.libraryId,
      id: item.id,
      rawText: item.content,
      url: item.url,
      status: item.status,
      resultRefs: refs,
      operationId: item.operationId ?? `legacy-${item.id}`,
      source: item.source ?? 'inbox',
      createdAt: item.createdAt,
      updatedAt: item.createdAt
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Reads                                                                   */
  /* ---------------------------------------------------------------------- */

  async listItems(options: ListItemsOptions = {}): Promise<Result<ItemMeta[]>> {
    let rows = this.notes().map((n) => this.toItem(n));
    if (!options.includeDeleted) rows = rows.filter((r) => !r.deletedAt);
    if (options.kind && options.kind !== 'note') rows = [];
    if (options.projectId) rows = rows.filter((r) => r.projectIds.includes(options.projectId!));
    if (options.search) {
      const needle = options.search.toLowerCase();
      rows = rows.filter((r) => `${r.title} ${r.tags.join(' ')}`.toLowerCase().includes(needle));
    }
    rows.sort((a, b) => b.updatedAt - a.updatedAt);
    if (options.limit && options.limit > 0) rows = rows.slice(0, options.limit);
    return ok(rows);
  }

  async getNote(
    itemId: string,
    options: { includeDeleted?: boolean } = {}
  ): Promise<Result<{ item: ItemMeta; body: NoteBody } | undefined>> {
    const note = this.notes().find((n) => n.id === itemId);
    if (!note) return ok(undefined);
    if (note.deletedAt && !options.includeDeleted) return ok(undefined);
    return ok({ item: this.toItem(note), body: this.toBody(note) });
  }

  async listLinks(options: { fromId?: string; toId?: string } = {}): Promise<Result<EntityLink[]>> {
    const links: EntityLink[] = [];
    for (const project of this.projects()) {
      for (const noteId of project.noteIds || []) {
        links.push({
          libraryId: this.libraryId,
          id: `${noteId}::project::${project.id}`,
          fromType: 'item',
          fromId: noteId,
          toType: 'project',
          toId: project.id,
          relation: 'project',
          createdAt: project.createdAt
        });
      }
    }
    return ok(
      links.filter(
        (link) =>
          (!options.fromId || link.fromId === options.fromId) && (!options.toId || link.toId === options.toId)
      )
    );
  }

  async listInbox(status?: InboxEntry['status']): Promise<Result<InboxEntry[]>> {
    const rows = this.inbox()
      .filter((i) => !status || i.status === status)
      .map((i) => this.toEntry(i))
      .sort((a, b) => b.createdAt - a.createdAt);
    return ok(rows);
  }

  /* ---------------------------------------------------------------------- */
  /* Writes                                                                  */
  /* ---------------------------------------------------------------------- */

  /**
   * Persist a candidate payload.
   *
   * The candidate is only committed when `saveHubState` confirms it. On refusal
   * the in-memory copy is dropped so a later read cannot see an edit that never
   * landed.
   */
  private commit(candidate: HubState, touched: { stores: string[]; ids: string[] }): Result<number> {
    const next = { ...candidate, contentRevision: (Number((candidate as { contentRevision?: number }).contentRevision) || 0) + 1 };
    const result = saveHubState(next);
    if (!result.success) {
      // Keep the last known-good payload.
      this.state = normalizeHubState(loadHubState());
      if (result.readOnly) {
        return fail(
          appError('MIGRATION_REQUIRED', result.error || '本页版本较旧，已切换为只读。', {
            suggestedAction: 'reload_page'
          })
        );
      }
      if (/空间已满|quota/i.test(result.error || '')) {
        return fail(
          appError('QUOTA_EXCEEDED', result.error || '本机存储空间不足，本次改动没有写入。', {
            suggestedAction: 'export_backup_then_free_space'
          })
        );
      }
      return fail(appError('UNKNOWN', result.error || '保存失败', { safeDetail: 'saveHubState rejected' }));
    }
    this.state = next;
    const revision = Number((next as { contentRevision?: number }).contentRevision) || 0;
    emitChange(this.listeners, { contentRevision: revision, stores: touched.stores, ids: touched.ids });
    return ok(revision);
  }

  async saveNote(input: SaveNoteInput): Promise<Result<SaveNoteOutput>> {
    const title = (input.title || '').trim();
    if (!title) return fail(appError('VALIDATION', '笔记标题不能为空。', { safeDetail: 'empty title' }));
    // `undefined` means "leave the links alone"; an array replaces them.
    const projectIds = input.projectIds === undefined ? undefined : Array.from(new Set(input.projectIds));
    const idsToVerify = projectIds ?? [];

    const current = this.current();
    const knownProjects = new Set((current.projects || []).map((p) => p.id));
    const missing = idsToVerify.filter((id) => !knownProjects.has(id));
    if (missing.length > 0) {
      // Rejected before anything is written, exactly like the IndexedDB path.
      return fail(
        appError('VALIDATION', '引用的项目不存在，本次改动没有保存。', {
          safeDetail: `missing projects: ${missing.join(', ')}`,
          suggestedAction: 'fix_data'
        })
      );
    }

    const now = this.now();
    const id = input.id ?? this.newId('note');
    const existing = (current.notes || []).find((n) => n.id === id) as LegacyNote | undefined;
    const revision = (Number((existing as { revision?: number })?.revision) || 0) + 1;
    const effectiveProjectIds = projectIds ?? existing?.projectIds ?? this.projectIdsOf(id);

    const note: LegacyNote = {
      id,
      title,
      content: input.markdown,
      category: existing?.category ?? '速记',
      tags: input.tags ?? existing?.tags ?? [],
      pinned: existing?.pinned ?? false,
      updatedAt: now,
      projectIds: effectiveProjectIds
    };
    (note as { revision?: number }).revision = revision;

    // Candidate payload: note replaced/inserted, and every project's noteIds
    // updated in the same commit — but only when the caller stated the set.
    const notes = existing
      ? (current.notes || []).map((n) => (n.id === id ? note : n))
      : [note, ...(current.notes || [])];
    const projects =
      projectIds === undefined
        ? current.projects || []
        : (current.projects || []).map((project) => {
            const ids = new Set(project.noteIds || []);
            if (projectIds.includes(project.id)) ids.add(id);
            else ids.delete(id);
            return { ...project, noteIds: Array.from(ids) };
          });

    const revisionResult = this.commit(
      { ...current, notes, projects } as HubState,
      { stores: ['items_v3', 'note_bodies_v3', 'entity_links_v3'], ids: [id] }
    );
    if (!revisionResult.ok) return fail(revisionResult.error);

    return ok({
      item: this.toItem(note),
      body: this.toBody(note),
      contentRevision: revisionResult.value
    });
  }

  async deleteNote(itemId: string): Promise<Result<{ contentRevision: number }>> {
    const current = this.current();
    const note = (current.notes || []).find((n) => n.id === itemId) as LegacyNote | undefined;
    if (!note) return fail(appError('NOT_FOUND', '这条笔记不存在。', { safeDetail: itemId }));

    const notes = (current.notes || []).map((n) =>
      n.id === itemId ? { ...n, deletedAt: this.now() } : n
    );
    const projects = (current.projects || []).map((project) => ({
      ...project,
      noteIds: (project.noteIds || []).filter((id) => id !== itemId)
    }));

    const result = this.commit(
      { ...current, notes, projects } as HubState,
      { stores: ['items_v3', 'entity_links_v3'], ids: [itemId] }
    );
    if (!result.ok) return fail(result.error);
    return ok({ contentRevision: result.value });
  }

  async createProject(input: CreateProjectInput): Promise<Result<{ id: string; contentRevision: number }>> {
    const name = (input.name || '').trim();
    if (!name) return fail(appError('VALIDATION', '项目名称不能为空。', { safeDetail: 'empty name' }));
    const current = this.current();
    const now = this.now();
    const id = input.id ?? this.newId('proj');
    const project: ProjectItem = {
      id,
      name,
      description: input.description ?? '',
      status: 'active',
      noteIds: [],
      siteIds: [],
      serverIds: [],
      reminderIds: [],
      decisions: [],
      createdAt: now,
      updatedAt: now
    };
    const result = this.commit(
      { ...current, projects: [project, ...(current.projects || [])] } as HubState,
      { stores: ['projects_v3'], ids: [id] }
    );
    if (!result.ok) return fail(result.error);
    return ok({ id, contentRevision: result.value });
  }

  async captureInbox(input: CaptureInboxInput): Promise<Result<CaptureInboxOutput>> {
    const rawText = (input.rawText || '').trim();
    if (!rawText) return fail(appError('VALIDATION', '没有可记录的内容。', { safeDetail: 'empty capture' }));
    if (!input.operationId) {
      return fail(appError('VALIDATION', '记录缺少幂等键，无法保证不重复。', { safeDetail: 'missing operationId' }));
    }
    const current = this.current();
    const existing = this.inbox().find((i) => i.operationId === input.operationId);
    if (existing) {
      const revision = await this.getContentRevision();
      return ok({
        entry: this.toEntry(existing),
        created: false,
        contentRevision: revision.ok ? revision.value : 0
      });
    }

    const now = this.now();
    const entry: LegacyInbox = {
      id: this.newId('inbox'),
      content: rawText,
      url: input.url,
      type: input.url ? 'url' : 'text',
      status: 'inbox',
      createdAt: now,
      operationId: input.operationId,
      source: input.source,
      resultRefs: []
    };
    const result = this.commit(
      { ...current, inbox: [entry, ...(current.inbox || [])] } as HubState,
      { stores: ['inbox_v3'], ids: [entry.id] }
    );
    if (!result.ok) return fail(result.error);
    return ok({ entry: this.toEntry(entry), created: true, contentRevision: result.value });
  }

  async convertInboxEntry(entryId: string, target: ConvertTarget): Promise<Result<ConvertInboxOutput>> {
    const current = this.current();
    const entry = this.inbox().find((i) => i.id === entryId);
    if (!entry) return fail(appError('NOT_FOUND', '这条收件箱内容不存在。', { safeDetail: entryId }));

    const previous = (entry.resultRefs || []).find((ref) => ref.type === target.type);
    if (previous) {
      const revision = await this.getContentRevision();
      return ok({
        entry: this.toEntry(entry),
        targetId: previous.id,
        created: false,
        contentRevision: revision.ok ? revision.value : 0
      });
    }

    const now = this.now();
    const targetId = this.newId(target.type === 'note' ? 'note' : 'site');
    const notes = [...(current.notes || [])];
    if (target.type === 'note') {
      notes.unshift({
        id: targetId,
        title: target.title,
        content: target.markdown,
        category: '速记',
        tags: target.tags ?? [],
        updatedAt: now
      } as QuickNote);
    }

    const updated: LegacyInbox = {
      ...entry,
      status: 'processed',
      // Store the v2 name for a bookmark target ('site'), not the v3 one.
      targetType: target.type === 'bookmark' ? 'site' : 'note',
      targetId,
      resultRefs: [...(entry.resultRefs || []), { type: target.type, id: targetId, at: now }]
    };
    const inbox = (current.inbox || []).map((i) => (i.id === entryId ? updated : i));
    const sites =
      target.type === 'bookmark'
        ? [
            {
              id: targetId,
              title: target.title,
              url: target.url,
              category: '常用推荐',
              createdAt: now
            },
            ...(current.sites || [])
          ]
        : current.sites;

    // One commit for the target entity, the entry status and its result refs.
    const result = this.commit(
      { ...current, notes, sites, inbox } as HubState,
      { stores: ['items_v3', 'note_bodies_v3', 'inbox_v3'], ids: [targetId, entryId] }
    );
    if (!result.ok) return fail(result.error);
    return ok({
      entry: this.toEntry(updated),
      targetId,
      created: true,
      contentRevision: result.value
    });
  }

  /** Diagnostics: shape of the legacy payload this adapter is projecting. */
  async debugCounts(): Promise<Record<string, number>> {
    const current = this.current();
    return {
      notes: (current.notes || []).length,
      inbox: (current.inbox || []).length,
      projects: (current.projects || []).length,
      sites: (current.sites || []).length,
      __modelVersion: MODEL_VERSION
    };
  }
}

export { LEGACY_LIBRARY_ID };
export type { Project };
