import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  X,
  Settings,
  HardDrive,
  Download,
  Upload,
  Shield,
  Globe,
  AlertTriangle,
  Lock,
  Key,
  Database,
  RefreshCw,
  RotateCcw,
  SlidersHorizontal,
  Plug,
  Wrench
} from 'lucide-react';
import { ObsidianConfig, AiConfig, HubState, WebdavSyncConfig, WucaiConfig, ConnectionTestRecord } from '../../types';
import { exportBackup, importBackup, INITIAL_STATE, saveHubState, snapshotForRollback, restoreRollbackSnapshot, hasRollbackSnapshot, listSalvagedPayloads, SALVAGE_PREFIX, getStorageHealth, describeStorageHealth } from '../../lib/storage';
import { exportEncryptedBackup, importEncryptedBackup } from '../../lib/crypto';
import { deleteAllDatabases, estimateStorageQuota } from '../../lib/indexedDb';
import { describeV3Counts } from '../../lib/storageMode';
import {
  backupKeyFor,
  describeBackupAge,
  mergeRestoredState,
  readStateBackup,
  readStateBackupFromWebdav
} from '../../lib/stateBackup';
import {
  isExtensionContext,
  openExtensionOptions,
  readExtensionSyncState,
  setExtensionSyncEnabled,
  type ExtensionSyncState
} from '../../lib/extensionBridge';
import { INTEGRATIONS, IntegrationId, IntegrationDef, ossConnectionDefs } from '../../lib/integrations';
import { FEATURE_DEFS, FeatureId, isFeatureEnabled } from '../../lib/features';
import { IntegrationCard } from '../settings/IntegrationCard';
import { V3BackupSection } from '../settings/V3BackupSection';
import { Button, ConfirmDialog, Section, StatusPill, VaultStateBadge, inputClass } from '../../shared/ui';
import { showToast as showToastGlobal } from '../../shared/ui/toast';
import { useConfirmDialog } from '../../shared/ui';
import { Hint } from '../../shared/Hint';
import { capabilityLabel, connectionStatus, fingerprintOf, runConnectionTest } from '../../lib/connectionState';
import { resolveBackupTarget, type BackupPolicy, type BackupTarget } from '../../lib/backupPolicy';
import { getSessionBackupPassword, hasSessionBackupPassword } from '../../infrastructure/backup/backupSession';
import { withFreshNewtabPreferences } from '../../lib/newtabPreferences';
import type { V3BackupPanelState } from '../../hooks/useV3Backup';

/* -------------------------------------------------------------------------- */
/* Information architecture (P1-08)                                           */
/* -------------------------------------------------------------------------- */

/**
 * The redesigned settings panes. Labels on screen are the plain-language ones
 * from the design (概览 / 使用偏好 / 连接与任务 / 数据与备份 / 浏览器与设备 /
 * 隐私与安全 / 高级与维护), so a user looking for "where do I back up?" does not
 * have to know that it used to be called 存储与备份.
 */
export const SETTINGS_PANES = [
  'overview',
  'preferences',
  'connections',
  'storage',
  'browser',
  'privacy',
  'maintenance'
] as const;
export type SettingsPane = (typeof SETTINGS_PANES)[number];

/**
 * Old section ids stay addressable: `#/settings/data`, `#/settings/ai` and the
 * rest are in bookmarks, notifications and existing tests. They resolve to the
 * pane that now holds their content instead of 404-ing.
 */
export const SETTINGS_SECTION_ALIASES = {
  features: 'preferences',
  sync: 'browser',
  content: 'connections',
  ai: 'connections',
  data: 'storage'
} as const;

export type SettingsSection = SettingsPane | keyof typeof SETTINGS_SECTION_ALIASES;

export function settingsPaneFor(section: string | undefined | null): SettingsPane {
  if (!section) return 'overview';
  if ((SETTINGS_PANES as readonly string[]).includes(section)) return section as SettingsPane;
  const alias = (SETTINGS_SECTION_ALIASES as Record<string, SettingsPane>)[section];
  return alias ?? 'overview';
}

const NAV_ITEMS: { id: SettingsPane; label: string; icon: typeof Shield }[] = [
  { id: 'overview', label: '概览', icon: Shield },
  { id: 'preferences', label: '使用偏好', icon: SlidersHorizontal },
  { id: 'connections', label: '连接与任务', icon: Plug },
  { id: 'storage', label: '数据与备份', icon: HardDrive },
  { id: 'browser', label: '浏览器与设备', icon: Globe },
  { id: 'privacy', label: '隐私与安全', icon: Lock },
  { id: 'maintenance', label: '高级与维护', icon: Wrench }
];

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  obsidianConfig: ObsidianConfig;
  aiConfig: AiConfig;
  state: HubState;
  /**
   * Apply a restored state.
   *
   * May be asynchronous (in v3 mode the data has to be written into the active library, not
   * the payload) and may report failure with `false`, so the caller does not show "✅ 恢复成功"
   * for a restore that did not land.
   */
  onRestoreState: (state: HubState) => void | boolean | Promise<void | boolean>;
  masterPassword?: string | null;
  /** 是否创建过主密码（与「本次会话是否解锁」是两个事实，混用会显示成「未设置」）。 */
  hasMasterAuth?: boolean;
  /** Auto-backup status shown next to the OSS settings. */
  backupStatus?: {
    status: 'idle' | 'saving' | 'error' | 'conflict' | 'disabled';
    lastAt?: number;
    lastTrigger?: 'manual' | 'auto';
    message?: string;
    hint?: string;
  };
  /** Force a backup now (skips the debounce). */
  onBackupNow?: (force?: boolean) => Promise<{ ok: boolean; conflict?: boolean; error?: string }>;
  webdavConfig?: WebdavSyncConfig;
  /** Content sources (五彩 etc.) used to live inside the data page. */
  onUpdateWucai?: (config: WucaiConfig) => void;
  /** Open directly on a given section (used by the onboarding wizard). */
  initialSection?: 'overview' | 'storage' | null;
  /** Registry-driven save for every integration card. */
  onSaveIntegration: (id: IntegrationId, values: Record<string, string>) => void;
  /** Module switches (see lib/features). */
  onToggleFeature?: (id: FeatureId, enabled: boolean) => void;
  /**
   * `page` renders the same panel as a routed page instead of an overlay.
   * The redesign moves settings out of a modal so it can be linked to and
   * returned from; the content is shared so the two cannot drift.
   */
  variant?: 'modal' | 'page';
  /** Controlled section, so `#/settings/<section>` is the source of truth. */
  section?: SettingsSection;
  onSectionChange?: (section: SettingsSection) => void;
  /** Leave the settings page (page variant). */
  onLeave?: () => void;
  /**
   * Persist the result of a connection test. The test itself never saves the
   * draft — this only records "this exact config version was probed at time T".
   */
  onRecordConnectionTest?: (id: IntegrationId, record: ConnectionTestRecord) => void;
  /**
   * Resolved backup destination, so the backup pane shows the target that will
   * actually be written to instead of re-deriving it from field presence.
   */
  /**
   * Resolved backup destination from the shared resolver.
   *
   * Typed as the resolver's own `BackupTarget` rather than a hand-copied subset: the subset
   * had already drifted (it was missing `formatWarning`), and a subset type silently hides a
   * field the UI needs.
   */
  backupTarget?: BackupTarget;
  /** Change the whole-state backup destination / task switch. */
  onUpdateBackupPolicy?: (policy: {
    provider: 'auto' | 'oss' | 'webdav';
    enabled: boolean;
    format?: 'legacy' | 'v3';
    destinations?: Array<'oss' | 'webdav'>;
  }) => void;
  /** All configured OSS/S3 buckets, so the settings card edits the one the user picks. */
  obsidianConnections?: ObsidianConfig[];
  onSelectObsidianConnection?: (id: string) => void;
  onAddObsidianConnection?: () => void;
  /** Delete a bucket card (never the last one). */
  onRemoveObsidianConnection?: (id: string) => void;
  /**
   * Which store is the fact source (P2 切库).
   *
   * Device-level, not part of the library; the pane shows it next to the backup controls
   * because "where is my data" and "what is my backup" are the same question to a user.
   */
  storageMode?: {
    mode: 'local' | 'v3';
    counts?: Record<string, number>;
    error?: string;
    /** Result of the migration that switched this device over, if it ran here. */
    migration?: {
      stagingLibraryId: string;
      counts: number;
      warnings: string[];
      unknownFields: number;
      snapshotHash?: string;
    };
  };
  onSwitchStorageMode?: (mode: 'local' | 'v3', password?: string) => Promise<{ ok: boolean; error?: string }>;
  /**
   * v3 encrypted backup panel (P2-05).
   *
   * Passed as one object so the settings surface does not grow six more props, and
   * so the pane cannot accidentally reach into the backup internals itself.
   */
  v3Backup?: {
    panel: V3BackupPanelState;
    onUnlock: (password: string) => void;
    onLock: () => void;
    onRefresh: () => void;
    onRun: () => void;
    onPrune: () => void;
    onFormatChange: (format: 'legacy' | 'v3') => void;
    /** P2-06 restore flow. */
    onPreviewBatch: (generationId: string) => void;
    onConflictChoice: (collection: string, strategy: 'keep-local' | 'use-backup' | 'keep-both') => void;
    onRestoreMode: (mode: 'merge' | 'replace') => void;
    onApplyRestore: () => void;
    onDiscardPreview: () => void;
    /** P2-06 migration packages. */
    onExportMigration: () => void;
    onPreviewMigration: (generationId: string) => void;
    onImportCredentialsChange: (value: boolean) => void;
    onRemoveMigration: (generationId: string) => void;
    /** §9.1 single-file exchange. */
    onExportBundle: (includeCredentials: boolean) => void;
    onImportBundle: (json: string) => void;
    onRetestConnections: (services: string[]) => void;
  };
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  isOpen,
  onClose,
  obsidianConfig,
  state,
  onRestoreState,
  masterPassword,
  hasMasterAuth,
  backupStatus,
  onBackupNow,
  webdavConfig,
  onSaveIntegration,
  onToggleFeature,
  initialSection,
  variant = 'modal',
  section: controlledSection,
  onSectionChange,
  onLeave,
  onRecordConnectionTest,
  backupTarget,
  onUpdateBackupPolicy,
  obsidianConnections,
  onSelectObsidianConnection,
  onAddObsidianConnection,
  onRemoveObsidianConnection,
  v3Backup,
  storageMode,
  onSwitchStorageMode
}) => {
  const [internalTab, setInternalTab] = useState<SettingsSection>('overview');
  /** Password for the encrypted pre-migration snapshot; never stored. */
  const [storageMigrationPassword, setStorageMigrationPassword] = useState('');
  const [storageMigrationError, setStorageMigrationError] = useState<string | null>(null);
  /** True while a switch is in flight: the button must not look idle for seconds. */
  const [storageSwitching, setStorageSwitching] = useState(false);
  /** 存储迁移折叠态：最危险的操作默认收起，当前模式一行常显。 */
  const [storageAdvancedOpen, setStorageAdvancedOpen] = useState(false);
  // Page variant: the URL owns which section is open, so a link (or the back
  // button) lands on the right pane instead of always resetting to 概览.
  const activeSection = controlledSection ?? internalTab;
  const activePane = settingsPaneFor(activeSection);
  const isPage = variant === 'page';
  const open = isPage ? true : isOpen;
  const [extSync, setExtSync] = useState<ExtensionSyncState>({
    available: false,
    provider: 'none',
    autoSync: false
  });

  /**
   * Unsaved connection drafts, lifted from the cards (P1-08).
   *
   * The cards own their draft state; the shell only needs to know *which*
   * connections are dirty and *what* they currently hold, so it can protect the
   * user's edit when they switch panes or leave.
   */
  const [dirtyIds, setDirtyIds] = useState<IntegrationId[]>([]);
  const draftsRef = useRef<Partial<Record<IntegrationId, Record<string, string>>>>({});
  const [discardToken, setDiscardToken] = useState(0);
  const [guard, setGuard] = useState<{ next: SettingsPane | null } | null>(null);

  const [testingId, setTestingId] = useState<IntegrationId | null>(null);
  const [testOutcomes, setTestOutcomes] = useState<
    Partial<Record<IntegrationId, { status: 'ok' | 'failed' | 'unavailable'; message: string }>>
  >({});

  useEffect(() => {
    if (!open) return;
    void readExtensionSyncState().then(setExtSync);
  }, [open]);

  // Storage Quota & Encrypted Backup states
  const [quota, setQuota] = useState<{ usageMb: number; quotaMb: number; percentage: number; persisted: boolean } | null>(null);
  const [isExportingEncrypted, setIsExportingEncrypted] = useState(false);
  const [exportPassword, setExportPassword] = useState('');
  const [showExportPasswordInput, setShowExportPasswordInput] = useState(false);
  const [canRollback, setCanRollback] = useState(false);
  const { confirm, dialog: confirmDialog } = useConfirmDialog();
  /** 加密备份导入时无会话主密码：先存文件内容，等遮蔽的密码框而不是明文 prompt()。 */
  const [pendingEncryptedRestore, setPendingEncryptedRestore] = useState<string | null>(null);
  const [restorePassword, setRestorePassword] = useState('');
/**
 * Damaged payloads kept aside by `loadHubState`.
 * P0-02 found that a corrupt `self_hub_data_v2` was copied to a
 */
  const [salvage, setSalvage] = useState<Array<{ key: string; at: number; bytes: number }>>([]);
  const [salvageToDelete, setSalvageToDelete] = useState<string | null>(null);

  useEffect(() => {
    if (!open || isPage) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, isPage, onClose]);

  useEffect(() => {
    if (!open) return;
    setCanRollback(hasRollbackSnapshot());
    if (initialSection) setInternalTab(initialSection);
    // Salvaged payloads are read from storage, not from app state: they exist
    // precisely because the payload could not be parsed into app state.
    setSalvage(listSalvagedPayloads());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const exportSalvaged = (key: string) => {
    try {
      const raw = localStorage.getItem(key);
      if (raw === null) return;
      const blob = new Blob([raw], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `self-hub-salvaged-${key.startsWith(SALVAGE_PREFIX) ? key.slice(SALVAGE_PREFIX.length) : Date.now()}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      showToastGlobal(`导出失败：${err instanceof Error ? err.message : '未知错误'}`, 'danger');
    }
  };

  const deleteSalvaged = (key: string) => {
    try {
      localStorage.removeItem(key);
    } catch {
      /* storage unavailable */
    }
    setSalvage(listSalvagedPayloads());
    setSalvageToDelete(null);
  };

  // Load storage quota
  useEffect(() => {
    if (open) {
      estimateStorageQuota().then((q) => setQuota(q));
    }
  }, [open]);

  /**
   * Tab close / reload. A same-document hash change (sidebar navigation) cannot
   * be vetoed from here — the route owner is App.tsx — so the in-app guards are
   * the pane switch and the 返回工作台 button; this covers closing the tab.
   */
  useEffect(() => {
    if (!dirtyIds.length) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '有未保存的连接修改，离开会丢失。';
      return e.returnValue;
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirtyIds.length]);

  const handleDirtyChange = useCallback((id: IntegrationId, dirty: boolean) => {
    setDirtyIds((prev) => {
      if (dirty) return prev.includes(id) ? prev : [...prev, id];
      const next = prev.filter((x) => x !== id);
      return next.length === prev.length ? prev : next;
    });
  }, []);

  const handleDraftChange = useCallback((id: IntegrationId, values: Record<string, string>) => {
    draftsRef.current = { ...draftsRef.current, [id]: values };
  }, []);

  if (!open) return null;

  const leaveNow = () => {
    (onLeave ?? onClose)();
  };

  const applyPane = (next: SettingsPane) => {
    setInternalTab(next);
    onSectionChange?.(next);
  };

  /** Intercept every in-panel navigation while a draft is unsaved. */
  const requestPane = (next: SettingsPane) => {
    if (next === activePane) return;
    if (dirtyIds.length) {
      setGuard({ next });
      return;
    }
    applyPane(next);
  };

  const requestLeave = () => {
    if (dirtyIds.length) {
      setGuard({ next: null });
      return;
    }
    leaveNow();
  };

  const proceedAfterGuard = (action: { next: SettingsPane | null }) => {
    if (action.next) applyPane(action.next);
    else leaveNow();
  };

  const handleDiscardAndProceed = () => {
    if (!guard) return;
    const action = guard;
    setDiscardToken((n) => n + 1);
    setGuard(null);
    proceedAfterGuard(action);
  };

  const handleSaveAndProceed = () => {
    if (!guard) return;
    const action = guard;
    setGuard(null);
    for (const id of dirtyIds) {
      const values = draftsRef.current[id];
      if (values) onSaveIntegration(id, values);
    }
    // One frame for the parent state (and its persistence effect) to settle
    // before the pane changes underneath the cards.
    setTimeout(() => proceedAfterGuard(action), 0);
  };

  const runTest = async (def: IntegrationDef, draft: Record<string, string>) => {
    setTestingId(def.id);
    try {
      const result = await runConnectionTest(def, draft);
      setTestOutcomes((prev) => ({ ...prev, [def.id]: result }));
      if (result.status !== 'unavailable') {
        // Only a probe that actually ran produces a record. A "cannot test here"
        // answer must not masquerade as a failed credential.
        onRecordConnectionTest?.(def.id, {
          at: Date.now(),
          ok: result.status === 'ok',
          message: result.message,
          fingerprint: fingerprintOf(def, draft),
          capabilities: result.capabilities,
          environment: isExtensionContext() ? 'extension' : 'web'
        });
      }
    } finally {
      setTestingId(null);
    }
  };

  const handleExportEncryptedClick = async () => {
    const pwd = exportPassword || masterPassword;
    if (!pwd) {
      setShowExportPasswordInput(true);
      return;
    }

    try {
      setIsExportingEncrypted(true);
      // The new tab owns the dashboard layout; read it now so the file carries the
      // arrangement the user is looking at, not the one from the last state sync.
      const encryptedJson = await exportEncryptedBackup(await withFreshNewtabPreferences(state), pwd);
      const blob = new Blob([encryptedJson], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `self-hub-encrypted-backup-${new Date().toISOString().slice(0, 10)}.enc.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setShowExportPasswordInput(false);
      setExportPassword('');
    } catch (err: any) {
      showToastGlobal(`加密导出失败：${err.message || '未知错误'}`, 'danger');
    } finally {
      setIsExportingEncrypted(false);
    }
  };

  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (event) => {
      const content = event.target?.result as string;
      try {
        const parsed = JSON.parse(content);
        if (parsed.encryptedData && parsed.app === 'self-hub') {
          // Encrypted backup. 密码输入必须是遮蔽的模态输入框——原生 prompt()
          // 不遮蔽，主密码会明文留在屏幕上。
          const pwd = masterPassword;
          if (!pwd) {
            setPendingEncryptedRestore(content);
            return;
          }
          await runEncryptedRestore(content, pwd);
        } else {
          // Standard plaintext backup
          const imported = importBackup(content);
          if (imported) {
            const applied = await Promise.resolve(onRestoreState(imported));
            if (applied === false) {
              showToastGlobal('数据没有写入本机库，请看页面顶部提示', 'danger');
              return;
            }
            setCanRollback(true);
            showToastGlobal('备份数据已恢复', 'ok');
          } else {
            showToastGlobal('备份文件格式错误或数据校验未通过，恢复中止以保护现有数据', 'danger');
          }
        }
      } catch (err: any) {
        showToastGlobal(`读取备份失败：${err.message || '不是有效的 JSON 文件'}`, 'danger');
      } finally {
        // Allow re-selecting the same file again.
        e.target.value = '';
      }
    };
    reader.readAsText(file);
  };

  /** 带主密码的加密备份恢复；成功后留在本面板（回滚入口就在手边）。 */
  const runEncryptedRestore = async (content: string, pwd: string) => {
    snapshotForRollback();
    const restored = await importEncryptedBackup(content, pwd);
    if (restored) {
      const applied = await Promise.resolve(onRestoreState(restored));
      if (applied === false) {
        showToastGlobal('数据没有写入本机库，请看页面顶部提示', 'danger');
        return;
      }
      setCanRollback(true);
      showToastGlobal(`加密备份已解密并恢复：${restored.sites?.length || 0} 个站点、${restored.notes?.length || 0} 条笔记`, 'ok');
    } else {
      showToastGlobal('解密失败：主密码错误或备份文件损坏', 'danger');
    }
  };

  const handleRollback = async () => {
    if (!(await confirm({ title: '撤销上一次备份导入？', description: '恢复到导入前的数据。', confirmLabel: '撤销并恢复', tone: 'danger' }))) return;
    const restored = restoreRollbackSnapshot();
    if (!restored) {
      showToastGlobal('没有可用的回滚快照（仅本次会话内有效）', 'warn');
      setCanRollback(false);
      return;
    }
    const applied = await Promise.resolve(onRestoreState(restored));
    if (applied === false) {
      showToastGlobal('回滚没有写入本机库，请看页面顶部提示', 'danger');
      return;
    }
    setCanRollback(false);
    showToastGlobal('已回滚到导入前的数据', 'ok');
  };

  const handleResetData = () => {
    void confirm({
      title: '彻底清空所有本地数据？',
      description: '将清除全部本地缓存、旧测试数据与历史记录，恢复纯净出厂状态；云端已备份的快照不受影响。此操作无法撤销。',
      confirmLabel: '清空全部数据',
      tone: 'danger'
    }).then((ok) => {
      if (!ok) return;
      void (async () => {
        try {
          const removed = await deleteAllDatabases();
          console.info('[Self-Hub] removed IndexedDB databases:', removed);
        } catch (err) {
          console.warn('IndexedDB cleanup failed', err);
        }
        try {
          localStorage.clear();
          sessionStorage.clear();
        } catch {}
        saveHubState(INITIAL_STATE);
        onRestoreState(INITIAL_STATE);
        showToastGlobal('本地数据与缓存已彻底清空，已恢复出厂状态', 'ok');
        onClose();
        window.location.reload();
      })();
    });
  };

  /* ---------------------------------------------------------------------- */
  /* Derived status (one resolver for "where does the backup go")           */
  /* ---------------------------------------------------------------------- */
  const resolvedTarget = backupTarget ?? resolveBackupTarget(state);
  /** Size of the stored payload, for the diagnostics row and the capacity warning. */
  const storageHealth = React.useMemo(() => getStorageHealth(), [state]);
/**
 * True only when the application's own snapshot task would actually run.
 * The extension-overlap warning says "站点/批注会被写两次". Using `configured`
 */
  const backupTargetActive = resolvedTarget.canRun;
  const backupPolicy: BackupPolicy =
    state.backupPolicy ?? { provider: 'auto', enabled: resolvedTarget.enabled, format: 'legacy' };
  /**
   * The format the automatic task writes. `resolvedTarget` wins when the caller
   * passed one (it comes from the same resolver the backup hook uses); otherwise
   * fall back to the persisted policy so the panel never shows a stale format.
   */
  const activeBackupFormat: 'legacy' | 'v3' =
    resolvedTarget.format ?? state.backupPolicy?.format ?? 'legacy';
  const providerName = resolvedTarget.provider === 'oss' ? '阿里云 OSS' : resolvedTarget.provider === 'webdav' ? 'WebDAV' : '未确定';
  const dirtyTitles = dirtyIds.map((id) => INTEGRATIONS.find((d) => d.id === id)?.title || id);

  const updatePolicy = (patch: Partial<BackupPolicy>) => {
    onUpdateBackupPolicy?.({
      provider: patch.provider ?? backupPolicy.provider,
      enabled: patch.enabled ?? backupPolicy.enabled,
      format: patch.format ?? backupPolicy.format
    });
  };

  const panel = (
    <div
      onClick={(e) => e.stopPropagation()}
      className={
        isPage
          ? 'w-full bg-sh-surface border border-sh-line rounded-2xl shadow-sm overflow-hidden flex flex-col'
          : 'w-full max-w-2xl bg-sh-surface border border-sh-line rounded-2xl shadow-2xl overflow-hidden flex flex-col animate-in slide-in-from-bottom-2'
      }
      data-testid="settings-panel"
      data-variant={variant}
    >
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b border-sh-line">
        <div className="flex items-center gap-2">
          <Settings className="w-4 h-4 text-sh-muted" />
          <h3 className="text-sm font-semibold text-sh-fg">设置</h3>
        </div>
        {isPage ? (
          <button
            onClick={requestLeave}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-sh-line text-xs text-sh-muted hover:text-sh-fg"
            data-testid="settings-leave"
          >
            返回工作台
          </button>
        ) : (
          <button onClick={onClose} className="p-1 rounded-lg hover:bg-sh-surface2 text-sh-muted hover:text-sh-fg" aria-label="关闭设置">
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* Section nav + content */}
      <div className="flex min-h-0">
        <nav className="w-36 sm:w-44 shrink-0 border-r border-sh-line bg-sh-surface2/40 p-2 space-y-0.5">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const active = activePane === item.id;
            return (
              <button
                key={item.id}
                onClick={() => requestPane(item.id)}
                data-settings-nav={item.id}
                data-active={active ? 'true' : 'false'}
                aria-current={active ? 'page' : undefined}
                className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-left text-xs transition-colors ${
                  active
                    ? 'bg-sh-surface2 text-sh-fg font-semibold border border-sh-line-strong/60'
                    : 'text-sh-muted hover:text-sh-fg hover:bg-sh-surface2'
                }`}
              >
                <Icon className="w-3.5 h-3.5 shrink-0" />
                <span className="truncate">{item.label}</span>
              </button>
            );
          })}
        </nav>

        <div className="flex-1 min-w-0 p-5 space-y-4 overflow-y-auto max-h-[70vh]">
          {/* ============ 概览：所有外部连接真实状态一屏看清 ============ */}
          {activePane === 'overview' && (
            <div className="space-y-3" data-testid="settings-overview">
              <p className="text-xs text-sh-muted leading-relaxed">
                这里汇总所有外部连接与备份的真实状态。连接是否<strong>填写完整</strong>、是否<strong>通过检测</strong>、
                <strong>用途</strong>是否启用、<strong>任务</strong>是否在运行是四件不同的事，这里不合并成一个「已配置」。
              </p>

              {[
                ...INTEGRATIONS.map((def) => {
                  const status = connectionStatus(state, def);
                  return {
                    key: def.id as string,
                    name: def.title,
                    stage: status.stage,
                    statusLabel: status.label,
                    tone: status.tone,
                    detail: def.describe(state),
                    pane: 'connections' as SettingsPane
                  };
                }),
                {
                  key: 'backup',
                  name: '整站备份',
                  stage: resolvedTarget.canRun ? 'verified' : resolvedTarget.configured ? 'saved-untested' : 'empty',
                  statusLabel: resolvedTarget.canRun
                    ? `自动备份已开启（${providerName}）`
                    : resolvedTarget.configured
                    ? '已配置，自动备份未开启'
                    : '未配置',
                  tone: (resolvedTarget.canRun ? 'ok' : resolvedTarget.configured ? 'info' : 'neutral') as
                    | 'ok'
                    | 'info'
                    | 'neutral',
                  detail: resolvedTarget.destination || describeBackupAge(backupStatus?.lastAt),
                  pane: 'storage' as SettingsPane
                },
                {
                  key: 'extension',
                  name: '浏览器扩展内置同步',
                  stage: isExtensionContext() ? 'verified' : 'empty',
                  statusLabel: isExtensionContext() ? '扩展环境可用' : '普通网页不可用',
                  tone: (isExtensionContext() ? 'info' : 'neutral') as 'info' | 'neutral',
                  detail: isExtensionContext() ? '扩展同步与应用备份覆盖同一批数据，注意重复写入' : '当前是普通网页，扩展同步不可用',
                  pane: 'browser' as SettingsPane
                },
                {
                  key: 'index',
                  name: '本地存储与索引',
                  stage: 'verified',
                  statusLabel: '本机保存',
                  tone: 'ok' as const,
                  detail: '在「高级与维护」中查看用量与诊断',
                  pane: 'maintenance' as SettingsPane
                }
              ].map((row) => (
                <div
                  key={row.key}
                  data-overview-item={row.key}
                  className="flex items-center justify-between gap-3 rounded-xl border border-sh-line bg-sh-surface2/40 px-3 py-2"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-sh-fg truncate">{row.name}</span>
                      <span data-overview-stage={row.key} data-stage={row.stage}>
                        <StatusPill tone={row.tone} label={row.statusLabel} />
                      </span>
                    </div>
                    <p className="text-[10px] text-sh-subtle font-mono truncate mt-0.5">{row.detail}</p>
                  </div>
                  <Button variant="secondary" size="sm" onClick={() => requestPane(row.pane)}>
                    配置
                  </Button>
                </div>
              ))}
            </div>
          )}

          {/* ============ 使用偏好：模块开关 ============ */}
          {activePane === 'preferences' && (
            <div className="space-y-3" data-testid="settings-preferences">
              <p className="text-xs text-sh-muted leading-relaxed">
                不是每个模块都要用。关掉的模块会从侧边栏与顶部标签中消失，已存数据不会被删除，随时可以再打开。
                仪表盘、网站、倒计时与 Obsidian 笔记属于核心功能，不可关闭。
                主题与显示密度在顶栏即时切换，不需要保存按钮。
              </p>

              <div className="rounded-xl border border-sh-line bg-sh-surface2/40 divide-y divide-sh-line">
                {FEATURE_DEFS.map((def) => {
                  const enabled = isFeatureEnabled(state.features, def.id);
                  return (
                    <div key={def.id} className="flex items-center justify-between gap-3 px-3 py-2">
                      <div className="min-w-0">
                        <div className="text-xs text-sh-fg">{def.label}</div>
                        <p className="text-[10px] text-sh-muted mt-0.5 leading-relaxed">{def.description}</p>
                      </div>
                      <button
                        onClick={() => onToggleFeature?.(def.id, !enabled)}
                        data-feature-toggle={def.id}
                        data-enabled={enabled ? 'true' : 'false'}
                        aria-pressed={enabled}
                        className={`shrink-0 w-9 h-5 rounded-full transition-colors relative ${
                          enabled ? 'bg-sh-ok' : 'bg-sh-line-strong'
                        }`}
                        title={enabled ? '点击关闭，从导航中隐藏' : '点击开启'}
                      >
                        <span
                          className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all ${
                            enabled ? 'left-[18px]' : 'left-0.5'
                          }`}
                        />
                      </button>
                    </div>
                  );
                })}
              </div>
              <p className="text-[11px] text-sh-subtle leading-relaxed">
                这些开关是<strong>显示与模块</strong>偏好：关掉五彩不会删除已保存的 Token，
                也不会停止任何连接或任务——停用连接请到「连接与任务」，停止自动备份请到「数据与备份」。
              </p>
            </div>
          )}

          {/* ============ 连接与任务：草稿 + 四类事实 + 检测 ============ */}
          {activePane === 'connections' && (
            <div className="space-y-3" data-testid="settings-connections">
              <Hint id="connections-intro">
                连接状态依次是：未填写 → 草稿 → 已保存待测试 → 检测通过 / 检测失败。
                <strong>检测结果绑定配置版本</strong>：改了地址、密钥或路径，结果立即变成「已过期」，需要重新检测。
                检测只针对当前草稿，<strong>不会保存、也不会启用任何任务</strong>。
              </Hint>
              {dirtyIds.length > 0 && (
                <div
                  className="rounded-lg border border-sh-warn/50 bg-sh-warn/10 px-3 py-2 text-[11px] text-sh-warn"
                  data-testid="connections-dirty-notice"
                >
                  有 {dirtyIds.length} 个连接有未保存的修改：{dirtyTitles.join('、')}。切换分区会先询问你。
                </div>
              )}

              {/*
                每个桶一张「阿里云 OSS」卡（名称可自定义）。远端笔记里的「加桶」只是从这些已配置的
                桶里挑一个来显示 —— 配置归配置，显示归显示。
              */}
              {(onAddObsidianConnection || onRemoveObsidianConnection) && (
                <div className="flex items-center justify-between gap-2" data-testid="oss-cards-toolbar">
                  <span className="text-[11px] text-sh-subtle">
                    每个桶一张卡，共 {(obsidianConnections?.length ?? 0) || 1} 个
                  </span>
                  {onAddObsidianConnection && (
                    <Button variant="secondary" size="sm" onClick={onAddObsidianConnection} data-testid="oss-card-add">
                      + 添加阿里云 OSS 桶
                    </Button>
                  )}
                </div>
              )}

              {INTEGRATIONS.flatMap((def) => (def.id === 'oss' ? ossConnectionDefs(state) : [def])).map((def) => {
                const outcome = testOutcomes[def.id];
                return (
                  <div key={def.id} className="space-y-1">
                    <IntegrationCard
                      def={def}
                      state={state}
                      onSave={onSaveIntegration}
                    onDirtyChange={handleDirtyChange}
                    onDraftChange={handleDraftChange}
                    onTest={(draft) => void runTest(def, draft)}
                    testing={testingId === def.id}
                    resetSignal={discardToken}
                  >
                    <div className="space-y-1.5 w-full">
                      <p className="text-[10px] text-sh-subtle leading-relaxed" data-connection-capabilities={def.id}>
                        可用能力：
                        {def.capabilities.length
                          ? def.capabilities.map(capabilityLabel).join('、')
                          : '无（远端接口尚未接通）'}
                        {' · '}检测只能证明：
                        {def.testCapabilities.length ? def.testCapabilities.map(capabilityLabel).join('、') : '无'}
                      </p>
                      {def.purpose === 'backup' && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => requestPane('storage')}
                          data-backup-settings-link={def.id}
                        >
                          在「数据与备份」里启用/停用自动备份 →
                        </Button>
                      )}
                      {outcome && (
                        <div
                          data-test-result={def.id}
                          data-testid={
                            def.id === 'webdav' ? 'webdav-test-result' : def.id === 'ai' ? 'ai-test-result' : undefined
                          }
                          data-outcome={outcome.status}
                          className={`w-full rounded-lg border px-3 py-2 text-[11px] leading-relaxed whitespace-pre-wrap ${
                            outcome.status === 'ok'
                              ? 'border-sh-ok/50 bg-sh-ok/10 text-sh-ok'
                              : outcome.status === 'unavailable'
                              ? 'border-sh-line bg-sh-surface2/60 text-sh-muted'
                              : 'border-sh-danger/50 bg-sh-danger/10 text-sh-danger'
                          }`}
                        >
                          {outcome.status === 'ok' ? '✅ ' : outcome.status === 'unavailable' ? 'ℹ️ ' : '⚠️ '}
                          {outcome.message}
                        </div>
                      )}
                    </div>
                  </IntegrationCard>
                    {(def.id === 'oss' || def.id.startsWith('oss:')) &&
                      onRemoveObsidianConnection &&
                      (obsidianConnections?.length ?? 0) > 1 && (
                      <div className="flex justify-end">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => onRemoveObsidianConnection(def.id)}
                          data-testid={`oss-card-remove-${def.id}`}
                        >
                          删除这个桶
                        </Button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* ============ 数据与备份（P1-09） ============ */}
          {activePane === 'storage' && (
            <div className="space-y-4" data-testid="settings-storage">
              {/* 事实来源：v2 负载还是 v3 库。切换前先写入，切回只改偏好。 */}
              {storageMode && (
                <Section
                  title="存储模式（本机事实来源）"
                  description="决定应用从哪里读写你的资料。v2 负载是单一整包（受浏览器约 5MB 限制）；v3 库在 IndexedDB 里按实体存储。"
                  className="bg-sh-surface2/40"
                >
                  <div className="space-y-2 text-[11px]" data-testid="storage-mode">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <span className="text-sh-muted">当前模式</span>
                      {/* 迁移是最危险、最低频的操作，不该占据首屏第一位：
                          折叠在「切换存储 / 迁移…」后面，当前模式始终可见。 */}
                      <span className="flex items-center gap-2">
                        <span className="text-sh-fg font-mono" data-testid="storage-mode-current">
                          {storageMode.mode}
                        </span>
                        <Button
                          variant="secondary"
                          size="sm"
                          data-testid="storage-advanced-toggle"
                          aria-expanded={storageAdvancedOpen}
                          onClick={() => setStorageAdvancedOpen((open) => !open)}
                        >
                          {storageAdvancedOpen ? '收起迁移' : '切换存储 / 迁移…'}
                        </Button>
                      </span>
                    </div>
                    <p className="text-sh-subtle leading-relaxed">
                      {storageMode.mode === 'v3'
                        ? 'v3 库（IndexedDB）是事实来源；v2 负载仍会同步写入，作为随时可回退的副本。'
                        : 'v2 负载（localStorage 单一整包）是事实来源；v3 库不参与读写。'}
                      {' '}无论哪种模式，连接密钥都只留在本机，不进入资料库。
                    </p>
                    {storageMode.error && (
                      <p className="text-sh-warn" data-testid="storage-mode-error">
                        v3 库读取失败，当前仍使用 v2 负载：{storageMode.error}
                      </p>
                    )}
                    {storageAdvancedOpen && (
                      <>
                    {storageMode.mode === 'v3' && storageMode.counts && (
                      <div className="text-sh-subtle" data-testid="storage-mode-counts">
                        库内：{describeV3Counts(storageMode.counts)}
                      </div>
                    )}
                    <div className="flex flex-wrap items-center gap-2 pt-1">
                      {storageMode.mode === 'v3' ? (
                        <Button
                          variant="secondary"
                          size="sm"
                          data-testid="storage-mode-switch-local"
                          onClick={() => void onSwitchStorageMode?.('local')}
                        >
                          切回 v2 负载
                        </Button>
                      ) : (
                        <>
                          <input
                            type="password"
                            value={storageMigrationPassword}
                            onChange={(e) => setStorageMigrationPassword(e.target.value)}
                            placeholder="备份密码（用于加密迁移前的快照）"
                            data-testid="storage-migration-password"
                            className="rounded-lg border border-sh-line bg-sh-surface px-2 py-1 text-[11px] text-sh-fg"
                          />
                          {hasSessionBackupPassword() && (
                            <Button
                              variant="ghost"
                              size="sm"
                              data-testid="storage-migration-password-reuse"
                              onClick={() => setStorageMigrationPassword(getSessionBackupPassword() || '')}
                            >
                              用已解锁的备份密码
                            </Button>
                          )}
                          <Button
                            variant="primary"
                            size="sm"
                            data-testid="storage-mode-switch-v3"
                            disabled={storageSwitching}
                            onClick={async () => {
                              if (storageSwitching) return;
                              setStorageMigrationError(null);
                              setStorageSwitching(true);
                              try {
                                const result = await onSwitchStorageMode?.('v3', storageMigrationPassword);
                                if (result && !result.ok) setStorageMigrationError(result.error ?? '迁移失败');
                                setStorageMigrationPassword('');
                              } finally {
                                setStorageSwitching(false);
                              }
                            }}
                          >
                            {storageSwitching ? '正在迁移并校验…' : '迁移并切换到 v3 库'}
                          </Button>
                          <span className="text-sh-subtle text-[11px] w-full">
                            这里填的是「备份密码」，与下方 v3 加密备份用的是同一个密码，不是金库主密码。
                          </span>
                        </>
                      )}
                      <span className="text-sh-subtle">
                        切换会先写一份加密快照，再分批写入并校验计数与引用，确认无误后才改变读取来源；切回 v2 不会删除 v3 副本。
                      </span>
                    </div>
                    {storageMigrationError && (
                      <p className="text-sh-danger leading-relaxed" data-testid="storage-migration-error">
                        {storageMigrationError}
                      </p>
                    )}
                    {storageMode.migration && (
                      <div className="space-y-0.5 text-sh-subtle" data-testid="storage-migration-report">
                        <div>
                          已迁移到库 <span className="font-mono">{storageMode.migration.stagingLibraryId}</span>：
                          {storageMode.migration.counts} 个集合，未知字段 {storageMode.migration.unknownFields} 处。
                        </div>
                        {storageMode.migration.snapshotHash && (
                          <div className="font-mono truncate">快照 {storageMode.migration.snapshotHash.slice(0, 16)}…</div>
                        )}
                        {storageMode.migration.warnings.map((warning) => (
                          <div key={warning} className="text-sh-warn">
                            {warning}
                          </div>
                        ))}
                      </div>
                    )}
                      </>
                    )}
                  </div>
                </Section>
              )}

              <Section
                title="全量数据备份"
                description="手动、自动与概览共用同一套目的地解析：上面的选择就是实际写入的位置。"
                className="bg-sh-surface2/40"
              >
                <div className="space-y-3" data-testid="cloud-backup-section">
                  {backupStatus?.status === 'error' ? (
                    /* 失败不能是灰色小字：PRODUCT.md 的四问里「失败后如何处理」
                       必须就地给出重试和去因入口。 */
                    <div
                      className="rounded-xl border border-sh-danger/50 bg-sh-danger/10 px-3 py-2 space-y-1.5"
                      data-testid="backup-status"
                      role="alert"
                    >
                      <p className="text-[11px] text-sh-danger font-medium">
                        最近一次备份失败：{backupStatus.message || '未知原因'}
                      </p>
                      <div className="flex flex-wrap items-center gap-2">
                        <Button size="sm" variant="danger" onClick={() => void onBackupNow?.(true)}>
                          重试备份
                        </Button>
                        <Button size="sm" variant="secondary" onClick={() => requestPane('connections')}>
                          检查连接
                        </Button>
                      </div>
                    </div>
                  ) : backupStatus?.status === 'conflict' ? (
                    <div
                      className="rounded-xl border border-sh-warn/50 bg-sh-warn/10 px-3 py-2 text-[11px] text-sh-warn"
                      data-testid="backup-status"
                      role="status"
                    >
                      云端比本机新，未覆盖；要覆盖请在下方强制备份。
                    </div>
                  ) : (
                    <div className="flex flex-wrap items-center gap-2 text-[11px]">
                      <span className="font-mono text-sh-muted" data-testid="backup-status">
                        {backupStatus?.status === 'saving' ? '备份中…' : describeBackupAge(backupStatus?.lastAt)}
                      </span>
                    </div>
                  )}
                  {/* 2024-06 及更早的备份结果也在这里继续：目的地卡片属于同一个分区。 */}

                  <div className="rounded-xl border border-sh-line bg-sh-surface p-3 space-y-2" data-testid="backup-destination">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <span className="text-[11px] text-sh-muted">目的地</span>
                      <span className="text-[11px] text-sh-fg font-mono break-all" data-backup-destination>
                        {resolvedTarget.destination || '尚未配置'}
                      </span>
                    </div>
                    {/* OSS / WebDAV live in 连接与任务; say so and take the user there instead of
                        leaving a dead "先保存一个 OSS 或 WebDAV 连接" sentence in this pane. */}
                    {!resolvedTarget.destination && (
                      <div className="flex flex-wrap items-center gap-2">
                        <Button
                          variant="secondary"
                          size="sm"
                          data-testid="backup-goto-connections"
                          onClick={() => requestPane('connections')}
                        >
                          去「连接与任务」填写 OSS / WebDAV
                        </Button>
                        <span className="text-[11px] text-sh-subtle">连接信息只在那一处维护。</span>
                      </div>
                    )}
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <span className="text-[11px] text-sh-muted">实际使用的提供方</span>
                      <span className="text-[11px] text-sh-fg" data-backup-provider-used>
                        {providerName}
                        {resolvedTarget.canRun ? '（正在使用）' : '（尚未使用）'}
                      </span>
                    </div>
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <span className="text-[11px] text-sh-muted">自动备份任务</span>
                      <span className="text-[11px]" data-backup-auto-state>
                        {resolvedTarget.canRun ? '已开启并可运行' : resolvedTarget.enabled ? '已开启，但当前不可运行' : '未开启'}
                      </span>
                    </div>
                    {resolvedTarget.reason && (
                      <p className="text-[11px] text-sh-warn leading-relaxed" data-backup-reason>
                        {resolvedTarget.reason}
                      </p>
                    )}

                    {onUpdateBackupPolicy ? (
                      <div className="flex flex-wrap items-center gap-2 pt-1">
                        <button
                          onClick={() => updatePolicy({ enabled: !backupPolicy.enabled })}
                          data-backup-auto-toggle
                          data-enabled={backupPolicy.enabled ? 'true' : 'false'}
                          aria-pressed={backupPolicy.enabled}
                          className={`shrink-0 w-9 h-5 rounded-full transition-colors relative ${
                            backupPolicy.enabled ? 'bg-sh-ok' : 'bg-sh-line-strong'
                          }`}
                          title={backupPolicy.enabled ? '点击暂停自动备份' : '点击开启自动备份'}
                        >
                          <span
                            className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all ${
                              backupPolicy.enabled ? 'left-[18px]' : 'left-0.5'
                            }`}
                          />
                        </button>
                        <span className="text-[11px] text-sh-fg">自动备份</span>
                        <span className="text-[11px] text-sh-subtle">
                          {backupPolicy.enabled ? '已开启（保存后按上面的目的地运行）' : '已暂停'}
                        </span>
                      </div>
                    ) : (
                      <p className="text-[11px] text-sh-subtle">在设置页面里可以修改目的地与自动备份开关。</p>
                    )}

                    <div className="pt-1 space-y-1">
                      <div className="text-[11px] text-sh-muted">目的地选择</div>
                      <div className="flex flex-wrap gap-1.5">
                        {(
                          [
                            { id: 'auto', label: '自动选择' },
                            { id: 'oss', label: '只用 OSS' },
                            { id: 'webdav', label: '只用 WebDAV' }
                          ] as const
                        ).map((option) => (
                          <button
                            key={option.id}
                            onClick={() => onUpdateBackupPolicy && updatePolicy({ provider: option.id })}
                            disabled={!onUpdateBackupPolicy}
                            data-backup-provider={option.id}
                            data-active={backupPolicy.provider === option.id ? 'true' : 'false'}
                            className={`px-2.5 py-1 rounded-lg text-[11px] border transition-colors disabled:opacity-50 ${
                              backupPolicy.provider === option.id
                                ? 'border-sh-line-strong bg-sh-surface2 text-sh-fg font-semibold'
                                : 'border-sh-line text-sh-muted hover:text-sh-fg'
                            }`}
                          >
                            {option.label}
                          </button>
                        ))}
                      </div>

                      {/* 多端备份：勾上的每个目的地各存一份（WebDAV 一份 + OSS 一份）。 */}
                      <div className="pt-1">
                        <div className="text-[11px] text-sh-muted mb-1">多端备份（可以同时勾多个）</div>
                        <div className="flex flex-wrap gap-3">
                          {(
                            [
                              { id: 'oss', label: 'OSS', ok: resolvedTarget.ossConfigured },
                              { id: 'webdav', label: 'WebDAV', ok: resolvedTarget.webdavConfigured }
                            ] as const
                          ).map((option) => {
                            const selected = (backupPolicy.destinations ?? []).includes(option.id);
                            return (
                              <label
                                key={option.id}
                                className={`inline-flex items-center gap-1.5 text-[11px] ${
                                  option.ok ? 'text-sh-fg' : 'text-sh-subtle'
                                }`}
                                title={option.ok ? undefined : '这个连接还没配置完整'}
                              >
                                <input
                                  type="checkbox"
                                  checked={selected}
                                  disabled={!option.ok || !onUpdateBackupPolicy}
                                  data-backup-destination={option.id}
                                  onChange={(event) => {
                                    if (!onUpdateBackupPolicy) return;
                                    const next = new Set(backupPolicy.destinations ?? []);
                                    if (event.target.checked) next.add(option.id);
                                    else next.delete(option.id);
                                    onUpdateBackupPolicy({
                                      provider: backupPolicy.provider,
                                      enabled: backupPolicy.enabled,
                                      format: backupPolicy.format,
                                      destinations: Array.from(next) as Array<'oss' | 'webdav'>
                                    });
                                  }}
                                />
                                {option.label}
                              </label>
                            );
                          })}
                        </div>
                        <p className="text-[10px] text-sh-subtle mt-1">
                          勾一个就只备一份；两个都勾就各存一份。都不勾则按上面的「目的地选择」走。
                        </p>
                      </div>
                    </div>
                  </div>

                  {resolvedTarget.bothConfigured && (
                    <div
                      className="rounded-lg border border-sh-warn/50 bg-sh-warn/10 px-3 py-2 text-[11px] text-sh-warn leading-relaxed"
                      data-testid="backup-both-warning"
                    >
                      ⚠️ OSS 与 WebDAV 都已配置。当前实际写入的是 <strong>{providerName}</strong>，
                      另一个只会闲置；它的存在不会让数据更安全。请在上面固定一个目的地，避免以后误以为两份都在更新。
                    </div>
                  )}

                  <div className="rounded-lg border border-sh-line bg-sh-surface p-3 space-y-1 text-[11px] leading-relaxed" data-testid="backup-scope">
                    <div data-testid="backup-recent-runs">
                      <span className="text-sh-muted">最近成功：</span>
                      <span className="text-sh-fg">
                        {backupStatus?.lastAt ? describeBackupAge(backupStatus.lastAt) : '本会话还没有成功的备份'}
                      </span>
                      <span className="text-sh-muted"> · 最近失败：</span>
                      <span className={backupStatus?.status === 'error' ? 'text-sh-danger' : 'text-sh-fg'}>
                        {backupStatus?.status === 'error' ? backupStatus.message || '未知原因' : '本会话没有失败记录'}
                      </span>
                    </div>
                    <div className="text-sh-muted" data-testid="backup-scope-format">
                      覆盖范围：站点、提醒、项目、收件箱、批注、签到、笔记等本地数据。
                      {activeBackupFormat === 'v3' ? (
                        <>
                          当前选择的是 <strong className="text-sh-fg">v3 加密批次</strong>
                          ：每个批次独立、逐对象加密、带完成标记，范围与引用备份情况见下方面板。
                        </>
                      ) : (
                        <>
                          快照是<strong className="text-sh-fg">明文 JSON</strong>，但会剥离 AccessKey Secret、
                          WebDAV 密码、AI Key 与五彩 Token（金库条目只保留密文，仍需要主密码）。换设备恢复后要重新填写凭据。
                        </>
                      )}
                    </div>
                    <div className="text-sh-muted">
                      运行条件：<strong className="text-sh-fg">普通网页只在页面打开时备份</strong>；浏览器扩展里可以随浏览器在后台运行；
                      两者都<strong className="text-sh-fg">无法在浏览器关闭后运行</strong>。写入位置：
                      <code className="text-sh-fg mx-1">{resolvedTarget.destination || backupKeyFor(obsidianConfig)}</code>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={async () => {
                        if (!onBackupNow) return;
                        // Never clobber a newer cloud snapshot silently: ask first.
                        const res = await onBackupNow(false);
                        if (res.ok) {
                          showToastGlobal('已备份到云端', 'ok');
                          return;
                        }
                        if (res.conflict) {
                          showToastGlobal(res.error || '云端备份比本机新，本地快照已另存到 conflicts 目录', 'warn');
                          if (!(await confirm({ title: '覆盖云端备份？', description: '云端备份比本机更新（可能来自另一台设备）。仍要用本机数据覆盖云端吗？', confirmLabel: '覆盖云端', tone: 'danger' }))) return;
                          const forced = await onBackupNow(true);
                          showToastGlobal(forced.ok ? '已用本机数据覆盖云端备份' : forced.error || '覆盖失败', forced.ok ? 'ok' : 'danger');
                          return;
                        }
                        showToastGlobal(`备份失败：${res.error || '未知原因'}`, 'danger');
                      }}
                      disabled={backupStatus?.status === 'saving' || !onBackupNow}
                      data-testid="backup-now"
                    >
                      立即备份
                    </Button>

                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={async () => {
                        // Restore from whichever provider the shared resolver chose.
                        const res =
                          resolvedTarget.provider === 'webdav' && webdavConfig
                            ? await readStateBackupFromWebdav(webdavConfig)
                            : await readStateBackup(obsidianConfig);
                        if (!res.ok || !res.backup) {
                          showToastGlobal(`无法读取云端备份：${res.error || '未知原因'}`, 'danger');
                          return;
                        }
                        const when = res.backup.envelope.updatedAt
                          ? new Date(res.backup.envelope.updatedAt).toLocaleString()
                          : '未知时间';
                        if (
                          !(await confirm({
                            title: '从云端恢复备份？',
                            description: `备份时间：${when} · 来源设备：${res.backup.envelope.deviceId}。当前本机数据会被这份备份覆盖（建议先「立即备份」把当前状态存上去）。`,
                            confirmLabel: '恢复',
                            tone: 'danger'
                          }))
                        ) {
                          return;
                        }
                        // Credentials never travel in the backup; keep the local ones.
                        onRestoreState(mergeRestoredState(res.backup.envelope.state, state));
                        showToastGlobal('已从云端恢复', 'ok');
                      }}
                      data-testid="restore-from-cloud"
                    >
                      从云端恢复
                    </Button>
                  </div>
                </div>
              </Section>

              {v3Backup && (
                <V3BackupSection
                  panel={v3Backup.panel}
                  destination={resolvedTarget.destination}
                  formatWarning={resolvedTarget.formatWarning}
                  onUnlock={v3Backup.onUnlock}
                  onLock={v3Backup.onLock}
                  onRefresh={v3Backup.onRefresh}
                  onRun={v3Backup.onRun}
                  onPrune={v3Backup.onPrune}
                  onFormatChange={v3Backup.onFormatChange}
                  onPreviewBatch={v3Backup.onPreviewBatch}
                  onConflictChoice={v3Backup.onConflictChoice}
                  onRestoreMode={v3Backup.onRestoreMode}
                  onApplyRestore={v3Backup.onApplyRestore}
                  onDiscardPreview={v3Backup.onDiscardPreview}
                  credentialScope={v3Backup.panel.credentialScope ?? []}
                  onExportMigration={v3Backup.onExportMigration}
                  onPreviewMigration={v3Backup.onPreviewMigration}
                  onImportCredentialsChange={v3Backup.onImportCredentialsChange}
                  onRemoveMigration={v3Backup.onRemoveMigration}
                  onExportBundle={v3Backup.onExportBundle}
                  onImportBundle={v3Backup.onImportBundle}
                  onRetestConnections={v3Backup.onRetestConnections}
                />
              )}

              <Section title="加密包" description="AES-256-GCM 完整加密备份包（推荐跨设备转移）" className="bg-sh-surface2/40">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="text-[11px] text-sh-muted leading-relaxed max-w-lg space-y-1">
                    <p>
                      使用 PBKDF2（100,000 次加盐迭代）+ AES-256-GCM 在本地加密全站数据（书签、笔记、金库凭据与项目），
                      生成 <code className="text-sh-muted">.enc.json</code> 密文文件；上传到网盘或经网络传输都不会以明文暴露。
                    </p>
                    <p className="text-sh-subtle">
                      与上面「跨环境交换」的区别：那是 v3 批次工具（先预览差异、再决定冲突，需要先解锁备份密码），
                      这里的旧版单文件导出不做预览、直接覆盖导入。日常换设备优先用「跨环境交换」。
                    </p>
                  </div>
                  <Button
                    variant="secondary"
                    size="sm"
                    icon={<Key className="w-3.5 h-3.5 text-sh-warn" />}
                    onClick={handleExportEncryptedClick}
                    busy={isExportingEncrypted}
                  >
                    {isExportingEncrypted ? '加密打包中...' : '导出加密包'}
                  </Button>
                </div>

                {showExportPasswordInput && (
                  <div className="mt-3 p-3 rounded-lg bg-sh-bg border border-sh-warn/40 space-y-2">
                    <div className="text-[11px] text-sh-fg">请输入加密备份用的主密码：</div>
                    <div className="flex items-center gap-2">
                      <input
                        type="password"
                        value={exportPassword}
                        onChange={(e) => setExportPassword(e.target.value)}
                        placeholder="输入加密密钥 / 主密码..."
                        className="flex-1 bg-sh-surface border border-sh-line rounded px-2.5 py-1 text-xs text-sh-fg font-mono focus:outline-none"
                      />
                      <Button variant="primary" size="sm" onClick={handleExportEncryptedClick}>
                        确认导出
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setShowExportPasswordInput(false);
                          setExportPassword('');
                        }}
                      >
                        取消
                      </Button>
                    </div>
                  </div>
                )}
              </Section>

              <Section title="明文 JSON 备份" description="导出未二次加密的纯 JSON，便于本地查阅或文本编辑" className="bg-sh-surface2/40">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p className="text-[11px] text-sh-warn leading-relaxed">
                    明文导出会把 OSS 密钥、WebDAV 密码、AI Key 等以可读形式写进文件。请只存放在可信位置。
                  </p>
                  <Button
                    variant="secondary"
                    size="sm"
                    icon={<Download className="w-3.5 h-3.5" />}
                    onClick={async () => {
                      // The plaintext export is the one artifact that DOES contain
                      // credentials, so make the user acknowledge it once.
                      const hasSecrets = Boolean(
                        state.obsidianConfig?.accessKeySecret ||
                          state.webdavConfig?.password ||
                          state.aiConfig?.apiKey ||
                          state.wucaiConfig?.token ||
                          (state.secrets || []).length > 0
                      );
                      if (
                        hasSecrets &&
                        !(await confirm({
                          title: '仍要导出明文？',
                          description: '明文 JSON 里的 OSS 密钥、WebDAV 密码、AI Key 会以可读形式写入文件。只存可信位置，不要上传网盘；安全转移请改用「导出加密包」。',
                          confirmLabel: '导出明文',
                          tone: 'danger'
                        }))
                      ) {
                        return;
                      }
                      // Same reason as the encrypted export: pick up the current new-tab
                      // layout at the moment of the export.
                      void withFreshNewtabPreferences(state).then((fresh) => exportBackup(fresh));
                    }}
                  >
                    导出明文
                  </Button>
                </div>
              </Section>

              <Section title="恢复与导入" description="支持 .enc.json 加密包或标准 .json 明文备份，自动检测格式" className="bg-sh-surface2/40">
                <div className="flex flex-wrap items-center gap-2">
                  {canRollback && (
                    <Button
                      variant="secondary"
                      size="sm"
                      icon={<RotateCcw className="w-3.5 h-3.5" />}
                      onClick={handleRollback}
                      title="恢复到上一次导入备份之前的数据"
                    >
                      撤销上次导入
                    </Button>
                  )}
                  <label className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-sh-line bg-sh-surface2 text-xs text-sh-fg cursor-pointer">
                    <Upload className="w-3.5 h-3.5" />
                    选择文件
                    <input
                      type="file"
                      accept=".json,.enc.json"
                      onChange={handleImportFile}
                      data-testid="import-backup-file"
                      className="hidden"
                    />
                  </label>
                </div>
              </Section>

              <Section
                title="危险区域"
                description="删除本机全部数据与缓存，无法撤销（云端已备份的快照不受影响）"
                className="bg-sh-surface2/40 border-sh-danger/40"
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="text-xs text-sh-danger inline-flex items-center gap-1">
                    <AlertTriangle className="w-3.5 h-3.5" />
                    重置所有数据
                  </span>
                  <Button variant="danger" size="sm" onClick={handleResetData}>
                    重置所有数据
                  </Button>
                </div>
              </Section>
            </div>
          )}

          {/* ============ 浏览器与设备 ============ */}
          {activePane === 'browser' && (
            <div className="space-y-3" data-testid="settings-browser">
              <div className="rounded-xl border border-sh-line bg-sh-surface2/40 p-4 space-y-3" data-testid="extension-sync-section">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <h4 className="text-xs font-semibold text-sh-fg">浏览器扩展内置同步</h4>
                    <p className="text-[11px] text-sh-muted mt-0.5 leading-relaxed">
                      扩展里另有一套同步，会单独把站点、批注、收件箱写到云盘。它和本应用的「全量备份」
                      <b className="text-sh-muted">覆盖同一批数据但写在不同的目录</b>，同时开启会让同一份站点出现两处副本。
                    </p>
                  </div>
                </div>

                {!extSync.available ? (
                  <p className="text-[11px] text-sh-muted">
                    当前不是扩展环境，扩展自带同步不可用（也不会有重复写入的问题）。普通网页无法使用扩展的采集与后台能力。
                  </p>
                ) : (
                  <>
                    <div className="rounded-lg border border-sh-line bg-sh-surface p-3 font-mono text-[11px] space-y-1">
                      <div className="flex justify-between">
                        <span className="text-sh-muted">当前状态</span>
                        <span className={extSync.provider === 'none' ? 'text-sh-muted' : 'text-sh-ok'}>
                          {extSync.provider === 'none' ? '已关闭' : `已开启（${extSync.provider.toUpperCase()}）`}
                        </span>
                      </div>
                      {extSync.pathPrefix && (
                        <div className="flex justify-between">
                          <span className="text-sh-muted">写入目录</span>
                          <span className="text-sh-fg">{extSync.pathPrefix}/</span>
                        </div>
                      )}
                      {extSync.endpoint && (
                        <div className="flex justify-between gap-3">
                          <span className="text-sh-muted shrink-0">目标</span>
                          <span className="text-sh-fg truncate">{extSync.endpoint}</span>
                        </div>
                      )}
                      <div className="flex justify-between">
                        <span className="text-sh-muted">上次同步</span>
                        <span className="text-sh-muted">
                          {extSync.lastSyncTime ? new Date(extSync.lastSyncTime).toLocaleString() : '从未'}
                        </span>
                      </div>
                    </div>

                    {/* Overlap warning: both systems writing the same datasets. */}
                    {extSync.provider !== 'none' && backupTargetActive && (
                      <div
                        className="rounded-lg border border-sh-warn/50 bg-sh-warn/10 px-3 py-2 text-[11px] text-sh-warn leading-relaxed"
                        data-testid="sync-overlap-warning"
                      >
                        ⚠️ 两套同步同时开启：站点/批注会被写两次（扩展写「{extSync.pathPrefix || 'selfhub_sync'}/」，
                        应用备份写各自的目标）。建议只保留一套——应用备份已包含全部数据，建议关闭扩展同步。
                      </div>
                    )}

                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={async () => {
                          const turningOff = extSync.provider !== 'none';
                          if (
                            turningOff &&
                            !(await confirm({
                              title: '关闭扩展自带同步？',
                              description: '站点、批注、收件箱之后由「全量备份」统一负责；云端已写入的旧文件不会被删除。',
                              confirmLabel: '关闭同步'
                            }))
                          ) {
                            return;
                          }
                          const ok = await setExtensionSyncEnabled(!turningOff);
                          if (!ok) {
                            showToastGlobal('修改失败，请稍后重试', 'danger');
                            return;
                          }
                          setExtSync(await readExtensionSyncState());
                        }}
                        data-testid="extension-sync-toggle"
                      >
                        {extSync.provider === 'none' ? '开启扩展同步' : '关闭扩展同步（推荐）'}
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => openExtensionOptions()} data-testid="open-extension-options">
                        打开扩展完整设置页
                      </Button>
                    </div>
                  </>
                )}
              </div>

              <div className="rounded-xl border border-sh-line bg-sh-surface2/40 p-4 space-y-1 text-[11px] leading-relaxed">
                <div className="text-xs text-sh-fg">运行环境</div>
                <div className="text-sh-muted">
                  当前：{isExtensionContext() ? '浏览器扩展（可用采集、后台任务与新标签页）' : '普通网页（可用本机保存、搜索与手动备份）'}
                </div>
                <div className="text-sh-muted">
                  通知与采集权限由浏览器决定；权限不足时站内提醒仍然保留，不会假装已经通知。
                </div>
              </div>
            </div>
          )}

          {/* ============ 隐私与安全 ============ */}
          {activePane === 'privacy' && (
            <div className="space-y-3" data-testid="settings-privacy">
              <div className="rounded-xl border border-sh-line bg-sh-surface2/40 p-4 space-y-1 text-[11px] leading-relaxed">
                <div className="text-xs text-sh-fg">解锁与信任</div>
                {/* 三个事实分开说：设没设过主密码 / 金库锁没锁 / 本次会话解没解锁。
                    旧实现只看 masterPassword，「设过但锁定」会显示成「未设置」。 */}
                <div
                  className="text-sh-muted flex items-center gap-1.5"
                  data-vault-lock-state={!hasMasterAuth ? 'none' : masterPassword ? 'unlocked' : 'locked'}
                >
                  <VaultStateBadge hasMasterAuth={Boolean(hasMasterAuth)} unlocked={Boolean(masterPassword)} />
                  <span>
                    主密码：{hasMasterAuth ? '已设置' : '未设置'}
                    {hasMasterAuth && !masterPassword ? '（金库当前锁定中）' : ''}
                  </span>
                </div>
                <div className="text-sh-muted">
                  金库解锁是独立机制：锁定会清除内存中的明文，取消「在首页显示金库」不等于锁定。凭据不会写进首页片段与普通全文检索。
                </div>
              </div>

              <div className="rounded-xl border border-sh-line bg-sh-surface2/40 p-4 space-y-1 text-[11px] leading-relaxed">
                <div className="text-xs text-sh-fg">内容外发</div>
                <div
                  className={state.aiConfig?.cloudAiEnabled === true ? 'text-sh-warn' : 'text-sh-muted'}
                  data-cloud-ai-state={state.aiConfig?.cloudAiEnabled === true ? 'allowed' : 'blocked'}
                >
                  云端 AI：{state.aiConfig?.cloudAiEnabled === true ? '已允许把内容发送到所选服务商' : '已关闭（只用本机规则）'}
                </div>
                <div className="text-sh-muted">
                  允许后，只有你主动粘贴并点击分拣/提炼时才会发送；没有任何后台任务会自动上传内容。
                </div>
                <Button variant="secondary" size="sm" onClick={() => requestPane('connections')} data-cloud-ai-settings>
                  去「连接与任务」检查 AI 连接与发送开关
                </Button>
              </div>

              <div className="rounded-xl border border-sh-line bg-sh-surface2/40 p-4 space-y-1 text-[11px] leading-relaxed">
                <div className="text-xs text-sh-fg">本机保存与日志</div>
                <div className="text-sh-muted">
                  数据默认只存在这台设备的浏览器里。检测记录只保存不可逆的配置指纹，不保存任何密钥；密钥不会写入日志或页面属性。
                </div>
              </div>

              <div className="p-3.5 rounded-xl bg-sh-surface2/40 border border-sh-line text-xs leading-relaxed">
                <div className="font-semibold text-sh-fg flex items-center gap-1.5 mb-1.5">
                  <Shield className="w-4 h-4 text-sh-ok" />
                  独立域名自定义部署与防护指引
                </div>
                <p className="text-sh-muted mb-2">
                  1. 本项目构建产物（`npm run build` 生成的 `dist` 目录）直接拖拽发布至 <strong>Cloudflare Pages</strong> 或任意静态托管服务即可秒级上线。<br />
                  2. 在 Cloudflare Dashboard 绑定您的自定义域名（如 <code>my-hub.com</code>）。<br />
                  3. 在 <strong>Zero Trust &gt; Access &gt; Applications</strong> 中为该域名添加门禁策略：设置规则为 <em>Include: Emails = 您的个人邮箱</em>。
                </p>
                <div className="text-[11px] text-sh-ok bg-sh-ok/10 p-2 rounded-lg border border-sh-ok/40">
                  ✅ 效果：未经授权的访客打开该域名会被 Cloudflare 边缘直接拦截；只有输入您邮箱的 6 位临时验证码才能进入。
                </div>
              </div>
            </div>
          )}

          {/* ============ 高级与维护 ============ */}
          {activePane === 'maintenance' && (
            <div className="space-y-4" data-testid="settings-maintenance">
              <div className="p-4 rounded-xl bg-sh-surface2/40 border border-sh-line space-y-2">
                <div className="flex items-center justify-between text-xs">
                  <div className="flex items-center gap-1.5 text-sh-fg font-medium">
                    <Database className="w-3.5 h-3.5 text-sh-info" />
                    <span>本地存储健康与容量 (IndexedDB + Storage)</span>
                  </div>
                  {quota && (
                    <span className="font-mono text-[11px] text-sh-muted">
                      {quota.usageMb.toFixed(2)} MB / {quota.quotaMb.toFixed(0)} MB ({quota.percentage.toFixed(1)}%)
                    </span>
                  )}
                </div>
                <div className="w-full bg-sh-line h-1.5 rounded-full overflow-hidden">
                  <div
                    className="bg-sh-ok h-full rounded-full transition-all duration-300"
                    style={{ width: `${Math.min(100, Math.max(1, quota ? quota.percentage : 5))}%` }}
                  />
                </div>
                <div className="text-[10px] text-sh-muted flex items-center justify-between pt-0.5">
                  <span>支持离线断网运行、本地零延迟读写、零知识隔离</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={<RefreshCw className="w-2.5 h-2.5" />}
                    onClick={() => estimateStorageQuota().then((q) => setQuota(q))}
                  >
                    刷新
                  </Button>
                </div>
              </div>

              <Section title="诊断信息" description="排查问题时需要的最小事实，不包含任何凭据" className="bg-sh-surface2/40">
                <div className="rounded-lg border border-sh-line bg-sh-surface p-3 font-mono text-[11px] space-y-1" data-testid="diagnostics">
                  <div className="flex justify-between gap-3">
                    <span className="text-sh-muted">运行环境</span>
                    <span className="text-sh-fg">{isExtensionContext() ? 'extension' : 'web'}</span>
                  </div>
                  <div className="flex justify-between gap-3">
                    <span className="text-sh-muted">数据版本</span>
                    <span className="text-sh-fg">{state.schemaVersion ?? '（未标记）'}</span>
                  </div>
                  <div className="flex justify-between gap-3">
                    <span className="text-sh-muted">本机数据量</span>
                    <span className="text-sh-fg">
                      {state.sites.length} 站点 / {state.notes?.length ?? 0} 笔记 / {state.reminders?.length ?? 0} 提醒 /{' '}
                      {state.inbox?.length ?? 0} 收件箱
                    </span>
                  </div>
                  <div className="flex justify-between gap-3" data-testid="diagnostics-storage">
                    <span className="text-sh-muted">本机存储占用</span>
                    <span className={storageHealth.nearQuota ? 'text-sh-warn' : 'text-sh-fg'}>
                      {describeStorageHealth(storageHealth)}
                    </span>
                  </div>
                  {storageHealth.nearQuota && (
                    <p className="text-[11px] text-sh-warn leading-relaxed" data-testid="diagnostics-storage-warning">
                      已经超过警戒线：浏览器通常在 5 MB 左右拒绝写入。请先导出备份，再清理不再需要的手绘或大笔记。
                    </p>
                  )}
                  <div className="flex justify-between gap-3">
                    <span className="text-sh-muted">备份目的地</span>
                    <span className="text-sh-fg truncate">{resolvedTarget.destination || '未配置'}</span>
                  </div>
                </div>
              </Section>

              <Section
                title="损坏载荷抢救"
                description="主数据解析失败时，原始字节会被原样留在这里，不会被覆盖或删除"
                className="bg-sh-surface2/40"
              >
                {salvage.length === 0 ? (
                  <p className="text-[11px] text-sh-subtle" data-testid="salvage-empty">
                    没有发现无法解析的本地数据副本。
                  </p>
                ) : (
                  <div className="space-y-2" data-testid="salvage-list">
                    <p className="text-[11px] text-sh-warn leading-relaxed">
                      发现 {salvage.length} 份无法解析的数据副本。应用已经用可用的数据继续运行，但这份原始内容只在这里可以取回：
                      先导出保存，确认不需要后再删除。
                    </p>
                    <div className="rounded-lg border border-sh-line bg-sh-surface divide-y divide-sh-line">
                      {salvage.map((entry) => (
                        <div
                          key={entry.key}
                          className="flex flex-wrap items-center justify-between gap-2 px-3 py-2"
                          data-salvage-entry={entry.key}
                        >
                          <span className="min-w-0">
                            <span className="block text-[11px] text-sh-fg font-mono truncate">{entry.key}</span>
                            <span className="block text-[10px] text-sh-subtle">
                              {entry.at ? new Date(entry.at).toLocaleString() : '时间未知'} ·{' '}
                              {entry.bytes.toLocaleString()} 字符
                            </span>
                          </span>
                          <span className="flex items-center gap-1.5 shrink-0">
                            <Button size="sm" variant="secondary" onClick={() => exportSalvaged(entry.key)}>
                              导出原始内容
                            </Button>
                            <Button size="sm" variant="danger" onClick={() => setSalvageToDelete(entry.key)}>
                              删除
                            </Button>
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </Section>

              <Section title="连接检测记录"
                description="每条记录都绑定到当时的配置指纹；配置一改，记录立即失效"
                className="bg-sh-surface2/40"
              >
                <div className="rounded-lg border border-sh-line bg-sh-surface divide-y divide-sh-line" data-testid="test-records">
                  {INTEGRATIONS.map((def) => {
                    const record = state.connectionTests?.[def.id];
                    const status = connectionStatus(state, def);
                    return (
                      <div key={def.id} className="flex items-center justify-between gap-3 px-3 py-2" data-test-record={def.id}>
                        <span className="text-[11px] text-sh-fg truncate">{def.title}</span>
                        <span className="flex items-center gap-2 shrink-0">
                          <span className="text-[10px] text-sh-subtle font-mono">
                            {record ? new Date(record.at).toLocaleString() : '从未检测'}
                            {record?.environment ? ` · ${record.environment}` : ''}
                          </span>
                          <span data-test-record-stage={def.id} data-stage={status.stage}>
                            <StatusPill tone={status.tone} label={status.label} />
                          </span>
                        </span>
                      </div>
                    );
                  })}
                </div>
              </Section>

              <Section title="迁移与重置" description="导入导出、加密包与重置都在这里统一入口" className="bg-sh-surface2/40">
                <div className="flex flex-wrap items-center gap-2">
                  <Button variant="secondary" size="sm" onClick={() => requestPane('storage')} data-goto-backup>
                    去「数据与备份」导出 / 导入 / 重置
                  </Button>
                </div>
              </Section>
            </div>
          )}
        </div>
      </div>

      {confirmDialog}

      <ConfirmDialog
        open={pendingEncryptedRestore !== null}
        title="输入主密码以解密这份加密备份"
        tone="danger"
        confirmLabel="解密并恢复"
        cancelLabel="取消导入"
        onConfirm={async () => {
          const content = pendingEncryptedRestore;
          const pwd = restorePassword;
          setPendingEncryptedRestore(null);
          setRestorePassword('');
          if (content && pwd) await runEncryptedRestore(content, pwd);
        }}
        onCancel={() => {
          setPendingEncryptedRestore(null);
          setRestorePassword('');
        }}
        description={
          <div className="space-y-2">
            <p>检测到 AES-256 加密备份文件。主密码只用于本机解密，不会离开这台设备。</p>
            <input
              type="password"
              value={restorePassword}
              onChange={(e) => setRestorePassword(e.target.value)}
              autoFocus
              aria-label="备份主密码"
              data-testid="restore-password-input"
              className={inputClass}
              placeholder="主密码"
            />
            <p className="text-sh-warn">密码错误时恢复会中止，现有数据不受影响。</p>
          </div>
        }
      />

      <ConfirmDialog
        open={salvageToDelete !== null}
        title="删除这份抢救副本？"
        description={
          <div className="space-y-1.5">
            <p>
              这会永久删除 <span className="font-mono">{salvageToDelete}</span>。它是主数据解析失败时保留下来的原始字节，
              当前运行的数据不依赖它。
            </p>
            <p className="text-sh-warn">如果还可能有别的信息只存在于这份副本里，请先导出再删除。</p>
          </div>
        }
        confirmLabel="永久删除"
        tone="danger"
        onConfirm={() => salvageToDelete && deleteSalvaged(salvageToDelete)}
        onCancel={() => setSalvageToDelete(null)}
      />

      {/* Footer */}
      {isPage ? (
        // The modal's bottom "保存配置" button never saved anything — each card
        // persists its own values. On a routed page there is no reason to keep a
        // button that only pretends to commit, so it is replaced by the rule.
        <div className="flex flex-wrap items-center justify-between gap-2 p-4 border-t border-sh-line text-[11px] text-sh-muted">
          <span>连接信息由每张卡片的「保存连接」提交；主题、密度等偏好即时生效。测试连接不会保存或启用任何任务。</span>
          <button onClick={requestLeave} className="px-3 py-1.5 rounded-xl bg-sh-surface2 hover:bg-sh-line text-sh-muted text-xs">
            返回工作台
          </button>
        </div>
      ) : (
        <div className="flex items-center justify-end gap-2 p-4 border-t border-sh-line">
          <button onClick={onClose} className="px-4 py-2 rounded-xl bg-sh-surface2 hover:bg-sh-line text-sh-muted text-xs">
            关闭
          </button>
        </div>
      )}

      {/* Unsaved-draft guard: 继续编辑 / 放弃修改 / 保存后离开 */}
      <ConfirmDialog
        open={guard !== null}
        title="有未保存的连接修改"
        cancelLabel="继续编辑"
        confirmLabel="保存后离开"
        onCancel={() => setGuard(null)}
        onConfirm={handleSaveAndProceed}
        description={
          <div className="space-y-2" data-testid="unsaved-changes-dialog">
            <p>
              以下连接有未保存的修改：<strong>{dirtyTitles.join('、')}</strong>。
            </p>
            <p>离开会丢弃这些修改；已经保存的连接和正在运行的任务不会受影响。</p>
            <Button variant="danger" size="sm" onClick={handleDiscardAndProceed} data-testid="unsaved-discard">
              放弃修改
            </Button>
          </div>
        }
      />
    </div>
  );

  if (!isPage) {
    return (
      <div
        onClick={onClose}
        className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-[var(--sh-overlay)] backdrop-blur-sm animate-in fade-in"
      >
        {panel}
      </div>
    );
  }

  return <div data-testid="settings-page">{panel}</div>;
};

export default SettingsModal;
