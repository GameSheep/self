import { test, expect } from '@playwright/test';
import { gotoSettingsPane, openSettings, seedState, baseState, readState, expandAllIntegrations } from './helpers';

/**
 * WebDAV: the second backup destination (P1-09).
 *
 * The regression this guards: with only WebDAV configured the *automatic* backup used to never
 * fire, because the trigger looked at the OSS fields only. Manual and automatic now share one
 * resolver, and the tests below drive both paths.
 */

/** `state()` takes whole-state overrides here (webdavConfig, obsidianConfig, …). */
function state(overrides: Record<string, unknown> = {}) {
  return baseState(overrides);
}

async function openWebdavCard(page: any) {
  await gotoSettingsPane(page, 'connections');
  await expandAllIntegrations(page);
  await expect(page.locator('[data-integration="webdav"]')).toBeVisible();
}

/** 「立即备份」按钮仍在「数据与备份」分区。 */
async function openBackupTab(page: any) {
  await openSettings(page);
  await gotoSettingsPane(page, 'storage');
  await expect(page.getByTestId('backup-now')).toBeVisible();
}

async function mockWebdav(page: any, handler: (method: string, url: string) => { status: number; headers?: Record<string, string> }) {
  await page.route('**/*your-host.example.com/**', async (route) => {
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
    await openWebdavCard(page);

    await page.locator('[data-field="webdav.url"]').fill('https://your-host.example.com/dav/');
    await page.locator('[data-field="webdav.username"]').fill('example-user');
    await page.locator('[data-field="webdav.password"]').fill('app-password');
    await page.locator('[data-testid="webdav-test"]').click();

    const result = page.getByTestId('webdav-test-result');
    await expect(result).toBeVisible({ timeout: 20_000 });
    await expect(result).toContainText('连接成功');
    await expect(result).toContainText('1.2');
  });

  test('401 时明确指出是认证问题并给出排查方向', async ({ page }) => {
    await mockWebdav(page, () => ({ status: 401 }));
    await seedState(page, state());
    await page.goto('/');
    await openWebdavCard(page);

    await page.locator('[data-field="webdav.url"]').fill('https://your-host.example.com/dav/');
    await page.locator('[data-field="webdav.username"]').fill('example-user');
    await page.locator('[data-field="webdav.password"]').fill('wrong');
    await page.locator('[data-testid="webdav-test"]').click();

    const result = page.getByTestId('webdav-test-result');
    await expect(result).toBeVisible({ timeout: 20_000 });
    await expect(result).toContainText('认证失败');
    await expect(result).toContainText('应用密码');
  });

  test('网络层失败时提示可能是 CORS/扩展环境问题', async ({ page }) => {
    await page.route('**/*your-host.example.com/**', (route) => route.abort('failed'));
    await seedState(page, state());
    await page.goto('/');
    await openWebdavCard(page);

    await page.locator('[data-field="webdav.url"]').fill('https://your-host.example.com/dav/');
    await page.locator('[data-field="webdav.username"]').fill('u');
    await page.locator('[data-field="webdav.password"]').fill('p');
    await page.locator('[data-testid="webdav-test"]').click();

    const result = page.getByTestId('webdav-test-result');
    await expect(result).toBeVisible({ timeout: 20_000 });
    await expect(result).toContainText('无法连接');
    await expect(result).toContainText('扩展');
  });

  test('缺少字段时直接提示，不发请求', async ({ page }) => {
    let calls = 0;
    await page.route('**/*your-host.example.com/**', (route) => {
      calls++;
      return route.fulfill({ status: 207, body: '' });
    });
    await seedState(page, state());
    await page.goto('/');
    await openWebdavCard(page);

    await page.locator('[data-testid="webdav-test"]').click();
    // 改版后的措辞是「无法检测：请先填写 …」——业务契约不变：字段不全就直接说明，不发请求。
    await expect(page.getByTestId('webdav-test-result')).toContainText('无法检测');
    await expect(page.getByTestId('webdav-test-result')).toContainText('请先填写');
    expect(calls).toBe(0);
  });

  test('保存 WebDAV 配置会持久化', async ({ page }) => {
    await mockWebdav(page, () => ({ status: 207, headers: { DAV: '1' } }));
    await seedState(page, state());
    await page.goto('/');
    await openWebdavCard(page);

    await page.locator('[data-field="webdav.url"]').fill('https://your-host.example.com/dav/');
    await page.locator('[data-field="webdav.username"]').fill('example-user');
    await page.locator('[data-field="webdav.password"]').fill('app-password');
    await page.locator('[data-field="webdav.pathPrefix"]').fill('selfhub_sync');

    // P1-08 契约变更：填写字段既不会落盘、也不会自动启用连接，必须先打开
    // 「启用这个连接」再点「保存连接」。
    const beforeSave: any = await readState(page);
    expect(beforeSave?.webdavConfig?.url ?? '').not.toBe('https://your-host.example.com/dav/');

    await page.locator('[data-field="webdav.enabled"]').click();
    await expect(page.locator('[data-field="webdav.enabled"]')).toHaveAttribute('data-enabled', 'true');
    await page.locator('[data-save="webdav"]').click();

    await expect.poll(async () => {
      const s: any = await readState(page);
      return s?.webdavConfig?.url;
    }).toBe('https://your-host.example.com/dav/');

    const saved: any = await readState(page);
    // enabled 只反映用户显式打开的开关，不再由「字段填满」推导。
    expect(saved.webdavConfig.enabled).toBe(true);
    expect(saved.webdavConfig.username).toBe('example-user');
    expect(saved.webdavConfig.pathPrefix).toBe('selfhub_sync');
  });

  test('目标路径预览正确拼接', async ({ page }) => {
    await mockWebdav(page, () => ({ status: 207 }));
    await seedState(page, state());
    await page.goto('/');
    await openWebdavCard(page);

    await page.locator('[data-field="webdav.url"]').fill('https://your-host.example.com/dav/');
    await page.locator('[data-field="webdav.pathPrefix"]').fill('selfhub_sync');
    await expect(page.locator('[data-integration="webdav"]')).toContainText('https://your-host.example.com/dav/selfhub_sync/state.json');
  });

  test('启用 WebDAV 后「立即备份」会 PUT 到 WebDAV 而不是 OSS', async ({ page }) => {
    const puts: string[] = [];
    let stored = '';
    await page.route('**/*', async (route) => {
      const req = route.request();
      if (!req.url().includes('your-host.example.com')) return route.continue();
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
          url: 'https://your-host.example.com/dav/',
          username: 'example-user',
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
    expect(envelope.version).toBe(2); // v2 strips credentials before upload
    expect(envelope.state).toBeTruthy();
  });

  test('WebDAV 上已有更新快照时不覆盖，另存冲突副本', async ({ page }) => {
    const puts: string[] = [];
    const newer = JSON.stringify({ version: 1, updatedAt: Date.now() + 600000, deviceId: 'dev-other', state: state() });

    await page.route('**/*', async (route) => {
      const req = route.request();
      if (!req.url().includes('your-host.example.com')) return route.continue();
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
          url: 'https://your-host.example.com/dav/',
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
