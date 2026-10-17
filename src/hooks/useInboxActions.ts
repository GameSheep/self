/**
 * Inbox actions, including the cross-domain conversions.
 *
 * "Turn this inbox item into a note / a site / a project task" touches several
 * domains at once. Rather than reaching into other slices, this hook receives the
 * collaborators it needs (addNote, addSite) as explicit dependencies — the
 * conversion logic stays here, the ownership of each collection stays there.
 */
import { useCallback } from 'react';
import { InboxItem, NavSite, QuickNote } from '../types';
import type { StateUpdater } from './useSiteActions';

interface InboxDeps {
  addNote: (note: QuickNote) => void;
  addSite: (site: NavSite) => void;
}

export function useInboxActions(updateState: StateUpdater, deps: InboxDeps) {
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

  const convertToNote = useCallback(
    (item: InboxItem) => {
      const newNote: QuickNote = {
        id: `note-${Date.now()}`,
        title: item.title || (item.content.length > 20 ? item.content.slice(0, 20) + '...' : item.content),
        content: item.content + (item.url ? `\n\n来源链接: ${item.url}` : ''),
        category: '速记',
        tags: ['收件箱转化'],
        updatedAt: Date.now()
      };
      // Create the note through the notes domain, then mark the inbox item done.
      addNote(newNote);
      updateState((prev) => ({
        ...prev,
        inbox: (prev.inbox || []).map((i) =>
          i.id === item.id ? { ...i, status: 'processed', targetType: 'note', targetId: newNote.id } : i
        )
      }));
    },
    [addNote, updateState]
  );

  const convertToSite = useCallback(
    (item: InboxItem) => {
      const targetUrl = item.url || (item.content.startsWith('http') ? item.content : `https://${item.content}`);
      const newSite: NavSite = {
        id: `site-${Date.now()}`,
        title: item.title || '收件箱新存网址',
        url: targetUrl,
        category: '常用推荐',
        description: item.content !== targetUrl ? item.content : '从统一收件箱快速收藏',
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
    },
    [addSite, updateState]
  );

  const assignToProject = useCallback(
    (itemId: string, projectId: string) => {
      updateState((prev) => ({
        ...prev,
        inbox: (prev.inbox || []).map((i) =>
          i.id === itemId ? { ...i, targetType: 'project', targetId: projectId, status: 'processed' } : i
        )
      }));
    },
    [updateState]
  );

  return { addInboxItem, updateInboxItem, deleteInboxItem, convertToNote, convertToSite, assignToProject };
}
