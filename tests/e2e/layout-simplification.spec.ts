import { test, expect } from '@playwright/test';
import { baseState, readState, seedState } from './helpers';

const profile = () => baseState({
  sites: [{ id: 'layout-site', title: '常用网站', url: 'https://example.invalid/', category: '技术开发', createdAt: 1 }],
  notes: [{ id: 'layout-note', title: '项目资料', content: '继续编辑这里', updatedAt: 1, folder: '工作' }],
  noteFolders: ['工作'],
  reminders: [{ id: 'layout-reminder', title: '项目续费', targetDate: Date.now() + 86400000, createdAt: 1, category: 'other' }]
});

test('桌面首屏可以看到全部导航，首页搜索和网站无需跨栏查找', async ({ page }, info) => {
  await page.setViewportSize({ width: 1024, height: 720 });
  await seedState(page, profile());
  await page.goto('/#/home');
  const sidebar = page.getByTestId('sidebar');
  for (const name of ['首页', '快捷导航', '收件箱', '笔记', '网页批注', '远端笔记', '项目', '提醒', '服务器', '域名', '凭证金库', '签到', '手绘', '设置']) {
    await expect(sidebar.getByRole('button', { name, exact: true })).toBeInViewport();
  }
  await expect(page.getByTestId('home-search-input')).toBeInViewport();
  await expect(page.getByTestId('home-note-layout-note')).toBeInViewport();
  await expect(page.locator('main a[href="https://example.invalid/"]')).toHaveCount(1);
  const search = await page.getByTestId('home-search-input').boundingBox();
  const sites = await page.locator('[data-home-block="sites"]').boundingBox();
  expect(search!.y + search!.height).toBeLessThan(sites!.y);
  expect(search!.width).toBeGreaterThan(700);
  await page.getByTestId('home-capture-input').fill('简单记录一件事');
  await page.getByTestId('home-capture-submit').click();
  await expect.poll(async () => (await readState(page)).inbox?.some((entry: any) => entry.content?.includes('简单记录'))).toBe(true);
  await page.screenshot({ path: info.outputPath('home-desktop.png') });
  await page.getByRole('button', { name: '添加网站', exact: true }).click();
  await expect(page.getByTestId('add-item-modal')).toBeVisible();
  // A contextual action opens the correct form without another type selection.
  await expect(page.locator('[data-add-type]')).toHaveCount(0);
});

test('320px 首页无横向溢出，手机导航仍能到达资料、资源和工具', async ({ page }, info) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await seedState(page, profile());
  await page.goto('/#/home');
  await expect(page.getByTestId('home-search-input')).toBeInViewport();
  await expect(page.getByTestId('home-capture-submit')).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('home-mobile.png') });
  await page.getByTestId('mobile-nav-toggle').click();
  const navigation = page.getByRole('dialog', { name: '导航', exact: true });
  for (const name of ['笔记', '网页批注', '远端笔记', '服务器', '域名', '凭证金库', '签到', '手绘', '整理内容', '解锁金库']) {
    await expect(navigation.getByRole('button', { name, exact: true })).toBeVisible();
  }
  await navigation.getByRole('button', { name: '笔记', exact: true }).click();
  await expect(page.getByTestId('page-title')).toHaveText('笔记');
  await expect(navigation).toHaveCount(0);
});

test('手机先显示笔记编辑区，打开列表后可返回编辑并保存', async ({ page }, info) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await seedState(page, profile());
  await page.goto('/#/library?view=notes');
  await expect(page.getByTestId('notes-textarea')).toBeInViewport();
  await expect(page.getByRole('tablist', { name: '资料库视图' })).toBeVisible();
  await expect(page.getByTestId('notes-folder-tree')).toBeHidden();
  await page.getByTestId('notes-browse-toggle').click();
  await expect(page.getByTestId('notes-folder-tree')).toBeVisible();
  await page.getByTestId('note-row-layout-note').getByRole('button', { name: '项目资料', exact: true }).click();
  await expect(page.getByTestId('note-row-layout-note')).toHaveAttribute('data-selected', 'true');
  await expect(page.getByTestId('notes-textarea')).toHaveValue(/继续编辑这里/);
  await page.getByTestId('notes-textarea').fill('新的标题\n新的正文');
  // Merely browsing must not discard unsaved edits.
  await page.getByTestId('notes-browse-toggle').click();
  await page.getByTestId('notes-browse-toggle').click();
  await expect(page.getByTestId('notes-textarea')).toHaveValue('新的标题\n新的正文');
  await page.getByTestId('notes-save').click();
  await expect.poll(async () => (await readState(page)).notes.find((note: any) => note.id === 'layout-note')?.title).toBe('新的标题');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('notes-mobile.png') });
});

test('网站列表优先显示，收起录入区保留输入且不发起外部搜索', async ({ page }, info) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await seedState(page, profile());
  await page.goto('/#/navigation');
  await expect(page.locator('[data-site-id="layout-site"]')).toBeInViewport();
  await expect(page.getByTestId('paste-capture-input')).toBeHidden();
  await expect(page.getByTestId('web-search-input')).toBeHidden();
  await page.screenshot({ path: info.outputPath('navigation-desktop.png') });
  await page.getByTestId('nav-ai-focus').click();
  await page.getByTestId('paste-capture-input').fill('稍后整理 https://example.invalid/');
  await page.getByTestId('nav-ai-focus').click();
  await page.getByTestId('nav-ai-focus').click();
  await expect(page.getByTestId('paste-capture-input')).toHaveValue('稍后整理 https://example.invalid/');
  await page.getByText('去网上搜索', { exact: true }).click();
  await expect(page.getByTestId('web-search-input')).toBeVisible();
});

test('桌面分类是左侧竖栏，手机上折成分类条且不横向溢出', async ({ page }, info) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await seedState(page, baseState({
    categories: ['全部', '技术开发', '效率工具'],
    sites: [
      { id: 'layout-site', title: '常用网站', url: 'https://example.invalid/', category: '技术开发', createdAt: 1 },
      { id: 'layout-other', title: '效率站点', url: 'https://two.example.invalid/', category: '效率工具', createdAt: 2 }
    ]
  }));
  await page.goto('/#/navigation');

  const rail = page.getByTestId('site-category-rail');
  const content = page.getByTestId('site-content');
  await expect(rail).toBeVisible();

  const railBox = await rail.boundingBox();
  const contentBox = await content.boundingBox();
  // The category column ends before the website column starts.
  expect(railBox!.x + railBox!.width).toBeLessThanOrEqual(contentBox!.x);

  const all = await page.getByTestId('site-category-全部').boundingBox();
  const group = await page.getByTestId('site-category-技术开发').boundingBox();
  // Vertical stack: same left edge, next item below.
  expect(Math.abs(group!.x - all!.x)).toBeLessThanOrEqual(1);
  expect(group!.y).toBeGreaterThan(all!.y);
  await expect(page.getByTestId('site-category-全部')).toHaveAttribute('aria-current', 'page');
  await page.screenshot({ path: info.outputPath('navigation-rail-desktop.png') });

  await page.getByTestId('site-category-技术开发').click();
  await expect(page.getByTestId('site-category-技术开发')).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('[data-site-id="layout-site"]')).toBeVisible();
  await expect(page.locator('[data-site-id="layout-other"]')).toHaveCount(0);

  await page.setViewportSize({ width: 320, height: 800 });
  const mobileRailBox = await rail.boundingBox();
  const mobileContentBox = await content.boundingBox();
  // A phone gets the same choices as a compact strip above the website list.
  expect(mobileRailBox!.y + mobileRailBox!.height).toBeLessThanOrEqual(mobileContentBox!.y);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('navigation-rail-mobile.png') });
});
