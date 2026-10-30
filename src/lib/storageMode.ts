/**
 * Which store is the fact source (P2 切库 phase 3).
 *
 * The switch is a **device-level** preference, deliberately outside `HubState`: the
 * library is data, this is "where do I read it from", and putting it in the payload
 * would mean the answer changes depending on which store you read the question from.
 *
 * `local` (default) keeps the app exactly as it was: the v2 payload in localStorage is
 * the fact source. `v3` reads the IndexedDB library built by the adapter, with the v2
 * payload still written on every save as the rollback path (§13.4) — a switch you
 * cannot undo is not a switch.
 */
export type StorageMode = 'local' | 'v3';

const MODE_KEY = 'selfhub_storage_mode';

export function readStorageMode(): StorageMode {
  try {
    return localStorage.getItem(MODE_KEY) === 'v3' ? 'v3' : 'local';
  } catch {
    return 'local';
  }
}

export function writeStorageMode(mode: StorageMode): void {
  try {
    if (mode === 'v3') localStorage.setItem(MODE_KEY, 'v3');
    else localStorage.removeItem(MODE_KEY);
  } catch {
    /* a failed preference write must not break the app; it just stays on v2 */
  }
}

/**
 * The library id used by the v3 store.
 *
 * Same value the backup/restore path uses, so the backup you can already make is the
 * backup of the library you just switched to.
 */
export const LOCAL_LIBRARY_ID = 'local-v2';

/**
 * Labels for both vocabularies the panel receives.
 *
 * The boot/migration path counts by *collection* (from `readLibrary`), a write reports
 * *store* names (from `writeLibrary`). Showing whichever arrived would make the same
 * library describe itself differently depending on what happened last, so both are
 * mapped to one label set.
 */
const COUNT_LABELS: Record<string, string> = {
  notes: '笔记',
  note_bodies_v3: '笔记正文',
  sites: '收藏',
  bookmarks_v3: '收藏',
  annotations: '批注',
  annotations_v3: '批注',
  handwritings: '手绘',
  projects: '项目',
  projects_v3: '项目',
  servers: '服务器',
  servers_v3: '服务器',
  secrets: '凭证',
  credentials_v3: '凭证',
  reminders: '提醒',
  reminders_v3: '提醒',
  checkIns: '签到',
  checkins_v3: '签到',
  checkin_runs_v3: '签到记录',
  inbox: '收件箱',
  inbox_v3: '收件箱',
  obsidianNotes: '远端笔记',
  remote_documents_v3: '远端笔记',
  items_v3: '条目',
  webpages_v3: '网页',
  entity_links_v3: '关联',
  blobs_v3: '缓存内容',
  attachments_v3: '附件',
  wucaiHighlights: '五彩划线',
  youdaoNotes: '有道笔记'
};

const COUNT_ORDER = [
  'notes',
  'note_bodies_v3',
  'sites',
  'bookmarks_v3',
  'annotations',
  'annotations_v3',
  'wucaiHighlights',
  'handwritings',
  'items_v3',
  'webpages_v3',
  'projects',
  'projects_v3',
  'servers',
  'servers_v3',
  'secrets',
  'credentials_v3',
  'reminders',
  'reminders_v3',
  'checkIns',
  'checkins_v3',
  'checkin_runs_v3',
  'inbox',
  'inbox_v3',
  'obsidianNotes',
  'remote_documents_v3',
  'blobs_v3',
  'attachments_v3',
  'entity_links_v3'
];

export function describeV3Counts(counts: Record<string, number>): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const key of COUNT_ORDER) {
    const value = counts[key];
    if (value === undefined) continue;
    const label = COUNT_LABELS[key] ?? key;
    // `notes` and `note_bodies_v3` both exist after a write; show each label once.
    if (seen.has(label)) continue;
    seen.add(label);
    parts.push(`${label} ${value}`);
  }
  for (const [key, value] of Object.entries(counts)) {
    if (COUNT_ORDER.includes(key)) continue;
    parts.push(`${COUNT_LABELS[key] ?? key} ${value}`);
  }
  return parts.join(' · ');
}
