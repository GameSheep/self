import { test, expect } from '@playwright/test';
import { resetApp, readState, seedState, baseState, STORAGE_KEY, gotoTab, visible } from './helpers';

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
    await gotoTab(page, '倒计时与续费');
    await expect(page.locator('main')).toContainText('非法周期提醒', { timeout: 10_000 });

    // A valid navigation still works => the main thread is not blocked.
    // The old 仪表盘总览 card titles are gone; #/home is HomeView, and the
    // never-completed overdue reminder must surface in its 今天要处理 block.
    await gotoTab(page, '首页');
    await expect(page.locator('[data-home-block="todo"]')).toContainText('非法周期提醒');
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
    await gotoTab(page, '倒计时与续费');
    await expect
      .poll(async () => (await readState(page)).reminders[0].targetDate, { timeout: 10_000 })
      .toBeGreaterThan(Date.now());
  });
});

test.describe('笔记草稿', () => {
  test('保存后不再提示恢复草稿（草稿曾经被永久保留）', async ({ page }) => {
    page.on('dialog', (d) => d.accept());
    await resetApp(page);

    // A reset profile is empty; the pane's single textarea creates the note, and typing in it
    // is what writes the draft.
    await gotoTab(page, '深度知识文档');
    await expect(page.getByTestId('notes-workspace')).toBeVisible();
    await page.getByTestId('notes-textarea').fill('草稿回归笔记\n草稿内容草稿内容');
    // Let the 800ms debounced draft write happen.
    await page.waitForTimeout(1200);
    const draftWhileEditing = await page.evaluate(() => localStorage.getItem('selfhub_note_draft_pane'));
    expect(draftWhileEditing, '编辑中应写入草稿').not.toBeNull();

    await page.getByTestId('notes-save').click();
    // Exactly one note: saving did not duplicate it.
    await expect.poll(async () => (await readState(page)).notes.length).toBe(1);
    expect((await readState(page)).notes[0].title).toBe('草稿回归笔记');
    const draft = await page.evaluate(() => localStorage.getItem('selfhub_note_draft_pane'));
    expect(draft, '保存成功后草稿应被清除').toBeNull();
    await expect(page.getByTestId('notes-draft-banner')).toHaveCount(0);
  });

  test('直接编辑不保存就离开，草稿仍在并能在回来后恢复', async ({ page }) => {
    // The pane has no 「编辑 / 取消」 pair any more — it is one textarea. Leaving it unsaved must
    // still not silently lose the text: the draft is kept and offered when the page reloads,
    // while the stored note stays untouched until the user saves.
    await resetApp(page);
    await seedState(
      page,
      baseState({
        notes: [{ id: 'n-edit', title: '待编辑笔记', content: '原始内容', updatedAt: Date.now() }]
      })
    );
    await page.goto('/');
    await gotoTab(page, '深度知识文档');
    await page.getByTestId('notes-textarea').fill('未保存的修改内容');
    await page.waitForTimeout(1100);

    // Stored note untouched so far.
    expect((await readState(page)).notes[0].content).toBe('原始内容');

    await page.reload();
    await gotoTab(page, '深度知识文档');
    await expect(page.getByTestId('notes-draft-banner')).toBeVisible();
    await page.getByTestId('notes-draft-restore').click();
    await expect(page.getByTestId('notes-textarea')).toHaveValue(/未保存的修改内容/);
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
