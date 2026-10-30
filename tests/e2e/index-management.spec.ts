import { test, expect } from '@playwright/test';
import { seedState, baseState, gotoTab } from './helpers';

/**
 * Full-text index management.
 *
 * The index lived only in IndexedDB with no UI: if it went bad there was no way
 * to clear or rebuild it short of wiping site data.
 */

const ENDPOINT = 'oss-cn-beijing.aliyuncs.com';
const BUCKET = 'example-obsidian-vault';

const DOCS: Record<string, string> = {
  'vault/alpha.md': '# Alpha\n\n这里记录了 Redis 缓存的使用方式。\n',
  'vault/beta.md': '---\ntags: [infra]\n---\n\n# Beta\n\nKubernetes 维护手册。\n'
};

function listXml(): string {
  const contents = Object.keys(DOCS)
    .map(
      (key) =>
        `<Contents><Key>${key}</Key><LastModified>2026-10-16T12:00:00.000Z</LastModified><ETag>"e-${key}"</ETag><Size>${new Blob([DOCS[key]]).size}</Size></Contents>`
    )
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult><Name>${BUCKET}</Name><MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`;
}

async function mock(page: any) {
  await page.route('**/*', async (route) => {
    const request = route.request();
    if (!request.url().includes(ENDPOINT)) {
      await route.continue();
      return;
    }
    const decoded = decodeURIComponent(request.url());
    const match = Object.keys(DOCS).find((key) => decoded.endsWith(`/${key}`));
    if (request.method() === 'GET' && match) {
      await route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'text/markdown; charset=utf-8', 'Access-Control-Allow-Origin': '*' },
        body: DOCS[match]
      });
      return;
    }
    await route.fulfill({
      status: 200,
      headers: { 'Content-Type': 'application/xml', 'Access-Control-Allow-Origin': '*' },
      body: listXml()
    });
  });
}

function state() {
  return baseState({
    obsidianConfig: {
      enabled: true,
      bucket: BUCKET,
      endpoint: ENDPOINT,
      region: 'oss-cn-beijing',
      accessKeyId: 'LTAI5tEXAMPLE000000000',
      accessKeySecret: 'test-secret',
      prefix: 'vault/'
    }
  });
}

async function boot(page: any) {
  await page.goto('/');
  await gotoTab(page, '多平台数据互通');
  await expect(page.locator('main')).toContainText('对象 2');
}

async function buildIndex(page: any) {
  await page.locator('button', { hasText: '建立索引' }).click();
  await expect(page.locator('main')).toContainText('已索引 2', { timeout: 20_000 });
}

const indexDbCount = (page: any) =>
  page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const req = indexedDB.open('self_hub_vault_index');
        req.onsuccess = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains('docs')) {
            resolve(-1);
            return;
          }
          const tx = db.transaction('docs', 'readonly');
          const count = tx.objectStore('docs').count();
          count.onsuccess = () => resolve(count.result);
          count.onerror = () => resolve(-2);
        };
        req.onerror = () => resolve(-3);
      })
  );

test.describe('全文索引管理', () => {
  test.beforeEach(async ({ page }) => {
    page.on('dialog', (d) => d.accept());
  });

  test('索引面板显示篇数、体积与更新时间', async ({ page }) => {
    await mock(page);
    await seedState(page, state());
    await boot(page);
    await buildIndex(page);

    await page.getByTestId('index-status').click();
    const panel = page.getByTestId('index-panel');
    await expect(panel).toBeVisible();
    await expect(page.getByTestId('index-doc-count')).toHaveText('2 篇');

    const size = await page.getByTestId('index-size').textContent();
    expect(size).toBeTruthy();
    expect(size).toMatch(/字$/);

    const lastBuilt = await page.getByTestId('index-last-built').textContent();
    expect(lastBuilt).not.toBe('从未建立');

    // Health: a freshly built index must report as healthy, not "needs rebuild".
    // (The first version of the health check used the wrong field name and would
    // have called every record corrupt, sending users to rebuild a good index.)
    await expect(page.getByTestId('index-health-ok')).toBeVisible();
    await expect(page.getByTestId('index-health-warning')).toHaveCount(0);
  });

  test('索引损坏时健康检查明确提示并可重建', async ({ page }) => {
    await mock(page);
    // A store with one malformed record (missing `text`) alongside a valid one.
    await page.addInitScript(`
      (async () => {
        if (localStorage.getItem('__bad_record_seeded')) return;
        await new Promise((resolve) => {
          const req = indexedDB.open('self_hub_vault_index', 1);
          req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains('docs')) db.createObjectStore('docs', { keyPath: 'key' });
          };
          req.onsuccess = () => {
            const db = req.result;
            const tx = db.transaction('docs', 'readwrite');
            tx.objectStore('docs').put({ key: 'bad.md', title: '坏记录' });
            tx.oncomplete = () => { db.close(); resolve(); };
            tx.onerror = () => { db.close(); resolve(); };
          };
          req.onerror = () => resolve();
        });
        localStorage.setItem('__bad_record_seeded', '1');
      })();
    `);
    await page.goto('/');
    await expect.poll(() => page.evaluate(() => localStorage.getItem('__bad_record_seeded'))).toBe('1');

    await seedState(page, state());
    await boot(page);

    await page.getByTestId('index-status').click();
    const warning = page.getByTestId('index-health-warning');
    await expect(warning).toBeVisible({ timeout: 10_000 });
    await expect(warning).toContainText('格式不正确');
    await expect(warning).toContainText('建议重建索引');
  });

  test('清除索引会清空 IndexedDB 并回到未建立状态', async ({ page }) => {
    await mock(page);
    await seedState(page, state());
    await boot(page);
    await buildIndex(page);

    expect(await indexDbCount(page)).toBe(2);

    await page.getByTestId('index-status').click();
    await page.getByTestId('index-clear').click();

    await expect(page.locator('main')).toContainText('已索引 0', { timeout: 15_000 });
    expect(await indexDbCount(page)).toBeLessThanOrEqual(0);

    // Full-text search now guides the user instead of silently returning nothing.
    await page.locator('button', { hasText: '全文' }).click();
    await page.getByTestId('vault-search-input').fill('Redis');
    await expect(page.getByText('还没有全文索引')).toBeVisible();
  });

  test('重建索引后可以重新搜到内容', async ({ page }) => {
    await mock(page);
    await seedState(page, state());
    await boot(page);
    await buildIndex(page);

    await page.getByTestId('index-status').click();
    await page.locator('button', { hasText: '重建索引' }).click();

    // The label already read "已索引 2" before the rebuild, so poll the real
    // database instead of trusting text that may not have changed yet.
    await expect.poll(() => indexDbCount(page), { timeout: 25_000 }).toBe(2);
    await expect(page.locator('main')).toContainText('已索引 2');

    await page.locator('button', { hasText: '全文' }).click();
    await page.getByTestId('vault-search-input').fill('Kubernetes');
    await expect(page.getByTestId('vault-search-results')).toContainText(/beta/i);
  });

  test('索引数据库损坏时自动重建而不是永久失效', async ({ page }) => {
    await mock(page);
    // Seed a same-named database that lacks the `docs` store, and only continue
    // once it is actually on disk (otherwise the app races with the seeding).
    await page.addInitScript(`
      (async () => {
        if (localStorage.getItem('__corrupt_seeded')) return;
        await new Promise((resolve) => {
          const req = indexedDB.open('self_hub_vault_index', 1);
          req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains('junk')) db.createObjectStore('junk', { keyPath: 'id' });
          };
          req.onsuccess = () => { req.result.close(); resolve(); };
          req.onerror = () => resolve();
        });
        localStorage.setItem('__corrupt_seeded', '1');
      })();
    `);
    await page.goto('/');
    await expect.poll(() => page.evaluate(() => localStorage.getItem('__corrupt_seeded'))).toBe('1');

    await seedState(page, state());
    await page.goto('/');
    await gotoTab(page, '多平台数据互通');
    await expect(page.locator('main')).toContainText('对象 2');

    // Building works after recovery, and the store is correct again.
    await page.locator('button', { hasText: '建立索引' }).click();
    await expect(page.locator('main')).toContainText('已索引 2', { timeout: 25_000 });
    expect(await indexDbCount(page)).toBe(2);

    await page.locator('button', { hasText: '全文' }).click();
    await page.getByTestId('vault-search-input').fill('Redis');
    await expect(page.getByTestId('vault-search-results')).toContainText(/alpha/i);
  });
});
