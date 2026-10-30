import React, { useState, useEffect } from 'react';
import { X, Plus, Globe, Server, Key, CheckSquare, FileText, Check, AlertCircle } from 'lucide-react';
import { NavSite, ServerDeployment, SecretItem, CheckInTask, QuickNote } from '../../types';
import { encryptText, createMaskedPreview } from '../../lib/crypto';
import { Hint } from '../../shared/Hint';
import { SiteIcon } from '../SiteIcon';

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
  /**
   * Open on these types only.
   *
   * The global 「+ 新建」 needs the type chooser; a page-level 「添加服务器」 or 「添加凭据」 does
   * not — showing five unrelated tabs under a button that said "add a server" was confusing.
   * When a single type is given, the chooser is hidden and the title names the action.
   */
  onlyTypes?: ItemType[];
  /** Existing server group labels, offered as suggestions for 「归属网站/项目」. */
  serverGroups?: string[];
}

type ItemType = 'site' | 'server' | 'secret' | 'checkin' | 'note';

const TYPE_META: Record<ItemType, { label: string; title: string; icon: typeof Globe }> = {
  site: { label: '网站', title: '新增网站', icon: Globe },
  server: { label: '服务器', title: '新增服务器', icon: Server },
  secret: { label: '凭证', title: '新增凭证', icon: Key },
  checkin: { label: '签到网站', title: '添加签到网站', icon: CheckSquare },
  note: { label: '便签', title: '新增便签', icon: FileText }
};

/** Label suggestions for multi-field credentials (key + secret go in one entry). */
const SECRET_FIELD_SUGGESTIONS = [
  'API Key',
  'API Secret',
  'Access Key ID',
  'Access Key Secret',
  'Token',
  '密码',
  '用户名',
  'Host',
  '端口'
];

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
  onAddNote,
  onlyTypes,
  serverGroups = []
}) => {
  const availableTypes: ItemType[] = onlyTypes?.length ? onlyTypes : ['site', 'server', 'secret', 'checkin', 'note'];
  const [activeType, setActiveType] = useState<ItemType>(availableTypes[0]);
  const singleType = availableTypes.length === 1;
  const meta = TYPE_META[activeType];

  // Site form
  const [siteTitle, setSiteTitle] = useState('');
  const [siteUrl, setSiteUrl] = useState('');
  const [siteCategory, setSiteCategory] = useState(categories[1] || '常用工具');
  const [siteDesc, setSiteDesc] = useState('');

  // Server form
  const [serverName, setServerName] = useState('');
  /** 所属网站/项目：一个网站常常有多台主机（web/db/cdn），列表会按它分组。 */
  const [serverGroup, setServerGroup] = useState('');
  const [serverDomain, setServerDomain] = useState('');
  const [serverIp, setServerIp] = useState('');
  const [serverPort, setServerPort] = useState(22);
  const [serverEnv, setServerEnv] = useState<'prod' | 'test' | 'dev'>('prod');
  const [serverUser, setServerUser] = useState('root');
  const [serverNotes, setServerNotes] = useState('');
  const [serverHealthUrl, setServerHealthUrl] = useState('');

  // Secret form
  const [secretName, setSecretName] = useState('');
  const [secretCategory, setSecretCategory] = useState<'api_key' | 'ssh_key' | 'db_credential' | 'token'>('api_key');
  /** Which site this credential belongs to; several credentials may share one site. */
  const [secretWebsite, setSecretWebsite] = useState('');
  /**
   * Multi-field credential: a real credential is usually key + secret (OSS, DB login…),
   * so one entry can hold several labelled fields, each encrypted on its own.
   */
  const [secretFields, setSecretFields] = useState<Array<{ label: string; value: string }>>([
    { label: '', value: '' }
  ]);
  const [secretDesc, setSecretDesc] = useState('');

  // CheckIn form
  const [checkInName, setCheckInName] = useState('');
  const [checkInUrl, setCheckInUrl] = useState('');

  // Note form
  const [noteTitle, setNoteTitle] = useState('');
  const [noteContent, setNoteContent] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState('');

  // Latest close handler for the ESC listener; requestClose depends on the
  // current form values and must not be captured stale.
  const closeRef = React.useRef<() => void>(() => onClose);

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
      setServerGroup('');
      setServerDomain('');
      setServerIp('');
      setServerPort(22);
      setServerEnv('prod');
      setServerUser('root');
      setServerNotes('');
      setServerHealthUrl('');
      setSecretName('');
      setSecretWebsite('');
      setSecretFields([{ label: '', value: '' }]);
      setSecretDesc('');
      setCheckInName('');
      setCheckInUrl('');
      setNoteTitle('');
      setNoteContent('');
      setActiveType(availableTypes[0]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  // Global window keydown listener for ESC
  useEffect(() => {
    if (!isOpen) return;
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeRef.current();
      }
    };
    window.addEventListener('keydown', handleGlobalKeyDown, true);
    return () => window.removeEventListener('keydown', handleGlobalKeyDown, true);
  }, [isOpen]);

  if (!isOpen) return null;
  /**
   * Closing guard: a credential form can hold pasted plaintext keys and a
   * server form a dozen fields — dropping all of it on a stray backdrop click
   * or ESC is a silent data loss. Ask once when anything was typed.
   */
  const hasUnsavedInput = () => {
    const typed =
      siteTitle.trim() ||
      siteUrl.trim() ||
      siteDesc.trim() ||
      serverName.trim() ||
      serverGroup.trim() ||
      serverDomain.trim() ||
      serverIp.trim() ||
      serverNotes.trim() ||
      serverHealthUrl.trim() ||
      secretName.trim() ||
      secretWebsite.trim() ||
      secretDesc.trim() ||
      checkInName.trim() ||
      checkInUrl.trim() ||
      noteTitle.trim() ||
      noteContent.trim();
    if (typed) return true;
    return secretFields.some((f) => f.label.trim() || f.value.trim());
  };
  const requestClose = () => {
    if (hasUnsavedInput() && !window.confirm('表单里还有未保存的内容，确定丢弃并关闭吗？')) {
      return;
    }
    onClose();
  };
  closeRef.current = requestClose;

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
        group: serverGroup.trim() || undefined,
        domain: serverDomain,
        publicIp: serverIp.trim(),
        port: Number(serverPort) || 22,
        env: serverEnv,
        sshUser: serverUser,
        sshCommand: `ssh ${serverUser}@${serverIp}${Number(serverPort) && Number(serverPort) !== 22 ? ` -p ${serverPort}` : ''}`,
        notes: serverNotes,
        healthUrl: serverHealthUrl.trim() || undefined,
        status: 'unknown',
        createdAt: Date.now()
      });
      onClose();
    } else if (activeType === 'secret') {
      if (!secretName.trim()) {
        setFormError('请填写凭据名称');
        return;
      }
      const filled = secretFields.filter((f) => f.value.trim());
      if (filled.length === 0) {
        setFormError('请至少填写一个字段内容（如 Access Key ID 和 Access Key Secret）');
        return;
      }
      if (!masterPassword) {
        setFormError('安全金库处于锁定状态，请先在解锁弹窗中输入主密码（该弹窗已置于最上层）。');
        onRequireUnlock();
        return;
      }
      try {
        setSubmitting(true);
        // Each field is encrypted on its own, so revealing one never exposes the others.
        const encryptedFields = await Promise.all(
          filled.map(async (field) => {
            const encrypted = await encryptText(field.value, masterPassword);
            return {
              label: field.label.trim() || '字段',
              encryptedValue: encrypted.ciphertext,
              iv: encrypted.iv,
              salt: encrypted.salt,
              maskedPreview: createMaskedPreview(field.value)
            };
          })
        );
        // The first field is mirrored into the legacy single-value shape so backups,
        // global-search previews and other older readers keep working unchanged.
        const primary = encryptedFields[0];
        onAddSecret({
          id: `sec-${Date.now()}`,
          name: secretName.trim(),
          category: secretCategory,
          website: secretWebsite.trim() || undefined,
          encryptedValue: primary.encryptedValue,
          iv: primary.iv,
          salt: primary.salt,
          maskedPreview: primary.maskedPreview,
          fields: encryptedFields,
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
        type: 'redirect',
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
    /**
     * Right-side drawer, not a centred full-cover modal.
     *
     * Filling in a server or a credential usually means *referencing* the list behind
     * (existing groups, similar entries, which site a key belongs to) — a dark blurred
     * overlay hid all of it. The page stays fully visible here; only the drawer panel
     * intercepts clicks, and clicking the page (or ESC) closes the form.
     */
    <div onClick={requestClose} className="fixed inset-0 z-50 flex justify-end animate-in fade-in">
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md sm:max-w-lg h-full bg-sh-surface border-l border-sh-line shadow-2xl overflow-hidden flex flex-col sh-drawer-in"
        data-testid="add-item-modal"
        role="dialog"
        aria-label={singleType ? meta.title : '新建内容'}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-sh-line">
          <div className="flex items-center gap-2">
            <Plus className="w-4 h-4 text-sh-fg" />
            <h3 className="text-sm font-semibold text-sh-fg">
              {singleType ? meta.title : '新建内容'}
            </h3>
          </div>
          <button onClick={requestClose} aria-label="关闭" className="p-1 rounded-lg hover:bg-sh-surface2 text-sh-muted hover:text-sh-fg">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Type switch — only when the caller did not already choose */}
        {!singleType && (
          <div className="flex flex-wrap gap-1 border-b border-sh-line bg-sh-surface2 p-1">
            {availableTypes.map((type) => {
              const TypeIcon = TYPE_META[type].icon;
              return (
                <button
                  key={type}
                  onClick={() => setActiveType(type)}
                  data-add-type={type}
                  className={`flex-1 min-w-[84px] py-1.5 text-xs font-medium rounded-lg transition-colors flex items-center justify-center gap-1.5 ${
                    activeType === type ? 'bg-sh-surface text-sh-fg shadow-sm' : 'text-sh-muted hover:text-sh-fg'
                  }`}
                >
                  <TypeIcon className="w-3.5 h-3.5" />
                  {TYPE_META[type].label}
                </button>
              );
            })}
          </div>
        )}

        {/* Form Body */}
        <form onSubmit={handleSubmit} className="p-5 space-y-3.5 overflow-y-auto flex-1" data-add-form={activeType}>
          {activeType === 'site' && (
            <>
              {siteUrl.trim() && (
                <div
                  className="flex items-center gap-2.5 p-2.5 rounded-lg border border-sh-line bg-sh-surface2/50"
                  data-testid="add-site-icon-preview"
                >
                  <SiteIcon url={siteUrl} title={siteTitle} size={36} rounded="lg" />
                  <div className="min-w-0">
                    <p className="text-[11px] text-sh-fg">图标已按网址自动识别</p>
                    <p className="text-[10px] text-sh-subtle truncate">
                      直接读取该网站的 favicon；拿不到时用彩色首字母代替，无需手动上传。
                    </p>
                  </div>
                </div>
              )}
              <div>
                <label className="block text-xs text-sh-muted mb-1">网站名称</label>
                <input
                  type="text"
                  required
                  value={siteTitle}
                  onChange={(e) => setSiteTitle(e.target.value)}
                  placeholder="例如: GitHub 个人中心"
                  className="w-full bg-sh-surface2 border border-sh-line rounded-lg px-3 py-1.5 text-xs text-sh-fg focus:outline-none focus:border-sh-line-strong"
                />
              </div>
              <div>
                <label className="block text-xs text-sh-muted mb-1">URL 网址</label>
                <input
                  type="text"
                  required
                  value={siteUrl}
                  onChange={(e) => setSiteUrl(e.target.value)}
                  placeholder="https://..."
                  className="w-full bg-sh-surface2 border border-sh-line rounded-lg px-3 py-1.5 text-xs text-sh-fg font-mono focus:outline-none focus:border-sh-line-strong"
                />
              </div>
              <div>
                <label className="block text-xs text-sh-muted mb-1">所属分类</label>
                <select
                  value={siteCategory}
                  onChange={(e) => setSiteCategory(e.target.value)}
                  className="w-full bg-sh-surface2 border border-sh-line rounded-lg px-3 py-1.5 text-xs text-sh-fg focus:outline-none"
                >
                  {categories.filter(c => c !== '全部').map(c => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs text-sh-muted mb-1">简要描述 (可选)</label>
                <input
                  type="text"
                  value={siteDesc}
                  onChange={(e) => setSiteDesc(e.target.value)}
                  placeholder="用于搜索与快速备忘..."
                  className="w-full bg-sh-surface2 border border-sh-line rounded-lg px-3 py-1.5 text-xs text-sh-fg focus:outline-none focus:border-sh-line-strong"
                />
              </div>
            </>
          )}

          {activeType === 'server' && (
            <>
              <div>
                <label className="block text-xs text-sh-muted mb-1">服务/节点名称</label>
                <input
                  type="text"
                  required
                  value={serverName}
                  onChange={(e) => setServerName(e.target.value)}
                  placeholder="例如: 生产核心服务节点"
                  className="w-full bg-sh-surface2 border border-sh-line rounded-lg px-3 py-1.5 text-xs text-sh-fg focus:outline-none focus:border-sh-line-strong"
                />
              </div>
              <div>
                <label className="block text-xs text-sh-muted mb-1">归属网站/项目 (可选)</label>
                <input
                  type="text"
                  list="server-group-suggestions"
                  value={serverGroup}
                  onChange={(e) => setServerGroup(e.target.value)}
                  placeholder="例如: 官网 / api.example.com"
                  data-server-field="group"
                  className="w-full bg-sh-surface2 border border-sh-line rounded-lg px-3 py-1.5 text-xs text-sh-fg focus:outline-none focus:border-sh-line-strong"
                />
                <datalist id="server-group-suggestions">
                  {serverGroups.map((g) => (
                    <option key={g} value={g} />
                  ))}
                </datalist>
                <p className="mt-1 text-[10px] text-sh-subtle">
                  一个网站常有多台主机（web / 数据库 / CDN），填同一个名字就能在列表里归成一组。
                </p>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <div>
                  <label className="block text-xs text-sh-muted mb-1">公网 IP</label>
                  <input
                    type="text"
                    required
                    value={serverIp}
                    onChange={(e) => setServerIp(e.target.value)}
                    placeholder="1.2.3.4"
                    className="w-full bg-sh-surface2 border border-sh-line rounded-lg px-3 py-1.5 text-xs text-sh-fg font-mono focus:outline-none focus:border-sh-line-strong"
                  />
                </div>
                <div>
                  <label className="block text-xs text-sh-muted mb-1">端口</label>
                  <input
                    type="number"
                    value={serverPort}
                    onChange={(e) => setServerPort(Number(e.target.value))}
                    className="w-full bg-sh-surface2 border border-sh-line rounded-lg px-3 py-1.5 text-xs text-sh-fg font-mono focus:outline-none focus:border-sh-line-strong"
                  />
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <div>
                  <label className="block text-xs text-sh-muted mb-1">绑定域名 (可选)</label>
                  <input
                    type="text"
                    value={serverDomain}
                    onChange={(e) => setServerDomain(e.target.value)}
                    placeholder="my-server.example.com"
                    className="w-full bg-sh-surface2 border border-sh-line rounded-lg px-3 py-1.5 text-xs text-sh-fg font-mono focus:outline-none focus:border-sh-line-strong"
                  />
                </div>
                <div>
                  <label className="block text-xs text-sh-muted mb-1">部署环境</label>
                  <select
                    value={serverEnv}
                    onChange={(e) => setServerEnv(e.target.value as any)}
                    className="w-full bg-sh-surface2 border border-sh-line rounded-lg px-3 py-1.5 text-xs text-sh-fg focus:outline-none"
                  >
                    <option value="prod">生产环境 (PROD)</option>
                    <option value="test">测试环境 (TEST)</option>
                    <option value="dev">本地/开发 (DEV)</option>
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-xs text-sh-muted mb-1">SSH 用户名</label>
                <input
                  type="text"
                  value={serverUser}
                  onChange={(e) => setServerUser(e.target.value)}
                  placeholder="root"
                  className="w-full bg-sh-surface2 border border-sh-line rounded-lg px-3 py-1.5 text-xs text-sh-fg font-mono focus:outline-none focus:border-sh-line-strong"
                />
              </div>
              <div>
                <label className="block text-xs text-sh-muted mb-1">
                  健康检查 URL (可选，用于真实在线检测)
                </label>
                <input
                  type="text"
                  value={serverHealthUrl}
                  onChange={(e) => setServerHealthUrl(e.target.value)}
                  placeholder="https://api.example.com/health"
                  className="w-full bg-sh-surface2 border border-sh-line rounded-lg px-3 py-1.5 text-xs text-sh-fg font-mono focus:outline-none focus:border-sh-line-strong"
                />
                <Hint id="server-health-url" className="mt-1">
                  浏览器无法直连 SSH 端口；填写一个可访问的 HTTP 地址（或绑定域名）后，「检测」才能给出真实的在线状态。
                </Hint>
              </div>
            </>
          )}

          {activeType === 'secret' && (
            <>
              <div>
                <label className="block text-xs text-sh-muted mb-1">凭据/密钥名称</label>
                <input
                  type="text"
                  required
                  value={secretName}
                  onChange={(e) => setSecretName(e.target.value)}
                  placeholder="例如: Google Gemini 3.8 API Key"
                  className="w-full bg-sh-surface2 border border-sh-line rounded-lg px-3 py-1.5 text-xs text-sh-fg focus:outline-none focus:border-sh-line-strong"
                />
              </div>
              <div>
                <label className="block text-xs text-sh-muted mb-1">凭据分类</label>
                <select
                  value={secretCategory}
                  onChange={(e) => setSecretCategory(e.target.value as any)}
                  className="w-full bg-sh-surface2 border border-sh-line rounded-lg px-3 py-1.5 text-xs text-sh-fg focus:outline-none"
                >
                  <option value="api_key">API Key</option>
                  <option value="ssh_key">SSH 秘钥 / 口令</option>
                  <option value="db_credential">数据库连接账号密码</option>
                  <option value="token">个人 Token / 访问令牌</option>
                </select>
              </div>
              <div>
                <label className="block text-xs text-sh-muted mb-1">所属网站（可选）</label>
                <input
                  type="text"
                  value={secretWebsite}
                  onChange={(e) => setSecretWebsite(e.target.value)}
                  placeholder="github.com / 阿里云"
                  data-secret-field="website"
                  className="w-full bg-sh-surface2 border border-sh-line rounded-lg px-3 py-1.5 text-xs text-sh-fg focus:outline-none focus:border-sh-line-strong"
                />
                <p className="mt-1 text-[10px] text-sh-subtle">
                  同一个网站可以有多条凭据（比如只读 token 和 admin token），列表会按网站分组。
                </p>
              </div>

              {/* Multi-field credential: key + secret (and friends) live in one entry. */}
              <div className="space-y-2" data-testid="secret-fields-editor">
                <div className="flex items-center justify-between">
                  <label className="block text-xs text-sh-muted">凭据字段（key 和 secret 可以放同一条）</label>
                  <button
                    type="button"
                    onClick={() => setSecretFields((prev) => [...prev, { label: '', value: '' }])}
                    data-testid="secret-add-field"
                    className="px-2 py-0.5 rounded border border-sh-line text-[11px] text-sh-muted hover:text-sh-fg"
                  >
                    + 添加字段
                  </button>
                </div>
                {secretFields.map((field, index) => (
                  <div
                    key={index}
                    data-secret-row={index}
                    className="rounded-lg border border-sh-line p-2 space-y-1.5 bg-sh-surface2/50"
                  >
                    <div className="flex items-center gap-1.5">
                      <input
                        type="text"
                        list="secret-field-suggestions"
                        value={field.label}
                        onChange={(e) =>
                          setSecretFields((prev) =>
                            prev.map((f, i) => (i === index ? { ...f, label: e.target.value } : f))
                          )
                        }
                        placeholder="字段名（如 Access Key ID）"
                        data-secret-field={`label-${index}`}
                        className="w-40 bg-sh-surface2 border border-sh-line rounded px-2 py-1 text-[11px] text-sh-fg focus:outline-none focus:border-sh-line-strong"
                      />
                      {secretFields.length > 1 && (
                        <button
                          type="button"
                          onClick={() => setSecretFields((prev) => prev.filter((_, i) => i !== index))}
                          title="移除该字段"
                          className="ml-auto px-1.5 py-0.5 rounded border border-sh-line text-[10px] text-sh-danger"
                        >
                          移除
                        </button>
                      )}
                    </div>
                    <input
                      type="text"
                      required={index === 0}
                      value={field.value}
                      onChange={(e) =>
                        setSecretFields((prev) =>
                          prev.map((f, i) => (i === index ? { ...f, value: e.target.value } : f))
                        )
                      }
                      placeholder={index === 0 ? '粘贴完整的 Key 或密码...' : '粘贴该字段内容（可留空删除此行）'}
                      data-secret-field={`value-${index}`}
                      className="w-full bg-sh-surface2 border border-sh-line rounded px-2 py-1 text-xs text-sh-fg font-mono focus:outline-none focus:border-sh-line-strong"
                    />
                  </div>
                ))}
                <datalist id="secret-field-suggestions">
                  {SECRET_FIELD_SUGGESTIONS.map((s) => (
                    <option key={s} value={s} />
                  ))}
                </datalist>
                <p className="text-[10px] text-sh-subtle">
                  每个字段独立加密，查看/复制互不影响；留空的字段保存时会被丢弃。
                </p>
              </div>

              <div>
                <label className="block text-xs text-sh-muted mb-1">用途说明</label>
                <input
                  type="text"
                  value={secretDesc}
                  onChange={(e) => setSecretDesc(e.target.value)}
                  placeholder="用于..."
                  className="w-full bg-sh-surface2 border border-sh-line rounded-lg px-3 py-1.5 text-xs text-sh-fg focus:outline-none focus:border-sh-line-strong"
                />
              </div>
            </>
          )}

          {activeType === 'checkin' && (
            <>
              <div>
                <label className="block text-xs text-sh-muted mb-1">网站名称</label>
                <input
                  type="text"
                  required
                  value={checkInName}
                  onChange={(e) => setCheckInName(e.target.value)}
                  placeholder="例如: V2EX 每日签到"
                  className="w-full bg-sh-surface2 border border-sh-line rounded-lg px-3 py-1.5 text-xs text-sh-fg focus:outline-none focus:border-sh-line-strong"
                />
              </div>
              <div>
                <label className="block text-xs text-sh-muted mb-1">签到页面网址</label>
                <input
                  type="text"
                  required
                  value={checkInUrl}
                  onChange={(e) => setCheckInUrl(e.target.value)}
                  placeholder="https://..."
                  className="w-full bg-sh-surface2 border border-sh-line rounded-lg px-3 py-1.5 text-xs text-sh-fg font-mono focus:outline-none focus:border-sh-line-strong"
                />
                <p className="mt-1 text-[10px] text-sh-subtle">
                  每天从清单打开这个网站手动签到；应用不会替你发请求。
                </p>
              </div>
            </>
          )}

          {activeType === 'note' && (
            <>
              <div>
                <label className="block text-xs text-sh-muted mb-1">便签标题</label>
                <input
                  type="text"
                  required
                  value={noteTitle}
                  onChange={(e) => setNoteTitle(e.target.value)}
                  placeholder="例如: 常用 Git 指令备忘"
                  className="w-full bg-sh-surface2 border border-sh-line rounded-lg px-3 py-1.5 text-xs text-sh-fg focus:outline-none focus:border-sh-line-strong"
                />
              </div>
              <div>
                <label className="block text-xs text-sh-muted mb-1">便签内容 (支持 Markdown)</label>
                <textarea
                  required
                  rows={6}
                  value={noteContent}
                  onChange={(e) => setNoteContent(e.target.value)}
                  placeholder="记录内容..."
                  className="w-full bg-sh-surface2 border border-sh-line rounded-lg px-3 py-2 text-xs text-sh-fg font-mono focus:outline-none focus:border-sh-line-strong resize-none"
                />
              </div>
            </>
          )}

          {formError && (
            <div
              className="flex items-start gap-2 p-2.5 rounded-lg bg-sh-danger/10 border border-sh-danger/40 text-sh-danger text-xs"
              data-add-error
            >
              <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              <span>{formError}</span>
            </div>
          )}

          <div className="flex items-center justify-end gap-2 pt-3 border-t border-sh-line">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-xl bg-sh-surface2 hover:bg-sh-surface2 text-sh-muted text-xs"
            >
              取消
            </button>
            <button
              type="submit"
              disabled={submitting}
              data-testid="add-item-submit"
              className="px-4 py-2 rounded-xl bg-sh-accent text-sh-accent-fg hover:opacity-90 text-xs font-semibold flex items-center gap-1.5 shadow-sm disabled:opacity-60 disabled:cursor-not-allowed"
            >
              <Check className="w-3.5 h-3.5" />
              <span>{submitting ? '加密保存中...' : `保存${meta.label}`}</span>
            </button>
          </div>
        </form>

      </div>
    </div>
  );
};

