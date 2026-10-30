import { test, expect } from '@playwright/test';
import { seedState, baseState, readState } from './helpers';

/**
 * P1-07 — reminder recurrence and list state.
 *
 * The old `src/lib/dates.ts` advanced months with `setMonth(+1)`, so 1 月 31 日
 * renewed to 3 月 3 日. These cases pin the anchored behaviour: the day-of-month
 * is kept, a short month clamps to its last day, and the series returns to the
 * anchor afterwards.
 *
 * Every expectation is derived from the *seeded* timestamp through local date
 * getters, so the spec neither waits on real timers nor depends on the machine's
 * wall clock. `toISOString()` is never used — the app must stay in local time.
 */

const DAY = 24 * 60 * 60 * 1000;

const localMidnight = (y: number, m: number, d: number) => new Date(y, m - 1, d, 0, 0, 0, 0).getTime();

const localDateKey = (ts: number) => {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/** Last day of a local month, computed independently of the app's helper. */
const lastDayOf = (y: number, monthIndex: number) => new Date(y, monthIndex + 1, 0).getDate();

/** The app's monthly rule, re-implemented here so the assertion is not a tautology. */
function expectedMonthlyAnchor(base: number, steps: number, anchorDay: number): string {
  const b = new Date(base);
  const d = new Date(b.getFullYear(), b.getMonth() + steps, 1);
  const day = Math.min(anchorDay, lastDayOf(d.getFullYear(), d.getMonth()));
  return localDateKey(new Date(d.getFullYear(), d.getMonth(), day).getTime());
}

/** The last day of a 31-day month, guaranteed to be in the past: 1 月 31 日 last year. */
function lastPast31st(now: number): number {
  return localMidnight(new Date(now).getFullYear() - 1, 1, 31);
}

/** The most recent 2 月 29 日 that is already in the past (leap year). */
function lastPastFeb29(now: number): number {
  const year = new Date(now).getFullYear();
  for (let y = year; y > year - 12; y--) {
    const ts = localMidnight(y, 2, 29);
    if (new Date(ts).getDate() === 29 && ts <= now) return ts;
  }
  return localMidnight(2024, 2, 29);
}

test.describe('提醒：月末与闰年续期', () => {
  test.beforeEach(async ({ page }) => {
    page.on('dialog', (d) => d.accept());
  });

  test('每月 31 日续期先落到短月最后一天，之后回到 31 日', async ({ page }) => {
    // A fixed anchor: 1 月 31 日 of last year. Deterministic, and guarantees the
    // sequence crosses a short month (2 月) before returning to the 31st.
    const seeded = localMidnight(new Date().getFullYear() - 1, 1, 31);
    await seedState(
      page,
      baseState({
        reminders: [
          {
            id: 'r-31',
            title: '每月 31 日续费的服务',
            category: 'subscription',
            targetDate: seeded,
            recurring: 'monthly',
            anchorDay: 31,
            // Auto rollover off: the user renews by hand, so the test observes the
            // date produced by the click instead of a catch-up on mount.
            autoRollover: false,
            completed: false,
            createdAt: seeded - 200 * DAY
          }
        ]
      })
    );
    await page.goto('/#/reminders');

    const card = page.getByTestId('reminder-card-r-31');
    await expect(card).toBeVisible();
    await expect(card).toContainText(localDateKey(seeded));
    // The rule — and *why* the next date is what it is — is visible.
    await expect(card).toContainText('每月 · 锚定 31 日');

    const firstStep = expectedMonthlyAnchor(seeded, 1, 31);
    const secondStep = expectedMonthlyAnchor(seeded, 2, 31);
    // The first step must be a clamped month-end (2 月 28/29 日), not 3 月 3 日.
    expect(new Date(firstStep).getMonth(), '第一步必须落在 2 月').toBe(1);
    expect(new Date(firstStep).getDate()).toBeLessThan(31);
    expect(secondStep.endsWith('-31'), '第二次续期必须回到 31 日').toBe(true);

    await page.getByTestId('reminder-renew-r-31').click();
    await expect(card).toContainText(firstStep);
    expect(localDateKey((await readState(page)).reminders[0].targetDate)).toBe(firstStep);

    // No permanent downward drift: the following cycle is back on the 31st.
    await page.getByTestId('reminder-renew-r-31').click();
    await expect(card).toContainText(secondStep);
    expect(localDateKey((await readState(page)).reminders[0].targetDate)).toBe(secondStep);

    const card2 = page.getByTestId('reminder-card-r-31');
    await expect(card2.locator('[data-action="renewed"]')).toHaveCount(2);
    await expect(card2.locator('[data-action="renewed"]').first()).toContainText(`${firstStep} · 已续期 → ${secondStep}`);
  });

  test('2 月 29 日的按年提醒在非闰年落到 2 月 28 日', async ({ page }) => {
    const seeded = lastPastFeb29(Date.now());
    const baseYear = new Date(seeded).getFullYear();
    await seedState(
      page,
      baseState({
        reminders: [
          {
            id: 'r-leap',
            title: '四年一续的证书',
            category: 'cert',
            targetDate: seeded,
            recurring: 'yearly',
            anchorDay: 29,
            anchorMonth: 1,
            autoRollover: false,
            completed: false,
            createdAt: seeded - 400 * DAY
          }
        ]
      })
    );
    await page.goto('/#/reminders');

    const card = page.getByTestId('reminder-card-r-leap');
    await expect(card).toContainText(localDateKey(seeded));
    await expect(card).toContainText('每年 · 锚定 2 月 29 日');

    const renew = page.getByTestId('reminder-renew-r-leap');

    // Every later non-leap year clamps to 2 月 28 日…
    for (const offset of [1, 2, 3]) {
      await renew.click();
      await expect(card).toContainText(localDateKey(localMidnight(baseYear + offset, 2, 28)));
    }

    // …and the next leap year returns to 2 月 29 日.
    await renew.click();
    const leap = localDateKey(localMidnight(baseYear + 4, 2, 29));
    await expect(card).toContainText(leap);
    expect(new Date(localMidnight(baseYear + 4, 2, 29)).getDate()).toBe(29);
    expect(localDateKey((await readState(page)).reminders[0].targetDate)).toBe(leap);
  });

  test('完成本次不移动日期，重复点击只记录一次', async ({ page }) => {
    const seeded = lastPast31st(Date.now());
    await seedState(
      page,
      baseState({
        reminders: [
          {
            id: 'r-31',
            title: '每月 31 日续费的服务',
            category: 'subscription',
            targetDate: seeded,
            recurring: 'monthly',
            anchorDay: 31,
            autoRollover: false,
            completed: false,
            createdAt: seeded - 200 * DAY
          }
        ]
      })
    );
    await page.goto('/#/reminders');

    const card = page.getByTestId('reminder-card-r-31');
    const complete = page.getByTestId('reminder-complete-r-31');
    await expect(card).toContainText(localDateKey(seeded));

    await complete.click();
    await expect(card.locator('[data-action="completed"]')).toHaveCount(1);
    await expect(card).toContainText(localDateKey(seeded));

    // Clicking 完成本次 twice for the same occurrence must not append a second
    // record. (The button is a toggle, so the second click re-opens the
    // occurrence rather than adding another one.)
    await complete.click();
    await page.waitForTimeout(250);
    await expect(card.locator('[data-action="completed"]')).toHaveCount(0);

    // Mark it done again and assert the persisted constraint directly.
    await complete.click();
    await expect(card.locator('[data-action="completed"]')).toHaveCount(1);

    const stored = (await readState(page)).reminders[0];
    expect(localDateKey(stored.targetDate), '完成本次不得移动到期日').toBe(localDateKey(seeded));
    expect(stored.occurrences.filter((o: any) => o.action === 'completed')).toHaveLength(1);
    expect(stored.occurrences.filter((o: any) => o.dueAt === seeded)).toHaveLength(1);

    // 续期 is a different action: it moves the date and appends its own record.
    await page.getByTestId('reminder-renew-r-31').click();
    const afterRenew = expectedMonthlyAnchor(seeded, 1, 31);
    await expect(card).toContainText(afterRenew);
    const renewed = (await readState(page)).reminders[0];
    expect(localDateKey(renewed.targetDate)).toBe(afterRenew);
    expect(renewed.occurrences.filter((o: any) => o.action === 'renewed')).toHaveLength(1);
  });

  test('分成逾期 / 7 天内 / 之后三组，且之后组不会被隐藏', async ({ page }) => {
    const now = Date.now();
    await seedState(
      page,
      baseState({
        reminders: [
          {
            id: 'r-over',
            title: '已经过期的域名',
            category: 'domain',
            targetDate: now - 3 * DAY,
            recurring: 'yearly',
            autoRollover: false,
            completed: false,
            createdAt: now - 300 * DAY
          },
          {
            id: 'r-today',
            title: '今天到期的订阅',
            category: 'subscription',
            targetDate: now,
            recurring: 'monthly',
            anchorDay: new Date(now).getDate(),
            autoRollover: false,
            completed: false,
            createdAt: now - 30 * DAY
          },
          {
            id: 'r-soon',
            title: '4 天后的服务器',
            category: 'server',
            targetDate: now + 4 * DAY,
            recurring: 'monthly',
            anchorDay: new Date(now + 4 * DAY).getDate(),
            autoRollover: false,
            completed: false,
            createdAt: now - 10 * DAY
          },
          {
            id: 'r-later',
            title: '很久以后才续费',
            category: 'other',
            targetDate: now + 30 * DAY,
            recurring: 'once',
            completed: false,
            createdAt: now - DAY
          }
        ]
      })
    );
    await page.goto('/#/reminders');

    await expect(page.getByTestId('reminder-group-overdue')).toHaveAttribute('data-count', '1');
    await expect(page.getByTestId('reminder-group-within7')).toHaveAttribute('data-count', '2');
    await expect(page.getByTestId('reminder-group-later')).toHaveAttribute('data-count', '1');

    // All three groups render at once — upcoming items are not collapsed away.
    await expect(page.getByTestId('reminder-card-r-over')).toBeVisible();
    await expect(page.getByTestId('reminder-card-r-today')).toBeVisible();
    await expect(page.getByTestId('reminder-card-r-soon')).toBeVisible();
    await expect(page.getByTestId('reminder-card-r-later')).toBeVisible();

    // 完成 and 续期 are separate buttons with different wording.
    await expect(page.getByTestId('reminder-complete-r-today')).toContainText('完成本次');
    await expect(page.getByTestId('reminder-renew-r-today')).toContainText('续期到下期');

    // Notification honesty: a plain page can only remind while it is open, and an
    // un-granted permission must keep the in-page reminder instead of going silent.
    const strip = page.getByTestId('notification-strip');
    await expect(strip).toHaveAttribute('data-mode', 'page-open');
    const stripText = (await strip.innerText()).replace(/\s+/g, '');
    expect(
      stripText.includes('页面打开时') || stripText.includes('保留在本页列表'),
      `通知条必须说明网页版限制，实际为：${stripText}`
    ).toBe(true);
  });

  test('空列表给出下一步，而不是只有“暂无数据”', async ({ page }) => {
    await seedState(page, baseState({ reminders: [] }));
    await page.goto('/#/reminders');

    await expect(page.getByText('还没有任何提醒')).toBeVisible();
    await expect(page.locator('button', { hasText: '新建第一条提醒' })).toBeVisible();
  });
});
