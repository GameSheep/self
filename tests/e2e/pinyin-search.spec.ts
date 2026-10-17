import { test, expect } from '@playwright/test';
import { seedState, baseState } from './helpers';

/**
 * Pinyin initial search.
 *
 * The previous table had 62 hand-written characters, so "rmkj" (热门科技) could not
 * find anything. It now covers the 6763 GB2312 hanzi.
 */

function state(overrides: Record<string, unknown> = {}) {
  return baseState(overrides);
}

/** Search through the Ctrl+K palette and return the result titles. */
async function search(page: any, query: string) {
  await page.keyboard.press('Control+k');
  await page.waitForTimeout(300);
  await page.keyboard.type(query);
  await page.waitForTimeout(500);
  const text = await page.locator('body').innerText();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  return text;
}

test.describe('拼音首字母检索', () => {
  test.beforeEach(async ({ page }) => {
    page.on('dialog', (d) => d.accept());
  });

  test('rmkj 能找到「热门科技」', async ({ page }) => {
    await seedState(
      page,
      state({
        sites: [
          {
            id: 's1',
            title: '热门科技资讯',
            url: 'https://example.com',
            category: '知识资讯',
            pinned: false,
            visitCount: 0,
            createdAt: Date.now()
          }
        ]
      })
    );
    await page.goto('/');
    const body = await search(page, 'rmkj');
    expect(body).toContain('热门科技资讯');
  });

  test('多个不同首字母都能命中（覆盖旧表完全没有的字）', async ({ page }) => {
    await seedState(
      page,
      state({
        sites: [
          { id: 's1', title: '阿里云服务器', url: 'https://a.com', category: '运维部署', pinned: false, visitCount: 0, createdAt: 1 },
          { id: 's2', title: '深度知识文档', url: 'https://b.com', category: '知识资讯', pinned: false, visitCount: 0, createdAt: 2 },
          { id: 's3', title: '加密安全金库', url: 'https://c.com', category: '常用工具', pinned: false, visitCount: 0, createdAt: 3 }
        ]
      })
    );
    await page.goto('/');

    // a l y f w q  (阿里云服务器)
    expect(await search(page, 'alyfwq')).toContain('阿里云服务器');
    // s d z s w d  (深度知识文档)
    expect(await search(page, 'sdzswd')).toContain('深度知识文档');
    // j m a q j k  (加密安全金库)
    expect(await search(page, 'jmaqjk')).toContain('加密安全金库');
  });

  test('中英混排时英文部分按原样参与匹配', async ({ page }) => {
    await seedState(
      page,
      state({
        sites: [
          { id: 's1', title: 'GitHub 代码托管', url: 'https://github.com', category: '技术开发', pinned: false, visitCount: 0, createdAt: 1 }
        ]
      })
    );
    await page.goto('/');
    // g h + d m t g (代码托管)
    expect(await search(page, 'ghdmtg')).toContain('GitHub 代码托管');
  });

  test('拼音命中不会让无关内容混进结果', async ({ page }) => {
    await seedState(
      page,
      state({
        sites: [
          { id: 's1', title: '热门科技资讯', url: 'https://a.com', category: '知识资讯', pinned: false, visitCount: 0, createdAt: 1 },
          { id: 's2', title: '每日食谱', url: 'https://b.com', category: '日常资讯', pinned: false, visitCount: 0, createdAt: 2 }
        ]
      })
    );
    await page.goto('/');
    await page.keyboard.press('Control+k');
    await page.waitForTimeout(300);
    await page.keyboard.type('rmkj');
    await page.waitForTimeout(500);
    // Scope to the palette: the dashboard behind it also lists sites.
    const results = await page.getByTestId('global-search-results').innerText();
    expect(results).toContain('热门科技资讯');
    expect(results).not.toContain('每日食谱');
    await page.keyboard.press('Escape');
  });
});

