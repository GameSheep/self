import { test, expect } from '@playwright/test';
import { seedState, baseState } from './helpers';

/**
 * P2-07: unified search coverage.
 *
 * Before this, "where can I find it?" depended on which box you typed into: the ⌘K
 * palette searched titles and note bodies but **not annotations**, the library had its
 * own filter, and the vault index only held remote bodies. This spec pins the new
 * contract: one scan over every source, grouped, with a real snippet, and an explicit
 * statement of what was *not* searched.
 */

function state(overrides: Record<string, unknown> = {}) {
  return baseState({
    notes: [
      {
        id: 'n1',
        title: '周报模板',
        // The searchable phrase is body-only, so a title match cannot explain a hit.
        content: '# 周报\n\n本周研究了 Zerotier 内网穿透的延迟表现。',
        updatedAt: 1
      }
    ],
    annotations: [
      {
        id: 'ann1',
        pageTitle: '一篇关于缓存的文章',
        pageUrl: 'https://example.com/cache',
        text: '缓存穿透可以通过布隆过滤器缓解',
        note: '和我上周的做法一致',
        color: 'yellow',
        createdAt: 1
      }
    ],
    sites: [
      { id: 's1', title: 'GitHub', url: 'https://github.com', category: '工具', createdAt: 1 }
    ],
    secrets: [
      {
        id: 'sec1',
        name: '部署用的令牌',
        category: 'api_key',
        // A distinctive ciphertext: searching for it must never match.
        encryptedValue: 'CIPHERTEXT-ZEBRA-UNIQUE-9911',
        iv: 'iv',
        salt: 'salt',
        maskedPreview: 'sk-••••9911',
        description: '用于 CI 部署',
        updatedAt: 1
      }
    ],
    ...overrides
  });
}

async function openSearch(page: any) {
  await page.keyboard.press('Control+k');
  await expect(page.getByTestId('global-search-input')).toBeVisible({ timeout: 5_000 });
}

test.describe('P2-07 统一检索覆盖', () => {
  test.beforeEach(async ({ page }) => {
    page.on('dialog', (d) => d.accept());
  });

  test('批注的原文与我的批注都能搜到，并能打开对应条目', async ({ page }) => {
    await seedState(page, state());
    await page.goto('/');
    await openSearch(page);

    // Match the *annotation text*, which no title contains.
    await page.getByTestId('global-search-input').fill('布隆过滤器');
    const annotationGroup = page.locator('[data-search-group="annotation"]');
    await expect(annotationGroup).toBeVisible();
    await expect(annotationGroup).toContainText('网页批注');
    // The snippet shows the matched context, highlighted.
    await expect(annotationGroup.locator('mark')).toContainText('布隆过滤器');

    await page.locator('[data-search-hit="annotation"]').first().click();
    await expect(page).toHaveURL(/#\/library\/item\/webpage%3Aann1|#\/library\/item\/webpage:ann1/);
  });

  test('笔记正文命中给出片段与高亮，而不是标题', async ({ page }) => {
    await seedState(page, state());
    await page.goto('/');
    await openSearch(page);

    await page.getByTestId('global-search-input').fill('Zerotier');
    const noteGroup = page.locator('[data-search-group="note"]');
    await expect(noteGroup).toBeVisible();
    await expect(noteGroup.locator('mark')).toContainText('Zerotier');
    await expect(noteGroup).toContainText('周报模板');
  });

  test('凭据只按名称匹配，密文不参与搜索', async ({ page }) => {
    await seedState(page, state());
    await page.goto('/');
    await openSearch(page);

    // The ciphertext (and any plaintext it used to be) must never be searchable.
    await page.getByTestId('global-search-input').fill('ZEBRA-UNIQUE');
    await expect(page.getByTestId('global-search-results')).toContainText('没有匹配');
    await expect(page.locator('[data-search-group="secret"]')).toHaveCount(0);

    await page.getByTestId('global-search-input').fill('部署用的令牌');
    await expect(page.locator('[data-search-group="secret"]')).toBeVisible();
    await expect(page.locator('[data-search-group="secret"]')).toContainText('sk-••••9911');
  });

  test('明确说明哪些内容没有被搜索', async ({ page }) => {
    await seedState(page, state());
    await page.goto('/');
    await openSearch(page);

    // No vault index was built in this profile.
    const coverage = page.getByTestId('search-coverage');
    await expect(coverage).toBeVisible();
    await expect(coverage).toContainText('还没有建立全文索引');
    await expect(coverage).toContainText('不参与搜索');

    // The empty state repeats the reason, so "nothing found" is not ambiguous.
    await page.getByTestId('global-search-input').fill('完全不存在的内容xyz');
    await expect(page.getByTestId('search-coverage-empty')).toContainText('不参与搜索');
  });

  test('分组显示真实总数，超出的条目会说明还有多少', async ({ page }) => {
    const manyNotes = Array.from({ length: 8 }, (_, i) => ({
      id: `n${i}`,
      title: `性能笔记 ${i}`,
      content: `这段正文都提到 qwerty 这个词（第 ${i} 篇）。`,
      updatedAt: 1
    }));
    await seedState(page, state({ notes: manyNotes }));
    await page.goto('/');
    await openSearch(page);

    await page.getByTestId('global-search-input').fill('qwerty');
    const noteGroup = page.locator('[data-search-group="note"]');
    await expect(noteGroup).toBeVisible();
    // Default per-kind limit is 5, and the group says how many are left.
    await expect(page.locator('[data-search-hit="note"]')).toHaveCount(5);
    await expect(page.locator('[data-search-more="note"]')).toContainText('还有 3 条');

    // Switching to the group shows all of them.
    await page.locator('[data-search-chip="note"]').click();
    await expect(page.locator('[data-search-hit="note"]')).toHaveCount(8);
  });
});
