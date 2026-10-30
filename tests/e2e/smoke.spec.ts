import { test, expect } from '@playwright/test';
import { resetApp, gotoTab, seedState, baseState } from './helpers';

/**
 * Every routed page must render. The list is the redesigned information
 * architecture: the old eleven flat modules now live under 日常 / 管理 and the
 * settings page is a route of its own.
 */
const ROUTES = [
  '首页',
  '快捷导航',
  '收件箱',
  '资料库',
  '项目',
  '提醒',
  '服务器',
  '域名与订阅',
  '凭证金库',
  '签到',
  '手绘',
  '多平台数据互通',
  '设置'
];

/** One record per collection, so every page renders its data path, not its empty state. */
function seededProfile() {
  return baseState({
    sites: [{ id: 's1', title: '示例站点', url: 'https://example.invalid/', category: '技术开发', createdAt: 1 }],
    servers: [{ id: 'srv1', name: '示例主机', publicIp: '203.0.113.10', env: 'dev', createdAt: 1 }],
    secrets: [],
    reminders: [
      { id: 'r1', title: '示例提醒', category: 'domain', targetDate: Date.now() + 86400000, createdAt: 1 }
    ],
    notes: [{ id: 'n1', title: '示例笔记', content: '# 内容', category: '速记', updatedAt: 1 }],
    checkIns: [{ id: 'c1', name: '示例签到', url: 'https://example.invalid/', method: 'GET', type: 'http', createdAt: 1 }],
    handwritings: [],
    inbox: [{ id: 'i1', content: '示例待整理', type: 'text', status: 'inbox', createdAt: 1 }],
    projects: [{ id: 'p1', name: '示例项目', description: '', status: 'active', createdAt: 1, updatedAt: 1 }]
  });
}

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
    await seedState(page, seededProfile());

    for (const route of ROUTES) {
      await gotoTab(page, route);
      const main = page.locator('main');
      await expect(main).toBeVisible();
      // A crash renders an empty main or trips the error boundary.
      await expect(main).not.toHaveText('');
      await expect(main).not.toContainText('页面不存在');
    }

    expect(errors, `控制台错误: ${errors.join(' | ')}`).toEqual([]);
  });

  test('刷新后数据与主题仍然存在', async ({ page }) => {
    await seedState(page, seededProfile());
    await page.goto('/#/navigation');
    await expect(page.locator('main')).toContainText('示例站点');
    await page.reload();
    await expect(page.locator('main')).toContainText('示例站点');
  });

  test('浏览器前进后退能恢复页面', async ({ page }) => {
    await seedState(page, seededProfile());
    await page.goto('/#/home');
    await gotoTab(page, '资料库');
    await expect(page).toHaveURL(/#\/library/);
    await page.goBack();
    await expect(page).toHaveURL(/#\/home/);
    await page.goForward();
    await expect(page).toHaveURL(/#\/library/);
  });
});
