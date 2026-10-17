import { test, expect } from '@playwright/test';
import { seedState, baseState } from './helpers';

/**
 * Full-vault search and backlinks.
 *
 * With ~1700 notes, searching only file names meant the content was effectively
 * unreachable. These tests cover building the local index, searching bodies /
 * tags / links, and the backlinks strip.
 */

const ENDPOINT = 'oss-cn-beijing.aliyuncs.com';
const BUCKET = 'uiuecho-obsidian';

const DOCS: Record<string, string> = {
  'vault/alpha.md': '# Alpha\n\n这里记录了 Redis 缓存的使用方式。\n',
  'vault/beta.md': '# Beta\n\n部署笔记：引用 [[alpha]] 的缓存结论。\n',
  'vault/gamma.md': '---\ntags: [infra, ops]\n---\n\n# Gamma\n\nKubernetes 集群维护手册。\n'
};

function listXml(): string {
  const contents = Object.keys(DOCS)
    .map(
      (key) =>
        `<Contents><Key>${key}</Key><LastModified>2026-10-16T12:00:00.000Z</LastModified><ETag>"e-${key}"</ETag><Size>${DOCS[key].length}</Size></Contents>`
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
    if (request.method() === 'HEAD') {
      await route.fulfill({
        status: 200,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Expose-Headers': 'Last-Modified,ETag',
          'Last-Modified': 'Thu, 01 Jan 2026 00:00:00 GMT',
          ETag: '"same"'
        },
        body: ''
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
  await expect(page.locator('main')).toContainText('对象 3');
}

async function buildIndex(page: any) {
  await page.locator('button', { hasText: '建立索引' }).click();
  await expect(page.locator('main')).toContainText('已索引 3', { timeout: 20_000 });
}

const searchBox = (page: any) => page.getByTestId('vault-search-input');

test.describe('全库全文搜索', () => {
  test.beforeEach(async ({ page }) => {
    page.on('dialog', (d) => d.accept());
  });

  test('未建索引时提示并可一键建立', async ({ page }) => {
    await mock(page);
    await seedState(page, state());
    await boot(page);

    await page.locator('button', { hasText: '全文' }).click();
    await searchBox(page).fill('Redis');

    await expect(page.getByText('还没有全文索引')).toBeVisible();
    await page.locator('button', { hasText: '建立全文索引' }).click();
    await expect(page.locator('main')).toContainText('已索引 3', { timeout: 20_000 });
  });

  test('按正文搜索并高亮命中片段', async ({ page }) => {
    await mock(page);
    await seedState(page, state());
    await boot(page);
    await buildIndex(page);

    await page.locator('button', { hasText: '全文' }).click();
    await searchBox(page).fill('Redis');

    const results = page.getByTestId('vault-search-results');
    await expect(results).toBeVisible();
    await expect(results.locator('button')).toHaveCount(1);
    await expect(results).toContainText(/alpha/i);
    await expect(results.locator('mark')).toHaveText('Redis');
  });

  test('点击结果可打开对应笔记', async ({ page }) => {
    await mock(page);
    await seedState(page, state());
    await boot(page);
    await buildIndex(page);

    await page.locator('button', { hasText: '全文' }).click();
    await searchBox(page).fill('Kubernetes');
    await page.locator('[data-oss-hit="vault/gamma.md"]').click();

    await expect(page.locator('.md-body')).toContainText('Kubernetes 集群维护手册');
  });

  test('按标签精确检索（#infra）', async ({ page }) => {
    await mock(page);
    await seedState(page, state());
    await boot(page);
    await buildIndex(page);

    await page.locator('button', { hasText: '全文' }).click();
    await searchBox(page).fill('#infra');

    const results = page.getByTestId('vault-search-results');
    await expect(results).toContainText(/gamma/i);
    await expect(results.locator('button')).toHaveCount(1);
  });

  test('按双链检索', async ({ page }) => {
    await mock(page);
    await seedState(page, state());
    await boot(page);
    await buildIndex(page);

    await page.locator('button', { hasText: '全文' }).click();
    await searchBox(page).fill('alpha');

    // beta 的正文里有 [[alpha]]
    const results = page.getByTestId('vault-search-results');
    await expect(results).toContainText(/beta/i);
  });

  test('文件名模式不会走全文索引', async ({ page }) => {
    await mock(page);
    await seedState(page, state());
    await boot(page);
    await buildIndex(page);

    // Still in 文件名 mode: searching body-only text must not return results.
    await searchBox(page).fill('Redis');
    await expect(page.getByTestId('vault-search-results')).toHaveCount(0);
    await expect(page.locator('[data-oss-kind="file"]')).toHaveCount(0);
  });
});

test.describe('反向链接', () => {
  test.beforeEach(async ({ page }) => {
    page.on('dialog', (d) => d.accept());
  });

  test('打开被引用的笔记时显示反向链接', async ({ page }) => {
    await mock(page);
    await seedState(page, state());
    await boot(page);
    await buildIndex(page);

    // Open alpha, which beta links to.
    await page.locator('[data-oss-kind="file"]', { hasText: 'alpha.md' }).click();
    await expect(page.locator('.md-body')).toContainText('Redis 缓存');

    await expect(page.getByText('反向链接 (1)')).toBeVisible();
    const backlink = page.locator('[data-backlink="vault/beta.md"]');
    await expect(backlink).toBeVisible();
    await expect(backlink).toHaveText(/beta/i);
  });

  test('点击反向链接可跳转到引用方', async ({ page }) => {
    await mock(page);
    await seedState(page, state());
    await boot(page);
    await buildIndex(page);

    await page.locator('[data-oss-kind="file"]', { hasText: 'alpha.md' }).click();
    await page.locator('[data-backlink="vault/beta.md"]').click();

    await expect(page.locator('.md-body')).toContainText('部署笔记');
  });

  test('没有被引用时不显示反向链接条', async ({ page }) => {
    await mock(page);
    await seedState(page, state());
    await boot(page);
    await buildIndex(page);

    await page.locator('[data-oss-kind="file"]', { hasText: 'gamma.md' }).click();
    await expect(page.locator('.md-body')).toContainText('Kubernetes');
    await expect(page.getByText(/反向链接 \(/)).toHaveCount(0);
  });
});



