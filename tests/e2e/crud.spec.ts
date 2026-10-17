import { test, expect } from '@playwright/test';
import { resetApp, readState, visible, openAddModal } from './helpers';

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
    await page.locator('div.fixed.inset-0 button', { hasText: '保存资产' }).click();

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
    await page.locator('nav button', { hasText: '深度知识文档' }).click();
    const before = (await readState(page)).notes.length;

    await page.locator('button', { hasText: '新建知识文档' }).first().click();
    // Exact placeholders: "*=标题" would also match the full-text search box.
    await visible(page, 'input[placeholder="文档标题..."]').fill('回归笔记');
    await visible(page, 'textarea[placeholder*="Markdown"]').fill('回归笔记正文');
    await page.locator('button', { hasText: /^保存$/ }).first().click();

    await expect.poll(async () => (await readState(page)).notes.length).toBe(before + 1);
    const note = (await readState(page)).notes.find((n: any) => n.title === '回归笔记');
    expect(note.content).toContain('回归笔记正文');
  });

  test('新增提醒事项并持久化', async ({ page }) => {
    await page.locator('nav button', { hasText: '倒计时与续费' }).click();
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
    await page.locator('nav button', { hasText: '倒计时与续费' }).click();
    await page.locator('button', { hasText: '新建提醒事项' }).first().click();
    await visible(page, 'input[placeholder*="ChatGPT"], input[placeholder*="名称"], input[placeholder*="标题"]').fill('可完成提醒');
    await visible(page, 'input[type="date"]').fill('2026-12-31');
    await page.locator('button', { hasText: /保存|确认|添加/ }).first().click();
    await expect.poll(async () => (await readState(page)).reminders.length).toBe(1);

    await page.locator('button', { hasText: '标记完成' }).first().click();
    await expect.poll(async () => (await readState(page)).reminders[0].completed).toBe(true);

    await page.locator('button', { hasText: '已完成' }).first().click();
    await expect.poll(async () => (await readState(page)).reminders[0].completed).toBe(false);
  });

  test('收件箱快速存入并转为笔记', async ({ page }) => {
    await page.locator('nav button', { hasText: '统一收件箱' }).click();
    const box = page.locator('main textarea').first();
    await box.fill('https://inbox.example.com');
    await page.keyboard.press('Control+Enter');
    await expect.poll(async () => (await readState(page)).inbox?.length).toBe(1);

    await page.locator('button', { hasText: '转为笔记' }).first().click();
    await expect.poll(async () => (await readState(page)).notes.length).toBeGreaterThan(0);

    const item = (await readState(page)).inbox![0];
    expect(item.status).toBe('processed');
    // Regression: the conversion used to wipe targetId with a stale second update.
    expect(item.targetType).toBe('note');
    expect(item.targetId).toBeTruthy();
  });

  test('手绘白板保存为卡片', async ({ page }) => {
    await page.locator('nav button', { hasText: '交互手绘白板' }).click();
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
    await page.locator('nav button', { hasText: '交互手绘白板' }).click();
    await page.locator('button', { hasText: '保存为卡片' }).first().click();
    await expect.poll(() => dialogs.join('|')).toContain('空');
    expect((await readState(page)).handwritings.length).toBe(0);
  });
});
