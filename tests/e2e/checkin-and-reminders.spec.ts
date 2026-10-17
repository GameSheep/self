import { test, expect } from '@playwright/test';
import { seedState, baseState, readState } from './helpers';

/**
 * Check-in daily records and reminder notifications.
 *
 * Previously `streakDays` incremented on every click (two clicks in one day = two
 * days) and there was no per-day record. Reminders never notified at all.
 */

const ENDPOINT = 'ok.example.com';

function localDateKey(offsetDays = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function mockCheckIn(page: any) {
  await page.route('**/*', async (route) => {
    const url = route.request().url();
    if (!url.includes(ENDPOINT)) {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ code: 0, msg: 'ok' })
    });
  });
}

test.describe('签到按日记录', () => {
  test.beforeEach(async ({ page }) => {
    page.on('dialog', (d) => d.accept());
    await mockCheckIn(page);
  });

  test('同一天重复签到不会把连续天数算两次', async ({ page }) => {
    await seedState(
      page,
      baseState({
        checkIns: [
          {
            id: 'c1',
            name: '每日签到',
            url: `https://${ENDPOINT}/checkin`,
            method: 'GET',
            type: 'http',
            streakDays: 0,
            createdAt: Date.now()
          }
        ]
      })
    );
    await page.goto('/');
    await page.locator('nav button', { hasText: '自动化与打卡' }).click();

    await page.locator('button', { hasText: '立即签到' }).click();
    await expect(page.getByTestId('checkin-streak')).toContainText('连续 1 天', { timeout: 15_000 });

    // Same day, second run.
    await page.locator('button', { hasText: '立即签到' }).click();
    await page.waitForTimeout(2500);
    await expect(page.getByTestId('checkin-streak')).toContainText('连续 1 天');

    const state = await readState(page);
    const task = (state as any).checkIns[0];
    expect(task.history).toHaveLength(1);
    expect(task.history[0].date).toBe(localDateKey(0));
    expect(task.history[0].status).toBe('success');
  });

  test('近 14 天记录反映实际状态', async ({ page }) => {
    await seedState(
      page,
      baseState({
        checkIns: [
          {
            id: 'c1',
            name: '历史签到',
            url: `https://${ENDPOINT}/checkin`,
            method: 'GET',
            type: 'http',
            streakDays: 2,
            history: [
              { date: localDateKey(-1), at: Date.now() - 86400000, status: 'success', message: 'ok' },
              { date: localDateKey(-3), at: Date.now() - 3 * 86400000, status: 'failed', message: '失败' }
            ],
            createdAt: Date.now()
          }
        ]
      })
    );
    await page.goto('/');
    await page.locator('nav button', { hasText: '自动化与打卡' }).click();

    const cells = page.getByTestId('checkin-history').locator('[data-day]');
    await expect(cells).toHaveCount(14);
    await expect(page.locator(`[data-day="${localDateKey(-1)}"]`)).toHaveAttribute('data-status', 'success');
    await expect(page.locator(`[data-day="${localDateKey(-3)}"]`)).toHaveAttribute('data-status', 'failed');
    await expect(page.locator(`[data-day="${localDateKey(0)}"]`)).toHaveAttribute('data-status', 'none');
  });

  test('昨天签过、今天没签，连续天数仍然有效', async ({ page }) => {
    await seedState(
      page,
      baseState({
        checkIns: [
          {
            id: 'c1',
            name: '跨天',
            url: `https://${ENDPOINT}/checkin`,
            method: 'GET',
            type: 'http',
            history: [
              { date: localDateKey(-1), at: Date.now() - 86400000, status: 'success', message: 'ok' },
              { date: localDateKey(-2), at: Date.now() - 2 * 86400000, status: 'success', message: 'ok' }
            ],
            createdAt: Date.now()
          }
        ]
      })
    );
    await page.goto('/');
    await page.locator('nav button', { hasText: '自动化与打卡' }).click();
    await expect(page.getByTestId('checkin-streak')).toContainText('连续 2 天');
  });
});

test.describe('到期提醒通知', () => {
  test.beforeEach(async ({ page }) => {
    page.on('dialog', (d) => d.accept());
  });

  /** Replace the Notification API so we can observe what would be shown. */
  async function stubNotifications(page: any, permission: 'granted' | 'default' | 'denied') {
    await page.addInitScript(`
      window.__notifications = window.__notifications || [];
      class FakeNotification {
        static permission = '${permission}';
        static requestPermission() { FakeNotification.permission = 'granted'; return Promise.resolve('granted'); }
        constructor(title, options) {
          window.__notifications.push({ title, body: (options && options.body) || '', tag: (options && options.tag) || '' });
        }
      }
      Object.defineProperty(window, 'Notification', { value: FakeNotification, writable: true, configurable: true });
    `);
  }

  function dueState() {
    return baseState({
      reminders: [
        {
          id: 'r-today',
          title: '今天到期的订阅',
          category: 'subscription',
          targetDate: new Date().setHours(12, 0, 0, 0),
          recurring: 'monthly',
          cost: '¥199/年',
          completed: false,
          createdAt: Date.now()
        },
        {
          id: 'r-far',
          title: '很久以后',
          category: 'other',
          targetDate: Date.now() + 60 * 86400000,
          recurring: 'once',
          completed: false,
          createdAt: Date.now()
        }
      ]
    });
  }

  test('已授权时会为到期项推送系统通知', async ({ page }) => {
    await stubNotifications(page, 'granted');
    await seedState(page, dueState());
    await page.goto('/');
    await page.waitForTimeout(1500);

    const notes = await page.evaluate(() => (window as any).__notifications || []);
    expect(notes.length).toBe(1);
    expect(notes[0].title).toContain('Self-Hub');
    expect(notes[0].body).toContain('今天到期的订阅');
  });

  test('同一天刷新不会重复轰炸', async ({ page }) => {
    await stubNotifications(page, 'granted');
    await seedState(page, dueState());
    await page.goto('/');
    await page.waitForTimeout(1200);
    const first = await page.evaluate(() => (window as any).__notifications.length);
    expect(first).toBe(1);

    await page.reload();
    await page.waitForTimeout(1200);
    // The counter restarts with the new document, so "no repeat" means zero here.
    const after = await page.evaluate(() => (window as any).__notifications.length);
    expect(after, '同一天第二次打开不应再通知').toBe(0);
  });

  test('未授权时不推送，提醒页给出开启入口', async ({ page }) => {
    await stubNotifications(page, 'default');
    await seedState(page, dueState());
    await page.goto('/');
    await page.locator('nav button', { hasText: '倒计时与续费' }).click();

    await expect(page.locator('button', { hasText: '开启到期提醒' })).toBeVisible();
    const notes = await page.evaluate(() => (window as any).__notifications || []);
    expect(notes).toHaveLength(0);

    await page.locator('button', { hasText: '开启到期提醒' }).click();
    await expect(page.getByText('到期提醒已开启')).toBeVisible({ timeout: 10_000 });
  });

  test('已完成或远期提醒不通知', async ({ page }) => {
    await stubNotifications(page, 'granted');
    const state = dueState();
    state.reminders[0].completed = true;
    await seedState(page, state);
    await page.goto('/');
    await page.waitForTimeout(1200);

    const notes = await page.evaluate(() => (window as any).__notifications || []);
    expect(notes).toHaveLength(0);
  });
});

test.describe('扩展后台提醒桥接', () => {
  test.beforeEach(async ({ page }) => {
    page.on('dialog', (d) => d.accept());
  });

  /** Pretend to be an extension page: chrome.storage + runtime.sendMessage. */
  async function stubChrome(page: any) {
    await page.addInitScript(`
      window.__messages = [];
      window.__stored = {};
      window.chrome = {
        storage: { local: { set(items, cb) {
          Object.assign(window.__stored, items);
          if (cb) cb();
        } } },
        runtime: {
          id: 'test-extension-id',
          lastError: null,
          sendMessage(message, cb) {
            window.__messages.push(message);
            if (cb) cb({ success: true });
          }
        }
      };
      window.__notifications = [];
      class FakeNotification {
        static permission = 'granted';
        constructor(title, options) { window.__notifications.push({ title, body: (options||{}).body }); }
      }
      Object.defineProperty(window, 'Notification', { value: FakeNotification, writable: true, configurable: true });
    `);
  }

  test('提醒会发布给后台 worker，而不是只在页面里提醒', async ({ page }) => {
    await stubChrome(page);
    await seedState(
      page,
      baseState({
        reminders: [
          {
            id: 'r1',
            title: '年费续订',
            category: 'subscription',
            targetDate: Date.now() + 2 * 86400000,
            recurring: 'yearly',
            cost: '¥99/年',
            completed: false,
            createdAt: Date.now()
          }
        ]
      })
    );
    await page.goto('/');
    await page.waitForTimeout(1200);

    const messages = await page.evaluate(() => (window as any).__messages || []);
    const publish = messages.find((m: any) => m.action === 'PUBLISH_REMINDERS');
    expect(publish, '应向后台发送 PUBLISH_REMINDERS').toBeTruthy();
    expect(publish.reminders).toHaveLength(1);
    expect(publish.reminders[0]).toMatchObject({ id: 'r1', title: '年费续订', completed: false });

    // Inside the extension the worker owns notifications; the page must not
    // duplicate them.
    const notes = await page.evaluate(() => (window as any).__notifications || []);
    expect(notes, '扩展环境不应由页面重复通知').toHaveLength(0);
  });

  test('普通网页环境下不会误发扩展消息', async ({ page }) => {
    await seedState(page, baseState({ reminders: [] }));
    await page.goto('/');
    await page.waitForTimeout(800);
    const hasChromeRuntime = await page.evaluate(() =>
      Boolean((window as any).chrome && (window as any).chrome.runtime && (window as any).chrome.runtime.id)
    );
    expect(hasChromeRuntime).toBe(false);
  });
});

