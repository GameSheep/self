import React, { useState, useEffect } from 'react';
import { X, Settings, HardDrive, Sparkles, Download, Upload, Shield, Check, Globe, AlertTriangle, Lock, Key, Database, RefreshCw, RotateCcw, BookOpen, SlidersHorizontal
} from 'lucide-react';
import { ObsidianConfig, AiConfig, HubState, WebdavSyncConfig, WucaiConfig } from '../../types';
import { exportBackup, importBackup, INITIAL_STATE, saveHubState, snapshotForRollback, restoreRollbackSnapshot, hasRollbackSnapshot } from '../../lib/storage';
import { exportEncryptedBackup, importEncryptedBackup, getTrustedSession } from '../../lib/crypto';
import { deleteAllDatabases } from '../../lib/indexedDb';
import {
  backupKeyFor,
  describeBackupAge,
  mergeRestoredState,
  readStateBackup,
  readStateBackupFromWebdav
} from '../../lib/stateBackup';
import { testWebdav } from '../../lib/webdavClient';
import { testAiProvider } from '../../lib/aiProviders';
import {
  isExtensionContext,
  openExtensionOptions,
  readExtensionSyncState,
  setExtensionSyncEnabled,
  type ExtensionSyncState
} from '../../lib/extensionBridge';
import { INTEGRATIONS, IntegrationId } from '../../lib/integrations';
import { FEATURE_DEFS, FeatureId, isFeatureEnabled } from '../../lib/features';
import { IntegrationCard } from '../settings/IntegrationCard';
import { estimateStorageQuota } from '../../lib/indexedDb';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  obsidianConfig: ObsidianConfig;
  aiConfig: AiConfig;
  state: HubState;
  onRestoreState: (state: HubState) => void;
  masterPassword?: string | null;
  /** Auto-backup status shown next to the OSS settings. */
  backupStatus?: { status: 'idle' | 'saving' | 'error' | 'conflict'; lastAt?: number; message?: string };
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
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  isOpen,
  onClose,
  obsidianConfig,
  aiConfig,
  state,
  onRestoreState,
  masterPassword,
  backupStatus,
  onBackupNow,
  webdavConfig,
  onUpdateWucai,
  onSaveIntegration,
  onToggleFeature,
  initialSection
}) => {
  type SettingsSection = 'overview' | 'features' | 'storage' | 'sync' | 'content' | 'ai' | 'data';
  const [activeTab, setActiveTab] = useState<SettingsSection>('overview');
  const [wd, setWd] = useState<WebdavSyncConfig>(
    webdavConfig || { enabled: false, url: '', username: '', password: '', pathPrefix: 'selfhub_sync' }
  );
  const [wdTest, setWdTest] = useState<{ ok: boolean; message: string } | null>(null);
  const [wdTesting, setWdTesting] = useState(false);
  const [aiTest, setAiTest] = useState<Awaited<ReturnType<typeof testAiProvider>> | null>(null);
  const [aiTesting, setAiTesting] = useState(false);
  const [extSync, setExtSync] = useState<ExtensionSyncState>({
    available: false,
    provider: 'none',
    autoSync: false
  });
  useEffect(() => {
    if (isOpen && webdavConfig) setWd(webdavConfig);
  }, [isOpen, webdavConfig]);

  // OSS state

  // AI state
  const [savedSuccess, setSavedSuccess] = useState(false);
  // True when the app's own whole-state backup is pointing somewhere.
  const backupTargetActive = Boolean(
    (webdavConfig?.enabled && webdavConfig.url) || (obsidianConfig.enabled && obsidianConfig.bucket)
  );

  // Storage Quota & Encrypted Backup states
  const [quota, setQuota] = useState<{ usageMb: number; quotaMb: number; percentage: number; persisted: boolean } | null>(null);
  const [isExportingEncrypted, setIsExportingEncrypted] = useState(false);
  const [exportPassword, setExportPassword] = useState('');
  const [showExportPasswordInput, setShowExportPasswordInput] = useState(false);
  const [canRollback, setCanRollback] = useState(false);

  // Integration fields are registry-driven and keep their own draft state inside
  // <IntegrationCard>, so the modal no longer mirrors config into local state.
  // Esc closes the modal (matching every other dialog in the app).
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [isOpen, onClose]);

  useEffect(() => {
    if (!isOpen) return;
    setCanRollback(hasRollbackSnapshot());
    setSavedSuccess(false);
    if (initialSection) setActiveTab(initialSection);
    void readExtensionSyncState().then(setExtSync);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  // Load storage quota
  useEffect(() => {
    if (isOpen) {
      estimateStorageQuota().then((q) => setQuota(q));
    }
  }, [isOpen]);

  // Global window keydown listener for ESC
  React.useEffect(() => {
    if (!isOpen) return;
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', handleGlobalKeyDown, true);
    return () => window.removeEventListener('keydown', handleGlobalKeyDown, true);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const handleSaveConfigs = () => {
    // Every integration card persists on blur / on its own save button, so this
    // footer action must NOT write cached copies back (that is how stale values
    // used to clobber fresh edits). It only confirms.
    setSavedSuccess(true);
    setTimeout(() => {
      setSavedSuccess(false);
      onClose();
    }, 1000);
  };

  const handleExportEncryptedClick = async () => {
    const pwd = exportPassword || masterPassword;
    if (!pwd) {
      setShowExportPasswordInput(true);
      return;
    }

    try {
      setIsExportingEncrypted(true);
      const encryptedJson = await exportEncryptedBackup(state, pwd);
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
      alert(`加密导出失败: ${err.message || '未知错误'}`);
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
          // Encrypted backup
          let pwd = masterPassword;
          if (!pwd) {
            pwd = prompt('检测到 AES-256 加密备份文件，请输入主密码以解密恢复：');
            if (!pwd) return;
          }
          snapshotForRollback();
          const restored = await importEncryptedBackup(content, pwd);
          if (restored) {
            onRestoreState(restored);
            setCanRollback(true);
            alert(`✅ 加密备份已成功解密并恢复！共恢复 ${restored.sites?.length || 0} 个站点，${restored.notes?.length || 0} 条笔记。`);
            onClose();
          } else {
            alert('❌ 解密失败：主密码错误或备份文件损坏');
          }
        } else {
          // Standard plaintext backup
          const imported = importBackup(content);
          if (imported) {
            onRestoreState(imported);
            setCanRollback(true);
            alert('✅ 备份数据已成功恢复！');
            onClose();
          } else {
            alert('❌ 备份文件格式错误或数据校验未通过，恢复中止以保护现有数据');
          }
        }
      } catch (err: any) {
        alert(`❌ 读取备份失败: ${err.message || '不是有效的 JSON 文件'}`);
      } finally {
        // Allow re-selecting the same file again.
        e.target.value = '';
      }
    };
    reader.readAsText(file);
  };

  const handleRollback = () => {
    if (!confirm('确定撤销上一次备份导入，恢复到导入前的数据吗？')) return;
    const restored = restoreRollbackSnapshot();
    if (!restored) {
      alert('❌ 没有可用的回滚快照（快照仅在本次浏览器会话内有效）');
      setCanRollback(false);
      return;
    }
    onRestoreState(restored);
    setCanRollback(false);
    alert('✅ 已回滚到导入前的数据');
    onClose();
  };

  const handleResetData = () => {
    if (confirm('⚠️ 警告：确定彻底清空所有本地数据并恢复纯净出厂状态吗？这将清除全部本地缓存、旧测试数据与历史记录。')) {
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
        alert('✅ 本地数据与缓存已彻底清空，已重置为纯净出厂状态！');
        onClose();
        window.location.reload();
      })();
    }
  };

  return (
    <div 
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-black/80 backdrop-blur-sm animate-in fade-in"
    >
      <div 
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-2xl bg-[#121316] border border-zinc-800 rounded-2xl shadow-2xl overflow-hidden flex flex-col"
      >
        
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-zinc-800">
          <div className="flex items-center gap-2">
            <Settings className="w-4 h-4 text-zinc-300" />
            <h3 className="text-sm font-semibold text-zinc-100">系统与服务集成设置</h3>
          </div>
          <button onClick={onClose} className="p-1 rounded-lg hover:bg-zinc-800 text-zinc-400 hover:text-white">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Section nav + content */}
        <div className="flex min-h-0">
          <nav className="w-32 sm:w-40 shrink-0 border-r border-zinc-800 bg-zinc-900/40 p-2 space-y-0.5">
            {(
              [
                { id: 'overview', label: '概览', icon: Shield },
                { id: 'features', label: '功能开关', icon: SlidersHorizontal },
                { id: 'storage', label: '存储与备份', icon: HardDrive },
                { id: 'sync', label: '同步', icon: RefreshCw },
                { id: 'content', label: '内容来源', icon: BookOpen, SlidersHorizontal },
                { id: 'ai', label: 'AI 模型', icon: Sparkles },
                { id: 'data', label: '数据与维护', icon: Database }
              ] as const
            ).map((item) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.id}
                  onClick={() => setActiveTab(item.id)}
                  data-settings-nav={item.id}
                  className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-left text-xs transition-colors ${
                    activeTab === item.id
                      ? 'bg-zinc-800 text-white font-medium'
                      : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50'
                  }`}
                >
                  <Icon className="w-3.5 h-3.5 shrink-0" />
                  <span className="truncate">{item.label}</span>
                </button>
              );
            })}
          </nav>

          <div className="flex-1 min-w-0 p-5 space-y-4 overflow-y-auto max-h-[65vh]">
          {/* ============ 概览：所有外部连接一屏看清 ============ */}
          {activeTab === 'overview' && (
            <div className="space-y-3" data-testid="settings-overview">
              <p className="text-xs text-zinc-400 leading-relaxed">
                这里汇总所有外部连接的状态。配置项统一收敛在本设置里，不再分散在各个业务页面。
              </p>

              {[
                ...INTEGRATIONS.map((def) => ({
                  key: def.id as string,
                  name: def.title,
                  configured: def.isConfigured(state),
                  detail: def.describe(state),
                  section: def.section
                })),
                // Rows that are not integrations but still part of "what is set up".
                {
                  key: 'backup',
                  name: '全量备份',
                  configured: Boolean(backupStatus?.lastAt),
                  detail: describeBackupAge(backupStatus?.lastAt),
                  section: 'storage' as SettingsSection
                },
                {
                  key: 'extension',
                  name: '浏览器扩展内置同步',
                  configured: isExtensionContext(),
                  detail: isExtensionContext() ? '当前运行在扩展环境' : '当前是普通网页，扩展同步不可用',
                  section: 'sync' as SettingsSection
                },
                {
                  key: 'index',
                  name: '全文索引',
                  configured: true,
                  detail: '在「数据与维护」中查看用量、清除或重建',
                  section: 'data' as SettingsSection
                }
              ].map((row) => (
                <div
                  key={row.key}
                  data-overview-item={row.key}
                  className="flex items-center justify-between gap-3 rounded-xl border border-zinc-800 bg-zinc-900/40 px-3 py-2"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span
                        className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                          row.configured ? 'bg-emerald-400' : 'bg-zinc-600'
                        }`}
                      />
                      <span className="text-xs text-zinc-200 truncate">{row.name}</span>
                    </div>
                    <p className="text-[10px] text-zinc-500 font-mono truncate mt-0.5 pl-3.5">{row.detail}</p>
                  </div>
                  <button
                    onClick={() => setActiveTab(row.section)}
                    className="shrink-0 text-[11px] px-2 py-0.5 rounded-md bg-zinc-800 hover:bg-zinc-700 text-zinc-300"
                  >
                    配置
                  </button>
                </div>
              ))}
            </div>
          )}


          {/* ============ 功能开关：不用的模块直接收起来 ============ */}
          {activeTab === 'features' && (
            <div className="space-y-3" data-testid="settings-features">
              <p className="text-xs text-zinc-400 leading-relaxed">
                不是每个模块都要用。关掉的模块会从侧边栏与顶部标签中消失，已存数据不会被删除，随时可以再打开。
                仪表盘、网站、倒计时与 Obsidian 笔记属于核心功能，不可关闭。
              </p>

              <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 divide-y divide-zinc-800">
                {FEATURE_DEFS.map((def) => {
                  const enabled = isFeatureEnabled(state.features, def.id);
                  return (
                    <div key={def.id} className="flex items-center justify-between gap-3 px-3 py-2">
                      <div className="min-w-0">
                        <div className="text-xs text-zinc-200">{def.label}</div>
                        <p className="text-[10px] text-zinc-500 mt-0.5 leading-relaxed">{def.description}</p>
                      </div>
                      <button
                        onClick={() => onToggleFeature?.(def.id, !enabled)}
                        data-feature-toggle={def.id}
                        data-enabled={enabled ? 'true' : 'false'}
                        aria-pressed={enabled}
                        className={`shrink-0 w-9 h-5 rounded-full transition-colors relative ${
                          enabled ? 'bg-emerald-600' : 'bg-zinc-700'
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
            </div>
          )}
          {/* ============ 内容来源（注册表驱动） ============ */}
          {activeTab === 'content' && (
            <div className="space-y-3" data-testid="settings-content">
              <p className="text-xs text-zinc-400 leading-relaxed">
                内容来源的凭据统一在这里维护，业务页面只负责展示数据，不再各自保存一份 Token。
              </p>
              {INTEGRATIONS.filter((i) => i.section === 'content').map((def) => (
                <IntegrationCard key={def.id} def={def} state={state} onSave={onSaveIntegration} />
              ))}
            </div>
          )}

          {/* ============ 存储与备份：同一套卡片渲染 ============ */}
          {activeTab === 'storage' && (
            <div className="space-y-3">
              {INTEGRATIONS.filter((i) => i.section === 'storage').map((def) => (
                <IntegrationCard
                  key={def.id}
                  def={def}
                  state={state}
                  onSave={onSaveIntegration}
                  actions={
                    def.id === 'webdav'
                      ? (draft) => (
                          <button
                            onClick={async () => {
                              setWdTesting(true);
                              setWdTest(null);
                              try {
                                const result = await testWebdav({
                                  enabled: true,
                                  url: draft.url || '',
                                  username: draft.username || '',
                                  password: draft.password || '',
                                  pathPrefix: draft.pathPrefix || 'selfhub_sync'
                                });
                                setWdTest({ ok: result.ok, message: result.message });
                              } finally {
                                setWdTesting(false);
                              }
                            }}
                            disabled={wdTesting}
                            className="px-2.5 py-1 rounded-lg bg-teal-700 hover:bg-teal-600 text-white text-[11px] font-semibold disabled:opacity-50"
                            data-testid="webdav-test"
                          >
                            {wdTesting ? '测试中…' : '测试连接'}
                          </button>
                        )
                      : undefined
                  }
                >
                  {def.id === 'webdav' && wdTest && (
                    <span
                      data-testid="webdav-test-result"
                      className={`text-[11px] ${wdTest.ok ? 'text-emerald-400' : 'text-rose-400'}`}
                    >
                      {wdTest.ok ? '✅ ' : '⚠️ '}
                      {wdTest.message}
                    </span>
                  )}
                </IntegrationCard>
              ))}
            </div>
          )}

          {/* ============ AI 模型（注册表驱动） ============ */}
          {activeTab === 'ai' && (
            <div className="space-y-3">
              {INTEGRATIONS.filter((i) => i.section === 'ai').map((def) => (
                <IntegrationCard
                  key={def.id}
                  def={def}
                  state={state}
                  onSave={onSaveIntegration}
                  actions={(draft) => (
                    <button
                      onClick={async () => {
                        setAiTesting(true);
                        setAiTest(null);
                        try {
                          const result = await testAiProvider({
                            provider: (draft.provider as HubState['aiConfig']['provider']) || 'gemini',
                            apiKey: draft.apiKey || '',
                            baseUrl: draft.baseUrl || '',
                            model: draft.model || '',
                            cloudAiEnabled: draft.cloudAiEnabled === 'true'
                          });
                          setAiTest(result);
                        } finally {
                          setAiTesting(false);
                        }
                      }}
                      disabled={aiTesting}
                      className="px-2.5 py-1 rounded-lg bg-sky-700 hover:bg-sky-600 text-white text-[11px] font-semibold disabled:opacity-50"
                      data-testid="ai-test"
                    >
                      {aiTesting ? '测试中…' : '测试连接'}
                    </button>
                  )}
                >
                  {aiTest && (
                    <div
                      data-testid="ai-test-result"
                      className={`w-full mt-2 rounded-lg border px-3 py-2 text-[11px] leading-relaxed whitespace-pre-wrap ${
                        aiTest.ok
                          ? 'border-emerald-900/60 bg-emerald-950/30 text-emerald-300'
                          : 'border-rose-900/60 bg-rose-950/30 text-rose-300'
                      }`}
                    >
                      {aiTest.ok ? '✅ ' : '⚠️ '}
                      {aiTest.message}
                      {aiTest.modelSubstituted && (
                        <span className="block mt-1 text-amber-300">
                          注意：模型名与服务商不匹配，已自动改用 {aiTest.model}。请把模型字段也改成它，避免再次产生 400。
                        </span>
                      )}
                    </div>
                  )}
                </IntegrationCard>
              ))}
            </div>
          )}
          {activeTab === 'sync' && (
            <div className="space-y-3">
              {/* ---- 浏览器扩展自带同步：与全量备份存在重叠，必须让用户看得见 ---- */}
              <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4 space-y-3" data-testid="extension-sync-section">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <h4 className="text-xs font-semibold text-zinc-200">浏览器扩展自带同步</h4>
                    <p className="text-[11px] text-zinc-500 mt-0.5 leading-relaxed">
                      扩展里另有一套同步，会单独把站点、批注、收件箱写到云盘。它和本应用的「全量备份」
                      <b className="text-zinc-400">覆盖同一批数据但写在不同的目录</b>，同时开启会让同一份站点出现两处副本。
                    </p>
                  </div>
                </div>

                {!extSync.available ? (
                  <p className="text-[11px] text-zinc-500">
                    当前不是扩展环境，扩展自带同步不可用（也不会有重复写入的问题）。
                  </p>
                ) : (
                  <>
                    <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3 font-mono text-[11px] space-y-1">
                      <div className="flex justify-between">
                        <span className="text-zinc-500">当前状态</span>
                        <span className={extSync.provider === 'none' ? 'text-zinc-400' : 'text-emerald-400'}>
                          {extSync.provider === 'none' ? '已关闭' : `已开启（${extSync.provider.toUpperCase()}）`}
                        </span>
                      </div>
                      {extSync.pathPrefix && (
                        <div className="flex justify-between">
                          <span className="text-zinc-500">写入目录</span>
                          <span className="text-zinc-300">{extSync.pathPrefix}/</span>
                        </div>
                      )}
                      {extSync.endpoint && (
                        <div className="flex justify-between gap-3">
                          <span className="text-zinc-500 shrink-0">目标</span>
                          <span className="text-zinc-300 truncate">{extSync.endpoint}</span>
                        </div>
                      )}
                      <div className="flex justify-between">
                        <span className="text-zinc-500">上次同步</span>
                        <span className="text-zinc-400">
                          {extSync.lastSyncTime ? new Date(extSync.lastSyncTime).toLocaleString() : '从未'}
                        </span>
                      </div>
                    </div>

                    {/* Overlap warning: both systems writing the same datasets. */}
                    {extSync.provider !== 'none' && backupTargetActive && (
                      <div
                        className="rounded-lg border border-amber-900/60 bg-amber-950/25 px-3 py-2 text-[11px] text-amber-300 leading-relaxed"
                        data-testid="sync-overlap-warning"
                      >
                        ⚠️ 两套同步同时开启：站点/批注会被写两次（扩展写「{extSync.pathPrefix || 'selfhub_sync'}/」，
                        应用备份写各自的目标）。建议只保留一套——应用备份已包含全部数据，建议关闭扩展同步。
                      </div>
                    )}

                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        onClick={async () => {
                          const turningOff = extSync.provider !== 'none';
                          if (
                            turningOff &&
                            !confirm(
                              '关闭扩展自带同步？\n\n站点、批注、收件箱之后由本应用的「全量备份」统一负责，云端已写入的旧文件不会被删除。'
                            )
                          ) {
                            return;
                          }
                          const ok = await setExtensionSyncEnabled(!turningOff);
                          if (!ok) {
                            alert('⚠️ 修改失败，请稍后重试');
                            return;
                          }
                          setExtSync(await readExtensionSyncState());
                        }}
                        className="px-2.5 py-1 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-[11px]"
                        data-testid="extension-sync-toggle"
                      >
                        {extSync.provider === 'none' ? '开启扩展同步' : '关闭扩展同步（推荐）'}
                      </button>
                      <button
                        onClick={() => openExtensionOptions()}
                        className="text-[11px] text-sky-400 hover:underline"
                        data-testid="open-extension-options"
                      >
                        打开扩展完整设置页
                      </button>
                    </div>
                  </>
                )}
              </div>

              <div className="p-3.5 rounded-xl bg-zinc-900/80 border border-zinc-800 text-xs text-zinc-300 leading-relaxed">
                <div className="font-semibold text-zinc-100 flex items-center gap-1.5 mb-1.5">
                  <Shield className="w-4 h-4 text-emerald-400" />
                  独立域名自定义部署与防护指引
                </div>
                <p className="text-zinc-400 mb-2">
                  1. 本项目构建产物（`npm run build` 生成的 `dist` 目录）直接拖拽发布至 <strong>Cloudflare Pages</strong> 或任意静态托管服务即可秒级上线。<br />
                  2. 在 Cloudflare Dashboard 绑定您的自定义域名（如 <code>my-hub.com</code>）。<br />
                  3. 在 <strong>Zero Trust &gt; Access &gt; Applications</strong> 中为该域名添加门禁策略：设置规则为 <em>Include: Emails = 您的个人邮箱</em>。
                </p>
                <div className="text-[11px] text-emerald-400 bg-emerald-950/40 p-2 rounded-lg border border-emerald-800/40">
                  ✅ 效果：未经授权的访客打开该域名会被 Cloudflare 边缘直接拦截；只有输入您邮箱的 6 位临时验证码才能进入。
                </div>
              </div>
            </div>
          )}

          {activeTab === 'data' && (
            <div className="space-y-4">
              {/* Storage Quota Overview (N04) */}
              <div className="p-4 rounded-xl bg-zinc-900/60 border border-zinc-800 space-y-2">
                <div className="flex items-center justify-between text-xs">
                  <div className="flex items-center gap-1.5 text-zinc-300 font-medium">
                    <Database className="w-3.5 h-3.5 text-sky-400" />
                    <span>本地存储健康与容量使用 (IndexedDB + Storage)</span>
                  </div>
                  {quota && (
                    <span className="font-mono text-[11px] text-zinc-400">
                      {quota.usageMb.toFixed(2)} MB / {quota.quotaMb.toFixed(0)} MB ({quota.percentage.toFixed(1)}%)
                    </span>
                  )}
                </div>
                <div className="w-full bg-zinc-800 h-1.5 rounded-full overflow-hidden">
                  <div
                    className="bg-emerald-500 h-full rounded-full transition-all duration-300"
                    style={{ width: `${Math.min(100, Math.max(1, quota ? quota.percentage : 5))}%` }}
                  />
                </div>
                <div className="text-[10px] text-zinc-400 flex items-center justify-between pt-0.5">
                  <span>支持离线断网运行、本地零延迟读写、零知识隔离</span>
                  <button
                    onClick={() => estimateStorageQuota().then((q) => setQuota(q))}
                    className="flex items-center gap-1 hover:text-zinc-200"
                  >
                    <RefreshCw className="w-2.5 h-2.5" />
                    <span>刷新</span>
                  </button>
                </div>
              </div>

              {/* AES-256 Full Encrypted Backup Package (N02, N03) */}
              <div className="p-4 rounded-xl bg-zinc-900/60 border border-zinc-800 space-y-3">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <div className="flex items-center gap-1.5">
                      <Lock className="w-3.5 h-3.5 text-amber-400" />
                      <h4 className="text-xs font-semibold text-zinc-200">AES-256-GCM 完整加密备份包 (推荐)</h4>
                      <span className="px-1.5 py-0.5 rounded text-[9px] bg-amber-950/60 border border-amber-800/60 text-amber-300 font-medium">强安全</span>
                    </div>
                    <p className="text-[11px] text-zinc-400 mt-1 leading-relaxed">
                      使用 PBKDF2 (100,000次加盐迭代) + AES-256-GCM 客户端本地加密全站数据（包括书签、笔记、金库凭据与项目）。生成 <code>.enc.json</code> 密文文件，上传至任何公共云盘或网络传输均绝对安全。
                    </p>
                  </div>
                  <button
                    onClick={handleExportEncryptedClick}
                    disabled={isExportingEncrypted}
                    className="px-3 py-1.5 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/30 text-xs text-amber-200 font-medium flex items-center gap-1.5 shrink-0 transition-colors"
                  >
                    <Key className="w-3.5 h-3.5 text-amber-400" />
                    <span>{isExportingEncrypted ? '加密打包中...' : '导出加密包'}</span>
                  </button>
                </div>

                {showExportPasswordInput && (
                  <div className="p-3 rounded-lg bg-zinc-950/80 border border-amber-900/40 space-y-2 animate-in fade-in">
                    <div className="text-[11px] text-zinc-300 font-medium">请输入加密备份用的主密码：</div>
                    <div className="flex items-center gap-2">
                      <input
                        type="password"
                        value={exportPassword}
                        onChange={(e) => setExportPassword(e.target.value)}
                        placeholder="输入加密密钥 / 主密码..."
                        className="flex-1 bg-zinc-900 border border-zinc-700 rounded px-2.5 py-1 text-xs text-zinc-100 font-mono focus:outline-none"
                      />
                      <button
                        onClick={handleExportEncryptedClick}
                        className="px-3 py-1 bg-amber-500 hover:bg-amber-400 text-black text-xs font-semibold rounded"
                      >
                        确认导出
                      </button>
                      <button
                        onClick={() => {
                          setShowExportPasswordInput(false);
                          setExportPassword('');
                        }}
                        className="px-2 py-1 text-xs text-zinc-400 hover:text-white"
                      >
                        取消
                      </button>
                    </div>
                  </div>
                )}
              </div>

              {/* Standard Plaintext JSON Backup */}
              <div className="p-4 rounded-xl bg-zinc-900/60 border border-zinc-800 flex items-center justify-between">
                <div>
                  <h4 className="text-xs font-semibold text-zinc-200">标准明文 JSON 备份</h4>
                  <p className="text-[11px] text-zinc-400 mt-0.5">导出未二次加密的纯 JSON 文件，便于手动查阅代码或在本地文本编辑器修改</p>
                </div>
                <button
                  onClick={() => {
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
                      !confirm(
                        '导出的是明文 JSON，其中的 OSS 密钥、WebDAV 密码、AI Key 等会以可读形式保存到文件。\n\n' +
                          '请只存放在可信位置，不要上传到网盘或发给他人。\n\n' +
                          '如需安全转移，请改用左侧的「导出加密包」。\n\n仍要导出明文吗？'
                      )
                    ) {
                      return;
                    }
                    exportBackup(state);
                  }}
                  className="px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-xs text-zinc-100 font-medium flex items-center gap-1.5 shrink-0 transition-colors"
                >
                  <Download className="w-3.5 h-3.5" />
                  导出明文
                </button>
              </div>

              {/* Restore Backup (Auto-detects Encrypted vs. Plaintext) */}
              <div className="p-4 rounded-xl bg-zinc-900/60 border border-zinc-800 flex items-center justify-between">
                <div>
                  <h4 className="text-xs font-semibold text-zinc-200">恢复与导入备份</h4>
                  <p className="text-[11px] text-zinc-400 mt-0.5">支持一键导入 <code>.enc.json</code> 加密备份包或标准 <code>.json</code> 明文备份，自动检测格式与校验</p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {canRollback && (
                    <button
                      onClick={handleRollback}
                      className="px-3 py-1.5 rounded-lg bg-amber-950/40 border border-amber-800/50 text-xs text-amber-300 font-medium flex items-center gap-1.5 transition-colors hover:bg-amber-900/40"
                      title="恢复到上一次导入备份之前的数据"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                      撤销上次导入
                    </button>
                  )}
                  <label className="px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-xs text-zinc-100 font-medium flex items-center gap-1.5 cursor-pointer shrink-0 transition-colors">
                    <Upload className="w-3.5 h-3.5" />
                    选择文件
                    <input type="file" accept=".json,.enc.json" onChange={handleImportFile} className="hidden" />
                  </label>
                </div>
              </div>

              <div className="pt-2 border-t border-zinc-800/80 flex items-center justify-between">
                <span className="text-xs text-red-400 flex items-center gap-1">
                  <AlertTriangle className="w-3.5 h-3.5" />
                  危险区域
                </span>
                <button
                  onClick={handleResetData}
                  className="px-3 py-1.5 rounded-lg bg-red-950/40 border border-red-800/40 text-xs text-red-400 hover:bg-red-900/40"
                >
                  重置所有数据
                </button>
              </div>
            </div>
          )}

          {/* ---- 全量数据云备份 ---- */}
          {activeTab === 'storage' && (
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4 space-y-3" data-testid="cloud-backup-section">
              <div>
                <h4 className="text-xs font-semibold text-zinc-200 flex items-center gap-1.5">
                  <Database className="w-3.5 h-3.5 text-sky-400" />
                  全量数据自动备份
                </h4>
                <p className="text-[11px] text-zinc-500 mt-0.5 leading-relaxed">
                  把站点、提醒、项目、收件箱、批注、签到等本地数据备份到
                  <code className="text-zinc-400 mx-1">{backupKeyFor(obsidianConfig)}</code>
                  。换设备或清空浏览器数据后可从这里恢复。
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2 text-[11px]">
                <span className="font-mono text-zinc-400" data-testid="backup-status">
                  {backupStatus?.status === 'saving'
                    ? '备份中…'
                    : backupStatus?.status === 'conflict'
                    ? '⚠️ 云端更新，未覆盖'
                    : backupStatus?.status === 'error'
                    ? `⚠️ 备份失败：${backupStatus.message || '未知原因'}`
                    : describeBackupAge(backupStatus?.lastAt)}
                </span>

                <button
                  onClick={async () => {
                    if (!onBackupNow) return;
                    // Never clobber a newer cloud snapshot silently: ask first.
                    const res = await onBackupNow(false);
                    if (res.ok) {
                      alert('✅ 已备份到云端');
                      return;
                    }
                    if (res.conflict) {
                      alert(`⚠️ ${res.error || '云端备份比本机新，已把本地快照另存到 conflicts 目录'}`);
                      if (confirm('云端备份比本机更新（可能来自另一台设备）。\n\n仍要用本机数据覆盖云端吗？')) {
                        const forced = await onBackupNow(true);
                        alert(forced.ok ? '✅ 已用本机数据覆盖云端备份' : `⚠️ ${forced.error || '仍然失败'}`);
                      }
                      return;
                    }
                    alert(`⚠️ 备份失败：${res.error || '未知原因'}`);
                  }}
                  disabled={backupStatus?.status === 'saving' || !onBackupNow}
                  className="px-2.5 py-1 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 disabled:opacity-50"
                  data-testid="backup-now"
                >
                  立即备份
                </button>

                <button
                  onClick={async () => {
                    // Restore from whichever provider is active.
                    const useWd = Boolean(
                      webdavConfig?.enabled && webdavConfig.url && webdavConfig.username && webdavConfig.password
                    );
                    const res = useWd
                      ? await readStateBackupFromWebdav(webdavConfig!)
                      : await readStateBackup(obsidianConfig);
                    if (!res.ok || !res.backup) {
                      alert(`⚠️ 无法读取云端备份：${res.error || '未知原因'}`);
                      return;
                    }
                    const when = res.backup.envelope.updatedAt
                      ? new Date(res.backup.envelope.updatedAt).toLocaleString()
                      : '未知时间';
                    if (
                      !confirm(
                        `从云端恢复备份？\n\n备份时间：${when}\n来源设备：${res.backup.envelope.deviceId}\n\n当前本机数据会被这份备份覆盖（建议先「立即备份」把当前状态存上去）。`
                      )
                    ) {
                      return;
                    }
                    // Credentials never travel in the backup; keep the local ones.
                    onRestoreState(mergeRestoredState(res.backup.envelope.state, state));
                    alert('✅ 已从云端恢复');
                  }}
                  className="px-2.5 py-1 rounded-lg bg-zinc-900 border border-zinc-800 hover:bg-zinc-800 text-zinc-300"
                  data-testid="restore-from-cloud"
                >
                  从云端恢复
                </button>
              </div>
            </div>
          )}

          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 p-4 border-t border-zinc-800">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-xl bg-zinc-900 hover:bg-zinc-800 text-zinc-300 text-xs"
          >
            取消
          </button>
          <button
            onClick={handleSaveConfigs}
            className="px-4 py-2 rounded-xl bg-zinc-100 text-zinc-900 hover:bg-white text-xs font-semibold flex items-center gap-1.5 shadow-sm"
          >
            {savedSuccess ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Check className="w-3.5 h-3.5" />}
            <span>{savedSuccess ? '配置已保存' : '保存配置'}</span>
          </button>
        </div>

      </div>
    </div>
  );
};











