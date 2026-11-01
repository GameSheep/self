import { test, expect } from '@playwright/test';
import { seedState, baseState, openSettings, gotoSettingsPane } from './helpers';

/**
 * P2-07 capacity guardrails.
 * The app stores the whole library as one localStorage payload, and browsers stop
 */

/** A payload just under the ~5MB limit, so writes still succeed. */
function nearQuotaState() {
  const state = baseState() as Record<string, unknown>;
  const filler = 'x'.repeat(4_100_000);
  return {
    ...state,
    handwritings: [
      {
        id: 'big-1',
        title: '一张很大的手绘',
        dataUrl: `data:image/png;base64,${filler}`,
        createdAt: 1
      }
    ]
  };
}

test.describe('P2-07 容量保护', () => {
  test.beforeEach(async ({ page }) => {
    page.on('dialog', (d) => d.accept());
  });

  test('接近上限时提前警告并给出真实数字，而不是等到写入失败', async ({ page }) => {
    await seedState(page, nearQuotaState());
    await page.goto('/');

    // Any committed change triggers a save; the banner must appear while it succeeds.
    await page.locator('button[aria-label="切换为明亮主题"]').click();
    const banner = page.getByTestId('storage-near-quota-banner');
    await expect(banner).toBeVisible({ timeout: 10_000 });
    await expect(banner).toContainText('本机数据快接近浏览器上限');
    await expect(banner).toContainText('MB');
    // The save itself still succeeded — no failure banner.
    await expect(page.getByTestId('storage-near-quota-banner')).toContainText('建议先导出备份');

    // The banner points at the place where the export lives.
    await banner.getByRole('button', { name: '去导出备份' }).click();
    await expect(page.getByTestId('settings-page')).toBeVisible();
  });

  test('设置页诊断显示本机占用与占比', async ({ page }) => {
    await seedState(page, nearQuotaState());
    await page.goto('/');
    await openSettings(page);
    await gotoSettingsPane(page, 'maintenance');

    const row = page.getByTestId('diagnostics-storage');
    await expect(row).toBeVisible();
    await expect(row).toContainText('本机数据');
    await expect(row).toContainText('MB');
    await expect(row).toContainText('%');
    // Above the 80% line the row is accompanied by the explicit warning.
    await expect(page.getByTestId('diagnostics-storage-warning')).toBeVisible();
  });

  test('正常大小的数据不会打扰用户', async ({ page }) => {
    await seedState(
      page,
      baseState({
        notes: [{ id: 'n1', title: '普通笔记', content: '# 正文', updatedAt: 1 }]
      })
    );
    await page.goto('/');
    await page.locator('button[aria-label="切换为明亮主题"]').click();
    await expect(page.getByTestId('storage-near-quota-banner')).toHaveCount(0);
  });
});
