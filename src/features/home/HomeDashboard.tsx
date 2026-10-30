import React, { useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  Bell,
  CheckSquare,
  FileText,
  Globe,
  Lock,
  Plus,
  RefreshCw,
  ShieldCheck,
  Unlock
} from 'lucide-react';
import type { HubState, InboxItem } from '../../types';
import { EmptyState, inputClass } from '../../shared/ui';
import { HomeSearch } from './HomeSearch';
import { HomeSiteTile } from './HomeSiteTile';
import type { SearchHit } from '../../domain/search';
import { selectHomeSites, selectOpsSummary } from '../../domain/home';
import { daysUntil, formatRelative } from '../../lib/dates';

export interface CaptureResult {
  ok: boolean;
  message?: string;
  error?: string;
  /** Present when the capture became (or already was) an inbox entry. */
  id?: string;
  /** False when the same content was captured twice — the row is not duplicated. */
  created?: boolean;
  /** True when the local write was refused (read-only schema) — the UI must not claim success. */
  readOnly?: boolean;
}

export interface HomeDashboardProps {
  state: HubState;
  onNavigate: (path: string) => void;
  onVisitSite: (id: string) => void;
  onCapture: (raw: string, source: InboxItem['source']) => CaptureResult;
  onOpenAddModal: (type?: 'site' | 'note') => void;
  onOpenSearchHit?: (hit: SearchHit) => void;
  backupStatus?: { status: string; lastAt?: number; message?: string };
  /** True only after unlocking; the summary never displays credential contents. */
  vaultUnlocked?: boolean;
  onRequireUnlock?: () => void;
}

/** Search and capture first, followed by shortcuts and recent work. */
export const HomeDashboard: React.FC<HomeDashboardProps> = ({
  state,
  onNavigate,
  onVisitSite,
  onCapture,
  onOpenAddModal,
  onOpenSearchHit,
  backupStatus,
  vaultUnlocked = false,
  onRequireUnlock
}) => {
  const [captureText, setCaptureText] = useState('');
  const [feedback, setFeedback] = useState<CaptureResult | null>(null);

  const ops = useMemo(() => selectOpsSummary(state, vaultUnlocked), [state, vaultUnlocked]);

  const notes = useMemo(
    () => [...(state.notes ?? [])].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, 5),
    [state.notes]
  );

  /**
   * Most-used sites, pinned first. `selectHomeSites` orders by pin → visit
   * count → recency over the whole collection, then slices — so a pinned site
   * can never crowd out the actually-visited ones and the limit applies after
   * the grouping filter below.
   */
  const [siteGroup, setSiteGroup] = useState('全部');
  const siteGroups = useMemo(() => {
    const set = new Set<string>(['全部']);
    for (const site of state.sites || []) if (site.category) set.add(site.category);
    return Array.from(set);
  }, [state.sites]);
  const sites = useMemo(
    () => selectHomeSites(state, 12, siteGroup === '全部' ? undefined : siteGroup),
    [state, siteGroup]
  );
  const siteGroupTotal = useMemo(() => {
    if (siteGroup === '全部') return (state.sites || []).length;
    return (state.sites || []).filter((s) => s.category === siteGroup).length;
  }, [state.sites, siteGroup]);

  const dueReminders = useMemo(
    () =>
      [...(state.reminders ?? [])]
        .filter((reminder) => !reminder.completed)
        .map((reminder) => ({ reminder, days: daysUntil(reminder.targetDate) }))
        .sort((a, b) => a.days - b.days)
        .slice(0, 6),
    [state.reminders]
  );

  const checkIns = useMemo(() => (state.checkIns ?? []).slice(0, 6), [state.checkIns]);
  const pendingInbox = (state.inbox ?? []).filter((item) => item.status === 'inbox').length;

  const submitCapture = (event: React.FormEvent) => {
    event.preventDefault();
    const raw = captureText.trim();
    if (!raw) return;
    const result = onCapture(raw, 'home');
    setFeedback(result);
    if (result.ok) {
      setCaptureText('');
      setTimeout(() => setFeedback(null), 2600);
    }
  };

  const openNote = (id: string) => onNavigate(`#/library/item/note:${id}`);

  return (
    <div data-testid="home-view" className="space-y-6">
      <section className="space-y-3" aria-label="搜索与记录">
        {onOpenSearchHit && <HomeSearch state={state} onOpenHit={onOpenSearchHit} />}
        <form onSubmit={submitCapture} className="flex flex-wrap items-center gap-2" data-home-block="capture">
          <input
            value={captureText}
            onChange={(e) => setCaptureText(e.target.value)}
            placeholder="记一笔，或粘贴链接…"
            aria-label="快速记录"
            data-testid="home-capture-input"
            className={inputClass + ' flex-1 min-w-0 !min-h-10'}
          />
          <button type="submit" data-testid="home-capture-submit" disabled={!captureText.trim()}
            className="sh-tap px-4 rounded-lg bg-sh-accent text-sh-accent-fg text-sm font-medium disabled:opacity-50">
            记到收件箱
          </button>
          {pendingInbox > 0 && <button type="button" onClick={() => onNavigate('#/inbox')}
            className="sh-tap text-xs text-sh-muted hover:text-sh-fg">待整理 {pendingInbox} 条 <ArrowRight className="inline w-3 h-3" aria-hidden /></button>}
        </form>
        {feedback && <p role="status" data-testid="home-capture-feedback"
          className={'text-xs ' + (feedback.ok ? 'text-sh-ok' : 'text-sh-danger')}>
          {feedback.ok ? feedback.message || '已保存到本机' : feedback.error || '保存失败'}
        </p>}
      </section>

      <section data-home-block="sites" aria-labelledby="home-sites-title">
        <header className="flex flex-wrap items-center justify-between gap-2 mb-3">
          <h2 id="home-sites-title" className="text-sm font-semibold text-sh-fg">常用网站</h2>
          <div className="flex items-center gap-4">
            <button onClick={() => onOpenAddModal('site')} className="sh-tap inline-flex items-center gap-1 text-xs text-sh-muted hover:text-sh-fg">
              <Plus className="w-3.5 h-3.5" aria-hidden />添加网站
            </button>
            <button onClick={() => onNavigate('#/navigation')} className="sh-tap inline-flex items-center gap-1 text-xs text-sh-muted hover:text-sh-fg">
              全部网站 <ArrowRight className="w-3.5 h-3.5" aria-hidden />
            </button>
          </div>
        </header>
        {sites.length === 0 ? <EmptyState icon={<Globe className="w-5 h-5" />} title="添加常用网站，从这里一键打开"
          action={<button onClick={() => onOpenAddModal('site')} className="sh-tap px-3 rounded-lg bg-sh-accent text-sh-accent-fg text-sm">添加网站</button>} /> : (
          <>
            {siteGroups.length > 1 && (
              <div className="flex flex-wrap items-center gap-1.5 mb-3">
                {siteGroups.map((g) => (
                  <button
                    key={g}
                    onClick={() => setSiteGroup(g)}
                    className={`sh-tap px-2 py-0.5 rounded-lg text-[11px] border transition-colors ${
                      siteGroup === g ? 'bg-sh-surface2 border-sh-line-strong text-sh-fg' : 'border-sh-line text-sh-muted hover:text-sh-fg'
                    }`}
                  >
                    {g}
                  </button>
                ))}
              </div>
            )}
            <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8 gap-3">
              {sites.map((site) => <HomeSiteTile key={site.id} site={site} onVisit={onVisitSite} />)}
            </div>
            {siteGroupTotal > 12 && (
              <p className="mt-2.5 text-[11px] text-sh-subtle">
                显示最常用的前 12 个，共 {siteGroupTotal} 个 ·{' '}
                <button onClick={() => onNavigate('#/navigation')} className="sh-tap text-sh-info hover:underline">查看全部</button>
              </p>
            )}
          </>
        )}
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <section data-home-block="continue" aria-labelledby="home-notes-title" className="min-w-0">
          <header className="flex items-center justify-between gap-2 mb-2">
            <h2 id="home-notes-title" className="text-sm font-semibold text-sh-fg">最近笔记</h2>
            <button onClick={() => onNavigate('#/library?view=notes')} className="sh-tap inline-flex items-center gap-1 text-xs text-sh-muted hover:text-sh-fg">
              全部笔记 <ArrowRight className="w-3.5 h-3.5" aria-hidden />
            </button>
          </header>
          <div className="border-t border-sh-line">
            {notes.length === 0 ? <div className="py-5 text-sm text-sh-subtle">
              <p>把想留下的内容写成第一篇笔记。</p>
              <button onClick={() => onOpenAddModal('note')} className="sh-tap mt-1 text-sh-info">新建笔记 <ArrowRight className="inline w-3 h-3" aria-hidden /></button>
            </div> : notes.map((note) => <button key={note.id} onClick={() => openNote(note.id)} data-testid={'home-note-' + note.id}
              className="w-full text-left flex items-center gap-3 py-3 px-2 border-b border-sh-line/60 hover:bg-sh-surface2 rounded-lg">
              <FileText className="w-4 h-4 text-sh-subtle shrink-0" aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="block text-sm text-sh-fg truncate">{note.title || '未命名笔记'}</span>
                {note.folder && <span className="block text-xs text-sh-subtle truncate">{note.folder}</span>}
              </span>
              <span className="text-xs text-sh-subtle shrink-0">{formatRelative(note.updatedAt)}</span>
            </button>)}
          </div>
        </section>

        <section data-home-block="todo" aria-labelledby="home-reminders-title" className="min-w-0">
          <header className="flex items-center justify-between gap-2 mb-2">
            <h2 id="home-reminders-title" className="text-sm font-semibold text-sh-fg">待办与提醒</h2>
            <button onClick={() => onNavigate('#/reminders')} className="sh-tap inline-flex items-center gap-1 text-xs text-sh-muted hover:text-sh-fg">
              全部提醒 <ArrowRight className="w-3.5 h-3.5" aria-hidden />
            </button>
          </header>
          <div className="border-t border-sh-line">
            {dueReminders.length === 0 ? <p className="py-5 text-sm text-sh-subtle">暂无待处理的提醒。</p> : (
              <ul>{dueReminders.map(({reminder, days}) => <li key={reminder.id}>
                <button onClick={() => onNavigate('#/reminders')} className="w-full flex items-center gap-3 text-left py-3 px-2 border-b border-sh-line/60 hover:bg-sh-surface2 rounded-lg">
                  <Bell className="w-4 h-4 text-sh-subtle shrink-0" aria-hidden />
                  <span className="flex-1 min-w-0 text-sm text-sh-fg truncate">{reminder.title}</span>
                  <span className={'text-xs shrink-0 ' + (days < 0 ? 'text-sh-danger' : days <= 7 ? 'text-sh-warn' : 'text-sh-subtle')}>
                    {days < 0 ? '已过期 ' + Math.abs(days) + ' 天' : days === 0 ? '今天到期' : days + ' 天后'}
                  </span>
                </button>
              </li>)}</ul>
            )}
          </div>
          <div data-testid="home-checkins" className="mt-3 border-t border-sh-line pt-2">
            <button onClick={() => onNavigate('#/tools/checkins')} className="sh-tap w-full flex items-center gap-2 text-sm text-sh-muted hover:text-sh-fg">
              <CheckSquare className="w-4 h-4" aria-hidden />签到
              <span className="flex-1 text-right text-xs text-sh-subtle">{state.checkIns?.length ? state.checkIns.length + ' 项任务' : '添加签到任务'}</span>
              <ArrowRight className="w-3.5 h-3.5" aria-hidden />
            </button>
            {checkIns.map((task) => <button key={task.id} onClick={() => onNavigate('#/tools/checkins')}
              className="sh-tap w-full flex items-center justify-between gap-2 px-2 text-left hover:bg-sh-surface2 rounded-lg">
              <span className="text-sm text-sh-fg truncate">{task.name}</span>
              <span className={'text-xs shrink-0 ' + (task.lastStatus === 'failed' ? 'text-sh-danger' : task.lastStatus === 'success' ? 'text-sh-ok' : 'text-sh-subtle')}>
                {task.lastStatus === 'failed' ? '上次失败' : task.lastStatus === 'success' ? '上次成功' : '未执行'}
              </span>
            </button>)}
          </div>
        </section>
      </div>
        {(ops.serversTotal > 0 || ops.secretsTotal > 0) && (
          <section className="grid grid-cols-1 sm:grid-cols-3 gap-3 border-t border-sh-line pt-4" data-home-block="ops">
            <h2 className="sm:col-span-3 text-sm font-semibold text-sh-fg">资源摘要</h2>
            <button
              onClick={() => onNavigate('#/resources/servers')}
              className="w-full text-left rounded-xl border border-sh-line p-2.5 hover:border-sh-line-strong"
            >
              <span className="block text-[11px] text-sh-muted">服务器</span>
              <span className="block text-sm text-sh-fg">{ops.serversTotal} 台</span>
              <span className="block text-[11px] text-sh-subtle">
                {ops.serversNeverChecked > 0 ? `${ops.serversNeverChecked} 台从未检测` : '都有检测记录'}
                {ops.serversOffline > 0 ? ` · ${ops.serversOffline} 台不可达` : ''}
              </span>
            </button>
            <button
              onClick={() => onNavigate('#/reminders')}
              className="w-full text-left rounded-xl border border-sh-line p-2.5 hover:border-sh-line-strong"
            >
              <span className="block text-[11px] text-sh-muted">30 天内到期</span>
              <span className="block text-sm text-sh-fg">{ops.expiringAssets} 项</span>
              <span className="block text-[11px] text-sh-subtle">域名、订阅、证书与服务器</span>
            </button>
            <div className="rounded-xl border border-sh-line p-2.5">
              <span className="block text-[11px] text-sh-muted">凭证金库</span>
              <span className="flex items-center gap-1.5 text-sm text-sh-fg">
                {ops.vaultLocked ? (
                  <Lock className="w-3.5 h-3.5 text-sh-warn" aria-hidden />
                ) : (
                  <Unlock className="w-3.5 h-3.5 text-sh-ok" aria-hidden />
                )}
                {ops.vaultLocked ? '已锁定' : '已解锁'}
              </span>
              <span className="block text-[11px] text-sh-subtle">{ops.secretsTotal} 条凭据（不显示内容）</span>
              <button
                onClick={() => (ops.vaultLocked ? onRequireUnlock?.() : onNavigate('#/resources/vault'))}
                className="mt-1 text-[11px] text-sh-info hover:underline inline-flex items-center gap-1"
              >
                <ShieldCheck className="w-3 h-3" aria-hidden />
                {ops.vaultLocked ? '解锁' : '打开金库'}
              </button>
            </div>
          </section>
        )}

      <div className="border-t border-sh-line pt-4 flex flex-wrap items-center justify-between gap-2 text-xs text-sh-subtle">
        <span className="inline-flex items-center gap-1.5"><ShieldCheck className="w-3.5 h-3.5" aria-hidden />数据保存在这台设备的浏览器中</span>
        <span className="inline-flex items-center gap-2">
          {backupStatus?.lastAt ? '最近备份 ' + new Date(backupStatus.lastAt).toLocaleString() : '尚未备份到云端'}
          <button onClick={() => onNavigate('#/settings/storage')} className="sh-tap inline-flex items-center gap-2 hover:text-sh-fg">
            {backupStatus?.status === 'error' ? <AlertTriangle className="w-3.5 h-3.5 text-sh-danger" aria-hidden /> : <RefreshCw className="w-3.5 h-3.5" aria-hidden />}
            查看详情
          </button>
        </span>
        {backupStatus?.status === 'error' && <p role="status" className="w-full text-sh-danger">最近一次备份失败：{backupStatus.message || '未知原因'}</p>}
      </div>
    </div>
  );
};

export default HomeDashboard;
