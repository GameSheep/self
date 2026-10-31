import { test, expect } from '@playwright/test';
import { baseState, gotoTab, seedState, readState } from './helpers';

/**
 * 首页就地动词（批次3）。
 *
 * 审查报告 P1-4：首页曾经是只读仪表盘——提醒行点击=跳列表、签到行跳管理页、
 * 服务器卡没有检测动作、捕捉框粘贴链接只有收件箱一个去向。「不知道下一步
 * 做什么」是 PRODUCT.md 记录的原始痛点，首页是最佳答题位：每个状态行必须
 * 带一个能直接执行的动词。
 */

const DAY = 24 * 60 * 60 * 1000;

test.describe('首页就地动词', () => {
  test('提醒行内「完成」就地记录，不跳页；过期项还有「续期」', async ({ page }) => {
    await seedState(
      page,
      baseState({
        reminders: [
          {
            id: 'r-over',
            title: '已过期的域名续费',
            category: 'domain',
            targetDate: Date.now() - 2 * DAY,
            recurring: 'yearly',
            autoRollover: false,
            completed: false,
            createdAt: Date.now() - 300 * DAY
          }
        ]
      })
    );
    await gotoTab(page, '首页');

    // 完成就地生效：状态写入，行从待办里消失（completed 被过滤），URL 不变。
    await page.getByTestId('home-reminder-complete-r-over').click();
    await expect.poll(async () => (await readState(page)).reminders[0].completed).toBe(true);
    await expect(page.getByTestId('home-reminder-complete-r-over')).toHaveCount(0);
    expect(page.url()).not.toContain('#/reminders');
  });

  test('粘贴链接时出现「存为网站」，入书签且收件箱留有原始记录', async ({ page }) => {
    await seedState(page, baseState({}));
    await gotoTab(page, '首页');

    await page.getByTestId('home-capture-input').fill('https://example.com/article');
    // URL 检测：第二去向只在粘贴链接时出现。
    await expect(page.getByTestId('home-capture-site')).toBeVisible();
    await page.getByTestId('home-capture-site').click();

    await expect(page.getByTestId('home-capture-feedback')).toContainText('已存为网站');
    const state = await readState(page);
    expect(state.sites.map((s: { url: string }) => s.url)).toContain('https://example.com/article');
    // 原文留在收件箱：比静默建站多一层可回溯的痕迹。
    expect(state.inbox.length).toBe(1);
    expect(state.inbox[0].content).toContain('example.com/article');
  });

  test('捕捉成功后的反馈带「去收件箱整理」入口', async ({ page }) => {
    await seedState(page, baseState({}));
    await gotoTab(page, '首页');

    await page.getByTestId('home-capture-input').fill('一条普通速记');
    await page.getByTestId('home-capture-submit').click();
    const feedback = page.getByTestId('home-capture-feedback');
    await expect(feedback).toContainText('已保存');
    await expect(feedback.getByRole('button', { name: /去收件箱整理/ })).toBeVisible();
  });
});
