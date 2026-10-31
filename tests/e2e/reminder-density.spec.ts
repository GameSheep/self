import { test, expect, type Page } from '@playwright/test';
import { baseState, gotoTab, seedState } from './helpers';

/**
 * 提醒密度。
 *
 * 提醒和收件箱、网页批注是同一类列表：只进不出（到期续期只会再攒），但旧版
 * 一条是一张 `p-4` 卡片——标题行 + 到期块 + 说明 + 历史 + 按钮行，200px 上下，
 * 三列一屏六条。来这个页面的目的是"扫一遍什么快到期了"，密度不该是滚动距离。
 *
 * 现在一条一行：标题为主信息，周期锚定 + 备注至多一行，右侧金额 / 到期日 /
 * 状态 pill；完成 / 续期常显（这是页面的主操作），编辑 / 删除悬停浮现，
 * 处理记录折叠在「历史」后面。这组用例锁密度和"窄屏不把标题挤没"。
 */
const DAY = 24 * 60 * 60 * 1000;

function reminders(count: number) {
  const now = Date.now();
  return Array.from({ length: count }, (_, i) => {
    // 前 8 条逾期，接着 12 条 7 天内，其余更远：三个分组都有内容，也覆盖
    // 「今天到期」这种边界文案（i = 8 时 targetDate 正好是今天）。
    const targetDate = i < 8 ? now - (i + 1) * DAY : i < 20 ? now + (i - 8) * DAY : now + (i - 12) * DAY;
    return {
      id: `rem-${i}`,
      title: `第 ${i + 1} 项：ChatGPT Plus / 阿里云 / 域名续费之类的长标题，用来验证单行截断`,
      category: (['subscription', 'server', 'domain', 'cert', 'other'] as const)[i % 5],
      targetDate,
      recurring: i % 2 ? 'monthly' : 'yearly',
      anchorDay: new Date(targetDate).getDate(),
      autoRollover: i % 3 === 0,
      cost: i % 4 === 0 ? '$20/月' : undefined,
      // 一半有备注：行高会因此不同，但不该因此变回卡片。
      notes: i % 2 === 0 ? `第 ${i + 1} 条备忘：绑定了外币卡扣款，扣款前查一下额度。` : undefined,
      // 四分之一带处理记录：折叠时行高必须和不带的完全一样。
      occurrences:
        i % 4 === 1
          ? [{ at: now - 30 * DAY, dueAt: now - 30 * DAY, action: 'renewed' as const, nextDueAt: targetDate }]
          : undefined,
      completed: false,
      createdAt: now - 200 * DAY
    };
  });
}

async function rowStats(page: Page) {
  return page.getByTestId(/reminder-row-rem-/).evaluateAll((els) =>
    els.reduce(
      (acc, el) => {
        const box = el.getBoundingClientRect();
        acc.max = Math.max(acc.max, box.height);
        if (box.top >= 0 && box.bottom <= window.innerHeight) acc.visible += 1;
        return acc;
      },
      { max: 0, visible: 0 }
    )
  );
}

test.describe('提醒密度：一条提醒一行', () => {
  // 同 inbox/annotation-density：顶层 1440×900 会被 `devices['Desktop Chrome']`
  // 的 1280×720 盖掉，而"一屏能看几条"必须钉在真实桌面高度上。
  test.use({ viewport: { width: 1440, height: 900 } });

  test('30 条提醒一屏能看到 12 条以上，每行不超过 60px', async ({ page }) => {
    await seedState(page, baseState({ reminders: reminders(30) }));
    await gotoTab(page, '提醒');

    const rows = page.getByTestId(/reminder-row-rem-/);
    await expect(rows).toHaveCount(30);

    const stats = await rowStats(page);
    // 60px：两行（标题 + 锚定/备注）也够；再高说明又退回卡片了。
    expect(stats.max, `行高 ${stats.max}px，超过 60px 说明提醒又变成卡片了`).toBeLessThan(60);
    // 旧版三列卡片一屏 6 条；12 是下限，实测留了余量。
    expect(stats.visible, '1440×900 一屏应至少看到 12 条').toBeGreaterThanOrEqual(12);
  });

  test('很长的标题和备注只截断，不把行撑开', async ({ page }) => {
    const long = '这是一个特别特别长的提醒标题，'.repeat(30);
    await seedState(
      page,
      baseState({
        reminders: [
          {
            id: 'long-1',
            title: long,
            category: 'subscription',
            targetDate: Date.now() + 3 * DAY,
            recurring: 'monthly',
            notes: '很长的备忘，'.repeat(80),
            completed: false,
            createdAt: Date.now()
          }
        ]
      })
    );
    await gotoTab(page, '提醒');

    const row = page.getByTestId('reminder-row-long-1');
    await expect(row).toBeVisible();
    expect((await row.boundingBox())!.height).toBeLessThan(60);

    const clipped = await page.getByTestId('reminder-row-text-long-1').evaluate((el) => {
      const [title, meta] = [el.children[0], el.children[1]] as [HTMLElement, HTMLElement];
      const titleSpan = title.querySelector('span:nth-child(2)') as HTMLElement;
      const metaSpan = meta.querySelector('span.truncate') as HTMLElement | null;
      return {
        titleOverflow: titleSpan.scrollWidth > titleSpan.clientWidth,
        notesOverflow: metaSpan ? metaSpan.scrollWidth > metaSpan.clientWidth : null
      };
    });
    expect(clipped.titleOverflow, '长标题应被截断').toBe(true);
    expect(clipped.notesOverflow, '长备注应被截断').toBe(true);
  });

  test('编辑/删除悬停才出现，出现时行高不变（不抖）', async ({ page }) => {
    await seedState(page, baseState({ reminders: reminders(3) }));
    await gotoTab(page, '提醒');

    const row = page.getByTestId('reminder-row-rem-0');
    const edit = page.getByTestId('reminder-edit-rem-0');
    const heightBefore = (await row.boundingBox())!.height;
    expect(await edit.evaluate((el) => getComputedStyle(el).opacity)).toBe('0');

    await row.hover();
    await expect.poll(() => edit.evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
    const heightAfter = (await row.boundingBox())!.height;

    expect(Math.abs(heightAfter - heightBefore)).toBeLessThan(1);
  });

  test('历史默认折叠；展开后能看到处理记录，收起后行高还原', async ({ page }) => {
    await seedState(page, baseState({ reminders: reminders(3) }));
    await gotoTab(page, '提醒');

    const row = page.getByTestId('reminder-row-rem-1');
    const history = page.getByTestId('reminder-history-rem-1');
    const list = page.getByTestId('reminder-occurrences-rem-1');

    // 折叠时行高与无历史的行一致；记录在 DOM 里（recurrence spec 按它断言）。
    const heightBefore = (await row.boundingBox())!.height;
    await expect(list).toBeHidden();

    await history.click();
    await expect(list).toBeVisible();
    await expect(list.locator('[data-action="renewed"]')).toHaveCount(1);
    const heightOpen = (await row.boundingBox())!.height;
    expect(heightOpen).toBeGreaterThan(heightBefore);

    await history.click();
    await expect(list).toBeHidden();
    expect(Math.abs((await row.boundingBox())!.height - heightBefore)).toBeLessThan(1);
  });

  test('320px 下标题仍然可读，操作折到下一行而不是挤掉标题', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 720 });
    await seedState(page, baseState({ reminders: reminders(8) }));
    await gotoTab(page, '提醒');

    const row = page.getByTestId('reminder-row-rem-0');
    await expect(row).toBeVisible();

    const textWidth = (await page.getByTestId('reminder-row-text-rem-0').boundingBox())!.width;
    // 旧版三列网格在 320px 只剩一列卡片还能看；行版必须保证标题区不被挤没。
    expect(textWidth, `窄屏标题区只有 ${textWidth}px 宽`).toBeGreaterThan(140);

    const box = (await row.boundingBox())!;
    expect(box.height).toBeGreaterThan(50);
    expect(box.height).toBeLessThan(130);

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
