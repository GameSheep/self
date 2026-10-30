import { test, expect } from '@playwright/test';
import { seedState, baseState, STORAGE_KEY, gotoTab } from './helpers';

/**
 * Vault file operations: upload, rename, move, folders, attachment preview.
 *
 * These were the round-1 product gaps: you could only create and delete, so a
 * typo in a filename meant re-creating the note, and pasted screenshots vanished.
 */

const KEY_ID = 'LTAI5tEXAMPLE000000000';
const ENDPOINT = 'oss-cn-beijing.aliyuncs.com';
const BUCKET = 'example-obsidian-vault';

const LIST_XML = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult><Name>${BUCKET}</Name><MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated>
  <Contents><Key>vault/a.md</Key><LastModified>2026-10-16T12:00:00.000Z</LastModified><Size>12</Size></Contents>
  <Contents><Key>vault/图片位置/pic.png</Key><LastModified>2026-10-16T12:00:00.000Z</LastModified><Size>70</Size></Contents>
</ListBucketResult>`;

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

interface Captured {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

function ossState(noteContent = '# 笔记\n\n正文\n') {
  return baseState({
    obsidianConfig: {
      enabled: true,
      bucket: BUCKET,
      endpoint: ENDPOINT,
      region: 'oss-cn-beijing',
      accessKeyId: KEY_ID,
      accessKeySecret: 'test-secret',
      prefix: 'vault/'
    },
    obsidianNotes: [
      {
        key: 'vault/a.md',
        title: 'a',
        path: 'vault/a.md',
        size: 12,
        lastModified: 1760000000000,
        content: noteContent
      },
      { key: 'vault/图片位置/pic.png', title: 'pic', path: 'vault/图片位置/pic.png', size: 70, lastModified: 1760000000000 }
    ]
  });
}

/** Route every OSS call through a recorder. */
async function mockOss(page: any, captured: Captured[]) {
  await page.route('**/*', async (route) => {
    const request = route.request();
    if (!request.url().includes(ENDPOINT)) {
      await route.continue();
      return;
    }
    captured.push({
      method: request.method(),
      url: decodeURIComponent(request.url()),
      headers: request.headers(),
      body: request.postData() || undefined
    });

    if (request.method() === 'PUT' || request.method() === 'DELETE') {
      await route.fulfill({
        status: request.method() === 'DELETE' ? 204 : 200,
        headers: { 'Access-Control-Allow-Origin': '*', ETag: '"x"' },
        body: request.method() === 'DELETE' ? '' : ''
      });
      return;
    }
    // GET object (attachment preview)
    if (/\.(png|jpe?g|gif|webp)$/i.test(request.url())) {
      await route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'image/png', 'Access-Control-Allow-Origin': '*' },
        body: PNG
      });
      return;
    }
    await route.fulfill({
      status: 200,
      headers: { 'Content-Type': 'application/xml', 'Access-Control-Allow-Origin': '*' },
      body: LIST_XML
    });
  });
}

async function boot(page: any) {
  await page.goto('/');
  await gotoTab(page, '多平台数据互通');
  await expect(page.locator('.md-body')).toBeVisible();
}

const finds = (captured: Captured[], method: string, fragment: string) =>
  captured.filter((c) => c.method === method && c.url.includes(fragment));

test.describe('桶内文件操作', () => {
  test.beforeEach(async ({ page }) => {
    page.on('dialog', (d) => d.accept());
  });

  test('粘贴图片自动上传到 OSS 并插入 Markdown', async ({ page }) => {
    const captured: Captured[] = [];
    await mockOss(page, captured);
    await seedState(page, ossState());
    await boot(page);

    await page.locator('button', { hasText: '编辑' }).first().click();
    await expect(page.locator('.md-editor-textarea')).toBeVisible();

    // Simulate a screenshot paste (no filename, like a real clipboard image).
    await page.evaluate(() => {
      const ta = document.querySelector('.md-editor-textarea') as HTMLTextAreaElement;
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array([1, 2, 3])], 'image.png', { type: 'image/png' }));
      ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    });

    // Upload happened...
    await expect
      .poll(() => finds(captured, 'PUT', '图片位置/').length, { timeout: 15_000 })
      .toBeGreaterThan(0);
    const put = finds(captured, 'PUT', '图片位置/')[0];
    expect(put.headers['content-type']).toContain('image/png');
    expect(put.headers['x-oss-date']).toBeTruthy();

    // ...and a markdown image reference was inserted into the note body.
    const value = await page.locator('.md-editor-textarea').inputValue();
    expect(value).toMatch(/!\[[^\]]*\]\(vault\/图片位置\/[^)]+\.png\)/);
  });

  test('重命名文件走服务端 COPY 并删除旧对象', async ({ page }) => {
    const captured: Captured[] = [];
    await mockOss(page, captured);
    await seedState(page, ossState());
    await boot(page);

    const row = page.locator('[data-oss-kind="file"][data-oss-path="vault/a.md"]');
    await expect(row).toBeVisible();
    await row.hover();
    await row.locator('button[title="重命名"]').click();

    const input = page.locator('input[placeholder="日记/2026年/2026年10月.md"]');
    await expect(input).toBeVisible();
    await input.fill('vault/renamed.md');
    await page.locator('button', { hasText: /^确定$/ }).click();

    await expect.poll(() => finds(captured, 'PUT', 'renamed.md').length, { timeout: 15_000 }).toBeGreaterThan(0);
    const copy = finds(captured, 'PUT', 'renamed.md')[0];
    // The copy source header must be signed together with x-oss-date.
    expect(copy.headers['x-oss-copy-source']).toBe(`/${BUCKET}/vault/a.md`);

    await expect.poll(() => finds(captured, 'DELETE', 'vault/a.md').length, { timeout: 15_000 }).toBeGreaterThan(0);
  });

  test('新建目录会写入以 / 结尾的占位对象', async ({ page }) => {
    const captured: Captured[] = [];
    await mockOss(page, captured);
    await seedState(page, ossState());
    await boot(page);

    await page.locator('button[title="新建目录"]').click();
    const input = page.locator('input[placeholder="日记/2026年/2026年10月.md"]');
    await expect(input).toBeVisible();
    await input.fill('vault/新目录');
    await page.locator('button', { hasText: '创建' }).click();

    await expect.poll(() => finds(captured, 'PUT', '新目录/').length, { timeout: 15_000 }).toBeGreaterThan(0);
  });

  test('点击图片附件会在右侧预览（而不是提示"不是文本文件"）', async ({ page }) => {
    const captured: Captured[] = [];
    await mockOss(page, captured);
    await seedState(page, ossState());
    await boot(page);

    await page.locator('[data-oss-kind="dir"][data-oss-path="vault/图片位置/"]').click();
    const pic = page.locator('[data-oss-kind="file"][data-oss-path="vault/图片位置/pic.png"]');
    await expect(pic).toBeVisible();
    await pic.click();

    const preview = page.getByTestId('attachment-preview');
    await expect(preview).toBeVisible({ timeout: 15_000 });
    expect(await preview.getAttribute('src')).toMatch(/^blob:/);
  });

  test('打开过的笔记出现在"最近打开"里', async ({ page }) => {
    const captured: Captured[] = [];
    await mockOss(page, captured);
    await seedState(page, ossState());
    await boot(page);

    await page.locator('[data-oss-kind="file"][data-oss-path="vault/a.md"]').click();
    await expect(page.getByText('最近打开')).toBeVisible();
    await expect(page.locator('button', { hasText: 'a.md' }).first()).toBeVisible();
  });

  test('上传本地文件按钮会把文件 PUT 到附件目录', async ({ page }) => {
    const captured: Captured[] = [];
    await mockOss(page, captured);
    await seedState(page, ossState());
    await boot(page);

    await page.locator('input[type="file"]').first().setInputFiles({
      name: 'diagram.png',
      mimeType: 'image/png',
      buffer: PNG
    });

    await expect.poll(() => finds(captured, 'PUT', '图片位置/diagram').length, { timeout: 15_000 }).toBeGreaterThan(0);
  });

  test('移动目录拒绝移动到自身子目录', async ({ page }) => {
    const captured: Captured[] = [];
    await mockOss(page, captured);
    await seedState(page, ossState());
    await boot(page);

    const dir = page.locator('[data-oss-kind="dir"][data-oss-path="vault/图片位置/"]');
    await dir.hover();
    await dir.locator('button[title="移动目录"]').click();
    const input = page.locator('input[placeholder="日记/2026年/2026年10月.md"]');
    await input.fill('vault/图片位置/子目录');
    await page.locator('button', { hasText: /^确定$/ }).click();

    // No copy should be attempted at all.
    await page.waitForTimeout(800);
    expect(finds(captured, 'PUT', '子目录')).toHaveLength(0);
  });
});
