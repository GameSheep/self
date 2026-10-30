import React, { useMemo, useState } from 'react';
import { Globe, Plus, Save, Trash2 } from 'lucide-react';
import type { DomainRecord, HubState } from '../../types';
import { EmptyState, PageHeader, inputClass } from '../../shared/ui';
import { createDomain, daysUntilExpiry, normalizeDomainName } from '../../domain/domains';

export interface DomainsViewProps {
  state: HubState;
  onAddDomain: (domain: DomainRecord) => void;
  onUpdateDomain: (domain: DomainRecord) => void;
  onDeleteDomain: (id: string) => void;
}

const DAY = 86_400_000;

function toDateInput(value?: number): string {
  if (!value) return '';
  const date = new Date(value);
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

function fromDateInput(value: string): number | undefined {
  if (!value) return undefined;
  const at = new Date(`${value}T00:00:00`).getTime();
  return Number.isFinite(at) ? at : undefined;
}

interface Draft {
  name: string;
  start: string;
  expire: string;
  registrar: string;
  dns: string;
  url: string;
  note: string;
}

const EMPTY_DRAFT: Draft = { name: '', start: '', expire: '', registrar: '', dns: '', url: '', note: '' };

/**
 * 域名 (6.2).
 *
 * This page lists domains, and only domains: name, start, expiry, registrar, nameservers.
 * It no longer sends the user to the reminders page — that behaviour was the bug, because the
 * reminder is a different thing (it is *about* a date) and it has nowhere to put a registrar.
 *
 * 「域名到期」 reminders still exist and still drive 「今天要处理」; domain records that came from
 * them are marked 「由提醒迁移而来」 so the two can be told apart.
 */
export const DomainsView: React.FC<DomainsViewProps> = ({ state, onAddDomain, onUpdateDomain, onDeleteDomain }) => {
  const domains = useMemo(
    () => [...(state.domains ?? [])].sort((a, b) => (a.expireAt ?? Infinity) - (b.expireAt ?? Infinity)),
    [state.domains]
  );
  const [draft, setDraft] = useState<Draft | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return domains;
    return domains.filter((domain) =>
      [domain.name, domain.registrar, domain.dns, domain.note].filter(Boolean).join(' ').toLowerCase().includes(needle)
    );
  }, [domains, query]);

  const submit = () => {
    if (!draft || !draft.name.trim()) return;
    const payload = {
      name: draft.name,
      startAt: fromDateInput(draft.start),
      expireAt: fromDateInput(draft.expire),
      registrar: draft.registrar,
      dns: draft.dns,
      url: draft.url,
      note: draft.note
    };
    if (editingId) {
      const current = domains.find((domain) => domain.id === editingId);
      if (current) {
        onUpdateDomain({
          ...current,
          ...payload,
          name: normalizeDomainName(payload.name) || payload.name.trim(),
          updatedAt: Date.now()
        });
      }
    } else {
      onAddDomain(createDomain(payload));
    }
    setDraft(null);
    setEditingId(null);
  };

  const startEdit = (domain: DomainRecord) => {
    setEditingId(domain.id);
    setDraft({
      name: domain.name,
      start: toDateInput(domain.startAt),
      expire: toDateInput(domain.expireAt),
      registrar: domain.registrar ?? '',
      dns: domain.dns ?? '',
      url: domain.url ?? '',
      note: domain.note ?? ''
    });
  };

  const overdue = domains.filter((domain) => {
    const days = daysUntilExpiry(domain);
    return days !== null && days < 0;
  }).length;
  const soon = domains.filter((domain) => {
    const days = daysUntilExpiry(domain);
    return days !== null && days >= 0 && days <= 30;
  }).length;

  return (
    <div data-testid="domains-view">
      <PageHeader
        title="域名"
        description="只列域名自己的信息：什么时候买的、什么时候到期、在哪买的、DNS 是什么。到期日仍会出现在首页「今天要处理」里。"
        actions={
          <button
            onClick={() => {
              setEditingId(null);
              setDraft(EMPTY_DRAFT);
            }}
            data-testid="domain-add"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-sh-accent text-sh-accent-fg text-xs font-semibold sh-tap"
          >
            <Plus className="w-3.5 h-3.5" aria-hidden />
            新增域名
          </button>
        }
      />

      <div className="grid grid-cols-3 gap-2 mb-3">
        <div className="rounded-xl border border-sh-line bg-sh-surface p-3">
          <span className="block text-[11px] text-sh-muted">域名总数</span>
          <span className="block text-lg text-sh-fg" data-testid="domain-count">
            {domains.length}
          </span>
        </div>
        <div className="rounded-xl border border-sh-line bg-sh-surface p-3">
          <span className="block text-[11px] text-sh-muted">30 天内到期</span>
          <span className="block text-lg text-sh-warn">{soon}</span>
        </div>
        <div className="rounded-xl border border-sh-line bg-sh-surface p-3">
          <span className="block text-[11px] text-sh-muted">已过期</span>
          <span className="block text-lg text-sh-danger">{overdue}</span>
        </div>
      </div>

      <div className="flex items-center gap-2 mb-3">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索域名、注册商或 DNS"
          data-testid="domain-search"
          className={`${inputClass} max-w-xs`}
        />
      </div>

      {draft && (
        <form
          data-testid="domain-form"
          className="mb-3 rounded-xl border border-sh-line bg-sh-surface p-3 space-y-2.5"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="block">
              <span className="block text-[11px] text-sh-muted mb-1">域名</span>
              <input
                required
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                placeholder="example.com"
                data-testid="domain-name"
                className={inputClass}
              />
            </label>
            <label className="block">
              <span className="block text-[11px] text-sh-muted mb-1">在哪买的（注册商）</span>
              <input
                value={draft.registrar}
                onChange={(e) => setDraft({ ...draft, registrar: e.target.value })}
                placeholder="阿里云 / Cloudflare / Namecheap"
                data-testid="domain-registrar"
                className={inputClass}
              />
            </label>
            <label className="block">
              <span className="block text-[11px] text-sh-muted mb-1">开始时间（购买）</span>
              <input
                type="date"
                value={draft.start}
                onChange={(e) => setDraft({ ...draft, start: e.target.value })}
                data-testid="domain-start"
                className={inputClass}
              />
            </label>
            <label className="block">
              <span className="block text-[11px] text-sh-muted mb-1">到期时间</span>
              <input
                type="date"
                value={draft.expire}
                onChange={(e) => setDraft({ ...draft, expire: e.target.value })}
                data-testid="domain-expire"
                className={inputClass}
              />
            </label>
            <label className="block">
              <span className="block text-[11px] text-sh-muted mb-1">DNS（可选）</span>
              <input
                value={draft.dns}
                onChange={(e) => setDraft({ ...draft, dns: e.target.value })}
                placeholder="ns1.aliyun.com / Cloudflare"
                data-testid="domain-dns"
                className={inputClass}
              />
            </label>
            <label className="block">
              <span className="block text-[11px] text-sh-muted mb-1">管理入口（可选）</span>
              <input
                value={draft.url}
                onChange={(e) => setDraft({ ...draft, url: e.target.value })}
                placeholder="https://..."
                data-testid="domain-url"
                className={`${inputClass} font-mono`}
              />
            </label>
            <label className="block sm:col-span-2">
              <span className="block text-[11px] text-sh-muted mb-1">备注（可选）</span>
              <input
                value={draft.note}
                onChange={(e) => setDraft({ ...draft, note: e.target.value })}
                data-testid="domain-note"
                className={inputClass}
              />
            </label>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="submit"
              data-testid="domain-save"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-sh-accent text-sh-accent-fg text-xs font-semibold"
            >
              <Save className="w-3.5 h-3.5" aria-hidden />
              {editingId ? '保存修改' : '保存'}
            </button>
            <button
              type="button"
              onClick={() => {
                setDraft(null);
                setEditingId(null);
              }}
              className="px-3 py-1.5 rounded-lg border border-sh-line text-xs"
            >
              取消
            </button>
          </div>
        </form>
      )}

      {visible.length === 0 ? (
        <EmptyState
          icon={<Globe className="w-5 h-5" />}
          title={domains.length === 0 ? '还没有域名' : '没有匹配的域名'}
          description={
            domains.length === 0
              ? '记下域名、开始与到期时间、在哪买的；有 DNS 就一起记，没有也能存。'
              : '换个关键字，或清空搜索。'
          }
        />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-sh-line" data-testid="domain-table">
          <table className="w-full text-xs">
            <thead className="bg-sh-surface2 text-sh-muted">
              <tr>
                <th className="text-left px-3 py-2 font-medium">域名</th>
                <th className="text-left px-3 py-2 font-medium">开始</th>
                <th className="text-left px-3 py-2 font-medium">到期</th>
                <th className="text-left px-3 py-2 font-medium">注册商</th>
                <th className="text-left px-3 py-2 font-medium">DNS</th>
                <th className="text-right px-3 py-2 font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((domain) => {
                const days = daysUntilExpiry(domain);
                return (
                  <tr key={domain.id} className="border-t border-sh-line" data-domain-row={domain.id}>
                    <td className="px-3 py-2">
                      <span className="text-sh-fg font-medium font-mono">{domain.name}</span>
                      {domain.note && <span className="block text-[10px] text-sh-subtle">{domain.note}</span>}
                    </td>
                    <td className="px-3 py-2 text-sh-muted">
                      {domain.startAt ? new Date(domain.startAt).toLocaleDateString() : '—'}
                    </td>
                    <td className="px-3 py-2">
                      {domain.expireAt ? (
                        <>
                          <span className="text-sh-fg">{new Date(domain.expireAt).toLocaleDateString()}</span>
                          <span
                            className={`block text-[10px] ${
                              days === null ? 'text-sh-subtle' : days < 0 ? 'text-sh-danger' : days <= 30 ? 'text-sh-warn' : 'text-sh-subtle'
                            }`}
                          >
                            {days === null ? '' : days < 0 ? `已过期 ${Math.abs(days)} 天` : `${days} 天后`}
                          </span>
                        </>
                      ) : (
                        <span className="text-sh-subtle">未填</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-sh-muted">{domain.registrar || '—'}</td>
                    <td className="px-3 py-2 text-sh-muted font-mono text-[11px]">{domain.dns || '—'}</td>
                    <td className="px-3 py-2">
                      <div className="flex items-center justify-end gap-1.5">
                        {domain.url && (
                          <a
                            href={domain.url}
                            target="_blank"
                            rel="noreferrer"
                            className="px-2 py-1 rounded border border-sh-line text-sh-info hover:underline"
                          >
                            管理
                          </a>
                        )}
                        <button
                          onClick={() => startEdit(domain)}
                          data-testid={`domain-edit-${domain.id}`}
                          className="px-2 py-1 rounded border border-sh-line text-sh-muted hover:text-sh-fg"
                        >
                          编辑
                        </button>
                        <button
                          onClick={() => onDeleteDomain(domain.id)}
                          data-testid={`domain-delete-${domain.id}`}
                          className="px-2 py-1 rounded border border-sh-line text-sh-danger hover:bg-sh-danger/10"
                          aria-label={`删除 ${domain.name}`}
                        >
                          <Trash2 className="w-3.5 h-3.5" aria-hidden />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

export default DomainsView;
