/**
 * Inbox actions, including the cross-domain conversions.
 *
 * "Turn this inbox item into a note / a site / a project task" touches several
 * domains at once. Rather than reaching into other slices, this hook receives the
 * collaborators it needs (addNote, addSite) as explicit dependencies — the
 * conversion logic stays here, the ownership of each collection stays there.
 *
 * P1-05 rework. The old conversion had three problems the redesign calls out:
 *
 * 1. It stamped `status: 'processed'` and `targetId` in the same pass but never
 *    reported the result, so the view announced success unconditionally.
 * 2. Converting an already-converted item was blocked with a toast — but the
 *    correct behaviour is to *open the original target*, not to refuse.
 * 3. A conversion whose target had since been deleted left an item pointing at
 *    nothing, with no way forward.
 *
 * All three are handled by returning a result object and by looking the target
 * up before creating anything. Batch conversion reuses the same single-item path
 * so a partial failure is reported per item instead of aborting the batch.
 */
import { useCallback } from 'react';
import { HubState, InboxItem, NavSite, QuickNote } from '../types';
import type { StateUpdater } from './useSiteActions';

interface InboxDeps {
  addNote: (note: QuickNote) => void;
  addSite: (site: NavSite) => void;
}

export type ConversionTarget = 'note' | 'site' | 'project';

export interface ConversionResult {
  ok: boolean;
  /** The entity the item now points at. */
  targetId?: string;
  targetType?: ConversionTarget;
  /** True when the item had already been converted and was not created again. */
  reused?: boolean;
  /** User-facing failure reason; the item stays in the inbox. */
  error?: string;
}

export interface BatchPreview {
  total: number;
  /** Items that will actually be created. */
  willCreate: number;
  /** Items already converted; selecting them opens the original target. */
  alreadyConverted: number;
  /** Items that cannot be converted at all (e.g. no URL for a bookmark). */
  notConvertible: number;
  /** Plain-language destination, e.g. "资料库 · 笔记". */
  destination: string;
}

function titleFrom(item: InboxItem): string {
  if (item.title) return item.title;
  const flat = item.content.replace(/\s+/g, ' ').trim();
  return flat.length > 20 ? `${flat.slice(0, 20)}…` : flat || '收件箱条目';
}

export function useInboxActions(state: HubState, updateState: StateUpdater, deps: InboxDeps) {
  const { addNote, addSite } = deps;

  const addInboxItem = useCallback(
    (item: InboxItem) => {
      updateState((prev) => ({ ...prev, inbox: [item, ...(prev.inbox || [])] }));
    },
    [updateState]
  );

  const updateInboxItem = useCallback(
    (item: InboxItem) => {
      updateState((prev) => ({
        ...prev,
        inbox: (prev.inbox || []).map((i) => (i.id === item.id ? item : i))
      }));
    },
    [updateState]
  );

  const deleteInboxItem = useCallback(
    (id: string) => {
      updateState((prev) => ({ ...prev, inbox: (prev.inbox || []).filter((i) => i.id !== id) }));
    },
    [updateState]
  );

  /** Note this item already produced, when that note still exists. */
  const existingTarget = useCallback(
    (item: InboxItem): ConversionResult | null => {
      if (!item.targetType || !item.targetId) return null;
      if (item.targetType === 'note') {
        const note = (state.notes || []).find((n) => n.id === item.targetId);
        if (note) return { ok: true, targetId: note.id, targetType: 'note', reused: true };
      }
      if (item.targetType === 'site') {
        const site = (state.sites || []).find((s) => s.id === item.targetId);
        if (site) return { ok: true, targetId: site.id, targetType: 'site', reused: true };
      }
      if (item.targetType === 'project') {
        const project = (state.projects || []).find((p) => p.id === item.targetId);
        if (project) return { ok: true, targetId: project.id, targetType: 'project', reused: true };
      }
      // The target was deleted: report it so the UI can offer a re-convert
      // instead of silently creating a duplicate.
      return { ok: false, error: '原目标已被删除，可以重新转换。' };
    },
    [state.notes, state.sites, state.projects]
  );

  const convertToNote = useCallback(
    (item: InboxItem): ConversionResult => {
      const existing = existingTarget(item);
      if (existing?.ok) return existing;

      const newNote: QuickNote = {
        id: `note-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
        title: titleFrom(item),
        content: item.content + (item.url ? `\n\n来源链接: ${item.url}` : ''),
        category: '速记',
        tags: ['收件箱转化'],
        updatedAt: Date.now()
      };
      // Create the note through the notes domain first; only then mark the inbox
      // item handled, and store the target id so a repeat opens it instead of
      // creating a second copy.
      addNote(newNote);
      updateState((prev) => ({
        ...prev,
        inbox: (prev.inbox || []).map((i) =>
          i.id === item.id ? { ...i, status: 'processed', targetType: 'note', targetId: newNote.id } : i
        )
      }));
      return { ok: true, targetId: newNote.id, targetType: 'note', reused: false };
    },
    [addNote, existingTarget, updateState]
  );

  const convertToSite = useCallback(
    (item: InboxItem): ConversionResult => {
      const existing = existingTarget(item);
      if (existing?.ok) return existing;

      const rawUrl = item.url || (item.content.startsWith('http') ? item.content : '');
      if (!rawUrl) return { ok: false, error: '这条内容里没有可识别的网址。' };

      const newSite: NavSite = {
        id: `site-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
        title: titleFrom(item),
        url: rawUrl,
        category: '常用推荐',
        description: item.content !== rawUrl ? item.content : '从统一收件箱快速收藏',
        icon: 'Globe',
        createdAt: Date.now()
      };
      addSite(newSite);
      updateState((prev) => ({
        ...prev,
        inbox: (prev.inbox || []).map((i) =>
          i.id === item.id ? { ...i, status: 'processed', targetType: 'site', targetId: newSite.id } : i
        )
      }));
      return { ok: true, targetId: newSite.id, targetType: 'site', reused: false };
    },
    [addSite, existingTarget, updateState]
  );

  const assignToProject = useCallback(
    (itemId: string, projectId: string): ConversionResult => {
      const project = (state.projects || []).find((p) => p.id === projectId);
      if (!project) return { ok: false, error: '项目不存在，可能已被删除。' };
      updateState((prev) => ({
        ...prev,
        inbox: (prev.inbox || []).map((i) =>
          i.id === itemId ? { ...i, targetType: 'project', targetId: projectId, status: 'processed' } : i
        )
      }));
      return { ok: true, targetId: projectId, targetType: 'project', reused: false };
    },
    [state.projects, updateState]
  );

  /** What a batch conversion would do, so the UI can confirm before acting. */
  const previewBatch = useCallback(
    (items: InboxItem[], target: ConversionTarget): BatchPreview => {
      let willCreate = 0;
      let alreadyConverted = 0;
      let notConvertible = 0;
      for (const item of items) {
        const existing = existingTarget(item);
        if (existing?.ok) {
          alreadyConverted += 1;
          continue;
        }
        if (target === 'site' && !(item.url || item.content.startsWith('http'))) {
          notConvertible += 1;
          continue;
        }
        willCreate += 1;
      }
      return {
        total: items.length,
        willCreate,
        alreadyConverted,
        notConvertible,
        destination: target === 'note' ? '资料库 · 笔记' : target === 'site' ? '快捷导航 · 收藏' : '项目'
      };
    },
    [existingTarget]
  );

  /**
   * Convert many items. Failures are reported per item and the failing items
   * remain in the inbox with their original content.
   */
  const convertMany = useCallback(
    (items: InboxItem[], target: 'note' | 'site'): { results: Array<{ id: string; result: ConversionResult }> } => {
      const results = items.map((item) => ({
        id: item.id,
        result: target === 'note' ? convertToNote(item) : convertToSite(item)
      }));
      return { results };
    },
    [convertToNote, convertToSite]
  );

  return {
    addInboxItem,
    updateInboxItem,
    deleteInboxItem,
    convertToNote,
    convertToSite,
    assignToProject,
    previewBatch,
    convertMany,
    existingTarget
  };
}
