import { test, expect } from '@playwright/test';
import { seedState, baseState, readState } from './helpers';

/**
 * Data safety (credentials must never leave the device in a backup) and
 * optional-module switches.
 */

function state(overrides: Record<string, unknown> = {}) {
  return baseState({
    obsidianConfig: {
      enabled: true,
      bucket: 'my-vault',
      endpoint: 'oss-cn-beijing.aliyuncs.com',
      region: 'oss-cn-beijing',
      accessKeyId: 'LTAI-TEST-ID',
      accessKeySecret: 'SUPER-SECRET-OSS-KEY',
      prefix: 'vault/'
    },
    webdavConfig: {
      enabled: true,
      url: 'https://kurio.infini-cloud.net/dav/',
      username: 'someone',
      password: 'WEBDAV-SECRET-PASS',
      pathPrefix: 'selfhub_sync'
    },
    aiConfig: { provider: 'deepseek', apiKey: 'AI-SECRET-KEY', baseUrl: '', model: 'deepseek-chat' },
    wucaiConfig: { enabled: true, token: 'WUCAI-SECRET-TOKEN' },
    youdaoConfig: { enabled: true, token: 'YOUDAO-SECRET', cookie: 'YOUDAO-COOKIE' },
    ...overrides
  });
}

async function openSettings(page: any) {
  await page.locator('aside button[title*="系统设置"]').click();
  await expect(page.getByText('系统与服务集成设置')).toBeVisible();
}

test.describe('备份不泄露凭据', () => {
  test.beforeEach(async ({ page }) => {
    page.on('dialog', (d) => d.accept());
  });

  test('上传的备份里不包含任何密钥/密码/Token', async ({ page }) => {
    const uploaded: string[] = [];
    await page.route('**/*', async (route) => {
      const req = route.request();
      if (!req.url().includes('aliyuncs.com')) return route.continue();
      if (req.method() === 'PUT') {
        uploaded.push(req.postData() || '');
        return route.fulfill({ status: 200, headers: { 'Access-Control-Allow-Origin': '*' }, body: '' });
      }
      if (req.method() === 'HEAD') {
        return route.fulfill({ status: 404, headers: { 'Access-Control-Allow-Origin': '*' }, body: '' });
      }
      return route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'application/xml', 'Access-Control-Allow-Origin': '*' },
        body: '<?xml version="1.0"?><ListBucketResult><Name>my-vault</Name><MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated></ListBucketResult>'
      });
    });

    // Back up via OSS: disable WebDAV so the provider routing picks OSS.
    const ossOnly = state();
    (ossOnly as any).webdavConfig = { ...(ossOnly as any).webdavConfig, enabled: false };
    await seedState(page, ossOnly);
    await page.goto('/');
    await openSettings(page);
    await page.locator('[data-settings-nav="storage"]').click();
    await page.getByTestId('backup-now').click();

    await expect.poll(() => uploaded.length, { timeout: 20_000 }).toBeGreaterThan(0);
    const body = uploaded[uploaded.length - 1];

    for (const secret of [
      'SUPER-SECRET-OSS-KEY',
      'WEBDAV-SECRET-PASS',
      'AI-SECRET-KEY',
      'WUCAI-SECRET-TOKEN',
      'YOUDAO-SECRET',
      'YOUDAO-COOKIE'
    ]) {
      expect(body, `备份不能包含 ${secret}`).not.toContain(secret);
    }

    const envelope = JSON.parse(body);
    expect(envelope.credentialsStripped).toBe(true);
    // Non-secret settings still travel, so a restore keeps working.
    expect(envelope.state.obsidianConfig.bucket).toBe('my-vault');
    expect(envelope.state.obsidianConfig.accessKeyId).toBe('LTAI-TEST-ID');
    expect(envelope.state.webdavConfig.url).toContain('infini-cloud');
  });

  test('从云端恢复时保留本机凭据（备份里没有它们）', async ({ page }) => {
    const remoteState = state();
    // Simulate a stripped backup: secrets empty.
    remoteState.obsidianConfig.accessKeySecret = '';
    remoteState.aiConfig.apiKey = '';
    remoteState.wucaiConfig.token = '';
    const envelope = JSON.stringify({
      version: 2,
      updatedAt: Date.now(),
      deviceId: 'dev-other',
      credentialsStripped: true,
      state: remoteState
    });

    await page.route('**/*', async (route) => {
      const req = route.request();
      if (!req.url().includes('aliyuncs.com')) return route.continue();
      if (req.method() === 'HEAD') {
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
      if (req.method() === 'GET') {
        return route.fulfill({
          status: 200,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
          body: envelope
        });
      }
      return route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'application/xml', 'Access-Control-Allow-Origin': '*' },
        body: '<?xml version="1.0"?><ListBucketResult><Name>my-vault</Name><MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated></ListBucketResult>'
      });
    });

    await seedState(page, state());
    await page.goto('/');
    await openSettings(page);
    await page.locator('[data-settings-nav="storage"]').click();
    await page.getByTestId('restore-from-cloud').click();

    await expect
      .poll(async () => (await readState(page)).obsidianConfig?.accessKeySecret, { timeout: 15_000 })
      .toBe('SUPER-SECRET-OSS-KEY');

    const saved: any = await readState(page);
    expect(saved.aiConfig.apiKey).toBe('AI-SECRET-KEY');
    expect(saved.wucaiConfig.token).toBe('WUCAI-SECRET-TOKEN');
  });
});

test.describe('功能开关', () => {
  test.beforeEach(async ({ page }) => {
    page.on('dialog', (d) => d.accept());
  });

  test('关闭模块后侧边栏不再显示，数据仍在', async ({ page }) => {
    await seedState(page, state({ secrets: [{ id: 'x', name: 'k', maskedPreview: '••' }] }));
    await page.goto('/');
    await expect(page.locator('nav button', { hasText: '加密安全金库' })).toBeVisible();

    await openSettings(page);
    await page.locator('[data-settings-nav="features"]').click();
    await page.locator('[data-feature-toggle="secrets"]').click();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);

    await expect(page.locator('nav button', { hasText: '加密安全金库' })).toHaveCount(0);

    const saved: any = await readState(page);
    expect(saved.features.secrets).toBe(false);
    expect(saved.secrets).toHaveLength(1);
  });

  test('关闭当前所在模块会退回仪表盘', async ({ page }) => {
    await seedState(page, state());
    await page.goto('/');
    await page.locator('nav button', { hasText: '加密安全金库' }).click();
    await expect(page.locator('main')).toContainText('零知识加密安全金库');

    await openSettings(page);
    await page.locator('[data-settings-nav="features"]').click();
    await page.locator('[data-feature-toggle="secrets"]').click();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);

    // Falls back to the dashboard, and the secrets entry is gone from the sidebar.
    await expect(page.locator('nav button', { hasText: '加密安全金库' })).toHaveCount(0);
    await expect(page.locator('main')).toContainText('基础设施与部署监控');
  });

  test('仪表盘也遵守开关：关闭的模块不再显示卡片', async ({ page }) => {
    await seedState(page, state());
    await page.goto('/');
    await expect(page.locator('main')).toContainText('加密金库全览');

    await openSettings(page);
    await page.locator('[data-settings-nav="features"]').click();
    await page.locator('[data-feature-toggle="secrets"]').click();
    await page.locator('[data-feature-toggle="servers"]').click();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);

    await expect(page.locator('main')).not.toContainText('加密金库全览');
    await expect(page.locator('main')).not.toContainText('基础设施与部署监控');
    // Other widgets stay.
    await expect(page.locator('main')).toContainText('日常自动化与签到中心');
  });

  test('核心模块没有开关', async ({ page }) => {
    await seedState(page, state());
    await page.goto('/');
    await openSettings(page);
    await page.locator('[data-settings-nav="features"]').click();

    for (const core of ['dashboard', 'sites', 'reminders', 'obsidian']) {
      await expect(page.locator(`[data-feature-toggle="${core}"]`)).toHaveCount(0);
    }
    await expect(page.locator('[data-feature-toggle="inbox"]')).toHaveCount(1);
  });

  test('重新打开开关后模块恢复', async ({ page }) => {
    await seedState(page, state({ features: { servers: false } }));
    await page.goto('/');
    await expect(page.locator('nav button', { hasText: '自研部署与主机' })).toHaveCount(0);

    await openSettings(page);
    await page.locator('[data-settings-nav="features"]').click();
    await page.locator('[data-feature-toggle="servers"]').click();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);

    await expect(page.locator('nav button', { hasText: '自研部署与主机' })).toBeVisible();
  });
});





