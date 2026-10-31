/**
 * Unified library index (P1-05 foundation).
 * Notes, bookmark annotations, imported 五彩 highlights, hand drawings and OSS
 * remote documents live in five different collections with five different
 * · Pure functions only; no React, no storage access. That keeps it testable and
 */
import type { HubState } from '../types';
import { isFeatureEnabled, type FeatureFlags, type FeatureId } from '../lib/features';

export type LibraryKind = 'note' | 'webpage' | 'drawing' | 'bookmark' | 'remote';

export type LibrarySource = 'local' | 'web-clip' | 'oss' | 'wucai' | 'youdao';

export interface LibraryItem {
  /** Stable identity: `${kind}:${nativeId}` so keys never collide across kinds. */
  key: string;
  id: string;
  kind: LibraryKind;
  source: LibrarySource;
  title: string;
  /** Short single-line preview text for list rows. */
  snippet: string;
  updatedAt: number;
  /** Human labels for the list "来源" column. */
  sourceLabel: string;
  kindLabel: string;
  tags: string[];
  /** Project name when this item is referenced by exactly one project. */
  projectName?: string;
  /** Extra location info (URL for pages, remote key for OSS files). */
  location?: string;
  /** True when the body is not available locally (remote, not downloaded). */
  partial?: boolean;
}

export const KIND_LABELS: Record<LibraryKind, string> = {
  note: '笔记',
  webpage: '网页批注',
  drawing: '手绘',
  bookmark: '收藏',
  remote: '远端文件'
};

export const SOURCE_LABELS: Record<LibrarySource, string> = {
  local: '本机',
  'web-clip': '网页采集',
  oss: 'OSS 笔记库',
  wucai: '五彩导入',
  youdao: '有道导入'
};

/** Squash whitespace so a list row stays one line. */
export function snippetOf(text: string | undefined, max = 120): string {
  if (!text) return '';
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** Map note id → project name, for the "所属项目" column. */
export function noteProjectMap(state: HubState): Map<string, string> {
  const map = new Map<string, string>();
  for (const project of state.projects || []) {
    for (const noteId of project.noteIds || []) {
      // First project wins; a note in two projects shows the first rather than
      // pretending it belongs to only one.
      if (!map.has(noteId)) map.set(noteId, project.name);
    }
  }
  return map;
}

/**
 * Every library item, newest first. `state` is read-only.
 */
export function buildLibraryIndex(state: HubState): LibraryItem[] {
  const projectOfNote = noteProjectMap(state);
  const items: LibraryItem[] = [];

  for (const note of state.notes || []) {
    items.push({
      key: `note:${note.id}`,
      id: note.id,
      kind: 'note',
      source: 'local',
      title: note.title || '未命名笔记',
      snippet: snippetOf(note.content),
      updatedAt: note.updatedAt || 0,
      sourceLabel: SOURCE_LABELS.local,
      kindLabel: KIND_LABELS.note,
      tags: note.tags || [],
      projectName: projectOfNote.get(note.id)
    });
  }

  for (const annotation of state.annotations || []) {
    items.push({
      key: `webpage:${annotation.id}`,
      id: annotation.id,
      kind: 'webpage',
      source: 'web-clip',
      title: annotation.pageTitle || annotation.pageUrl || '网页批注',
      snippet: snippetOf(annotation.note || annotation.text),
      updatedAt: annotation.updatedAt || annotation.createdAt || 0,
      sourceLabel: SOURCE_LABELS['web-clip'],
      kindLabel: KIND_LABELS.webpage,
      tags: annotation.tags || [],
      location: annotation.pageUrl
    });
  }

  for (const highlight of state.wucaiHighlights || []) {
    items.push({
      key: `webpage:wucai:${highlight.id}`,
      id: highlight.id,
      kind: 'webpage',
      source: 'wucai',
      title: highlight.pageTitle || highlight.pageUrl || '五彩划线',
      snippet: snippetOf(highlight.note || highlight.text),
      updatedAt: highlight.updatedAt || highlight.createdAt || 0,
      sourceLabel: SOURCE_LABELS.wucai,
      kindLabel: KIND_LABELS.webpage,
      tags: highlight.tags || [],
      location: highlight.pageUrl
    });
  }

  for (const drawing of state.handwritings || []) {
    items.push({
      key: `drawing:${drawing.id}`,
      id: drawing.id,
      kind: 'drawing',
      source: 'local',
      title: drawing.title || '未命名手绘',
      snippet: '手绘图片',
      updatedAt: drawing.createdAt || 0,
      sourceLabel: SOURCE_LABELS.local,
      kindLabel: KIND_LABELS.drawing,
      tags: drawing.tags || []
    });
  }

  for (const remote of state.obsidianNotes || []) {
    const cached = typeof remote.content === 'string' && remote.content.length > 0;
    items.push({
      key: `remote:${remote.key}`,
      id: remote.key,
      kind: 'remote',
      source: 'oss',
      title: remote.title || remote.path || remote.key,
      // Never show an empty body as if it were loaded content.
      snippet: cached ? snippetOf(remote.content) : '尚未下载正文（远端文件）',
      updatedAt: remote.lastModified || 0,
      sourceLabel: SOURCE_LABELS.oss,
      kindLabel: KIND_LABELS.remote,
      tags: [],
      location: remote.key,
      partial: !cached
    });
  }

  return items.sort((a, b) => b.updatedAt - a.updatedAt);
}

export interface LibraryFilters {
  kind?: LibraryKind | 'all';
  source?: LibrarySource | 'all';
  project?: string | 'all';
  tag?: string | 'all';
  query?: string;
}

/**
 * Apply the list filters. Kept separate so the home page can reuse the index.
 * Measured on the P2-07 fixture (6.6k items): UI-level P95 ≈ 310ms. A lower-cased
 * haystack cache was tried here and made no measurable difference — the cost is the
 */
export function filterLibrary(items: LibraryItem[], filters: LibraryFilters): LibraryItem[] {
  const query = (filters.query || '').trim().toLowerCase();
  return items.filter((item) => {
    if (filters.kind && filters.kind !== 'all' && item.kind !== filters.kind) return false;
    if (filters.source && filters.source !== 'all' && item.source !== filters.source) return false;
    if (filters.project && filters.project !== 'all') {
      if (filters.project === '__none__' ? Boolean(item.projectName) : item.projectName !== filters.project) return false;
    }
    if (filters.tag && filters.tag !== 'all' && !item.tags.includes(filters.tag)) return false;
    if (query) {
      const haystack = `${item.title} ${item.snippet} ${item.location || ''} ${item.tags.join(' ')}`.toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  });
}

/** Distinct values for the filter dropdowns. */
export function libraryFacets(items: LibraryItem[]): { kinds: LibraryKind[]; sources: LibrarySource[]; tags: string[] } {
  return {
    kinds: Array.from(new Set(items.map((i) => i.kind))),
    sources: Array.from(new Set(items.map((i) => i.source))),
    tags: Array.from(new Set(items.flatMap((i) => i.tags))).slice(0, 40)
  };
}

/**
 * Which switch owns an item.
 *
 * The unified list mixes five collections and each has its own module switch. Turning one off
 * used to hide only the sidebar entry while its rows kept showing up here, which made the
 * switch look broken — so the list filters too. Nothing is deleted: the UI reports how many
 * rows a switch is hiding.
 */
export function featureOwnerOf(item: LibraryItem): FeatureId | null {
  if (item.source === 'wucai') return 'wucai';
  if (item.source === 'youdao') return 'youdao';
  if (item.source === 'oss' || item.kind === 'remote') return 'obsidian';
  if (item.kind === 'webpage') return 'annotations';
  if (item.kind === 'drawing') return 'handwriting';
  if (item.kind === 'note') return 'notes';
  return null;
}

/** True when the item's module switch is on (or it belongs to no switchable module). */
export function isLibraryItemVisible(item: LibraryItem, features: Partial<FeatureFlags> | undefined): boolean {
  const owner = featureOwnerOf(item);
  return owner ? isFeatureEnabled(features, owner) : true;
}

/** Filter the unified list by module switches, reporting what was hidden and by whom. */
export function filterLibraryByFeatures(
  items: LibraryItem[],
  features: Partial<FeatureFlags> | undefined
): { items: LibraryItem[]; hidden: Array<{ feature: FeatureId; count: number }> } {
  const hiddenCounts = new Map<FeatureId, number>();
  const visible: LibraryItem[] = [];
  for (const item of items) {
    if (isLibraryItemVisible(item, features)) {
      visible.push(item);
      continue;
    }
    const owner = featureOwnerOf(item);
    if (owner) hiddenCounts.set(owner, (hiddenCounts.get(owner) ?? 0) + 1);
  }
  return {
    items: visible,
    hidden: Array.from(hiddenCounts.entries()).map(([feature, count]) => ({ feature, count }))
  };
}
