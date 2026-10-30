import React, { useState, useEffect } from 'react';
import { Sparkles, Check, X, Globe, Server, Key, FileText, AlertCircle, Clock, Folder, Edit2, ShieldCheck } from 'lucide-react';
import { AiConfig, NavSite, ServerDeployment, SecretItem, QuickNote, ReminderItem } from '../../types';
import { parseTextWithLLM, ParsedEntities } from '../../lib/aiParser';
import { maskSecrets, rehydrateValue, describeFindings, type MaskResult } from '../../lib/secretMask';
import { encryptText, createMaskedPreview } from '../../lib/crypto';
import { SiteIcon } from '../SiteIcon';

interface AiIngestModalProps {
  isOpen: boolean;
  onClose: () => void;
  categories: string[];
  aiConfig: AiConfig;
  masterPassword: string | null;
  onRequireUnlock: () => void;
  onBatchImport: (data: {
    sites: NavSite[];
    servers: ServerDeployment[];
    secrets: SecretItem[];
    notes: QuickNote[];
    reminders: ReminderItem[];
  }) => void;
}

export const AiIngestModal: React.FC<AiIngestModalProps> = ({
  isOpen,
  onClose,
  categories,
  aiConfig,
  masterPassword,
  onRequireUnlock,
  onBatchImport
}) => {
  const [rawText, setRawText] = useState('');
  const [loading, setLoading] = useState(false);
  const [parsedResult, setParsedResult] = useState<ParsedEntities | null>(null);
  const [maskInfo, setMaskInfo] = useState<MaskResult | null>(null);
  const [errorMsg, setErrorMsg] = useState('');
  const [importing, setImporting] = useState(false);

  // Destination custom mapping overrides
  const [siteCategories, setSiteCategories] = useState<Record<number, string>>({});
  const [secretCategories, setSecretCategories] = useState<Record<number, 'api_key' | 'ssh_key' | 'token'>>({});
  const [serverEnvs, setServerEnvs] = useState<Record<number, 'prod' | 'test' | 'dev'>>({});

  // Start every open from a blank slate (a stale confirmation screen used to
  // reappear with the previous batch still queued).
  useEffect(() => {
    if (isOpen) {
      setRawText('');
      setParsedResult(null);
      setErrorMsg('');
      setLoading(false);
      setImporting(false);
      setSiteCategories({});
      setSecretCategories({});
      setServerEnvs({});
    }
  }, [isOpen]);

  // Global window keydown listener for ESC
  useEffect(() => {
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

  const handleSampleFill = () => {
    setRawText(`生产测试服务器 1.2.3.4 root 端口22 (下个月18号到期需续费¥199)
常用开发平台：https://github.com 我的个人代码仓库托管
经常刷的技术社区：https://juejin.cn 稀土掘金前端，还有 V2EX 论坛 https://v2ex.com
ChatGPT Plus 订阅：每月20号自动扣款 $20
Google Gemini API Key: AIzaSyDemoKeyExampleDoNotUseInProd 用于主力AI代码助手
生产环境规范：部署到静态托管，后端 Docker 容器更新前一定要验证 Redis 缓存。`);
  };

  const handleAnalyze = async () => {
    if (!rawText.trim()) return;
    setLoading(true);
    setErrorMsg('');
    setMaskInfo(null);
    try {
      const cloudOn = Boolean(aiConfig.apiKey && aiConfig.cloudAiEnabled === true);

      // Cloud path: mask credentials before anything leaves the device, then put
      // the real values back locally if the model echoed our placeholders.
      // Local path: use the original text — it never leaves the browser and the
      // engine needs the real values in order to encrypt and store them.
      const mask = cloudOn ? maskSecrets(rawText) : null;
      setMaskInfo(mask && mask.findings.length > 0 ? mask : null);

      const result = await parseTextWithLLM(mask ? mask.masked : rawText, aiConfig);

      if (mask) {
        result.secrets = (result.secrets || []).map((s) => ({
          ...s,
          rawValue: rehydrateValue(s.rawValue, mask.values) ?? s.rawValue
        }));
      }

      setParsedResult(result);
    } catch (err: any) {
      setErrorMsg(err.message || '解析失败，请检查输入或重试');
    } finally {
      setLoading(false);
    }
  };

  const handleConfirmImport = async () => {
    if (!parsedResult || importing) return;

    if (parsedResult.secrets.length > 0 && !masterPassword) {
      alert('检测到敏感凭证需要加密，请先输入主密码解锁金库后再入库！');
      onRequireUnlock();
      return;
    }

    setImporting(true);

    // The import body awaits crypto (encryptText). If that throws — a non-secure
    // context has no crypto.subtle — the button used to stay stuck on
    // "正在加密入库..." forever with no error anywhere.
    try {
      // 1. Prepare sites with customized categories
      const newSites: NavSite[] = parsedResult.sites.map((s, idx) => ({
        id: `site-${Date.now()}-${idx}`,
        title: s.title || '未命名网站',
        url: s.url || '#',
        category: siteCategories[idx] || s.category || categories[1] || '常用工具',
        description: s.description || '',
        createdAt: Date.now()
      }));

      // 2. Prepare servers with customized environments
      const newServers: ServerDeployment[] = parsedResult.servers.map((srv, idx) => ({
        id: `srv-${Date.now()}-${idx}`,
        name: srv.name || '自研服务',
        publicIp: srv.publicIp || '127.0.0.1',
        port: srv.port || 22,
        env: serverEnvs[idx] || srv.env || 'prod',
        sshUser: srv.sshUser || 'root',
        sshCommand: srv.sshCommand || `ssh ${srv.sshUser || 'root'}@${srv.publicIp || '127.0.0.1'}`,
        notes: srv.notes || '',
        status: 'unknown',
        createdAt: Date.now()
      }));

    // 3. Prepare secrets (AES-256 encrypted)
    const newSecrets: SecretItem[] = [];
    const skippedSecrets: string[] = [];
    if (masterPassword) {
      for (let i = 0; i < parsedResult.secrets.length; i++) {
        const sec = parsedResult.secrets[i];

        // Already-encrypted payload (importing a Self-Hub export): keep the original
        // ciphertext. Re-encrypting a missing rawValue used to store a credential
        // that decrypts to an empty string and loses the original secret forever.
        if (sec.encryptedValue && sec.iv && sec.salt) {
          newSecrets.push({
            id: `sec-${Date.now()}-${i}`,
            name: sec.name,
            category: (secretCategories[i] || sec.category || 'api_key') as SecretItem['category'],
            encryptedValue: sec.encryptedValue,
            iv: sec.iv,
            salt: sec.salt,
            maskedPreview: sec.maskedPreview || '••••••••',
            description: sec.description,
            tags: sec.tags,
            updatedAt: Date.now()
          });
          continue;
        }

        if (!sec.rawValue || !String(sec.rawValue).trim()) {
          skippedSecrets.push(sec.name || `第 ${i + 1} 条凭据`);
          continue;
        }

        const encrypted = await encryptText(sec.rawValue, masterPassword);
        newSecrets.push({
          id: `sec-${Date.now()}-${i}`,
          name: sec.name,
          category: (secretCategories[i] || sec.category || 'api_key') as SecretItem['category'],
          encryptedValue: encrypted.ciphertext,
          iv: encrypted.iv,
          salt: encrypted.salt,
          maskedPreview: createMaskedPreview(sec.rawValue),
          description: sec.description,
          tags: sec.tags,
          updatedAt: Date.now()
        });
      }
      if (skippedSecrets.length > 0) {
        alert(
          `⚠️ 以下 ${skippedSecrets.length} 条凭据缺少明文内容，已跳过（不会写入空凭据）：\n${skippedSecrets.join('、')}`
        );
      }
    } else if (parsedResult.secrets.length > 0) {
      alert(
        `⚠️ 检测到 ${parsedResult.secrets.length} 条敏感凭据，但金库处于锁定状态，本次未导入。请先解锁金库后重试。`
      );
    }

    // 4. Prepare notes
    const newNotes: QuickNote[] = parsedResult.notes.map((n, idx) => ({
      id: `note-${Date.now()}-${idx}`,
      title: n.title || '快速知识便签',
      content: n.content || '',
      category: n.category || 'AI智能整理',
      updatedAt: Date.now()
    }));

    // 5. Detect and prepare reminders from text. The date is a heuristic — the
    // parser cannot read real dates yet, so label the estimate instead of
    // presenting a made-up day as fact.
    const newReminders: ReminderItem[] = [];
    if (rawText.includes('续费') || rawText.includes('到期') || rawText.includes('Plus') || rawText.includes('扣款')) {
      newReminders.push({
        id: `rem-ai-${Date.now()}`,
        title: 'AI 自动提取续费提醒项（到期日为估算，请核对修改）',
        category: 'subscription',
        targetDate: Date.now() + 86400000 * 30,
        recurring: 'monthly',
        notes: '由 AI 智能整理自动识别的时效提醒。暂未解析文中的真实日期，默认按 30 天后估算，请在提醒页改成准确日期。',
        createdAt: Date.now()
      });
    }

    onBatchImport({
      sites: newSites,
      servers: newServers,
      secrets: newSecrets,
      notes: newNotes,
      reminders: newReminders
    });

    onClose();
    setParsedResult(null);
    setRawText('');
    } catch (err: any) {
      setErrorMsg(`入库失败：${err?.message || err}`);
    } finally {
      setImporting(false);
    }
  };

  // Closing guard: the backdrop used to discard a finished parse (or typed
  // text) with a single stray click, with no way back.
  const requestClose = () => {
    if ((rawText.trim() || parsedResult) && !importing &&
        !window.confirm('当前内容尚未入库，关闭会丢弃这些内容，确定吗？')) {
      return;
    }
    onClose();
  };

  return (
    <div
      onClick={requestClose}
      role="dialog"
      aria-modal="true"
      aria-label="AI 内容整理"
      className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-black/80 backdrop-blur-sm animate-in fade-in"
    >
      <div 
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-4xl max-h-[90vh] bg-sh-surface border border-zinc-800 rounded-2xl flex flex-col shadow-2xl overflow-hidden animate-in slide-in-from-bottom-2"
      >
        
        {/* Header */}
        <div className="flex items-center justify-between p-4 sm:p-5 border-b border-zinc-800">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-zinc-800 flex items-center justify-center text-zinc-100">
              <Sparkles className="w-4 h-4 text-amber-400" />
            </div>
            <div>
              <h2 className="text-xs sm:text-sm font-semibold text-zinc-100">AI 高精准分拣与存储位置指定</h2>
              <p className="text-[11px] sm:text-xs text-zinc-400">
                支持粘贴微信、聊天记录与乱七八糟笔记，AI 解析后由您在预览中自主选择存储分区
              </p>
            </div>
          </div>
          <button onClick={requestClose} aria-label="关闭整理窗口" className="p-1 rounded-lg hover:bg-zinc-800 text-zinc-400 hover:text-white">
            <X className="w-4 h-4" aria-hidden />
          </button>
        </div>

        {/* Content Body */}
        <div className="p-4 sm:p-5 overflow-y-auto space-y-4">
          {!parsedResult ? (
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-xs font-medium text-zinc-300">
                  粘贴您要整理的大段文本：
                </label>
                <button
                  onClick={handleSampleFill}
                  className="text-xs text-sky-400 hover:underline"
                >
                  填入高保真实测样例
                </button>
              </div>

              <textarea
                value={rawText}
                onChange={(e) => setRawText(e.target.value)}
                rows={9}
                placeholder="直接粘贴任意杂乱文本，例如：\n测试服务器 1.2.3.4 root 端口22 (下个月18号到期需续费¥199)\n平时刷的网站 https://juejin.cn\nChatGPT Plus 订阅：每月20号扣款 $20\nAPI Key: sk-example-938210931209312388421\n关于架构和Docker配置的长篇备忘..."
                className="w-full bg-zinc-900 border border-zinc-800 rounded-xl p-3.5 text-xs text-zinc-200 font-mono placeholder-zinc-600 focus:outline-none focus:border-zinc-700 resize-none leading-relaxed"
              />

              {errorMsg && (
                <div className="flex items-center gap-2 p-3 rounded-lg bg-red-950/40 border border-red-800/40 text-red-400 text-xs mt-2">
                  <AlertCircle className="w-4 h-4 shrink-0" />
                  <span>{errorMsg}</span>
                </div>
              )}

              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mt-4">
                <span className="text-xs text-zinc-400 font-mono">
                  {aiConfig.apiKey && aiConfig.cloudAiEnabled === true
                    ? `云端引擎: ${aiConfig.model || 'Gemini 2.5 Flash'}（内容会发送到该服务商）`
                    : '内置本地规则引擎（离线即时，内容不离开本机）'}
                </span>

                <button
                  onClick={handleAnalyze}
                  disabled={loading || !rawText.trim()}
                  className="px-4 py-2 rounded-xl bg-zinc-100 text-zinc-900 hover:bg-white text-xs font-semibold flex items-center justify-center gap-2 transition-all disabled:opacity-50 shadow-sm"
                >
                  <Sparkles className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
                  <span>{loading ? '正在解析语义与结构...' : '开始高精准识别'}</span>
                </button>
              </div>

              {/* Be explicit about the privacy boundary before anything is sent. */}
              {aiConfig.apiKey && aiConfig.cloudAiEnabled === true && (
                <div
                  className="mt-3 flex items-start gap-2 rounded-xl border border-amber-900/60 bg-amber-950/25 px-3 py-2 text-[11px] text-amber-300 leading-relaxed"
                  data-testid="cloud-ai-warning"
                >
                  <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>
                    当前会把下面这段文字发送到 <b>{aiConfig.provider}</b>。请确认其中没有真实的 API Key、
                    SSH 密码或数据库连接串——这类内容一旦发送就离开了本机。
                    可在「设置 → 连接与任务 → AI 模型」里关闭云端 AI，改用本地规则。
                  </span>
                </div>
              )}

              {/* What the masker removed before sending. */}
              {maskInfo && maskInfo.findings.length > 0 && (
                <div
                  className="mt-3 rounded-xl border border-emerald-900/60 bg-emerald-950/25 px-3 py-2 text-[11px] text-emerald-300 leading-relaxed"
                  data-testid="mask-report"
                >
                  <div className="flex items-center gap-2">
                    <ShieldCheck className="w-4 h-4 shrink-0" />
                    <span>{describeFindings(maskInfo.findings)}，发送前已替换为占位符。</span>
                  </div>
                  <ul className="mt-2 space-y-0.5 font-mono text-[10px] text-emerald-200/80">
                    {maskInfo.findings.map((f, i) => (
                      <li key={i} data-mask-kind={f.kind}>
                        {f.kind}：{f.preview}
                      </li>
                    ))}
                  </ul>
                  <p className="mt-2 text-[10px] text-emerald-200/70">
                    原始值只在本机保存；若模型原样保留占位符，入库时会自动还原为真实值。
                  </p>
                </div>
              )}
            </div>
          ) : (
            /* Review & Destination Selector Screen */
            <div className="space-y-4">
              <div className="flex items-center justify-between bg-zinc-900/60 p-3 rounded-xl border border-zinc-800">
                <div className="text-xs text-zinc-300">
                  ✅ 识别完成，请在下方<strong>核对并指定各项存储分区</strong>：
                </div>
                <button
                  onClick={() => setParsedResult(null)}
                  className="text-xs text-zinc-400 hover:text-zinc-200 underline"
                >
                  重新输入
                </button>
              </div>

              {/* A failed cloud call used to fall back silently, which looked like
                  success. Say it out loud, with the provider's reason. */}
              {parsedResult.warning && (
                <div
                  className="rounded-xl border border-amber-900/60 bg-amber-950/25 px-3 py-2 text-[11px] text-amber-300 leading-relaxed"
                  data-testid="ai-fallback-warning"
                >
                  <div className="flex items-start gap-2">
                    <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                    <div>
                      <div className="font-medium">云端 AI 调用失败，已改用本地规则</div>
                      <p className="mt-1 font-mono text-[10px] text-amber-200/80 break-all">
                        {parsedResult.warning}
                      </p>
                      <p className="mt-1 text-[10px] text-amber-200/70">
                        常见原因：模型名与服务商不匹配、Key 失效或额度用尽。可到「设置 → 连接与任务 → AI 模型」核对。
                      </p>
                    </div>
                  </div>
                </div>
              )}
              {/* Keep the masking notice visible on the result screen too — the user
                  should still be able to see what was withheld from the provider. */}
              {maskInfo && maskInfo.findings.length > 0 && (
                <div
                  className="rounded-xl border border-emerald-900/60 bg-emerald-950/25 px-3 py-2 text-[11px] text-emerald-300 leading-relaxed"
                  data-testid="mask-report"
                >
                  <div className="flex items-center gap-2">
                    <ShieldCheck className="w-4 h-4 shrink-0" />
                    <span>{describeFindings(maskInfo.findings)}，发送前已替换为占位符。</span>
                  </div>
                  <ul className="mt-2 space-y-0.5 font-mono text-[10px] text-emerald-200/80">
                    {maskInfo.findings.map((f, i) => (
                      <li key={i} data-mask-kind={f.kind}>
                        {f.kind}：{f.preview}
                      </li>
                    ))}
                  </ul>
                  <p className="mt-2 text-[10px] text-emerald-200/70">
                    原始值只在本机保存；入库时会自动还原为真实值。
                  </p>
                </div>
              )}

              {/* Sites with Destination Category Selector */}
              {parsedResult.sites.length > 0 && (
                <div className="space-y-2">
                  <h4 className="text-xs font-semibold text-zinc-400 flex items-center gap-1.5">
                    <Globe className="w-3.5 h-3.5 text-sky-400" />
                    网站与工具 ({parsedResult.sites.length}) · 请确认存储分类
                  </h4>
                  <div className="space-y-2">
                    {parsedResult.sites.map((s, i) => (
                      <div key={i} className="p-3 rounded-xl bg-zinc-900/70 border border-zinc-800 flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
                        <div className="flex items-center gap-2.5 min-w-0 flex-1">
                          <SiteIcon url={s.url || ''} title={s.title} size={28} rounded="md" />
                          <div className="min-w-0 flex-1">
                            <div className="font-semibold text-zinc-200 text-xs truncate">{s.title}</div>
                            <div className="text-zinc-400 font-mono text-[11px] truncate">{s.url}</div>
                          </div>
                        </div>

                        {/* Storage Category Selector */}
                        <div className="flex items-center gap-2 shrink-0">
                          <span className="text-[11px] text-zinc-400 whitespace-nowrap">存入分类:</span>
                          <select
                            value={siteCategories[i] || s.category || categories[1] || '常用工具'}
                            onChange={(e) => setSiteCategories(prev => ({ ...prev, [i]: e.target.value }))}
                            className="bg-zinc-800 border border-zinc-700 text-xs text-zinc-200 rounded-lg px-2 py-1 focus:outline-none"
                          >
                            {Array.from(new Set([
                              ...categories.filter(c => c !== '全部'),
                              ...(parsedResult ? parsedResult.sites.map(item => item.category).filter(Boolean) as string[] : [])
                            ])).map(cat => (
                              <option key={cat} value={cat}>{cat}</option>
                            ))}
                          </select>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Servers with Env Selector */}
              {parsedResult.servers.length > 0 && (
                <div className="space-y-2">
                  <h4 className="text-xs font-semibold text-zinc-400 flex items-center gap-1.5">
                    <Server className="w-3.5 h-3.5 text-emerald-400" />
                    服务器与主机部署 ({parsedResult.servers.length}) · 请选择环境级别
                  </h4>
                  <div className="space-y-2">
                    {parsedResult.servers.map((srv, i) => (
                      <div key={i} className="p-3 rounded-xl bg-zinc-900/70 border border-zinc-800 flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
                        <div className="min-w-0 flex-1">
                          <div className="font-semibold text-zinc-200 text-xs truncate">{srv.name}</div>
                          <div className="text-zinc-400 font-mono text-[11px]">
                            {srv.publicIp}:{srv.port} ({srv.sshUser})
                          </div>
                        </div>

                        <div className="flex items-center gap-2 shrink-0">
                          <span className="text-[11px] text-zinc-400 whitespace-nowrap">部署级别:</span>
                          <select
                            value={serverEnvs[i] || srv.env || 'prod'}
                            onChange={(e) => setServerEnvs(prev => ({ ...prev, [i]: e.target.value as any }))}
                            className="bg-zinc-800 border border-zinc-700 text-xs text-zinc-200 rounded-lg px-2 py-1 focus:outline-none"
                          >
                            <option value="prod">生产环境 (PROD)</option>
                            <option value="test">测试环境 (TEST)</option>
                            <option value="dev">本地/开发 (DEV)</option>
                          </select>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Secrets with Category Selector */}
              {parsedResult.secrets.length > 0 && (
                <div className="space-y-2">
                  <h4 className="text-xs font-semibold text-zinc-400 flex items-center gap-1.5">
                    <Key className="w-3.5 h-3.5 text-amber-400" />
                    敏感凭据 (将以 AES-256 加密存入金库) ({parsedResult.secrets.length})
                  </h4>
                  <div className="space-y-2">
                    {parsedResult.secrets.map((sec, i) => (
                      <div key={i} className="p-3 rounded-xl bg-zinc-900/70 border border-amber-900/40 flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
                        <div className="min-w-0 flex-1">
                          <div className="font-semibold text-zinc-200 text-xs truncate">{sec.name}</div>
                          <div className="text-zinc-400 font-mono text-[11px]">
                            {sec.encryptedValue
                              ? `${sec.maskedPreview || '••••••••'}（已是加密凭据，将原样保留）`
                              : sec.rawValue
                                ? createMaskedPreview(sec.rawValue)
                                : '⚠️ 缺少明文内容，导入时将跳过'}
                          </div>
                        </div>

                        <div className="flex items-center gap-2 shrink-0">
                          <span className="text-[11px] text-zinc-400 whitespace-nowrap">凭证类型:</span>
                          <select
                            value={secretCategories[i] || sec.category || 'api_key'}
                            onChange={(e) => setSecretCategories(prev => ({ ...prev, [i]: e.target.value as any }))}
                            className="bg-zinc-800 border border-zinc-700 text-xs text-zinc-200 rounded-lg px-2 py-1 focus:outline-none"
                          >
                            <option value="api_key">API Key</option>
                            <option value="ssh_key">SSH 秘钥口令</option>
                            <option value="token">Token 访问令牌</option>
                          </select>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Extracted Knowledge Notes */}
              {parsedResult.notes.length > 0 && (
                <div className="space-y-2">
                  <h4 className="text-xs font-semibold text-zinc-400 flex items-center gap-1.5">
                    <FileText className="w-3.5 h-3.5 text-purple-400" />
                    深度知识与备忘 ({parsedResult.notes.length}) · 存入知识库
                  </h4>
                  <div className="space-y-2">
                    {parsedResult.notes.map((n, i) => (
                      <div key={i} className="p-3 rounded-xl bg-zinc-900/70 border border-zinc-800 text-xs">
                        <div className="font-semibold text-zinc-200 mb-1">{n.title}</div>
                        <div className="text-zinc-400 font-mono text-[11px] line-clamp-2">{n.content}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Action Buttons */}
              <div className="flex items-center justify-end gap-2 pt-4 border-t border-zinc-800">
                <button
                  onClick={() => setParsedResult(null)}
                  className="px-4 py-2 rounded-xl bg-zinc-900 hover:bg-zinc-800 text-zinc-300 text-xs"
                >
                  放弃重置
                </button>
                <button
                  onClick={handleConfirmImport}
                  disabled={importing}
                  className="px-4 py-2 rounded-xl bg-zinc-100 text-zinc-900 hover:bg-white text-xs font-semibold flex items-center gap-1.5 shadow-sm disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  <Check className="w-3.5 h-3.5" />
                  <span>{importing ? '正在加密入库...' : '确认存储位置，一键全部入库'}</span>
                </button>
              </div>
            </div>
          )}
        </div>

      </div>
    </div>
  );
};




