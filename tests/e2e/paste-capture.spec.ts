import { test, expect } from '@playwright/test';
import { resetApp, seedState, baseState, readState } from './helpers';

/**
 * 粘贴识别 (2).
 *
 * Paste text that contains links → sites are recognised **locally** → a dialog asks where the
 * content should go (快捷导航 / 收件箱 / 笔记) → only after confirming is anything written.
 */
test.describe('快捷导航：粘贴识别', () => {
  test.beforeEach(async ({ page }) => {
    page.on('dialog', (d) => d.accept());
  });

  test('粘贴带链接的文字 → 识别出网站 → 确认后存进快捷导航', async ({ page }) => {
    await resetApp(page);
    await seedState(page, baseState());
    await page.goto('/#/navigation');
    await page.reload();
    await page.getByTestId('nav-ai-focus').click();

    await expect(page.getByTestId('paste-capture')).toBeVisible();
    await page
      .getByTestId('paste-capture-input')
      .fill('我的收藏\nGitHub 代码托管 https://github.com/explore\n阿里云控制台 https://ecs.console.aliyun.com');
    await page.getByTestId('paste-capture-recognize').click();

    const dialog = page.getByTestId('paste-capture-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('识别到 2 个网站');

    // Category guess from the host, editable in the dialog.
    await expect(page.getByTestId('paste-candidate-category-0')).toHaveValue('技术开发');

    // 快捷导航 is the default destination.
    await expect(page.locator('[data-destination="sites"]')).toBeChecked();
    await page.getByTestId('paste-capture-save').click();

    await expect(page.getByTestId('paste-capture-feedback')).toContainText('2 个网站');
    await expect.poll(async () => (await readState(page)).sites?.length).toBe(2);
    const saved: any = await readState(page);
    expect(saved.sites.map((s: any) => s.url).sort()).toEqual([
      'https://ecs.console.aliyun.com',
      'https://github.com/explore'
    ]);
    expect(saved.sites.every((s: any) => s.category)).toBe(true);
    // Nothing was written before confirmation, and nothing extra was written after it.
    expect(saved.notes).toHaveLength(0);
    expect(saved.inbox).toHaveLength(0);
  });

  test('可以同时存到收件箱与笔记（原文保留）', async ({ page }) => {
    await resetApp(page);
    await seedState(page, baseState());
    await page.goto('/#/navigation');
    await page.reload();
    await page.getByTestId('nav-ai-focus').click();

    const raw = '读到一个好站点 https://example.invalid/article 记下来';
    await page.getByTestId('paste-capture-input').fill(raw);
    await page.getByTestId('paste-capture-recognize').click();
    await page.locator('[data-destination="sites"]').uncheck();
    await page.locator('[data-destination="inbox"]').check();
    await page.locator('[data-destination="note"]').check();
    await page.getByTestId('paste-capture-save').click();

    await expect.poll(async () => (await readState(page)).inbox?.length).toBe(1);
    const saved: any = await readState(page);
    expect(saved.inbox[0].content).toContain('example.invalid/article');
    expect(saved.notes).toHaveLength(1);
    expect(saved.notes[0].content).toContain('读到一个好站点');
    // 「存到哪里」是用户选的：没勾快捷导航就不写网站。
    expect(saved.sites).toHaveLength(0);
  });

  test('没有链接时也能整段存起来，并说明没识别到网站', async ({ page }) => {
    await resetApp(page);
    await seedState(page, baseState());
    await page.goto('/#/navigation');
    await page.reload();
    await page.getByTestId('nav-ai-focus').click();

    await page.getByTestId('paste-capture-input').fill('一段没有链接的随手记');
    await page.getByTestId('paste-capture-recognize').click();
    await expect(page.getByTestId('paste-capture-dialog')).toContainText('这段文字里没有链接');

    await page.locator('[data-destination="inbox"]').check();
    await page.getByTestId('paste-capture-save').click();
    await expect.poll(async () => (await readState(page)).inbox?.length).toBe(1);
    expect((await readState(page)).sites).toHaveLength(0);
  });

  test('取消不写入任何东西', async ({ page }) => {
    await resetApp(page);
    await seedState(page, baseState());
    await page.goto('/#/navigation');
    await page.reload();
    await page.getByTestId('nav-ai-focus').click();

    await page.getByTestId('paste-capture-input').fill('https://cancel.example.invalid');
    await page.getByTestId('paste-capture-recognize').click();
    await page.getByTestId('paste-capture-dialog').getByRole('button', { name: '取消' }).click();

    const saved: any = await readState(page);
    expect(saved.sites).toHaveLength(0);
    expect(saved.inbox ?? []).toHaveLength(0);
    expect(saved.notes).toHaveLength(0);
  });

  test('云端 AI 猜分类是可选的，而且只发送域名', async ({ page }) => {
    // Cloud AI is off by default; the button must not even appear.
    await resetApp(page);
    await seedState(page, baseState());
    await page.goto('/#/navigation');
    await page.reload();
    await page.getByTestId('nav-ai-focus').click();
    await page.getByTestId('paste-capture-input').fill('https://github.com/private/repo?token=SECRET');
    await page.getByTestId('paste-capture-recognize').click();
    await expect(page.getByTestId('paste-ai-classify')).toHaveCount(0);

    // Enable cloud AI and capture what is actually sent.
    const bodies: string[] = [];
    await page.route('**/*', async (route) => {
      const url = route.request().url();
      if (!url.includes('generativelanguage.googleapis.com') && !url.includes('api.deepseek.com')) {
        return route.continue();
      }
      bodies.push(route.request().postData() ?? '');
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          candidates: [{ content: { parts: [{ text: '{"github.com":"运维部署"}' }] } }]
        })
      });
    });

    // Enable cloud AI. A plain `localStorage` write would be overwritten by seedState's own
    // init script on the next navigation, so this is a second init script (it runs after it).
    await page.addInitScript(() => {
      const raw = localStorage.getItem('self_hub_data_v2');
      if (!raw) return;
      const state = JSON.parse(raw);
      // The classifier may only choose from the user's existing categories, so seed the one
      // the mocked answer uses.
      state.categories = ['全部', '技术开发', '运维部署'];
      state.aiConfig = {
        ...state.aiConfig,
        provider: 'gemini',
        apiKey: 'test-key',
        model: 'gemini-2.5-flash',
        cloudAiEnabled: true
      };
      localStorage.setItem('self_hub_data_v2', JSON.stringify(state));
    });
    await page.reload();
    await page.getByTestId('nav-ai-focus').click();

    await page.getByTestId('paste-capture-input').fill('https://github.com/private/repo?token=SECRET');
    await page.getByTestId('paste-capture-recognize').click();
    await page.getByTestId('paste-ai-classify').click();

    await expect(page.getByTestId('paste-ai-message')).toContainText('云端');
    await expect(page.getByTestId('paste-candidate-category-0')).toHaveValue('运维部署');

    // Privacy: the prompt carries the hostname and nothing else from the paste.
    const sent = bodies.join('\n');
    expect(sent).toContain('github.com');
    expect(sent).not.toContain('/private/repo');
    expect(sent).not.toContain('SECRET');
  });
});
