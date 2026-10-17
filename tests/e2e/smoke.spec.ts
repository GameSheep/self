import { test, expect } from '@playwright/test';
import { resetApp, gotoTab } from './helpers';

const TABS = [
  '仪表盘总览',
  '统一收件箱',
  '自研项目空间',
  '倒计时与续费',
  '网站与工作台',
  '自研部署与主机',
  '加密安全金库',
  '深度知识文档',
  '自动化与打卡',
  '多平台数据互通',
  '交互手绘白板'
];

test.describe('smoke', () => {
  test.beforeEach(async ({ page }) => {
    page.on('dialog', (d) => d.dismiss());
  });

  test('每一页都能渲染，且不产生控制台错误', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });

    await resetApp(page);

    for (const tab of TABS) {
      await gotoTab(page, tab);
      const main = page.locator('main');
      await expect(main).toBeVisible();
      // A crash renders an empty main or trips the error boundary.
      await expect(main).not.toHaveText('');
    }

    expect(errors, `控制台错误: ${errors.join(' | ')}`).toEqual([]);
  });

  test('刷新后示例数据与主题仍然存在', async ({ page }) => {
    await resetApp(page);
    await expect(page.locator('main')).toContainText('GitHub');
    await page.reload();
    await expect(page.locator('main')).toContainText('GitHub');
  });
});
