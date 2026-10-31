import { test, expect } from '@playwright/test';
import { resetApp, readState, visible, openAddModal, gotoTab } from './helpers';

test.describe('核心 CRUD 与持久化', () => {
  let dialogs: string[] = [];

  test.beforeEach(async ({ page }) => {
    dialogs = [];
    page.on('dialog', (d) => {
      dialogs.push(d.message());
      void d.accept();
    });
    await resetApp(page);
  });

  test('新增网站会写入 localStorage 并在刷新后保留', async ({ page }) => {
    const before = await readState(page);
    await openAddModal(page);
    await visible(page, 'input[placeholder="例如: GitHub 个人中心"]').fill('回归测试站点');
    await visible(page, 'input[placeholder="https://..."]').fill('regression.example.com');
    await page.getByTestId('add-item-submit').click();

    await expect
      .poll(async () => (await readState(page)).sites.length)
      .toBe(before.sites.length + 1);

    const added = (await readState(page)).sites.find((s: any) => s.title === '回归测试站点');
    expect(added.url).toBe('https://regression.example.com');
    expect(added.category).toBeTruthy();
    expect(added.icon).toBeTruthy();

    await page.reload();
    await expect(page.locator('main')).toContainText('回归测试站点');
  });

  test('新增笔记、编辑、删除形成闭环', async ({ page }) => {
    await gotoTab(page, '深度知识文档');
    const before = (await readState(page)).notes.length;

    // No 「新建」 button and no edit mode: the pane is one big textarea, first line = title.
    await page.getByTestId('notes-textarea').fill('回归笔记\n回归笔记正文');
    await page.getByTestId('notes-save').click();

    await expect.poll(async () => (await readState(page)).notes.length).toBe(before + 1);
    const note = (await readState(page)).notes.find((n: any) => n.title === '回归笔记');
    expect(note.content).toContain('回归笔记正文');

    // Editing is the same textarea: change the text and save again.
    await page.getByTestId('notes-textarea').fill('回归笔记\n回归笔记正文（已编辑）');
    await page.getByTestId('notes-save').click();
    await expect
      .poll(async () => (await readState(page)).notes.find((n: any) => n.id === note.id)?.content)
      .toContain('已编辑');
  });

  test('新增提醒事项并持久化', async ({ page }) => {
    await gotoTab(page, '倒计时与续费');
    await page.locator('button', { hasText: '新建提醒事项' }).first().click();
    await visible(page, 'input[placeholder*="ChatGPT"], input[placeholder*="名称"], input[placeholder*="标题"]').fill('回归提醒');
    await visible(page, 'input[type="date"]').fill('2026-12-31');
    await page.locator('button', { hasText: /保存|确认|添加/ }).first().click();

    await expect.poll(async () => (await readState(page)).reminders.length).toBe(1);
    const reminder = (await readState(page)).reminders[0];
    // Local-date parsing: 2026-12-31 must not drift a day in UTC+8.
    expect(new Date(reminder.targetDate).getDate()).toBe(31);
    expect(new Date(reminder.targetDate).getMonth()).toBe(11);
  });

  test('提醒可以标记完成并取消（completed 是可达状态）', async ({ page }) => {
    await gotoTab(page, '倒计时与续费');
    await page.locator('button', { hasText: '新建提醒事项' }).first().click();
    await visible(page, 'input[placeholder*="ChatGPT"], input[placeholder*="名称"], input[placeholder*="标题"]').fill('可完成提醒');
    await visible(page, 'input[type="date"]').fill('2026-12-31');
    await page.locator('button', { hasText: /保存|确认|添加/ }).first().click();
    await expect.poll(async () => (await readState(page)).reminders.length).toBe(1);

    // Contract (P1-07): 完成本次 and 续期 are now two separate actions. 完成本次
    // only records this occurrence ("完成本次" → "已完成本次") and leaves the due
    // date alone, so the same button is also the way back to an open state.
    // The old 标记完成 / 已完成 label pair no longer exists.
    const reminderId = (await readState(page)).reminders[0].id;
    const completeToggle = page.getByTestId(`reminder-complete-${reminderId}`);

    await completeToggle.click();
    await expect.poll(async () => (await readState(page)).reminders[0].completed).toBe(true);
    // The rounded state must be visible, not just stored.
    await expect(completeToggle).toContainText('已完成本次');

    await completeToggle.click();
    await expect.poll(async () => (await readState(page)).reminders[0].completed).toBe(false);
    await expect(completeToggle).toContainText('完成本次');
  });

  test('收件箱快速存入并转为笔记', async ({ page }) => {
    await gotoTab(page, '统一收件箱');
    const box = page.locator('main textarea').first();
    await box.fill('https://inbox.example.com');
    await page.keyboard.press('Control+Enter');
    await expect.poll(async () => (await readState(page)).inbox?.length).toBe(1);

    // The per-item conversion button now carries a testid. Matching on the text
    // "转为笔记" also matched the batch action 批量转为笔记, which only opens the
    // batch preview dialog — it never converted the single item.
    const itemId = (await readState(page)).inbox![0].id;
    await page.getByTestId(`inbox-convert-note-${itemId}`).click();
    await expect.poll(async () => (await readState(page)).notes.length).toBeGreaterThan(0);

    const item = (await readState(page)).inbox![0];
    expect(item.status).toBe('processed');
    // Regression: the conversion used to wipe targetId with a stale second update.
    expect(item.targetType).toBe('note');
    expect(item.targetId).toBeTruthy();
    // A converted item stays visible until the filter changes, so the outcome is
    // discoverable instead of the card vanishing under the cursor (P1-05).
    await expect(page.getByTestId(`inbox-open-target-${itemId}`)).toBeVisible();
  });

  test('手绘白板保存为卡片', async ({ page }) => {
    await gotoTab(page, '交互手绘白板');
    const canvas = page.locator('main canvas').first();
    const box = (await canvas.boundingBox())!;
    await page.mouse.move(box.x + 40, box.y + 40);
    await page.mouse.down();
    await page.mouse.move(box.x + 160, box.y + 120, { steps: 8 });
    await page.mouse.up();
    await page.locator('button', { hasText: '保存为卡片' }).first().click();
    await expect.poll(async () => (await readState(page)).handwritings.length).toBe(1);
  });

  test('空画板不会保存出一张空白卡片', async ({ page }) => {
    await gotoTab(page, '交互手绘白板');
    await page.locator('button', { hasText: '保存为卡片' }).first().click();
    // 空画板拒绝保存的提示现在是全局 toast（原生 alert 已退役）。
    await expect(page.getByText('画板还是空的')).toBeVisible();
    expect((await readState(page)).handwritings.length).toBe(0);
  });
});
