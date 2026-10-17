import { test, expect } from '@playwright/test';
import { resetApp, readState, seedState, baseState, STORAGE_KEY } from './helpers';

/**
 * Regression tests for data-integrity bugs found during the audit:
 * the reminder auto-rollover infinite loop, the note draft that silently
 * overwrote another note, and search that ignored the clicked result.
 */

test.describe('倒计时自动顺延', () => {
  test('非法的 recurring 值不会把标签页卡死（曾经的死循环）', async ({ page }) => {
    page.on('dialog', (d) => d.accept());
    await resetApp(page);
    // Seed a reminder whose recurrence is outside the union type and long expired,
    // with autoRollover enabled: this used to spin forever on mount.
    await page.evaluate(
      ([key, value]) => localStorage.setItem(key as string, value as string),
      [
        STORAGE_KEY,
        JSON.stringify(
          baseState({
            reminders: [
              {
                id: 'r-bad',
                title: '非法周期提醒',
                category: 'subscription',
                targetDate: Date.now() - 1000 * 60 * 60 * 24 * 400,
                recurring: 'daily',
                autoRollover: true,
                completed: false,
                createdAt: Date.now()
              }
            ]
          })
        )
      ] as const
    );

    await page.goto('/');
    // The UI must remain responsive within a couple of seconds.
    await expect(page.locator('main')).toBeVisible({ timeout: 10_000 });
    await page.locator('nav button', { hasText: '倒计时与续费' }).click();
    await expect(page.locator('main')).toContainText('非法周期提醒', { timeout: 10_000 });

    // A valid click still works => the main thread is not blocked.
    await page.locator('nav button', { hasText: '仪表盘总览' }).click();
    await expect(page.locator('main')).toContainText('快速秒开');
  });

  test('合法周期会从到期日推进到下一个未来周期', async ({ page }) => {
    page.on('dialog', (d) => d.accept());
    await resetApp(page);
    const expired = Date.now() - 1000 * 60 * 60 * 24 * 3;
    await page.evaluate(
      ([key, value]) => localStorage.setItem(key as string, value as string),
      [
        STORAGE_KEY,
        JSON.stringify(
          baseState({
            reminders: [
              {
                id: 'r-ok',
                title: '月付会员',
                category: 'subscription',
                targetDate: expired,
                recurring: 'monthly',
                autoRollover: true,
                completed: false,
                createdAt: Date.now()
              }
            ]
          })
        )
      ] as const
    );

    await page.goto('/');
    await page.locator('nav button', { hasText: '倒计时与续费' }).click();
    await expect
      .poll(async () => (await readState(page)).reminders[0].targetDate, { timeout: 10_000 })
      .toBeGreaterThan(Date.now());
  });
});

test.describe('笔记草稿', () => {
  test('保存后不再提示恢复草稿（草稿曾经被永久保留）', async ({ page }) => {
    page.on('dialog', (d) => d.accept());
    await resetApp(page);

    await page.locator('nav button', { hasText: '深度知识文档' }).click();
    await page.locator('button', { hasText: '新建知识文档' }).first().click();
    const title = page.locator('input[placeholder*="标题"]').locator('visible=true').first();
    await title.fill('草稿回归笔记');
    await page.locator('textarea').first().fill('草稿内容草稿内容');
    // Let the 800ms debounced draft write happen.
    await page.waitForTimeout(1200);
    await page.locator('button', { hasText: /^保存$/ }).first().click();

    await expect.poll(async () => (await readState(page)).notes.length).toBeGreaterThan(1);
    const draft = await page.evaluate(() => localStorage.getItem('selfhub_note_draft'));
    expect(draft, '保存成功后草稿应被清除').toBeNull();
    await expect(page.getByText('检测到本地存在上次未提交的编辑草稿')).toHaveCount(0);
  });

  test('编辑途中取消会先确认，避免静默丢弃', async ({ page }) => {
    await resetApp(page);
    await page.locator('nav button', { hasText: '深度知识文档' }).click();
    await page.locator('button', { hasText: /编辑/ }).first().click();
    await page.locator('textarea').first().fill('未保存的修改内容');

    let confirmShown = false;
    page.once('dialog', (d) => {
      confirmShown = true;
      void d.dismiss();
    });
    await page.locator('button', { hasText: '取消' }).first().click();
    await page.waitForTimeout(300);
    expect(confirmShown, '取消编辑时应提示未保存内容').toBe(true);
  });
});

test.describe('全局搜索', () => {
  test('Ctrl+K 搜索后可定位到具体笔记', async ({ page }) => {
    page.on('dialog', (d) => d.accept());
    await resetApp(page);
    await seedState(
      page,
      baseState({
        notes: [
          { id: 'n-target', title: '独一无二的定位目标', content: 'anchor-content', updatedAt: Date.now() },
          { id: 'n-other', title: '另一篇笔记', content: 'other', updatedAt: Date.now() }
        ]
      })
    );
    await page.goto('/');

    await page.keyboard.press('Control+k');
    await page.keyboard.type('独一无二的定位目标');
    await expect(page.getByText('独一无二的定位目标').first()).toBeVisible();
    await page.keyboard.press('Enter');

    await expect(page.locator('main')).toContainText('anchor-content');
  });
});
