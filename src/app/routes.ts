/**
 * Hash routing (P1-01).
 *
 * Why a hand-rolled parser instead of a router dependency: the workspace runs
 * from a static `dist/` and from `chrome-extension://<id>/app/index.html`, so
 * History-API paths would need server rewrites and would break inside the
 * extension. Hash routing needs neither. Route strings are built and parsed in
 * exactly one place — views never concatenate their own URLs, which is what
 * makes deep links (搜索→条目, 通知→提醒) trustworthy.
 *
 * The route table mirrors docs/SELF_HUB_DEVELOPMENT.md §4.1.
 */

export type RouteName =
  | 'home'
  | 'navigation'
  | 'inbox'
  | 'library'
  | 'library-item'
  | 'projects'
  | 'project'
  | 'reminders'
  | 'servers'
  | 'assets'
  | 'vault'
  | 'checkins'
  | 'drawing'
  | 'settings'
  | 'settings-connection'
  | 'not-found';

export interface Route {
  name: RouteName;
  /** Path segments after the route (id, connection id, …). */
  params: Record<string, string>;
  /** Query-string values. Never holds credentials or unlock tokens. */
  query: Record<string, string>;
  /** Canonical hash for this route, e.g. `#/library?type=note`. */
  path: string;
}

/**
 * Settings sections that may appear in the URL (whitelist).
 *
 * The first seven are the redesigned panes (see SettingsModal). The trailing
 * five are the pre-redesign ids, kept addressable because they are in existing
 * bookmarks, notifications and tests: they resolve to the pane that now holds
 * their content instead of 404-ing (`#/settings/data` → 数据与备份, …).
 */
export const SETTINGS_SECTIONS = [
  'overview',
  'preferences',
  'connections',
  'storage',
  'browser',
  'privacy',
  'maintenance',
  // Legacy aliases kept working for old links.
  'features',
  'sync',
  'content',
  'ai',
  'data'
] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

/**
 * Old `activeTab` values → new routes.
 *
 * Kept in the routing layer (not in the views) so a bookmark or an in-flight
 * click from an older bundle still lands somewhere sensible.
 */
export const LEGACY_TAB_ROUTES: Record<string, string> = {
  dashboard: '#/home',
  sites: '#/navigation',
  inbox: '#/inbox',
  notes: '#/library?type=note',
  projects: '#/projects',
  reminders: '#/reminders',
  servers: '#/resources/servers',
  secrets: '#/resources/vault',
  checkin: '#/tools/checkins',
  handwriting: '#/tools/drawing/new',
  obsidian: '#/library?source=oss',
  settings: '#/settings/overview'
};

export function routeForLegacyTab(tab: string): string {
  return LEGACY_TAB_ROUTES[tab] ?? '#/home';
}

function encodeQuery(query: Record<string, string>): string {
  const parts = Object.entries(query)
    .filter(([, v]) => v !== undefined && v !== null && `${v}`.length > 0)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  return parts.length ? `?${parts.join('&')}` : '';
}

/** Build a canonical hash route. Pass an already-normalised path (no `#`). */
export function buildRoute(name: RouteName, params: Record<string, string> = {}, query: Record<string, string> = {}): string {
  const q = encodeQuery(query);
  const id = params.id ? `/${encodeURIComponent(params.id)}` : '';
  switch (name) {
    case 'home':
      return `#/home${q}`;
    case 'navigation':
      return `#/navigation${q}`;
    case 'inbox':
      return `#/inbox${q}`;
    case 'library':
      return `#/library${q}`;
    case 'library-item':
      return `#/library/item${id}${q}`;
    case 'projects':
      return `#/projects${q}`;
    case 'project':
      return `#/projects${id}${q}`;
    case 'reminders':
      return `#/reminders${q}`;
    case 'servers':
      return `#/resources/servers${q}`;
    case 'assets':
      return `#/resources/assets${q}`;
    case 'vault':
      return `#/resources/vault${q}`;
    case 'checkins':
      return `#/tools/checkins${q}`;
    case 'drawing':
      return `#/tools/drawing/new${q}`;
    case 'settings':
      return `#/settings/${params.section || 'overview'}${q}`;
    case 'settings-connection':
      return `#/settings/connections${id}${q}`;
    default:
      return `#/home${q}`;
  }
}

function parseQuery(search: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!search) return out;
  for (const pair of search.replace(/^\?/, '').split('&')) {
    if (!pair) continue;
    const idx = pair.indexOf('=');
    const rawKey = idx === -1 ? pair : pair.slice(0, idx);
    const rawValue = idx === -1 ? '' : pair.slice(idx + 1);
    if (!rawKey) continue;
    try {
      out[decodeURIComponent(rawKey)] = decodeURIComponent(rawValue);
    } catch {
      // A malformed escape must not blank the whole app.
      out[rawKey] = rawValue;
    }
  }
  return out;
}

export function notFound(path = '#/home'): Route {
  return { name: 'not-found', params: {}, query: {}, path };
}

/**
 * Parse `location.hash` into a route. Unknown or malformed hashes become
 * `not-found` so the shell can show an explicit "页面不存在" state with a way
 * back — never a blank screen.
 */
export function parseHash(hash: string): Route {
  const raw = (hash || '').replace(/^#/, '');
  const [pathPart, queryPart] = raw.split('?');
  const query = parseQuery(queryPart);
  const segments = pathPart.split('/').filter(Boolean).map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  });

  if (segments.length === 0) return { name: 'home', params: {}, query, path: '#/home' };

  const [first, second, third] = segments;

  switch (first) {
    case 'home':
      return { name: 'home', params: {}, query, path: buildRoute('home', {}, query) };
    case 'navigation':
      return { name: 'navigation', params: {}, query, path: buildRoute('navigation', {}, query) };
    case 'inbox':
      return { name: 'inbox', params: {}, query, path: buildRoute('inbox', {}, query) };
    case 'library':
      if (second === 'item') {
        if (!third) return notFound('#/library');
        return { name: 'library-item', params: { id: third }, query, path: buildRoute('library-item', { id: third }, query) };
      }
      if (second) return notFound(hash);
      return { name: 'library', params: {}, query, path: buildRoute('library', {}, query) };
    case 'projects':
      if (second) return { name: 'project', params: { id: second }, query, path: buildRoute('project', { id: second }, query) };
      return { name: 'projects', params: {}, query, path: buildRoute('projects', {}, query) };
    case 'reminders':
      return { name: 'reminders', params: {}, query, path: buildRoute('reminders', {}, query) };
    case 'resources':
      if (second === 'servers') return { name: 'servers', params: {}, query, path: buildRoute('servers', {}, query) };
      if (second === 'assets') return { name: 'assets', params: {}, query, path: buildRoute('assets', {}, query) };
      if (second === 'vault') return { name: 'vault', params: {}, query, path: buildRoute('vault', {}, query) };
      return notFound(hash);
    case 'tools':
      if (second === 'checkins') return { name: 'checkins', params: {}, query, path: buildRoute('checkins', {}, query) };
      if (second === 'drawing') return { name: 'drawing', params: {}, query, path: buildRoute('drawing', {}, query) };
      return notFound(hash);
    case 'settings': {
      if (!second) return { name: 'settings', params: { section: 'overview' }, query, path: buildRoute('settings', { section: 'overview' }, query) };
      if (second === 'connections') {
        if (!third) return { name: 'settings', params: { section: 'connections' }, query, path: buildRoute('settings', { section: 'connections' }, query) };
        return {
          name: 'settings-connection',
          params: { id: third },
          query,
          path: buildRoute('settings-connection', { id: third }, query)
        };
      }
      if ((SETTINGS_SECTIONS as readonly string[]).includes(second)) {
        return { name: 'settings', params: { section: second }, query, path: buildRoute('settings', { section: second }, query) };
      }
      return notFound('#/settings/overview');
    }
    default:
      return notFound(hash);
  }
}

/** Read the current route from the address bar (SSR/test safe). */
export function currentRoute(): Route {
  if (typeof window === 'undefined') return parseHash('#/home');
  return parseHash(window.location.hash);
}

/** Navigate without adding a history entry when the target is unchanged. */
export function navigate(path: string, replace = false): void {
  if (typeof window === 'undefined') return;
  if (window.location.hash === path) return;
  if (replace) {
    const url = `${window.location.pathname}${window.location.search}${path}`;
    window.history.replaceState(null, '', url);
    // replaceState does not fire hashchange, so notify listeners explicitly.
    let event: Event;
    try {
      event = new HashChangeEvent('hashchange');
    } catch {
      event = new Event('hashchange');
    }
    window.dispatchEvent(event);
  } else {
    window.location.hash = path;
  }
}
