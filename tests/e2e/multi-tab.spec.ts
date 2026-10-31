import { test, expect } from '@playwright/test';
import { resetApp } from './helpers';

/**
 * Two tabs on the same device.
 *
 * This is the most common way a single user actually loses data: the same payload is open
 * in two tabs, both keep writing, and the last write wins. The app cannot merge (there is no
 * merge for concurrent plain writes), so its contract is: **notice, say so, and tell the user
 * to reload** — a loud warning instead of a silent overwrite.
 *
 * Nothing tested that contract before. It is cheap to test and it protects the one place
 * where the app deliberately chooses "warn" over "resolve".
 *
 * No `seedState` here on purpose: its init script re-applies the fixture on every
 * navigation, so the reload this test performs would silently restore the fixture and the
 * assertion would be about the fixture, not about what the two tabs wrote.
 */
test.describe('多标签页：检测到其它标签页写入', () => {
  test.beforeEach(async ({ page }) => {
    page.on('dialog', (d) => d.accept());
    await resetApp(page);
  });

  test('另一个标签页写入后，本页出现提示，并可重新加载采用新数据', async ({ page, context }) => {
    await page.goto('/');
    await expect(page.getByTestId('home-view')).toBeVisible();

    // Tab 1 writes something, so the payload is non-empty before tab 2 appears.
    await page.getByTestId('home-capture-input').fill('第一页的记录');
    await page.getByTestId('home-capture-submit').click();
    await expect(page.getByTestId('home-capture-feedback')).toContainText('已保存到本机');

    // A second tab on the same origin/device.
    const other = await context.newPage();
    await other.goto('/');
    await expect(other.getByTestId('home-view')).toBeVisible();

    // The other tab writes too.
    await other.getByTestId('home-capture-input').fill('另一个标签页写入的记录');
    await other.getByTestId('home-capture-submit').click();
    await expect(other.getByTestId('home-capture-feedback')).toContainText('已保存到本机');

    // Tab 1 must notice — the storage event is what makes this honest rather than silent.
    const banner = page.getByTestId('external-change-banner');
    await expect(banner).toBeVisible({ timeout: 10_000 });
    await expect(banner).toContainText('另一个标签页修改了同一份数据');
    await expect(page.locator('main')).toContainText('继续在当前页面编辑会用这里的版本覆盖对方');

    // Taking the offered action adopts the newer payload instead of overwriting it.
    await banner.getByRole('button', { name: '重新加载' }).click();
    await expect(page.getByTestId('home-view')).toBeVisible();
    const stored = await page.evaluate(() => localStorage.getItem('self_hub_data_v2') ?? '');
    expect(stored, '重新加载后应采用另一个标签页写入的数据').toContain('另一个标签页写入的记录');

    await other.close();
  });

  test('未收到其它标签页写入时不打扰', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('home-view')).toBeVisible();
    // Give the storage listener a moment; nothing should appear.
    await page.waitForTimeout(500);
    await expect(page.getByTestId('external-change-banner')).toHaveCount(0);
  });

  /**
   * The same contract in v3 mode, where it used to be impossible to notice.
   *
   * In v3 mode the payload holds only device configuration, so two tabs writing business
   * data produce a **byte-identical** payload — `localStorage.setItem` then fires no storage
   * event, and the first tab had no way to know the library changed under it. The warning
   * has to survive the migration to v3, otherwise switching modes quietly removes a safety
   * net.
   */
  test('v3 模式下另一个标签页写入库时，本页同样会提示', async ({ page, context }) => {
    await page.goto('/');
    await expect(page.getByTestId('home-view')).toBeVisible();
    await page.getByTestId('home-capture-input').fill('切换前记录');
    await page.getByTestId('home-capture-submit').click();
    await expect(page.getByTestId('home-capture-feedback')).toContainText('已保存到本机');

    // Switch this device onto the v3 library (needs a snapshot password).
    await page.goto('/#/settings/storage');
    await expect(page.getByTestId('storage-mode')).toBeVisible({ timeout: 20_000 });
    await page.getByTestId('storage-advanced-toggle').click();
    await page.getByTestId('storage-migration-password').fill('multi-tab-password');
    await page.getByTestId('storage-mode-switch-v3').click();
    await expect(page.getByTestId('storage-mode-current')).toHaveText('v3', { timeout: 30_000 });

    // Let this tab write its *device-only* payload first: while it still holds the
    // pre-switch full payload, any later write would differ for the wrong reason and the
    // test would pass without the v3 signal existing at all.
    await expect
      .poll(
        async () =>
          page.evaluate(() => {
            const raw = localStorage.getItem('self_hub_data_v2');
            return raw ? ((JSON.parse(raw).notes as unknown[]) ?? []).length : -1;
          }),
        { timeout: 15_000, message: '切换后负载应只剩设备配置' }
      )
      .toBe(0);

    // With the fix, the switch itself must not raise the banner in the tab that performed it
    // (it wrote the payload itself), so the signal below is about the second tab only.
    await expect(page.getByTestId('external-change-banner')).toHaveCount(0);

    // Second tab, same device, writing into the same library.
    const other = await context.newPage();
    await other.goto('/#/home');
    await expect(other.getByTestId('home-view')).toBeVisible();
    await other.getByTestId('home-capture-input').fill('v3 另一个标签页的记录');
    await other.getByTestId('home-capture-submit').click();
    await expect(other.getByTestId('home-capture-feedback')).toContainText('已保存到本机');

    // The signal is the library activity key, not the payload: in v3 mode both tabs' payloads
    // are byte-identical device configuration, so the payload cannot carry this.
    await expect
      .poll(async () => page.evaluate(() => localStorage.getItem('selfhub_v3_activity')), {
        timeout: 10_000,
        message: '库写入后应留下跨标签页的活动信号'
      })
      .toBeTruthy();

    // The live listener turns it into the banner — a reload would clear the flag by design,
    // because after reloading the tab already has the newest data.
    await expect(page.getByTestId('external-change-banner')).toBeVisible({ timeout: 10_000 });

    await other.close();
  });
});
