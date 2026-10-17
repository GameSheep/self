import { test, expect } from '@playwright/test';
import { seedState, baseState, readState } from './helpers';

/**
 * Whole-state cloud backup.
 *
 * Sites / reminders / projects / inbox / annotations only ever lived in
 * localStorage, so switching machines or clearing site data lost them.
 */

const ENDPOINT = 'oss-cn-beijing.aliyuncs.com';
const BUCKET = 'uiuecho-obsidian';
const STATE_KEY = '.selfhub/state.json';

interface Captured {
  method: string;
  key: string;
  body: string;
  headers: Record<string, string>;
}

/** Mutable remote state so a single test can simulate another device writing. */
const remote = {
  mtime: 0,
  exists: false
};

async function mockOss(page: any, captured: Captured[]) {
  remote.mtime = 0;
  remote.exists = false;

  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = request.url();
    if (!url.includes(ENDPOINT)) {
      await route.continue();
      return;
    }
    const decoded = decodeURIComponent(url);
    const path = decoded.split(`${BUCKET}.${ENDPOINT}/`)[1] || '';

    if (request.method() === 'HEAD') {
      if (remote.exists) {
        await route.fulfill({
          status: 200,
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Expose-Headers': 'Last-Modified,ETag',
            'Last-Modified': new Date(remote.mtime).toUTCString(),
            ETag: '"x"'
          },
          body: ''
        });
      } else {
        await route.fulfill({ status: 404, headers: { 'Access-Control-Allow-Origin': '*' }, body: '' });
      }
      return;
    }

    if (request.method() === 'PUT') {
      captured.push({ method: 'PUT', key: path, body: request.postData() || '', headers: request.headers() });
      remote.exists = true;
      remote.mtime = Date.now();
      await route.fulfill({
        status: 200,
        headers: { 'Access-Control-Allow-Origin': '*', ETag: '"new"' },
        body: ''
      });
      return;
    }

    await route.fulfill({
      status: 200,
      headers: { 'Content-Type': 'application/xml', 'Access-Control-Allow-Origin': '*' },
      body: `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>${BUCKET}</Name><MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated></ListBucketResult>`
    });
  });
}

function state() {
  return baseState({
    obsidianConfig: {
      enabled: true,
      bucket: BUCKET,
      endpoint: ENDPOINT,
      region: 'oss-cn-beijing',
      accessKeyId: 'LTAI5t8JAm7fyYaDsK5ECJer',
      accessKeySecret: 'test-secret',
      prefix: 'vault/'
    },
    sites: [
      {
        id: 's1',
        title: '示例站点',
        url: 'https://example.com',
        category: '技术开发',
        description: '用于触发一次状态变更',
        tags: [],
        pinned: false,
        visitCount: 0,
        createdAt: Date.now()
      }
    ]
  });
}

async function openBackupTab(page: any) {
  await page.locator('aside button[title*="系统设置"]').click();
  await expect(page.getByText('系统与服务集成设置')).toBeVisible();
  await page.locator('[data-settings-nav="storage"]').click();
  await page.waitForTimeout(300);
}

test.describe('全量数据云备份', () => {
  test.beforeEach(async ({ page }) => {
    page.on('dialog', (d) => d.accept());
  });

  test('状态变化后自动备份到 .selfhub/state.json', async ({ page }) => {
    const captured: Captured[] = [];
    await mockOss(page, captured);
    await seedState(page, state());
    await page.goto('/');

    // Trigger a real state change: flip the theme.
    await page.locator('aside button[title*="切换为白天"]').click();

    await expect
      .poll(() => captured.filter((c) => c.method === 'PUT').length, { timeout: 20_000 })
      .toBeGreaterThan(0);

    const put = captured.find((c) => c.key.endsWith(STATE_KEY))!;
    expect(put, `应写入 ${STATE_KEY}`).toBeTruthy();
    const envelope = JSON.parse(put.body);
    expect(envelope.version).toBe(1);
    expect(envelope.deviceId).toMatch(/^dev-/);
    expect(envelope.state.theme).toBe('light');
  });

  test('手动备份按钮会立即上传', async ({ page }) => {
    const captured: Captured[] = [];
    await mockOss(page, captured);
    await seedState(page, state());
    await page.goto('/');
    await openBackupTab(page);

    await page.getByTestId('backup-now').click();
    await expect.poll(() => captured.length, { timeout: 15_000 }).toBeGreaterThan(0);
    expect(captured[0].key).toContain(STATE_KEY);
  });

  test('云端更新时不覆盖，而是另存冲突副本', async ({ page }) => {
    // Dismiss the "overwrite anyway?" confirm so we can observe the conflict path.
    page.removeAllListeners('dialog');
    page.on('dialog', (d) => (d.type() === 'confirm' ? d.dismiss() : d.accept()));

    const captured: Captured[] = [];
    await mockOss(page, captured);
    await seedState(page, state());
    await page.goto('/');
    await openBackupTab(page);

    // First backup establishes our base mtime.
    await page.getByTestId('backup-now').click();
    await expect.poll(() => captured.length, { timeout: 15_000 }).toBe(1);
    // The base mtime is written after the follow-up HEAD; wait for it, otherwise
    // the next backup has nothing to compare against.
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem('selfhub_backup_base_mtime')), { timeout: 15_000 })
      .not.toBeNull();

    // Another device writes 10 minutes later.
    remote.mtime = Date.now() + 10 * 60_000;
    remote.exists = true;

    await page.getByTestId('backup-now').click();
    await expect
      .poll(() => captured.filter((c) => c.key.includes('.selfhub/conflicts/')).length, { timeout: 15_000 })
      .toBe(1);

    // The main snapshot was NOT overwritten.
    const toMain = captured.filter((c) => c.key.endsWith(STATE_KEY));
    expect(toMain).toHaveLength(1);
    await expect(page.getByTestId('backup-status')).toContainText('未覆盖');
  });

  test('可以从云端备份恢复', async ({ page }) => {
    const captured: Captured[] = [];
    await mockOss(page, captured);

    // Serve a stored backup whose site list differs from the local one.
    const remoteState = state();
    remoteState.sites[0].title = '来自云端的站点';
    const envelope = JSON.stringify({ version: 1, updatedAt: Date.now(), deviceId: 'dev-other', state: remoteState });

    await page.route('**/*', async (route) => {
      const request = route.request();
      if (!request.url().includes(ENDPOINT)) return route.continue();
      if (request.method() === 'GET' && decodeURIComponent(request.url()).includes('state.json')) {
        return route.fulfill({
          status: 200,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
          body: envelope
        });
      }
      if (request.method() === 'HEAD') {
        return route.fulfill({
          status: 200,
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Expose-Headers': 'Last-Modified',
            'Last-Modified': new Date().toUTCString()
          },
          body: ''
        });
      }
      return route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'application/xml', 'Access-Control-Allow-Origin': '*' },
        body: `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>${BUCKET}</Name><MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated></ListBucketResult>`
      });
    });

    await seedState(page, state());
    await page.goto('/');
    await openBackupTab(page);

    await page.getByTestId('restore-from-cloud').click();
    await expect.poll(async () => (await readState(page)).sites[0]?.title, { timeout: 15_000 }).toBe('来自云端的站点');
  });

  test('未配置 OSS 时不会尝试备份', async ({ page }) => {
    const captured: Captured[] = [];
    await mockOss(page, captured);
    const noOss = state();
    noOss.obsidianConfig = { ...noOss.obsidianConfig, enabled: false };
    await seedState(page, noOss);
    await page.goto('/');

    await page.locator('aside button[title*="切换为白天"]').click();
    await page.waitForTimeout(7000);

    expect(captured.filter((c) => c.key.includes('.selfhub'))).toHaveLength(0);
  });
});



