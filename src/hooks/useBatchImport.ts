/**
 * Bulk import used by the AI ingest flow.
 * It writes to five collections in a single atomic update on purpose: a partial
 */
import { useCallback } from 'react';
import { NavSite, QuickNote, ReminderItem, SecretItem, ServerDeployment } from '../types';
import type { StateUpdater } from './useSiteActions';

export interface BatchImportPayload {
  sites: NavSite[];
  servers: ServerDeployment[];
  secrets: SecretItem[];
  notes: QuickNote[];
  reminders: ReminderItem[];
}

export function useBatchImport(updateState: StateUpdater) {
  return useCallback(
    (data: BatchImportPayload) => {
      updateState((prev) => {
        const catSet = new Set(prev.categories || ['全部']);
        data.sites.forEach((s) => {
          if (s.category && s.category.trim()) catSet.add(s.category.trim());
        });

        return {
          ...prev,
          categories: Array.from(catSet),
          sites: [...data.sites, ...prev.sites],
          servers: [...data.servers, ...prev.servers],
          secrets: [...data.secrets, ...prev.secrets],
          notes: [...data.notes, ...(prev.notes || [])],
          reminders: [...data.reminders, ...(prev.reminders || [])]
        };
      });
    },
    [updateState]
  );
}
