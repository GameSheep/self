import { test, expect } from '@playwright/test';
import { seedState, baseState, readState } from './helpers';

/**
 * P1-07 (simplified 2026-10) — check-in records without automation.
 *
 * The app no longer fires HTTP requests: the two user gestures are
 * 「打开网站」 (recorded as `opened_page`, never a success, never a streak day)
 * and 「标记今天已签」 (the user's own confirmation, recorded as the day's
 * success). Automatic execution is gone entirely: loading the page must not
 * touch the network.
 */

const HOST = 'checkin.test';

function task(overrides: Record<string, unknown> = {}) {
  return {
    id: 'c-open',
    name: '手动签到站点',
    url: `http://${HOST}/page`,
    method: 'GET',
    type: 'redirect',
    streakDays: 0,
    createdAt: Date.now(),
    ...overrides
  };
}

test.describe('签到网站：打开与手动标记的区别', () => {
  test.beforeEach(async ({ page }) => {
    page.on('dialog', (d) => d.accept());
  });

  test('打开网站只记录 opened_page，不算成功也不加连续天数', async ({ page }) => {
    await seedState(page, baseState({ checkIns: [task()] }));
    await page.goto('/#/tools/checkins');

    const card = page.getByTestId('checkin-open-page-c-open');
    await expect(card).toBeVisible();
    await card.click();

    await expect.poll(async () => (await readState(page)).checkIns[0].lastOutcome, { timeout: 10_000 }).toBe('opened_page');

    const stored = (await readState(page)).checkIns[0];
    expect(stored.lastStatus, '打开页面不得被记为成功').not.toBe('success');
    expect(stored.history).toHaveLength(1);
    expect(stored.history[0].status).toBe('failed');
    expect(stored.history[0].outcome).toBe('opened_page');
    expect(stored.streakDays ?? 0, '打开页面不得增加连续天数').toBe(0);

    // The card says so in words, not only in colour.
    await expect(page.getByTestId('checkin-last-result-c-open')).toContainText('已打开签到页面');
    await expect(page.getByTestId('checkin-streak')).toContainText('连续 0 天');
  });

  test('标记今天已签记为成功并计入连续天数', async ({ page }) => {
    await seedState(page, baseState({ checkIns: [task({ id: 'c-mark' })] }));
    await page.goto('/#/tools/checkins');

    await page.getByTestId('checkin-mark-done-c-mark').click();
    await expect.poll(async () => (await readState(page)).checkIns[0].lastOutcome, { timeout: 10_000 }).toBe('http_success');

    const stored = (await readState(page)).checkIns[0];
    expect(stored.lastStatus).toBe('success');
    expect(stored.history).toHaveLength(1);
    expect(stored.history[0].status).toBe('success');
    expect(stored.streakDays).toBe(1);
    await expect(page.getByTestId('checkin-streak')).toContainText('连续 1 天');
    await expect(page.getByTestId('checkin-last-result-c-mark')).toContainText('手动标记');
  });

  test('标记后按钮变已签（同一天重复标记由每日记录去重）', async ({ page }) => {
    await seedState(page, baseState({ checkIns: [task({ id: 'c-mark' })] }));
    await page.goto('/#/tools/checkins');

    const mark = page.getByTestId('checkin-mark-done-c-mark');
    await expect(mark).toBeVisible();
    await mark.click();
    await expect(mark, '当天已标记后按钮禁用，避免误以为还能再签').toBeDisabled({ timeout: 10_000 });

    // And the status pill flipped to 今日已签.
    await expect(page.getByTestId('checkins-view')).toContainText('今日已签');
  });

  test('打开应用不会替用户签到（无自动执行）', async ({ page }) => {
    let requests = 0;
    await page.route(`http://${HOST}/**`, (route: any) => {
      requests++;
      return route.fulfill({ status: 200, body: '{}' });
    });

    await seedState(page, baseState({ checkIns: [task({ id: 'c-auto' })] }));
    await page.goto('/#/tools/checkins');
    await page.waitForTimeout(1500);

    expect(requests, '加载页面不得自动发起任何签到请求').toBe(0);
    const stored = (await readState(page)).checkIns[0];
    expect(stored.lastOutcome).toBeUndefined();
    expect(stored.history ?? []).toHaveLength(0);
    expect(stored.streakDays ?? 0).toBe(0);
  });
});
