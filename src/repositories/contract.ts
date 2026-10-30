/**
 * Repository contract (P2-01).
 *
 * The point of this interface is that **the same suite validates both
 * implementations** — the P1 legacy `localStorage` payload and the v3
 * IndexedDB store. That is what makes P2-02 a switch rather than a rewrite: use
 * cases never learn which one they are talking to.
 *
 * The contract is stated in **use-case terms** (save a note, capture an inbox
 * entry, convert it) rather than raw store terms. A raw `transact(store, …)`
 * surface could not be honoured by the v2 payload, because v2 has no `_v3`
 * stores to write into — the projection between them is exactly what P2-02 will
 * build. Use-case terms are satisfiable by both today, which is what the plan
 * asks for.
 *
 * Two guarantees the contract has to make, because the acceptance criteria are
 * stated in terms of them:
 *
 * 1. **Atomic across collections.** A rejected write leaves nothing behind — not
 *    the item, not the body, not the link. Implementations validate and abort;
 *    they never write-then-repair.
 * 2. **Persisted means persisted.** Success is reported only after the storage
 *    confirmed the commit (`tx.oncomplete` for IndexedDB, a completed
 *    `setItem` for legacy). A request's `onsuccess` is not a commit.
 *
 * Implementations must not perform network, crypto or file I/O inside the write
 * path; §6.4 keeps those outside the transaction so a slow call cannot hold a
 * database transaction open.
 */
import type { ItemMeta, NoteBody, InboxEntry, EntityLink, ItemKind } from '../domain/model';
import type { AppError, Result } from './errors';

export type RepositoryKind = 'legacy' | 'indexeddb';

export interface ChangeEvent {
  /** Monotonic per repository lifetime; bumped once per committed write. */
  contentRevision: number;
  stores: string[];
  ids: string[];
}

export interface ListItemsOptions {
  kind?: ItemKind;
  projectId?: string;
  limit?: number;
  /** Include soft-deleted rows. Default false. */
  includeDeleted?: boolean;
  /** Case-insensitive substring match over title (and tags when present). */
  search?: string;
}

export interface SaveNoteInput {
  /** Omit to create a new note. */
  id?: string;
  title: string;
  markdown: string;
  tags?: string[];
  /**
   * Project references.
   *
   * `undefined` means "leave the existing links alone" — a caller that only
   * edits a title must not silently drop the note out of its projects. An array
   * (including an empty one) *replaces* the link set, which is how a caller
   * expresses "these are now the projects".
   *
   * Every id must already exist: a dangling reference is rejected atomically
   * rather than stored and cleaned up later.
   */
  projectIds?: string[];
}

export interface SaveNoteOutput {
  item: ItemMeta;
  body: NoteBody;
  contentRevision: number;
}

export interface CaptureInboxInput {
  rawText: string;
  url?: string;
  /** Idempotency key: the same key returns the existing entry. */
  operationId: string;
  source: InboxEntry['source'];
}

export interface CaptureInboxOutput {
  entry: InboxEntry;
  /** False when an entry with this operationId already existed. */
  created: boolean;
  contentRevision: number;
}

export type ConvertTarget =
  | { type: 'note'; title: string; markdown: string; tags?: string[] }
  | { type: 'bookmark'; title: string; url: string };

export interface ConvertInboxOutput {
  entry: InboxEntry;
  targetId: string;
  /** False when the entry had already been converted to the same target type. */
  created: boolean;
  contentRevision: number;
}

export interface CreateProjectInput {
  id?: string;
  name: string;
  description?: string;
}

export interface HubRepository {
  readonly kind: RepositoryKind;
  /** True once `init()` has completed. */
  readonly ready: boolean;

  init(): Promise<Result<void>>;
  close(): void;

  /** Bumped on every committed write; also the "is my cached view stale" check. */
  getContentRevision(): Promise<Result<number>>;

  listItems(options?: ListItemsOptions): Promise<Result<ItemMeta[]>>;
  /**
   * Read one note and its body.
   *
   * Hidden when soft-deleted unless `includeDeleted` is set, so a normal read
   * cannot resurrect something the user removed — the recycle bin is the only
   * place that asks for deleted rows on purpose.
   */
  getNote(
    itemId: string,
    options?: { includeDeleted?: boolean }
  ): Promise<Result<{ item: ItemMeta; body: NoteBody } | undefined>>;

  /**
   * Create or update a note together with its body and its project links, in one
   * commit. Rejects (writes nothing) when a referenced project does not exist.
   */
  saveNote(input: SaveNoteInput): Promise<Result<SaveNoteOutput>>;
  /** Soft-deletes the note and removes its links, in one commit. */
  deleteNote(itemId: string): Promise<Result<{ contentRevision: number }>>;

  createProject(input: CreateProjectInput): Promise<Result<{ id: string; contentRevision: number }>>;
  listLinks(options?: { fromId?: string; toId?: string }): Promise<Result<EntityLink[]>>;

  /** Idempotent capture. */
  captureInbox(input: CaptureInboxInput): Promise<Result<CaptureInboxOutput>>;
  listInbox(status?: InboxEntry['status']): Promise<Result<InboxEntry[]>>;
  /**
   * Convert in one commit: the target entity, the entry's status *and* its
   * resultRefs. Converting twice returns the first result instead of creating a
   * second target.
   */
  convertInboxEntry(entryId: string, target: ConvertTarget): Promise<Result<ConvertInboxOutput>>;

  subscribe(listener: (event: ChangeEvent) => void): () => void;
}

/** Emit a change event to every listener, isolating listener failures. */
export function emitChange(listeners: Set<(e: ChangeEvent) => void>, event: ChangeEvent): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch (err) {
      // A broken listener must not fail the write that already committed.
      console.warn('[Self-Hub] repository listener failed', err);
    }
  }
}

export function validationFailure(err: unknown): AppError {
  const detail = err instanceof Error ? err.message : String(err);
  return {
    code: 'VALIDATION',
    userMessage: '写入的数据不符合当前模型，本次改动没有保存。',
    safeDetail: detail.slice(0, 300),
    retryable: false,
    suggestedAction: 'fix_data'
  };
}
