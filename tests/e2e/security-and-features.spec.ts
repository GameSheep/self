import { test, expect } from '@playwright/test';
import { seedState, baseState, readState, openSettings, gotoSettingsPane, gotoTab } from './helpers';

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
      url: 'https://your-host.example.com/dav/',
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
    await gotoSettingsPane(page, 'storage');
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
    expect(envelope.state.webdavConfig.url).toContain('your-host.example.com');
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
    await gotoSettingsPane(page, 'storage');
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
    // Second-level entries are visible without first entering their parent group.
    await expect(page.locator('aside [data-nav-child="vault"]')).toBeVisible();

    await gotoSettingsPane(page, 'features');
    await page.locator('[data-feature-toggle="secrets"]').click();
    await page.waitForTimeout(300);

    await expect(page.locator('aside [data-nav-child="vault"]')).toHaveCount(0);

    const saved: any = await readState(page);
    expect(saved.features.secrets).toBe(false);
    // Hiding a navigation entry never deletes the data behind it.
    expect(saved.secrets).toHaveLength(1);
  });

  test('关闭开关不会把正在浏览的模块踢走，只隐藏入口', async ({ page }) => {
    // The redesign separates "hidden in navigation" from "capability off": the
    // old build bounced the user to the dashboard the moment a switch was
    // turned off, which is exactly the confusion the switch was supposed to
    // remove. The page stays; only the entry disappears.
    await seedState(page, state());
    await page.goto('/');
    await gotoTab(page, '凭证金库');
    await expect(page.locator('main')).toContainText('凭证金库');

    await gotoSettingsPane(page, 'features');
    await page.locator('[data-feature-toggle="secrets"]').click();
    await page.waitForTimeout(300);

    await page.goto('/#/resources/vault');
    await expect(page.locator('main')).toContainText('凭证金库');
    await expect(page.locator('aside [data-nav-child="vault"]')).toHaveCount(0);

    const saved: any = await readState(page);
    expect(saved.features.secrets).toBe(false);
  });

  test('隐藏导航不会暂停后台任务，也不会隐藏首页数据', async ({ page }) => {
    await seedState(
      page,
      state({
        servers: [{ id: 'srv-1', name: '示例主机', publicIp: '203.0.113.10', env: 'dev', createdAt: 1 }],
        secrets: [{ id: 'sec-1', name: '示例凭据', maskedPreview: '••', category: 'api_key', updatedAt: 1 }]
      })
    );
    await page.goto('/');
    // 资源摘要 shows server / vault status while the modules are visible.
    await expect(page.locator('[data-home-block="ops"]')).toBeVisible();

    await gotoSettingsPane(page, 'features');
    await page.locator('[data-feature-toggle="secrets"]').click();
    await page.locator('[data-feature-toggle="servers"]').click();
    await page.waitForTimeout(300);

    await page.goto('/#/home');
    // Hiding the entries must not silently empty the home summary: the switch is
    // a navigation preference, and the redesign keeps data and task state
    // independent of it.
    await expect(page.locator('[data-home-block="ops"]')).toBeVisible();
    const saved: any = await readState(page);
    expect(saved.servers).toHaveLength(1);
    expect(saved.secrets).toHaveLength(1);
  });

  test('核心模块没有开关', async ({ page }) => {
    await seedState(page, state());
    await page.goto('/');
    await gotoSettingsPane(page, 'features');

    // 首页 / 快捷导航 / 提醒 are the product; everything else is optional and therefore has one.
    for (const core of ['dashboard', 'sites', 'reminders']) {
      await expect(page.locator(`[data-feature-toggle="${core}"]`)).toHaveCount(0);
    }
    for (const optional of ['inbox', 'obsidian', 'annotations', 'assets', 'wucai']) {
      await expect(page.locator(`[data-feature-toggle="${optional}"]`)).toHaveCount(1);
    }
  });

  test('每个开关都真的控制一个入口，而不是摆设', async ({ page }) => {
    // Before this, `wucai` / `youdao` existed in settings but nothing read them: the page they
    // belong to ignored the flags. A switch that does nothing is worse than no switch.
    await seedState(page, state());
    await page.goto('/');
    await expect(page.locator('aside [data-nav-child="library-annotations"]')).toBeVisible();
    await expect(page.locator('aside [data-nav-child="library-sources"]')).toBeVisible();
    await expect(page.locator('aside [data-nav-child="assets"]')).toBeVisible();

    await gotoSettingsPane(page, 'features');
    for (const id of ['annotations', 'obsidian', 'wucai', 'assets']) {
      await page.locator(`[data-feature-toggle="${id}"]`).click();
      await page.waitForTimeout(120);
    }

    // Entries that no longer have an enabled capability disappear.
    await expect(page.locator('aside [data-nav-child="library-annotations"]')).toHaveCount(0);
    await expect(page.locator('aside [data-nav-child="assets"]')).toHaveCount(0);
    // 远端笔记 still exists (other sources could be on) but its source tabs are gone; with all
    // three off it says so instead of rendering an empty shell.
    await page.goto('/#/library?view=sources');
    await expect(page.locator('[data-source-tab="obsidian"]')).toHaveCount(0);
    await expect(page.locator('[data-source-tab="wucai"]')).toHaveCount(0);
    await expect(page.locator('[data-source-tab="youdao"]')).toHaveCount(0);
    await expect(page.locator('[data-sources-off]')).toBeVisible();

    // Nothing was deleted by switching things off.
    const saved: any = await readState(page);
    expect(saved.features.obsidian).toBe(false);
    expect(saved.annotations).toEqual([]);
  });

  test('关掉某一来源只隐藏它自己的标签', async ({ page }) => {
    await seedState(page, state({ features: { wucai: false } }));
    await page.goto('/#/library?view=sources');
    await expect(page.locator('[data-source-tab="obsidian"]')).toBeVisible();
    await expect(page.locator('[data-source-tab="wucai"]')).toHaveCount(0);
    // 有道云笔记 is hidden entirely now — its tab never appears, whatever the flags say.
    await expect(page.locator('[data-source-tab="youdao"]')).toHaveCount(0);
    // The page itself stays reachable through the sources that are still on.
    await expect(page.locator('aside [data-nav-child="library-sources"]')).toBeVisible();
  });

  test('开关也过滤列表，并说明隐藏了多少条', async ({ page }) => {
    // The user asked for filtering: a switch that only hides a menu entry while the rows stay
    // in the list reads as broken. 全部资料 is gone, so the annotations pane is the list here.
    await seedState(
      page,
      state({
        notes: [{ id: 'n1', title: '看得见的笔记', content: '正文', category: '速记', updatedAt: 2 }],
        annotations: [
          {
            id: 'a1',
            pageTitle: '被开关藏起来的批注',
            pageUrl: 'https://example.invalid/a',
            text: '原文',
            note: '我的批注',
            createdAt: 1,
            updatedAt: 1
          }
        ]
      })
    );
    await page.goto('/#/library?type=webpage');
    // 行式布局里 pageTitle 在链接的 title 属性上，行内显示的是原文与域名。
    await expect(page.locator('main')).toContainText('example.invalid');

    await gotoSettingsPane(page, 'features');
    await page.locator('[data-feature-toggle="annotations"]').click();
    await page.waitForTimeout(200);

    await page.goto('/#/library?type=webpage');
    await expect(page.locator('main')).not.toContainText('example.invalid');
    // The pane says the module is off and how many rows are kept, instead of showing a module
    // the user turned off.
    await expect(page.getByTestId('module-switched-off')).toContainText('网页批注已关闭');
    await expect(page.getByTestId('module-switched-off')).toContainText('1 条');

    // And the data is still there — a switch hides, it does not delete.
    const saved: any = await readState(page);
    expect(saved.annotations).toHaveLength(1);
    expect(saved.notes).toHaveLength(1);
  });

  test('首页摘要不受开关影响（仍在首页显示）', async ({ page }) => {
    await seedState(
      page,
      state({
        servers: [{ id: 'srv-1', name: '示例主机', publicIp: '203.0.113.10', env: 'dev', createdAt: 1 }],
        features: { servers: false }
      })
    );
    await page.goto('/#/home');
    // Confirmed with the user: the summary keeps showing even when the module's entry is off.
    await expect(page.locator('[data-home-block="ops"]')).toBeVisible();
  });

  test('重新打开开关后模块恢复', async ({ page }) => {
    await seedState(page, state({ features: { servers: false } }));
    await page.goto('/');
    await expect(page.locator('aside [data-nav-child="servers"]')).toHaveCount(0);

    await gotoSettingsPane(page, 'features');
    await page.locator('[data-feature-toggle="servers"]').click();
    await page.waitForTimeout(300);

    await expect(page.locator('aside [data-nav-child="servers"]')).toBeVisible();
  });
});





