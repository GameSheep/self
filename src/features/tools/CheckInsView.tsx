import React from 'react';
import { CheckSquare, Plus } from 'lucide-react';
import type { CheckInTask } from '../../types';
import { CheckInCard } from '../../components/cards/CheckInCard';
import { EmptyState, PageHeader, StatusPill } from '../../shared/ui';
import { unconfiguredSites, type SupportedCheckInSite } from '../../domain/checkinSites';
import { hasRunToday } from '../../lib/checkInHistory';

export interface CheckInsViewProps {
  checkIns: CheckInTask[];
  /** `mode: 'open_page'` opens the site; `'mark_done'` records the user's confirmation. */
  onRun: (id: string, mode: 'open_page' | 'mark_done') => Promise<void>;
  onDelete: (id: string) => void;
  onOpenAddModal: (type?: 'site' | 'server' | 'secret' | 'checkin' | 'note') => void;
  /** Add a site from the supported-site catalogue (one click, then it appears in the list). */
  onAddFromTemplate?: (site: SupportedCheckInSite) => void;
}

/**
 * 签到网站 (P1-07, simplified 2026-10).
 * Not an automation feature any more: this is a list of sites the user wants to
 * confirmed — it never fires requests on anyone's behalf.
 */
export const CheckInsView: React.FC<CheckInsViewProps> = ({
  checkIns,
  onRun,
  onDelete,
  onOpenAddModal,
  onAddFromTemplate
}) => {
  const doneToday = checkIns.filter((t) => hasRunToday(t)).length;
  /** Supported sites the user has not added yet. They are never listed as tasks. */
  const available = unconfiguredSites(checkIns);

  return (
    <div data-testid="checkins-view">
      <PageHeader
        title="签到网站"
        description="需要每天手动签到的网站清单。点「打开网站」去签，签完回来点「标记今天已签」记录一笔——应用不会替你签到。"
        actions={
          <button
            onClick={() => onOpenAddModal('checkin')}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-sh-accent text-sh-accent-fg text-xs font-semibold sh-tap"
          >
            <Plus className="w-3.5 h-3.5" aria-hidden />
            添加签到网站
          </button>
        }
      />

      <div className="flex flex-wrap items-center gap-2 mb-3">
        <StatusPill tone="neutral" label={`共 ${checkIns.length} 个站点`} />
        {checkIns.length > 0 && (
          <>
            <StatusPill tone="ok" label={`今日已签 ${doneToday}`} />
            <StatusPill tone={checkIns.length - doneToday > 0 ? 'warn' : 'neutral'} label={`待签 ${checkIns.length - doneToday}`} />
          </>
        )}
      </div>

      {/*
        7.1: the supported sites are a *catalogue*, not the list. They are visible so you can
        pick one, and the list above/below only ever shows what you actually added.
      */}
      {onAddFromTemplate && available.length > 0 && (
        <div className="mb-3 rounded-xl border border-sh-line bg-sh-surface px-3 py-2" data-testid="checkin-catalog">
          <p className="text-[11px] text-sh-muted mb-1.5">常见签到站点（点一下加入清单）</p>
          <div className="flex flex-wrap gap-1.5">
            {available.map((site) => (
              <button
                key={site.id}
                onClick={() => onAddFromTemplate(site)}
                data-testid={`checkin-catalog-${site.id}`}
                title={site.note}
                className="px-2 py-1 rounded-lg border border-sh-line text-[11px] text-sh-muted hover:text-sh-fg hover:bg-sh-surface2"
              >
                + {site.name}
              </button>
            ))}
          </div>
        </div>
      )}

      {checkIns.length === 0 ? (
        <EmptyState
          icon={<CheckSquare className="w-5 h-5" />}
          title="还没有签到网站"
          description="把需要每天手动签到的网站加进来，每天从这里打开、签完记一笔。"
          action={
            <button onClick={() => onOpenAddModal('checkin')} className="px-3 py-1.5 rounded-lg bg-sh-accent text-sh-accent-fg text-xs font-semibold">
              添加签到网站
            </button>
          }
        />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
          {checkIns.map((task) => (
            <CheckInCard key={task.id} task={task} onRun={onRun} onDelete={onDelete} />
          ))}
        </div>
      )}
    </div>
  );
};

export default CheckInsView;
