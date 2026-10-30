/**
 * Site (bookmark) actions.
 *
 * Extracted from App, which had accumulated every domain's CRUD callbacks in one
 * 900-line component. Each hook owns one domain and receives only the state
 * updater, so a change here cannot reach into unrelated features.
 *
 * P1-04 added `updateSite` and `updateSites`. `importBookmarks` keeps its name
 * and signature (App still calls it as `(newSites) => void`) but now *replaces*
 * the sites collection with the array it is handed instead of prepending to it:
 * reordering, pinning and moving between groups all have to write a complete,
 * explicitly ordered list, and a prepend would have duplicated every record.
 * It still merges the incoming categories, so a batch can introduce new groups.
 */
import { useCallback } from 'react';
import { HubState, NavSite } from '../types';

export type StateUpdater = (updater: (prev: HubState) => HubState) => void;

export function useSiteActions(updateState: StateUpdater) {
  const addSite = useCallback(
    (site: NavSite) => {
      updateState((prev) => ({ ...prev, sites: [site, ...prev.sites] }));
    },
    [updateState]
  );

  const deleteSite = useCallback(
    (id: string) => {
      updateState((prev) => ({ ...prev, sites: prev.sites.filter((s) => s.id !== id) }));
    },
    [updateState]
  );

  const visitSite = useCallback(
    (id: string) => {
      updateState((prev) => ({
        ...prev,
        sites: prev.sites.map((s) =>
          s.id === id ? { ...s, visitCount: (s.visitCount || 0) + 1, lastVisited: Date.now() } : s
        )
      }));
    },
    [updateState]
  );

  /** Edit an existing site (title / url / category / tags / description / pin). */
  const updateSite = useCallback(
    (id: string, patch: Partial<NavSite>) => {
      updateState((prev) => ({
        ...prev,
        sites: prev.sites.map((s) => (s.id === id ? { ...s, ...patch, id: s.id } : s))
      }));
    },
    [updateState]
  );

  /**
   * Batch write used by reorder / move / pin / import / undo. The array is the
   * new truth for `state.sites`; categories are merged, never removed, so undo
   * cannot silently delete a group the user created elsewhere.
   */
  const importBookmarks = useCallback(
    (newSites: NavSite[]) => {
      updateState((prev) => {
        const catSet = new Set(prev.categories || ['全部']);
        newSites.forEach((s) => {
          if (s.category && s.category.trim()) catSet.add(s.category.trim());
        });
        return { ...prev, categories: Array.from(catSet), sites: newSites };
      });
    },
    [updateState]
  );

  /** Alias with the intent-revealing name; same writer as `importBookmarks`. */
  const updateSites = importBookmarks;

  return { addSite, deleteSite, visitSite, updateSite, updateSites, importBookmarks };
}
