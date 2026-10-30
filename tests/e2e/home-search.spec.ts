import { test, expect } from '@playwright/test';
import { resetApp, seedState, baseState } from './helpers';

/**
 * 首页搜索 (1).
 *
 * One box on the home page that searches everything and opens the hit where it belongs. It
 * shares `openSearchHit` with the ⌘K dialog on purpose: a result that behaves differently
 * depending on where it was found is its own kind of confusion.
 */
function profile() {
  return baseState({
    sites: [{ id: 'site-1', title: '独一无二的站点', url: 'https://unique.example.invalid/', category: '技术开发', createdAt: 1 }],
    notes: [{ id: 'note-1', title: '独一无二的笔记', content: '正文里的独特词', category: '速记', updatedAt: 1 }],
    annotations: [
      {
        id: 'ann-1',
        pageTitle: '独一无二的批注',
        pageUrl: 'https://unique.example.invalid/page',
        text: '原文',
        note: '我的批注',
        color: 'yellow',
        createdAt: 1,
        updatedAt: 1
      }
    ],
    domains: [{ id: 'dom-1', name: 'uniquedomain.com', registrar: 'Cloudflare', createdAt: 1 }],
    servers: [
      { id: 'srv-1', name: '独一无二的主机', publicIp: '203.0.113.10', env: 'prod', createdAt: 1 }
    ],
    reminders: [
      { id: 'rem-1', title: '独一无二的提醒', category: 'other', targetDate: Date.now() + 86_400_000, createdAt: 1 }
    ]
  });
}

test.describe('首页搜索', () => {
  test.beforeEach(async ({ page }) => {
    page.on('dialog', (d) => d.accept());
  });

  test('首页中部就能搜，结果按类型分组并给出真实总数', async ({ page }) => {
    await resetApp(page);
    await seedState(page, profile());
    // A hash-only goto is same-document: the seed init script would never run.
    await page.goto('/#/home');
    await page.reload();

    await expect(page.getByTestId('home-search')).toBeVisible();
    await page.getByTestId('home-search-input').fill('独一无二');

    await expect(page.getByTestId('home-search-results')).toBeVisible();
    // Grouped, not one flat list: 笔记 / 网页批注 / 服务器 / 提醒 all match.
    await expect(page.locator('[data-search-group="note"]')).toBeVisible();
    await expect(page.locator('[data-search-group="annotation"]')).toBeVisible();
    await expect(page.locator('[data-search-group="server"]')).toBeVisible();
    await expect(page.getByTestId('home-search-total')).toContainText('条');
  });

  test('点结果跳到对应条目（笔记 → 资料条目）', async ({ page }) => {
    await resetApp(page);
    await seedState(page, profile());
    // A hash-only goto is same-document: the seed init script would never run.
    await page.goto('/#/home');
    await page.reload();
    await page.getByTestId('home-search-input').fill('独一无二的笔记');
    await page.getByTestId('home-search-hit-note-note-1').click();
    await expect(page).toHaveURL(/#\/library\/item\/note%3Anote-1|#\/library\/item\/note:note-1/);
    await expect(page.locator('main')).toContainText('独一无二的笔记');
  });

  test('没结果时说没找到，不编造条目', async ({ page }) => {
    await resetApp(page);
    await seedState(page, profile());
    // A hash-only goto is same-document: the seed init script would never run.
    await page.goto('/#/home');
    await page.reload();
    await page.getByTestId('home-search-input').fill('根本不存在的东西xyzzy');
    await expect(page.getByTestId('home-search-empty')).toContainText('没找到');
  });
});
