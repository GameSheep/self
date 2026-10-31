import React, { useMemo, useState } from 'react';
import { Activity, FolderOpen, Plus, Server } from 'lucide-react';
import type { ServerDeployment } from '../../types';
import { ServerCard } from '../../components/cards/ServerCard';
import { ConfirmButton, PageHeader, EmptyState, StatusDot } from '../../shared/ui';
import { showToast as showToastGlobal } from '../../shared/ui/toast';
import { daysUntil } from '../../lib/dates';

export interface ServersViewProps {
  servers: ServerDeployment[];
  onDelete: (id: string) => void;
  /** Persist a server row after an inline edit (extras / notes / group). */
  onUpdate?: (server: ServerDeployment) => void;
  onCheck: (id: string) => Promise<void> | void;
  /** 返回检测汇总（可达/不可达），调用方据此给批量结果反馈。 */
  onCheckAll: () => Promise<{ total: number; online: number; offline: number } | void> | void;
  onOpenAddModal: (type?: 'site' | 'server' | 'secret' | 'checkin' | 'note') => void;
}

type StatusFilter = 'all' | 'never' | 'offline' | 'online';

/**
 * Group the (already filtered) servers by their 归属 label, ungrouped last.
 *
 * One website often spans several hosts (web + db + cdn); a flat grid made them look
 * like unrelated entries. Grouping is by the free-form `group` string so the user is
 * never forced through a group-management dialog just to say "these belong together".
 */
function groupServers(servers: ServerDeployment[]): Array<[string, ServerDeployment[]]> {
  const groups = new Map<string, ServerDeployment[]>();
  for (const server of servers) {
    const key = (server.group || '').trim();
    const bucket = groups.get(key);
    if (bucket) bucket.push(server);
    else groups.set(key, [server]);
  }
  return Array.from(groups.entries()).sort(([a], [b]) => {
    if (a === '') return 1;
    if (b === '') return -1;
    return a.localeCompare(b);
  });
}

/**
 * Servers (P1-06).
 * The list leads with what the user needs to act on — name, environment,
 * address, HTTP reachability with the time it was observed, and expiry — instead
 */
export const ServersView: React.FC<ServersViewProps> = ({
  servers,
  onDelete,
  onUpdate,
  onCheck,
  onCheckAll,
  onOpenAddModal
}) => {
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [checkingAll, setCheckingAll] = useState(false);
  /** Which server's 「备注项」 editor is open. */
  const [extrasOpenId, setExtrasOpenId] = useState<string | null>(null);
  /** Which server's 「归属」 editor is open. */
  const [groupEditId, setGroupEditId] = useState<string | null>(null);

  const counts = useMemo(
    () => ({
      all: servers.length,
      never: servers.filter((s) => !s.lastCheckedAt).length,
      offline: servers.filter((s) => s.status === 'offline').length,
      online: servers.filter((s) => s.status === 'online').length
    }),
    [servers]
  );

  const visible = servers.filter((s) => {
    if (filter === 'never') return !s.lastCheckedAt;
    if (filter === 'offline') return s.status === 'offline';
    if (filter === 'online') return s.status === 'online';
    return true;
  });

  /** Distinct non-empty group labels, offered as suggestions in both editors. */
  const knownGroups = useMemo(
    () => Array.from(new Set(servers.map((s) => (s.group || '').trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b)),
    [servers]
  );

  /** True when at least one server carries a group label; drives the grouped layout. */
  const hasAnyGroup = knownGroups.length > 0;

  return (
    <div data-testid="servers-view">
      <PageHeader
        title="服务器"
        description="主机信息、连接命令与 HTTP 可达性检测。检测只代表当前浏览器能访问该地址，不代表主机上的服务全部正常。"
        actions={
          <>
            <button
              onClick={async () => {
                setCheckingAll(true);
                try {
                  const summary = await onCheckAll();
                  if (summary && summary.total > 0) {
                    showToastGlobal(
                      summary.offline > 0
                        ? `检测完成：${summary.online}/${summary.total} 台可达，${summary.offline} 台不可达`
                        : `检测完成：${summary.total} 台全部可达`,
                      summary.offline > 0 ? 'warn' : 'ok'
                    );
                  }
                } finally {
                  setCheckingAll(false);
                }
              }}
              disabled={servers.length === 0 || checkingAll}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-sh-line text-xs text-sh-muted hover:text-sh-fg disabled:opacity-50 sh-tap"
            >
              <Activity className="w-3.5 h-3.5" aria-hidden />
              {checkingAll ? '检测中…' : '全部检测'}
            </button>
            <button
              onClick={() => onOpenAddModal('server')}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-sh-accent text-sh-accent-fg text-xs font-semibold sh-tap"
            >
              <Plus className="w-3.5 h-3.5" aria-hidden />
              添加服务器
            </button>
          </>
        }
      />

      <div className="flex flex-wrap items-center gap-1.5 mb-3">
        {(
          [
            ['all', `全部 ${counts.all}`],
            ['never', `从未检测 ${counts.never}`],
            ['offline', `不可达 ${counts.offline}`],
            ['online', `可达 ${counts.online}`]
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            onClick={() => setFilter(id)}
            data-server-filter={id}
            className={`px-2.5 py-1 rounded-lg text-[11px] border transition-colors ${
              filter === id ? 'bg-sh-surface2 border-sh-line-strong text-sh-fg' : 'border-sh-line text-sh-muted'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <datalist id="server-group-known">
        {knownGroups.map((g) => (
          <option key={g} value={g} />
        ))}
      </datalist>

      {servers.length === 0 ? (
        <EmptyState
          icon={<Server className="w-5 h-5" />}
          title="还没有服务器"
          description="添加主机后可以复制 SSH 命令、记录部署路径，并检测 HTTP 是否可达。"
          action={
            <button onClick={() => onOpenAddModal('server')} className="px-3 py-1.5 rounded-lg bg-sh-accent text-sh-accent-fg text-xs font-semibold">
              添加服务器
            </button>
          }
        />
      ) : visible.length === 0 ? (
        <EmptyState title="当前筛选下没有服务器" description="切换上方筛选条件查看其他主机。" />
      ) : (
        /**
         * Grouped by 归属网站/项目 when any group exists; a fully ungrouped list keeps
         * the flat grid so casual users never see a pointless 「未分组」 header.
         */
        hasAnyGroup ? (
          <div className="space-y-5" data-testid="server-groups">
            {groupServers(visible).map(([label, list]) => (
              <section key={label || '__ungrouped__'} data-server-group={label || ''}>
                <div className="flex items-center gap-2 mb-1.5">
                  <FolderOpen className="w-3.5 h-3.5 text-sh-subtle" aria-hidden />
                  <h3 className="text-[11px] font-semibold text-sh-muted">
                    {label === '' ? '未分组' : label}
                  </h3>
                  <span className="text-[10px] text-sh-subtle">{list.length} 台</span>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
                  {list.map((server) => renderServer(server))}
                </div>
              </section>
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
            {visible.map((server) => renderServer(server))}
          </div>
        )
      )}
    </div>
  );

  function renderServer(server: ServerDeployment) {
    const expiryDays = Number.isFinite(daysUntil(server.expiresAt || NaN)) ? daysUntil(server.expiresAt || NaN) : null;
    const groupLabel = (server.group || '').trim();
    return (
      <div key={server.id} data-server-row={server.id}>
        <ServerCard server={server} onDelete={onDelete} onCheck={(id) => void onCheck(id)} />

        {onUpdate && (
          <div className="mt-1 px-1">
            {groupEditId === server.id ? (
              <form
                data-testid={`server-group-form-${server.id}`}
                className="mt-1 space-y-1.5 rounded-lg border border-sh-line p-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  const form = event.currentTarget as HTMLFormElement;
                  const value = (form.elements.namedItem('group') as HTMLInputElement).value.trim();
                  onUpdate({ ...server, group: value || undefined });
                  setGroupEditId(null);
                }}
              >
                <div className="flex flex-wrap items-center gap-1.5">
                  <input
                    name="group"
                    list="server-group-known"
                    defaultValue={groupLabel}
                    placeholder="归属网站/项目（如 官网）"
                    className="flex-1 min-w-[140px] bg-sh-surface2 border border-sh-line rounded px-2 py-1 text-[11px] text-sh-fg"
                  />
                  <button type="submit" className="px-2 py-1 rounded bg-sh-accent text-sh-accent-fg text-[11px] font-semibold">
                    保存
                  </button>
                  <button
                    type="button"
                    onClick={() => setGroupEditId(null)}
                    className="px-2 py-1 rounded border border-sh-line text-[11px]"
                  >
                    收起
                  </button>
                </div>
              </form>
            ) : (
              <button
                onClick={() => setGroupEditId(server.id)}
                data-testid={`server-group-edit-${server.id}`}
                className={`text-[11px] hover:underline ${groupLabel ? 'text-sh-info' : 'text-sh-subtle'}`}
              >
                {groupLabel ? `归属：${groupLabel}` : '+ 设置归属（网站/项目）'}
              </button>
            )}
          </div>
        )}

                {/*
                  备注项: arbitrary label/value pairs (SSH tunnels, panel URLs, accounts…).
                  Repeating something that already lives in 域名 or 凭据 is allowed on purpose.
                */}
                {(server.extras?.length ?? 0) > 0 && (
                  <ul
                    className="mt-1 px-1 space-y-0.5"
                    data-server-extras={server.id}
                    data-testid={`server-extras-${server.id}`}
                  >
                    {server.extras!.map((extra) => (
                      <li key={extra.id} className="flex items-baseline gap-1.5 text-[11px]">
                        <span className="text-sh-subtle shrink-0">{extra.label}</span>
                        <span className="text-sh-muted font-mono break-all">{extra.value}</span>
                      </li>
                    ))}
                  </ul>
                )}

                {onUpdate && (
                  <div className="mt-1 px-1">
                    {extrasOpenId === server.id ? (
                      <form
                        data-testid={`server-extra-form-${server.id}`}
                        className="mt-1 space-y-1.5 rounded-lg border border-sh-line p-2"
                        onSubmit={(event) => {
                          event.preventDefault();
                          const form = event.currentTarget as HTMLFormElement;
                          const label = (form.elements.namedItem('label') as HTMLInputElement).value.trim();
                          const value = (form.elements.namedItem('value') as HTMLInputElement).value.trim();
                          if (!label || !value) return;
                          onUpdate({
                            ...server,
                            extras: [
                              ...(server.extras ?? []),
                              { id: `extra-${Date.now()}`, label, value }
                            ]
                          });
                          form.reset();
                        }}
                      >
                        <div className="flex flex-wrap items-center gap-1.5">
                          <input
                            name="label"
                            placeholder="名称（如 SSH 映射）"
                            className="w-28 bg-sh-surface2 border border-sh-line rounded px-2 py-1 text-[11px] text-sh-fg"
                          />
                          <input
                            name="value"
                            placeholder="内容（如 127.0.0.1:8080 → 10.0.0.2:80）"
                            className="flex-1 min-w-[140px] bg-sh-surface2 border border-sh-line rounded px-2 py-1 text-[11px] text-sh-fg font-mono"
                          />
                          <button type="submit" className="px-2 py-1 rounded bg-sh-accent text-sh-accent-fg text-[11px] font-semibold">
                            添加
                          </button>
                          <button
                            type="button"
                            onClick={() => setExtrasOpenId(null)}
                            className="px-2 py-1 rounded border border-sh-line text-[11px]"
                          >
                            收起
                          </button>
                        </div>
                        {(server.extras ?? []).length > 0 && (
                          <div className="flex flex-wrap gap-1">
                            {server.extras!.map((extra) => (
                              <ConfirmButton
                                key={extra.id}
                                onConfirm={() =>
                                  onUpdate({ ...server, extras: server.extras!.filter((entry) => entry.id !== extra.id) })
                                }
                                confirmLabel="确认删除？"
                                className="px-1.5 py-0.5 rounded border border-sh-line text-[10px] text-sh-danger"
                              >
                                删除 {extra.label}
                              </ConfirmButton>
                            ))}
                          </div>
                        )}
                      </form>
                    ) : (
                      <button
                        onClick={() => setExtrasOpenId(server.id)}
                        data-testid={`server-extra-add-${server.id}`}
                        className="text-[11px] text-sh-info hover:underline"
                      >
                        + 备注项（SSH 映射、面板、账号…）
                      </button>
                    )}
                  </div>
                )}

                {expiryDays !== null && (
                  <div className="mt-1 px-1">
                    <StatusDot
                      tone={expiryDays < 0 ? 'danger' : expiryDays <= 14 ? 'warn' : 'neutral'}
                      label={
                        expiryDays < 0
                          ? `已过期 ${Math.abs(expiryDays)} 天`
                          : expiryDays === 0
                            ? '今天到期'
                            : `${expiryDays} 天后到期`
                      }
                    />
                  </div>
                )}
      </div>
    );
  }
};

export default ServersView;
