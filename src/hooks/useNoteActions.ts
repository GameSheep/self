/**
 * Knowledge content actions: quick notes and handwriting boards.
 * Both are "content I authored locally", so they share one hook.
 */
import { useCallback } from 'react';
import { HandwritingNote, ProjectItem, QuickNote } from '../types';
import type { StateUpdater } from './useSiteActions';

export function useNoteActions(updateState: StateUpdater) {
  const addNote = useCallback(
    (note: QuickNote) => {
      updateState((prev) => ({ ...prev, notes: [note, ...(prev.notes || [])] }));
    },
    [updateState]
  );

  const updateNote = useCallback(
    (note: QuickNote) => {
      updateState((prev) => ({
        ...prev,
        notes: (prev.notes || []).map((n) => (n.id === note.id ? note : n))
      }));
    },
    [updateState]
  );

  const deleteNote = useCallback(
    (id: string) => {
      updateState((prev) => ({ ...prev, notes: (prev.notes || []).filter((n) => n.id !== id) }));
    },
    [updateState]
  );

  const saveHandwriting = useCallback(
    (note: HandwritingNote) => {
      updateState((prev) => {
        const exists = (prev.handwritings || []).some((h) => h.id === note.id);
        return {
          ...prev,
          handwritings: exists
            ? (prev.handwritings || []).map((h) => (h.id === note.id ? note : h))
            : [note, ...(prev.handwritings || [])]
        };
      });
    },
    [updateState]
  );

  const deleteHandwriting = useCallback(
    (id: string) => {
      updateState((prev) => ({ ...prev, handwritings: (prev.handwritings || []).filter((h) => h.id !== id) }));
    },
    [updateState]
  );

  return { addNote, updateNote, deleteNote, saveHandwriting, deleteHandwriting };
}

export function useProjectActions(updateState: StateUpdater) {
  const addProject = useCallback(
    (project: ProjectItem) => {
      updateState((prev) => ({ ...prev, projects: [project, ...(prev.projects || [])] }));
    },
    [updateState]
  );

  const updateProject = useCallback(
    (project: ProjectItem) => {
      updateState((prev) => ({
        ...prev,
        projects: (prev.projects || []).map((p) => (p.id === project.id ? project : p))
      }));
    },
    [updateState]
  );

  const deleteProject = useCallback(
    (id: string) => {
      updateState((prev) => ({ ...prev, projects: (prev.projects || []).filter((p) => p.id !== id) }));
    },
    [updateState]
  );

  return { addProject, updateProject, deleteProject };
}
