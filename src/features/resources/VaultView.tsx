import React, { useMemo, useState } from 'react';
import { Globe, Info, Lock, Plus, Search, ShieldCheck } from 'lucide-react';
import type { SecretItem } from '../../types';
import { SecretCard } from '../../components/cards/SecretCard';
import { EmptyState, PageHeader, inputClass } from '../../shared/ui';
import { Hint } from '../../shared/Hint';

export interface VaultViewProps {
  secrets: SecretItem[];
  masterPassword: string | null;
  onRequireUnlock: () => void;
  onLockVault: () => void;
  onDelete: (id: string) => void;
  onOpenAddModal: (type?: 'site' | 'server' | 'secret' | 'checkin' | 'note') => void;
  /** True when a master password has been established on this device. */
  hasMasterAuth: boolean;
}

/**
 * Credential vault (P1-06).
 *
 * A locked vault shows a locked screen, not a grid of greyed-out cards: the
 * search box, the counts and the previews are all absent while locked, because
 * "locked" has to mean the plaintext is not in the DOM. The unlock screen also
 * states what unlocking does and does not protect against, instead of implying
 * that storing a value here makes it safe.
 */
/** Group credentials by site, unassigned last. */
function groupByWebsite(secrets: SecretItem[]): Array<[string, SecretItem[]]> {
  const groups = new Map<string, SecretItem[]>();
  for (const secret of secrets) {
    const key = (secret.website || '').trim().toLowerCase();
    const bucket = groups.get(key);
    if (bucket) bucket.push(secret);
    else groups.set(key, [secret]);
  }
  return Array.from(groups.entries()).sort(([a], [b]) => {
    if (a === '') return 1;
    if (b === '') return -1;
    return a.localeCompare(b);
  });
}

export const VaultView: React.FC<VaultViewProps> = ({
  secrets,
  masterPassword,
  onRequireUnlock,
  onLockVault,
  onDelete,
  onOpenAddModal,
  hasMasterAuth
}) => {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<string>('all');

  const categories = useMemo(() => Array.from(new Set(secrets.map((s) => s.category))), [secrets]);

  // While locked, the list is not filtered or rendered at all: no metadata
  // beyond the count is exposed, and no search cache is kept in memory.
  const visible = useMemo(() => {
    if (!masterPassword) return [];
    const q = query.trim().toLowerCase();
    return secrets.filter((secret) => {
      if (category !== 'all' && secret.category !== category) return false;
      if (!q) return true;
      return `${secret.name} ${secret.category} ${(secret.tags || []).join(' ')}`.toLowerCase().includes(q);
    });
  }, [secrets, query, category, masterPassword]);

  if (!masterPassword) {
    return (
      <div data-testid="vault-view">
        <PageHeader title="凭证金库" description="加密保存 API Key、Token 与服务器密码。锁定状态下不加载、不搜索、也不显示任何明文。" />
        <div className="mx-auto max-w-lg rounded-2xl border border-sh-line bg-sh-surface p-6 text-center space-y-3">
          <Lock className="w-8 h-8 text-sh-warn mx-auto" aria-hidden />
          <h2 className="text-sm font-semibold text-sh-fg">金库已锁定</h2>
          <p className="text-xs text-sh-muted leading-relaxed">
            本机共保存 {secrets.length} 条凭据。解锁后才能查看、复制或编辑内容；锁定会清除内存中的已解密值与搜索缓存。
          </p>
          <button
            onClick={onRequireUnlock}
            className="px-4 py-2 rounded-xl bg-sh-accent text-sh-accent-fg text-xs font-semibold sh-tap"
            data-testid="vault-unlock"
          >
            {hasMasterAuth ? '输入主密码解锁' : '创建主密码'}
          </button>
          <Hint id="vault-lock-explainer">
            加密只保护“数据静止在磁盘上”这一种情况；解锁期间，本页面的脚本仍可读取明文，请只在信任此设备的浏览器中使用。
            忘记主密码时，只能通过此前导出的加密备份与主密码一起恢复，没有绕过解密的重置方式。
          </Hint>
        </div>
      </div>
    );
  }

  return (
    <div data-testid="vault-view">
      <PageHeader
        title="凭证金库"
        description="已解锁。复制操作会把明文放入系统剪贴板，应用无法可靠地替你清空，请在粘贴后自行处理。"
        actions={
          <>
            <button
              onClick={onLockVault}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-sh-line text-xs text-sh-muted hover:text-sh-fg sh-tap"
            >
              <Lock className="w-3.5 h-3.5" aria-hidden />
              立即锁定
            </button>
            <button
              onClick={() => onOpenAddModal('secret')}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-sh-accent text-sh-accent-fg text-xs font-semibold sh-tap"
            >
              <Plus className="w-3.5 h-3.5" aria-hidden />
              新建凭据
            </button>
          </>
        }
      />

      <div className="flex flex-wrap items-center gap-2 mb-3">
        <label className="relative flex-1 min-w-[200px]">
          <span className="sr-only">按名称搜索凭据</span>
          <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-sh-subtle" aria-hidden />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="按名称或分类搜索（只在本机内存中进行）"
            className={`${inputClass} pl-8`}
            data-testid="vault-search"
          />
        </label>
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            onClick={() => setCategory('all')}
            className={`px-2.5 py-1 rounded-lg text-[11px] border ${
              category === 'all' ? 'bg-sh-surface2 border-sh-line-strong text-sh-fg' : 'border-sh-line text-sh-muted'
            }`}
          >
            全部分类
          </button>
          {categories.map((c) => (
            <button
              key={c}
              onClick={() => setCategory(c)}
              className={`px-2.5 py-1 rounded-lg text-[11px] border ${
                category === c ? 'bg-sh-surface2 border-sh-line-strong text-sh-fg' : 'border-sh-line text-sh-muted'
              }`}
            >
              {c}
            </button>
          ))}
        </div>
      </div>

      <p className="flex items-start gap-1.5 text-[11px] text-sh-subtle mb-3">
        <Info className="w-3.5 h-3.5 shrink-0 mt-0.5" aria-hidden />
        金库内容不会出现在首页摘要或普通全文检索结果中；项目只能保存引用，解锁后才能查看。
      </p>

      {secrets.length === 0 ? (
        <EmptyState
          icon={<ShieldCheck className="w-5 h-5" />}
          title="金库还是空的"
          description="新建第一条凭据后，它会以 AES-256-GCM 加密保存在本机。"
          action={
            <button onClick={() => onOpenAddModal('secret')} className="px-3 py-1.5 rounded-lg bg-sh-accent text-sh-accent-fg text-xs font-semibold">
              新建凭据
            </button>
          }
        />
      ) : visible.length === 0 ? (
        <EmptyState title="没有匹配的凭据" description="换一个关键词，或切换到全部分类。" />
      ) : (
        /**
         * Grouped by site.
         *
         * One site legitimately holds several credentials (read-only + admin token, an old key
         * and its replacement). A flat grid made them look like duplicates; a heading per site
         * says "these belong together" without forcing a unique site field.
         */
        <div className="space-y-4" data-testid="vault-groups">
          {groupByWebsite(visible).map(([website, group]) => (
            <section key={website} data-vault-site={website}>
              <div className="flex items-center gap-2 mb-1.5">
                <Globe className="w-3.5 h-3.5 text-sh-subtle" aria-hidden />
                <h3 className="text-[11px] font-semibold text-sh-muted">
                  {website === '' ? '未指定网站' : website}
                </h3>
                <span className="text-[10px] text-sh-subtle">{group.length} 条</span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
                {group.map((secret) => (
                  <SecretCard
                    key={secret.id}
                    secret={secret}
                    masterPassword={masterPassword}
                    onRequireUnlock={onRequireUnlock}
                    onDelete={onDelete}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
};

export default VaultView;
