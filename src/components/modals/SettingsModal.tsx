import React, { useState, useEffect } from 'react';
import { X, Settings, HardDrive, Sparkles, Download, Upload, Shield, Check, Globe, AlertTriangle, Lock, Key, Database, RefreshCw } from 'lucide-react';
import { ObsidianConfig, AiConfig, HubState } from '../../types';
import { exportBackup, importBackup, INITIAL_STATE, saveHubState } from '../../lib/storage';
import { exportEncryptedBackup, importEncryptedBackup, getTrustedSession } from '../../lib/crypto';
import { estimateStorageQuota } from '../../lib/indexedDb';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  obsidianConfig: ObsidianConfig;
  onUpdateObsidian: (config: ObsidianConfig) => void;
  aiConfig: AiConfig;
  onUpdateAi: (config: AiConfig) => void;
  state: HubState;
  onRestoreState: (state: HubState) => void;
  masterPassword?: string | null;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  isOpen,
  onClose,
  obsidianConfig,
  onUpdateObsidian,
  aiConfig,
  onUpdateAi,
  state,
  onRestoreState,
  masterPassword
}) => {
  const [activeTab, setActiveTab] = useState<'oss' | 'ai' | 'backup' | 'cloudflare'>('cloudflare');

  // OSS state
  const [ossBucket, setOssBucket] = useState(obsidianConfig.bucket);
  const [ossEndpoint, setOssEndpoint] = useState(obsidianConfig.endpoint);
  const [ossRegion, setOssRegion] = useState(obsidianConfig.region);
  const [ossKeyId, setOssKeyId] = useState(obsidianConfig.accessKeyId);
  const [ossKeySecret, setOssKeySecret] = useState(obsidianConfig.accessKeySecret);
  const [ossPrefix, setOssPrefix] = useState(obsidianConfig.prefix);

  // AI state
  const [aiProvider, setAiProvider] = useState(aiConfig.provider);
  const [aiKey, setAiKey] = useState(aiConfig.apiKey);
  const [aiBaseUrl, setAiBaseUrl] = useState(aiConfig.baseUrl);
  const [aiModel, setAiModel] = useState(aiConfig.model);
  const [savedSuccess, setSavedSuccess] = useState(false);

  // Storage Quota & Encrypted Backup states
  const [quota, setQuota] = useState<{ usageMb: number; quotaMb: number; percentage: number; persisted: boolean } | null>(null);
  const [isExportingEncrypted, setIsExportingEncrypted] = useState(false);
  const [exportPassword, setExportPassword] = useState('');
  const [showExportPasswordInput, setShowExportPasswordInput] = useState(false);

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
    onUpdateObsidian({
      enabled: true,
      bucket: ossBucket,
      endpoint: ossEndpoint,
      region: ossRegion,
      accessKeyId: ossKeyId,
      accessKeySecret: ossKeySecret,
      prefix: ossPrefix
    });

    onUpdateAi({
      provider: aiProvider,
      apiKey: aiKey,
      baseUrl: aiBaseUrl,
      model: aiModel
    });

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
          const restored = await importEncryptedBackup(content, pwd);
          if (restored) {
            onRestoreState(restored);
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
            alert('✅ 备份数据已成功恢复！');
            onClose();
          } else {
            alert('❌ 备份文件格式错误或数据校验未通过，恢复中止以保护现有数据');
          }
        }
      } catch (err: any) {
        alert(`❌ 读取备份失败: ${err.message || '不是有效的 JSON 文件'}`);
      }
    };
    reader.readAsText(file);
  };

  const handleResetData = () => {
    if (confirm('⚠️ 警告：确定彻底清空所有本地数据并恢复纯净出厂状态吗？这将清除全部本地缓存、旧测试数据与历史记录。')) {
      try {
        localStorage.clear();
        sessionStorage.clear();
        indexedDB.deleteDatabase('SelfHubDB');
      } catch {}
      saveHubState(INITIAL_STATE);
      onRestoreState(INITIAL_STATE);
      alert('✅ 本地数据与缓存已彻底清空，已重置为纯净出厂状态！');
      onClose();
      window.location.reload();
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

        {/* Tab switcher */}
        <div className="flex border-b border-zinc-800 bg-zinc-900/60 p-1">
          <button
            onClick={() => setActiveTab('cloudflare')}
            className={`flex-1 py-1.5 text-xs font-medium rounded-lg transition-colors flex items-center justify-center gap-1.5 ${
              activeTab === 'cloudflare' ? 'bg-zinc-800 text-white' : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            <Globe className="w-3.5 h-3.5" />
            Cloudflare 门禁
          </button>
          <button
            onClick={() => setActiveTab('oss')}
            className={`flex-1 py-1.5 text-xs font-medium rounded-lg transition-colors flex items-center justify-center gap-1.5 ${
              activeTab === 'oss' ? 'bg-zinc-800 text-white' : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            <HardDrive className="w-3.5 h-3.5" />
            阿里云 OSS (Obsidian)
          </button>
          <button
            onClick={() => setActiveTab('ai')}
            className={`flex-1 py-1.5 text-xs font-medium rounded-lg transition-colors flex items-center justify-center gap-1.5 ${
              activeTab === 'ai' ? 'bg-zinc-800 text-white' : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            <Sparkles className="w-3.5 h-3.5" />
            AI 模型配置
          </button>
          <button
            onClick={() => setActiveTab('backup')}
            className={`flex-1 py-1.5 text-xs font-medium rounded-lg transition-colors flex items-center justify-center gap-1.5 ${
              activeTab === 'backup' ? 'bg-zinc-800 text-white' : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            <Download className="w-3.5 h-3.5" />
            备份与恢复
          </button>
        </div>

        {/* Content */}
        <div className="p-5 space-y-4 overflow-y-auto max-h-[65vh]">
          {activeTab === 'cloudflare' && (
            <div className="space-y-3">
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

          {activeTab === 'oss' && (
            <div className="space-y-3">
              <p className="text-xs text-zinc-400">
                配置您存放 Obsidian Markdown 库的阿里云 OSS Bucket 信息（建议配置只读 AccessKey）：
              </p>
              <div>
                <label className="block text-xs text-zinc-400 mb-1">Bucket 名称</label>
                <input
                  type="text"
                  value={ossBucket}
                  onChange={(e) => setOssBucket(e.target.value)}
                  placeholder="例如: my-obsidian-vault"
                  className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-1.5 text-xs text-zinc-100 font-mono focus:outline-none"
                />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <div>
                  <label className="block text-xs text-zinc-400 mb-1">Endpoint (地域节点)</label>
                  <input
                    type="text"
                    value={ossEndpoint}
                    onChange={(e) => setOssEndpoint(e.target.value)}
                    placeholder="oss-cn-hangzhou.aliyuncs.com"
                    className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-1.5 text-xs text-zinc-100 font-mono focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-xs text-zinc-400 mb-1">同步目录前缀</label>
                  <input
                    type="text"
                    value={ossPrefix}
                    onChange={(e) => setOssPrefix(e.target.value)}
                    placeholder="vault/"
                    className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-1.5 text-xs text-zinc-100 font-mono focus:outline-none"
                  />
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <div>
                  <label className="block text-xs text-zinc-400 mb-1">AccessKeyId (只读)</label>
                  <input
                    type="text"
                    value={ossKeyId}
                    onChange={(e) => setOssKeyId(e.target.value)}
                    placeholder="LTAI5t..."
                    className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-1.5 text-xs text-zinc-100 font-mono focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-xs text-zinc-400 mb-1">AccessKeySecret</label>
                  <input
                    type="password"
                    value={ossKeySecret}
                    onChange={(e) => setOssKeySecret(e.target.value)}
                    placeholder="••••••••••••"
                    className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-1.5 text-xs text-zinc-100 font-mono focus:outline-none"
                  />
                </div>
              </div>
            </div>
          )}

          {activeTab === 'ai' && (
            <div className="space-y-3">
              <p className="text-xs text-zinc-400">
                配置用于【AI 智能分拣整理】的大模型接口（默认免配置即可使用内置离线规则引擎）：
              </p>
              <div>
                <label className="block text-xs text-zinc-400 mb-1">模型提供商</label>
                <select
                  value={aiProvider}
                  onChange={(e) => setAiProvider(e.target.value as any)}
                  className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-1.5 text-xs text-zinc-100 focus:outline-none"
                >
                  <option value="gemini">Google Gemini (推荐: 速度极快)</option>
                  <option value="deepseek">DeepSeek (性价比高)</option>
                  <option value="openai">OpenAI / 兼容中转</option>
                </select>
              </div>
              <div>
                <label className="block text-xs text-zinc-400 mb-1">API Key</label>
                <input
                  type="password"
                  value={aiKey}
                  onChange={(e) => setAiKey(e.target.value)}
                  placeholder="AIzaSy... 或 sk-..."
                  className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-1.5 text-xs text-zinc-100 font-mono focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-xs text-zinc-400 mb-1">模型代号 (Model)</label>
                <input
                  type="text"
                  value={aiModel}
                  onChange={(e) => setAiModel(e.target.value)}
                  placeholder="gemini-2.5-flash / deepseek-chat"
                  className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-1.5 text-xs text-zinc-100 font-mono focus:outline-none"
                />
              </div>
            </div>
          )}

          {activeTab === 'backup' && (
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
                  onClick={() => exportBackup(state)}
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
                <label className="px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-xs text-zinc-100 font-medium flex items-center gap-1.5 cursor-pointer shrink-0 transition-colors">
                  <Upload className="w-3.5 h-3.5" />
                  选择文件
                  <input type="file" accept=".json,.enc.json" onChange={handleImportFile} className="hidden" />
                </label>
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
