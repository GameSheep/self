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

export async function gotoTab(page: Page, label: string) {
  await page.locator('nav button', { hasText: label }).first().click();
  await page.waitForTimeout(250);
}

/** First visible element matching a selector. */
export function visible(page: Page, selector: string) {
  return page.locator(selector).locator('visible=true').first();
}

export async function openAddModal(page: Page) {
  await page.locator('button', { hasText: '新建资产' }).first().click();
  await expect(page.getByText('录入新资产')).toBeVisible();
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
