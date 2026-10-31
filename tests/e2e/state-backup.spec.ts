import { test, expect } from '@playwright/test';
import { seedState, baseState, readState, openSettings, gotoSettingsPane } from './helpers';

/**
 * Whole-state cloud backup.
 *
 * Sites / reminders / projects / inbox / annotations only ever lived in
 * localStorage, so switching machines or clearing site data lost them.
 */

const ENDPOINT = 'oss-cn-beijing.aliyuncs.com';
const BUCKET = 'example-obsidian-vault';
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
      accessKeyId: 'LTAI5tEXAMPLE000000000',
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
  await openSettings(page);
  await gotoSettingsPane(page, 'storage');
  await page.waitForTimeout(300);
}

/**
 * 触发一次真实的状态变更（改主题）。
 *
 * 改版后主题开关从侧边栏底部搬到了顶栏：按钮的 aria-label 会随当前主题变化，
 * 深色下是「切换为明亮主题」。旧的 `aside button[title*="切换为白天"]` 已经不存在。
 */
async function toggleTheme(page: any) {
  await page.locator('button[aria-label="切换为明亮主题"]').click();
}

/** WebDAV 备份的 PUT 记录，用于断言「只配置 WebDAV 也会自动跑」。 */
interface WebdavPut {
  url: string;
  body: string;
}

async function mockWebdavBackup(page: any, puts: WebdavPut[]) {
  await page.route('**/*', async (route) => {
    const req = route.request();
    if (!req.url().includes('your-host.example.com')) return route.continue();
    if (req.method() === 'PUT') {
      puts.push({ url: decodeURIComponent(req.url()), body: req.postData() || '' });
      return route.fulfill({ status: 201, headers: { 'Access-Control-Allow-Origin': '*' }, body: '' });
    }
    if (req.method() === 'GET') {
      return route.fulfill({ status: 404, headers: { 'Access-Control-Allow-Origin': '*' }, body: '' });
    }
    // MKCOL / PROPFIND：目录创建与探测，成功即可。
    return route.fulfill({
      status: 207,
      headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'DAV', DAV: '1,2' },
      body: '<?xml version="1.0"?><D:multistatus xmlns:D="DAV:"></D:multistatus>'
    });
  });
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

    // Trigger a real state change: flip the theme (top bar since the redesign).
    await toggleTheme(page);

    await expect
      .poll(() => captured.filter((c) => c.method === 'PUT').length, { timeout: 20_000 })
      .toBeGreaterThan(0);

    const put = captured.find((c) => c.key.endsWith(STATE_KEY))!;
    expect(put, `应写入 ${STATE_KEY}`).toBeTruthy();
    const envelope = JSON.parse(put.body);
    expect(envelope.version).toBe(2); // v2 strips credentials before upload
    expect(envelope.deviceId).toMatch(/^dev-/);
    expect(envelope.state.theme).toBe('light');

    // 状态要暴露给界面：自动跑完后「数据与备份」显示的是刚写入的时间，而不是静默成功。
    await openBackupTab(page);
    await expect(page.getByTestId('backup-status')).toContainText('刚刚备份');
  });

  test('只配置 WebDAV 时状态变化也会自动备份（P1-09 / UX-06）', async ({ page }) => {
    const puts: WebdavPut[] = [];
    await mockWebdavBackup(page, puts);

    // OSS 完全留空、只启用 WebDAV。旧实现的自动触发只检查 OSS 字段
    //（`if (!cfg.enabled || !cfg.bucket || !cfg.accessKeyId) return`），
    // 所以这种配置下手动备份可用、自动备份永远不跑——这正是 P1-09 要修掉的缺陷。
    const webdavOnly = state();
    webdavOnly.obsidianConfig = {
      enabled: false,
      bucket: '',
      endpoint: '',
      region: '',
      accessKeyId: '',
      accessKeySecret: '',
      prefix: ''
    };
    (webdavOnly as any).webdavConfig = {
      enabled: true,
      url: 'https://your-host.example.com/dav/',
      username: 'u',
      password: 'p',
      pathPrefix: 'selfhub_sync'
    };
    await seedState(page, webdavOnly);
    await page.goto('/');

    await toggleTheme(page);

    await expect.poll(() => puts.length, { timeout: 20_000 }).toBeGreaterThan(0);

    const put = puts[puts.length - 1];
    expect(put.url).toContain('/dav/selfhub_sync/state.json');
    const envelope = JSON.parse(put.body);
    expect(envelope.version).toBe(2);
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
    // 恢复确认现在是应用内弹窗（原生 confirm 已全部退役），点「恢复」。
    await page.getByRole('dialog').getByRole('button', { name: '恢复', exact: true }).click();
    await expect.poll(async () => (await readState(page)).sites[0]?.title, { timeout: 15_000 }).toBe('来自云端的站点');
  });

  test('未配置 OSS 时不会尝试备份', async ({ page }) => {
    const captured: Captured[] = [];
    await mockOss(page, captured);
    const noOss = state();
    noOss.obsidianConfig = { ...noOss.obsidianConfig, enabled: false };
    await seedState(page, noOss);
    await page.goto('/');
    await openBackupTab(page);

    await toggleTheme(page);
    await page.waitForTimeout(7000);

    expect(captured.filter((c) => c.key.includes('.selfhub'))).toHaveLength(0);

    // 契约：没有可用目的地时不能静默什么都不做——解析器必须给出原因，
    // 并说明自动备份并没有在运行。
    await expect(page.locator('[data-backup-reason]')).toContainText('还没有可用的备份目的地');
    await expect(page.locator('[data-backup-auto-state]')).toContainText('未开启');
  });
});




