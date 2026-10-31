import React, { useMemo, useState } from 'react';
import { BadgeDollarSign, Globe, Plus, ShieldCheck } from 'lucide-react';
import type { HubState, ReminderItem } from '../../types';
import { EmptyState, PageHeader, StatusPill } from '../../shared/ui';
import { daysUntil } from '../../lib/dates';

export interface AssetsViewProps {
  state: HubState;
  onNavigate: (path: string) => void;
  onAddReminder: () => void;
  /**
   * Create a domain / subscription from this page.
   *
   * Still backed by a reminder (the design keeps one authoritative date), but the user adds
   * it *here*, in this page's language — 「新建到期提醒」 and a paragraph telling them to go
   * somewhere else was the page refusing to do the one thing it is for.
   */
  onCreateAsset?: (asset: { kind: 'domain' | 'subscription' | 'cert'; name: string; due: string; cost?: string; manageUrl?: string }) => void;
}

type AssetKind = 'domain' | 'subscription' | 'cert' | 'server-expiry' | 'token-expiry';

interface AssetRow {
  key: string;
  kind: AssetKind;
  name: string;
  provider?: string;
  dueAt: number;
  days: number;
  /** Where the authoritative date lives. */
  authority: 'reminder' | 'server' | 'credential';
  authorityId: string;
  manageUrl?: string;
  cost?: string;
}

const KIND_LABELS: Record<AssetKind, string> = {
  domain: '域名',
  subscription: '订阅',
  cert: '证书',
  'server-expiry': '服务器到期',
  'token-expiry': '凭证到期'
};

/**
 * 域名与订阅 (P1-06).
 * This view is a **projection**, not a new store. The design doc is explicit
 * that a due date must have one authoritative owner: if a domain's renewal date
 * · from there. It never invents an account, and it never asks the user to type
 */
export const AssetsView: React.FC<AssetsViewProps> = ({ state, onNavigate, onAddReminder, onCreateAsset }) => {
  const [kindFilter, setKindFilter] = useState<AssetKind | 'all'>('all');
  const [horizon, setHorizon] = useState<30 | 90 | 0>(90);
  const [showForm, setShowForm] = useState(false);
  const [draftKind, setDraftKind] = useState<'domain' | 'subscription' | 'cert'>('domain');
  const [draftName, setDraftName] = useState('');
  const [draftDue, setDraftDue] = useState('');
  const [draftCost, setDraftCost] = useState('');
  const [draftUrl, setDraftUrl] = useState('');

  const rows = useMemo<AssetRow[]>(() => {
    const out: AssetRow[] = [];

    for (const reminder of state.reminders || []) {
      const kind: AssetKind | null =
        reminder.category === 'domain'
          ? 'domain'
          : reminder.category === 'subscription'
            ? 'subscription'
            : reminder.category === 'cert'
              ? 'cert'
              : null;
      if (!kind || reminder.completed) continue;
      out.push({
        key: `reminder:${reminder.id}`,
        kind,
        name: reminder.title,
        dueAt: reminder.targetDate,
        days: daysUntil(reminder.targetDate),
        authority: 'reminder',
        authorityId: reminder.id,
        manageUrl: reminder.url,
        cost: reminder.cost
      });
    }

    for (const server of state.servers || []) {
      if (!server.expiresAt) continue;
      out.push({
        key: `server:${server.id}`,
        kind: 'server-expiry',
        name: server.name,
        provider: server.publicIp,
        dueAt: server.expiresAt,
        days: daysUntil(server.expiresAt),
        authority: 'server',
        authorityId: server.id,
        cost: server.renewalCost
      });
    }

    for (const secret of state.secrets || []) {
      if (!secret.expiresAt) continue;
      out.push({
        key: `secret:${secret.id}`,
        kind: 'token-expiry',
        name: secret.name,
        provider: secret.category,
        dueAt: secret.expiresAt,
        days: daysUntil(secret.expiresAt),
        authority: 'credential',
        authorityId: secret.id
      });
    }

    return out
      .filter((row) => Number.isFinite(row.days))
      .sort((a, b) => a.days - b.days);
  }, [state.reminders, state.servers, state.secrets]);

  const visible = rows.filter((row) => {
    if (kindFilter !== 'all' && row.kind !== kindFilter) return false;
    if (horizon !== 0 && row.days > horizon) return false;
    return true;
  });

  const soon = rows.filter((r) => r.days <= 30).length;
  const overdue = rows.filter((r) => r.days < 0).length;

  const countOf = (kind: AssetKind) => rows.filter((r) => r.kind === kind).length;

  return (
    <div data-testid="assets-view">
      <PageHeader
        title="域名与订阅"
        description="到期资源的集中视图。日期只在原处维护一次：提醒、服务器或凭证谁拥有它，这里就读谁，不会另存一份。"
        actions={
          <button
            onClick={() => setShowForm((open) => !open)}
            data-testid="asset-add"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-sh-accent text-sh-accent-fg text-xs font-semibold sh-tap"
          >
            <Plus className="w-3.5 h-3.5" aria-hidden />
            新建域名 / 订阅
          </button>
        }
      />

      {showForm && (
        <form
          data-testid="asset-form"
          className="mb-3 rounded-xl border border-sh-line bg-sh-surface p-3 space-y-2.5"
          onSubmit={(event) => {
            event.preventDefault();
            if (!draftName.trim() || !draftDue) return;
            onCreateAsset?.({
              kind: draftKind,
              name: draftName.trim(),
              due: draftDue,
              cost: draftCost.trim() || undefined,
              manageUrl: draftUrl.trim() || undefined
            });
            setDraftName('');
            setDraftDue('');
            setDraftCost('');
            setDraftUrl('');
            setShowForm(false);
          }}
        >
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="block">
              <span className="block text-[11px] text-sh-muted mb-1">名称</span>
              <input
                required
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                data-testid="asset-name"
                placeholder="example.com / 某订阅服务"
                className="w-full bg-sh-surface2 border border-sh-line rounded-lg px-2.5 py-1.5 text-xs text-sh-fg focus:outline-none focus:border-sh-line-strong"
              />
            </label>
            <label className="block">
              <span className="block text-[11px] text-sh-muted mb-1">类型</span>
              <select
                value={draftKind}
                onChange={(e) => setDraftKind(e.target.value as 'domain' | 'subscription' | 'cert')}
                data-testid="asset-kind"
                className="w-full bg-sh-surface2 border border-sh-line rounded-lg px-2.5 py-1.5 text-xs text-sh-fg focus:outline-none"
              >
                <option value="domain">域名</option>
                <option value="subscription">订阅</option>
                <option value="cert">证书</option>
              </select>
            </label>
            <label className="block">
              <span className="block text-[11px] text-sh-muted mb-1">到期日</span>
              <input
                required
                type="date"
                value={draftDue}
                onChange={(e) => setDraftDue(e.target.value)}
                data-testid="asset-due"
                className="w-full bg-sh-surface2 border border-sh-line rounded-lg px-2.5 py-1.5 text-xs text-sh-fg focus:outline-none focus:border-sh-line-strong"
              />
            </label>
            <label className="block">
              <span className="block text-[11px] text-sh-muted mb-1">费用（可选）</span>
              <input
                value={draftCost}
                onChange={(e) => setDraftCost(e.target.value)}
                data-testid="asset-cost"
                placeholder="¥99/年"
                className="w-full bg-sh-surface2 border border-sh-line rounded-lg px-2.5 py-1.5 text-xs text-sh-fg focus:outline-none focus:border-sh-line-strong"
              />
            </label>
            <label className="block sm:col-span-2">
              <span className="block text-[11px] text-sh-muted mb-1">续费 / 管理入口（可选）</span>
              <input
                value={draftUrl}
                onChange={(e) => setDraftUrl(e.target.value)}
                data-testid="asset-url"
                placeholder="https://..."
                className="w-full bg-sh-surface2 border border-sh-line rounded-lg px-2.5 py-1.5 text-xs text-sh-fg font-mono focus:outline-none focus:border-sh-line-strong"
              />
            </label>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="submit"
              data-testid="asset-save"
              className="px-3 py-1.5 rounded-lg bg-sh-accent text-sh-accent-fg text-xs font-semibold"
            >
              保存
            </button>
            <button type="button" onClick={() => setShowForm(false)} className="px-3 py-1.5 rounded-lg border border-sh-line text-xs">
              取消
            </button>
            {!onCreateAsset && (
              <button type="button" onClick={onAddReminder} className="px-3 py-1.5 rounded-lg border border-sh-line text-xs">
                改为新建提醒
              </button>
            )}
          </div>
        </form>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3">
        <div className="rounded-xl border border-sh-line bg-sh-surface p-3">
          <span className="block text-[11px] text-sh-muted">全部到期项</span>
          <span className="block text-lg text-sh-fg">{rows.length}</span>
        </div>
        <div className="rounded-xl border border-sh-line bg-sh-surface p-3">
          <span className="block text-[11px] text-sh-muted">30 天内</span>
          <span className="block text-lg text-sh-warn">{soon}</span>
        </div>
        <div className="rounded-xl border border-sh-line bg-sh-surface p-3">
          <span className="block text-[11px] text-sh-muted">已逾期</span>
          <span className="block text-lg text-sh-danger">{overdue}</span>
        </div>
        <div className="rounded-xl border border-sh-line bg-sh-surface p-3">
          <span className="block text-[11px] text-sh-muted">关联服务器</span>
          <span className="block text-lg text-sh-fg">{countOf('server-expiry')}</span>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5 mb-3">
        {(['all', 'domain', 'subscription', 'cert', 'server-expiry', 'token-expiry'] as const).map((id) => (
          <button
            key={id}
            onClick={() => setKindFilter(id)}
            className={`px-2.5 py-1 rounded-lg text-[11px] border transition-colors ${
              kindFilter === id ? 'bg-sh-surface2 border-sh-line-strong text-sh-fg' : 'border-sh-line text-sh-muted'
            }`}
          >
            {id === 'all' ? '全部类型' : KIND_LABELS[id]}
            {id !== 'all' && countOf(id) > 0 ? ` ${countOf(id)}` : ''}
          </button>
        ))}
        <span className="mx-1 w-px h-4 bg-sh-line" aria-hidden />
        {(
          [
            [90, '90 天内'],
            [30, '30 天内'],
            [0, '全部时间']
          ] as const
        ).map(([days, label]) => (
          <button
            key={label}
            onClick={() => setHorizon(days)}
            className={`px-2.5 py-1 rounded-lg text-[11px] border transition-colors ${
              horizon === days ? 'bg-sh-surface2 border-sh-line-strong text-sh-fg' : 'border-sh-line text-sh-muted'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {rows.length === 0 ? (
        <EmptyState
          icon={<BadgeDollarSign className="w-5 h-5" />}
          title="还没有到期资源"
          description="域名、订阅和证书都通过提醒来跟踪。新建一条提醒即可，不需要在这里重复填写已经存在的到期日期。"
          action={
            <button onClick={onAddReminder} className="px-3 py-1.5 rounded-lg bg-sh-accent text-sh-accent-fg text-xs font-semibold">
              新建到期提醒
            </button>
          }
        />
      ) : visible.length === 0 ? (
        <EmptyState title="当前筛选下没有内容" description="切换类型或时间范围查看其他到期项。" />
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-sh-line">
          <table className="w-full text-xs" data-testid="assets-table">
            <thead className="bg-sh-surface2 text-sh-muted">
              <tr>
                <th className="text-left font-medium px-3 py-2">名称</th>
                <th className="text-left font-medium px-3 py-2">类型</th>
                <th className="text-left font-medium px-3 py-2">到期</th>
                <th className="text-left font-medium px-3 py-2">日期来源</th>
                <th className="text-left font-medium px-3 py-2">费用 / 管理入口</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((row) => (
                <tr key={row.key} className="border-t border-sh-line" data-asset-row={row.key}>
                  <td className="px-3 py-2 text-sh-fg">{row.name}</td>
                  <td className="px-3 py-2 text-sh-muted">{KIND_LABELS[row.kind]}</td>
                  <td className="px-3 py-2">
                    <StatusPill
                      tone={row.days < 0 ? 'danger' : row.days <= 7 ? 'warn' : row.days <= 30 ? 'info' : 'neutral'}
                      label={
                        row.days < 0
                          ? `已过期 ${Math.abs(row.days)} 天`
                          : row.days === 0
                            ? '今天到期'
                            : `${row.days} 天后`
                      }
                    />
                    <span className="block text-[10px] text-sh-subtle mt-0.5 font-mono">
                      {new Date(row.dueAt).toLocaleDateString()}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-sh-muted">
                    {row.authority === 'reminder' ? (
                      <button onClick={() => onNavigate('#/reminders')} className="hover:underline inline-flex items-center gap-1">
                        <Globe className="w-3 h-3" aria-hidden /> 提醒记录
                      </button>
                    ) : row.authority === 'server' ? (
                      <button
                        onClick={() => onNavigate('#/resources/servers')}
                        className="hover:underline inline-flex items-center gap-1"
                      >
                        <Globe className="w-3 h-3" aria-hidden /> 服务器
                      </button>
                    ) : (
                      <button
                        onClick={() => onNavigate('#/resources/vault')}
                        className="hover:underline inline-flex items-center gap-1"
                      >
                        <ShieldCheck className="w-3 h-3" aria-hidden /> 凭证
                      </button>
                    )}
                  </td>
                  <td className="px-3 py-2 text-sh-muted">
                    {row.cost && <span className="block">{row.cost}</span>}
                    {row.manageUrl ? (
                      <a href={row.manageUrl} target="_blank" rel="noreferrer" className="text-sh-info hover:underline">
                        续费入口
                      </a>
                    ) : (
                      <span className="text-sh-subtle">未填写</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="mt-3 text-[11px] text-sh-subtle leading-relaxed">
        日期只有一处：这些条目同时出现在提醒里，改哪边都一样。
      </p>
    </div>
  );
};

export default AssetsView;
