import { test, expect } from '@playwright/test';
import { seedState, baseState, readState } from './helpers';

/**
 * WebDAV connection diagnostics.
 *
 * Real WebDAV servers (InfiniCLOUD/TeraCloud) return 401 for both wrong passwords
 * and "app connection disabled", and send no CORS headers at all. The UI must
 * report the concrete reason rather than a generic failure.
 */

function state(overrides: Record<string, unknown> = {}) {
  return baseState(overrides);
}

async function openBackupTab(page: any) {
  await page.locator('aside button[title*="系统设置"]').click();
  await expect(page.getByText('系统与服务集成设置')).toBeVisible();
  await page.locator('[data-settings-nav="storage"]').click();
  await expect(page.getByTestId('webdav-section')).toBeVisible();
}

async function mockWebdav(page: any, handler: (method: string, url: string) => { status: number; headers?: Record<string, string> }) {
  await page.route('**/*teracloud.jp/**', async (route) => {
    const req = route.request();
    const result = handler(req.method(), req.url());
    await route.fulfill({
      status: result.status,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Expose-Headers': 'DAV',
        ...(result.headers || {})
      },
      body: result.status === 207 ? '<?xml version="1.0"?><D:multistatus xmlns:D="DAV:"></D:multistatus>' : ''
    });
  });
}

test.describe('WebDAV 连接测试', () => {
  test.beforeEach(async ({ page }) => {
    page.on('dialog', (d) => d.accept());
  });

  test('207 时报告连接成功并显示 DAV 版本', async ({ page }) => {
    await mockWebdav(page, () => ({ status: 207, headers: { DAV: '1,2' } }));
    await seedState(page, state());
    await page.goto('/');
    await openBackupTab(page);

    await page.getByTestId('webdav-url').fill('https://toi.teracloud.jp/dav/');
    await page.getByTestId('webdav-user').fill('gamesheep8246');
    await page.getByTestId('webdav-pass').fill('app-password');
    await page.getByTestId('webdav-test').click();

    const result = page.getByTestId('webdav-test-result');
    await expect(result).toBeVisible({ timeout: 20_000 });
    await expect(result).toContainText('连接成功');
    await expect(result).toContainText('1.2');
  });

  test('401 时明确指出是认证问题并给出排查方向', async ({ page }) => {
    await mockWebdav(page, () => ({ status: 401 }));
    await seedState(page, state());
    await page.goto('/');
    await openBackupTab(page);

    await page.getByTestId('webdav-url').fill('https://toi.teracloud.jp/dav/');
    await page.getByTestId('webdav-user').fill('gamesheep8246');
    await page.getByTestId('webdav-pass').fill('wrong');
    await page.getByTestId('webdav-test').click();

    const result = page.getByTestId('webdav-test-result');
    await expect(result).toBeVisible({ timeout: 20_000 });
    await expect(result).toContainText('认证失败');
    await expect(result).toContainText('应用密码');
  });

  test('网络层失败时提示可能是 CORS/扩展环境问题', async ({ page }) => {
    await page.route('**/*teracloud.jp/**', (route) => route.abort('failed'));
    await seedState(page, state());
    await page.goto('/');
    await openBackupTab(page);

    await page.getByTestId('webdav-url').fill('https://toi.teracloud.jp/dav/');
    await page.getByTestId('webdav-user').fill('u');
    await page.getByTestId('webdav-pass').fill('p');
    await page.getByTestId('webdav-test').click();

    const result = page.getByTestId('webdav-test-result');
    await expect(result).toBeVisible({ timeout: 20_000 });
    await expect(result).toContainText('无法连接');
    await expect(result).toContainText('扩展');
  });

  test('缺少字段时直接提示，不发请求', async ({ page }) => {
    let calls = 0;
    await page.route('**/*teracloud.jp/**', (route) => {
      calls++;
      return route.fulfill({ status: 207, body: '' });
    });
    await seedState(page, state());
    await page.goto('/');
    await openBackupTab(page);

    await page.getByTestId('webdav-test').click();
    await expect(page.getByTestId('webdav-test-result')).toContainText('请填写');
    expect(calls).toBe(0);
  });

  test('保存 WebDAV 配置会持久化', async ({ page }) => {
    await mockWebdav(page, () => ({ status: 207, headers: { DAV: '1' } }));
    await seedState(page, state());
    await page.goto('/');
    await openBackupTab(page);

    await page.getByTestId('webdav-url').fill('https://toi.teracloud.jp/dav/');
    await page.getByTestId('webdav-user').fill('gamesheep8246');
    await page.getByTestId('webdav-pass').fill('app-password');
    await page.getByTestId('webdav-path').fill('selfhub_sync');
    await page.getByTestId('webdav-save').click();

    await expect.poll(async () => {
      const s: any = await readState(page);
      return s?.webdavConfig?.url;
    }).toBe('https://toi.teracloud.jp/dav/');

    const saved: any = await readState(page);
    expect(saved.webdavConfig.enabled).toBe(true);
    expect(saved.webdavConfig.username).toBe('gamesheep8246');
    expect(saved.webdavConfig.pathPrefix).toBe('selfhub_sync');
  });

  test('目标路径预览正确拼接', async ({ page }) => {
    await mockWebdav(page, () => ({ status: 207 }));
    await seedState(page, state());
    await page.goto('/');
    await openBackupTab(page);

    await page.getByTestId('webdav-url').fill('https://toi.teracloud.jp/dav/');
    await page.getByTestId('webdav-path').fill('selfhub_sync');
    await expect(page.getByTestId('webdav-section')).toContainText('https://toi.teracloud.jp/dav/selfhub_sync/state.json');
  });

  test('启用 WebDAV 后「立即备份」会 PUT 到 WebDAV 而不是 OSS', async ({ page }) => {
    const puts: string[] = [];
    let stored = '';
    await page.route('**/*', async (route) => {
      const req = route.request();
      if (!req.url().includes('infini-cloud.net')) return route.continue();
      if (req.method() === 'PUT') {
        puts.push(decodeURIComponent(req.url()));
        stored = req.postData() || '';
        return route.fulfill({ status: 201, headers: { 'Access-Control-Allow-Origin': '*' }, body: '' });
      }
      if (req.method() === 'GET') {
        return route.fulfill({ status: 404, headers: { 'Access-Control-Allow-Origin': '*' }, body: '' });
      }
      return route.fulfill({
        status: 207,
        headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'DAV', DAV: '1,2' },
        body: '<?xml version="1.0"?><D:multistatus xmlns:D="DAV:"></D:multistatus>'
      });
    });

    await seedState(
      page,
      state({
        webdavConfig: {
          enabled: true,
          url: 'https://kurio.infini-cloud.net/dav/',
          username: 'gamesheep8246',
          password: 'app-pass',
          pathPrefix: 'selfhub_sync'
        }
      })
    );
    await page.goto('/');
    await openBackupTab(page);

    await page.getByTestId('backup-now').click();
    await expect.poll(() => puts.length, { timeout: 20_000 }).toBeGreaterThan(0);

    const target = puts[puts.length - 1];
    expect(target).toContain('/dav/selfhub_sync/state.json');
    const envelope = JSON.parse(stored);
    expect(envelope.version).toBe(1);
    expect(envelope.state).toBeTruthy();
  });

  test('WebDAV 上已有更新快照时不覆盖，另存冲突副本', async ({ page }) => {
    const puts: string[] = [];
    const newer = JSON.stringify({ version: 1, updatedAt: Date.now() + 600000, deviceId: 'dev-other', state: state() });

    await page.route('**/*', async (route) => {
      const req = route.request();
      if (!req.url().includes('infini-cloud.net')) return route.continue();
      if (req.method() === 'GET') {
        return route.fulfill({
          status: 200,
          headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
          body: newer
        });
      }
      if (req.method() === 'PUT') {
        puts.push(decodeURIComponent(req.url()));
        return route.fulfill({ status: 201, headers: { 'Access-Control-Allow-Origin': '*' }, body: '' });
      }
      return route.fulfill({ status: 207, headers: { 'Access-Control-Allow-Origin': '*' }, body: '' });
    });

    await seedState(
      page,
      state({
        webdavConfig: {
          enabled: true,
          url: 'https://kurio.infini-cloud.net/dav/',
          username: 'u',
          password: 'p',
          pathPrefix: 'selfhub_sync'
        }
      })
    );
    await page.goto('/');
    await openBackupTab(page);

    // Establish a base backup time first.
    await page.evaluate(() => localStorage.setItem('selfhub_last_backup_at', String(Date.now() - 3600_000)));
    page.removeAllListeners('dialog');
    page.on('dialog', (d) => (d.type() === 'confirm' ? d.dismiss() : d.accept()));

    await page.getByTestId('backup-now').click();
    await expect.poll(() => puts.length, { timeout: 20_000 }).toBeGreaterThan(0);

    expect(puts[puts.length - 1]).toContain('/conflicts/');
    expect(puts.some((u) => u.endsWith('/selfhub_sync/state.json'))).toBe(false);
  });
});

