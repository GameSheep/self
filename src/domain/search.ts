/**
 * Unified search across every collection (P2-07 "统一索引覆盖").
 *
 * There were three overlapping searches with different reach: the ⌘K dialog matched
 * titles and note bodies (but not annotations), the library filtered notes,
 * annotations and remote metadata, and the vault index searched remote note bodies.
 * "Where can I find this?" therefore depended on which box you typed into, and
 * annotations — the thing this product is *for* — were invisible in the global box.
 *
 * This module is the single answer: one scan over all sources, grouped by kind, with
 * a real snippet per hit, a declared coverage (what was and was not searched) and
 * per-kind totals so the UI can say "还有 N 条" instead of silently truncating.
 *
 * What it deliberately does **not** do:
 * - decrypt or index vault plaintext. A credential matches on its name, description,
 *   category and tags only; the ciphertext is never searched ($12.1).
 * - claim completeness it cannot have: remote note bodies are only searchable when the
 *   local index holds them, and that is reported in `coverage`.
 */
import type { HubState } from '../types';
import type { IndexedDoc } from '../lib/vaultIndex';
import { matchesQuery } from '../lib/searchEngine';

export type SearchKind =
  | 'note'
  | 'annotation'
  | 'drawing'
  | 'bookmark'
  | 'server'
  | 'reminder'
  | 'project'
  | 'inbox'
  | 'secret'
  | 'remote'
  | 'vault';

export const SEARCH_KIND_LABELS: Record<SearchKind, string> = {
  note: '笔记',
  annotation: '网页批注',
  drawing: '手绘',
  bookmark: '收藏',
  server: '服务器',
  reminder: '提醒',
  project: '项目',
  inbox: '收件箱',
  secret: '金库',
  remote: '远端文件',
  vault: '远端全文'
};

export interface SearchHit<T = unknown> {
  kind: SearchKind;
  /** Entity id (or remote key). Empty for vault hits that carry their own key. */
  id: string;
  title: string;
  /** Context around the match; absent when there is nothing useful to show. */
  snippet?: string;
  /** Offset of the match inside `snippet`, when the match was literal. */
  matchIndex?: number;
  matchLength?: number;
  /** Small right-aligned detail (category, env, due date…). */
  meta?: string;
  /** The entity itself, so the caller does not have to re-find it by id. */
  entity?: T;
}

export interface SearchGroup {
  kind: SearchKind;
  label: string;
  /** Matches in this kind, before the per-kind limit. */
  total: number;
  hits: Array<SearchHit>;
}

export interface SearchCoverage {
  /** Sources that were actually scanned, in user language. */
  searched: string[];
  /** Sources that could not be scanned, with the reason. */
  skipped: string[];
}

export interface SearchResult {
  query: string;
  groups: SearchGroup[];
  total: number;
  coverage: SearchCoverage;
  /** Kinds that have more matches than the returned `hits`. */
  truncated: SearchKind[];
}

const DEFAULT_LIMIT = 5;

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Snippet around the first literal match.
 *
 * Pinyin and multi-token matches have no literal offset, so they fall back to the
 * head of the field without a highlight. Pretending otherwise would put the highlight
 * on the wrong characters.
 */
export function snippetAround(source: string, query: string, radius = 42): { snippet: string; matchIndex?: number } {
  const text = collapse(source);
  const needle = query.trim().toLowerCase();
  if (!needle) return { snippet: text.slice(0, radius * 2) };
  const index = text.toLowerCase().indexOf(needle);
  if (index < 0) return { snippet: text.slice(0, radius * 2) };
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + needle.length + radius);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < text.length ? '…' : '';
  const snippet = `${prefix}${text.slice(start, end)}${suffix}`;
  // Whitespace was collapsed, so re-locate inside the final string.
  const found = snippet.toLowerCase().indexOf(needle);
  return { snippet, matchIndex: found >= 0 ? found : undefined };
}

interface ScanSource<T> {
  kind: SearchKind;
  meta?: string;
  rows: T[];
  /** Text that participates in matching. */
  haystack: (row: T) => string;
  /** Text a snippet is taken from (usually the most specific field). */
  snippetSource: (row: T) => string;
  title: (row: T) => string;
  id: (row: T) => string;
  detail?: (row: T) => string | undefined;
}

function scan<T>(source: ScanSource<T>, query: string, limit: number): SearchGroup {
  const hits: Array<SearchHit> = [];
  let total = 0;
  for (const row of source.rows) {
    if (!matchesQuery(source.haystack(row), query)) continue;
    total += 1;
    if (hits.length >= limit) continue;
    const { snippet, matchIndex } = snippetAround(source.snippetSource(row), query);
    hits.push({
      kind: source.kind,
      id: source.id(row),
      title: source.title(row) || '(无标题)',
      snippet,
      matchIndex,
      matchLength: matchIndex === undefined ? undefined : query.trim().length,
      meta: source.detail?.(row),
      entity: row
    });
  }
  return { kind: source.kind, label: SEARCH_KIND_LABELS[source.kind], total, hits };
}

export interface SearchEverythingInput {
  state: HubState;
  /** Bodies from the local vault index; absent means "not indexed yet". */
  vaultDocs?: IndexedDoc[];
  query: string;
  /** Restrict to these kinds (the dialog's filter chips). */
  kinds?: SearchKind[];
  /** Per-kind limits; defaults to 5. */
  limits?: Partial<Record<SearchKind, number>>;
  defaultLimit?: number;
}

/**
 * What a search does and does not cover, in user language.
 *
 * Reported even when the query is empty: "the palette covers these sources, and these
 * ones it cannot" is exactly the information a user needs *before* trusting a miss.
 */
export function buildCoverage(vaultDocs: IndexedDoc[]): SearchCoverage {
  const searched = [
    '本机笔记（标题与正文）',
    '网页批注（原文与我的批注）',
    '收藏（标题/网址/分类）',
    '服务器（名称/地址/备注）',
    '提醒（标题/备注）',
    '项目（名称/描述）',
    '收件箱（内容）',
    '手绘（标题）',
    '金库条目（名称与描述）'
  ];
  const skipped: string[] = [];
  if (vaultDocs.length === 0) {
    skipped.push('远端笔记正文：本机还没有建立全文索引，目前只能按文件名匹配。');
  } else {
    searched.push(`远端笔记正文（本机索引 ${vaultDocs.length} 篇）`);
  }
  skipped.push('金库明文与连接密钥：不参与搜索，只在解锁后按你的操作单独解密。');
  return { searched, skipped };
}

export function searchEverything(input: SearchEverythingInput): SearchResult {
  const query = input.query.trim();
  const state = input.state;
  const wanted = input.kinds && input.kinds.length > 0 ? new Set(input.kinds) : null;
  const limitFor = (kind: SearchKind) => input.limits?.[kind] ?? input.defaultLimit ?? DEFAULT_LIMIT;
  const vaultDocs = input.vaultDocs ?? [];

  const coverage = buildCoverage(vaultDocs);

  if (!query) {
    // Coverage is still reported for an empty query: the palette should be able to say
    // what it searches *before* the user types, not only after a miss.
    return { query, groups: [], total: 0, coverage, truncated: [] };
  }

  // Heterogeneous list of sources: each entry is `ScanSource<T>` for its own entity
  // type, and the scan loop treats them uniformly. `any` here is contained to this
  // array — the public surface (`SearchHit`, `SearchResult`) is typed.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sources: Array<ScanSource<any>> = [
    {
      kind: 'note',
      rows: state.notes || [],
      haystack: (n) => `${n.title} ${n.content} ${n.category || ''} ${(n.tags || []).join(' ')}`,
      snippetSource: (n) => `${n.title}\n${n.content}`,
      title: (n) => n.title,
      id: (n) => n.id,
      detail: (n) => n.category || '笔记'
    },
    {
      kind: 'annotation',
      rows: state.annotations || [],
      haystack: (a) => `${a.pageTitle} ${a.pageUrl} ${a.text} ${a.note || ''} ${(a.tags || []).join(' ')}`,
      // Prefer the user's own comment when there is one: that is what they remember.
      snippetSource: (a) => (a.note ? `${a.note}\n${a.text}` : a.text),
      title: (a) => a.pageTitle || a.pageUrl,
      id: (a) => a.id,
      detail: (a) => (a.note ? '含我的批注' : '划线')
    },
    {
      kind: 'drawing',
      rows: state.handwritings || [],
      haystack: (h) => `${h.title} ${(h.tags || []).join(' ')}`,
      snippetSource: (h) => h.title,
      title: (h) => h.title,
      id: (h) => h.id,
      detail: () => '手绘'
    },
    {
      kind: 'bookmark',
      rows: state.sites || [],
      haystack: (s) => `${s.title} ${s.url} ${s.category || ''} ${s.description || ''} ${(s.tags || []).join(' ')}`,
      snippetSource: (s) => `${s.title} ${s.url}`,
      title: (s) => s.title,
      id: (s) => s.id,
      detail: (s) => s.category || '收藏'
    },
    {
      kind: 'server',
      rows: state.servers || [],
      haystack: (srv) =>
        `${srv.name} ${srv.publicIp} ${srv.domain || ''} ${srv.sshUser || ''} ${srv.notes || ''} ${srv.env}`,
      snippetSource: (srv) => `${srv.name} ${srv.publicIp} ${srv.notes || ''}`,
      title: (srv) => srv.name,
      id: (srv) => srv.id,
      detail: (srv) => srv.env.toUpperCase()
    },
    {
      kind: 'reminder',
      rows: state.reminders || [],
      haystack: (r) => `${r.title} ${r.cost || ''} ${r.notes || ''} ${r.category}`,
      snippetSource: (r) => `${r.title} ${r.notes || ''}`,
      title: (r) => r.title,
      id: (r) => r.id,
      detail: (r) => (r.targetDate ? new Date(r.targetDate).toLocaleDateString() : '提醒')
    },
    {
      kind: 'project',
      rows: state.projects || [],
      haystack: (p) => `${p.name} ${p.description} ${(p.tags || []).join(' ')} ${p.status}`,
      snippetSource: (p) => `${p.name} ${p.description}`,
      title: (p) => p.name,
      id: (p) => p.id,
      detail: (p) => `项目·${p.status}`
    },
    {
      kind: 'inbox',
      rows: state.inbox || [],
      haystack: (i) => `${i.content} ${i.title || ''} ${i.url || ''} ${i.type}`,
      snippetSource: (i) => `${i.title || ''} ${i.content}`,
      title: (i) => i.title || i.content.slice(0, 30),
      id: (i) => i.id,
      detail: (i) => (i.status === 'inbox' ? '待处理' : '已处理')
    },
    {
      kind: 'secret',
      // Name/描述/分类/标签 only: the ciphertext is never searched ($12.1).
      rows: state.secrets || [],
      haystack: (s) => `${s.name} ${s.description || ''} ${s.category} ${(s.tags || []).join(' ')}`,
      snippetSource: (s) => `${s.name} ${s.description || ''}`,
      title: (s) => s.name,
      id: (s) => s.id,
      detail: (s) => s.maskedPreview
    },
    {
      kind: 'remote',
      rows: state.obsidianNotes || [],
      haystack: (n) => `${n.title} ${n.path}`,
      snippetSource: (n) => n.path,
      title: (n) => n.title,
      id: (n) => n.key,
      detail: (n) => (n.content ? '远端·已缓存' : '远端·未下载')
    }
  ];

  if (vaultDocs.length > 0) {
    sources.push({
      kind: 'vault',
      rows: vaultDocs,
      haystack: (d) => `${d.title} ${d.text} ${d.tags.join(' ')}`,
      snippetSource: (d) => `${d.title}\n${d.text}`,
      title: (d) => d.title,
      id: (d) => d.key,
      detail: (d) => (d.key.includes('/') ? d.key.split('/').slice(0, -1).join('/') : '根目录')
    });
  }

  const groups: SearchGroup[] = [];
  const truncated: SearchKind[] = [];
  let total = 0;
  for (const source of sources) {
    if (wanted && !wanted.has(source.kind)) continue;
    const group = scan(source, query, limitFor(source.kind));
    if (group.total === 0) continue;
    total += group.total;
    if (group.total > group.hits.length) truncated.push(group.kind);
    groups.push(group);
  }

  const searched = [
    '本机笔记（标题与正文）',
    '网页批注（原文与我的批注）',
    '收藏（标题/网址/分类）',
    '服务器（名称/地址/备注）',
    '提醒（标题/备注）',
    '项目（名称/描述）',
    '收件箱（内容）',
    '手绘（标题）',
    '金库条目（名称与描述）'
  ];
  const skipped: string[] = [];
  if (vaultDocs.length === 0) {
    skipped.push('远端笔记正文：本机还没有建立全文索引，目前只能按文件名匹配。');
  } else {
    searched.push(`远端笔记正文（本机索引 ${vaultDocs.length} 篇）`);
  }
  skipped.push('金库明文与连接密钥：不参与搜索，只在解锁后按你的操作单独解密。');

  return {
    query,
    groups,
    total,
    coverage: { searched, skipped },
    truncated
  };
}
