import React, { useState, useEffect } from 'react';
import { X, Plus, Globe, Server, Key, CheckSquare, FileText, Check, AlertCircle } from 'lucide-react';
import { NavSite, ServerDeployment, SecretItem, CheckInTask, QuickNote } from '../../types';
import { encryptText, createMaskedPreview } from '../../lib/crypto';

interface AddItemModalProps {
  isOpen: boolean;
  onClose: () => void;
  categories: string[];
  masterPassword: string | null;
  onRequireUnlock: () => void;
  onAddSite: (site: NavSite) => void;
  onAddServer: (server: ServerDeployment) => void;
  onAddSecret: (secret: SecretItem) => void;
  onAddCheckIn: (task: CheckInTask) => void;
  onAddNote: (note: QuickNote) => void;
}

export const AddItemModal: React.FC<AddItemModalProps> = ({
  isOpen,
  onClose,
  categories,
  masterPassword,
  onRequireUnlock,
  onAddSite,
  onAddServer,
  onAddSecret,
  onAddCheckIn,
  onAddNote
}) => {
  const [activeType, setActiveType] = useState<'site' | 'server' | 'secret' | 'checkin' | 'note'>('site');

  // Site form
  const [siteTitle, setSiteTitle] = useState('');
  const [siteUrl, setSiteUrl] = useState('');
  const [siteCategory, setSiteCategory] = useState(categories[1] || '常用工具');
  const [siteDesc, setSiteDesc] = useState('');

  // Server form
  const [serverName, setServerName] = useState('');
  const [serverDomain, setServerDomain] = useState('');
  const [serverIp, setServerIp] = useState('');
  const [serverPort, setServerPort] = useState(22);
  const [serverEnv, setServerEnv] = useState<'prod' | 'test' | 'dev'>('prod');
  const [serverUser, setServerUser] = useState('root');
  const [serverNotes, setServerNotes] = useState('');

  // Secret form
  const [secretName, setSecretName] = useState('');
  const [secretCategory, setSecretCategory] = useState<'api_key' | 'ssh_key' | 'db_credential' | 'token'>('api_key');
  const [secretRaw, setSecretRaw] = useState('');
  const [secretDesc, setSecretDesc] = useState('');

  // CheckIn form
  const [checkInName, setCheckInName] = useState('');
  const [checkInUrl, setCheckInUrl] = useState('');
  const [checkInType, setCheckInType] = useState<'http' | 'redirect'>('redirect');

  // Note form
  const [noteTitle, setNoteTitle] = useState('');
  const [noteContent, setNoteContent] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState('');

  // Wipe the form (including any pasted plaintext secret) whenever the modal closes.
  useEffect(() => {
    if (isOpen) {
      setFormError('');
      setSubmitting(false);
      setSiteTitle('');
      setSiteUrl('');
      setSiteDesc('');
      setSiteCategory(categories.filter((c) => c !== '全部')[0] || '常用工具');
      setServerName('');
      setServerDomain('');
      setServerIp('');
      setServerPort(22);
      setServerEnv('prod');
      setServerUser('root');
      setServerNotes('');
      setSecretName('');
      setSecretRaw('');
      setSecretDesc('');
      setCheckInName('');
      setCheckInUrl('');
      setCheckInType('redirect');
      setNoteTitle('');
      setNoteContent('');
      setActiveType('site');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setFormError('');

    if (activeType === 'site') {
      if (!siteTitle.trim() || !siteUrl.trim()) {
        setFormError('请填写网站名称与 URL 网址');
        return;
      }
      onAddSite({
        id: `site-${Date.now()}`,
        title: siteTitle.trim(),
        url: siteUrl.startsWith('http') ? siteUrl : `https://${siteUrl}`,
        category: siteCategory,
        description: siteDesc,
        icon: 'Globe',
        createdAt: Date.now()
      });
      onClose();
    } else if (activeType === 'server') {
      if (!serverName.trim() || !serverIp.trim()) {
        setFormError('请填写服务名称与公网 IP');
        return;
      }
      onAddServer({
        id: `srv-${Date.now()}`,
        name: serverName.trim(),
        domain: serverDomain,
        publicIp: serverIp.trim(),
        port: Number(serverPort) || 22,
        env: serverEnv,
        sshUser: serverUser,
        sshCommand: `ssh ${serverUser}@${serverIp}${Number(serverPort) && Number(serverPort) !== 22 ? ` -p ${serverPort}` : ''}`,
        notes: serverNotes,
        status: 'online',
        createdAt: Date.now()
      });
      onClose();
    } else if (activeType === 'secret') {
      if (!secretName.trim() || !secretRaw.trim()) {
        setFormError('请填写凭据名称与明文内容');
        return;
      }
      if (!masterPassword) {
        setFormError('安全金库处于锁定状态，请先在解锁弹窗中输入主密码（该弹窗已置于最上层）。');
        onRequireUnlock();
        return;
      }
      try {
        setSubmitting(true);
        const encrypted = await encryptText(secretRaw, masterPassword);
        onAddSecret({
          id: `sec-${Date.now()}`,
          name: secretName.trim(),
          category: secretCategory,
          encryptedValue: encrypted.ciphertext,
          iv: encrypted.iv,
          salt: encrypted.salt,
          maskedPreview: createMaskedPreview(secretRaw),
          description: secretDesc,
          updatedAt: Date.now()
        });
        onClose();
      } catch (err) {
        setFormError(`加密失败：${(err as Error)?.message || err}`);
      } finally {
        setSubmitting(false);
      }
    } else if (activeType === 'checkin') {
      if (!checkInName.trim() || !checkInUrl.trim()) {
        setFormError('请填写签到任务名称与 URL');
        return;
      }
      onAddCheckIn({
        id: `chk-${Date.now()}`,
        name: checkInName.trim(),
        url: checkInUrl.trim(),
        method: 'GET',
        type: checkInType,
        streakDays: 0,
        createdAt: Date.now()
      });
      onClose();
    } else if (activeType === 'note') {
      if (!noteTitle.trim() || !noteContent.trim()) {
        setFormError('请填写便签标题与内容');
        return;
      }
      onAddNote({
        id: `note-${Date.now()}`,
        title: noteTitle.trim(),
        content: noteContent,
        updatedAt: Date.now()
      });
      onClose();
    }
  };

  return (
    <div 
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-black/80 backdrop-blur-sm animate-in fade-in"
    >
      <div 
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-lg bg-[#121316] border border-zinc-800 rounded-2xl shadow-2xl overflow-hidden flex flex-col"
      >
        
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-zinc-800">
          <div className="flex items-center gap-2">
            <Plus className="w-4 h-4 text-zinc-100" />
            <h3 className="text-sm font-semibold text-zinc-100">录入新资产</h3>
          </div>
          <button onClick={onClose} className="p-1 rounded-lg hover:bg-zinc-800 text-zinc-400 hover:text-white">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Tab switch */}
        <div className="flex border-b border-zinc-800 bg-zinc-900/60 p-1">
          <button
            onClick={() => setActiveType('site')}
            className={`flex-1 py-1.5 text-xs font-medium rounded-lg transition-colors flex items-center justify-center gap-1.5 ${
              activeType === 'site' ? 'bg-zinc-800 text-white shadow-sm' : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            <Globe className="w-3.5 h-3.5" />
            网站
          </button>
          <button
            onClick={() => setActiveType('server')}
            className={`flex-1 py-1.5 text-xs font-medium rounded-lg transition-colors flex items-center justify-center gap-1.5 ${
              activeType === 'server' ? 'bg-zinc-800 text-white shadow-sm' : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            <Server className="w-3.5 h-3.5" />
            部署
          </button>
          <button
            onClick={() => setActiveType('secret')}
            className={`flex-1 py-1.5 text-xs font-medium rounded-lg transition-colors flex items-center justify-center gap-1.5 ${
              activeType === 'secret' ? 'bg-zinc-800 text-white shadow-sm' : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            <Key className="w-3.5 h-3.5" />
            金库凭据
          </button>
          <button
            onClick={() => setActiveType('checkin')}
            className={`flex-1 py-1.5 text-xs font-medium rounded-lg transition-colors flex items-center justify-center gap-1.5 ${
              activeType === 'checkin' ? 'bg-zinc-800 text-white shadow-sm' : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            <CheckSquare className="w-3.5 h-3.5" />
            签到
          </button>
          <button
            onClick={() => setActiveType('note')}
            className={`flex-1 py-1.5 text-xs font-medium rounded-lg transition-colors flex items-center justify-center gap-1.5 ${
              activeType === 'note' ? 'bg-zinc-800 text-white shadow-sm' : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            <FileText className="w-3.5 h-3.5" />
            便签
          </button>
        </div>

        {/* Form Body */}
        <form onSubmit={handleSubmit} className="p-5 space-y-3.5 overflow-y-auto max-h-[70vh]">
          {activeType === 'site' && (
            <>
              <div>
                <label className="block text-xs text-zinc-400 mb-1">网站名称</label>
                <input
                  type="text"
                  required
                  value={siteTitle}
                  onChange={(e) => setSiteTitle(e.target.value)}
                  placeholder="例如: GitHub 个人中心"
                  className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-1.5 text-xs text-zinc-100 focus:outline-none focus:border-zinc-700"
                />
              </div>
              <div>
                <label className="block text-xs text-zinc-400 mb-1">URL 网址</label>
                <input
                  type="text"
                  required
                  value={siteUrl}
                  onChange={(e) => setSiteUrl(e.target.value)}
                  placeholder="https://..."
                  className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-1.5 text-xs text-zinc-100 font-mono focus:outline-none focus:border-zinc-700"
                />
              </div>
              <div>
                <label className="block text-xs text-zinc-400 mb-1">所属分类</label>
                <select
                  value={siteCategory}
                  onChange={(e) => setSiteCategory(e.target.value)}
                  className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-1.5 text-xs text-zinc-100 focus:outline-none"
                >
                  {categories.filter(c => c !== '全部').map(c => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs text-zinc-400 mb-1">简要描述 (可选)</label>
                <input
                  type="text"
                  value={siteDesc}
                  onChange={(e) => setSiteDesc(e.target.value)}
                  placeholder="用于搜索与快速备忘..."
                  className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-1.5 text-xs text-zinc-100 focus:outline-none focus:border-zinc-700"
                />
              </div>
            </>
          )}

          {activeType === 'server' && (
            <>
              <div>
                <label className="block text-xs text-zinc-400 mb-1">服务/节点名称</label>
                <input
                  type="text"
                  required
                  value={serverName}
                  onChange={(e) => setServerName(e.target.value)}
                  placeholder="例如: 生产核心服务节点"
                  className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-1.5 text-xs text-zinc-100 focus:outline-none focus:border-zinc-700"
                />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <div>
                  <label className="block text-xs text-zinc-400 mb-1">公网 IP</label>
                  <input
                    type="text"
                    required
                    value={serverIp}
                    onChange={(e) => setServerIp(e.target.value)}
                    placeholder="1.2.3.4"
                    className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-1.5 text-xs text-zinc-100 font-mono focus:outline-none focus:border-zinc-700"
                  />
                </div>
                <div>
                  <label className="block text-xs text-zinc-400 mb-1">端口</label>
                  <input
                    type="number"
                    value={serverPort}
                    onChange={(e) => setServerPort(Number(e.target.value))}
                    className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-1.5 text-xs text-zinc-100 font-mono focus:outline-none focus:border-zinc-700"
                  />
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <div>
                  <label className="block text-xs text-zinc-400 mb-1">绑定域名 (可选)</label>
                  <input
                    type="text"
                    value={serverDomain}
                    onChange={(e) => setServerDomain(e.target.value)}
                    placeholder="my-server.example.com"
                    className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-1.5 text-xs text-zinc-100 font-mono focus:outline-none focus:border-zinc-700"
                  />
                </div>
                <div>
                  <label className="block text-xs text-zinc-400 mb-1">部署环境</label>
                  <select
                    value={serverEnv}
                    onChange={(e) => setServerEnv(e.target.value as any)}
                    className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-1.5 text-xs text-zinc-100 focus:outline-none"
                  >
                    <option value="prod">生产环境 (PROD)</option>
                    <option value="test">测试环境 (TEST)</option>
                    <option value="dev">本地/开发 (DEV)</option>
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-xs text-zinc-400 mb-1">SSH 用户名</label>
                <input
                  type="text"
                  value={serverUser}
                  onChange={(e) => setServerUser(e.target.value)}
                  placeholder="root"
                  className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-1.5 text-xs text-zinc-100 font-mono focus:outline-none focus:border-zinc-700"
                />
              </div>
            </>
          )}

          {activeType === 'secret' && (
            <>
              <div>
                <label className="block text-xs text-zinc-400 mb-1">凭据/密钥名称</label>
                <input
                  type="text"
                  required
                  value={secretName}
                  onChange={(e) => setSecretName(e.target.value)}
                  placeholder="例如: Google Gemini 3.8 API Key"
                  className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-1.5 text-xs text-zinc-100 focus:outline-none focus:border-zinc-700"
                />
              </div>
              <div>
                <label className="block text-xs text-zinc-400 mb-1">凭据分类</label>
                <select
                  value={secretCategory}
                  onChange={(e) => setSecretCategory(e.target.value as any)}
                  className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-1.5 text-xs text-zinc-100 focus:outline-none"
                >
                  <option value="api_key">API Key</option>
                  <option value="ssh_key">SSH 秘钥 / 口令</option>
                  <option value="db_credential">数据库连接账号密码</option>
                  <option value="token">个人 Token / 访问令牌</option>
                </select>
              </div>
              <div>
                <label className="block text-xs text-zinc-400 mb-1">明文内容 (将在前端即时 AES-256 加密)</label>
                <input
                  type="text"
                  required
                  value={secretRaw}
                  onChange={(e) => setSecretRaw(e.target.value)}
                  placeholder="粘贴完整的 Key 或密码..."
                  className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-1.5 text-xs text-zinc-100 font-mono focus:outline-none focus:border-zinc-700"
                />
              </div>
              <div>
                <label className="block text-xs text-zinc-400 mb-1">用途说明</label>
                <input
                  type="text"
                  value={secretDesc}
                  onChange={(e) => setSecretDesc(e.target.value)}
                  placeholder="用于..."
                  className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-1.5 text-xs text-zinc-100 focus:outline-none focus:border-zinc-700"
                />
              </div>
            </>
          )}

          {activeType === 'checkin' && (
            <>
              <div>
                <label className="block text-xs text-zinc-400 mb-1">签到任务名称</label>
                <input
                  type="text"
                  required
                  value={checkInName}
                  onChange={(e) => setCheckInName(e.target.value)}
                  placeholder="例如: V2EX 每日领取银币"
                  className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-1.5 text-xs text-zinc-100 focus:outline-none focus:border-zinc-700"
                />
              </div>
              <div>
                <label className="block text-xs text-zinc-400 mb-1">签到页面或 API URL</label>
                <input
                  type="text"
                  required
                  value={checkInUrl}
                  onChange={(e) => setCheckInUrl(e.target.value)}
                  placeholder="https://..."
                  className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-1.5 text-xs text-zinc-100 font-mono focus:outline-none focus:border-zinc-700"
                />
              </div>
              <div>
                <label className="block text-xs text-zinc-400 mb-1">触发类型</label>
                <select
                  value={checkInType}
                  onChange={(e) => setCheckInType(e.target.value as any)}
                  className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-1.5 text-xs text-zinc-100 focus:outline-none"
                >
                  <option value="redirect">快速跳转直达签到页</option>
                  <option value="http">直接发送 HTTP 请求打卡</option>
                </select>
              </div>
            </>
          )}

          {activeType === 'note' && (
            <>
              <div>
                <label className="block text-xs text-zinc-400 mb-1">便签标题</label>
                <input
                  type="text"
                  required
                  value={noteTitle}
                  onChange={(e) => setNoteTitle(e.target.value)}
                  placeholder="例如: 常用 Git 指令备忘"
                  className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-1.5 text-xs text-zinc-100 focus:outline-none focus:border-zinc-700"
                />
              </div>
              <div>
                <label className="block text-xs text-zinc-400 mb-1">便签内容 (支持 Markdown)</label>
                <textarea
                  required
                  rows={6}
                  value={noteContent}
                  onChange={(e) => setNoteContent(e.target.value)}
                  placeholder="记录内容..."
                  className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-xs text-zinc-100 font-mono focus:outline-none focus:border-zinc-700 resize-none"
                />
              </div>
            </>
          )}

          {formError && (
            <div className="flex items-start gap-2 p-2.5 rounded-lg bg-red-950/40 border border-red-800/40 text-red-400 text-xs">
              <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              <span>{formError}</span>
            </div>
          )}

          <div className="flex items-center justify-end gap-2 pt-3 border-t border-zinc-800">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-xl bg-zinc-900 hover:bg-zinc-800 text-zinc-300 text-xs"
            >
              取消
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="px-4 py-2 rounded-xl bg-zinc-100 text-zinc-900 hover:bg-white text-xs font-semibold flex items-center gap-1.5 shadow-sm disabled:opacity-60 disabled:cursor-not-allowed"
            >
              <Check className="w-3.5 h-3.5" />
              <span>{submitting ? '加密保存中...' : '保存资产'}</span>
            </button>
          </div>
        </form>

      </div>
    </div>
  );
};
