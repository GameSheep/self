import { test, expect, chromium, type BrowserContext, type Page } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { assertPackagedAppFresh } from './packagedApp';

/**
 * The new-tab dashboard layout travels with the backup: the tab owns
 * `selfhub_newtab_layout`/`_pins` in chrome.storage, and restores used to lose it.
 * Asserted both ways — mirrored into exports/v3 batches, and written back on
 * restore without an old package wiping what the device already has. Runs against
 * the packaged workspace (the bridge is `chrome.storage`).
 */

const EXT_PATH = path.join(process.cwd(), 'extension');

/** Layout A: what the device currently has. Three columns, one module. */
const LAYOUT_A = {
  v: 1,
  columns: [
    { id: 'c1', fr: 1 },
    { id: 'c2', fr: 3 },
    { id: 'c3', fr: 1 }
  ],
  modules: [{ id: 'm-notes', type: 'notes', column: 0, height: null, source: { mode: 'recent' } }]
};

/** Layout B: what the backup carries. Two columns, two modules, a pinned height. */
const LAYOUT_B = {
  v: 1,
  columns: [
    { id: 'c1', fr: 2 },
    { id: 'c2', fr: 1 }
  ],
  modules: [
    { id: 'm-notes', type: 'notes', column: 0, height: 320, source: { mode: 'recent' } },
    { id: 'm-sites', type: 'sites', column: 1, height: null, source: { mode: 'all' } }
  ]
};

let context: BrowserContext | null = null;
let extensionId = '';

test.beforeAll(async () => {
  expect(fs.existsSync(path.join(EXT_PATH, 'manifest.json')), '扩展目录必须存在').toBe(true);
  // 这些用例读的是打包进扩展的工作台，不是 src/：产物旧了就会测到旧代码。
  assertPackagedAppFresh(EXT_PATH);
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'selfhub-newtab-backup-'));
  context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1440, height: 900 },
    args: [
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`,
      '--no-first-run',
      '--no-default-browser-check'
    ]
  });
  let worker = context.serviceWorkers()[0];
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 20_000 });
  const match = /^chrome-extension:\/\/([a-p]{32})\//.exec(worker.url());
  expect(match, `无法从 service worker URL 取到扩展 ID: ${worker.url()}`).toBeTruthy();
  extensionId = match![1];
});

test.afterAll(async () => {
  await context?.close();
  context = null;
});

/** Open the packaged workbench. `reset: false` keeps whatever the profile already holds. */
async function openWorkbench(options: { reset?: boolean } = {}): Promise<Page> {
  const page = await context!.newPage();
  page.on('dialog', (dialog) => void dialog.accept());
  await page.goto(`chrome-extension://${extensionId}/app/index.html#/home`);
  if (options.reset !== false) {
    // Start from nothing so the mirrored payload is unambiguous.
    await page.evaluate(
      () => new Promise<void>((resolve) => chrome.storage.local.clear(() => resolve()))
    );
    await page.evaluate(() => localStorage.clear());
    await page.reload();
  }
  await expect(page.getByTestId('home-view')).toBeVisible({ timeout: 20_000 });
  const skip = page.getByRole('button', { name: /跳过|开始使用/ });
  if (await skip.count()) await skip.first().click();
  return page;
}

/**
 * Write a layout the way the new tab would, with no workbench open.
 *
 * This is the case the mirror-on-`storage.onChanged` path cannot see: the user arranged the
 * dashboard while the workbench was closed, so only the boot-time read can pick it up.
 */
async function arrangeLayoutFromNewTab(items: Record<string, unknown>): Promise<void> {
  const page = await context!.newPage();
  await page.goto(`chrome-extension://${extensionId}/newtab.html`);
  await page.evaluate(
    (payload) => new Promise<void>((resolve) => chrome.storage.local.set(payload, () => resolve())),
    items
  );
  await page.close();
}

function seedNewtabStorage(page: Page, items: Record<string, unknown>): Promise<void> {
  return page.evaluate(
    (payload) => new Promise<void>((resolve) => chrome.storage.local.set(payload, () => resolve())),
    items
  );
}

function readStoredLayout(page: Page): Promise<{ columns?: unknown[]; modules?: unknown[] } | null> {
  return page.evaluate(
    () =>
      new Promise<{ columns?: unknown[]; modules?: unknown[] } | null>((resolve) => {
        chrome.storage.local.get(['selfhub_newtab_layout'], (res) => {
          const value = res.selfhub_newtab_layout as { columns?: unknown[]; modules?: unknown[] } | undefined;
          resolve(value ?? null);
        });
      })
  );
}

/** A plaintext backup that passes `validateHubState` (the required collections are arrays). */
function plainBackup(extra: Record<string, unknown>): string {
  return JSON.stringify({
    theme: 'dark',
    categories: ['全部'],
    sites: [],
    servers: [],
    secrets: [],
    reminders: [],
    notes: [],
    checkIns: [],
    handwritings: [],
    ...extra
  });
}

test.describe('新标签页布局跟着备份走', () => {
  test('新标签页改的布局会被工作台收进本机数据', async () => {
    const page = await openWorkbench();

    await seedNewtabStorage(page, {
      selfhub_newtab_layout: LAYOUT_A,
      selfhub_newtab_pins: ['s-1', 's-2']
    });

    // The mirror runs through `storage.onChanged`; wait for the payload to carry it.
    await page.waitForFunction(
      () => {
        const raw = localStorage.getItem('self_hub_data_v2');
        if (!raw) return false;
        const prefs = JSON.parse(raw).newtabPreferences;
        return Boolean(prefs && prefs.layout && Array.isArray(prefs.pins));
      },
      undefined,
      { timeout: 15_000 }
    );

    const prefs = await page.evaluate(
      () => JSON.parse(localStorage.getItem('self_hub_data_v2')!).newtabPreferences
    );
    // 布局原样保留（工作台不解释它的形状），常用网站 id 也在。
    expect(prefs.layout.columns).toHaveLength(3);
    expect(prefs.layout.modules[0].id).toBe('m-notes');
    expect(prefs.pins).toEqual(['s-1', 's-2']);
    await page.close();
  });

  test('重新打开工作台时，新标签页在此期间改的布局也会被补上', async () => {
    const first = await openWorkbench();
    await first.close();

    // 模拟"工作台关着的时候在新标签页拖了卡片"：只有启动时的读取能看到它。
    await arrangeLayoutFromNewTab({ selfhub_newtab_layout: LAYOUT_A, selfhub_newtab_pins: ['s-1'] });

    // 再开一个工作台，不清空任何东西：启动时应该把存储里的布局拉进 payload。
    const reopened = await openWorkbench({ reset: false });
    await reopened.waitForFunction(
      () => {
        const raw = localStorage.getItem('self_hub_data_v2');
        if (!raw) return false;
        return Boolean(JSON.parse(raw).newtabPreferences?.layout);
      },
      undefined,
      { timeout: 15_000 }
    );
    const prefs = await reopened.evaluate(
      () => JSON.parse(localStorage.getItem('self_hub_data_v2')!).newtabPreferences
    );
    expect(prefs.layout.modules[0].id).toBe('m-notes');
    expect(prefs.pins).toEqual(['s-1']);
    await reopened.close();
  });

  test('导入备份会把布局写回新标签页；老备份不会清掉现有布局', async () => {
    const page = await openWorkbench();

    // 本机当前是布局 A。
    await seedNewtabStorage(page, { selfhub_newtab_layout: LAYOUT_A, selfhub_newtab_pins: ['s-1'] });
    await expect.poll(async () => (await readStoredLayout(page))?.columns?.length).toBe(3);

    // 打开「数据与备份」，导入一个带布局 B 的备份。
    await page.goto(`chrome-extension://${extensionId}/app/index.html#/settings/storage`);
    await expect(page.getByTestId('settings-page')).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('import-backup-file').setInputFiles({
      name: 'self-hub-backup.json',
      mimeType: 'application/json',
      buffer: Buffer.from(
        plainBackup({ newtabPreferences: { layout: LAYOUT_B, pins: ['s-9'] } })
      )
    });

    // 恢复是唯一一处工作台写这两个 key 的地方：布局和 ☆ 都要换过来。
    await expect
      .poll(async () => (await readStoredLayout(page))?.columns?.length, { timeout: 15_000 })
      .toBe(2);
    const restored = await page.evaluate(
      () =>
        new Promise<{ modules?: Array<{ id: string; height: number | null }>; pins?: string[] }>((resolve) => {
          chrome.storage.local.get(['selfhub_newtab_layout', 'selfhub_newtab_pins'], (res) => {
            const layout = res.selfhub_newtab_layout as { modules?: Array<{ id: string; height: number | null }> };
            resolve({ modules: layout?.modules, pins: res.selfhub_newtab_pins as string[] });
          });
        })
    );
    expect(restored.modules?.map((m) => m.id)).toEqual(['m-notes', 'm-sites']);
    expect(restored.modules?.[0].height).toBe(320);
    expect(restored.pins).toEqual(['s-9']);

    // 再导入一个**没有** newtabPreferences 的老备份：布局必须原样留着。
    await page.goto(`chrome-extension://${extensionId}/app/index.html#/settings/storage`);
    await expect(page.getByTestId('settings-page')).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('import-backup-file').setInputFiles({
      name: 'old-backup.json',
      mimeType: 'application/json',
      buffer: Buffer.from(plainBackup({ notes: [] }))
    });
    // 给恢复留出执行时间，再确认布局没被动过。
    await page.waitForTimeout(1200);
    const afterOld = await readStoredLayout(page);
    expect(afterOld?.columns).toHaveLength(2);
    expect(afterOld?.modules).toHaveLength(2);

    await page.close();
  });
});
