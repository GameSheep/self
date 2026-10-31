import React from 'react';
import { ChevronLeft, ChevronRight, Lock, Settings as SettingsIcon, Unlock } from 'lucide-react';
import { visibleNavItems, navOwnerForRoute, navChildForRoute, type NavItem } from '../app/navigation';
import { buildRoute } from '../app/routes';
import type { FeatureFlags } from '../lib/features';
import type { RouteName } from '../app/routes';

interface SidebarProps {
  routeName: RouteName;
  /** `?view=` of the current route, so the library panes highlight correctly. */
  routeView?: string;
  /** `?type=` of the current route (the 批注 pane uses it). */
  routeType?: string;
  onNavigate: (path: string) => void;
  collapsed: boolean;
  setCollapsed: (c: boolean) => void;
  isUnlocked: boolean;
  onLockVault: () => void;
  onOpenMasterKeyModal: () => void;
  features?: Partial<FeatureFlags>;
  /** Only actionable counts; every other module shows no number. */
  inboxCount: number;
  reminderCount: number;
}

const GROUP_LABELS: Record<string, string> = {
  daily: '日常',
  manage: '管理'
};

/**
 * Left navigation (P1-01).
 * Two changes from the previous dock: the labels are the plain-language names
 * from the redesign ("服务器" not "自研部署与主机"), and the list is grouped into
 * · 日常 / 管理 with 设置 pinned to the bottom. Counts appear only where the number
 */
export const Sidebar: React.FC<SidebarProps> = ({
  routeName,
  routeView,
  routeType,
  onNavigate,
  collapsed,
  setCollapsed,
  isUnlocked,
  onLockVault,
  onOpenMasterKeyModal,
  features,
  inboxCount,
  reminderCount
}) => {
  const owner = navOwnerForRoute(routeName);
  const activeChildId = navChildForRoute(routeName, routeView, routeType);
  const items = visibleNavItems(features);
  const settingsEntry = {
    id: 'settings',
    label: '设置',
    route: buildRoute('settings', { section: 'overview' })
  };

  const badgeValue = (item: NavItem): number | null => {
    if (item.badge === 'inbox') return inboxCount || 0;
    if (item.badge === 'reminders') return reminderCount || 0;
    return null;
  };

  /** Registry children appear at the same visual level as the other destinations. */
  const renderChild = (parent: NavItem, child: NonNullable<NavItem['children']>[number]) => {
    const ChildIcon = child.icon;
    const childActive = activeChildId === child.id;
    return (
      <button
        key={`${parent.id}:${child.id}`}
        onClick={() => onNavigate(child.route)}
        aria-current={childActive ? 'page' : undefined}
        data-nav-child={child.id}
        title={child.label}
        aria-label={child.label}
        className={`w-full min-h-9 flex items-center gap-2.5 rounded-lg text-[13px] transition-colors ${
          collapsed ? 'justify-center px-0 py-1.5' : 'px-3 py-1.5'
        } ${
          childActive ? 'text-sh-fg font-medium bg-sh-surface2' : 'text-sh-muted hover:text-sh-fg hover:bg-sh-surface2'
        }`}
      >
        <ChildIcon className="w-4 h-4 shrink-0" aria-hidden />
        {!collapsed && <span className="truncate">{child.label}</span>}
      </button>
    );
  };

  const renderItem = (item: NavItem, nested = false) => {
    const Icon = item.icon;
    const isActive = owner === item.id;
    const count = nested ? null : badgeValue(item);
    // Keep semantic groups and feature filtering without adding another visible heading.
    const isGroup = Boolean(item.children?.length) && !nested;
    if (isGroup) {
      return (
        <div key={item.id} data-nav-parent={item.id} role="group" aria-label={item.label} className="space-y-0.5">
          {item.children?.map((child) => renderChild(item, child))}
        </div>
      );
    }
    return (
      <button
        key={item.id}
        onClick={() => onNavigate(item.route)}
        aria-current={isActive ? 'page' : undefined}
        data-nav-item={item.id}
        className={`w-full min-h-9 flex items-center gap-3 rounded-lg text-[13px] transition-colors ${
          nested ? 'pl-6 pr-2 py-1.5' : 'px-3 py-1.5'
        } ${collapsed && !nested ? 'justify-center px-0' : 'justify-between'} ${
          isActive
            ? 'bg-sh-surface2 text-sh-fg font-semibold border border-sh-line-strong/60'
            : 'text-sh-muted hover:text-sh-fg hover:bg-sh-surface2'
        }`}
        title={item.label}
        aria-label={item.label}
      >
        <span className="flex items-center gap-2.5 min-w-0">
          <Icon className={`shrink-0 ${nested ? 'w-3.5 h-3.5' : 'w-4 h-4'}`} aria-hidden />
          {!collapsed && <span className="truncate">{item.label}</span>}
        </span>
        {!collapsed && count !== null && count > 0 && (
          <span
            className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-sh-bg text-sh-muted border border-sh-line"
            aria-label={`${count} 项待处理`}
          >
            {count}
          </span>
        )}
      </button>
    );
  };

  const groups: Array<'daily' | 'manage'> = ['daily', 'manage'];

  return (
    <aside
      data-testid="sidebar"
      className={`hidden md:flex flex-col justify-between shrink-0 border-r border-sh-line bg-sh-surface transition-all duration-200 z-30 select-none ${
        collapsed ? 'w-16' : 'w-52'
      }`}
    >
      <div className="min-h-0 flex-1 flex flex-col">
        <div className="h-14 px-3 flex items-center justify-between border-b border-sh-line shrink-0">
          {!collapsed ? (
            <div className="flex items-center gap-2.5 min-w-0">
              <div className="w-8 h-8 rounded-lg bg-sh-surface2 border border-sh-line flex items-center justify-center text-sh-fg font-semibold shrink-0">
                <span className="text-sm font-mono">H</span>
              </div>
              <div className="min-w-0">
                <span className="font-semibold text-sm tracking-tight text-sh-fg block truncate">Self-Hub</span>
                <span className="text-[10px] text-sh-subtle font-mono block truncate">本机数据</span>
              </div>
            </div>
          ) : (
            <div className="mx-auto w-8 h-8 rounded-lg bg-sh-surface2 border border-sh-line flex items-center justify-center text-sh-fg font-semibold">
              <span className="text-sm font-mono">H</span>
            </div>
          )}
          <button
            onClick={() => setCollapsed(!collapsed)}
            className="p-1 rounded-lg hover:bg-sh-surface2 text-sh-subtle hover:text-sh-fg transition-colors"
            title={collapsed ? '展开侧边栏' : '收起侧边栏'}
            aria-label={collapsed ? '展开侧边栏' : '收起侧边栏'}
          >
            {collapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
          </button>
        </div>

        <nav className="p-2 space-y-3 overflow-y-auto flex-1" aria-label="主导航">
          {groups.map((group) => {
            const groupItems = items.filter((i) => i.group === group);
            if (groupItems.length === 0) return null;
            return (
              <div key={group} className="space-y-0.5">
                {!collapsed && (
                  <div className="px-3 pt-1 pb-1 text-xs text-sh-subtle">
                    {GROUP_LABELS[group]}
                  </div>
                )}
                {groupItems.map((item) => (
                  <React.Fragment key={item.id}>{renderItem(item)}</React.Fragment>
                ))}
              </div>
            );
          })}
        </nav>
      </div>

      <div className="p-2 border-t border-sh-line space-y-1.5 shrink-0">
        {isUnlocked ? (
          <button
            onClick={onLockVault}
            className={`w-full flex items-center gap-2 px-2.5 py-2 rounded-xl bg-sh-ok/10 border border-sh-ok/40 text-sh-ok hover:bg-sh-ok/20 text-xs transition-colors sh-tap ${
              collapsed ? 'justify-center px-0' : 'justify-between'
            }`}
            title="金库已解锁，点击立即锁定并清除内存中的明文"
          >
            <span className="flex items-center gap-2">
              <Unlock className="w-3.5 h-3.5 shrink-0" aria-hidden />
              {!collapsed && <span>金库已解锁</span>}
            </span>
            {!collapsed && <span className="text-[10px] opacity-80">点击锁定</span>}
          </button>
        ) : (
          <button
            onClick={onOpenMasterKeyModal}
            className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sh-muted hover:text-sh-fg hover:bg-sh-surface2 text-xs transition-colors sh-tap ${
              collapsed ? 'justify-center px-0' : 'justify-between'
            }`}
            title="金库锁定中，点击输入主密码解锁"
          >
            <span className="flex items-center gap-2">
              <Lock className="w-3.5 h-3.5 shrink-0" aria-hidden />
              {!collapsed && <span>金库已锁定</span>}
            </span>
            {!collapsed && <span className="text-[10px] opacity-80">解锁</span>}
          </button>
        )}

        <button
          onClick={() => onNavigate(settingsEntry.route)}
          aria-current={owner === 'settings' ? 'page' : undefined}
          data-nav-item="settings"
          className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-xs transition-colors sh-tap ${
            collapsed ? 'justify-center px-0' : ''
          } ${
            owner === 'settings'
              ? 'bg-sh-surface2 text-sh-fg font-semibold border border-sh-line-strong/60'
              : 'text-sh-muted hover:text-sh-fg hover:bg-sh-surface2'
          }`}
          title="设置"
        >
          <span className="flex items-center gap-2.5 min-w-0">
            <SettingsIcon className="w-4 h-4 shrink-0" aria-hidden />
            {!collapsed && <span className="truncate">设置</span>}
          </span>
        </button>
      </div>
    </aside>
  );
};

export default Sidebar;
