import { test, expect, type Page } from '@playwright/test';
import { baseState, gotoTab, seedState } from './helpers';

/** 网页批注密度：一条划词一两行，原文荧光底 + 域名小字 + 悬停操作。 */
function highlights(count: number) {
  const now = Date.now();
  return Array.from({ length: count }, (_, i) => ({
    id: `anno-${i}`,
    pageUrl: `https://example.com/post/${i}`,
    pageTitle: `第 ${i + 1} 篇：一个很长很长的页面标题，长到如果按标题显示就会占掉半行`,
    text: `第 ${i + 1} 条划词原文：这是一段比较长的内容，用来验证一行不会被撑开，也不会折成三行。`,
    // 一半有批注、一半没有：行高本来就该因此不同，但不该因此变成卡片。
    note: i % 2 === 0 ? `第 ${i + 1} 条我的批注，同样是一段不短的话。` : undefined,
    color: (['yellow', 'green', 'blue', 'purple', 'red'] as const)[i % 5],
    createdAt: now - i * 60_000,
    updatedAt: now - i * 60_000
  }));
}

async function rowStats(page: Page) {
  return page.getByTestId('annotation-row').evaluateAll((els) =>
    els.reduce(
      (acc, el) => {
        const box = el.getBoundingClientRect();
        acc.max = Math.max(acc.max, box.height);
        acc.min = Math.min(acc.min, box.height);
        if (box.top >= 0 && box.bottom <= window.innerHeight) acc.visible += 1;
        return acc;
      },
      { min: Number.POSITIVE_INFINITY, max: 0, visible: 0 }
    )
  );
}

test.describe('网页批注密度：一条划词一行', () => {
  // 同 inbox-density：顶层 1440×900 会被 `devices['Desktop Chrome']` 的 1280×720
  // 盖掉，而"一屏能看几条"必须钉在真实桌面高度上。
  test.use({ viewport: { width: 1440, height: 900 } });

  test('30 条批注一屏能看到 12 条以上，每行不超过 60px', async ({ page }) => {
    await seedState(page, baseState({ annotations: highlights(30) }));
    await gotoTab(page, '网页批注');

    const rows = page.getByTestId('annotation-row');
    await expect(rows).toHaveCount(30);

    const stats = await rowStats(page);
    // 60px 的上限：两行（原文 + 批注）也够；再高说明又退回卡片了。
    expect(stats.max, `行高 ${stats.max}px，超过 60px 说明批注又变成卡片了`).toBeLessThan(60);
    // 旧版一屏 4–5 条；这里 12 是下限，实际 15，留余量给字体/间距微调。
    expect(stats.visible, '1440×900 一屏应至少看到 12 条').toBeGreaterThanOrEqual(12);
  });

  test('很长的划词原文只截断，不把行撑开', async ({ page }) => {
    const long = '这是一段很长的划词原文，'.repeat(120);
    await seedState(
      page,
      baseState({
        annotations: [
          {
            id: 'long-1',
            pageUrl: 'https://example.com/long',
            pageTitle: '长文',
            text: long,
            color: 'yellow',
            createdAt: Date.now(),
            updatedAt: Date.now()
          }
        ]
      })
    );
    await gotoTab(page, '网页批注');

    const row = page.getByTestId('annotation-row').first();
    await expect(row).toBeVisible();
    expect((await row.boundingBox())!.height).toBeLessThan(45);

    const clipped = await page.getByTestId('annotation-row-text').first().evaluate((el) => {
      const p = el.querySelector('p') as HTMLElement | null;
      if (!p) return null;
      return { overflow: getComputedStyle(p).textOverflow, overflowing: p.scrollWidth > p.clientWidth };
    });
    expect(clipped).not.toBeNull();
    expect(clipped!.overflow).toBe('ellipsis');
    expect(clipped!.overflowing).toBe(true);
  });

  test('编辑/删除悬停才出现，出现时行高不变（不抖）', async ({ page }) => {
    await seedState(page, baseState({ annotations: highlights(5) }));
    await gotoTab(page, '网页批注');

    const row = page.getByTestId('annotation-row').first();
    const actions = page.getByTestId('annotation-row-actions').first();
    const heightBefore = (await row.boundingBox())!.height;
    expect(await actions.evaluate((el) => getComputedStyle(el).opacity)).toBe('0');

    await row.hover();
    await expect.poll(() => actions.evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
    const heightAfter = (await row.boundingBox())!.height;

    expect(Math.abs(heightAfter - heightBefore)).toBeLessThan(1);
  });

  test('320px 下原文仍然可读，操作行折到第二行而不是挤掉原文', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 720 });
    await seedState(page, baseState({ annotations: highlights(8) }));
    await gotoTab(page, '网页批注');

    const row = page.getByTestId('annotation-row').first();
    await expect(row).toBeVisible();

    const textWidth = (await page.getByTestId('annotation-row-text').first().boundingBox())!.width;
    // 旧版把标题、链接、按钮全挤在一行，正文只剩几十像素。现在操作行换行。
    expect(textWidth, `窄屏原文只有 ${textWidth}px 宽`).toBeGreaterThan(140);

    const box = (await row.boundingBox())!;
    expect(box.height).toBeGreaterThan(60);
    expect(box.height).toBeLessThan(110);

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
