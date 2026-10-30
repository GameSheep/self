import { test, expect } from '@playwright/test';
import { seedState, baseState, gotoSettingsPane, expandAllIntegrations } from './helpers';

/**
 * 首次运行向导（P1-03）.
 *
 * Two things this file protects: a fresh profile gets a short, skippable guide instead of a
 * pre-filled library, and the guide tells the truth about credentials (they are stripped before
 * any upload).
 */

function freshState() {
  return baseState();
}

test.describe('首次运行向导', () => {
  test.beforeEach(async ({ page }) => {
    page.on('dialog', (d) => d.accept());
  });

  test('向导结束后统一设置里能看到 OSS 与 WebDAV 的连接入口', async ({ page }) => {
    await seedState(page, freshState(), { onboarded: true });
    await page.goto('/');
    await expect(page.locator('main')).toBeVisible();
    await gotoSettingsPane(page, 'connections');
    await expandAllIntegrations(page);
    await expect(page.getByTestId('settings-connections')).toBeVisible();
    await expect(page.locator('[data-integration="oss"]')).toBeVisible();
    await expect(page.locator('[data-integration="webdav"]')).toBeVisible();
  });

  test('向导里说明了凭据不会上云', async ({ page }) => {
    await seedState(page, freshState(), { onboarded: false });
    await page.goto('/');
    await expect(page.getByTestId('onboarding')).toBeVisible();
    await page.getByTestId('onboarding-next').click();
    await page.getByTestId('onboarding-next').click();
    await expect(page.getByTestId('onboarding')).toContainText('云端备份在上传前会自动剥离全部凭据');
  });

  test('跳过向导之后不再出现，而且不会写入任何示例数据', async ({ page }) => {
    await seedState(page, freshState(), { onboarded: false });
    await page.goto('/');
    await expect(page.getByTestId('onboarding')).toBeVisible();
    await page.getByTestId('onboarding-skip').click();
    await expect(page.getByTestId('onboarding')).toHaveCount(0);

    // Skipping is a decision, not a seed: the library stays empty.
    await expect(page.getByTestId('home-view')).toBeVisible();
    const stored = await page.evaluate(() => {
      const raw = localStorage.getItem('self_hub_data_v2');
      if (!raw) return { sites: -1, notes: -1 };
      const state = JSON.parse(raw);
      return { sites: (state.sites ?? []).length, notes: (state.notes ?? []).length };
    });
    expect(stored.sites).toBe(0);
    expect(stored.notes).toBe(0);

    // Reloading does not bring it back.
    await page.reload();
    await expect(page.getByTestId('home-view')).toBeVisible();
    await expect(page.getByTestId('onboarding')).toHaveCount(0);
  });

  test('已经完成向导的档案不会再看一遍', async ({ page }) => {
    await seedState(page, freshState(), { onboarded: true });
    await page.goto('/');
    await expect(page.getByTestId('home-view')).toBeVisible();
    await expect(page.getByTestId('onboarding')).toHaveCount(0);
  });
});

