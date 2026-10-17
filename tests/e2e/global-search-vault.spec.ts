import { test, expect } from '@playwright/test';
import { seedState, baseState } from './helpers';

/**
 * Wiring the full-text index into the highest-traffic entry point (Ctrl+K),
 * plus automatic incremental refresh of the index after a tree reload.
 */

const ENDPOINT = 'oss-cn-beijing.aliyuncs.com';
const BUCKET = 'uiuecho-obsidian';

const DOCS: Record<string, string> = {
  'vault/alpha.md': '# Alpha\n\n这里记录了 Redis 缓存的使用方式。\n',
  'vault/beta.md': '# Beta\n\n部署笔记，与缓存无关。\n'
};

const LATE_DOC = 'vault/late.md';
const LATE_BODY = '# Late\n\n后来才加入的 Tranch 内容。\n';

let extraDocEnabled = false;

function listXml(): string {
  const keys = [...Object.keys(DOCS), ...(extraDocEnabled ? [LATE_DOC] : [])];
  const contents = keys
    .map(
      (key) =>
        `<Contents><Key>${key}</Key><LastModified>2026-10-16T12:00:00.000Z</LastModified><ETag>"e-${key}"</ETag><Size>20</Size></Contents>`
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
    if (request.method() === 'GET' && decoded.endsWith(`/${LATE_DOC}`) && extraDocEnabled) {
      await route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'text/markdown; charset=utf-8', 'Access-Control-Allow-Origin': '*' },
        body: LATE_BODY
      });
      return;
    }
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
      accessKeyId: 'LTAI5t8JAm7fyYaDsK5ECJer',
      accessKeySecret: 'test-secret',
      prefix: 'vault/'
    }
  });
}

async function boot(page: any) {
  await page.goto('/');
  await page.locator('nav button', { hasText: '多平台数据互通' }).click();
  await expect(page.locator('main')).toContainText('对象 2');
}

test.describe('全局搜索接入全文索引', () => {
  test.beforeEach(async ({ page }) => {
    extraDocEnabled = false;
    page.on('dialog', (d) => d.accept());
  });

  test('Ctrl+K 能搜到笔记正文并跳转到该笔记', async ({ page }) => {
    await mock(page);
    await seedState(page, state());
    await boot(page);

    // Build the index first (full-text results need it).
    await page.locator('button', { hasText: '建立索引' }).click();
    await expect(page.locator('main')).toContainText('已索引 2', { timeout: 20_000 });

    await page.keyboard.press('Control+k');
    await page.waitForTimeout(400);
    await page.keyboard.type('Redis');
    await page.waitForTimeout(600);

    // The vault hit is grouped as "正文·…".
    await expect(page.getByText(/正文·vault/)).toBeVisible();
    await expect(page.getByText(/记录了 Redis 缓存/)).toBeVisible();

    await page.keyboard.press('Enter');
    await expect(page.locator('.md-body')).toContainText('Redis 缓存的使用方式', { timeout: 15_000 });
  });

  test('索引里没有的内容不会误报', async ({ page }) => {
    await mock(page);
    await seedState(page, state());
    await boot(page);

    await page.locator('button', { hasText: '建立索引' }).click();
    await expect(page.locator('main')).toContainText('已索引 2', { timeout: 20_000 });

    await page.keyboard.press('Control+k');
    await page.waitForTimeout(400);
    await page.keyboard.type('Tranch');
    await page.waitForTimeout(600);

    await expect(page.getByText(/正文·vault/)).toHaveCount(0);
  });
});

test.describe('索引自动增量更新', () => {
  test.beforeEach(async ({ page }) => {
    extraDocEnabled = false;
    page.on('dialog', (d) => d.accept());
  });

  test('刷新目录后新增笔记会自动进入索引', async ({ page }) => {
    await mock(page);
    await seedState(page, state());
    await boot(page);

    await page.locator('button', { hasText: '建立索引' }).click();
    await expect(page.locator('main')).toContainText('已索引 2', { timeout: 20_000 });

    // A new note appears in the bucket.
    extraDocEnabled = true;
    await page.locator('button[title*="从 OSS 刷新"]').click();

    await expect(page.locator('main')).toContainText('对象 3', { timeout: 20_000 });
    // No manual "更新索引" click: the refresh updates it incrementally.
    await expect(page.locator('main')).toContainText('已索引 3', { timeout: 25_000 });
  });
});
