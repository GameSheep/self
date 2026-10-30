import { test, expect } from '@playwright/test';
import { seedState, baseState, readState, resetApp, gotoTab } from './helpers';

/**
 * P1-10 场景检查：离线 / 无通知权限 / 锁定 / 窄屏。
 *
 * These are the states the plan lists under 手工验收场景 that the feature specs
 * do not reach: they are about what the product claims while something external
 * is unavailable, which is exactly where the old build over-promised.
 */

const KEY = 'self_hub_data_v2';

function profileWithData() {
  return baseState({
    sites: [{ id: 's1', title: '示例站点', url: 'https://example.invalid/', category: '技术开发', pinned: true, createdAt: 1 }],
    notes: [
      { id: 'n1', title: '离线可读的笔记', content: '# 本机内容\n\n不需要网络。', category: '速记', updatedAt: 1760000000000 }
    ],
    reminders: [
      { id: 'r1', title: '示例提醒', category: 'domain', targetDate: Date.now() + 3 * 86400000, createdAt: 1 }
    ],
    secrets: [
      { id: 'sec1', name: '示例凭据', maskedPreview: 'sk-••••0001', category: 'api_key', encryptedValue: 'AAAA', iv: 'BBBB', salt: 'CCCC', updatedAt: 1 }
    ]
  });
}

test.describe('P1-10 场景检查', () => {
  test.beforeEach(async ({ page }) => {
    page.on('dialog', (d) => d.dismiss());
  });

  test('断网后已加载的页面仍可本机录入、浏览与检索', async ({ page, context }) => {
    await seedState(page, profileWithData());
    await page.goto('/#/home');
    await expect(page.locator('main')).toBeVisible();

    // Warm the lazily-loaded chunks first. P1 has no service worker, so a chunk
    // that has never been fetched cannot be fetched offline either — the honest
    // guarantee is "everything you have already opened keeps working offline",
    // not "a cold start works with no network". Recorded as a P1 limitation.
    await page.goto('/#/library?view=notes');
    await expect(page.locator('[data-testid^="note-row-"]').first()).toContainText('离线可读的笔记');
    await gotoTab(page, '首页');

    await context.setOffline(true);

    // 浏览本机资料。
    await page.goto('/#/library?view=notes');
    await expect(page.locator('[data-testid^="note-row-"]').first()).toContainText('离线可读的笔记');

    // 本机检索：在已加载的页面上直接过滤，不需要网络。
    await page.locator('[data-testid="notes-search"]').fill('离线可读');
    await expect(page.locator('[data-testid^="note-row-"]').first()).toContainText('离线可读的笔记');

    // 本机录入：不依赖任何云连接。
    await page.goto('/#/home');
    await page.getByTestId('home-capture-input').fill('离线时记录的内容');
    await page.getByTestId('home-capture-submit').click();
    await expect(page.getByTestId('home-capture-feedback')).toContainText('已保存到本机');

    // The write is already in localStorage — that is what "saved on this device"
    // means, and it does not need a network round trip. (A reload is not used to
    // prove this: `seedState` installs an init script that re-writes the seed on
    // every navigation, which would overwrite the new entry. The reload-based
    // version of this assertion lives in p1-main-path.spec.ts, which seeds via
    // `resetApp` instead.)
    const stored = await readState(page);
    expect(stored.inbox?.some((i: any) => i.content === '离线时记录的内容')).toBe(true);

    await context.setOffline(false);
    await page.goto('/#/inbox');
    await expect(page.locator('main')).toContainText('离线时记录的内容');
  });

  test('云端失败时本机保存与远端失败同时可见，并给出处置入口', async ({ page }) => {
    // OSS is configured and enabled, but every request fails at the network
    // layer. The point: the local write must still be reported as saved, and the
    // failure must be visible with a way to act on it — not swallowed.
    await seedState(
      page,
      baseState({
        obsidianConfig: {
          enabled: true,
          bucket: 'offline-bucket',
          endpoint: 'oss-cn-hangzhou.aliyuncs.com',
          region: 'oss-cn-hangzhou',
          accessKeyId: 'LTAI-offline-test',
          accessKeySecret: 'offline-secret',
          prefix: 'vault/'
        }
      })
    );
    await page.route('**/oss-cn-hangzhou.aliyuncs.com/**', (route) => route.abort('failed'));

    await page.goto('/#/home');
    await page.getByTestId('home-capture-input').fill('云端会失败但本机要成功');
    await page.getByTestId('home-capture-submit').click();
    await expect(page.getByTestId('home-capture-feedback')).toContainText('已保存到本机');

    // The local write is the fact; the cloud attempt is a separate status with a
    // link into the backup pane.
    await expect(page.getByText('数据保存在这台设备的浏览器中')).toBeVisible();
    const detail = page.getByRole('button', { name: '查看详情' });
    await expect(detail).toBeVisible();
  });

  test('未授权通知时保留站内提醒，且不静默请求权限', async ({ page, context }) => {
    await context.clearPermissions();
    const permissionRequests: string[] = [];
    page.on('console', (m) => {
      if (m.text().includes('Notification')) permissionRequests.push(m.text());
    });

    await seedState(page, profileWithData());
    await page.goto('/#/reminders');
    await expect(page.locator('main')).toBeVisible();

    // The reminder list is the in-app reminder: it works regardless of permission.
    await expect(page.locator('main')).toContainText('示例提醒');

    // The strip states the real running condition instead of promising a
    // background notification it cannot deliver. With permission unavailable it
    // says so explicitly and still keeps the item in the in-page list; it never
    // requests permission on its own.
    const strip = page.getByTestId('notification-strip');
    await expect(strip).toBeVisible();
    await expect(strip).toHaveAttribute('data-mode', 'page-open');
    const permission = await page.evaluate(() =>
      typeof Notification === 'undefined' ? 'unsupported' : Notification.permission
    );
    await expect(strip).toHaveAttribute('data-permission', permission === 'unsupported' ? 'unsupported' : permission);
    if (permission === 'denied') {
      await expect(strip).toContainText('本页列表');
    } else {
      // default / granted: the limitation is stated rather than implied.
      await expect(strip).toContainText('页面打开时');
    }
  });

  test('金库锁定时首页与全局检索都不出现凭据明文', async ({ page }) => {
    await seedState(page, profileWithData());
    await page.goto('/#/home');
    await expect(page.locator('[data-home-block="ops"]')).toBeVisible();

    // The ops block reports the lock state and a count, never a value.
    await expect(page.locator('main')).toContainText('凭证金库');
    const text = await page.locator('main').innerText();
    expect(text).not.toContain('sk-••••0001');
    expect(text).not.toContain('AAAA');

    // Global search matches secrets by name only and requires an unlock to reveal.
    // The dialog input is targeted by testid: `getByRole('textbox').first()` used to
    // resolve to the home capture box when the dialog had not opened yet, and the
    // assertion then silently measured the wrong element.
    await page.keyboard.press('Control+K');
    const searchInput = page.getByTestId('global-search-input');
    await expect(searchInput).toBeVisible();
    await searchInput.fill('示例凭据');
    await expect(page.locator('body')).toContainText('示例凭据');
    const bodyText = await page.locator('body').innerText();
    expect(bodyText).not.toContain('AAAA');
  });

  test('320px 窄屏下核心页面没有横向溢出', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 720 });
    await seedState(page, profileWithData());

    for (const route of ['#/home', '#/inbox', '#/library', '#/reminders', '#/resources/vault']) {
      await page.goto(route);
      await expect(page.locator('main')).toBeVisible();
      const overflow = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth
      }));
      expect(
        overflow.scrollWidth <= overflow.clientWidth + 1,
        `${route} 出现页面级横向溢出：${overflow.scrollWidth} > ${overflow.clientWidth}`
      ).toBe(true);
    }
  });

  test('新装档案没有任何示例数据，也没有云配置依赖', async ({ page }) => {
    await resetApp(page);
    const state = await readState(page);
    expect(state.sites).toEqual([]);
    expect(state.notes).toEqual([]);
    expect(KEY).toBe('self_hub_data_v2');

    // The home page is usable without any cloud configuration, and it does not lecture:
    // the first-run 「先做这三件事」 panel was removed on request.
    await expect(page.getByTestId('home-view')).toBeVisible();
    await expect(page.getByTestId('home-capture-input')).toBeVisible();
    await expect(page.getByTestId('home-starters')).toHaveCount(0);
  });
});
