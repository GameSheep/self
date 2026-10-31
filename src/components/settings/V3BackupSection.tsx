import React, { useState } from 'react';
import { AlertTriangle, RefreshCw, Trash2 } from 'lucide-react';
import { Button, Section, StatusPill } from '../../shared/ui';
import type { V3BackupPanelState } from '../../hooks/useV3Backup';
import type { ConflictStrategy } from '../../infrastructure/backup/restoreService';

/**
 * "v3 加密备份" panel (P2-05).
 * Everything here is a statement the app can back up with storage facts:
 * - which format the automatic task writes **right now**,
 */
export interface V3BackupSectionProps {
  panel: V3BackupPanelState;
  /** Resolved destination description from the shared backup resolver. */
  destination?: string;
  /**
   * Policy-level warning about the chosen format (from `resolveBackupTarget`), shown before
   * any status is fetched. Absent when the format can carry this device's data.
   */
  formatWarning?: string;
  onUnlock: (password: string) => void;
  onLock: () => void;
  onRefresh: () => void;
  onRun: () => void;
  onPrune: () => void;
  onFormatChange: (format: 'legacy' | 'v3') => void;
  /** P2-06: parse one batch into staging and show the diff report. */
  onPreviewBatch: (generationId: string) => void;
  onConflictChoice: (collection: string, strategy: ConflictStrategy) => void;
  onRestoreMode: (mode: 'merge' | 'replace') => void;
  onApplyRestore: () => void;
  onDiscardPreview: () => void;
  /** P2-06 migration packages. */
  credentialScope: string[];
  onExportMigration: () => void;
  onPreviewMigration: (generationId: string) => void;
  onImportCredentialsChange: (value: boolean) => void;
  onRemoveMigration: (generationId: string) => void;
  /** §9.1 single-file exchange between the web app and the packaged extension. */
  onExportBundle: (includeCredentials: boolean) => void;
  onImportBundle: (json: string) => void;
  onRetestConnections: (services: string[]) => void;
  busy?: boolean;
}

/** Plain-language names for the collections a restore reports on. */
const COLLECTION_LABELS: Record<string, string> = {
  sites: '收藏',
  notes: '笔记',
  annotations: '网页批注',
  handwritings: '手绘',
  projects: '项目',
  servers: '服务器',
  secrets: '金库条目',
  reminders: '提醒',
  checkIns: '签到',
  inbox: '收件箱',
  wucaiHighlights: '五彩导入',
  youdaoNotes: '有道导入'
};

function formatWhen(at?: number): string {
  if (!at) return '时间未知';
  try {
    return new Date(at).toLocaleString();
  } catch {
    return String(at);
  }
}

export const V3BackupSection: React.FC<V3BackupSectionProps> = ({
  panel,
  destination,
  formatWarning,
  onUnlock,
  onLock,
  onRefresh,
  onRun,
  onPrune,
  onFormatChange,
  onPreviewBatch,
  onConflictChoice,
  onRestoreMode,
  onApplyRestore,
  onDiscardPreview,
  credentialScope,
  onExportMigration,
  onPreviewMigration,
  onImportCredentialsChange,
  onRemoveMigration,
  onExportBundle,
  onImportBundle,
  onRetestConnections
}) => {
  const [draft, setDraft] = useState('');
  const [confirmingExport, setConfirmingExport] = useState(false);
  const [confirmingBundleCredentials, setConfirmingBundleCredentials] = useState(false);
  const status = panel.status;
  const usable = status?.usable ?? false;
  const latest = status?.latestBatch;
  const activeFormat = status?.format ?? panel.format;

  return (
    <Section
      title="v3 加密备份（可选）"
      description="旧的 .selfhub/state.json 仍是默认格式。启用后每次备份是一个独立、加密、带完成标记的批次，范围与失败原因都会如实显示。"
      className="bg-sh-surface2/40"
    >
      <div className="space-y-3" data-testid="v3-backup-section">
        <div className="grid gap-2 sm:grid-cols-2">
          {(
            [
              { id: 'legacy', label: '继续使用旧格式（state.json）', hint: '兼容现有恢复入口；明文整包' },
              { id: 'v3', label: '使用 v3 加密备份', hint: '独立批次、加密、带完成标记与范围报告' }
            ] as const
          ).map((option) => (
            <button
              key={option.id}
              onClick={() => onFormatChange(option.id)}
              data-v3-format-option={option.id}
              data-active={activeFormat === option.id ? 'true' : 'false'}
              className={`text-left rounded-xl border px-3 py-2 transition-colors ${
                activeFormat === option.id
                  ? 'border-sh-line-strong bg-sh-surface'
                  : 'border-sh-line bg-transparent hover:border-sh-line-strong'
              }`}
            >
              <span className="block text-[12px] text-sh-fg font-medium">{option.label}</span>
              <span className="block text-[11px] text-sh-subtle leading-relaxed">{option.hint}</span>
            </button>
          ))}
        </div>
        <div className="text-[11px] text-sh-muted">
          当前自动备份格式：<span data-testid="v3-format" className="text-sh-fg font-mono">{activeFormat}</span>
        </div>

        {/*
          v3 storage + legacy format: the backup would write the device payload, which holds
          no notes/bookmarks/vault entries. Automatic runs are already stopped by the policy
          resolver; this is the visible half, plus the one-click way out.

          Rendered from the `formatWarning` prop rather than the fetched status: it is a
          *policy* fact (storage mode + chosen format), and a warning that only appears after
          someone asks to refresh the status is a warning nobody sees.
        */}
        {(formatWarning || status?.formatWarning) && (
          <div
            className="rounded-xl border border-sh-warn/50 bg-sh-warn/10 p-3 space-y-2 text-[11px] text-sh-warn"
            data-testid="v3-format-warning"
            role="status"
          >
            <p className="leading-relaxed">{formatWarning ?? status?.formatWarning}</p>
            <Button variant="secondary" size="sm" data-testid="v3-format-warning-fix" onClick={() => onFormatChange('v3')}>
              改用 v3 加密备份
            </Button>
          </div>
        )}

        <div className="rounded-xl border border-sh-line bg-sh-surface p-3 space-y-2">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="text-[11px] text-sh-muted">目的地</span>
            <span className="text-[11px] text-sh-fg font-mono break-all" data-testid="v3-destination">
              {status?.destination || destination || '尚未确定（先保存一个 OSS 或 WebDAV 连接）'}
            </span>
          </div>
          {!usable && (status?.unusableReason || status) && (
            <p className="text-[11px] text-sh-warn leading-relaxed" data-testid="v3-unusable">
              {status?.unusableReason || '当前还没有可用的备份目的地。'}
            </p>
          )}

          <div className="pt-1 space-y-1" data-testid="v3-password">
            <div className="flex items-center gap-2 text-[11px]" data-testid="v3-password-state">
              {panel.unlocked ? (
                <StatusPill tone="ok" label="本次会话已解锁备份密码" />
              ) : panel.passwordEstablished ? (
                <StatusPill tone="warn" label={`已建立过备份密码（${formatWhen(panel.establishedAt)}），本次会话未解锁`} />
              ) : (
                <StatusPill tone="info" label="还没有建立备份密码" />
              )}
            </div>
            {panel.unlocked ? (
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="ghost" size="sm" onClick={onLock} data-testid="v3-lock">
                  锁定备份密码
                </Button>
                <span className="text-[11px] text-sh-subtle">
                  密码只保存在本次会话内存中；刷新或锁定后自动备份会暂停，不会改用明文上传。
                </span>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <input
                  type="password"
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  placeholder="备份密码（与连接密钥、金库主密码都不同）"
                  data-testid="v3-password-input"
                  className="flex-1 min-w-[200px] rounded-lg border border-sh-line bg-sh-surface px-2.5 py-1.5 text-[12px] text-sh-fg"
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && draft.trim()) {
                      onUnlock(draft);
                      setDraft('');
                    }
                  }}
                />
                <Button
                  variant="primary"
                  size="sm"
                  disabled={!draft.trim()}
                  onClick={() => {
                    onUnlock(draft);
                    setDraft('');
                  }}
                  data-testid="v3-unlock"
                >
                  本次会话解锁
                </Button>
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Button
              variant="primary"
              size="sm"
              disabled={panel.busy || !panel.unlocked}
              onClick={onRun}
              data-testid="v3-run"
            >
              {panel.busy && panel.progress !== undefined ? `备份中… ${panel.progress}%` : '立即创建一次加密备份'}
            </Button>
            <Button variant="ghost" size="sm" onClick={onRefresh} disabled={panel.busy} data-testid="v3-refresh">
              <RefreshCw className="w-3.5 h-3.5" aria-hidden /> 刷新状态
            </Button>
            <Button variant="ghost" size="sm" onClick={onPrune} disabled={panel.busy || !panel.unlocked} data-testid="v3-prune">
              <Trash2 className="w-3.5 h-3.5" aria-hidden /> 按保留策略清理
            </Button>
          </div>

          {panel.message && (
            <p className="text-[11px] text-sh-ok leading-relaxed" data-testid="v3-message">
              {panel.message}
            </p>
          )}
          {panel.error && (
            <p className="text-[11px] text-sh-danger leading-relaxed" data-testid="v3-error">
              {panel.error}
            </p>
          )}
        </div>

        <div className="rounded-xl border border-sh-line bg-sh-surface p-3 space-y-2 text-[11px] leading-relaxed">
          <div>
            <span className="text-sh-muted">自动备份运行条件：</span>
            <span className={status?.canAutoRun ? 'text-sh-ok' : 'text-sh-warn'} data-testid="v3-auto-reason">
              {status?.canAutoRun
                ? '满足：目的地可用、任务已开启、本次会话已解锁。'
                : status?.autoReason ??
                  (activeFormat === 'v3'
                    ? '还没有读取目的地状态；点「刷新状态」查看是否满足运行条件。'
                    : '当前使用旧的 state.json 备份格式；v3 加密备份需要在这里显式启用。')}
            </span>
          </div>
          <div>
            <span className="text-sh-muted">默认恢复源：</span>
            <span className="text-sh-fg" data-testid="v3-latest">
              {status?.latestDescription ?? (status ? '还没有可恢复的批次' : '尚未读取')}
            </span>
          </div>
          <div className="text-sh-muted">
            批次：
            <span className="text-sh-fg" data-testid="v3-batch-count">
              {status ? status.batches.length : '未读取'}
            </span>
            个（未完成{' '}
            <span data-testid="v3-incomplete" className={status?.incomplete ? 'text-sh-warn' : 'text-sh-fg'}>
              {status ? status.incomplete : '—'}
            </span>
            ）；保留最近 10 次与最近 30 天每日一份。
          </div>
          {status && status.batches.length > 0 && (
            <ul className="space-y-1" data-testid="v3-batches">
              {status.batches.slice(0, 5).map((batch) => (
                <li
                  key={batch.generationId}
                  className="flex flex-wrap items-baseline gap-2"
                  data-v3-batch={batch.generationId}
                >
                  <span className="font-mono text-sh-muted">{batch.generationId}</span>
                  <span className={batch.complete ? 'text-sh-ok' : 'text-sh-warn'}>
                    {batch.complete ? '已完成' : '未完成（不能作为恢复源）'}
                  </span>
                  <span className="text-sh-subtle">{formatWhen(batch.createdAt)}</span>
                  {batch.complete && (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={!panel.unlocked || Boolean(panel.previewBusy)}
                      onClick={() => onPreviewBatch(batch.generationId)}
                      data-testid="v3-preview-batch"
                      data-batch={batch.generationId}
                      title={panel.unlocked ? '先预览差异，确认后才应用' : '先解锁备份密码'}
                    >
                      预览恢复
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {latest && (
            <div className="pt-1 border-t border-sh-line space-y-1" data-testid="v3-scope">
              <div className="text-sh-fg" data-testid="v3-scope-summary">
                最近一个完整批次：{latest.description || `${latest.objectCount} 个对象`}
              </div>
              {(latest.exclusions ?? []).slice(0, 3).map((line) => (
                <div key={line} className="text-sh-subtle" data-testid="v3-exclusion">
                  · {line}
                </div>
              ))}
            </div>
          )}
          {!panel.unlocked && (
            <div className="flex items-start gap-2 text-sh-subtle" data-testid="v3-locked-note">
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0 text-sh-warn" aria-hidden />
              <span>
                未解锁时这里只能看到批次是否存在；解锁后才会读取清单，显示计数与范围。解锁只影响本次会话，不会把密码写入本机。
              </span>
            </div>
          )}
        </div>

        {/* P2-06 restore: preview first, decide conflicts, then apply. */}        {panel.previewBusy && !panel.preview && (
          <p className="text-[11px] text-sh-subtle" data-testid="v3-preview-busy">
            正在读取并校验批次…
          </p>
        )}
        {panel.previewError && (
          <p className="text-[11px] text-sh-danger leading-relaxed" data-testid="v3-preview-error">
            {panel.previewError}
          </p>
        )}
        {panel.applied && (
          <div className="rounded-xl border border-sh-ok/40 bg-sh-ok/5 p-3 space-y-1 text-[11px]" data-testid="v3-restore-applied">
            <div className="text-sh-ok">
              恢复完成：应用 {Object.values(panel.applied.applied).reduce((sum, n) => sum + n, 0)} 条 · 冲突处理{' '}
              {panel.applied.conflictsResolved} 条 · 保留本机 {panel.applied.keptLocal} 条 · 副本 {panel.applied.copies} 个
              {panel.applied.remapped > 0 ? ` · 重新编号 ${panel.applied.remapped} 条` : ''}
            </div>
            {panel.applied.credentialsImported.length > 0 && (
              <div className="text-sh-warn" data-testid="v3-credentials-imported">
                已导入连接凭据：{panel.applied.credentialsImported.join('、')}
                {panel.applied.connectionsToRetest.length > 0 && (
                  <>
                    ；这些连接在本机还没测试过，请重新测试（
                    {panel.applied.connectionsToRetest.join('、')}）
                  </>
                )}
              </div>
            )}
            {panel.applied.connectionsToRetest.length > 0 && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => onRetestConnections(panel.applied!.connectionsToRetest)}
                data-testid="v3-retest-connections"
              >
                重新测试这些连接
              </Button>
            )}
            {panel.applied.credentialsSkipped.length > 0 && (
              <ul className="text-sh-subtle space-y-0.5" data-testid="v3-credentials-skipped">
                {panel.applied.credentialsSkipped.map((entry) => (
                  <li key={entry.label}>
                    · {entry.label}：{entry.reason}
                  </li>
                ))}
              </ul>
            )}
            <ul className="text-sh-subtle space-y-0.5">
              {panel.applied.pending.map((line) => (
                <li key={line}>· {line}</li>
              ))}
            </ul>
            <div className="text-sh-subtle">
              如需撤回：本次恢复前已经保存了回滚快照，可在「高级与维护」里恢复它。
            </div>
          </div>
        )}

        {/* §9.1: the web app and the packaged extension are different origins and
            cannot share a database, so data moves as a file — explicitly. */}
        <div className="rounded-xl border border-sh-line bg-sh-surface p-3 space-y-2 text-[11px]" data-testid="v3-bundle-section">
          <div className="text-sh-fg font-medium">跨环境交换（单个加密文件）</div>
          <p className="text-sh-subtle leading-relaxed">
            网页版与扩展版是<strong className="text-sh-fg">两个独立的库</strong>，不会自动共享数据。要搬数据时，在一个环境里导出加密文件，
            再到另一个环境里导入；导入走的是和恢复完全相同的流程（先预览差异、再决定冲突）。
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              disabled={!panel.unlocked || panel.busy}
              onClick={() => onExportBundle(false)}
              data-testid="v3-export-bundle"
            >
              导出加密文件（不含凭据）
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={!panel.unlocked || panel.busy}
              onClick={() => setConfirmingBundleCredentials(true)}
              data-testid="v3-export-bundle-credentials"
            >
              导出含凭据的迁移文件
            </Button>
          </div>
          {confirmingBundleCredentials && (
            <div className="rounded-lg border border-sh-warn/50 bg-sh-warn/10 p-2 space-y-2" data-testid="v3-bundle-credentials-confirm">
              <div className="text-sh-warn leading-relaxed">
                这个文件会包含连接密钥（{credentialScope.length} 项）。请只把它交给你自己的另一台设备，用完后删除。
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => {
                    setConfirmingBundleCredentials(false);
                    onExportBundle(true);
                  }}
                  data-testid="v3-bundle-credentials-confirm-yes"
                >
                  确认导出
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setConfirmingBundleCredentials(false)}>
                  取消
                </Button>
              </div>
            </div>
          )}

          <label className="block space-y-1">
            <span className="text-sh-muted">选择要导入的加密文件</span>
            <input
              type="file"
              accept=".json,application/json"
              data-testid="v3-import-bundle-input"
              disabled={!panel.unlocked || Boolean(panel.previewBusy)}
              onChange={async (event) => {
                const file = event.target.files?.[0];
                if (!file) return;
                const text = await file.text();
                onImportBundle(text);
                event.target.value = '';
              }}
              className="block w-full text-[11px] text-sh-muted file:mr-2 file:rounded file:border file:border-sh-line file:bg-sh-surface2 file:px-2 file:py-1 file:text-[11px] file:text-sh-fg"
            />
          </label>
          {!panel.unlocked && (
            <div className="text-sh-warn">先解锁备份密码，才能导出或导入加密文件（文件用同一个备份密码加密）。</div>
          )}
        </div>

        {/* P2-06 migration packages: the only artefact allowed to carry credentials. */}
        <div className="rounded-xl border border-sh-line bg-sh-surface p-3 space-y-2 text-[11px]" data-testid="v3-migration-section">
          <div className="text-sh-fg font-medium">换设备用的迁移包</div>
          <p className="text-sh-subtle leading-relaxed">
            日常备份与 v3 批次都会移除连接密钥。要换设备时，可以另外创建一个<strong className="text-sh-fg">独立的加密迁移包</strong>
            ：它写在单独的目录里，不会被当成备份、也不参与备份的清理。请只在迁移时使用，并把它当成敏感文件保管。
          </p>
          <div className="text-sh-subtle">
            包内将包含：
            {credentialScope.length > 0 ? (
              <ul className="space-y-0.5" data-testid="v3-credential-scope">
                {credentialScope.map((line) => (
                  <li key={line}>· {line}</li>
                ))}
              </ul>
            ) : (
              <span data-testid="v3-credential-scope"> 本机目前没有可导出的连接凭据（只填了非机密字段）。</span>
            )}
          </div>

          {confirmingExport ? (
            <div className="rounded-lg border border-sh-warn/50 bg-sh-warn/10 p-2 space-y-2" data-testid="v3-migration-confirm">
              <div className="text-sh-warn leading-relaxed">
                确认创建？这会加密上传包含连接密钥的迁移包。请确认：
                ① 只用于你自己的另一台设备；② 上传目的地是你信任的存储；③ 导出后按敏感文件对待。
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="primary"
                  size="sm"
                  disabled={!panel.unlocked || panel.busy || credentialScope.length === 0}
                  onClick={() => {
                    setConfirmingExport(false);
                    onExportMigration();
                  }}
                  data-testid="v3-migration-export-confirm"
                >
                  确认创建迁移包
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setConfirmingExport(false)} data-testid="v3-migration-export-cancel">
                  取消
                </Button>
              </div>
            </div>
          ) : (
            <Button
              variant="secondary"
              size="sm"
              disabled={!panel.unlocked || panel.busy || credentialScope.length === 0}
              onClick={() => setConfirmingExport(true)}
              data-testid="v3-migration-export"
              title={panel.unlocked ? undefined : '先解锁备份密码'}
            >
              创建含凭据的加密迁移包
            </Button>
          )}

          {panel.migrationPackages && panel.migrationPackages.length > 0 ? (
            <ul className="space-y-1" data-testid="v3-migration-list">
              {panel.migrationPackages.slice(0, 5).map((pkg) => (
                <li key={pkg.generationId} className="flex flex-wrap items-baseline gap-2" data-migration-package={pkg.generationId}>
                  <span className="font-mono text-sh-muted">{pkg.generationId}</span>
                  <span className={pkg.complete ? 'text-sh-ok' : 'text-sh-warn'}>
                    {pkg.complete ? '已完成' : '未完成'}
                  </span>
                  {pkg.includesCredentials && <span className="text-sh-warn">含连接凭据</span>}
                  <span className="text-sh-subtle">{formatWhen(pkg.createdAt)}</span>
                  {pkg.complete && (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={!panel.unlocked || Boolean(panel.previewBusy)}
                      onClick={() => onPreviewMigration(pkg.generationId)}
                      data-testid="v3-preview-migration"
                      data-package={pkg.generationId}
                    >
                      预览导入
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={panel.busy}
                    onClick={() => {
                      if (window.confirm('删除这个迁移包？它包含连接凭据，删除后无法从云端找回。')) {
                        onRemoveMigration(pkg.generationId);
                      }
                    }}
                    data-testid="v3-remove-migration"
                    data-package={pkg.generationId}
                  >
                    删除
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <div className="text-sh-subtle" data-testid="v3-migration-empty">
              还没有迁移包。{panel.unlocked ? '' : '（解锁备份密码后才会列出来）'}
            </div>
          )}
        </div>

        {panel.preview && (
          <div className="rounded-xl border border-sh-line-strong bg-sh-surface p-3 space-y-2 text-[11px]" data-testid="v3-restore-preview">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="text-sh-fg font-medium">
                恢复预览：<span className="font-mono">{panel.preview.generationId}</span>
              </span>
              <span className="text-sh-subtle">
                {formatWhen(panel.preview.createdAt)} · {panel.preview.sameLibrary ? '同一个库' : `来自另一个库（${panel.preview.packageLibraryId}）`}
              </span>
            </div>

            <div className="space-y-0.5" data-testid="v3-preview-counts">
              {Object.entries(panel.preview.packageCounts)
                .filter(([, count]) => count > 0)
                .map(([collection, count]) => (
                  <div key={collection} className="flex flex-wrap gap-2 text-sh-muted" data-preview-collection={collection}>
                    <span className="text-sh-fg">{COLLECTION_LABELS[collection] ?? collection}</span>
                    <span>备份 {count}</span>
                    <span>本机 {panel.preview!.localCounts[collection] ?? 0}</span>
                    <span className={panel.preview!.added[collection] ? 'text-sh-ok' : ''}>
                      新增 {panel.preview!.added[collection] ?? 0}
                    </span>
                    <span className={panel.preview!.conflictCounts[collection] ? 'text-sh-warn' : ''}>
                      冲突 {panel.preview!.conflictCounts[collection] ?? 0}
                    </span>
                  </div>
                ))}
              <div className="text-sh-subtle">
                完全相同的条目 {panel.preview.identicalCount} 条；远端引用 {panel.preview.referenceOnly.length} 个。
              </div>
            </div>

            {panel.preview.missingAttachments.length > 0 && (
              <div className="text-sh-warn" data-testid="v3-preview-missing">
                缺失附件 {panel.preview.missingAttachments.length} 个：
                {panel.preview.missingAttachments.slice(0, 3).map((item) => item.name).join('、')}
              </div>
            )}
            {panel.preview.unsupportedFields.length > 0 && (
              <div className="text-sh-subtle" data-testid="v3-preview-unsupported">
                当前版本不认识的字段 {panel.preview.unsupportedFields.length} 个（会原样保留）：
                {panel.preview.unsupportedFields.slice(0, 3).join('、')}
              </div>
            )}
            {panel.preview.warnings.map((line) => (
              <div key={line} className="text-sh-warn leading-relaxed" data-testid="v3-preview-warning">
                · {line}
              </div>
            ))}
            <div className="text-sh-subtle leading-relaxed" data-testid="v3-preview-credentials">
              {panel.preview.credentialNote}
              <br />
              {panel.preview.vaultNote}
            </div>

            {panel.preview.includesCredentials && (
              <div className="rounded-lg border border-sh-warn/50 bg-sh-warn/10 p-2 space-y-1" data-testid="v3-credential-optin">
                <label className="flex items-start gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={panel.importCredentials}
                    onChange={(event) => onImportCredentialsChange(event.target.checked)}
                    data-testid="v3-import-credentials"
                    className="mt-0.5"
                  />
                  <span className="text-sh-warn leading-relaxed">
                    导入这个包里的连接凭据（只补上本机还没有的连接；已配置不同账号的服务会被跳过，不会被覆盖）
                  </span>
                </label>
                <div className="space-y-0.5 text-sh-subtle">
                  {panel.preview.credentialPlans.map((plan) => (
                    <div key={plan.service} data-credential-plan={plan.service} data-action={plan.action}>
                      · {plan.label}：
                      {plan.action === 'adopt'
                        ? '可导入'
                        : plan.action === 'keep-local'
                        ? '保留本机'
                        : '跳过'}
                      （{plan.reason}）
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="pt-1 space-y-1">
              <div className="text-sh-muted">恢复方式</div>
              <div className="flex flex-wrap gap-1.5">
                {(
                  [
                    { id: 'merge', label: '合并（保留本机独有的条目）' },
                    { id: 'replace', label: '替换（用备份覆盖这些集合）' }
                  ] as const
                ).map((option) => (
                  <button
                    key={option.id}
                    onClick={() => onRestoreMode(option.id)}
                    data-testid="v3-restore-mode"
                    data-mode={option.id}
                    data-active={panel.restoreMode === option.id ? 'true' : 'false'}
                    className={`px-2.5 py-1 rounded-lg border text-[11px] transition-colors ${
                      panel.restoreMode === option.id
                        ? 'border-sh-line-strong bg-sh-surface2 text-sh-fg font-semibold'
                        : 'border-sh-line text-sh-muted hover:text-sh-fg'
                    }`}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>

            {panel.restoreMode === 'merge' && Object.keys(panel.preview.conflictCounts).length > 0 && (
              <div className="pt-1 space-y-1" data-testid="v3-conflict-choices">
                <div className="text-sh-muted">冲突怎么处理（逐集合）</div>
                {Object.entries(panel.preview.conflictCounts).map(([collection, count]) => (
                  <div key={collection} className="flex flex-wrap items-center gap-1.5" data-conflict-collection={collection}>
                    <span className="text-sh-fg">
                      {COLLECTION_LABELS[collection] ?? collection}（{count}）
                    </span>
                    {(
                      [
                        { id: 'keep-local', label: '保留本机' },
                        { id: 'use-backup', label: '使用备份' },
                        { id: 'keep-both', label: '另存副本' }
                      ] as const
                    ).map((option) => (
                      <button
                        key={option.id}
                        onClick={() => onConflictChoice(collection, option.id)}
                        data-testid="v3-conflict-choice"
                        data-collection={collection}
                        data-strategy={option.id}
                        data-active={panel.conflictChoices[collection] === option.id ? 'true' : 'false'}
                        className={`px-2 py-0.5 rounded border text-[11px] transition-colors ${
                          panel.conflictChoices[collection] === option.id
                            ? 'border-sh-line-strong bg-sh-surface2 text-sh-fg font-semibold'
                            : 'border-sh-line text-sh-muted hover:text-sh-fg'
                        }`}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            )}
            {panel.restoreMode === 'replace' && (
              <div className="text-sh-warn" data-testid="v3-replace-note">
                替换模式会用备份里的内容覆盖这些集合，本机独有的条目不会保留；连接密钥仍保留本机的。
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2 pt-1">
              <Button variant="primary" size="sm" busy={panel.previewBusy} onClick={onApplyRestore} data-testid="v3-apply-restore">
                应用恢复
              </Button>
              <Button variant="ghost" size="sm" onClick={onDiscardPreview} data-testid="v3-discard-preview">
                放弃预览
              </Button>
            </div>
          </div>
        )}
      </div>
    </Section>
  );
};

export default V3BackupSection;
