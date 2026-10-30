import { test, expect } from '@playwright/test';
import { resetApp, seedState, baseState, readState, gotoSettingsPane } from './helpers';

/**
 * 有道云笔记 已整体隐藏（用户要求「隐藏所有有道云笔记相关的」）。
 *
 * 隐藏 = 没有任何入口：来源标签、设置里的连接卡、使用偏好里的开关都没有了。
 * 但**数据不删**：`youdaoConfig` / `youdaoNotes` 仍在负载与导出里，导回去还能看到。
 */
const seeded = baseState({
  youdaoConfig: { enabled: true, token: 'YOUDAO-SECRET', cookie: 'YNOTE_SKEY' },
  youdaoNotes: [{ id: 'y1', title: '有道旧笔记', folder: '旧', content: '正文', createdAt: 1, updatedAt: 1 }]
});

test.describe('有道云笔记：所有入口都隐藏，数据保留', () => {
  test.beforeEach(async ({ page }) => {
    page.on('dialog', (d) => d.accept());
  });

  test('远端笔记没有有道标签，设置里没有有道卡与开关', async ({ page }) => {
    await resetApp(page);
    await seedState(page, seeded);

    await page.goto('/#/library?view=sources');
    await page.reload();
    await expect(page.getByTestId('library-sources')).toBeVisible();
    await expect(page.locator('[data-source-tab="youdao"]')).toHaveCount(0);
    await expect(page.locator('main')).not.toContainText('有道云笔记');

    await gotoSettingsPane(page, 'connections');
    await expect(page.getByTestId('settings-connections')).toBeVisible();
    await expect(page.locator('[data-integration="youdao"]')).toHaveCount(0);

    await gotoSettingsPane(page, 'features');
    await expect(page.locator('[data-feature-toggle="youdao"]')).toHaveCount(0);
  });

  test('被隐藏的同时，原有有道数据仍在负载里', async ({ page }) => {
    await resetApp(page);
    await seedState(page, seeded);
    await page.goto('/#/library?view=sources');
    await page.reload();
    await page.waitForTimeout(400);

    const saved: any = await readState(page);
    expect(saved.youdaoConfig.token).toBe('YOUDAO-SECRET');
    expect(saved.youdaoNotes).toHaveLength(1);
    expect(saved.youdaoNotes[0].title).toBe('有道旧笔记');
  });
});
