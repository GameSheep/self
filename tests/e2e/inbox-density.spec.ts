import { test, expect, type Page } from '@playwright/test';
import { baseState, gotoTab, seedState } from './helpers';

/**
 * 收件箱密度。
 *
 * 用户原话：「这里块头这么大，将来多了岂不是很不好显示，重新设计一下」。
 *
 * 旧版每条是一张 `p-4` 的卡片（徽章行 + 正文块 + 一整行按钮），200–350px 一条，
 * 900px 高的屏幕只放得下两三条。而这个页面**每天都会多几条**，所以它在变长之前
 * 就已经读不动了 —— 卡片的尺寸是常量，条目数量是变量，两者的比例迟早要失控。
 *
 * 现在一行就是一行：类型图标 + 摘要（单行截断）+ 至多一行次要信息 + 时间，
 * 操作在悬停时才浮现。这组用例锁住的是密度本身，不是具体像素：
 * 行高上限、一屏条数、长内容不撑开、窄屏不把正文挤没。
 */
function backlog(count: number) {
  const now = Date.now();
  return Array.from({ length: count }, (_, i) => {
    const isUrl = i % 3 === 0;
    return {
      id: `dense-${i}`,
      content: isUrl
        ? `https://example.com/article/${i}?from=inbox`
        : `第 ${i + 1} 条速记：这是一段比较长的内容，用来验证一行不会被撑开，也不会折成三行。`,
      title: isUrl ? `示例文章 ${i}` : undefined,
      url: isUrl ? `https://example.com/article/${i}` : undefined,
      type: isUrl ? 'url' : 'text',
      status: 'inbox',
      createdAt: now - i * 60_000
    };
  });
}

/** 视口内完整可见的行数，以及行高区间。 */
async function rowStats(page: Page) {
  return page.getByTestId('inbox-row').evaluateAll((els) =>
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

test.describe('收件箱密度：一行就是一行', () => {
  // 顶层 use 的 1440×900 会被 `devices['Desktop Chrome']` 的 1280×720 盖掉，
  // 而"一屏能看几条"必须钉在真实桌面高度上，所以这里显式声明一次。
  test.use({ viewport: { width: 1440, height: 900 } });

  test('30 条待整理一屏能看到 10 条以上，每行不超过 60px', async ({ page }) => {
    await seedState(page, baseState({ inbox: backlog(30) }));
    await gotoTab(page, '统一收件箱');

    const rows = page.getByTestId('inbox-row');
    await expect(rows).toHaveCount(30);

    const stats = await rowStats(page);
    // 60px 的上限：两行（标题 + 链接/正文）也够，再高就说明又退回卡片了。
    expect(stats.max, `行高 ${stats.max}px，超过 60px 说明条目又变成卡片了`).toBeLessThan(60);
    // 旧版一屏 2–3 条；这里 9 是下限，实际 10，留一条余量给字体/间距微调。
    expect(stats.visible, '1440×900 一屏应至少看到 9 条').toBeGreaterThanOrEqual(9);
  });

  test('两千字的正文只截断，不把行撑开', async ({ page }) => {
    const long = '这是一段很长的速记内容，'.repeat(120);
    await seedState(
      page,
      baseState({
        inbox: [
          { id: 'long-1', content: long, type: 'text', status: 'inbox', createdAt: Date.now() }
        ]
      })
    );
    await gotoTab(page, '统一收件箱');

    const row = page.getByTestId('inbox-row').first();
    await expect(row).toBeVisible();
    const box = (await row.boundingBox())!;
    expect(box.height).toBeLessThan(60);

    // 被截断的证据：文本溢出了容器宽度，且计算样式是 ellipsis。
    const text = page.getByTestId('inbox-row-text').first();
    const clipped = await text.evaluate((el) => {
      const p = el.querySelector('p') as HTMLElement | null;
      if (!p) return null;
      return {
        overflow: getComputedStyle(p).textOverflow,
        overflowing: p.scrollWidth > p.clientWidth
      };
    });
    expect(clipped).not.toBeNull();
    expect(clipped!.overflow).toBe('ellipsis');
    expect(clipped!.overflowing).toBe(true);
  });

  test('操作按钮悬停才出现，出现时行高不变（不抖）', async ({ page }) => {
    await seedState(page, baseState({ inbox: backlog(5) }));
    await gotoTab(page, '统一收件箱');

    const row = page.getByTestId('inbox-row').first();
    const actions = page.getByTestId('inbox-row-actions').first();
    const heightBefore = (await row.boundingBox())!.height;
    expect(await actions.evaluate((el) => getComputedStyle(el).opacity)).toBe('0');

    await row.hover();
    await expect.poll(() => actions.evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
    const heightAfter = (await row.boundingBox())!.height;

    // 只改 opacity 不改布局，所以悬停不该让行高变化 —— 变了就是整列在跳。
    expect(Math.abs(heightAfter - heightBefore)).toBeLessThan(1);
  });

  test('320px 下正文仍然可读，操作行折到第二行而不是挤掉摘要', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 720 });
    await seedState(page, baseState({ inbox: backlog(8) }));
    await gotoTab(page, '统一收件箱');

    const row = page.getByTestId('inbox-row').first();
    await expect(row).toBeVisible();

    const textWidth = (await page.getByTestId('inbox-row-text').first().boundingBox())!.width;
    // 旧版把摘要压成「第 2 …」——不到 60px。现在操作行换行，正文至少半屏宽。
    expect(textWidth, `窄屏正文只有 ${textWidth}px 宽`).toBeGreaterThan(140);

    // 折行的代价是行变高，但仍有上限（图标行 + 操作行）。
    const box = (await row.boundingBox())!;
    expect(box.height).toBeGreaterThan(60);
    expect(box.height).toBeLessThan(110);

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth
    );
    expect(overflow).toBeLessThanOrEqual(0);

    // 批量按钮带 `whitespace-nowrap`：容器不换行的话，**最后一个**会被卡片裁掉，
    // 而页面级的 scrollWidth 断言看不出来（卡片自己 clip 了）。所以量卡片里所有
    // 按钮的最大右边界，而不是只看第一个。
    const overhang = await page.getByTestId('inbox-batch-note').evaluate((el) => {
      const card = el.closest('.rounded-2xl') as HTMLElement | null;
      if (!card) return Number.POSITIVE_INFINITY;
      const limit = card.getBoundingClientRect().right;
      return Array.from(card.querySelectorAll('button')).reduce(
        (max, btn) => Math.max(max, btn.getBoundingClientRect().right - limit),
        Number.NEGATIVE_INFINITY
      );
    });
    expect(overhang, `有按钮超出卡片右边缘 ${overhang}px`).toBeLessThanOrEqual(1);
  });
});
