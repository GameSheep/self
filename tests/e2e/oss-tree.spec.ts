import { test, expect } from '@playwright/test';
import { seedState, baseState, STORAGE_KEY, gotoTab } from './helpers';

/**
 * Multi-level OSS browsing.
 *
 * The old listing used a single `max-keys=200` request under one prefix, so a
 * nested vault looked empty. These tests pin the behaviour that makes a deep
 * bucket browsable: full pagination, tree rendering, and cross-level search.
 */

const KEY_ID = 'LTAI5tEXAMPLE000000000';
const KEY_SECRET = 'test-secret';
const BUCKET = 'example-obsidian-vault';
const ENDPOINT = 'oss-cn-beijing.aliyuncs.com';

/** 1200 objects in 3 top-level folders — more than one 1000-key page. */
function listXml(marker: string): { xml: string; isTruncated: boolean } {
  const all: string[] = [];
  for (let i = 0; i < 1200; i++) {
    const folder = ['日记/', 'WuCai/', '项目/子目录/'][i % 3];
    all.push(`${folder}note-${String(i).padStart(4, '0')}.md`);
  }
  const start = marker ? all.indexOf(marker) + 1 : 0;
  const page = all.slice(start, start + 1000);
  const isTruncated = start + 1000 < all.length;
  const contents = page
    .map(
      (key) => `<Contents><Key>${key}</Key><LastModified>2026-10-16T12:00:00.000Z</LastModified><Size>128</Size><ETag>"x"</ETag><StorageClass>Standard</StorageClass></Contents>`
    )
    .join('');
  const nextMarker = isTruncated ? page[page.length - 1] : '';
  return {
    isTruncated,
    xml: `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult>
  <Name>${BUCKET}</Name><Prefix></Prefix><Marker>${marker}</Marker>
  <MaxKeys>1000</MaxKeys><IsTruncated>${isTruncated}</IsTruncated>
  ${isTruncated ? `<NextMarker>${nextMarker}</NextMarker>` : ''}
  ${contents}
</ListBucketResult>`
  };
}

async function configure(page: any, prefix: string) {
  await seedState(
    page,
    baseState({
      obsidianConfig: {
        enabled: true,
        bucket: BUCKET,
        endpoint: ENDPOINT,
        region: 'oss-cn-beijing',
        accessKeyId: KEY_ID,
        accessKeySecret: KEY_SECRET,
        prefix
      }
    })
  );
  await page.goto('/');
  await gotoTab(page, '多平台数据互通');
  await expect(page.locator('main')).toContainText('测连通');
}

test.describe('OSS 多层目录树', () => {
  test('跨页拉取全部对象（不止第一页 1000 条）', async ({ page }) => {
    const markers: string[] = [];
    await page.route('**/*', async (route) => {
      const request = route.request();
      if (!request.url().includes(ENDPOINT)) {
        await route.continue();
        return;
      }
      const url = new URL(request.url());
      const marker = url.searchParams.get('marker') || '';
      markers.push(marker);
      const { xml } = listXml(marker);
      await route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'application/xml', 'Access-Control-Allow-Origin': '*' },
        body: xml
      });
    });

    await configure(page, '');
    // The panel auto-loads on mount; wait for that to finish first.
    await expect(page.locator('main')).toContainText('对象 1200', { timeout: 15_000 });

    markers.length = 0;
    await page.locator('[data-testid="oss-refresh"]').click();

    // Two pages: 1000 + 200.
    await expect.poll(() => markers.length, { timeout: 15_000 }).toBe(2);
    expect(markers[0]).toBe('');
    expect(markers[1]).not.toBe('');

    await expect(page.locator('main')).toContainText('对象 1200');
    await expect(page.locator('main')).toContainText('2 页');
  });

  test('多层级目录以树形展开，可逐层点开并读到文件', async ({ page }) => {
    await page.route('**/*', async (route) => {
      const request = route.request();
      if (!request.url().includes(ENDPOINT)) {
        await route.continue();
        return;
      }
      if (request.method() === 'GET' && !request.url().includes('max-keys')) {
        await route.fulfill({
          status: 200,
          headers: { 'Content-Type': 'text/markdown', 'Access-Control-Allow-Origin': '*' },
          body: '# 云端正文\n\n这是从 OSS 读回的正文。'
        });
        return;
      }
      await route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'application/xml', 'Access-Control-Allow-Origin': '*' },
        body: listXml(new URL(request.url()).searchParams.get('marker') || '').xml
      });
    });

    await configure(page, '');
    await page.locator('[data-testid="oss-refresh"]').click();
    await expect(page.locator('main')).toContainText('对象 1200');

    // Root folders are visible and expandable.
    const folder = page.locator('[data-oss-kind="dir"][data-oss-path="日记/"]');
    await expect(folder).toBeVisible();
    await folder.click();

    // File rows carry an icon + name + size, so match the name without anchors.
    const fileRow = page.locator('[data-oss-kind="file"][data-oss-path="日记/note-0000.md"]');
    await expect(fileRow).toBeVisible();
    await expect(page.locator('[data-oss-kind="file"][data-oss-path="日记/note-0003.md"]')).toBeVisible();

    // Open a file -> body is fetched on demand from OSS.
    await fileRow.click();
    await expect(page.locator('main')).toContainText('这是从 OSS 读回的正文', { timeout: 10_000 });
  });

  test('搜索会跨所有层级命中（不只搜当前一层）', async ({ page }) => {
    await page.route('**/*', async (route) => {
      const request = route.request();
      if (!request.url().includes(ENDPOINT)) {
        await route.continue();
        return;
      }
      await route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'application/xml', 'Access-Control-Allow-Origin': '*' },
        body: listXml(new URL(request.url()).searchParams.get('marker') || '').xml
      });
    });

    await configure(page, '');
    await page.locator('[data-testid="oss-refresh"]').click();
    await expect(page.locator('main')).toContainText('对象 1200');

    // '子目录' only appears on the third folder path.
    await page.fill('input[placeholder*="在整棵目录树中搜索"]', 'note-1199');
    await expect(page.locator('[data-oss-path="项目/子目录/note-1199.md"]')).toBeVisible();
    await expect(page.locator('[data-oss-path="日记/note-0000.md"]')).toHaveCount(0);
  });

  test('前缀把内容过滤空时给出明确提示，而不是谎报"没有笔记"', async ({ page }) => {
    await page.route('**/*', async (route) => {
      const request = route.request();
      if (!request.url().includes(ENDPOINT)) {
        await route.continue();
        return;
      }
      const url = new URL(request.url());
      const prefix = url.searchParams.get('prefix') || '';
      if (prefix === 'vault/') {
        // prefix matches nothing
        await route.fulfill({
          status: 200,
          headers: { 'Content-Type': 'application/xml', 'Access-Control-Allow-Origin': '*' },
          body: `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>${BUCKET}</Name><Prefix>vault/</Prefix><MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated></ListBucketResult>`
        });
        return;
      }
      await route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'application/xml', 'Access-Control-Allow-Origin': '*' },
        body: listXml(url.searchParams.get('marker') || '').xml
      });
    });

    await configure(page, 'vault/');
    await page.locator('[data-testid="oss-refresh"]').click();

    await expect(page.locator('main')).toContainText('前缀把内容过滤空了', { timeout: 10_000 });
    await expect(page.locator('main')).toContainText('文件前缀');
    // The bucket's real size is surfaced so the user can see content exists elsewhere.
    await expect(page.locator('main')).toContainText('但桶内至少有 1000 个对象');
  });
});

