import { test, expect } from '@playwright/test';
import { seedState, baseState } from './helpers';

/**
 * Data-safety behaviours: the trash and overwrite detection.
 *
 * Deleting used to be permanent, and saving could silently overwrite a version
 * that Obsidian desktop had written in the meantime.
 */

const KEY_ID = 'LTAI5t8JAm7fyYaDsK5ECJer';
const ENDPOINT = 'oss-cn-beijing.aliyuncs.com';
const BUCKET = 'uiuecho-obsidian';

/** Listing reports an old mtime; that becomes the baseline for conflict checks. */
const OLD_ISO = '2026-01-01T00:00:00.000Z';
const OLD_RFC = 'Thu, 01 Jan 2026 00:00:00 GMT';
const NEW_RFC = 'Fri, 16 Oct 2026 12:00:00 GMT';

const LIST_XML = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult><Name>${BUCKET}</Name><MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated>
  <Contents><Key>vault/a.md</Key><LastModified>${OLD_ISO}</LastModified><ETag>"base-etag"</ETag><Size>12</Size></Contents>
  <Contents><Key>.trash/vault/old.md</Key><LastModified>${OLD_ISO}</LastModified><Size>8</Size></Contents>
</ListBucketResult>`;

interface Captured {
  method: string;
  url: string;
  headers: Record<string, string>;
}

async function mockOss(page: any, captured: Captured[], headLastModified = OLD_RFC) {
  await page.route('**/*', async (route) => {
    const request = route.request();
    if (!request.url().includes(ENDPOINT)) {
      await route.continue();
      return;
    }
    captured.push({ method: request.method(), url: decodeURIComponent(request.url()), headers: request.headers() });

    if (request.method() === 'HEAD') {
      await route.fulfill({
        status: 200,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Expose-Headers': 'Last-Modified,ETag',
          'Last-Modified': headLastModified,
          ETag: '"abc"'
        },
        body: ''
      });
      return;
    }
    if (request.method() === 'PUT' || request.method() === 'DELETE') {
      await route.fulfill({
        status: request.method() === 'DELETE' ? 204 : 200,
        headers: { 'Access-Control-Allow-Origin': '*', ETag: '"x"' },
        body: ''
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

function state() {
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
      { key: 'vault/a.md', title: 'a', path: 'vault/a.md', size: 12, lastModified: 1767225600000, content: '# 笔记\n\n正文\n' }
    ]
  });
}

async function boot(page: any) {
  await page.goto('/');
  await page.locator('nav button', { hasText: '多平台数据互通' }).click();
  await expect(page.locator('.md-body')).toBeVisible();
}

const puts = (c: Captured[]) => c.filter((x) => x.method === 'PUT');
const deletes = (c: Captured[]) => c.filter((x) => x.method === 'DELETE');

test.describe('回收站', () => {
  test.beforeEach(async ({ page }) => {
    page.on('dialog', (d) => d.accept());
  });

  test('删除文件是移入 .trash/ 而不是永久删除', async ({ page }) => {
    const captured: Captured[] = [];
    await mockOss(page, captured);
    await seedState(page, state());
    await boot(page);

    const row = page.locator('[data-oss-kind="file"][data-oss-path="vault/a.md"]');
    await expect(row).toBeVisible();
    await row.hover();
    await row.locator('button[title="删除"]').click();

    // Copy into the trash...
    await expect
      .poll(() => puts(captured).filter((p) => p.url.includes('.trash/vault/a.md')).length, { timeout: 15_000 })
      .toBeGreaterThan(0);
    const copy = puts(captured).find((p) => p.url.includes('.trash/vault/a.md'))!;
    expect(copy.headers['x-oss-copy-source']).toBe(`/${BUCKET}/vault/a.md`);

    // ...and only then remove the original.
    await expect
      .poll(() => deletes(captured).filter((d) => d.url.endsWith('/vault/a.md')).length, { timeout: 15_000 })
      .toBeGreaterThan(0);
  });

  test('回收站里的条目提供恢复操作，恢复到原路径', async ({ page }) => {
    const captured: Captured[] = [];
    await mockOss(page, captured);
    await seedState(page, state());
    await boot(page);

    // Open the trash folder.
    await page.locator('[data-oss-kind="dir"][data-oss-path=".trash/"]').click();
    await page.locator('[data-oss-kind="dir"][data-oss-path=".trash/vault/"]').click();

    const trashed = page.locator('[data-oss-kind="file"][data-oss-path=".trash/vault/old.md"]');
    await expect(trashed).toBeVisible();
    await trashed.hover();
    await trashed.locator('button[title="从回收站恢复"]').click();

    await expect
      .poll(() => puts(captured).filter((p) => p.url.includes('/vault/old.md') && !p.url.includes('.trash')).length, {
        timeout: 15_000
      })
      .toBeGreaterThan(0);
    const restore = puts(captured).find((p) => p.url.endsWith('/vault/old.md'))!;
    expect(restore.headers['x-oss-copy-source']).toBe(`/${BUCKET}/.trash/vault/old.md`);
    // The trash copy is cleaned up afterwards.
    await expect
      .poll(() => deletes(captured).filter((d) => d.url.includes('.trash/vault/old.md')).length, { timeout: 15_000 })
      .toBeGreaterThan(0);
  });
});

test.describe('保存冲突检测', () => {
  test.beforeEach(async ({ page }) => {
    page.on('dialog', (d) => d.accept());
  });

  test('云端更新后保存被拦截，并弹出冲突对话框（不写入）', async ({ page }) => {
    const captured: Captured[] = [];
    await mockOss(page, captured, NEW_RFC); // cloud is newer than our baseline
    await seedState(page, state());
    await boot(page);

    await page.locator('button', { hasText: '编辑' }).first().click();
    await page.locator('.md-editor-textarea').fill('# 我改的内容\n');
    await page.locator('.md-editor button', { hasText: '保存' }).click();

    await expect(page.getByText('云端文件已被修改')).toBeVisible({ timeout: 15_000 });
    // Nothing may have been written.
    expect(puts(captured)).toHaveLength(0);
  });

  test('选择"覆盖"后才真正写入', async ({ page }) => {
    const captured: Captured[] = [];
    await mockOss(page, captured, NEW_RFC);
    await seedState(page, state());
    await boot(page);

    await page.locator('button', { hasText: '编辑' }).first().click();
    await page.locator('.md-editor-textarea').fill('# 强制覆盖\n');
    await page.locator('.md-editor button', { hasText: '保存' }).click();

    await expect(page.getByText('云端文件已被修改')).toBeVisible({ timeout: 15_000 });
    await page.locator('button', { hasText: '仍然用我的版本覆盖' }).click();

    await expect.poll(() => puts(captured).length, { timeout: 15_000 }).toBeGreaterThan(0);
    expect(puts(captured)[0].headers['x-oss-date']).toBeTruthy();
    await expect(page.getByText('云端文件已被修改')).toHaveCount(0);
  });

  test('云端未变化时正常保存，不弹冲突', async ({ page }) => {
    const captured: Captured[] = [];
    await mockOss(page, captured, OLD_RFC); // same mtime as baseline
    await seedState(page, state());
    await boot(page);

    await page.locator('button', { hasText: '编辑' }).first().click();
    await page.locator('.md-editor-textarea').fill('# 正常保存\n');
    await page.locator('.md-editor button', { hasText: '保存' }).click();

    await expect.poll(() => puts(captured).length, { timeout: 15_000 }).toBeGreaterThan(0);
    await expect(page.getByText('云端文件已被修改')).toHaveCount(0);
  });

  test('选择"重新加载云端版本"会丢弃本地改动', async ({ page }) => {
    const captured: Captured[] = [];
    await mockOss(page, captured, NEW_RFC);
    await seedState(page, state());
    await boot(page);

    await page.locator('button', { hasText: '编辑' }).first().click();
    await page.locator('.md-editor-textarea').fill('# 会被丢弃\n');
    await page.locator('.md-editor button', { hasText: '保存' }).click();

    await expect(page.getByText('云端文件已被修改')).toBeVisible({ timeout: 15_000 });
    await page.locator('button', { hasText: '重新加载云端版本' }).click();

    await expect(page.getByText('云端文件已被修改')).toHaveCount(0);
    expect(puts(captured)).toHaveLength(0);
  });

  /**
   * The web build relies on CORS exposing headers. Many buckets only expose ETag,
   * so conflict detection must fall back to comparing it.
   */
  test('拿不到 Last-Modified 时用 ETag 兜底检测冲突', async ({ page }) => {
    const captured: Captured[] = [];
    await page.route('**/*', async (route) => {
      const request = route.request();
      if (!request.url().includes(ENDPOINT)) {
        await route.continue();
        return;
      }
      captured.push({ method: request.method(), url: decodeURIComponent(request.url()), headers: request.headers() });
      if (request.method() === 'HEAD') {
        // Deliberately no Last-Modified (as if CORS did not expose it).
        await route.fulfill({
          status: 200,
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Expose-Headers': 'ETag',
            ETag: '"changed-etag"'
          },
          body: ''
        });
        return;
      }
      if (request.method() === 'PUT') {
        await route.fulfill({ status: 200, headers: { 'Access-Control-Allow-Origin': '*' }, body: '' });
        return;
      }
      await route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'application/xml', 'Access-Control-Allow-Origin': '*' },
        body: LIST_XML
      });
    });

    await seedState(page, state());
    await boot(page);

    await page.locator('button', { hasText: '编辑' }).first().click();
    await page.locator('.md-editor-textarea').fill('# 改了\n');
    await page.locator('.md-editor button', { hasText: '保存' }).click();

    await expect(page.getByText('云端文件已被修改')).toBeVisible({ timeout: 15_000 });
    expect(puts(captured)).toHaveLength(0);
  });
});
