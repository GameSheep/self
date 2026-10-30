/**
 * Navigation registry (P1-01).
 *
 * The old sidebar was an array literal inside `Sidebar.tsx` with eleven flat
 * entries, and the top bar had a second, differently-worded copy of the same
 * list. Two sources meant two ways to be wrong. Everything now reads this
 * registry: sidebar, mobile bar, mobile drawer, command-search hints and the
 * "back to" logic in settings.
 *
 * Three rules the registry encodes, from the design doc:
 * 1. Navigation grouping is a *preference*. Hiding an entry never changes
 *    whether a background task runs.
 * 2. Only inbox and pending reminders carry an actionable count. A total on
 *    every entry is noise, not information.
 * 3. A module can be hidden from the sidebar and still be reachable by URL.
 */
import type { LucideIcon } from 'lucide-react';
import {
  LayoutDashboard,
  Globe,
  Inbox,
  Library,
  FileText,
  Highlighter,
  Cloud,
  FolderKanban,
  Clock,
  ShieldCheck,
  Server,
  BadgeDollarSign,
  CheckSquare,
  PenTool,
  Settings
} from 'lucide-react';
import type { FeatureFlags } from '../lib/features';
import { isFeatureEnabled } from '../lib/features';
import type { HubState } from '../types';
import { buildRoute } from './routes';

export type NavGroup = 'daily' | 'manage' | 'system';

export interface NavChild {
  id: string;
  label: string;
  icon: LucideIcon;
  route: string;
  /** Which module switch governs visibility, when one does. */
  capability?: keyof FeatureFlags;
  /**
   * Visible when *any* of these switches is on.
   *
   * The 远端笔记 page holds three independent sources (OSS / 五彩 / 有道); a single capability
   * would hide the entry for a user who turned one of them off while still using another.
   */
  capabilities?: Array<keyof FeatureFlags>;
}

export interface NavItem {
  id: string;
  /** Plain-language label. The old names ("自研部署与主机") were the complaint. */
  label: string;
  icon: LucideIcon;
  route: string;
  group: NavGroup;
  /** Secondary entries render indented under their parent. */
  children?: NavChild[];
  capability?: keyof FeatureFlags;
  /** Counts only where the number implies an action. */
  badge?: 'inbox' | 'reminders';
  /** Shown as a pinned shortcut candidate on the home page. */
  defaultPinned?: boolean;
}

export const NAV_ITEMS: NavItem[] = [
  { id: 'home', label: '首页', icon: LayoutDashboard, route: buildRoute('home'), group: 'daily', defaultPinned: true },
  {
    id: 'navigation',
    label: '快捷导航',
    icon: Globe,
    route: buildRoute('navigation'),
    group: 'daily',
    defaultPinned: true
  },
  {
    id: 'inbox',
    label: '收件箱',
    icon: Inbox,
    route: buildRoute('inbox'),
    group: 'daily',
    capability: 'inbox',
    badge: 'inbox'
  },
  {
    id: 'library',
    label: '资料库',
    icon: Library,
    route: buildRoute('library'),
    group: 'daily',
    capability: 'notes',
    defaultPinned: true,
    /**
     * The three library panes are one route with a `view` query, so they get explicit
     * children: 「远端笔记（OSS）」 in particular was only reachable by noticing a tab inside
     * the library page, which is how a working feature reads as missing.
     */
    children: [
      {
        id: 'library-notes',
        label: '笔记',
        icon: FileText,
        route: `${buildRoute('library')}?view=notes`,
        capability: 'notes'
      },
      {
        id: 'library-annotations',
        label: '网页批注',
        icon: Highlighter,
        // Annotations are indexed as the `webpage` kind (see domain/library.ts).
        route: `${buildRoute('library')}?type=webpage`,
        capability: 'annotations'
      },
      {
        id: 'library-sources',
        label: '远端笔记',
        icon: Cloud,
        route: `${buildRoute('library')}?view=sources`,
        // Any of the three sources keeps the page reachable; each tab inside is gated on its own.
        capabilities: ['obsidian', 'wucai']
      }
    ]
  },
  {
    id: 'projects',
    label: '项目',
    icon: FolderKanban,
    route: buildRoute('projects'),
    group: 'daily',
    capability: 'projects'
  },
  {
    id: 'reminders',
    label: '提醒',
    icon: Clock,
    route: buildRoute('reminders'),
    group: 'daily',
    badge: 'reminders'
  },
  {
    id: 'resources',
    label: '资源与安全',
    icon: ShieldCheck,
    route: buildRoute('servers'),
    group: 'manage',
    children: [
      {
        id: 'servers',
        label: '服务器',
        icon: Server,
        route: buildRoute('servers'),
        capability: 'servers'
      },
      {
        id: 'assets',
        label: '域名',
        icon: BadgeDollarSign,
        route: buildRoute('assets'),
        capability: 'assets'
      },
      {
        id: 'vault',
        label: '凭证金库',
        icon: ShieldCheck,
        route: buildRoute('vault'),
        capability: 'secrets'
      }
    ]
  },
  {
    id: 'tools',
    label: '工具',
    icon: PenTool,
    route: buildRoute('checkins'),
    group: 'manage',
    children: [
      { id: 'checkins', label: '签到', icon: CheckSquare, route: buildRoute('checkins'), capability: 'checkin' },
      { id: 'drawing', label: '手绘', icon: PenTool, route: buildRoute('drawing'), capability: 'handwriting' }
    ]
  },
  { id: 'settings', label: '设置', icon: Settings, route: buildRoute('settings', { section: 'overview' }), group: 'system' }
];

/** Route names that belong to a nav entry, for active-state highlighting. */
const ROUTE_OWNER: Record<string, string> = {
  home: 'home',
  navigation: 'navigation',
  inbox: 'inbox',
  library: 'library',
  'library-item': 'library',
  projects: 'projects',
  project: 'projects',
  reminders: 'reminders',
  servers: 'resources',
  assets: 'resources',
  vault: 'resources',
  checkins: 'tools',
  drawing: 'tools',
  settings: 'settings',
  'settings-connection': 'settings'
};

/**
 * Which top-level entry owns a route. Sub-routes (`#/resources/vault`) highlight
 * their parent group so the sidebar never shows two active rows.
 */
export function navOwnerForRoute(routeName: string): string | null {
  return ROUTE_OWNER[routeName] ?? null;
}

/**
 * The second-level entry id, when the route is nested.
 *
 * The library child cannot be derived from the route name alone — all three panes are
 * `#/library` with a different `view` — so the caller passes that query through.
 */
export function navChildForRoute(routeName: string, view?: string, type?: string): string | null {
  if (routeName === 'library') {
    if (type === 'webpage' || type === 'annotation') return 'library-annotations';
    if (view === 'sources') return 'library-sources';
    // 笔记 is the default pane now that 全部资料 is gone.
    return 'library-notes';
  }
  return ['servers', 'assets', 'vault', 'checkins', 'drawing'].includes(routeName) ? routeName : null;
}

function capabilityEnabled(features: Partial<FeatureFlags> | undefined, id?: keyof FeatureFlags): boolean {
  if (!id) return true;
  return isFeatureEnabled(features, id);
}

/** A child with `capabilities` needs only one of them on; a child with none needs nothing. */
function childVisible(features: Partial<FeatureFlags> | undefined, child: NavChild): boolean {
  if (child.capabilities?.length) {
    return child.capabilities.some((id) => isFeatureEnabled(features, id));
  }
  return capabilityEnabled(features, child.capability);
}

/**
 * Items visible in the sidebar for the given preferences.
 *
 * A group with no visible children disappears, so turning off servers *and*
 * vault does not leave an orphan "资源与安全" heading behind.
 */
export function visibleNavItems(features: Partial<FeatureFlags> | undefined): NavItem[] {
  return NAV_ITEMS.filter((item) => item.group !== 'system').reduce<NavItem[]>((acc, item) => {
    if (!capabilityEnabled(features, item.capability)) return acc;
    if (item.children) {
      const children = item.children.filter((c) => childVisible(features, c));
      if (children.length === 0) return acc;
      acc.push({ ...item, children });
      return acc;
    }
    acc.push(item);
    return acc;
  }, []);
}

/** Resolve the label shown as the page title. */
export function navLabelForRoute(routeName: string, view?: string, type?: string): string {
  const owner = navOwnerForRoute(routeName);
  if (!owner) return '页面不存在';
  if (routeName === 'library-item') return '资料';
  if (routeName === 'project') return '项目';
  if (routeName === 'settings-connection') return '连接详情';
  if (routeName === 'settings') return '设置';
  const found = NAV_ITEMS.find((i) => i.id === owner);
  if (found?.children) {
    const child = found.children.find((c) => c.id === navChildForRoute(routeName, view, type));
    if (child) return child.label;
  }
  return found?.label ?? 'Self-Hub';
}

export interface NavCounts {
  inbox?: number;
  reminders?: number;
}

/** Counts for the entries that carry an actionable number. */
export function navCountsFromState(state: HubState): NavCounts {
  return {
    inbox: (state.inbox || []).filter((i) => i.status === 'inbox').length,
    reminders: (state.reminders || []).filter((r) => !r.completed).length
  };
}
