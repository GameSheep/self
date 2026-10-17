/**
 * Chrome-extension bridge.
 *
 * The web app stores everything in `localStorage['self_hub_data_v2']`, while the
 * bundled extension reads `chrome.storage.local` (`selfhub_sites`,
 * `selfhub_annotations`, `selfhub_inbox`). When the app is opened from inside the
 * extension (`chrome-extension://<id>/app/index.html`) the two live on different
 * origins, so nothing ever flowed between them: the extension's new-tab grid could
 * only show its hardcoded defaults.
 *
 * This mirrors the bookmarks and annotations one way (app -> extension) on every
 * persisted change, and is a no-op in a normal browser tab.
 */
import { HubState } from '../types';

interface ChromeStorageLike {
  storage?: {
    local?: {
      set: (items: Record<string, unknown>, cb?: () => void) => void;
    };
  };
}

function getChrome(): ChromeStorageLike | null {
  const candidate = (globalThis as unknown as { chrome?: ChromeStorageLike }).chrome;
  if (candidate?.storage?.local?.set) return candidate;
  return null;
}

export function isExtensionContext(): boolean {
  return Boolean(getChrome());
}

/** Shape expected by extension/newtab.js and extension/background.js. */
export function mirrorStateToExtension(state: HubState): void {
  const chromeApi = getChrome();
  if (!chromeApi?.storage?.local) return;

  try {
    const wucaiAsAnnotations = (state.wucaiHighlights || []).map((h) => ({
      id: h.id,
      pageUrl: h.pageUrl,
      pageTitle: h.pageTitle,
      text: h.text,
      note: h.note || '',
      color: h.color,
      tags: h.tags || [],
      createdAt: h.createdAt,
      updatedAt: h.updatedAt || h.createdAt
    }));

    const pageAnnotations = (state.annotations || []).map((a) => ({
      id: a.id,
      pageUrl: a.pageUrl,
      pageTitle: a.pageTitle,
      text: a.text,
      note: a.note || '',
      color: a.color,
      tags: a.tags || [],
      anchor: a.anchor,
      createdAt: a.createdAt,
      updatedAt: a.updatedAt
    }));

    const byId = new Map<string, unknown>();
    for (const item of [...pageAnnotations, ...wucaiAsAnnotations]) {
      byId.set((item as { id: string }).id, item);
    }

    chromeApi.storage.local.set({
      selfhub_sites: (state.sites || []).map((s) => ({
        id: s.id,
        title: s.title,
        url: s.url,
        desc: s.description || '',
        category: s.category,
        pinned: Boolean(s.pinned),
        visitCount: s.visitCount || 0
      })),
      selfhub_annotations: Array.from(byId.values())
    });
  } catch (err) {
    console.warn('[Self-Hub] extension mirror failed', err);
  }
}
