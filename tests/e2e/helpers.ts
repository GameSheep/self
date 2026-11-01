import { Page, expect } from '@playwright/test';

export const STORAGE_KEY = 'self_hub_data_v2';

export interface StoredState {
  theme: string;
  sites: any[];
  servers: any[];
  secrets: any[];
  checkIns: any[];
  reminders: any[];
  notes: any[];
  handwritings: any[];
  inbox?: any[];
  projects?: any[];
  categories: string[];
}

/** Read the persisted HubState straight out of localStorage. */
export async function readState(page: Page): Promise<StoredState> {
  return page.evaluate((key) => {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : (null as any);
  }, STORAGE_KEY) as Promise<StoredState>;
}

/** Seed localStorage before the app boots (survives reloads in this context). */
/**
 * Seed localStorage before the app boots (survives reloads in this context).
 *
 * The first-run wizard is an overlay, so leaving it enabled would block every
 * unrelated test. Profiles seeded for feature tests are therefore marked as
 * already onboarded; onboarding.spec passes `{ onboarded: false }` explicitly.
 */
export async function seedState(
  page: Page,
  state: unknown,
  options: { onboarded?: boolean } = {}
) {
  const onboarded = options.onboarded ?? true;
  await page.addInitScript(
    ([key, value, flag]) => {
      window.localStorage.setItem(key as string, value as string);
      if (flag) window.localStorage.setItem('selfhub_onboarded', '1');
    },
    [STORAGE_KEY, JSON.stringify(state), onboarded] as const
  );
}

export async function resetApp(page: Page) {
  await page.goto('/');
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
    // A reset profile is "already onboarded": the wizard is an overlay and would
    // otherwise block every test that expects to interact with the app.
    localStorage.setItem('selfhub_onboarded', '1');
  });
  await page.reload();
  await expect(page.locator('main')).toBeVisible();
}

/**
 * Navigation labels → hash routes.
 * The redesign regrouped the navigation and renamed every module in plain
 */
export const TAB_ROUTES: Record<string, string> = {
  // Old labels kept for the existing suites.
  仪表盘总览: '/#/home',
  统一收件箱: '/#/inbox',
  自研项目空间: '/#/projects',
  倒计时与续费: '/#/reminders',
  网站与工作台: '/#/navigation',
  自研部署与主机: '/#/resources/servers',
  加密安全金库: '/#/resources/vault',
  深度知识文档: '/#/library?view=notes',
  自动化与打卡: '/#/tools/checkins',
  多平台数据互通: '/#/library?view=sources',
  交互手绘白板: '/#/tools/drawing/new',
  // New labels.
  首页: '/#/home',
  快捷导航: '/#/navigation',
  收件箱: '/#/inbox',
  资料库: '/#/library',
  项目: '/#/projects',
  提醒: '/#/reminders',
  服务器: '/#/resources/servers',
  域名与订阅: '/#/resources/assets',
  凭证金库: '/#/resources/vault',
  签到: '/#/tools/checkins',
  手绘: '/#/tools/drawing/new',
  网页批注: '/#/library?type=webpage',
  设置: '/#/settings/overview'
};

export async function gotoTab(page: Page, label: string) {
  const route = TAB_ROUTES[label];
  if (route) {
    await page.goto(route);
    await expect(page.locator('main')).toBeVisible();
    await page.waitForTimeout(150);
    return;
  }
  await page.locator('nav button', { hasText: label }).first().click();
  await page.waitForTimeout(250);
}

/** Current hash route, for asserting that navigation actually moved. */
export async function currentRoute(page: Page): Promise<string> {
  return page.evaluate(() => window.location.hash);
}

/** First visible element matching a selector. */
export function visible(page: Page, selector: string) {
  return page.locator(selector).locator('visible=true').first();
}

export async function openAddModal(
  page: Page,
  type?: 'site' | 'server' | 'secret' | 'checkin' | 'note'
) {
  // The top bar owns exactly one global "新建" action (P1-01).
  await page.getByTestId('global-new').click();
  await expect(page.getByTestId('add-item-modal')).toBeVisible();
  // Page-level buttons (添加服务器 / 新建凭据 …) open the dialog already focused on their type
  // and render no tab bar, so this click is a no-op there; the global entry shows the chooser.
  if (type) {
    await page.locator(`[data-add-type="${type}"]`).click({ timeout: 2000 }).catch(() => undefined);
  }
}

/**
 * Old settings-pane ids → the redesigned pane that now contains them.
 * The redesign collapsed seven panes into 概览 / 使用偏好 / 连接与任务 /
 */
export const SETTINGS_PANE_ALIAS: Record<string, string> = {
  features: 'preferences',
  ai: 'connections',
  content: 'connections',
  sync: 'browser',
  data: 'storage',
  storage: 'storage',
  browser: 'browser',
  privacy: 'privacy',
  maintenance: 'maintenance',
  overview: 'overview',
  preferences: 'preferences',
  connections: 'connections'
};

/**
 * Open the routed settings page.
 *
 * Settings used to be a modal opened from a sidebar button titled 系统设置.
 * It is now `#/settings/<pane>`, which is what makes deep links and the back
 * button work — so specs navigate instead of hunting for a trigger.
 */
export async function openSettings(page: Page, pane = 'overview') {
  await page.goto(`/#/settings/${pane}`);
  await expect(page.getByTestId('settings-page')).toBeVisible();
}

/** Click a settings pane by either its new id or a legacy alias. */
export async function gotoSettingsPane(page: Page, id: string) {
  const pane = SETTINGS_PANE_ALIAS[id] ?? id;
  await openSettings(page, pane);
  await expect(page.locator(`[data-settings-nav="${pane}"]`)).toHaveAttribute('data-active', 'true');
}

/**
 * Expand every collapsed integration card on 连接与任务.
 *
 * Cards are collapsed by default (the pane used to be six full forms at once). Specs that type
 * into a specific field opt in explicitly rather than the shared navigation doing it for them,
 * so "collapsed by default" stays a testable contract.
 */
export async function expandAllIntegrations(page: Page) {
  // Click the *first* collapsed toggle repeatedly: expanding one changes the filtered list, so
  // indexing into a snapshot of it skips cards (and that is exactly how this helper first broke).
  for (let guard = 0; guard < 20; guard += 1) {
    const collapsed = page.locator('[data-integration-toggle][aria-expanded="false"]');
    if ((await collapsed.count()) === 0) return;
    await collapsed.first().click();
  }
}

/** Expand one card by integration id (`oss`, `webdav`, `ai`, …). */
export async function expandIntegration(page: Page, id: string) {
  const toggle = page.locator(`[data-integration-toggle="${id}"]`);
  if ((await toggle.count()) === 0) return;
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
}

export function baseState(overrides: Record<string, unknown> = {}) {
  return {
    theme: 'dark',
    categories: ['全部', '技术开发'],
    sites: [],
    servers: [],
    secrets: [],
    checkIns: [],
    reminders: [],
    notes: [],
    handwritings: [],
    inbox: [],
    projects: [],
    annotations: [],
    obsidianConfig: { enabled: false, bucket: '', endpoint: '', region: '', accessKeyId: '', accessKeySecret: '', prefix: '' },
    wucaiConfig: { enabled: false, token: '' },
    youdaoConfig: { enabled: false, token: '' },
    aiConfig: { provider: 'gemini', apiKey: '', baseUrl: '', model: '' },
    cloudflareSync: { enabled: false, workerUrl: '', syncKey: '', autoSync: false },
    gotabPrefs: { searchEngine: 'google', wallpaperType: 'minimal', showQuickNotes: true, showProjects: true, dockLayout: 'comfortable' },
    ...overrides
  };
}
