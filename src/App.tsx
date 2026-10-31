import React, { useCallback, useEffect, useMemo, useRef, useState, Suspense } from 'react';
import { AlertTriangle, Loader2, RefreshCw, X } from 'lucide-react';
import { HubState, InboxItem, ReminderItem, ServerDeployment, WebPageAnnotation } from './types';
import { loadHubState, saveHubState, normalizeHubState, STORAGE_CAP_BYTES, getStorageKey, writeV2Rollback, readV2Rollback } from './lib/storage';
import { readStorageMode, writeStorageMode, LOCAL_LIBRARY_ID, type StorageMode } from './lib/storageMode';
import { checkWritable } from './lib/schemaGeneration';
import { clearTrustedSession, restoreTrustedSession } from './lib/crypto';
import { decryptText } from './lib/crypto';
import { getMasterAuth } from './lib/storage';
import { ErrorBoundary } from './components/ErrorBoundary';
import { isExtensionContext, mirrorStateToExtension, readExtensionCaptures, acknowledgeQuickNoteImported, markExtensionInboxImported, importExtensionAnnotations, readPendingNotes, acknowledgePendingNotes, type AnnotationSyncResult } from './lib/extensionBridge';
import { canCarryNewtabPreferences, readNewtabPreferences, writeNewtabPreferences, onNewtabPreferencesChanged, sameNewtabPreferences } from './lib/newtabPreferences';
import type { NewtabPreferences } from './types';
import { isFeatureEnabled } from './lib/features';
import { fetchWucaiHighlights } from './lib/wucaiClient';
import { Sidebar } from './components/Sidebar';
import { TopBar } from './components/TopBar';
import { ToastHost } from './shared/ui/toast';
import { InboxView } from './components/views/InboxView';
import { ProjectsView } from './components/views/ProjectsView';
import { RemindersView } from './components/views/RemindersView';
import { SitesView } from './components/views/SitesView';
import { GlobalSearch } from './components/GlobalSearch';
import type { SearchHit } from './domain/search';
import { MasterKeyModal } from './components/modals/MasterKeyModal';
import { OnboardingWizard } from './components/OnboardingWizard';
import { applyIntegrationValues } from './lib/integrations';
import { useCloudBackup } from './hooks/useCloudBackup';
import { useV3Backup } from './hooks/useV3Backup';
import { useReminderNotifications } from './hooks/useReminderNotifications';
import { useSiteActions } from './hooks/useSiteActions';
import { useServerActions } from './hooks/useServerActions';
import { useSecretActions, useCheckInActions } from './hooks/useSecretActions';
import { useReminderActions } from './hooks/useReminderActions';
import { useNoteActions, useProjectActions } from './hooks/useNoteActions';
import { useInboxActions } from './hooks/useInboxActions';
import { useBatchImport } from './hooks/useBatchImport';
import { useRoute } from './app/useRoute';
import { buildRoute, routeForLegacyTab } from './app/routes';
import { navLabelForRoute, navCountsFromState } from './app/navigation';
import { captureIntoInbox } from './domain/inbox';
import { mergeExtensionCaptures } from './domain/inbox';
import { migrateDomainReminders } from './domain/domains';
import { taskFromTemplate } from './domain/checkinSites';
import { HomeDashboard, type CaptureResult } from './features/home/HomeDashboard';
import { LibraryTabs } from './features/library/LibraryTabs';
import { ServersView } from './features/resources/ServersView';
import { DomainsView } from './features/resources/DomainsView';
import { AssetsView } from './features/resources/AssetsView';
import { anchorFromDate, parseDateInputValue } from './lib/dates';
import { VaultView } from './features/resources/VaultView';
import { CheckInsView } from './features/tools/CheckInsView';
import { DrawingView } from './features/tools/DrawingView';
import { NotFoundView } from './features/shell/NotFoundView';

/**
 * Deferred chunks (P1-10).
 * The first paint only needs the shell, the home page and the light list views.
 * The OSS file tree, the AI ingestion wizard, the entry form and the settings
 * · panel are all large and are all reachable only by an explicit click, so they
 */
const DataInteropView = React.lazy(() => import('./components/views/DataInteropView').then((m) => ({ default: m.DataInteropView })));
const AiIngestModal = React.lazy(() => import('./components/modals/AiIngestModal').then((m) => ({ default: m.AiIngestModal })));
const AddItemModal = React.lazy(() => import('./components/modals/AddItemModal').then((m) => ({ default: m.AddItemModal })));
const SettingsModal = React.lazy(() => import('./components/modals/SettingsModal'));
import { AnnotationsPane } from './features/library/AnnotationsPane';
const LibraryItemView = React.lazy(() => import('./features/library/LibraryItemView'));
import { NotesPane } from './features/library/NotesPane';

/** Loading placeholder that reserves space so the layout does not jump. */
function ChunkFallback({ label = '正在加载…' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-10 text-xs text-sh-muted" role="status">
      <Loader2 className="w-4 h-4 animate-spin" aria-hidden />
      {label}
    </div>
  );
}

/** Which settings pane a `#/settings/connections/:id` link should open. */
function sectionForConnection(id: string): 'ai' | 'content' | 'storage' {
  if (id === 'ai') return 'ai';
  if (id === 'wucai' || id === 'youdao') return 'content';
  return 'storage';
}

/**
 * Cross-tab signal that the **library** changed.
 *
 * In v3 mode the payload is device-only and usually byte-identical between writes, so
 * `localStorage` fires no storage event and a second tab would not notice. The value is
 * `<libraryId>#<revision>#<timestamp>` — no data, no secrets.
 */
const V3_ACTIVITY_KEY = 'selfhub_v3_activity';

export function App() {
  const { route, go, replace } = useRoute();
  const [state, setState] = useState<HubState>(() => migrateDomainReminders(loadHubState()));
  /**
   * Mirror of `state` for callbacks that must compute the *next* state and hand
   * it to storage synchronously (quick capture needs a truthful save result).
   */
  const stateRef = useRef(state);
  stateRef.current = state;

  /**
   * Which store is the fact source (P2 切库).
   *
   * `local` is the default and behaves exactly as before. In `v3` mode the IndexedDB
   * library is read at boot and written on every change — but the v2 payload is still
   * written too, so switching back is always possible (§13.4).
   */
  const [storageMode, setStorageMode] = useState<StorageMode>(() => readStorageMode());
  // Mirrors `storageMode` for stable callbacks (captureEntry) that must read the
  // current mode without being recreated on every change.
  const storageModeRef = useRef(storageMode);
  storageModeRef.current = storageMode;
  /**
   * False until the initial v3 read has finished.
   *
   * This guard is the whole safety of the switch: the save effect runs on mount with the
   * v2 state, and without it that stale payload would be written into the v3 library
   * *before* it is read — silently replacing the newer data with the older one.
   */
  const v3ReadyRef = useRef(readStorageMode() !== 'v3');
  const [v3Status, setV3Status] = useState<{
    counts?: Record<string, number>;
    error?: string;
    /** What the migration that switched this device wrote, shown in settings. */
    migration?: {
      stagingLibraryId: string;
      counts: number;
      warnings: string[];
      unknownFields: number;
      snapshotHash?: string;
    };
  }>({});
  const [v3WriteError, setV3WriteError] = useState<string | null>(null);
  const v3TimerRef = useRef<number | null>(null);
  /**
   * Transient global notice (clipboard results and other one-line feedback).
   * Clipboard writes used to fail silently or misreport as password errors; one
   * small toast covers every "did the thing actually happen" moment.
   */
  const [globalNotice, setGlobalNotice] = useState('');
  const globalNoticeTimerRef = useRef<number | null>(null);
  const flashNotice = useCallback((message: string) => {
    setGlobalNotice(message);
    if (globalNoticeTimerRef.current) window.clearTimeout(globalNoticeTimerRef.current);
    globalNoticeTimerRef.current = window.setTimeout(() => setGlobalNotice(''), 2600);
  }, []);
  useEffect(
    () => () => {
      if (globalNoticeTimerRef.current) window.clearTimeout(globalNoticeTimerRef.current);
    },
    []
  );
  /**
   * Which library the v3 side reads and writes.
   *
   * Not always `LOCAL_LIBRARY_ID`: the migration runner writes into a *staging* library and
   * then switches `activeLibraryId` to it in one durable write, so the app has to follow
   * whatever that pointer says (or it would read a library nobody writes to).
   */
  const [libraryId, setLibraryId] = useState<string>(LOCAL_LIBRARY_ID);

  // Collapse state persists across reloads; private-mode storage failures keep the default.
  const [sidebarCollapsed, setSidebarCollapsedState] = useState<boolean>(() => {
    try {
      return localStorage.getItem('selfhub_sidebar_collapsed') === '1';
    } catch {
      return false;
    }
  });
  const setSidebarCollapsed = (collapsed: boolean) => {
    setSidebarCollapsedState(collapsed);
    try {
      localStorage.setItem('selfhub_sidebar_collapsed', collapsed ? '1' : '0');
    } catch {}
  };
  const [masterPassword, setMasterPassword] = useState<string | null>(null);
  const [hasMasterAuth, setHasMasterAuth] = useState(() => Boolean(getMasterAuth()));
  const [persistError, setPersistError] = useState<string | null>(null);
  const [readOnlyNotice, setReadOnlyNotice] = useState<string | null>(null);
  const [externalChange, setExternalChange] = useState(false);
  const [focusNoteId, setFocusNoteId] = useState<string | null>(null);
  const clearFocusNoteId = useCallback(() => setFocusNoteId(null), []);
  const [focusVaultKey, setFocusVaultKey] = useState<string | null>(null);
  const clearFocusVaultKey = useCallback(() => setFocusVaultKey(null), []);

  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [isAiIngestOpen, setIsAiIngestOpen] = useState(false);
  const [isMasterKeyOpen, setIsMasterKeyOpen] = useState(false);
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  /**
   * Which type the create dialog opens on.
   *
   * `null` means "ask me" (the global 「+ 新建」); a page-level 添加服务器 / 添加凭据 passes its
   * own type so the dialog shows one focused form instead of five tabs.
   */
  const [addModalTypes, setAddModalTypes] = useState<Array<'site' | 'server' | 'secret' | 'checkin' | 'note'> | null>(
    null
  );
  /**
   * Bucket helpers shared by 远端笔记 and the settings card.
   *
   * `obsidianConfig` is the *active* bucket; switching one selects it, adding one appends a blank
   * entry. Keeping both call sites on the same handlers is what stops the tabs and the settings
   * card from disagreeing about which bucket is being edited.
   */
  const obsidianConnections = state.obsidianConnections ?? [state.obsidianConfig];
  const selectObsidianConnection = useCallback((id: string) => {
    updateState((prev) => {
      const list = prev.obsidianConnections?.length ? prev.obsidianConnections : [prev.obsidianConfig];
      const found = list.find((connection, index) => (connection.id || String(index)) === id);
      return found ? { ...prev, obsidianConfig: found } : prev;
    });
  }, []);
  const addObsidianConnection = useCallback(() => {
    updateState((prev) => {
      const list = prev.obsidianConnections?.length ? prev.obsidianConnections : [prev.obsidianConfig];
      const blank = {
        id: `oss-${Date.now()}`,
        label: `桶 ${list.length + 1}`,
        enabled: false,
        bucket: '',
        endpoint: '',
        region: '',
        accessKeyId: '',
        accessKeySecret: '',
        prefix: '',
        // A newly configured bucket is not automatically on the 远端笔记 tabs: the user picks it
        // there (「+ 桶」), which is what "加桶 = 选择已配置的桶" means.
        showInNotes: false
      };
      return { ...prev, obsidianConfig: blank, obsidianConnections: [...list, blank] };
    });
  }, []);
  /** Show a configured bucket in 远端笔记 (and make it the active connection). */
  const showObsidianBucket = useCallback((id: string) => {
    updateState((prev) => {
      const list = prev.obsidianConnections?.length ? prev.obsidianConnections : [prev.obsidianConfig];
      const found = list.find((connection, index) => (connection.id || String(index)) === id);
      if (!found) return prev;
      const next = { ...found, showInNotes: true };
      return {
        ...prev,
        obsidianConfig: next,
        obsidianConnections: list.map((connection) => (connection === found ? next : connection))
      };
    });
  }, []);
  /**
   * Remove a bucket's tab from 远端笔记 — the configuration stays.
   *
   * This is the counterpart of 「+ 桶」: hiding is about which buckets are on screen, deleting is a
   * settings action. If the hidden one was active, the first still-shown bucket takes over.
   */
  const hideObsidianBucket = useCallback((id: string) => {
    updateState((prev) => {
      const list = prev.obsidianConnections?.length ? prev.obsidianConnections : [prev.obsidianConfig];
      const target = list.find((connection, index) => (connection.id || String(index)) === id);
      if (!target) return prev;
      const nextList = list.map((connection) =>
        connection === target ? { ...connection, showInNotes: false } : connection
      );
      const wasActive = prev.obsidianConfig.id
        ? prev.obsidianConfig.id === target.id
        : prev.obsidianConfig.bucket === target.bucket && prev.obsidianConfig.endpoint === target.endpoint;
      const fallback = nextList.find((connection) => connection.showInNotes !== false);
      return {
        ...prev,
        obsidianConnections: nextList,
        obsidianConfig: wasActive && fallback ? fallback : prev.obsidianConfig
      };
    });
  }, []);
  /** Remove a bucket card by its card id (`oss` or `oss:<connection id>`). */
  const removeObsidianConnection = useCallback((cardId: string) => {
    updateState((prev) => {
      const list = prev.obsidianConnections?.length ? prev.obsidianConnections : [prev.obsidianConfig];
      if (list.length <= 1) return prev;
      const targetId = cardId.startsWith('oss:') ? cardId.slice(4) : null;
      const index = targetId ? list.findIndex((connection) => connection.id === targetId) : 0;
      if (index < 0) return prev;
      const nextList = list.filter((_, position) => position !== index);
      const wasActive = prev.obsidianConfig === list[index] || prev.obsidianConfig.id === list[index].id;
      return {
        ...prev,
        obsidianConnections: nextList,
        obsidianConfig: wasActive ? nextList[0] : prev.obsidianConfig
      };
    });
  }, []);

  const openAddModal = useCallback((type?: 'site' | 'server' | 'secret' | 'checkin' | 'note') => {
    setAddModalTypes(type ? [type] : null);
    setIsAddModalOpen(true);
  }, []);

  /**
   * Open a search hit. One handler for both the ⌘K dialog and the home page search box, so the
   * two cannot drift apart — a result that behaves differently depending on where it was found
   * is its own kind of confusion.
   */
  const openSearchHit = useCallback(
    (hit: SearchHit) => {
      setIsSearchOpen(false);
      switch (hit.kind) {
        case 'bookmark':
          window.open((hit.entity as { url: string }).url, '_blank', 'noopener,noreferrer');
          return;
        case 'server': {
          const server = hit.entity as ServerDeployment;
          const command = server.sshCommand || `ssh ${server.sshUser || 'root'}@${server.publicIp}`;
          navigator.clipboard
            .writeText(command)
            .then(() => flashNotice(`已复制 SSH 命令：${command.slice(0, 60)}`))
            .catch(() => flashNotice(`复制失败，请手动复制：${command}`));
          go(buildRoute('servers'));
          return;
        }
        case 'reminder': {
          const url = (hit.entity as ReminderItem).url;
          if (url) window.open(url, '_blank', 'noopener,noreferrer');
          else go(buildRoute('reminders'));
          return;
        }
        case 'project':
          go(buildRoute('project', { id: hit.id }));
          return;
        case 'inbox':
          go(buildRoute('inbox'));
          return;
        case 'note':
          setFocusNoteId(hit.id);
          go(buildRoute('library-item', { id: `note:${hit.id}` }));
          return;
        case 'annotation':
          go(buildRoute('library-item', { id: `webpage:${hit.id}` }));
          return;
        case 'drawing':
          go(buildRoute('library-item', { id: `drawing:${hit.id}` }));
          return;
        case 'remote':
        case 'vault':
          setFocusVaultKey(hit.id);
          go(`${buildRoute('library')}?view=sources`);
          return;
        default:
          go(buildRoute('library'));
      }
    },
    [go, flashNotice]
  );

  useEffect(() => {
    let cancelled = false;
    restoreTrustedSession().then((session) => {
      if (!cancelled && session.isValid && session.password) setMasterPassword(session.password);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useReminderNotifications(state.reminders);
  const { backupStatus, target: backupTarget, runStateBackup } = useCloudBackup(state);
  /**
   * v3 backup panel state (P2-05).
   *
   * The policy write-back goes through the same `updateState` the legacy switch
   * uses, so "which format" is one persisted preference and not a second source
   * of truth. Note that choosing v3 does **not** turn automatic backup on: the
   * format and the task switch stay separate, exactly like connections and tests.
   */
  /**
   * Late-bound state restore.
   *
   * `handleRestoreState` is defined further down (it needs `setState` and the
   * normaliser), so the hook receives a stable callback that reads the current
   * definition through this ref instead of a forward reference.
   */
  const restoreStateRef = useRef<(restored: HubState) => Promise<boolean | void> | boolean | void>(() => {});
  const v3Backup = useV3Backup(
    state,
    (policy) => updateState((prev) => ({ ...prev, backupPolicy: { ...policy } })),
    {
      lastBackupAt: backupStatus.lastAt,
      // §10.4.6: the merged library goes through the app's own write path so the
      // save guard, the IDB mirror and the rollback snapshot keep working. Fire-and-forget
      // is deliberate here: the v3 panel has already applied the restore and reports its own
      // result; this only brings the in-memory state in line.
      onRestoreState: (next) => {
        void restoreStateRef.current(next);
      },
      // Same recorder the settings cards use, so an imported credential's test
      // result is stored exactly like a normal "测试连接".
      onRecordConnectionTest: (id, record) =>
        updateState((prev) => ({
          ...prev,
          connectionTests: { ...(prev.connectionTests || {}), [id]: record }
        }))
    }
  );

  const counts = useMemo(() => navCountsFromState(state), [state]);

  /* ---------------------------------------------------------------------- */
  /* Onboarding (first run only)                                             */
  /* ---------------------------------------------------------------------- */
  const [showOnboarding, setShowOnboarding] = useState(false);
  useEffect(() => {
    if (localStorage.getItem('selfhub_onboarded')) return;
    const looksFresh =
      (state.sites?.length ?? 0) === 0 &&
      (state.servers?.length ?? 0) === 0 &&
      (state.secrets?.length ?? 0) === 0 &&
      (state.checkIns?.length ?? 0) === 0 &&
      (state.inbox?.length ?? 0) === 0 &&
      (state.projects?.length ?? 0) === 0 &&
      (state.notes?.length ?? 0) === 0;
    if (looksFresh) setShowOnboarding(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const dismissOnboarding = () => {
    try {
      localStorage.setItem('selfhub_onboarded', '1');
    } catch {
      /* private mode */
    }
    setShowOnboarding(false);
  };

  useEffect(() => {
    const isDark = (state.theme || 'dark') === 'dark';
    document.documentElement.classList.toggle('dark', isDark);
  }, [state.theme]);

  const handleToggleTheme = () => {
    updateState((prev) => ({ ...prev, theme: (prev.theme || 'dark') === 'dark' ? 'light' : 'dark' }));
  };

  // Pure state updates: persistence happens in the effect below, never inside the
  // setState updater (React may invoke an updater more than once, and writing to
  // storage during render is a side effect that can persist discarded state).
  const updateState = useCallback((updater: (prev: HubState) => HubState) => {
    setState((prev) => updater(prev));
  }, []);

  // Persist every committed state change and surface storage failures to the user.
  const persistResultRef = useRef<{ success: boolean; error?: string }>({ success: true });
  /**
   * "You are getting close to the localStorage limit" — said while everything still
   * works, not when a save finally fails. Reset when the payload shrinks again.
   */
  const [storageWarning, setStorageWarning] = useState<{ bytes: number; ratio: number } | null>(null);
  /** Payload size the user already dismissed the near-quota banner for. */
  const storageWarningDismissedRef = useRef<number>(0);
  useEffect(() => {
/**
 * In v3 mode only this device's configuration is written to the payload.
 * The library holds the business data, so writing it here too would keep the app at
 * the ~5 MB localStorage limit for no benefit — and would also make every save a
 */
    if (storageMode === 'v3' && !v3ReadyRef.current) {
/**
 * Before the boot-time library read finishes, the in-memory state is *not*
 * authoritative — it is whatever the payload held at load. Persisting it here used to
 * write the **whole library back into localStorage** on every boot in v3 mode (the
 * · `deviceOnly` guard was false at that moment), briefly re-inflating the payload to
 */
      return;
    }
    const deviceOnly = storageMode === 'v3';
    const result = saveHubState(state, { deviceOnly });
    persistResultRef.current = result;
    // P0-03: a refused write means a newer schema owns this origin. That is a
    // different problem from a quota error and needs a reload, not an export.
    if (result.readOnly) {
      setPersistError(null);
      setReadOnlyNotice(result.error || '本页版本较旧，已切换为只读。');
    } else {
      setReadOnlyNotice(null);
      setPersistError(result.success ? null : result.error || '保存失败');
    }
    if (result.success && result.nearQuota && result.bytes) {
      // Only re-warn when the payload actually grew past what the user dismissed.
      if (result.bytes > (storageWarningDismissedRef.current ?? 0)) {
        setStorageWarning({ bytes: result.bytes, ratio: result.bytes / STORAGE_CAP_BYTES });
      }
    } else if (storageWarning) {
      setStorageWarning(null);
    }
    mirrorStateToExtension(state);

    /**
     * Mirror into the v3 library (切库), debounced.
     *
     * Only after the boot-time read finished (`v3ReadyRef`), and only in v3 mode. The v2
     * write above is not skipped: it is the rollback copy, and keeping it costs one
     * synchronous localStorage write.
     */
    if (storageMode === 'v3' && v3ReadyRef.current) {
      if (v3TimerRef.current) window.clearTimeout(v3TimerRef.current);
      v3TimerRef.current = window.setTimeout(() => {
        void (async () => {
          try {
            const { writeLibrary } = await import('./repositories/hubStateAdapter');
            const written = await writeLibrary(stateRef.current, { libraryId });
            if (!written.ok) {
              // The data is safe in v2; say so instead of pretending the switch worked.
              setV3WriteError(
                `v3 库写入失败（本机 v2 负载已保存）：${written.error.userMessage}`
              );
            } else {
              setV3WriteError(null);
              setV3Status({ counts: written.value.counts });
              /**
               * Tell other tabs that the *library* changed.
               *
               * The payload they watch is device-only in v3 mode and usually byte-identical
               * between writes, so `localStorage` fires no event and a second tab would
               * silently miss that the library moved under it. This key carries the library
               * id, the new content revision and a timestamp — no data, no secrets.
               */
              try {
                localStorage.setItem(
                  V3_ACTIVITY_KEY,
                  `${libraryId}#${written.value.revision}#${Date.now()}`
                );
              } catch {
                /* storage unavailable: the write still succeeded, only the cross-tab notice is lost */
              }
            }
          } catch (err) {
            setV3WriteError(`v3 库写入失败（本机 v2 负载已保存）：${String(err)}`);
          }
        })();
      }, 800);
    }
    // Unmount cleanup: without this the debounce fired after the tab closed,
    // writing the library and calling setState on a dead component.
    return () => {
      if (v3TimerRef.current) window.clearTimeout(v3TimerRef.current);
    };
  }, [state, storageMode, libraryId]);

  useEffect(() => {
    const key = 'self_hub_data_v2';
    const onStorage = (e: StorageEvent) => {
      // Two signals, because in v3 mode the payload alone is not enough: it is device-only
      // and usually byte-identical between writes, so the library activity key is what tells
      // another tab that the data moved.
      if ((e.key === key || e.key === V3_ACTIVITY_KEY) && e.newValue) setExternalChange(true);
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  /**
   * Boot-time hydration in v3 mode.
   *
   * Runs before any v3 write is allowed (`v3ReadyRef`), so a stale v2 payload can never
   * overwrite the library it is about to be replaced by. An empty or unreadable library
   * keeps the v2 data and says why — "the switch silently emptied my app" is the failure
   * mode this is here to prevent.
   */
  useEffect(() => {
    if (storageMode !== 'v3') {
      if (v3TimerRef.current) window.clearTimeout(v3TimerRef.current);
      return;
    }
    let alive = true;
    void (async () => {
      try {
        const { readLibrary, mergeDeviceConfig } = await import('./repositories/hubStateAdapter');
        // Follow `activeLibraryId`: a migrated device reads the staging library, not the
        // pre-migration one. Read through the feature module, not the runner directly — see
        // the note in `switchStorageMode`.
        const { readActiveLibrary } = await import('./features/settings/storageMigration');
        const active = await readActiveLibrary();
        if (active) {
          setLibraryId(active);
        }
        const read = await readLibrary(active ?? LOCAL_LIBRARY_ID);
        if (!alive) return;
        if (!read.ok) {
          setV3Status({ error: read.error.userMessage });
          return;
        }
        const total = Object.values(read.value.counts).reduce((sum, count) => sum + count, 0);
        if (total > 0) {
          setState((prev) => migrateDomainReminders(mergeDeviceConfig(read.value.state, prev)));
        }
        setV3Status({ counts: read.value.counts });
        if (total === 0) {
          // The library looks empty (first boot after a failed switch, or IDB was cleared).
          // Do not silently show an empty app: restore the rollback copy if there is one.
          const rollback = readV2Rollback();
          if (rollback) {
            try {
              const restored = normalizeHubState(JSON.parse(rollback.json));
              saveHubState(restored);
              setState(restored);
              setV3WriteError(
                'v3 库是空的，已从切换前的 v2 快照恢复本机数据。请检查是否需要重新切换到 v3 库。'
              );
            } catch {
              setV3WriteError('v3 库是空的，且无法读取切换前的 v2 快照。');
            }
          } else {
            setV3WriteError('v3 库是空的，本次仍使用 v2 负载作为事实来源。');
          }
        }
      } catch (err) {
        if (alive) setV3Status({ error: String(err) });
      } finally {
        if (alive) v3ReadyRef.current = true;
      }
    })();
    return () => {
      alive = false;
    };
  }, [storageMode]);

/**
 * Switch the fact source (settings → 数据与备份 → 存储模式).
 * Going to v3 runs the **verified migration** (P2-02), not a raw copy: it writes an
 * encrypted snapshot of the sources first (§13.3), fills a staging library in batches
 * · with a checkpoint, verifies counts and links, and only then flips `activeLibraryId`
 */
  const switchingRef = useRef(false);
  const switchStorageModeInner = useCallback(
    async (mode: StorageMode, password?: string) => {
      if (mode === 'v3') {
        try {
          /**
           * Two-hop lazy import on purpose: when the entry chunk itself `await import()`s the
           * migration runner, Rollup folds that single-importer dynamic chunk into the entry
           * and the whole migration stack lands in the first load (~10 KB gzip, measured).
           * Going through a feature module gives the stack a lazy importer.
           */
          const { runMigrationAndSwitch } = await import('./features/settings/storageMigration');
          const outcome = await runMigrationAndSwitch(password ?? '');
          if (!outcome.ok) {
            return { ok: false, error: outcome.error };
          }
          // One-time rollback copy of the payload as it was *before* the switch. From now
          // on only device configuration is written there, so this is the copy "切回 v2"
          // can fall back to if the library ever becomes unreadable.
          const before = localStorage.getItem(getStorageKey());
          if (before) writeV2Rollback(before);
          setLibraryId(outcome.libraryId ?? LOCAL_LIBRARY_ID);
          writeStorageMode('v3');
          v3ReadyRef.current = true;
          setStorageMode('v3');
          setV3Status({
            counts: {},
            migration: {
              stagingLibraryId: outcome.report?.stagingLibraryId ?? '',
              counts: outcome.report?.counts.length ?? 0,
              warnings: outcome.report?.warnings.slice(0, 3) ?? [],
              unknownFields: outcome.report?.unknownFields.length ?? 0,
              snapshotHash: outcome.snapshotHash
            }
          });
          setV3WriteError(null);
          return { ok: true };
        } catch (err) {
          return { ok: false, error: String(err) };
        }
      }

      try {
        const { readLibrary, mergeDeviceConfig } = await import('./repositories/hubStateAdapter');
        const read = await readLibrary(libraryId);
        if (!read.ok) return { ok: false, error: read.error.userMessage };
        const total = Object.values(read.value.counts).reduce((sum, count) => sum + count, 0);
        const materialised = total > 0 ? mergeDeviceConfig(read.value.state, stateRef.current) : stateRef.current;
        const write = saveHubState(materialised);
        if (!write.success) {
          return { ok: false, error: write.error ?? '无法把库写回本机负载' };
        }
        writeStorageMode('local');
        v3ReadyRef.current = false;
        setStorageMode('local');
        setState(materialised);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    },
    [libraryId]
  );

  /**
   * Re-entrancy gate around `switchStorageModeInner`.
   *
   * Defined after the inner callback so `useCallback`'s dependency is a real value rather
   * than a forward reference.
   */
  const switchStorageMode = useCallback(
    async (mode: StorageMode, password?: string) => {
      if (switchingRef.current) {
        return { ok: false, error: '正在切换中，请等待当前操作完成。' };
      }
      switchingRef.current = true;
      try {
        return await switchStorageModeInner(mode, password);
      } finally {
        switchingRef.current = false;
      }
    },
    [switchStorageModeInner]
  );

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      // Never steal the shortcut from an editor or a text field.
      const typing =
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable === true);
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        // 在输入框里也不再失效：首页两个输入框曾经吞掉 Ctrl+K，鼠标用户
        // 在首页就够不到全局检索。打开时顺手全选已有内容，连续检索不摩擦。
        e.preventDefault();
        if (typing && target instanceof HTMLElement) {
          const input = target as HTMLInputElement;
          input.select?.();
        }
        setIsSearchOpen((prev) => !prev);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // View-switch transition: reset the *real* scroll container (the flex shell,
  // not window — window.scrollTo here was always a no-op) and crossfade the
  // content in. Deliberately **opacity-only, zero movement**: translating the
  // whole content area reads as jank on heavy views, and macOS view switches
  // are a bare fade. Driven by WAAPI instead of class toggling so restarting
  // needs no forced synchronous reflow (offsetWidth) — that reflow alone was
  // a tens-of-ms hitch on big pages. Query-only changes (filters, tabs) do
  // not replay and do not jump, so returning to a filtered list keeps its place.
  const scrollShellRef = useRef<HTMLDivElement>(null);
  const viewKey = `${route.name}:${route.query.view ?? ''}:${route.query.type ?? ''}`;
  const prevViewKeyRef = useRef('');
  useEffect(() => {
    if (prevViewKeyRef.current === viewKey) return;
    prevViewKeyRef.current = viewKey;
    if (scrollShellRef.current) scrollShellRef.current.scrollTop = 0;
    const main = document.getElementById('main');
    if (!main || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    main.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: 180,
      easing: 'cubic-bezier(0.2, 0, 0, 1)'
    });
  }, [viewKey]);

  /* ---------------------------------------------------------------------- */
  /* Domain actions                                                          */
  /* ---------------------------------------------------------------------- */
  const { addSite, deleteSite, visitSite, importBookmarks } = useSiteActions(updateState);
  const { addServer, deleteServer, checkServer, checkAllServers } = useServerActions(state, updateState);
  const { addSecret, deleteSecret } = useSecretActions(updateState);
  const { addCheckIn, deleteCheckIn, runCheckIn } = useCheckInActions(state, updateState);
  const { addReminder, deleteReminder, updateReminder, toggleReminderComplete, renewReminder } = useReminderActions(updateState);
  const { addNote, updateNote, deleteNote, saveHandwriting, deleteHandwriting } = useNoteActions(updateState);
  const { addProject, updateProject, deleteProject } = useProjectActions(updateState);
  const { addInboxItem, updateInboxItem, deleteInboxItem, convertToNote, convertToSite, assignToProject, previewBatch, convertMany } =
    useInboxActions(state, updateState, { addNote, addSite });

/**
 * Bring across captures the extension made on its own (new-tab 「记一笔」, the
 * popup, and right-click 「保存至统一收件箱」).
 * Those all write the extension's own v3 inbox, which lives in a *different*
 */
  const runCaptureImport = useCallback(async () => {
    if (!isExtensionContext()) return;
    // Same v3 guard as the annotation/wucai imports: without it this merge runs
    // before the boot-time library read, the captured entries are merged into
    // the in-memory v2 state, and the finished hydration then overwrites `inbox`
    // with the library's copy — the capture silently disappears from both ends.
    if (storageMode === 'v3' && !v3ReadyRef.current) return;
    const batch = await readExtensionCaptures();
    if (batch.captures.length === 0) return;
    const current = stateRef.current;
    const { items, imported, quickNoteImported } = mergeExtensionCaptures(current.inbox, batch.captures);
    if (imported > 0) {
      const next: HubState = { ...current, inbox: items };
      stateRef.current = next;
      setState(next);
      if (quickNoteImported) await acknowledgeQuickNoteImported();
    }
    await markExtensionInboxImported(batch.inboxIds);
  }, [storageMode, v3Status]);

  const extensionImportedRef = useRef(false);
  useEffect(() => {
    if (extensionImportedRef.current || !isExtensionContext()) return;
    if (storageMode === 'v3' && !v3ReadyRef.current) return;
    extensionImportedRef.current = true;
    void runCaptureImport();
  }, [storageMode, v3Status, runCaptureImport]);

/**
 * Live capture import while the workbench stays open.
 * The boot pass runs once, so a capture made *after* the workbench tab was
 * opened stayed invisible until a full reload — which is exactly when a user
 */
  useEffect(() => {
    if (!isExtensionContext()) return;
    const chromeApi = (
      globalThis as unknown as {
        chrome?: {
          runtime?: {
            onMessage?: {
              addListener?: (cb: (msg: unknown) => void) => void;
              removeListener?: (cb: (msg: unknown) => void) => void;
            };
          };
        };
      }
    ).chrome;
    const onBroadcast = (msg: unknown) => {
      const event = msg as { type?: string; kind?: string; stores?: string[] };
      if (event?.type !== 'SELFHUB_CHANGED') return;
      if (event.kind !== 'capture' && !(event.stores || []).includes('inbox_v3')) return;
      void runCaptureImport();
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') void runCaptureImport();
    };
    chromeApi?.runtime?.onMessage?.addListener?.(onBroadcast);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      chromeApi?.runtime?.onMessage?.removeListener?.(onBroadcast);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, [runCaptureImport]);

  /**
   * Notes typed in the new tab's 「文本框」 module.
   *
   * The new tab must not write the library itself (the app is its only writer),
   * so it appends to a queue in `chrome.storage.local`. Draining it here keeps
   * one writer, and `storage.onChanged` makes it live — the workbench is usually
   * open in another tab while the user writes on the new tab.
   */
  const pendingNotesImportedRef = useRef(false);
  const runPendingNoteImport = useCallback(async () => {
    if (!isExtensionContext()) return;
    if (storageMode === 'v3' && !v3ReadyRef.current) return;
    const queued = await readPendingNotes();
    if (!queued.length) return;
    const current = stateRef.current;
    const existing = new Set((current.notes ?? []).map((note) => note.id));
    const fresh = queued
      .filter((note) => !existing.has(note.id))
      .map((note) => ({
        id: note.id,
        title: note.title || '新标签页笔记',
        content: note.content,
        folder: note.folder,
        tags: [] as string[],
        updatedAt: note.updatedAt || Date.now()
      }));
    if (fresh.length) {
      const next: HubState = { ...current, notes: [...fresh, ...(current.notes ?? [])] };
      stateRef.current = next;
      setState(next);
    }
    await acknowledgePendingNotes(queued.map((note) => note.id));
  }, [storageMode, v3Status]);

  useEffect(() => {
    if (!isExtensionContext()) return;
    if (storageMode === 'v3' && !v3ReadyRef.current) return;
    if (!pendingNotesImportedRef.current) {
      pendingNotesImportedRef.current = true;
      void runPendingNoteImport();
    }
    const chromeApi = (
      globalThis as unknown as {
        chrome?: {
          storage?: {
            onChanged?: {
              addListener?: (cb: (changes: Record<string, unknown>, area: string) => void) => void;
              removeListener?: (cb: (changes: Record<string, unknown>, area: string) => void) => void;
            };
          };
        };
      }
    ).chrome;
    const onChanged = (changes: Record<string, unknown>, area: string) => {
      if (area !== 'local' || !changes?.selfhub_pending_notes) return;
      void runPendingNoteImport();
    };
    chromeApi?.storage?.onChanged?.addListener?.(onChanged);
    return () => chromeApi?.storage?.onChanged?.removeListener?.(onChanged);
  }, [storageMode, v3Status, runPendingNoteImport]);

/**
 * Import highlights the extension's content script saved (划词 → background →
 * chrome.storage). `importExtensionAnnotations` existed but was never wired to
 * anything, so the 网页批注 pane stayed empty even with highlights in the store.
 * · Import-only, like every other cross-store move here: ids the app already has
 */
  const extensionAnnotationsImportedRef = useRef(false);
  /** Import-only merge of extension-collected highlights into the app library. */
  const runAnnotationImport = useCallback(async (): Promise<{ imported: number; extensionCount: number; dropped: number }> => {
    const knownIds = new Set((stateRef.current.annotations ?? []).map((a) => a.id));
    const { rows, totalCount, dropped } = await importExtensionAnnotations(knownIds);
    if (rows.length > 0) {
      updateState((prev) => {
        const byId = new Map((prev.annotations ?? []).map((a) => [a.id, a]));
        for (const row of rows) {
          if (byId.has(row.id)) continue;
          byId.set(row.id, {
            id: row.id,
            pageUrl: row.pageUrl || '',
            pageTitle: row.pageTitle || row.pageUrl || '未命名页面',
            text: row.text,
            note: row.note ?? '',
            color: (row.color as WebPageAnnotation['color']) || 'yellow',
            tags: [],
            anchor: row.anchor as WebPageAnnotation['anchor'],
            createdAt: row.createdAt ?? Date.now(),
            updatedAt: row.updatedAt ?? row.createdAt ?? Date.now()
          });
        }
        return { ...prev, annotations: Array.from(byId.values()) };
      });
    }
    return { imported: rows.length, extensionCount: totalCount, dropped };
  }, [updateState]);

/**
 * The pane's manual 「从扩展同步」 button.
 * The automatic paths (boot import, broadcast listener, visibility re-import)
 * cover the happy path; this is the diagnostic path for when none of them seem
 */
  const handleSyncAnnotations = useCallback(async (): Promise<AnnotationSyncResult> => {
    if (!isExtensionContext()) {
      return {
        ok: false,
        message: '当前页面不是扩展内的工作台，读不到扩展里保存的批注。请从扩展打开工作台（新标签页里的「打开工作台」，或扩展管理页的详情页入口）。'
      };
    }
    try {
      const { imported, extensionCount, dropped } = await runAnnotationImport();
      if (extensionCount < 0) {
        return {
          ok: false,
          message: '扩展没有响应这次同步。多半是浏览器里跑的还是旧版本扩展——去 chrome://extensions 点一下本扩展的「重新加载」，再回来重试。'
        };
      }
      if (extensionCount === 0) {
        return {
          ok: true,
          extensionCount,
          imported,
          message: '扩展已连通，但里面还没有保存过任何批注。去任意网页划词保存一条，再回来看。'
        };
      }
      if (imported === 0) {
        const appCount = (stateRef.current.annotations ?? []).length;
        if (dropped > 0) {
          return {
            ok: false,
            extensionCount,
            imported,
            message: `扩展已连通，共 ${extensionCount} 条批注，但其中 ${dropped} 条缺少 id/text 字段被跳过（多半是旧版本写入的数据）——请把这条提示反馈给开发者。`
          };
        }
        if (appCount === 0) {
          return {
            ok: false,
            extensionCount,
            imported,
            message: `扩展已连通，扩展侧有 ${extensionCount} 条批注，但工作台列表仍为空——异常状态，请把这条提示反馈给开发者。`
          };
        }
        return {
          ok: true,
          extensionCount,
          imported,
          message: `扩展已连通：扩展侧共 ${extensionCount} 条批注，工作台已全部持有（列表 ${appCount} 条）。`
        };
      }
      return {
        ok: true,
        extensionCount,
        imported,
        message: `扩展已连通：从扩展导入了 ${imported} 条批注（扩展侧共 ${extensionCount} 条）。`
      };
    } catch (err) {
      return { ok: false, message: `同步失败：${(err as Error)?.message || err}` };
    }
  }, [runAnnotationImport]);

  useEffect(() => {
    if (extensionAnnotationsImportedRef.current || !isExtensionContext()) return;
    if (storageMode === 'v3' && !v3ReadyRef.current) return;
    extensionAnnotationsImportedRef.current = true;
    void runAnnotationImport();
  }, [storageMode, v3Status, runAnnotationImport]);

/**
 * Live import while the workbench stays open.
 * The boot import above runs once, so a highlight saved *after* the app tab was
 * open never arrived — the user highlights on a page, sees "已保存", and the
 */
  useEffect(() => {
    if (!isExtensionContext()) return;
    const chromeApi = (globalThis as unknown as {
      chrome?: {
        runtime?: {
          onMessage?: {
            addListener?: (cb: (msg: unknown) => void) => void;
            removeListener?: (cb: (msg: unknown) => void) => void;
          };
        };
      };
    }).chrome;
    const onBroadcast = (msg: unknown) => {
      const event = msg as { type?: string; kind?: string; stores?: string[] };
      if (event?.type !== 'SELFHUB_CHANGED') return;
      if (event.kind !== 'annotation-saved' && !(event.stores || []).includes('annotations_v3')) return;
      void runAnnotationImport();
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') void runAnnotationImport();
    };
    chromeApi?.runtime?.onMessage?.addListener?.(onBroadcast);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      chromeApi?.runtime?.onMessage?.removeListener?.(onBroadcast);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, [runAnnotationImport]);

/**
 * Pull highlights from the Wucai OpenAPI on boot.
 * `fetchWucaiHighlights` existed but had no caller, so a configured token never
 * did anything: the 划词 pane only ever held manually added rows. Import-only,
 * · HTTPS), but only when the 五彩 switch and its token are both on. A failed
 */
  const wucaiSyncedRef = useRef(false);
  useEffect(() => {
    if (wucaiSyncedRef.current) return;
    if (storageMode === 'v3' && !v3ReadyRef.current) return;
    const current = stateRef.current;
    if (!isFeatureEnabled(current.features, 'wucai')) return;
    const config = current.wucaiConfig;
    if (!config?.enabled || !config.token) return;
    wucaiSyncedRef.current = true;
    void (async () => {
      const knownIds = new Set((current.wucaiHighlights ?? []).map((h) => h.id));
      try {
        const fresh = await fetchWucaiHighlights(config, knownIds);
        if (fresh.length === 0) return;
        updateState((prev) => {
          const byId = new Map((prev.wucaiHighlights ?? []).map((h) => [h.id, h]));
          for (const row of fresh) byId.set(row.id, row);
          return {
            ...prev,
            wucaiHighlights: Array.from(byId.values()),
            wucaiConfig: { ...(prev.wucaiConfig || config), lastSyncTime: Date.now() }
          };
        });
      } catch (err) {
        console.warn('[Self-Hub] wucai highlight sync failed', err);
      }
    })();
  }, [storageMode, v3Status, updateState]);
  const batchImport = useBatchImport(updateState);

/**
 * Carry the new-tab layout into the hub state so that backups include it.
 * The new tab is a separate extension page and is the only writer of
 * `selfhub_newtab_layout` / `selfhub_newtab_pins`. The workbench merely records what is
 * · file export or v3 batch carries the dashboard the user arranged. It never writes back
 */
  useEffect(() => {
    if (!canCarryNewtabPreferences()) return;
    let cancelled = false;
    const adopt = (prefs: NewtabPreferences | null) => {
      if (cancelled || !prefs) return;
      updateState((prev) =>
        sameNewtabPreferences(prev.newtabPreferences, prefs) ? prev : { ...prev, newtabPreferences: prefs }
      );
    };
    void readNewtabPreferences().then(adopt);
    const stop = onNewtabPreferencesChanged(adopt);
    return () => {
      cancelled = true;
      stop();
    };
  }, [storageMode, v3Status, updateState]);

  const handleLockVault = () => {
    setMasterPassword(null);
    void clearTrustedSession();
  };

/**
 * Apply a restored state (legacy import, encrypted import, rollback, v3 batch restore).
 * In v3 mode the payload holds only device configuration, so writing the restored data
 * there would look exactly like "the restore did nothing": the app reads the library, and
 * · path: a package must never replace this machine's keys with whatever it carries.
 */
  const handleRestoreState = async (restored: HubState): Promise<boolean | void> => {
    const next = normalizeHubState(restored);
/**
 * Push the new-tab layout back into `chrome.storage.local`.
 * This is the only place the workbench writes those keys, and it is deliberate: a
 * restore is the one moment the state legitimately knows better than the device's
 * · failed write must not turn a successful data restore into an error.
 */
    if (next.newtabPreferences) void writeNewtabPreferences(next.newtabPreferences);
    if (storageMode !== 'v3') {
      setState(next);
      return undefined;
    }
    try {
      const { writeLibrary, mergeDeviceConfig } = await import('./repositories/hubStateAdapter');
      const merged = mergeDeviceConfig(next, stateRef.current);
      const written = await writeLibrary(merged, { libraryId });
      if (!written.ok) {
        setV3WriteError(`恢复的数据没有写入 v3 库，本机内容未改变：${written.error.userMessage}`);
        return false;
      }
      setV3WriteError(null);
      setState(merged);
      return true;
    } catch (err) {
      setV3WriteError(`恢复的数据没有写入 v3 库，本机内容未改变：${String(err)}`);
      return false;
    }
  };
  // Fill in the late-bound reference used by the v3 restore flow above.
  restoreStateRef.current = handleRestoreState;

  /**
   * Quick capture (P1-03).
   *
   * Writes through `saveHubState` here and returns its real result, so the home
   * page can say "已保存" only when the local write actually completed. An
   * optimistic message followed by a failed effect write is exactly the
   * dishonesty the redesign is meant to remove.
   */
  const captureEntry = useCallback((raw: string, source: InboxItem['source']): CaptureResult => {
    const current = stateRef.current;
    const { items, entry, created } = captureIntoInbox(current.inbox, raw, { source });
    if (!created) return { ok: true, id: entry.id, created: false };
    const next: HubState = { ...current, inbox: items };
    stateRef.current = next;
    setState(next);
    // v3 mode keeps the library in IndexedDB; writing the whole state back into
    // localStorage here re-inflates the payload to megabytes and reports a
    // quota failure for a save that actually succeeds (see the save effect's
    // deviceOnly note). Device config only, exactly like the save effect.
    const deviceOnly = storageModeRef.current === 'v3' && v3ReadyRef.current;
    const result = saveHubState(next, { deviceOnly });
    return { ok: result.success, error: result.error, readOnly: result.readOnly, id: entry.id, created: true };
  }, []);

  /* ---------------------------------------------------------------------- */
  /* Legacy tab links → routes                                               */
  /* ---------------------------------------------------------------------- */
  useEffect(() => {
    const hash = window.location.hash.replace(/^#/, '');
    // An old `#dashboard` / `#notes` bookmark has no leading slash: map it once.
    if (hash && !hash.startsWith('/')) {
      const path = routeForLegacyTab(hash.split('?')[0]);
      replace(path);
    }
  }, [replace]);

  const isPageSettings = route.name === 'settings' || route.name === 'settings-connection';

  const settingsSection = useMemo(() => {
    if (route.name === 'settings-connection') return sectionForConnection(route.params.id);
    return (route.params.section as never) || 'overview';
  }, [route]);

  /* ---------------------------------------------------------------------- */
  /* Render                                                                  */
  /* ---------------------------------------------------------------------- */
  return (
    <div
      className="flex h-screen overflow-hidden bg-sh-bg text-sh-fg font-sans"
      data-write-mode={readOnlyNotice ? 'read-only' : 'writable'}
    >
      {/* 真·跳转：把焦点交给 main（href 写 #/home 只会回到首页，焦点一步也没省）。 */}
      <a
        href="#main"
        className="sh-skip-link"
        onClick={(e) => {
          e.preventDefault();
          document.getElementById('main')?.focus();
        }}
      >
        跳到主要内容
      </a>

      <Sidebar
        routeName={route.name}
        routeView={route.query.view}
        routeType={route.query.type}
        onNavigate={go}
        collapsed={sidebarCollapsed}
        setCollapsed={setSidebarCollapsed}
        isUnlocked={Boolean(masterPassword)}
        onLockVault={handleLockVault}
        onOpenMasterKeyModal={() => setIsMasterKeyOpen(true)}
        features={state.features}
        inboxCount={counts.inbox || 0}
        reminderCount={counts.reminders || 0}
      />

      <div ref={scrollShellRef} className="flex-1 flex flex-col min-w-0 overflow-y-auto">
        <TopBar
          routeName={route.name}
          title={navLabelForRoute(route.name, route.query.view, route.query.type)}
          onNavigate={go}
          theme={state.theme || 'dark'}
          onToggleTheme={handleToggleTheme}
          onOpenSearch={() => setIsSearchOpen(true)}
          onOpenAiIngest={() => setIsAiIngestOpen(true)}
          onOpenAddModal={() => openAddModal()}
          onOpenMasterKeyModal={() => setIsMasterKeyOpen(true)}
          isUnlocked={Boolean(masterPassword)}
          onLockVault={handleLockVault}
          features={state.features}
          inboxCount={counts.inbox || 0}
        />

        <main id="main" tabIndex={-1} className="flex-1 p-3 sm:p-5 max-w-[1400px] w-full mx-auto focus:outline-none">
          {readOnlyNotice && (
            <div
              className="mb-4 flex items-start gap-2.5 rounded-2xl border border-sh-warn/50 bg-sh-warn/10 p-3.5 text-xs text-sh-warn"
              data-testid="schema-readonly-banner"
              role="alert"
            >
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden />
              <div className="flex-1 leading-relaxed">
                <div className="font-semibold">本页版本较旧，已切换为只读</div>
                <div className="mt-0.5">{readOnlyNotice}</div>
              </div>
              <button
                onClick={() => window.location.reload()}
                className="shrink-0 rounded-lg border border-sh-warn/50 px-2.5 py-1 font-medium inline-flex items-center gap-1"
              >
                <RefreshCw className="w-3 h-3" aria-hidden />
                重新加载
              </button>
            </div>
          )}

          {v3WriteError && (
            <div
              className="mb-4 flex items-start gap-2.5 rounded-2xl border border-sh-warn/50 bg-sh-warn/10 p-3.5 text-xs text-sh-warn"
              data-testid="v3-write-error"
              role="status"
            >
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden />
              <div className="flex-1 leading-relaxed">
                <div className="font-semibold">v3 库没有同步成功</div>
                <div className="mt-0.5">{v3WriteError}</div>
              </div>
              <button onClick={() => setV3WriteError(null)} className="shrink-0 p-1" aria-label="忽略">
                <X className="w-3.5 h-3.5" aria-hidden />
              </button>
            </div>
          )}

          {persistError && (
            <div
              className="mb-4 flex flex-wrap items-start gap-2.5 rounded-2xl border border-sh-danger/50 bg-sh-danger/10 p-3.5 text-xs text-sh-danger"
              data-testid="persist-error-banner"
              role="alert"
            >
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden />
              <div className="flex-1 leading-relaxed">
                <div className="font-semibold">数据未能写入本机存储</div>
                <div className="mt-0.5">{persistError}</div>
                {/* The 5 MB payload ceiling is the usual cause. Switching the storage mode moves
                    the business data into IndexedDB, which is the actual fix (not "export and hope"). */}
                <div className="mt-1.5 text-sh-fg/80">
                  常见原因：v2 整包负载接近浏览器约 5 MB 的上限。切到 v3 库后，资料存进 IndexedDB，这个上限不再约束。
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <button
                  onClick={() => go(buildRoute('settings', { section: 'storage' }))}
                  data-testid="persist-error-switch-v3"
                  className="rounded-lg border border-sh-danger/50 bg-sh-danger/10 px-2.5 py-1 font-semibold"
                >
                  切换到 v3 库
                </button>
                <button
                  onClick={() => go(buildRoute('settings', { section: 'data' }))}
                  className="rounded-lg border border-sh-danger/50 px-2.5 py-1 font-medium"
                >
                  先导出备份
                </button>
              </div>
            </div>
          )}

          {/* Warn while saving still works: the localStorage ceiling is ~5 MB and the
              old behaviour was to say nothing until a write failed. */}
          {storageWarning && !persistError && (
            <div
              className="mb-4 flex items-start gap-2.5 rounded-2xl border border-sh-warn/50 bg-sh-warn/10 p-3.5 text-xs text-sh-warn"
              data-testid="storage-near-quota-banner"
              role="status"
            >
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden />
              <div className="flex-1 leading-relaxed">
                <div className="font-semibold">本机数据快接近浏览器上限</div>
                <div className="mt-0.5">
                  已用 {(storageWarning.bytes / 1024 / 1024).toFixed(2)} MB，约占{' '}
                  {Math.round(storageWarning.ratio * 100)}%（浏览器通常约 5 MB）。再增长可能导致保存失败：
                  建议先导出备份，再删除不再需要的手绘或大笔记。
                </div>
              </div>
              <button
                onClick={() => go(buildRoute('settings', { section: 'data' }))}
                className="shrink-0 rounded-lg border border-sh-warn/50 px-2.5 py-1 font-medium"
              >
                去导出备份
              </button>
              <button
                onClick={() => {
                  // Remember which size was dismissed: without this the effect
                  // re-raises the banner on the very next save, so "忽略" only
                  // lasted until the next keystroke.
                  storageWarningDismissedRef.current = storageWarning.bytes;
                  setStorageWarning(null);
                }}
                className="shrink-0 p-1"
                aria-label="忽略容量提醒"
              >
                <X className="w-3.5 h-3.5" aria-hidden />
              </button>
            </div>
          )}

          {externalChange && (
            <div
              className="mb-4 flex items-start gap-2.5 rounded-2xl border border-sh-warn/50 bg-sh-warn/10 p-3.5 text-xs text-sh-warn"
              data-testid="external-change-banner"
              role="status"
            >
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden />
              <div className="flex-1 leading-relaxed">
                <div className="font-semibold">另一个标签页修改了同一份数据</div>
                <div className="mt-0.5">继续在当前页面编辑会用这里的版本覆盖对方。建议先重新加载，采用最新版本。</div>
              </div>
              <button
                onClick={() => window.location.reload()}
                className="shrink-0 rounded-lg border border-sh-warn/50 px-2.5 py-1 font-medium inline-flex items-center gap-1"
              >
                <RefreshCw className="w-3 h-3" aria-hidden />
                重新加载
              </button>
              <button onClick={() => setExternalChange(false)} className="shrink-0 p-1" aria-label="忽略">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

          <ErrorBoundary scope={route.name} key={route.name}>
            {route.name === 'home' && (
              <HomeDashboard
                state={state}
                onNavigate={go}
                onVisitSite={visitSite}
                onCapture={captureEntry}
                onCaptureSite={(raw) => {
                  // 先入收件箱留原始记录，再立即转为书签。
                  const result = captureEntry(raw, 'home');
                  if (!result.ok || !result.id) return result;
                  // captureEntry 已经 updateState，但本闭包里的 state 还是旧渲染
                  // 快照——从 stateRef 取最新值才能找到刚生成的条目。
                  const entry = stateRef.current.inbox?.find((item) => item.id === result.id);
                  if (!entry) return result;
                  const converted = convertToSite(entry);
                  return converted.ok ? { ok: true, message: '已存为网站' } : result;
                }}
                onOpenAddModal={(type) => openAddModal(type)}
                onOpenSearchHit={openSearchHit}
                backupStatus={backupStatus}
                vaultUnlocked={Boolean(hasMasterAuth && masterPassword)}
                onRequireUnlock={() => setIsMasterKeyOpen(true)}
                onToggleReminderComplete={toggleReminderComplete}
                onRenewReminder={renewReminder}
                onRunCheckIn={(id) => runCheckIn(id, 'mark_done')}
                onCheckAllServers={() => void checkAllServers()}
              />
            )}

            {route.name === 'navigation' && (
              <SitesView
                sites={state.sites}
                categories={state.categories}
                onVisit={visitSite}
                onDelete={deleteSite}
                onOpenAddModal={(type) => openAddModal(type)}
                onImportBookmarks={importBookmarks}
                onPasteRecognized={{
                  aiConfig: state.aiConfig,
                  onAddSites: (sites) => importBookmarks([...(state.sites ?? []), ...sites]),
                  onCaptureInbox: (raw) => captureEntry(raw, 'home'),
                  onAddNote: (note) => updateState((prev) => ({ ...prev, notes: [note, ...(prev.notes ?? [])] }))
                }}
              />
            )}

            {route.name === 'inbox' && (
              <InboxView
                inbox={state.inbox || []}
                onAddInboxItem={addInboxItem}
                onUpdateInboxItem={updateInboxItem}
                onDeleteInboxItem={deleteInboxItem}
                onConvertToNote={convertToNote}
                onConvertToSite={convertToSite}
                projects={state.projects || []}
                onAssignToProject={assignToProject}
                onPreviewBatch={previewBatch}
                onConvertMany={convertMany}
                onOpenTarget={(type, id) => {
                  if (type === 'note') go(buildRoute('library-item', { id: `note:${id}` }));
                  else if (type === 'site') go(buildRoute('navigation'));
                  else go(buildRoute('project', { id }));
                }}
              />
            )}

            {route.name === 'library' && route.query.view === 'sources' && (
              <Suspense fallback={<ChunkFallback label="正在加载远端笔记库…" />}>
                <div data-testid="library-sources">
                  <LibraryTabs active="sources" onNavigate={go} />
                  <DataInteropView
                    features={state.features}
                    obsidianConfig={state.obsidianConfig}
                    obsidianNotes={state.obsidianNotes || []}
                    obsidianConnections={obsidianConnections}
                    onUpdateObsidianConfig={(config) =>
                      updateState((prev) => {
                        /**
                         * `obsidianConfig` stays the *active* connection (the tree, the backup and
                         * the library adapter all read it). The list is what the tabs are drawn
                         * from, so a save has to update both: switch-and-edit is the same gesture.
                         */
                        const list =
                          prev.obsidianConnections && prev.obsidianConnections.length > 0
                            ? prev.obsidianConnections
                            : [prev.obsidianConfig];
                        const index = list.findIndex((entry) =>
                          config.id ? entry.id === config.id : entry.bucket === config.bucket && entry.endpoint === config.endpoint
                        );
                        const nextList =
                          index >= 0
                            ? list.map((entry, position) => (position === index ? { ...entry, ...config } : entry))
                            : [...list, config];
                        return { ...prev, obsidianConfig: config, obsidianConnections: nextList };
                      })
                    }
                    onAddObsidianConnection={addObsidianConnection}
                    onSelectBucket={showObsidianBucket}
                    onHideBucket={hideObsidianBucket}
                    onUpdateObsidianNotes={(notes) => updateState((prev) => ({ ...prev, obsidianNotes: notes }))}
                    wucaiConfig={state.wucaiConfig || { enabled: false, token: '' }}
                    wucaiHighlights={state.wucaiHighlights || []}
                    onUpdateWucaiHighlights={(hl) => updateState((prev) => ({ ...prev, wucaiHighlights: hl }))}
                    youdaoConfig={state.youdaoConfig || { enabled: false, token: '' }}
                    youdaoNotes={state.youdaoNotes || []}
                    onUpdateYoudaoNotes={(yd) => updateState((prev) => ({ ...prev, youdaoNotes: yd }))}
                    onAddQuickNote={addNote}
                    /* 数据 is 数据, 配置 is 配置: a "configure this connection" link belongs on the
                       connections pane, not on 数据与备份 (that pane is about where backups go). */
                    onOpenSettings={() => go(buildRoute('settings', { section: 'connections' }))}
                    focusVaultKey={focusVaultKey}
                    onFocusHandled={clearFocusVaultKey}
                  />
                </div>
              </Suspense>
            )}

            {/*
              网页批注 pane. 全部资料 is gone: a mixed list of every collection was the main
              source of "which page am I on". Each collection now has its own pane, and this one
              is the annotation showcase the user asked for (read, edit, delete, open source).
            */}
            {route.name === 'library' && route.query.type === 'webpage' && (
              <Suspense fallback={<ChunkFallback label="正在加载网页批注…" />}>
                <div data-testid="library-annotations">
                  <LibraryTabs active="annotations" onNavigate={go} />
                  {state.features?.annotations === false ? (
                    /* The switch is off: the entry is hidden from the nav, and the pane says so
                       instead of silently showing a module the user turned off. Data is kept. */
                    <div
                      className="rounded-2xl border border-sh-line bg-sh-surface p-6 text-center space-y-2"
                      data-testid="module-switched-off"
                    >
                      <p className="text-sm text-sh-fg">网页批注已关闭</p>
                      <p className="text-xs text-sh-muted">
                        还剩 {state.annotations?.length ?? 0} 条批注没有被删除。要重新看到它们，去设置打开这个开关。
                      </p>
                      <button
                        onClick={() => go(buildRoute('settings', { section: 'features' }))}
                        className="px-3 py-1.5 rounded-lg bg-sh-accent text-sh-accent-fg text-xs font-semibold"
                      >
                        去设置打开
                      </button>
                    </div>
                  ) : (
                    <AnnotationsPane
                      annotations={state.annotations ?? []}
                      onSyncFromExtension={handleSyncAnnotations}
                      onUpdate={(annotation) =>
                        updateState((prev) => ({
                          ...prev,
                          annotations: (prev.annotations ?? []).map((entry) =>
                            entry.id === annotation.id ? annotation : entry
                          )
                        }))
                      }
                      onDelete={(id) =>
                        updateState((prev) => ({
                          ...prev,
                          annotations: (prev.annotations ?? []).filter((entry) => entry.id !== id)
                        }))
                      }
                    />
                  )}
                </div>
              </Suspense>
            )}

            {/* 笔记: the default pane. `#/library` lands here, and so does an old
                `#/library?type=note` deep link. */}
            {route.name === 'library' &&
              route.query.type !== 'webpage' &&
              route.query.view !== 'sources' && (
                <div data-testid="notes-workspace">
                  <LibraryTabs active="notes" onNavigate={go} />
                  <NotesPane
                    focusNoteId={focusNoteId}
                    notes={state.notes || []}
                    folders={state.noteFolders ?? []}
                    onAddNote={addNote}
                    onUpdateNote={updateNote}
                    onDeleteNote={deleteNote}
                    onAddFolder={(path) =>
                      updateState((prev) => ({
                        ...prev,
                        noteFolders: Array.from(new Set([...(prev.noteFolders ?? []), path]))
                      }))
                    }
                    onRemoveFolder={(path) =>
                      updateState((prev) => ({
                        ...prev,
                        // Deleting a folder never deletes notes: they move up to the parent folder.
                        noteFolders: (prev.noteFolders ?? []).filter(
                          (entry) => entry !== path && !entry.startsWith(`${path}/`)
                        ),
                        notes: (prev.notes ?? []).map((note) => {
                          const folder = note.folder ?? '';
                          if (folder !== path && !folder.startsWith(`${path}/`)) return note;
                          const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
                          const rest = folder.slice(path.length).replace(/^\//, '');
                          const next = [parent, rest].filter(Boolean).join('/');
                          return { ...note, folder: next || undefined };
                        })
                      }))
                    }
                  />
                </div>
              )}

            {route.name === 'library-item' && (
              <Suspense fallback={<ChunkFallback label="正在加载资料…" />}>
                <LibraryItemView
                  state={state}
                  itemKey={route.params.id}
                  onNavigate={go}
                  onAddNote={addNote}
                  onUpdateNote={updateNote}
                  onDeleteNote={deleteNote}
                  onDeleteHandwriting={deleteHandwriting}
                  onDeleteSite={deleteSite}
                  /* 批注详情页的编辑/删除：与 AnnotationsPane 同一套写入口。 */
                  onUpdateAnnotation={(annotation) =>
                    updateState((prev) => ({
                      ...prev,
                      annotations: (prev.annotations ?? []).map((entry) =>
                        entry.id === annotation.id ? annotation : entry
                      )
                    }))
                  }
                  onDeleteAnnotation={(id) =>
                    updateState((prev) => ({
                      ...prev,
                      annotations: (prev.annotations ?? []).filter((entry) => entry.id !== id)
                    }))
                  }
                  onEditNote={(id) => {
                    go('#/library');
                    setFocusNoteId(id);
                  }}
                />
              </Suspense>
            )}

            {(route.name === 'projects' || route.name === 'project') && (
              <ProjectsView
                state={state}
                onAddProject={addProject}
                onUpdateProject={updateProject}
                onDeleteProject={deleteProject}
                onNavigate={go}
                /* 搜索命中 / 收件箱跳转的深链（#/projects/:id）以前落在这里 =
                   整页空白：路由解析出了 name:'project'，App 却只认 'projects'。 */
                initialSelectedId={route.name === 'project' ? route.params.id : undefined}
              />
            )}

            {route.name === 'reminders' && (
              <RemindersView
                reminders={state.reminders || []}
                onAddReminder={addReminder}
                onUpdateReminder={updateReminder}
                onDeleteReminder={deleteReminder}
                onToggleComplete={toggleReminderComplete}
                onRenewReminder={renewReminder}
              />
            )}

            {route.name === 'servers' && (
              <ServersView
                servers={state.servers}
                onDelete={deleteServer}
                onUpdate={(server) =>
                  updateState((prev) => ({
                    ...prev,
                    servers: prev.servers.map((entry) => (entry.id === server.id ? server : entry))
                  }))
                }
                onCheck={(id) => checkServer(id)}
                onCheckAll={() => checkAllServers()}
                onOpenAddModal={(type) => openAddModal(type)}
              />
            )}

            {route.name === 'assets' && (
              <>
                {/* 到期总览是投影（提醒/服务器/凭证谁拥有日期这里读谁）+ 就地新建；
                    394 行的 AssetsView 曾经是孤儿组件——从未被任何文件 import，
                    订阅/证书集中视图对用户根本不存在。现在它才是这一页的主角。 */}
                <AssetsView
                  state={state}
                  onNavigate={go}
                  onAddReminder={() => go('#/reminders')}
                  onCreateAsset={(asset) => {
                    // 日期的权威归属仍是提醒（设计约束：一个到期日只有一个 owner），
                    // 但录入发生在这一页、用这一页的语言。
                    const due = parseDateInputValue(asset.due);
                    if (!Number.isFinite(due)) return;
                    const anchor = anchorFromDate(due, 'yearly');
                    addReminder({
                      id: `rem-${Date.now()}`,
                      title: asset.name,
                      category: asset.kind,
                      targetDate: due,
                      recurring: 'yearly',
                      cost: asset.cost,
                      url: asset.manageUrl,
                      autoRollover: true,
                      completed: false,
                      createdAt: Date.now(),
                      ...(anchor ? { anchorDay: anchor.day, anchorMonth: anchor.month } : {})
                    });
                  }}
                />
                <div className="mt-6">
                  <DomainsView
                    state={state}
                    onAddDomain={(domain) => updateState((prev) => ({ ...prev, domains: [domain, ...(prev.domains ?? [])] }))}
                    onUpdateDomain={(domain) =>
                      updateState((prev) => ({
                        ...prev,
                        domains: (prev.domains ?? []).map((entry) => (entry.id === domain.id ? domain : entry))
                      }))
                    }
                    onDeleteDomain={(id) =>
                      updateState((prev) => ({ ...prev, domains: (prev.domains ?? []).filter((entry) => entry.id !== id) }))
                    }
                  />
                </div>
              </>
            )}

            {route.name === 'vault' && (
              <VaultView
                secrets={state.secrets}
                masterPassword={masterPassword}
                hasMasterAuth={hasMasterAuth}
                onRequireUnlock={() => setIsMasterKeyOpen(true)}
                onLockVault={handleLockVault}
                onDelete={deleteSecret}
                onOpenAddModal={(type) => openAddModal(type)}
              />
            )}

            {route.name === 'checkins' && (
              <CheckInsView
                checkIns={state.checkIns}
                onRun={runCheckIn}
                onDelete={deleteCheckIn}
                onOpenAddModal={(type) => openAddModal(type)}
                onAddFromTemplate={(site) =>
                  updateState((prev) => ({
                    ...prev,
                    checkIns: [taskFromTemplate(site), ...(prev.checkIns ?? [])]
                  }))
                }
              />
            )}

            {route.name === 'drawing' && (
              <DrawingView handwritings={state.handwritings} onSave={saveHandwriting} onDelete={deleteHandwriting} />
            )}

            {isPageSettings && (
              <Suspense fallback={<ChunkFallback label="正在加载设置…" />}>
                <SettingsModal
                  variant="page"
                  isOpen
                  section={settingsSection as never}
                  onSectionChange={(next) => replace(buildRoute('settings', { section: next }))}
                  onLeave={() => go(buildRoute('home'))}
                  onClose={() => go(buildRoute('home'))}
                  obsidianConfig={state.obsidianConfig}
                  obsidianConnections={obsidianConnections}
                  onSelectObsidianConnection={selectObsidianConnection}
                  onAddObsidianConnection={addObsidianConnection}
                  onRemoveObsidianConnection={removeObsidianConnection}
                  aiConfig={state.aiConfig}
                  onSaveIntegration={(id, values) => updateState((prev) => applyIntegrationValues(prev, id, values))}
                  onToggleFeature={(id, enabled) =>
                    updateState((prev) => ({ ...prev, features: { ...(prev.features || {}), [id]: enabled } }))
                  }
                  state={state}
                  onRestoreState={handleRestoreState}
                  masterPassword={masterPassword}
                  hasMasterAuth={hasMasterAuth}
                  backupStatus={backupStatus}
                  onBackupNow={(force) => runStateBackup(force, 'manual')}
                  webdavConfig={state.webdavConfig}
                  backupTarget={backupTarget}
                  onUpdateBackupPolicy={(backupPolicy) =>
                    updateState((prev) => ({
                      ...prev,
                      backupPolicy: {
                        provider: backupPolicy.provider,
                        enabled: backupPolicy.enabled,
                        format: backupPolicy.format ?? prev.backupPolicy?.format ?? 'legacy',
                        // Multi-target: undefined keeps the old single-provider behaviour.
                        destinations: backupPolicy.destinations ?? prev.backupPolicy?.destinations
                      }
                    }))
                  }
                  v3Backup={{
                    panel: v3Backup.panel,
                    onUnlock: v3Backup.unlock,
                    onLock: v3Backup.lock,
                    onRefresh: () => void v3Backup.refresh(),
                    onRun: () => void v3Backup.runNow(),
                    onPrune: () => void v3Backup.pruneNow(),
                    onFormatChange: v3Backup.setFormat,
                    onPreviewBatch: (id: string) => void v3Backup.previewBatch(id),
                    onConflictChoice: v3Backup.setConflictChoice,
                    onRestoreMode: v3Backup.setRestoreMode,
                    onApplyRestore: () => void v3Backup.applyPreview(),
                    onDiscardPreview: v3Backup.discardPreview,
                    onExportMigration: () => void v3Backup.exportMigration(),
                    onPreviewMigration: (id: string) => void v3Backup.previewMigration(id),
                    onImportCredentialsChange: v3Backup.setImportCredentials,
                    onRemoveMigration: (id: string) => void v3Backup.removeMigration(id),
                    onExportBundle: (withCredentials: boolean) =>
                      void v3Backup.buildBundleFile({ includeCredentials: withCredentials }),
                    onImportBundle: (json: string) => void v3Backup.previewBundleFile(json),
                    onRetestConnections: (services: string[]) => void v3Backup.retestConnections(services)
                  }}
                  storageMode={{ mode: storageMode, counts: v3Status.counts, error: v3Status.error, migration: v3Status.migration }}
                  onSwitchStorageMode={switchStorageMode}
                  onRecordConnectionTest={(id, record) =>
                    updateState((prev) => ({
                      ...prev,
                      connectionTests: { ...(prev.connectionTests || {}), [id]: record }
                    }))
                  }
                />
              </Suspense>
            )}

            {route.name === 'not-found' && <NotFoundView onNavigate={go} />}
          </ErrorBoundary>
        </main>

      </div>

      <GlobalSearch
        isOpen={isSearchOpen}
        onClose={() => setIsSearchOpen(false)}
        state={state}
        masterPassword={masterPassword}
        onRequireUnlock={() => setIsMasterKeyOpen(true)}
        onCopySecret={(secret) => {
          // Decryption stays here: the dialog never holds plaintext. A clipboard
          // failure must not masquerade as a wrong password — that used to pop
          // the unlock dialog and send the user into a pointless re-login loop.
          void (async () => {
            if (!masterPassword) {
              setIsMasterKeyOpen(true);
              return;
            }
            let plain: string;
            try {
              plain = await decryptText(secret.encryptedValue, secret.iv, secret.salt, masterPassword);
            } catch {
              setIsMasterKeyOpen(true);
              return;
            }
            try {
              await navigator.clipboard.writeText(plain);
              flashNotice(`已复制「${secret.name}」到剪贴板`);
            } catch {
              flashNotice('复制失败：浏览器拒绝了剪贴板访问。');
            }
          })();
        }}
        /**
         * Routing for every searchable kind lives in one place. The palette reports
         * *what* the user picked; turning that into a route is the app's job, which is
         * what keeps `#/library/item/...` keys out of the search component.
         */
        onOpenResult={openSearchHit}
      />

      <Suspense fallback={null}>
        <AiIngestModal
          isOpen={isAiIngestOpen}
          onClose={() => setIsAiIngestOpen(false)}
          categories={state.categories}
          aiConfig={state.aiConfig}
          masterPassword={masterPassword}
          onRequireUnlock={() => setIsMasterKeyOpen(true)}
          onBatchImport={batchImport}
        />
      </Suspense>

      <MasterKeyModal
        isOpen={isMasterKeyOpen}
        onClose={() => setIsMasterKeyOpen(false)}
        onSuccess={(pwd) => {
          setMasterPassword(pwd);
          setHasMasterAuth(true);
        }}
      />

      <Suspense fallback={null}>
        <AddItemModal
          isOpen={isAddModalOpen}
          onClose={() => setIsAddModalOpen(false)}
          categories={state.categories}
          masterPassword={masterPassword}
          onRequireUnlock={() => setIsMasterKeyOpen(true)}
          onAddSite={addSite}
          onAddServer={addServer}
          onAddSecret={addSecret}
          onAddCheckIn={addCheckIn}
          onAddNote={(note) => updateState((prev) => ({ ...prev, notes: [note, ...prev.notes] }))}
          onlyTypes={addModalTypes ?? undefined}
          serverGroups={Array.from(new Set(state.servers.map((s) => (s.group || '').trim()).filter(Boolean)))}
        />
      </Suspense>

      <OnboardingWizard
        isOpen={showOnboarding}
        features={state.features}
        onSkip={dismissOnboarding}
        onFinish={(features) => {
          updateState((prev) => ({ ...prev, features }));
          dismissOnboarding();
        }}
        onOpenStorage={() => {
          dismissOnboarding();
          go(buildRoute('settings', { section: 'storage' }));
        }}
      />

      {/* 设置只有页面形态；第二个 SettingsModal（永远打不开）已移除。 */}
      {/* `focusNoteId` is consumed by the library item view; clear it once used. */}
      {focusNoteId && (route.name === 'library' || route.name === 'library-item') && <FocusClear onDone={clearFocusNoteId} />}

      {/* Transient feedback for clipboard and other one-line results. */}
      {globalNotice && (
        <div
          role="status"
          data-testid="global-notice"
          className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[70] px-3.5 py-2 rounded-xl bg-sh-surface2 border border-sh-line-strong text-xs text-sh-fg shadow-xl max-w-[90vw] truncate"
        >
          {globalNotice}
        </div>
      )}

      {/* Exposed for diagnostics without importing the whole app in tests. */}
      <span className="hidden" data-testid="write-guard" data-mode={checkWritable().mode} />

      <ToastHost />
    </div>
  );
}

/** Small helper that runs a callback once after mount (keeps effects out of App). */
function FocusClear({ onDone }: { onDone: () => void }) {
  useEffect(() => {
    onDone();
  }, [onDone]);
  return null;
}

export default App;
