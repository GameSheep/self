import { test, expect } from '@playwright/test';
import { seedState, baseState, readState } from './helpers';

/**
 * First-run guide.
 *
 * Day one used to mean eleven modules and a dashboard full of empty cards. The
 * wizard asks one question (which modules do you need) and applies the existing
 * feature switches. It must never interrupt an established profile.
 */

function freshState(overrides: Record<string, unknown> = {}) {
  return baseState({ sites: [], ...overrides });
}

test.describe('首次使用向导', () => {
  test.beforeEach(async ({ page }) => {
    page.on('dialog', (d) => d.accept());
  });

  test('空配置首次打开会出现向导', async ({ page }) => {
    await seedState(page, freshState(), { onboarded: false });
    await page.goto('/');
    await expect(page.getByTestId('onboarding')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('onboarding')).toContainText('欢迎使用 Self-Hub');
  });

  test('已有数据的用户不会被向导打断', async ({ page }) => {
    const busy = baseState({
      sites: Array.from({ length: 20 }, (_, i) => ({
        id: `s${i}`,
        title: `站点${i}`,
        url: `https://example${i}.com`,
        category: '技术开发',
        pinned: false,
        visitCount: 0,
        createdAt: i
      }))
    });
    await seedState(page, busy, { onboarded: false });
    await page.goto('/');
    await page.waitForTimeout(1200);
    await expect(page.getByTestId('onboarding')).toHaveCount(0);
  });

  test('在向导里关掉模块后，侧边栏立即生效', async ({ page }) => {
    await seedState(page, freshState(), { onboarded: false });
    await page.goto('/');
    await expect(page.getByTestId('onboarding')).toBeVisible();

    await page.getByTestId('onboarding-next').click();
    await expect(page.getByTestId('onboarding')).toContainText('你实际会用哪些模块');

    // Turn off two modules that exist in the sidebar.
    await page.locator('[data-onboarding-feature="secrets"]').click();
    await page.locator('[data-onboarding-feature="handwriting"]').click();
    await page.getByTestId('onboarding-next').click();
    await page.getByTestId('onboarding-finish').click();

    await expect(page.getByTestId('onboarding')).toHaveCount(0);
    await expect(page.locator('nav button', { hasText: '加密安全金库' })).toHaveCount(0);
    await expect(page.locator('nav button', { hasText: '交互手绘白板' })).toHaveCount(0);

    const saved: any = await readState(page);
    expect(saved.features.secrets).toBe(false);
    expect(saved.features.handwriting).toBe(false);
    // Untouched modules stay on.
    expect(saved.features.servers).toBe(true);
  });

  test('跳过不会改动任何模块，且不再出现', async ({ page }) => {
    await seedState(page, freshState(), { onboarded: false });
    await page.goto('/');
    await expect(page.getByTestId('onboarding')).toBeVisible();

    await page.getByTestId('onboarding-skip').click();
    await expect(page.getByTestId('onboarding')).toHaveCount(0);
    await expect(page.locator('nav button', { hasText: '加密安全金库' })).toBeVisible();

    await page.reload();
    await page.waitForTimeout(1200);
    await expect(page.getByTestId('onboarding')).toHaveCount(0);
  });

  test('完成后直接跳到存储配置分区', async ({ page }) => {
    await seedState(page, freshState(), { onboarded: false });
    await page.goto('/');
    await expect(page.getByTestId('onboarding')).toBeVisible();

    await page.getByTestId('onboarding-next').click();
    await page.getByTestId('onboarding-next').click();
    await expect(page.getByTestId('onboarding')).toContainText('存储与备份');

    await page.getByTestId('onboarding-configure').click();
    await expect(page.getByText('系统与服务集成设置')).toBeVisible();
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
});

