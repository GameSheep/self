/**
 * Bookmark import with a real preview (P1-04).
 * The old flow ran `alert('成功导入 N 个网址')` *after* writing, with no way to
 * see what was about to happen and no way to take it back. This dialog:
 * · 4. never overwrites an existing site: duplicates are skipped by default, with
 */
import React, { useMemo, useState } from 'react';
import { AlertTriangle, Check, FileText, FolderPlus, Undo2, Upload } from 'lucide-react';
import { NavSite } from '../../types';
import { Button, StatusPill, inputClass } from '../../shared/ui';

/* -------------------------------------------------------------------------- */
/* Pure parsing helpers (exported so they can be unit-inspected)               */
/* -------------------------------------------------------------------------- */

/** Normalise a URL for duplicate detection (ignore protocol, www, trailing slash). */
export function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    const path = u.pathname.replace(/\/$/, '');
    return `${u.hostname.replace(/^www\./, '')}${path}${u.search}`.toLowerCase();
  } catch {
    return (raw || '').trim().toLowerCase();
  }
}

export interface ParsedBookmark {
  title: string;
  url: string;
  /** Folder path joined with ' / '; '' when the bookmark sits at the root. */
  folderPath: string;
  /** The group this bookmark will land in once imported. */
  category: string;
}

export interface ParsedBookmarks {
  /**
   * Every `<a>` in the file, including the ones that cannot be imported
   * (`javascript:`, `chrome://`, …). Kept separate from `links` because the
   * preview must not present unusable entries as importable bookmarks.
   */
  total: number;
  /** Usable http(s) links found in the file (before de-duplication). */
  links: number;
  items: ParsedBookmark[];
  /** Links that are not http(s) at all (javascript:, chrome://, place:, …). */
  invalid: number;
  /** Usable links inside the file that point at the same normalised URL. */
  duplicatesInFile: number;
}

export const DEFAULT_IMPORT_CATEGORY = '浏览器书签导入';

/**
 * Walk the nested `<DL>/<DT>` structure of a Netscape bookmark export.
 *
 * Folder names are the textual content of the `<H3>` that opens a `<DT>`; every
 * following `<DL>` is that folder's children and is visited with the extended
 * path, so nested exports keep their sub-folders.
 */
export function parseBookmarkHtml(html: string): ParsedBookmarks {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const items: ParsedBookmark[] = [];
  const seen = new Set<string>();
  let total = 0;
  let links = 0;
  let invalid = 0;
  let duplicatesInFile = 0;

  const visitDl = (dl: Element, path: string[]) => {
    for (const child of Array.from(dl.children)) {
      if (child.tagName !== 'DT') continue;
      const h3 = child.querySelector('h3');
      if (h3) {
        const name = (h3.textContent || '').trim();
        const nextPath = name ? [...path, name] : path;
        const nested = h3.nextElementSibling;
        if (nested && nested.tagName === 'DL') visitDl(nested, nextPath);
        continue;
      }

      const a = child.querySelector('a');
      if (!a) continue;
      total += 1;

      const href = (a.getAttribute('href') || '').trim();
      if (!/^https?:\/\//i.test(href)) {
        invalid += 1;
        continue;
      }
      links += 1;
      const title = (a.textContent || '').replace(/\s+/g, ' ').trim();
      const key = normalizeUrl(href);
      if (seen.has(key)) {
        duplicatesInFile += 1;
        continue;
      }
      seen.add(key);
      items.push({ title, url: href, folderPath: path.join(' / '), category: '' });
    }
  };

  doc.querySelectorAll('dl').forEach((dl) => {
    // Nested DLs are reached through their parent DT; only start from the root.
    if (!dl.parentElement?.closest('dl')) visitDl(dl, []);
  });

  return { total, links, items, invalid, duplicatesInFile };
}

export interface ImportPreviewRow extends ParsedBookmark {
  status: 'new' | 'duplicate' | 'copy';
  /** Missing title and/or group — "unknown fields" in the P1-04 wording. */
  incompleteFields: string[];
  categoryForImport: string;
}

export interface ImportPreview {
  total: number;
  usable: number;
  /** Links whose URL already exists in the library. */
  duplicates: number;
  duplicatesInFile: number;
  invalid: number;
  /** Usable, non-duplicate links that lack a title and/or a folder. */
  incomplete: number;
  rows: ImportPreviewRow[];
  /** Groups that do not exist in the library yet and would be created. */
  groupsToCreate: string[];
  existingGroups: string[];
  defaultGroup: string;
}

export function buildImportPreview(
  parsed: ParsedBookmarks,
  existingSites: NavSite[],
  options: { overwriteExisting?: boolean } = {}
): ImportPreview {
  const existing = new Set(existingSites.map((site) => normalizeUrl(site.url)));
  const knownGroups = new Set(
    existingSites.map((site) => (site.category || '').trim()).filter(Boolean)
  );

  const rows: ImportPreviewRow[] = parsed.items.map((item) => {
    const isDuplicate = existing.has(normalizeUrl(item.url));
    const categoryForImport = item.folderPath ? item.folderPath : DEFAULT_IMPORT_CATEGORY;
    const incompleteFields: string[] = [];
    if (!item.title) incompleteFields.push('标题');
    if (!item.folderPath) incompleteFields.push('分组');
    return {
      ...item,
      status: isDuplicate ? (options.overwriteExisting ? 'copy' : 'duplicate') : 'new',
      incompleteFields,
      categoryForImport
    };
  });

  const groupsToCreate = Array.from(
    new Set(rows.map((row) => row.categoryForImport).filter((group) => !knownGroups.has(group)))
  ).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));

  return {
    // Only http(s) links are importable, so this is the number the preview must
    // show as "found". Non-importable hrefs are reported on their own line.
    total: parsed.links,
    usable: parsed.items.length,
    duplicates: rows.filter((row) => row.status === 'duplicate').length,
    duplicatesInFile: parsed.duplicatesInFile,
    invalid: parsed.invalid,
    incomplete: rows.filter((row) => row.status !== 'duplicate' && row.incompleteFields.length > 0).length,
    rows,
    groupsToCreate,
    existingGroups: Array.from(knownGroups).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN')),
    defaultGroup: DEFAULT_IMPORT_CATEGORY
  };
}

/* -------------------------------------------------------------------------- */
/* Dialog                                                                     */
/* -------------------------------------------------------------------------- */

export interface BookmarkImportResult {
  /** How many records were appended. */
  added: number;
  /** Ids of exactly those records, for 撤销. */
  addedIds: string[];
  /** Duplicates that were left untouched. */
  skipped: number;
}
interface BookmarkImportDialogProps {
  open: boolean;
  sites: NavSite[];
  /**
   * `second arg` = the user explicitly opted into importing duplicates as
   * copies. Without it the caller must skip URLs that already exist: importing
   * may never overwrite or silently double an existing site.
   */
  onImport: (newSites: NavSite[], options: { allowDuplicates: boolean }) => BookmarkImportResult;
  onUndo: (ids: string[]) => number;
  onClose: () => void;
}

export const BookmarkImportDialog: React.FC<BookmarkImportDialogProps> = ({
  open,
  sites,
  onImport,
  onUndo,
  onClose
}) => {
  const [fileName, setFileName] = useState('');
  const [parsed, setParsed] = useState<ParsedBookmarks | null>(null);
  const [parseError, setParseError] = useState('');
  const [importCopies, setImportCopies] = useState(false);
  const [result, setResult] = useState<BookmarkImportResult | null>(null);
  const [undoCount, setUndoCount] = useState<number | null>(null);
  const [step, setStep] = useState<'pick' | 'preview' | 'done'>('pick');

  const preview = useMemo(
    () => (parsed ? buildImportPreview(parsed, sites, { overwriteExisting: importCopies }) : null),
    [parsed, sites, importCopies]
  );

  const reset = () => {
    setFileName('');
    setParsed(null);
    setParseError('');
    setImportCopies(false);
    setResult(null);
    setUndoCount(null);
    setStep('pick');
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Allow picking the same file again after a reset.
    e.target.value = '';
    if (!file) return;

    const reader = new FileReader();
    reader.onerror = () => {
      setParseError('读取书签文件失败，请确认文件完整后重试。');
      setStep('preview');
    };
    reader.onload = (event) => {
      const text = String(event.target?.result ?? '');
      const next = parseBookmarkHtml(text);
      if (next.links === 0) {
        setParsed(null);
        setParseError('文件里没有检测到书签超链接（需要 Chrome / Edge / GoTab 导出的 HTML）。');
        setStep('preview');
        return;
      }
      setFileName(file.name);
      setParseError('');
      setParsed(next);
      setStep('preview');
    };
    reader.readAsText(file);
  };

  const handleImport = () => {
    if (!preview) return;
    // One batch: duplicates are skipped unless the user opted into copies. The
    // dialog knows which rows it is leaving behind; the caller only sees the
    // batch, so the skip count has to travel with it.
    const toImport = preview.rows.filter((row) => row.status !== 'duplicate');
    const batch: NavSite[] = toImport.map((row, index) => ({
      id: `site-bm-${Date.now()}-${index}`,
      title: row.title || row.url,
      url: row.url,
      category: row.categoryForImport,
      visitCount: 0,
      createdAt: Date.now() + index
    }));
    const outcome = onImport(batch, { allowDuplicates: importCopies });
    setResult({ ...outcome, skipped: outcome.skipped + preview.duplicates });
    setStep('done');
  };

  const handleUndo = () => {
    if (!result) return;
    const removed = onUndo(result.addedIds);
    setUndoCount(removed);
    setResult(null);
  };

  if (!open) return null;

  const pendingCount = preview ? preview.rows.filter((row) => row.status !== 'duplicate').length : 0;
  const skippedCount = preview ? preview.duplicates : 0;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center p-4"
      style={{ background: 'var(--sh-overlay)' }}
      onClick={handleClose}
      role="dialog"
      aria-modal="true"
      aria-label="导入书签"
    >
      <div
        data-testid="bookmark-import-dialog"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-2xl max-h-[85vh] overflow-y-auto rounded-2xl border border-sh-line bg-sh-surface p-4 space-y-3 shadow-2xl"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-sh-fg flex items-center gap-2">
              <FileText className="w-4 h-4 text-sh-info" aria-hidden />
              导入书签（预览后再写入）
            </h3>
            <p className="text-[11px] text-sh-muted mt-1 leading-relaxed">
              支持 Chrome / Edge / GoTab 导出的 HTML 书签文件。导入前先看清数量、重复项与将要创建的分组；
              导入是一整批，可一键撤销。
            </p>
          </div>
          <button onClick={handleClose} className="p-1 rounded-lg text-sh-subtle hover:text-sh-fg" aria-label="关闭">
            ×
          </button>
        </div>

        {step === 'pick' && (
          <div className="space-y-3">
            <label className={`${inputClass} flex items-center justify-center gap-2 cursor-pointer py-6 border-dashed`}>
              <Upload className="w-4 h-4 text-sh-muted" aria-hidden />
              <span className="text-xs text-sh-muted">选择书签 HTML 文件</span>
              <input
                type="file"
                accept=".html,.htm"
                className="hidden"
                data-testid="bookmark-file-input"
                onChange={handleFile}
              />
            </label>
            <p className="text-[11px] text-sh-subtle">
              只读取本地文件，解析在浏览器里完成，不会上传到任何服务。
            </p>
          </div>
        )}

        {step === 'preview' && parseError && (
          <div className="rounded-xl border border-sh-danger/40 bg-sh-danger/5 p-3 text-xs text-sh-danger flex items-start gap-2">
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" aria-hidden />
            <span>{parseError}</span>
          </div>
        )}

        {step === 'preview' && preview && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <Stat label="文件中的书签链接" value={preview.total} hint="只统计 http(s) 链接" />
              <Stat label="将导入" value={pendingCount} tone="ok" />
              <Stat label="重复（已存在）" value={preview.duplicates} tone={preview.duplicates ? 'warn' : 'neutral'} />
              <Stat
                label="字段不完整"
                value={preview.incomplete}
                tone={preview.incomplete ? 'warn' : 'neutral'}
                hint="没有标题或没有分组"
              />
            </div>

            <div className="flex flex-wrap items-center gap-2 text-[11px] text-sh-muted">
              <span className="text-sh-subtle">文件：</span>
              <span className="font-mono text-sh-fg">{fileName}</span>
              {preview.duplicatesInFile > 0 && <StatusPill tone="warn" label={`文件内自重复 ${preview.duplicatesInFile}`} />}
              {preview.invalid > 0 && <StatusPill tone="neutral" label={`未导入的非 http 链接 ${preview.invalid}`} />}
            </div>

            <div className="rounded-xl border border-sh-line bg-sh-surface2/50 p-3 space-y-2">
              <div className="flex items-center gap-2 text-xs font-medium text-sh-fg">
                <FolderPlus className="w-3.5 h-3.5 text-sh-info" aria-hidden />
                将创建的分组
                <span className="text-[11px] font-mono text-sh-muted">({preview.groupsToCreate.length})</span>
              </div>
              {preview.groupsToCreate.length === 0 ? (
                <p className="text-[11px] text-sh-muted">没有新分组，全部书签都会落进已存在的分组。</p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {preview.groupsToCreate.map((group) => (
                    <span
                      key={group}
                      data-testid="preview-new-group"
                      className="px-1.5 py-0.5 rounded border border-sh-info/40 text-sh-info text-[10px]"
                    >
                      {group}
                    </span>
                  ))}
                </div>
              )}
              {preview.existingGroups.length > 0 && (
                <p className="text-[11px] text-sh-subtle">
                  已存在的分组会直接复用：{preview.existingGroups.join('、')}
                </p>
              )}
            </div>

            <div className="rounded-xl border border-sh-line overflow-hidden">
              <div className="grid grid-cols-[1fr_auto] gap-2 px-3 py-1.5 bg-sh-surface2 text-[10px] text-sh-subtle">
                <span>书签（最多显示 20 条）</span>
                <span>状态 / 分组</span>
              </div>
              <div className="divide-y divide-sh-line max-h-56 overflow-y-auto">
                {preview.rows.slice(0, 20).map((row, index) => (
                  <div key={`${row.url}-${index}`} className="grid grid-cols-[1fr_auto] gap-2 px-3 py-1.5 items-center">
                    <div className="min-w-0">
                      <div className="text-[11px] text-sh-fg truncate">
                        {row.title || <span className="text-sh-warn">（无标题）</span>}
                      </div>
                      <div className="text-[10px] text-sh-subtle font-mono truncate">{row.url}</div>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      {row.status === 'new' && <StatusPill tone="ok" label="新增" />}
                      {row.status === 'duplicate' && <StatusPill tone="warn" label="重复，跳过" />}
                      {row.status === 'copy' && <StatusPill tone="info" label="重复，存为副本" />}
                      <span className="text-[10px] text-sh-subtle max-w-[140px] truncate">
                        {row.incompleteFields.length > 0
                          ? `缺${row.incompleteFields.join('/')} → ${row.categoryForImport}`
                          : row.categoryForImport}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {preview.duplicates > 0 && (
              /* A bare <div>, not a <label>: a label wrapping the checkbox makes
                 Playwright's check() toggle it twice (click on the input + the
                 label forwarding a second click). */
              <div
                role="checkbox"
                aria-checked={importCopies}
                tabIndex={0}
                data-testid="import-duplicates-row"
                onClick={() => setImportCopies((v) => !v)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setImportCopies((v) => !v);
                  }
                }}
                className="flex items-center gap-2 text-[11px] text-sh-muted cursor-pointer"
              >
                <input
                  type="checkbox"
                  data-testid="import-duplicates-as-copies"
                  checked={importCopies}
                  readOnly
                  tabIndex={-1}
                  className="pointer-events-none"
                />
                把 {preview.duplicates} 个重复链接也导入为新副本（默认跳过，不会覆盖已有网站）
              </div>
            )}

            <div className="flex items-center justify-end gap-2 pt-1">
              <Button variant="secondary" onClick={reset}>
                换一个文件
              </Button>
              <Button
                variant="primary"
                data-testid="bookmark-import-confirm"
                disabled={pendingCount === 0}
                onClick={handleImport}
              >
                {pendingCount === 0 ? '没有新书签可导入' : `导入 ${pendingCount} 个书签`}
              </Button>
            </div>
            {pendingCount < preview.usable && (
              <p className="text-[11px] text-sh-subtle text-right">
                将跳过 {skippedCount} 个已存在的链接；已有网站不会被覆盖。
              </p>
            )}
          </div>
        )}

        {step === 'done' && (
          <div className="space-y-3">
            <div
              data-testid="import-status"
              className="rounded-xl border border-sh-line bg-sh-surface2/60 p-3 space-y-1.5 text-xs"
            >
              <div className="flex items-center gap-2">
                <StatusPill tone="ok" label={`已导入 ${result?.added ?? 0} 个`} />
                {(result?.skipped ?? 0) > 0 && <StatusPill tone="warn" label={`跳过重复 ${result?.skipped}`} />}
              </div>
              <p className="text-[11px] text-sh-muted leading-relaxed">
                {result && result.added > 0
                  ? '这一整批的 ID 已记录，可以用“撤销导入”把它们全部移除，其它网站不受影响。'
                  : '没有新增任何网站。'}
              </p>
            </div>
            {undoCount !== null && (
              <div className="rounded-xl border border-sh-line bg-sh-surface2/60 p-3 text-xs text-sh-fg">
                已撤销，移除了 {undoCount} 个本次导入的网站。
              </div>
            )}
            <div className="flex items-center justify-end gap-2">
              <Button variant="secondary" data-testid="import-done" onClick={handleClose}>
                {undoCount !== null ? '完成' : '关闭'}
              </Button>
              {result && result.added > 0 ? (
                <Button variant="danger" icon={<Undo2 className="w-3.5 h-3.5" />} onClick={handleUndo}>
                  撤销导入
                </Button>
              ) : (
                <Button variant="secondary" icon={<Check className="w-3.5 h-3.5" />} onClick={reset}>
                  再导入一个文件
                </Button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

const Stat: React.FC<{ label: string; value: number; tone?: 'neutral' | 'ok' | 'warn'; hint?: string }> = ({
  label,
  value,
  tone = 'neutral',
  hint
}) => (
  <div className="rounded-xl border border-sh-line bg-sh-surface2/50 px-3 py-2">
    <div className="text-[10px] text-sh-subtle">{label}</div>
    <div
      data-tone={tone}
      className={`text-sm font-semibold ${
        tone === 'ok' ? 'text-sh-ok' : tone === 'warn' ? 'text-sh-warn' : 'text-sh-fg'
      }`}
    >
      {value}
    </div>
    {hint && <div className="text-[10px] text-sh-subtle">{hint}</div>}
  </div>
);

export default BookmarkImportDialog;
