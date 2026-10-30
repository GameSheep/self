import { test, expect } from '@playwright/test';
import { seedState, baseState, gotoTab } from './helpers';

/**
 * 网站图标自动识别.
 *
 * 识别机制：图标永远从 URL 派生（<img src={origin}/favicon.ico>，由浏览器自动请求），
 * 不需要用户上传，也不会把书签列表发给第三方图标服务；请求失败（站点没有
 * /favicon.ico 或离线）就回退到按主机名哈希着色的首字母块。
 *
 * 覆盖两条链路：手动添加网站（表单内实时预览）与快捷导航卡片（保存后直接生效）。
 * AI 识别用同一个 <SiteIcon> 组件渲染预览，机制相同，不重复搭 AI mock。
 */

const TINY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60eQkgAAAABJRU5ErkJggg==';

async function mockFavicons(page: any) {
  await page.route('**/*', async (route) => {
    const url = route.request().url();
    if (url.startsWith('https://icon-ok.example.com/favicon.ico')) {
      await route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from(TINY_PNG, 'base64') });
      return;
    }
    if (url.startsWith('https://icon-bad.example.com/favicon.ico')) {
      await route.fulfill({ status: 404, contentType: 'text/plain', body: 'nope' });
      return;
    }
    await route.continue();
  });
}

test.describe('网站图标自动识别', () => {
  test('添加网站：输入网址后实时预览自动识别的图标，失败回退首字母', async ({ page }) => {
    await mockFavicons(page);
    await seedState(page, baseState({}));
    await page.goto('/');
    await page.getByTestId('global-new').click();
    await expect(page.getByTestId('add-item-modal')).toBeVisible();
    await page.locator('[data-add-type="site"]').click({ timeout: 2000 }).catch(() => undefined);

    // 能拿到 favicon 的站点：预览渲染真实图标（img 而非字母块）。
    // 带 ?s=1 查询参数是刻意的：Chromium 会静默取消裸 /favicon.ico 路径的子资源请求。
    await page.locator('input[placeholder="https://..."]').fill('https://icon-ok.example.com');
    const preview = page.getByTestId('add-site-icon-preview');
    await expect(preview).toBeVisible();
    await expect(preview.locator('img[data-site-icon-src]')).toHaveAttribute(
      'src',
      'https://icon-ok.example.com/favicon.ico?s=1'
    );

    // 拿不到 favicon 的站点：回退彩色首字母块。
    await page.locator('input[placeholder="https://..."]').fill('https://icon-bad.example.com');
    await expect(preview.locator('[data-site-icon-fallback="initial"]')).toBeVisible();
  });

  test('快捷导航卡片：保存后直接显示识别出的图标，无需任何手动设置', async ({ page }) => {
    await mockFavicons(page);
    await seedState(
      page,
      baseState({
        sites: [
          { id: 'st-ok', title: '图标站', url: 'https://icon-ok.example.com', category: '技术开发', createdAt: Date.now() },
          { id: 'st-bad', title: '字母站', url: 'https://icon-bad.example.com', category: '技术开发', createdAt: Date.now() }
        ]
      })
    );
    await page.goto('/');
    await gotoTab(page, '快捷导航');

    // 有 favicon 的站点：卡片渲染真实图标。
    await expect(page.locator('[data-site-id="st-ok"] img[data-site-icon-src]')).toBeVisible();

    // 没有 favicon 的站点：回退首字母（"字"）。
    const fallback = page.locator('[data-site-id="st-bad"] [data-site-icon-fallback="initial"]');
    await expect(fallback).toBeVisible();
    await expect(fallback).toHaveText('字');
  });
});
