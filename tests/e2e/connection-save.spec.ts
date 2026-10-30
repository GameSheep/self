import { test, expect, type Page } from '@playwright/test';
import { seedState, baseState, readState, expandAllIntegrations } from './helpers';

/**
 * Connection drafts (P1-08).
 *
 * The behaviour under test is the whole point of the task: a connection form is
 * a *draft*. Editing it changes nothing until 「保存连接」; 「取消」 restores what is
 * saved; 「测试连接」 probes the draft without persisting it; and a green result
 * dies the moment the address, key or path changes.
 */

const SAVED_URL = 'https://old.example.com/dav/';
const NEXT_URL = 'https://new.example.com/dav/';

function state(overrides: Record<string, unknown> = {}) {
  return baseState({
    webdavConfig: {
      enabled: true,
      url: SAVED_URL,
      username: 'user-id',
      password: 'app-password',
      pathPrefix: 'selfhub_sync'
    },
    backupPolicy: { provider: 'webdav', enabled: true },
    ...overrides
  });
}

/** Deep link to 连接与任务; the URL decides the pane, the click is a fallback. */
async function openConnections(page: Page) {
  await page.goto('/#/settings/connections');
  await expect(page.locator('[data-integration="webdav"]')).toBeVisible();
  const nav = page.locator('[data-settings-nav="connections"]');
  if (await nav.count()) await nav.first().click();
  await expect(page.locator('[data-integration="webdav"]')).toBeVisible();
  // Cards are collapsed by default; these tests type into their fields.
  await expandAllIntegrations(page);
}

/** Deterministic WebDAV host: 207 + DAV header, and a record of every request. */
async function mockWebdav(page: Page, requests: string[]) {
  await page.route('**/*example.com/**', async (route) => {
    const req = route.request();
    requests.push(`${req.method()} ${req.url()}`);
    await route.fulfill({
      status: 207,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Expose-Headers': 'DAV',
        DAV: '1,2'
      },
      body: '<?xml version="1.0"?><D:multistatus xmlns:D="DAV:"></D:multistatus>'
    });
  });
}

test.describe('连接草稿：保存、取消、测试', () => {
  test.beforeEach(async ({ page }) => {
    // Accept native beforeunload/confirm dialogs so navigation is never wedged.
    page.on('dialog', (d) => d.accept());
  });

  test('编辑后不保存就离开，localStorage 里仍是旧值', async ({ page }) => {
    await seedState(page, state());
    await openConnections(page);

    await page.locator('[data-field="webdav.url"]').fill(NEXT_URL);
    await expect(page.locator('[data-connection-stage="webdav"]')).toHaveAttribute('data-stage', 'draft');
    await expect(page.getByTestId('connections-dirty-notice')).toBeVisible();

    // Leaving is intercepted with 继续编辑 / 放弃修改 / 保存后离开.
    await page.getByTestId('settings-leave').click();
    await expect(page.getByTestId('unsaved-changes-dialog')).toBeVisible();
    await expect(page.getByTestId('unsaved-discard')).toBeVisible();
    await page.getByTestId('unsaved-discard').click();

    // The action still happened (we left the settings page)…
    await expect(page.getByTestId('settings-panel')).toHaveCount(0);
    // …and nothing was written.
    const saved: any = await readState(page);
    expect(saved.webdavConfig.url).toBe(SAVED_URL);
  });

  test('取消恢复已保存的值，且不动已保存配置与运行中的任务', async ({ page }) => {
    await seedState(page, state());
    await openConnections(page);

    const urlField = page.locator('[data-field="webdav.url"]');
    await urlField.fill(NEXT_URL);
    await expect(page.locator('[data-save="webdav"]')).toBeEnabled();

    await page.locator('[data-cancel="webdav"]').click();

    await expect(urlField).toHaveValue(SAVED_URL);
    await expect(page.locator('[data-save="webdav"]')).toBeDisabled();
    await expect(page.locator('[data-connection-stage="webdav"]')).toHaveAttribute('data-stage', 'saved-untested');

    const saved: any = await readState(page);
    expect(saved.webdavConfig.url).toBe(SAVED_URL);
    // Cancel must not touch a running task.
    expect(saved.backupPolicy.enabled).toBe(true);
  });

  test('保存连接会把新值写入 localStorage，并且只在写入生效后显示已保存', async ({ page }) => {
    await seedState(page, state());
    await openConnections(page);

    await page.locator('[data-field="webdav.url"]').fill(NEXT_URL);
    await page.locator('[data-save="webdav"]').click();

    await expect
      .poll(async () => (await readState(page)).webdavConfig?.url, { timeout: 10_000 })
      .toBe(NEXT_URL);
    // 已保存 means "the parent state now holds the submitted values".
    await expect(page.locator('[data-integration="webdav"] [role="status"]')).toContainText('已保存');
    await expect(page.locator('[data-connection-stage="webdav"]')).toHaveAttribute('data-stage', 'saved-untested');
    await expect(page.locator('[data-save="webdav"]')).toBeDisabled();
  });

  test('测试连接只检测草稿，不会把草稿写进 localStorage', async ({ page }) => {
    const requests: string[] = [];
    await mockWebdav(page, requests);
    await seedState(page, state());
    await openConnections(page);

    await page.locator('[data-field="webdav.url"]').fill(NEXT_URL);
    await page.locator('[data-test-connection="webdav"]').click();

    await expect(page.locator('[data-test-result="webdav"]')).toContainText('连接成功', { timeout: 20_000 });
    // The probe really went to the *draft* address.
    expect(requests.some((r) => r.includes('new.example.com'))).toBe(true);
    expect(requests.some((r) => r.includes('PROPFIND'))).toBe(true);

    // The draft is still a draft, and the saved value is untouched.
    await expect(page.locator('[data-field="webdav.url"]')).toHaveValue(NEXT_URL);
    const saved: any = await readState(page);
    expect(saved.webdavConfig.url).toBe(SAVED_URL);
    expect(saved.backupPolicy.enabled).toBe(true);
  });

  test('检测成功后改动地址，绿色结果变成「检测结果已过期」', async ({ page }) => {
    const requests: string[] = [];
    await mockWebdav(page, requests);
    await seedState(page, state());
    await openConnections(page);

    await page.locator('[data-test-connection="webdav"]').click();
    await expect(page.locator('[data-connection-stage="webdav"]')).toHaveAttribute('data-stage', 'verified', {
      timeout: 20_000
    });
    await expect(page.locator('[data-connection-fact="webdav.test"]')).toContainText('检测通过');

    // The saved config changed version → the old result must not stay green.
    await page.locator('[data-field="webdav.url"]').fill(NEXT_URL);

    await expect(page.locator('[data-connection-fact="webdav.test"]')).toContainText('检测结果已过期');
    await expect(page.locator('[data-connection-stage="webdav"]')).toHaveAttribute('data-stage', 'draft');
  });

  test('保存后离开会先写入草稿，再执行原本的导航', async ({ page }) => {
    await seedState(page, state());
    await openConnections(page);

    await page.locator('[data-field="webdav.url"]').fill(NEXT_URL);
    await page.getByTestId('settings-leave').click();
    await expect(page.getByTestId('unsaved-changes-dialog')).toBeVisible();
    await page.locator('[role="dialog"] button', { hasText: '保存后离开' }).click();

    await expect
      .poll(async () => (await readState(page)).webdavConfig?.url, { timeout: 10_000 })
      .toBe(NEXT_URL);
  });

  test('四类判断分开显示，不会合并成一个「已配置」', async ({ page }) => {
    await seedState(page, state());
    await openConnections(page);

    const card = page.locator('[data-integration="webdav"]');
    await expect(card.locator('[data-connection-fact="webdav.fields"]')).toContainText('必填字段已填写');
    await expect(card.locator('[data-connection-fact="webdav.test"]')).toContainText('从未检测');
    await expect(card.locator('[data-connection-fact="webdav.purpose"]')).toContainText('用途未启用');
    await expect(card.locator('[data-connection-fact="webdav.task"]')).toContainText('自动备份已开启');
    await expect(card).not.toContainText('已配置');
  });

  test('数据与备份：显示实际目的地，可固定提供方并暂停自动备份', async ({ page }) => {
    await seedState(
      page,
      state({
        obsidianConfig: {
          enabled: true,
          bucket: 'vault-bucket',
          endpoint: 'oss-cn-hangzhou.aliyuncs.com',
          region: '',
          accessKeyId: 'LTAI-real',
          accessKeySecret: 'secret',
          prefix: 'vault/'
        }
      })
    );
    await page.goto('/#/settings/storage');
    await expect(page.getByTestId('settings-storage')).toBeVisible();

    // Both providers configured → the winner must be named, and the user told to pin one.
    await expect(page.getByTestId('backup-both-warning')).toContainText('WebDAV');
    await expect(page.locator('[data-backup-provider-used]')).toContainText('WebDAV');
    await expect(page.getByTestId('backup-destination')).toContainText('old.example.com');

    // Honest scope/running conditions, not a claim of always-on sync.
    await expect(page.getByTestId('backup-scope')).toContainText('最近成功');
    await expect(page.getByTestId('backup-scope')).toContainText('浏览器关闭');

    // Pin OSS explicitly…
    await page.locator('[data-backup-provider="oss"]').click();
    await expect(page.locator('[data-backup-provider="oss"]')).toHaveAttribute('data-active', 'true');
    await expect(page.locator('[data-backup-provider-used]')).toContainText('阿里云 OSS');
    await expect.poll(async () => (await readState(page)).backupPolicy?.provider).toBe('oss');

    // …and pause the automatic task.
    await page.locator('[data-backup-auto-toggle]').click();
    await expect.poll(async () => (await readState(page)).backupPolicy?.enabled).toBe(false);
  });
});

test.describe('设置分区深链', () => {
  test('深链直达 使用偏好 / 数据与备份，浏览器后退回到上一个分区', async ({ page }) => {
    await seedState(page, state());

    await page.goto('/#/settings/preferences');
    await expect(page.getByTestId('settings-preferences')).toBeVisible();
    await expect(page.locator('[data-settings-nav="preferences"]')).toHaveAttribute('data-active', 'true');

    await page.goto('/#/settings/storage');
    await expect(page.getByTestId('settings-storage')).toBeVisible();
    await expect(page.getByTestId('cloud-backup-section')).toBeVisible();
    await expect(page.locator('[data-settings-nav="storage"]')).toHaveAttribute('data-active', 'true');

    await page.goBack();
    await expect(page.getByTestId('settings-preferences')).toBeVisible();
    await expect(page.locator('[data-settings-nav="preferences"]')).toHaveAttribute('data-active', 'true');
  });

  test('旧分区 id 仍然可达（别名不 404）', async ({ page }) => {
    await seedState(page, state());

    await page.goto('/#/settings/data');
    await expect(page.getByTestId('settings-storage')).toBeVisible();

    await page.goto('/#/settings/ai');
    await expect(page.getByTestId('settings-connections')).toBeVisible();
    // Old ids highlight the pane that now contains them.
    await expect(page.locator('[data-settings-nav="connections"]')).toHaveAttribute('data-active', 'true');
  });
});
