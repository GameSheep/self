import { test, expect } from '@playwright/test';
import { seedRichNote, openInterop } from './fixtures';
import { seedState, baseState } from './helpers';

/**
 * Markdown reading view quality.
 *
 * The interop page used to print note bodies as preformatted plain text, so none
 * of this rendered at all. Each assertion below pins one Obsidian-level feature.
 */

test.describe('Markdown 阅读视图', () => {
  test.beforeEach(async ({ page }) => {
    page.on('dialog', (d) => d.accept());
    await seedRichNote(page);
  });

  test('标题层级与锚点 id', async ({ page }) => {
    await openInterop(page);
    await expect(page.locator('h1.md-h1')).toHaveText('一级标题');
    await expect(page.locator('h2.md-h2')).toHaveText('二级标题');
    const id = await page.locator('h1.md-h1').getAttribute('id');
    expect(id).toBeTruthy();
  });

  test('行内格式：粗体/斜体/删除线/行内码', async ({ page }) => {
    await openInterop(page);
    await expect(page.locator('.md-body strong', { hasText: '粗体' }).first()).toBeVisible();
    await expect(page.locator('.md-body em', { hasText: '斜体' })).toBeVisible();
    await expect(page.locator('.md-body del', { hasText: '删除线' })).toBeVisible();
    await expect(page.locator('.md-body code.md-inline-code', { hasText: '行内码' })).toBeVisible();
  });

  test('frontmatter 渲染成属性表（含标签 chip）', async ({ page }) => {
    await openInterop(page);
    const props = page.locator('.md-props');
    await expect(props).toBeVisible();
    await expect(props).toContainText('title');
    await expect(props).toContainText('渲染测试');
    await expect(props.locator('.md-props-chip')).toHaveCount(2);
    await expect(props.locator('.md-props-chip').first()).toHaveText('obsidian');
    // The raw `---` fence must not leak into the body as a heading/hr.
    await expect(page.locator('.md-body')).not.toContainText('---');
  });

  test('双链：可解析的显示为链接，缺失的给出缺失样式', async ({ page }) => {
    await openInterop(page);
    const resolved = page.locator('.md-wikilink', { hasText: '另一篇笔记' });
    await expect(resolved).toBeVisible();
    await expect(resolved).not.toHaveClass(/md-wikilink-missing/);

    const missing = page.locator('.md-wikilink-missing', { hasText: '缺失链接' });
    await expect(missing).toBeVisible();
    await expect(missing).toHaveAttribute('title', /未找到/);
  });

  test('标签渲染为可点击 chip', async ({ page }) => {
    await openInterop(page);
    const tag = page.locator('.md-tag', { hasText: '#标签' });
    await expect(tag).toBeVisible();
    await tag.click();
    // Clicking a tag drives the vault search.
    await expect(page.getByTestId('vault-search-input')).toHaveValue('#标签');
  });

  test('标注块：普通与可折叠', async ({ page }) => {
    await openInterop(page);
    const note = page.locator('.md-callout-note');
    await expect(note).toBeVisible();
    await expect(note.locator('.md-callout-title')).toHaveText('提示标题');
    await expect(note).toContainText('标注块内容');
    await expect(note.locator('strong')).toHaveText('加粗');

    const folded = page.locator('details.md-callout-warning');
    await expect(folded).toBeVisible();
    await expect(folded).not.toHaveAttribute('open', /.*/);
  });

  test('任务列表：复选框状态正确', async ({ page }) => {
    await openInterop(page);
    const boxes = page.locator('.md-task-box');
    await expect(boxes).toHaveCount(2);
    await expect(boxes.nth(0)).not.toBeChecked();
    await expect(boxes.nth(1)).toBeChecked();
    await expect(page.locator('.md-task-done')).toHaveText('已完成任务');
  });

  test('有序/无序列表与嵌套', async ({ page }) => {
    await openInterop(page);
    await expect(page.locator('ol.md-list-ordered > li')).toHaveCount(2);
    await expect(page.locator('ol.md-list-ordered li ul.md-list-bullet li', { hasText: '嵌套无序' })).toHaveCount(1);
  });

  test('表格：表头、对齐与单元格', async ({ page }) => {
    await openInterop(page);
    const table = page.locator('table.md-table');
    await expect(table).toBeVisible();
    await expect(table.locator('th')).toHaveCount(3);
    await expect(table.locator('th', { hasText: '年龄' })).toHaveCSS('text-align', 'center');
    await expect(table.locator('th', { hasText: '城市' })).toHaveCSS('text-align', 'right');
    await expect(table.locator('td', { hasText: '张三' })).toBeVisible();
  });

  test('代码块：语言标签 + 语法高亮', async ({ page }) => {
    await openInterop(page);
    const code = page.locator('.md-code');
    await expect(code.locator('.md-code-lang')).toHaveText('js');
    await expect(code.locator('pre code')).toContainText('const answer = 42;');
    // highlight.js token spans must be present (real highlighting, not plain text).
    await expect(code.locator('span[class^="hljs-"]').first()).toBeVisible();
  });

  test('引用与分隔线', async ({ page }) => {
    await openInterop(page);
    await expect(page.locator('blockquote.md-blockquote', { hasText: '引用第一行' })).toBeVisible();
    await expect(page.locator('hr.md-hr')).toHaveCount(1);
  });

  test('未配置 OSS 时的图片给出明确提示而不是静默空白', async ({ page }) => {
    await openInterop(page);
    const placeholder = page.locator('.md-image-error, .md-image-pending');
    await expect(placeholder).toBeVisible();
  });

  test('库内相对路径图片走签名拉取并渲染为 blob URL', async ({ page }) => {
    // 1x1 transparent PNG
    const PNG = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      'base64'
    );
    const blobRequests: string[] = [];

    await page.route('**/*', async (route) => {
      const request = route.request();
      if (!request.url().includes('oss-cn-beijing.aliyuncs.com')) {
        await route.continue();
        return;
      }
      if (request.method() === 'GET' && request.url().includes('pic.png')) {
        blobRequests.push(request.url());
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
        body: `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>b</Name><MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated>
          <Contents><Key>vault/pic.png</Key><LastModified>2026-10-16T12:00:00.000Z</LastModified><Size>70</Size></Contents></ListBucketResult>`
      });
    });

    await seedState(
      page,
      baseState({
        obsidianConfig: {
          enabled: true,
          bucket: 'example-obsidian-vault',
          endpoint: 'oss-cn-beijing.aliyuncs.com',
          region: 'oss-cn-beijing',
          accessKeyId: 'LTAI5tEXAMPLE000000000',
          accessKeySecret: 'test-secret',
          prefix: ''
        },
        obsidianNotes: [
          {
            key: 'vault/img-test.md',
            title: 'img-test',
            path: 'vault/img-test.md',
            size: 40,
            lastModified: 1760000000000,
            content: '# 图片测试\n\n![本地图](pic.png)\n'
          },
          { key: 'vault/pic.png', title: 'pic', path: 'vault/pic.png', size: 70, lastModified: 1760000000000 }
        ]
      })
    );
    await openInterop(page);

    const img = page.locator('img.md-image');
    await expect(img).toBeVisible({ timeout: 15_000 });
    expect(await img.getAttribute('src')).toMatch(/^blob:/);
    expect(blobRequests.length).toBeGreaterThan(0);
  });

  test('文档大纲由标题生成并包含层级', async ({ page }) => {
    await openInterop(page);
    const outline = page.locator('.md-outline-item');
    await expect(outline).toHaveCount(2);
    await expect(outline.first()).toHaveText('一级标题');
  });
});


