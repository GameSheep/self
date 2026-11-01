import { test, expect } from '@playwright/test';
import { resetApp, seedState, baseState, readState } from './helpers';

/**
 * P1-03 / P1-05 acceptance: the first complete user path.
 * 首页打开网站 → 快速记录 → 收件箱 → 查找并打开资料
 */

test.describe('P1 主路径', () => {
  test.beforeEach(async ({ page }) => {
    page.on('dialog', (d) => d.dismiss());
  });

  test('首页可以直接打开常用网站，不经过模块配置', async ({ page }) => {
    // Stub the target so the popup resolves without network access. The route has
    // to live on the context: a popup is a different Page and would not see a
    // route registered on the opener.
    await page.context().route('https://example.invalid/**', (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>stub</h1>' })
    );
    await seedState(
      page,
      baseState({
        sites: [
          {
            id: 'site-e2e-1',
            title: '示例站点',
            url: 'https://example.invalid/',
            category: '技术开发',
            pinned: true,
            visitCount: 0,
            createdAt: 1760000000000
          }
        ]
      })
    );

    await page.goto('/#/home');
    await expect(page.locator('main')).toBeVisible();

    const popupPromise = page.waitForEvent('popup');
    await page.locator('[data-site-card="site-e2e-1"]').click();
    const popup = await popupPromise;
    expect(popup.url()).toContain('example.invalid');
    await popup.close();

    // Opening the site through the home grid counts as a visit.
    const state = await readState(page);
    expect(state.sites[0].visitCount).toBe(1);
  });

  test('新安装首页是可直接使用的，不再显示引导面板，也不会预填示例数据', async ({ page }) => {
    await resetApp(page);

    // The 「先做这三件事」 panel (and its 「体验示例」 link) was removed on request: it explained
    // the product on every visit. The two things a new profile actually needs are on screen.
    await expect(page.getByTestId('home-view')).toBeVisible();
    await expect(page.getByTestId('home-capture-input')).toBeVisible();
    await expect(page.getByTestId('home-starters')).toHaveCount(0);
    await expect(page.getByTestId('load-sample')).toHaveCount(0);

    // A new profile still starts empty — nothing is seeded behind the user's back.
    const before = await readState(page);
    expect(before.sites).toEqual([]);
    expect(before.notes).toEqual([]);

    // And the first action works immediately: record something into the inbox.
    await page.getByTestId('home-capture-input').fill('新装档案的第一条');
    await page.getByTestId('home-capture-submit').click();
    await expect(page.getByTestId('home-capture-feedback')).toContainText('已保存到本机');
    const after = await readState(page);
    expect(after.inbox.length).toBe(1);
  });

  test('快速记录 → 收件箱 → 转为笔记 → 从资料库找回', async ({ page }) => {
    await resetApp(page);

    const text = 'E2E 主路径记录：把这条内容一路找回来';

    // 1. 快速记录：不选类型、不选项目、不配置云服务。
    await page.getByTestId('home-capture-input').fill(text);
    await page.getByTestId('home-capture-submit').click();

    const feedback = page.getByTestId('home-capture-feedback');
    await expect(feedback).toContainText('已保存到本机');
    await expect(page.getByTestId('home-capture-input')).toHaveValue('');

    // 2. 本机保存已被确认，而且刷新之后还在（acceptance for UX-03）。
    const stored = await readState(page);
    expect(stored.inbox?.length).toBe(1);
    expect(stored.inbox?.[0]?.content).toBe(text);
    expect(stored.inbox?.[0]?.status).toBe('inbox');

    await page.reload();
    await expect(page.locator('main')).toBeVisible();
    const afterReload = await readState(page);
    expect(afterReload.inbox?.length).toBe(1);
    expect(afterReload.inbox?.[0]?.content).toBe(text);

    // 3. 收件箱里能看到它，并能转成笔记。
    await page.goto('/#/inbox');
    await expect(page.locator('main')).toContainText(text);
    const pendingItem = await readState(page);
    const itemId = pendingItem.inbox![0].id;

    await page.getByTestId(`inbox-convert-note-${itemId}`).click();
    // toast 在全局 ToastHost（main 之外），按文本断言。
    await expect(page.getByText('已转为笔记')).toBeVisible();

    const converted = await readState(page);
    expect(converted.notes?.length).toBe(1);
    expect(converted.inbox?.[0]?.status).toBe('processed');
    expect(converted.inbox?.[0]?.targetType).toBe('note');
    expect(converted.inbox?.[0]?.targetId).toBe(converted.notes?.[0]?.id);

    // 4. 重复操作不会创建第二条：按钮变成「打开原笔记」。
    await expect(page.getByTestId(`inbox-open-target-${itemId}`)).toBeVisible();
    await expect(page.getByTestId(`inbox-convert-note-${itemId}`)).toHaveCount(0);
    const stillOne = await readState(page);
    expect(stillOne.notes?.length).toBe(1);

    // 5. 从收件箱直接打开原笔记，落在资料条目上。
    await page.getByTestId(`inbox-open-target-${itemId}`).click();
    await expect(page).toHaveURL(/#\/library\/item\//);
    await expect(page.locator('main')).toContainText(text);

    // 6. 在「笔记」页里检索并打开这条实际条目（全部资料视图已按新方案移除）。
    await page.goto('/#/library?view=notes');
    await page.locator('[data-testid="notes-search"]').fill('E2E 主路径记录');
    // The folder tree lists it; opening it loads the textarea.
    const row = page.locator('[data-testid^="note-row-"]').first();
    await expect(row).toContainText('E2E 主路径记录');
    await row.getByRole('button').first().click();
    await expect(page.getByTestId('notes-textarea')).toHaveValue(/E2E 主路径记录/);
  });

  test('收件箱批量转换先给预览，再逐项报告结果', async ({ page }) => {
    await seedState(
      page,
      baseState({
        inbox: [
          { id: 'inbox-a', content: '第一条待整理内容', type: 'text', status: 'inbox', createdAt: 1760000000000 },
          { id: 'inbox-b', content: '第二条待整理内容', type: 'text', status: 'inbox', createdAt: 1760000000001 }
        ]
      })
    );
    await page.goto('/#/inbox');
    await page.getByTestId('inbox-batch-note').click();

    // Preview states counts and destination before anything is written.
    await expect(page.getByRole('dialog')).toContainText('批量转换预览');
    await expect(page.getByRole('dialog')).toContainText('将新建 2 条');
    await expect(page.getByRole('dialog')).toContainText('资料库 · 笔记');

    await page.getByRole('button', { name: '开始转换' }).click();
    const state = await readState(page);
    expect(state.notes?.length).toBe(2);
    expect(state.inbox?.every((i: any) => i.status === 'processed')).toBe(true);
  });

  test('非法路由显示明确的缺失页面，而不是空白', async ({ page }) => {
    await resetApp(page);
    await page.goto('/#/definitely-not-a-page');
    await expect(page.getByTestId('not-found-view')).toBeVisible();
    await page.getByRole('button', { name: '返回首页' }).click();
    await expect(page.getByTestId('home-view')).toBeVisible();
  });
});
